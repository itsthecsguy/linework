// Sequence diagrams: a direct layout onto draw.io's own UML shapes (lifelines,
// activation bars, frames, notes), so a person can drag lifelines and the messages
// stay attached. Vertical positions follow message order; horizontal positions can
// be pinned from an existing file so hand-arranged columns survive a rebuild.
import type { Diagram, FrameOp, SeqItem } from '../spec/model.js';
import { fontsFor, type Measure } from './layout.js';
import { TextMeasurer } from './text.js';
import { FRAME_TAB_X, LINE, PAD_X, PAD_Y, activationStyle, frameStyle, guardStyle, lifelineStyle, messageStyle, nodeLabel, noteStyle, palette, separatorStyle } from '../drawio/theme.js';
import { autoAttr, diagramMeta, lookAttrs, type Scene, type SceneEdge, type SceneVertex } from '../drawio/write.js';

const TOP = 24, BAR_W = 10, NOTE_W = 220;

type Row =
  | { t: 'msg'; item: Extract<SeqItem, { kind: 'msg' }>; y: number }
  | { t: 'note'; item: Extract<SeqItem, { kind: 'note' }>; y: number; h: number }
  | { t: 'gap'; y: number };

interface FrameBox { id: string; op: FrameOp; whens: Array<string | undefined>; start: number; seps: number[]; end: number; depth: number; parts: Set<string> }

export interface SequenceOptions {
  /** Existing lifeline columns (x, width) by participant id, to keep hand-made spacing. */
  keepX?: Map<string, { x: number; w: number }>;
  /** Existing lifeline styles/labels/attrs to keep when the participant is unchanged. */
  keep?: Map<string, { style?: string; label?: string; attrs?: Record<string, string> }>;
  extraMeta?: Record<string, string>;
  name?: string;
}

/**
 * A label centred on a long message covers the lifelines it passes. Put it in the
 * gap nearest the sender that fits it; keep it centred when none does.
 * Returns draw.io's -1..1 position along the arrow.
 */
function labelGap(x1: number, x2: number, w: number, centers: number[]): number | undefined {
  const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
  const stops = [lo, ...centers.filter((c) => c > lo + 1 && c < hi - 1).sort((a, b) => a - b), hi];
  if (stops.length <= 2) return undefined;
  const gaps = stops.slice(1).map((b, k) => ({ a: stops[k]!, b }));
  if (x2 < x1) gaps.reverse(); // nearest the sender first
  const fit = gaps.find((g) => g.b - g.a >= w + BAR_W);
  if (!fit) return undefined;
  const mid = (fit.a + fit.b) / 2;
  return ((mid - x1) / (x2 - x1)) * 2 - 1;
}

