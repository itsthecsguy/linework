// Diagram -> absolute geometry, via ELK layered.
import ElkModule from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge, ELK as ElkApi } from 'elkjs/lib/elk-api.js';
import { kindDef, type Diagram, type Direction, type ThemeName } from '../spec/model.js';
import { ER_HEAD, ER_ROW, FIELD_PAD, GROUP_INSET, LINE, PAD_X, PAD_Y, typeface } from '../drawio/theme.js';
import { TextMeasurer, type FontSpec } from './text.js';
import { ICON_PAD } from '../drawio/icons.js';
import { polish } from './polish.js';

export interface Box { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export interface LaidEdge { points: Point[]; label?: Box }
export interface Layout {
  direction: Exclude<Direction, 'auto'>;
  width: number;
  height: number;
  nodes: Map<string, Box>;
  groups: Map<string, Box>;
  edges: Map<string, LaidEdge>;
  /** Each node's own size before widths were evened out across the diagram. */
  natural: Map<string, { w: number; h: number }>;
  /** Group titles moved right to keep an edge off them: group id -> left inset. */
  titleInset?: Map<string, number>;
}

/** Returns text widths in px for [text, fontSize, fontWeight, fontFamily] requests. */
export type Measure = (reqs: Array<[string, number, number, string?]>) => Promise<number[]>;

/** Crude fallback when no browser is available (tests). */
export const estimateMeasure: Measure = async (reqs) =>
  reqs.map(([t, size, weight]) => Math.ceil(t.length * size * (weight >= 600 ? 0.6 : 0.55)));

// elkjs is CommonJS; under NodeNext the constructor sits on .default.
const ElkCtor = ((ElkModule as unknown as { default?: unknown }).default ?? ElkModule) as new () => ElkApi;
const elk = new ElkCtor();
const snap = (v: number, g = 8) => Math.ceil(v / g) * g;
const ELK_DIR = { TB: 'DOWN', LR: 'RIGHT', BT: 'UP', RL: 'LEFT' } as const;

export interface Fonts {
  label: FontSpec;
  sub: FontSpec;
  edge: FontSpec;
  group: FontSpec;
  field: FontSpec;
  fieldKey: FontSpec;
  /** Line height of a node label; every line of a label uses the label's size. */
  line: number;
  /** Longest a node's text line may get before it wraps. */
  maxText: number;
}

export function fontsFor(theme: ThemeName): Fonts {
  const t = typeface(theme);
  const f = (size: number, weight = 400, tracking?: number): FontSpec => ({ size, weight, family: t.family, tracking });
  return {
    label: f(t.size.label, t.strong),
    sub: f(t.size.sub),
    edge: f(t.size.edge),
    group: f(t.size.group, 700, t.upperGroups ? t.size.group * 0.06 : 0),
    field: f(t.size.field),
    fieldKey: f(t.size.field, t.strong),
    line: Math.round(t.size.label * LINE * 10) / 10,
    maxText: Math.round(t.size.label * 13),
  };
}

export async function layout(d: Diagram, measure: Measure = estimateMeasure): Promise<Layout> {
  const fonts = fontsFor(d.theme);
  const tm = new TextMeasurer(measure);
  await tm.prepare([
    ...d.nodes.flatMap((n): Array<[string | undefined, FontSpec]> => [
      [n.label, kindDef(d.type, n.kind).shape === 'table' ? fonts.label : fonts.label],
      [n.tech, fonts.sub],
      ...(n.fields ?? []).flatMap((fl): Array<[string | undefined, FontSpec]> => [
        [fl.name, fl.flags.includes('pk') ? fonts.fieldKey : fonts.field],
        [fieldRight(fl), fonts.field],
      ]),
    ]),
    ...d.edges.map((e): [string | undefined, FontSpec] => [e.label, fonts.edge]),
    ...d.groups.map((g): [string | undefined, FontSpec] => [groupText(g.label, d.theme), fonts.group]),
  ]);
  const { sizes, natural } = nodeSizes(d, tm, fonts);
  const labels = d.edges.map((e) => (e.label ? { w: Math.ceil(tm.width(e.label, fonts.edge)) + 10, h: Math.ceil(fonts.edge.size * LINE) + 4 } : undefined));
  const groupMin = new Map(d.groups.map((g) => [g.id, Math.ceil(tm.width(groupText(g.label, d.theme), fonts.group)) + 40]));
  const groupTop = Math.round(8 + fonts.group.size * LINE + 20);
  const groupTitle = new Map(d.groups.map((g) => [g.id, { w: Math.ceil(tm.width(groupText(g.label, d.theme), fonts.group)), h: Math.ceil(fonts.group.size * LINE) }]));
  const once = async (dir: Exclude<Direction, 'auto'>, order: Order, pairs: 'reply' | 'call' = 'reply'): Promise<Layout> => {
    let l: Layout = { ...(await run(d, dir, sizes, labels, groupMin, groupTop, order, undefined, pairs)), natural };
    // ER: once the tables are placed, run again with each relationship pinned to
    // its key rows, on the sides that face each other.
    const keys = d.type === 'er' ? keyRows(d) : new Map<string, RowPins>();
    if (keys.size) {
      const pins = new Map<string, PortPin[]>();
      for (const [eid, k] of keys) {
        const e = d.edges.find((x) => x.id === eid)!;
        const a = l.nodes.get(e.from)!, b = l.nodes.get(e.to)!;
        const aLeft = a.x + a.w / 2 <= b.x + b.w / 2;
        const pin = (node: string, row: number | undefined, east: boolean, end: 'from' | 'to') => {
          if (row === undefined) return;
          const list = pins.get(node) ?? [];
          list.push({ edge: eid, end, row, side: east ? 'EAST' : 'WEST' });
          pins.set(node, list);
        };
        pin(e.from, k.from, aLeft, 'from');
        pin(e.to, k.to, !aLeft, 'to');
      }
      // Two relationships on one key row would meet at one point and stack their
      // markers. Spread them across the row, the one from higher up on top.
      for (const [node, list] of pins) {
        const rows = new Map<string, PortPin[]>();
        for (const p of list) rows.set(`${p.side}:${p.row}`, [...(rows.get(`${p.side}:${p.row}`) ?? []), p]);
        for (const same of rows.values()) {
          if (same.length < 2) continue;
          const other = (p: PortPin) => {
            const e = d.edges.find((x) => x.id === p.edge)!;
            const b = l.nodes.get(e.from === node && p.end === 'from' ? e.to : e.from)!;
            return b.y + b.h / 2;
          };
          same.sort((a, b) => other(a) - other(b));
          const step = Math.min(12, Math.floor((ER_ROW - 4) / same.length));
          same.forEach((p, i) => (p.dy = Math.round((i - (same.length - 1) / 2) * step)));
        }
      }
      l = { ...(await run(d, dir, sizes, labels, groupMin, groupTop, order, pins, pairs)), natural };
    }
    polish(d, l, { groupTitle, titleInset: GROUP_INSET, groupTop });
    return toPixels(l);
  };
  // Spec order first: it keeps a diagram stable as the spec grows. Free ordering
  // wins only when it crosses fewer edges.
  const hasPairs = d.edges.some((e, i) => e.from !== e.to && d.edges.slice(0, i).some((x) => x.from === e.to && x.to === e.from));
  const go = async (dir: Exclude<Direction, 'auto'>): Promise<Layout> => {
    const tries: Array<[Order, 'reply' | 'call']> = [['NODES_AND_EDGES', 'reply'], ['NONE', 'reply']];
    if (hasPairs) tries.push(['NODES_AND_EDGES', 'call'], ['NONE', 'call']);
    const all = await Promise.all(tries.map(([o, p]) => once(dir, o, p)));
    // Fewest crossings; then clearly shorter edges; ties go to the earlier try.
    return all.reduce((best, l) => {
      const [cb, cl] = [crossings(best), crossings(l)];
      if (cl !== cb) return cl < cb ? l : best;
      return edgeLength(l) < 0.9 * edgeLength(best) ? l : best;
    });
  };
  if (d.direction !== 'auto') return go(d.direction);
  // Relationships attach to rows, on a table's sides, so tables read left to right.
  if (d.type === 'er') return go('LR');
  // Pick the direction whose result fits a document page best.
  const [tb, lr] = await Promise.all([go('TB'), go('LR')]);
  return score(tb) <= score(lr) ? tb : lr;
}

const groupText = (label: string, theme: ThemeName) => (typeface(theme).upperGroups ? label.toUpperCase() : label);
const fieldRight = (f: { type?: string; flags: string[] }) => {
  const keys = f.flags.filter((x) => x === 'pk' || x === 'fk').map((x) => x.toUpperCase());
  return [f.type, ...f.flags.filter((x) => x !== 'pk' && x !== 'fk'), ...keys].filter(Boolean).join(' ');
};

function score(l: Omit<Layout, 'natural'>) {
  const ratio = l.width / Math.max(1, l.height);
  return Math.abs(Math.log(ratio / 1.4)) + Math.max(0, l.width - 1200) / 400;
}

type Size = { w: number; h: number };

/** Extra width a shape needs around its text, beyond PAD_X on each side. */
function shapeExtra(shape: string, icon: boolean) {
  return (shape === 'parallelogram' ? 28 : shape === 'pill' ? 16 : 0) + (icon ? ICON_PAD - PAD_X + 4 : 0);
}

function boxHeight(lines: number, fonts: Fonts, shape: string) {
  return snap(PAD_Y * 2 + Math.max(1, lines) * fonts.line + (shape === 'cylinder' ? 16 : 0), 4);
}

function nodeSizes(d: Diagram, tm: TextMeasurer, fonts: Fonts) {
  const sizes = new Map<string, Size>();
  const minW = d.type === 'architecture' ? 136 : 112;
  const textOf = (n: Diagram['nodes'][number], maxW: number) => {
    const a = tm.wrap(n.label, fonts.label, maxW), b = tm.wrap(n.tech, fonts.sub, maxW);
    return { width: Math.max(a.width, b.width), lines: a.lines.length + b.lines.length };
  };
  for (const n of d.nodes) {
    const shape = kindDef(d.type, n.kind).shape;
    if (shape === 'table') {
      let w = tm.width(n.label, fonts.label) + 2 * FIELD_PAD + 8;
      for (const f of n.fields ?? []) {
        const nameW = tm.width(f.name, f.flags.includes('pk') ? fonts.fieldKey : fonts.field);
        w = Math.max(w, nameW + tm.width(fieldRight(f), fonts.field) + 2 * FIELD_PAD + 28);
      }
      const rows = n.fields?.length ?? 0;
      sizes.set(n.id, { w: snap(Math.max(176, w)), h: rows ? ER_HEAD + rows * ER_ROW + 6 : ER_HEAD });
      continue;
    }
    if (shape === 'start' || shape === 'end') {
      sizes.set(n.id, { w: 24, h: 24 });
      continue;
    }
    if (shape === 'diamond') {
      // A diamond holds little text for its size. Past two lines, wrap wider:
      // three lines in a wider diamond take less room than four in a tall one.
      let t = textOf(n, fonts.maxText * 0.7);
      if (t.lines > 2) t = textOf(n, fonts.maxText);
      const w = snap(Math.max(128, t.width * 1.5 + 40));
      sizes.set(n.id, { w, h: snap(Math.max(72, w * 0.5, t.lines * fonts.line * 2 + 24)) });
      continue;
    }
    const extra = shapeExtra(shape, !!n.icon);
    const t = textOf(n, fonts.maxText);
    sizes.set(n.id, { w: snap(Math.max(minW, t.width + 2 * PAD_X + extra)), h: boxHeight(t.lines, fonts, shape) });
  }
  const natural = new Map([...sizes].map(([k, v]) => [k, { ...v }]));
  // Boxes of nearly the same width read calmer at exactly the same width: their
  // edges line up down a column. Tables too, so their key rows' connectors start
  // at one x. Boxes much wider than the rest keep their own width rather than
  // stretching every box.
  const uniform = d.nodes.filter((n) => !['start', 'end', 'diamond'].includes(kindDef(d.type, n.kind).shape));
  const sorted = [...uniform].sort((a, b) => sizes.get(a.id)!.w - sizes.get(b.id)!.w);
  let cluster: typeof sorted = [];
  const flush = () => {
    const w = Math.max(0, ...cluster.map((n) => sizes.get(n.id)!.w));
    for (const n of cluster) {
      const s = sizes.get(n.id)!;
      if (s.w === w) continue;
      s.w = w;
      // A wider box may fit the text on fewer lines. A table's rows don't wrap.
      const shape = kindDef(d.type, n.kind).shape;
      if (shape === 'table') continue;
      s.h = boxHeight(textOf(n, w - 2 * PAD_X - shapeExtra(shape, !!n.icon)).lines, fonts, shape);
    }
    cluster = [];
  };
  for (const n of sorted) {
    if (cluster.length && sizes.get(n.id)!.w > sizes.get(cluster[0]!.id)!.w * 1.25) flush();
    cluster.push(n);
  }
  flush();
  return { sizes, natural };
}

async function run(
  d: Diagram,
  dir: Exclude<Direction, 'auto'>,
  sizes: Map<string, { w: number; h: number }>,
  labels: Array<{ w: number; h: number } | undefined>,
  groupMin: Map<string, number>,
  groupTop: number,
  order: Order,
  pins: Map<string, PortPin[]> = new Map(),
  pairs: 'reply' | 'call' = 'reply',
): Promise<Omit<Layout, 'natural'>> {
  const byId = new Map<string, ElkNode>();
  const root: ElkNode = {
    id: '__root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': ELK_DIR[dir],
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.layered.considerModelOrder.strategy': order,
      // Walk from the sources in spec order, so the edge that closes a loop (a retry,
      // a resume) is the one drawn backwards, not the main path.
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.layered.spacing.nodeNodeBetweenLayers': '32',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.edgeNodeBetweenLayers': '12',
      'elk.spacing.edgeNode': '24',
      'elk.spacing.edgeEdge': '16',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.inline': 'true',
      'elk.layered.edgeLabels.sideSelection': 'ALWAYS_UP',
      'elk.layered.mergeEdges': 'false',
      'elk.padding': '[top=16,left=16,bottom=16,right=16]',
      'elk.json.shapeCoords': 'ROOT',
      'elk.json.edgeCoords': 'ROOT',
    },
    children: [],
    edges: [],
  };
  byId.set(root.id, root);
  for (const g of d.groups) {
    byId.set(g.id, {
      id: g.id,
      children: [],
      layoutOptions: {
        'elk.padding': `[top=${groupTop},left=20,bottom=20,right=20]`,
        // Wide enough for its title.
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${groupMin.get(g.id) ?? 0}, 0)`,
      },
    });
  }
  for (const g of d.groups) byId.get(g.parent ?? '__root')!.children!.push(byId.get(g.id)!);
  for (const n of d.nodes) {
    const s = sizes.get(n.id)!;
    const en: ElkNode = { id: n.id, width: s.w, height: s.h };
    if (n.kind === 'start') en.layoutOptions = { 'elk.layered.layering.layerConstraint': 'FIRST' };
    const np = pins.get(n.id);
    if (np?.length) {
      en.layoutOptions = { ...en.layoutOptions, 'elk.portConstraints': 'FIXED_POS' };
      en.ports = np.map((p) => ({
        id: portId(p),
        width: 0,
        height: 0,
        x: p.side === 'EAST' ? s.w : 0,
        y: ER_HEAD + p.row * ER_ROW + ER_ROW / 2 + (p.dy ?? 0),
        layoutOptions: { 'elk.port.side': p.side },
      }));
    }
    byId.set(n.id, en);
    byId.get(n.parent ?? '__root')!.children!.push(en);
  }
  // A reply to an earlier edge (stripe -> api after api -> stripe) is laid out in
  // the call's direction, so the pair runs side by side instead of one of them
  // being drawn backwards around everything in between. Its points flip back below.
  // Which of the two to flip is tried both ways by the caller: flipping the call
  // puts the other end ahead of the caller, often outside its group.
  const flipped = new Set<string>();
  d.edges.forEach((e, i) => {
    const call = e.from !== e.to ? d.edges.slice(0, i).find((x) => x.from === e.to && x.to === e.from) : undefined;
    if (call) flipped.add(pairs === 'reply' ? e.id : call.id);
  });
  // The edge that closes a loop (a retry, "new findings, investigate again")
  // points back at a box that was declared earlier and already appears in an
  // earlier edge. Lay it out reversed, so the main path keeps running forward
  // whichever branch ELK happens to walk first.
  const index = new Map(d.nodes.map((n, i) => [n.id, i]));
  const firstUse = new Map<string, number>();
  d.edges.forEach((e, i) => {
    for (const id of [e.from, e.to]) if (!firstUse.has(id)) firstUse.set(id, i);
  });
  const back = d.edges
    .map((e, i) => ({ e, i }))
    .filter(({ e, i }) => e.from !== e.to && index.get(e.to)! < index.get(e.from)! && firstUse.get(e.to)! < i)
    // Call-and-reply pairs are handled above.
    .filter(({ e }) => !d.edges.some((x) => x.from === e.to && x.to === e.from))
    // Last written first: once the loop's closing edge is cut, an earlier
    // backward edge inside the same loop is no longer part of a cycle and stays.
    .reverse()
    .map(({ e }) => e);
  const cut = new Set<string>();
  const reaches = (from: string, to: string) => {
    const seen = new Set([from]);
    for (const q = [from]; q.length; ) {
      const cur = q.pop()!;
      if (cur === to) return true;
      for (const x of d.edges) if (x.from === cur && !cut.has(x.id) && !seen.has(x.to)) (seen.add(x.to), q.push(x.to));
    }
    return false;
  };
  for (const e of back) {
    if (!reaches(e.to, e.from)) continue;
    cut.add(e.id);
    flipped.add(e.id);
  }
  root.edges = d.edges.map((e, i): ElkExtendedEdge => {
    const src = pinFor(pins, e.from, e.id, 'from') ?? e.from, dst = pinFor(pins, e.to, e.id, 'to') ?? e.to;
    const flip = flipped.has(e.id);
    return {
      id: e.id,
      sources: [flip ? dst : src],
      targets: [flip ? src : dst],
      labels: labels[i] ? [{ text: e.label!, width: labels[i]!.w, height: labels[i]!.h }] : [],
    };
  });

  const out = await elk.layout(root);
  const nodes = new Map<string, Box>();
  const groups = new Map<string, Box>();
  const groupIds = new Set(d.groups.map((g) => g.id));
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      const box = { x: c.x!, y: c.y!, w: c.width!, h: c.height! };
      (groupIds.has(c.id) ? groups : nodes).set(c.id, box);
      walk(c);
    }
  };
  walk(out);
  const edges = new Map<string, LaidEdge>();
  for (const e of (out.edges ?? []) as ElkExtendedEdge[]) {
    const s = e.sections?.[0];
    if (!s) continue;
    const lab = e.labels?.[0];
    edges.set(e.id, {
      points: (flipped.has(e.id) ? (pts: Point[]) => pts.reverse() : (pts: Point[]) => pts)([s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y }))),
      label: lab && lab.x != null ? { x: lab.x, y: lab.y!, w: lab.width!, h: lab.height! } : undefined,
    });
  }
  return { direction: dir, width: out.width!, height: out.height!, nodes, groups, edges };
}

type Order = 'NODES_AND_EDGES' | 'NONE';

/**
 * Whole-pixel geometry. ELK centres boxes at fractions of a pixel; draw.io then
 * rounds the boxes but not the edges, so a straight drop gets 0.1px kinks and
 * 1px lines blur across two pixels. Sizes are whole already, so rounding every
 * coordinate keeps each edge end on its box.
 */
function toPixels(l: Layout): Layout {
  const rp = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });
  const rb = (b: Box): Box => ({ ...rp(b), w: Math.round(b.w), h: Math.round(b.h) });
  for (const m of [l.nodes, l.groups]) for (const [k, b] of m) m.set(k, rb(b));
  for (const [k, e] of l.edges) l.edges.set(k, { ...e, points: e.points.map(rp), label: e.label && rb(e.label) });
  return { ...l, width: Math.ceil(l.width), height: Math.ceil(l.height) };
}

/** Proper crossings between edge segments: what a reader has to untangle. */
export function crossings(l: Pick<Layout, 'edges'>): number {
  const segs: Array<[Point, Point, string]> = [];
  for (const [id, e] of l.edges) for (let i = 0; i < e.points.length - 1; i++) segs.push([e.points[i]!, e.points[i + 1]!, id]);
  let n = 0;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b, ea] = segs[i]!, [c, dd, eb] = segs[j]!;
      if (ea === eb) continue;
      const o = (p: Point, q: Point, r: Point) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
      if (o(a, b, c) * o(a, b, dd) < 0 && o(c, dd, a) * o(c, dd, b) < 0) n++;
    }
  return n;
}

export function edgeLength(l: Pick<Layout, 'edges'>): number {
  let n = 0;
  for (const e of l.edges.values()) for (let i = 1; i < e.points.length; i++) n += Math.abs(e.points[i]!.x - e.points[i - 1]!.x) + Math.abs(e.points[i]!.y - e.points[i - 1]!.y);
  return n;
}

type PortPin = { edge: string; end: 'from' | 'to'; row: number; side: 'EAST' | 'WEST'; dy?: number };
type RowPins = { from?: number; to?: number };
const portId = (p: PortPin) => `${p.edge}::${p.end}`;
const pinFor = (pins: Map<string, PortPin[]>, node: string, edge: string, end: 'from' | 'to') => {
  const p = pins.get(node)?.find((x) => x.edge === edge && x.end === end);
  return p ? portId(p) : undefined;
};

/** "addresses" -> "address", "categories" -> "category", "orgs" -> "org". */
export function singular(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (/(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * For each ER relationship, the rows its ends attach to: the foreign key on one
 * table that names the other ("customer_id" -> customers), and that table's
 * primary key. Relationships with no matching key attach to the table as a whole.
 */
export function keyRows(d: Diagram): Map<string, RowPins> {
  const out = new Map<string, RowPins>();
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const pk = (id: string) => {
    const i = byId.get(id)?.fields?.findIndex((f) => f.flags.includes('pk')) ?? -1;
    return i >= 0 ? i : undefined;
  };
  const fkTo = (child: string, parent: string) => {
    const p = byId.get(parent)!;
    const names = [...new Set([p.id, p.label].map((x) => singular(x.replace(/[\s-]+/g, '_'))))];
    const fields = byId.get(child)?.fields ?? [];
    const score = (name: string) => {
      const f = name.toLowerCase();
      for (const n of names) {
        if (f === `${n}_id` || f === `${n}id`) return 3;
        if (f.endsWith(`_${n}_id`) || f.startsWith(`${n}_`)) return 2;
        if (f.includes(n)) return 1;
      }
      return 0;
    };
    let best: { i: number; s: number } | undefined;
    fields.forEach((f, i) => {
      if (!f.flags.includes('fk')) return;
      const s = score(f.name);
      if (s && (!best || s > best.s)) best = { i, s };
    });
    return best?.i;
  };
  for (const e of d.edges) {
    if (e.from === e.to) continue;
    const a = fkTo(e.from, e.to);
    if (a !== undefined) {
      out.set(e.id, { from: a, to: pk(e.to) });
      continue;
    }
    const b = fkTo(e.to, e.from);
    if (b !== undefined) out.set(e.id, { from: pk(e.from), to: b });
  }
  return out;
}