export async function sequenceScene(d: Diagram, measure: Measure, opts: SequenceOptions = {}): Promise<Scene> {
  const parts = d.nodes;
  const idx = new Map(parts.map((p, i) => [p.id, i]));
  const theme = d.theme;

  // 1. Flatten items into rows, remembering frames.
  const rows: Row[] = [];
  const frames: FrameBox[] = [];
  const notes: Array<Extract<SeqItem, { kind: 'note' }>> = [];
  const walk = (items: SeqItem[], depth: number) => {
    for (const it of items) {
      if (it.kind === 'msg') rows.push({ t: 'msg', item: it, y: 0 });
      else if (it.kind === 'note') {
        rows.push({ t: 'note', item: it, y: 0, h: 0 });
        notes.push(it);
      } else {
        const f: FrameBox = { id: `frame_${frames.length + 1}`, op: it.op, whens: it.branches.map((b) => b.when), start: rows.length, seps: [], end: 0, depth, parts: new Set() };
        frames.push(f);
        rows.push({ t: 'gap', y: 0 });
        it.branches.forEach((b, bi) => {
          if (bi > 0) {
            f.seps.push(rows.length);
            rows.push({ t: 'gap', y: 0 });
          }
          const before = rows.length;
          walk(b.items, depth + 1);
          for (const r of rows.slice(before)) if (r.t === 'msg') { f.parts.add(r.item.from); f.parts.add(r.item.to); } else if (r.t === 'note') r.item.over.forEach((p) => f.parts.add(p));
        });
        f.end = rows.length;
        rows.push({ t: 'gap', y: 0 });
      }
    }
  };
  walk(d.seq ?? [], 0);
  // Frames include nested frames' participants.
  for (const f of [...frames].reverse()) for (const g of frames) if (g !== f && g.start > f.start && g.end < f.end) g.parts.forEach((p) => f.parts.add(p));

  // 2. Measure.
  const fonts = fontsFor(theme);
  const tm = new TextMeasurer(measure);
  const guards = frames.flatMap((f) => f.whens.filter((w): w is string => !!w).map((w) => `[${w}]`));
  await tm.prepare([
    ...parts.flatMap((p) => [[p.label, fonts.label], [p.tech, fonts.sub]] as const),
    ...rows.map((r) => [r.t === 'msg' ? r.item.label : r.t === 'note' ? r.item.text : undefined, fonts.edge] as const),
    ...guards.map((g) => [g, fonts.edge] as const),
    ...frames.map((f) => [f.op, fonts.group] as const),
  ]);
  const headText = parts.map((p) => {
    const a = tm.wrap(p.label, fonts.label, fonts.maxText), b = tm.wrap(p.tech, fonts.sub, fonts.maxText);
    return { w: Math.max(a.width, b.width), lines: a.lines.length + b.lines.length };
  });
  const headW = headText.map((t) => Math.max(120, Math.ceil((t.w + 2 * PAD_X) / 8) * 8));
  const HEAD = Math.ceil((PAD_Y * 2 + Math.max(...headText.map((t) => t.lines), 1) * fonts.line) / 4) * 4;
  const edgeLine = Math.ceil(fonts.edge.size * LINE);
  const ROW = Math.max(40, edgeLine + 24);
  const rowW = rows.map((r) => (r.t === 'msg' ? tm.width(r.item.label, fonts.edge) : r.t === 'note' ? Math.min(tm.width(r.item.text, fonts.edge), NOTE_W - 20) : 0));
  const noteLines = rows.map((r) => (r.t === 'note' ? Math.max(1, tm.wrap(r.item.text, fonts.edge, NOTE_W - 20).lines.length) : 0));

  // 3. Columns: centre-to-centre distance wide enough for every label between neighbours.
  const need = parts.map(() => 0); // need[i]: min centre distance between i and i+1
  rows.forEach((r, i) => {
    if (r.t !== 'msg' || r.item.from === r.item.to) return;
    const a = Math.min(idx.get(r.item.from)!, idx.get(r.item.to)!), b = Math.max(idx.get(r.item.from)!, idx.get(r.item.to)!);
    const per = (rowW[i]! + 48) / (b - a);
    for (let k = a; k < b; k++) need[k] = Math.max(need[k]!, per);
  });
  rows.forEach((r, i) => {
    if (r.t !== 'msg' || r.item.from !== r.item.to) return;
    const k = idx.get(r.item.from)!;
    if (k < parts.length - 1) need[k] = Math.max(need[k]!, rowW[i]! + 72);
  });
  const xs: number[] = [];
  parts.forEach((p, i) => {
    const kept = opts.keepX?.get(p.id);
    if (i === 0) return xs.push(kept?.x ?? 40);
    const prevC = xs[i - 1]! + headW[i - 1]! / 2;
    const minC = prevC + Math.max(need[i - 1]!, headW[i - 1]! / 2 + headW[i]! / 2 + 32);
    const fresh = minC - headW[i]! / 2;
    xs.push(kept ? Math.max(kept.x, prevC + headW[i - 1]! / 2 + 24) : fresh);
  });
  parts.forEach((p, i) => {
    const kept = opts.keepX?.get(p.id);
    if (kept && kept.w > headW[i]!) headW[i] = kept.w;
  });
  const cx = (id: string) => xs[idx.get(id)!]! + headW[idx.get(id)!]! / 2;

  // 4. Rows.
  let y = TOP + HEAD + 28;
  rows.forEach((r, i) => {
    r.y = y;
    if (r.t === 'msg') y += r.item.from === r.item.to ? ROW + 16 : ROW;
    else if (r.t === 'note') {
      r.h = 14 + noteLines[i]! * edgeLine;
      y += r.h + 16;
    } else y += (frames.some((f) => f.end === i) ? 20 : 34);
  });
  // Lifelines stop a short way past the last row instead of trailing off the page.
  const lifeH = y - TOP - 6;

  // 5. Activation bars from call/reply pairs.
  interface Bar { id: string; part: string; from: number; to: number }
  const bars: Bar[] = [];
  type Open = Map<string, Array<{ from: number; caller: string }>>;
  let open: Open = new Map();
  const copy = (o: Open): Open => new Map([...o].map(([k, v]) => [k, [...v]]));
  // Each branch of an alt/par starts from the calls open at the top of the frame,
  // not from wherever the previous branch left off.
  const frameAt = new Map(frames.map((f) => [f.start, f]));
  const sepOf = new Map(frames.flatMap((f) => f.seps.map((s) => [s, f] as const)));
  const snapshots = new Map<FrameBox, Open>();
  const barAt = new Map<number, { src?: Bar; dst?: Bar }>();
  rows.forEach((r, i) => {
    const fs = frameAt.get(i);
    if (fs) snapshots.set(fs, copy(open));
    const fsep = sepOf.get(i);
    if (fsep) open = copy(snapshots.get(fsep)!);
    if (r.t !== 'msg' || r.item.from === r.item.to) return;
    const { from, to, style } = r.item;
    if (style === 'sync') {
      const st = open.get(to) ?? [];
      st.push({ from: i, caller: from });
      open.set(to, st);
    } else if (style === 'reply') {
      const st = open.get(from) ?? [];
      const k = st.map((s) => s.caller).lastIndexOf(to);
      if (k >= 0) {
        const s = st.splice(k, 1)[0]!;
        bars.push({ id: `bar_${from}_${bars.length + 1}`, part: from, from: s.from, to: i });
      }
    }
  });
  // A call answered in more than one branch is one bar, to the last answer.
  for (let k = bars.length - 1; k >= 0; k--) {
    const b = bars[k]!;
    const first = bars.find((o) => o !== b && o.part === b.part && o.from === b.from);
    if (first) {
      first.to = Math.max(first.to, b.to);
      bars.splice(k, 1);
    }
  }
  const activeBar = (part: string, row: number) => bars.filter((b) => b.part === part && b.from <= row && b.to >= row).pop();
  rows.forEach((r, i) => {
    if (r.t !== 'msg' || r.item.from === r.item.to) return;
    const { from, to, style } = r.item;
    const dst = style === 'sync' ? bars.find((b) => b.part === to && b.from === i) : activeBar(to, i);
    const src = style === 'reply' ? (bars.find((b) => b.part === from && b.to === i) ?? activeBar(from, i)) : activeBar(from, i);
    barAt.set(i, { src, dst });
  });

  // 6. Cells.
  const vertices: SceneVertex[] = [];
  const edges: SceneEdge[] = [];
  const top = (b: Bar) => rows[b.from]!.y - 6;
  const barH = (b: Bar) => rows[b.to]!.y + 6 - top(b);
  parts.forEach((p, i) => {
    const box = { x: xs[i]!, y: TOP, w: headW[i]!, h: lifeH };
    const keep = opts.keep?.get(p.id);
    vertices.push({
      id: p.id,
      parent: '1',
      attrs: {
        ...(keep?.attrs ?? {}),
        label: keep?.label ?? nodeLabel(p.label, p.tech, { theme, type: 'sequence', kind: p.kind, color: p.color, highlight: p.highlight }),
        aiviz_kind: p.kind,
        aiviz_label: p.label,
        ...(p.tech ? { aiviz_tech: p.tech } : {}),
        ...lookAttrs(p),
        aiviz_auto: autoAttr(box),
      },
      style: keep?.style?.replace(/(^|;)size=\d+/, `$1size=${HEAD}`) ?? lifelineStyle(p.kind, theme, HEAD, p),
      box,
    });
  });
  for (const b of bars) {
    const i = idx.get(b.part)!;
    vertices.push({
      id: b.id,
      parent: b.part,
      attrs: { aiviz_type: 'bar' },
      style: activationStyle(parts[i]!.kind, theme, parts[i]!),
      box: { x: headW[i]! / 2 - BAR_W / 2, y: top(b) - TOP, w: BAR_W, h: barH(b) },
    });
  }
  // Frames before messages so arrows draw on top.
  for (const f of frames) {
    const ps = [...f.parts].map((p) => idx.get(p)!).filter((v) => v != null);
    const lo = ps.length ? Math.min(...ps) : 0, hi = ps.length ? Math.max(...ps) : 0;
    const inset = f.depth * 10;
    const fx = cx(parts[lo]!.id) - Math.max(80, headW[lo]! / 2 + 16) + inset;
    const fx2 = cx(parts[hi]!.id) + Math.max(80, headW[hi]! / 2 + 16) - inset;
    const fy = rows[f.start]!.y - 4, fy2 = rows[f.end]!.y;
    vertices.push({ id: f.id, parent: '1', attrs: { label: f.op, aiviz_type: 'frame', aiviz_frame: f.op }, style: frameStyle(theme), box: { x: fx, y: fy, w: fx2 - fx, h: fy2 - fy } });
    const guard = (when: string | undefined, gy: number, k: number) => {
      if (!when) return;
      // Start right of the operator label, then step past any lifeline the text would cover.
      const gw = Math.max(80, Math.ceil(tm.width(`[${when}]`, fonts.edge)) + 16);
      let gx = fx + 2 * FRAME_TAB_X + Math.ceil(tm.width(f.op, fonts.group)) + 10;
      for (const c of [...parts.map((p) => cx(p.id))].sort((a, b) => a - b)) if (c + BAR_W / 2 + 4 > gx && c - BAR_W / 2 - 4 < gx + gw) gx = c + BAR_W / 2 + 6;
      vertices.push({
        id: `${f.id}_g${k}`,
        parent: '1',
        attrs: { label: `[${when}]`, aiviz_type: 'guard', aiviz_guard: `${f.id}:${k}` },
        style: guardStyle(theme),
        box: { x: gx, y: gy, w: gw, h: Math.max(22, edgeLine + 6) },
      });
    };
    guard(f.whens[0], fy, 0);
    f.seps.forEach((s, k) => {
      const sy = rows[s]!.y + 4;
      edges.push({
        id: `${f.id}_s${k + 1}`,
        parent: '1',
        attrs: { label: '', aiviz_type: 'sep', aiviz_sep: `${f.id}:${k + 1}` },
        style: separatorStyle(theme),
        source: '',
        target: '',
        geomRaw: `<mxGeometry relative="1" as="geometry"><mxPoint x="${fx}" y="${sy}" as="sourcePoint"/><mxPoint x="${fx2}" y="${sy}" as="targetPoint"/></mxGeometry>`,
      });
      guard(f.whens[k + 1], sy + 2, k + 1);
    });
  }
  rows.forEach((r, i) => {
    if (r.t === 'note') {
      const it = r.item;
      const ids = it.over.map((p) => idx.get(p)!).sort((a, b) => a - b);
      const w = rowW[i]! + 24;
      let x: number, width: number;
      if (it.side === 'over') {
        const l = cx(parts[ids[0]!]!.id), rr = cx(parts[ids[ids.length - 1]!]!.id);
        width = Math.max(w, rr - l + 48, 96);
        x = (l + rr) / 2 - width / 2;
      } else {
        width = Math.min(Math.max(w, 96), NOTE_W);
        const c = cx(parts[ids[0]!]!.id);
        x = it.side === 'right' ? c + 16 : c - 16 - width;
      }
      vertices.push({
        id: `note_${i}`,
        parent: '1',
        attrs: { label: it.text, aiviz_type: 'note', aiviz_note: it.side, aiviz_over: it.over.join(',') },
        style: noteStyle(theme),
        box: { x, y: r.y - 4, w: Math.ceil(width / 8) * 8, h: r.h },
      });
    }
  });
  rows.forEach((r, i) => {
    if (r.t !== 'msg') return;
    const { from, to, style, label } = r.item;
    const self = from === to;
    const attrs = { label: label ?? '', aiviz_msg: style, ...lookAttrs(r.item) };
    const id = `m_${i}`;
    if (self) {
      const c = cx(from), lh = lifeH;
      edges.push({
        id, parent: '1', attrs,
        style: messageStyle(style, theme, true, r.item) + `exitX=0.5;exitY=${((r.y - TOP) / lh).toFixed(4)};entryX=0.5;entryY=${((r.y + 20 - TOP) / lh).toFixed(4)};exitDx=0;exitDy=0;entryDx=0;entryDy=0;`,
        source: from, target: from,
        points: [{ x: c + 40, y: r.y }, { x: c + 40, y: r.y + 20 }],
      });
      return;
    }
    const at = barAt.get(i) ?? {};
    const rightward = idx.get(to)! > idx.get(from)!;
    const end = (part: string, bar: Bar | undefined, isSource: boolean) => {
      if (bar) {
        const fy = (r.y - top(bar)) / barH(bar);
        const side = isSource === rightward ? 1 : 0;
        return { cell: bar.id, x: side, y: fy };
      }
      return { cell: part, x: 0.5, y: (r.y - TOP) / lifeH };
    };
    const s = end(from, at.src, true), t = end(to, at.dst, false);
    edges.push({
      id, parent: '1', attrs,
      labelX: label ? labelGap(cx(from), cx(to), rowW[i]! + 16, parts.map((p) => cx(p.id))) : undefined,
      style: messageStyle(style, theme, false, r.item) + `exitX=${s.x};exitY=${s.y.toFixed(4)};exitDx=0;exitDy=0;entryX=${t.x};entryY=${t.y.toFixed(4)};entryDx=0;entryDy=0;`,
      source: s.cell, target: t.cell, points: [],
    });
  });

  return {
    name: opts.name ?? d.title ?? 'Sequence',
    meta: diagramMeta(d, opts.extraMeta),
    background: palette(theme).canvas,
    vertices,
    edges,
    raw: [],
  };
}
