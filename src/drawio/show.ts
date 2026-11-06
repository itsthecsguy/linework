// draw.io model -> Diagram -> YAML spec. Works on files linework wrote, files a
// person edited, and plain draw.io files with no linework metadata at all.
import {
  DEFAULT_KIND,
  DIAGRAM_TYPES,
  DIRECTIONS,
  FRAME_OPS,
  KINDS,
  THEMES,
  kindDef,
  type Card,
  type Diagram,
  type DiagramType,
  type Direction,
  type EdgeStyle,
  type Field,
  type FrameOp,
  type Group,
  type MessageStyle,
  type Node,
  type SeqItem,
  type ThemeName,
} from '../spec/model.js';
import { humanize } from '../spec/parse.js';
import { absBox, labelLines, type Cell, type DrawioModel } from './read.js';
import { cardFromArrow } from './theme.js';
import { lookOf } from './write.js';
import { COLORS, type Look } from '../spec/model.js';

const ID_RE = /^[A-Za-z_][\w.-]*$/;
const FIELD_FLAGS = new Set(['pk', 'fk', 'uk', 'unique', 'null', 'not_null']);

export interface ShowResult {
  diagram: Diagram;
  notes: string[];
  /** draw.io cell id -> spec id, for vertices. */
  idMap: Map<string, string>;
  /** spec edge id -> draw.io cell id. */
  edgeCells: Map<string, string>;
  /** Cells the spec can't express (text, dangling edges, edges to groups). Merge carries them over. */
  skipped: string[];
}

const isLifeline = (c: Cell) => c.style.shape === 'umlLifeline';
const isEntityStyle = (c: Cell) => (c.style.shape === 'swimlane' || 'swimlane' in c.style) && c.style.childLayout === 'stackLayout';

export function toDiagram(m: DrawioModel): ShowResult {
  const notes: string[] = [];
  const vertices = m.cells.filter((c) => c.vertex && c.attrs.aiviz_type !== 'icon');

  let type = m.meta.aiviz_type as DiagramType | undefined;
  if (!type || !DIAGRAM_TYPES.includes(type)) {
    type = vertices.some(isLifeline)
      ? 'sequence'
      : vertices.some((v) => isEntityStyle(v) && !v.attrs.aiviz_type)
        ? 'er'
        : vertices.some((v) => 'rhombus' in v.style)
          ? 'flow'
          : 'architecture';
    if (!m.meta.aiviz_type) notes.push(`no linework metadata; guessed type: ${type}`);
  }
  const dirRaw = m.meta.aiviz_direction as Direction | undefined;
  const direction: Direction = dirRaw && DIRECTIONS.includes(dirRaw) ? dirRaw : 'auto';
  const themeRaw = m.meta.aiviz_theme as ThemeName | undefined;
  const theme: ThemeName = themeRaw && THEMES.includes(themeRaw) ? themeRaw : 'clean';
  if (type === 'sequence') return sequenceDiagram(m, theme, notes);

  const isEntity = (c: Cell) => type === 'er' && ((!!c.attrs.aiviz_kind && kindDef('er', c.attrs.aiviz_kind).shape === 'table') || isEntityStyle(c));
  const entityIds = new Set(vertices.filter(isEntity).map((c) => c.id));
  const isRow = (c: Cell) => !!c.parent && entityIds.has(c.parent);
  const hasChildren = new Set(vertices.filter((v) => !isRow(v)).map((v) => v.parent).filter(Boolean) as string[]);
  const isGroup = (c: Cell) =>
    !isEntity(c) && !c.attrs.aiviz_kind && (c.attrs.aiviz_type === 'group' || c.style.container === '1' || 'swimlane' in c.style || hasChildren.has(c.id));
  // Text-only cells (free notes) aren't diagram nodes.
  const isText = (c: Cell) => 'text' in c.style && !c.attrs.aiviz_kind && !isRow(c);

  // Assign spec ids: keep linework/readable ids, slug the rest from their labels.
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  const claim = (want: string) => {
    let id = want, n = 2;
    while (used.has(id)) id = `${want}_${n++}`;
    used.add(id);
    return id;
  };
  const known = (c: Cell) => !!(c.attrs.aiviz_kind || c.attrs.aiviz_type);
  const nodeCells = vertices.filter((c) => !isRow(c));
  for (const c of nodeCells) if (known(c) && ID_RE.test(c.id)) idMap.set(c.id, claim(c.id));
  for (const c of nodeCells) {
    if (idMap.has(c.id) || isText(c)) continue;
    const text = labelLines(c.label)[0] ?? '';
    idMap.set(c.id, claim(slug(text) || slug(c.id) || 'node'));
  }

  const groups: Group[] = [];
  const nodes: Node[] = [];
  for (const c of nodeCells) {
    if (isText(c)) continue;
    const id = idMap.get(c.id)!;
    const parentCell = c.parent && c.parent !== '1' ? m.byId.get(c.parent) : undefined;
    const parent = parentCell && isGroup(parentCell) ? idMap.get(parentCell.id) : undefined;
    const lines = labelLines(c.label);
    if (isGroup(c)) {
      groups.push({ id, label: lines.join(' ') || c.attrs.aiviz_label || humanize(id), parent, ...look(c) });
      continue;
    }
    const kind = c.attrs.aiviz_kind && KINDS[type][c.attrs.aiviz_kind] ? c.attrs.aiviz_kind : isEntity(c) ? 'entity' : inferKind(type, c);
    if (c.attrs.aiviz_kind && !KINDS[type][c.attrs.aiviz_kind]) notes.push(`${id}: kind "${c.attrs.aiviz_kind}" isn't valid for ${type}; using ${kind}`);
    const node: Node = { id, kind, label: lines[0] ?? c.attrs.aiviz_label ?? '', parent, ...look(c) };
    if (isEntity(c)) {
      node.label = lines.join(' ') || c.attrs.aiviz_label || humanize(id);
      const rows = vertices.filter((r) => r.parent === c.id).sort((a, b) => (a.geom?.y ?? 0) - (b.geom?.y ?? 0));
      const fields = rows.map(parseFieldRow).filter((f): f is Field => !!f);
      if (fields.length) node.fields = fields;
    } else if (lines.length > 1) node.tech = lines.slice(1).join(' ');
    if (c.attrs.aiviz_icon) node.icon = c.attrs.aiviz_icon;
    nodes.push(node);
  }

  const edges: Diagram['edges'] = [];
  const edgeCells = new Map<string, string>();
  const skipped = vertices.filter(isText).map((c) => c.id);
  const counts = new Map<string, number>();
  const endOf = (cellId?: string) => {
    if (!cellId) return undefined;
    const c = m.byId.get(cellId);
    // An edge drawn to an ER field row belongs to its entity.
    if (c && isRow(c)) return idMap.get(c.parent!);
    return idMap.get(cellId);
  };
  for (const c of m.cells.filter((c) => c.edge)) {
    const from = endOf(c.source);
    const to = endOf(c.target);
    if (!from || !to) {
      notes.push(`skipped an edge that isn't connected at both ends${c.label ? ` ("${labelLines(c.label).join(' ')}")` : ''}`);
      skipped.push(c.id);
      continue;
    }
    if (groups.some((g) => g.id === from || g.id === to)) {
      notes.push(`skipped edge ${from} -> ${to}: edges to groups aren't supported yet`);
      skipped.push(c.id);
      continue;
    }
    const base = `${from}->${to}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    const label = labelLines(c.label).join(' ') || undefined;
    const eid = n === 1 ? base : `${base}#${n}`;
    edgeCells.set(eid, c.id);
    const edge: Diagram['edges'][number] = { id: eid, from, to, label, style: edgeStyleOf(c), ...look(c) };
    if (type === 'er') {
      edge.style = 'line';
      edge.card = {
        from: cardFromArrow(c.style.startArrow) ?? 'one',
        to: cardFromArrow(c.style.endArrow) ?? 'many',
        identifying: c.style.dashed !== '1',
      };
    }
    edges.push(edge);
  }

  return { diagram: { type, title: m.meta.aiviz_title, direction, theme, groups, nodes, edges }, notes, idMap, edgeCells, skipped };
}

function look(c: Cell): Look {
  const l = lookOf(c.attrs);
  if (l.color && !(COLORS as readonly string[]).includes(l.color)) delete l.color;
  return l;
}

function parseFieldRow(c: Cell): Field | null {
  if (c.attrs.aiviz_field && !c.label) return { name: c.attrs.aiviz_field, type: c.attrs.aiviz_ftype, flags: (c.attrs.aiviz_flags ?? '').split(' ').filter(Boolean) };
  const text = labelLines(c.label).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // "name: type flags" (draw.io's own ER rows) or "name type flags" (ours)
  const m = /^([^\s:]+):?\s*(.*)$/.exec(text)!;
  const flags: string[] = [];
  const type: string[] = [];
  for (const tok of m[2]!.split(' ').filter(Boolean)) (FIELD_FLAGS.has(tok.toLowerCase()) ? flags : type).push(FIELD_FLAGS.has(tok.toLowerCase()) ? tok.toLowerCase() : tok);
  return { name: m[1]!, type: type.join(' ') || undefined, flags };
}

// ---------- sequence ----------

function sequenceDiagram(m: DrawioModel, theme: ThemeName, notes: string[]): ShowResult {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  const lifelines = m.cells.filter((c) => c.vertex && isLifeline(c)).sort((a, b) => (absBox(m, a.id)?.x ?? 0) - (absBox(m, b.id)?.x ?? 0));
  const nodes: Node[] = [];
  for (const c of lifelines) {
    const lines = labelLines(c.label);
    let id = c.attrs.aiviz_kind && ID_RE.test(c.id) ? c.id : slug(lines[0] ?? '') || 'participant';
    let n = 2;
    const base = id;
    while (used.has(id)) id = `${base}_${n++}`;
    used.add(id);
    idMap.set(c.id, id);
    const kind = c.attrs.aiviz_kind && KINDS.sequence[c.attrs.aiviz_kind] ? c.attrs.aiviz_kind : c.style.dashed === '1' ? 'external' : 'service';
    nodes.push({ id, kind, label: lines[0] ?? humanize(id), tech: lines.length > 1 ? lines.slice(1).join(' ') : undefined, ...look(c) });
  }
  // Activation bars and anything else inside a lifeline belong to that participant.
  const partOf = (cellId?: string): string | undefined => {
    for (let c = cellId ? m.byId.get(cellId) : undefined; c; c = c.parent ? m.byId.get(c.parent) : undefined) if (idMap.has(c.id)) return idMap.get(c.id);
    return undefined;
  };
  const center = (id: string) => {
    const cell = lifelines.find((c) => idMap.get(c.id) === id)!;
    const b = absBox(m, cell.id)!;
    return b.x + b.w / 2;
  };

  type Ev =
    | { y: number; o: 1; t: 'item'; item: SeqItem }
    | { y: number; o: 0; t: 'start'; frame: Cell }
    | { y: number; o: 0.5; t: 'sep'; frame: Cell }
    | { y: number; o: 2; t: 'end'; frame: Cell };
  const events: Ev[] = [];
  const skipped: string[] = [];

  const yAt = (c: Cell): number | undefined => {
    const end = (cellId: string | undefined, fx: string | undefined) => {
      const b = cellId ? absBox(m, cellId) : undefined;
      return b && fx != null ? b.y + Number(fx) * b.h : undefined;
    };
    return end(c.source, c.style.exitY) ?? end(c.target, c.style.entryY) ?? c.geom?.points[0]?.y;
  };
  const isFrame = (c: Cell) => c.attrs.aiviz_type === 'frame' || c.style.shape === 'umlFrame';
  const frames = m.cells.filter((c) => c.vertex && isFrame(c));
  const frameBox = new Map(frames.map((f) => [f.id, absBox(m, f.id)!]));
  const innermost = (y: number, x?: number) =>
    frames
      .filter((f) => {
        const b = frameBox.get(f.id)!;
        return y > b.y && y < b.y + b.h && (x == null || (x >= b.x - 2 && x <= b.x + b.w + 2));
      })
      .sort((a, b) => frameBox.get(a.id)!.h - frameBox.get(b.id)!.h)[0];

  for (const c of m.cells) {
    if (c.edge) {
      const from = partOf(c.source), to = partOf(c.target);
      if (from && to) {
        const y = yAt(c);
        if (y == null) continue;
        const style: MessageStyle = (c.attrs.aiviz_msg as MessageStyle) ?? (c.style.dashed === '1' ? 'reply' : c.style.endArrow === 'open' ? 'async' : 'sync');
        const label = labelLines(c.label).join(' ') || undefined;
        events.push({ y, o: 1, t: 'item', item: { kind: 'msg', from, to, label, style, ...look(c) } });
      } else if (!c.source && !c.target && c.geom) {
        // A dashed line across a frame divides its branches.
        const raw = /<mxPoint[^>]*y="([-\d.]+)"[^>]*as="sourcePoint"/.exec(c.geomRaw ?? '');
        const y = raw ? Number(raw[1]) : undefined;
        const f = y != null ? innermost(y) : undefined;
        if (f) events.push({ y: y!, o: 0.5, t: 'sep', frame: f });
        else skipped.push(c.id);
      } else skipped.push(c.id);
    } else if (c.vertex && (c.attrs.aiviz_type === 'note' || c.style.shape === 'note')) {
      const b = absBox(m, c.id)!;
      let over = c.attrs.aiviz_over?.split(',').filter((p) => nodes.some((n) => n.id === p)) ?? [];
      let side = (c.attrs.aiviz_note as 'over' | 'left' | 'right') ?? 'over';
      if (!over.length) {
        over = nodes.filter((n) => center(n.id) >= b.x && center(n.id) <= b.x + b.w).map((n) => n.id);
        if (!over.length && nodes.length) {
          const nearest = [...nodes].sort((a, z) => Math.abs(center(a.id) - (b.x + b.w / 2)) - Math.abs(center(z.id) - (b.x + b.w / 2)))[0]!;
          over = [nearest.id];
          side = center(nearest.id) < b.x ? 'right' : 'left';
        }
      }
      events.push({ y: b.y + 4, o: 1, t: 'item', item: { kind: 'note', over, side, text: labelLines(c.label).join(' ') } });
    } else if (c.vertex && isFrame(c)) {
      const b = frameBox.get(c.id)!;
      events.push({ y: b.y, o: 0, t: 'start', frame: c }, { y: b.y + b.h, o: 2, t: 'end', frame: c });
    } else if (c.vertex && !isLifeline(c) && !partOf(c.id) && !('text' in c.style)) skipped.push(c.id);
  }
  // Guards: bracketed text near the top of a frame or just under a separator.
  const guards = m.cells.filter((c) => c.vertex && 'text' in c.style).map((c) => ({ c, b: absBox(m, c.id)!, text: labelLines(c.label).join(' ') }));
  const guardNear = (frame: Cell, y: number) => {
    const fb = frameBox.get(frame.id)!;
    const g = guards.find((g) => g.b.y >= y - 4 && g.b.y <= y + 26 && g.b.x >= fb.x && g.b.x <= fb.x + fb.w);
    if (!g) return undefined;
    g.c = { ...g.c, id: '' }; // consumed
    return g.text.replace(/^\[|\]$/g, '').trim() || undefined;
  };
  for (const g of guards) if (!frames.some((f) => { const fb = frameBox.get(f.id)!; return g.b.y >= fb.y - 4 && g.b.y <= fb.y + fb.h; })) skipped.push(g.c.id);

  events.sort((a, b) => a.y - b.y || a.o - b.o);
  interface Open { frame: Cell; op: FrameOp; branches: Array<{ when?: string; items: SeqItem[] }> }
  const root: SeqItem[] = [];
  const stack: Open[] = [];
  const top = () => (stack.length ? stack[stack.length - 1]!.branches[stack[stack.length - 1]!.branches.length - 1]!.items : root);
  for (const ev of events) {
    if (ev.t === 'item') top().push(ev.item);
    else if (ev.t === 'start') {
      const label = (labelLines(ev.frame.label)[0] ?? '').toLowerCase();
      const op = ((ev.frame.attrs.aiviz_frame ?? label) as FrameOp);
      stack.push({ frame: ev.frame, op: FRAME_OPS.includes(op) ? op : 'opt', branches: [{ when: guardNear(ev.frame, ev.y), items: [] }] });
    } else if (ev.t === 'sep') {
      const s = stack.find((o) => o.frame.id === ev.frame.id);
      if (s) s.branches.push({ when: guardNear(ev.frame, ev.y), items: [] });
    } else {
      const i = stack.findIndex((o) => o.frame.id === ev.frame.id);
      if (i < 0) continue;
      const [o] = stack.splice(i, 1);
      top().push({ kind: 'frame', op: o!.op, branches: o!.branches });
    }
  }
  return {
    diagram: { type: 'sequence', title: m.meta.aiviz_title, direction: 'auto', theme, groups: [], nodes, edges: [], seq: root },
    notes,
    idMap,
    edgeCells: new Map(),
    skipped,
  };
}

function inferKind(type: DiagramType, c: Cell): string {
  const s = c.style;
  const has = (k: string) => k in s;
  const pick = (k: string) => (KINDS[type][k] ? k : DEFAULT_KIND[type]);
  const small = (c.geom?.w ?? 100) <= 40 && (c.geom?.h ?? 100) <= 40;
  if (s.shape === 'doubleEllipse' || s.shape === 'endState') return pick('end');
  if ((has('ellipse') || s.shape === 'ellipse') && small) return pick('start');
  if (s.shape?.startsWith('cylinder') || s.shape === 'datastore') return pick('database');
  if (has('rhombus') || s.shape === 'rhombus') return pick('decision');
  if (s.shape === 'parallelogram') return pick('data');
  if (s.shape === 'umlActor' || s.shape === 'actor') return pick('person');
  if (s.rounded === '1' && s.arcSize === '50') return type === 'flow' ? pick('terminal') : pick('queue');
  if (s.dashed === '1') return pick('external');
  return DEFAULT_KIND[type];
}

function edgeStyleOf(c: Cell): EdgeStyle {
  const s = c.style;
  const end = s.endArrow ?? 'classic';
  const start = s.startArrow ?? 'none';
  if (end === 'none' && start === 'none') return 'line';
  if (end !== 'none' && start !== 'none') return 'bidir';
  if (s.dashed === '1') return 'async';
  return 'sync';
}

function slug(s: string) {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return out && /^[a-z_]/.test(out) ? out : out ? `n_${out}` : '';
}

// ---------- YAML output ----------

const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;
function q(s: string, inFlow = false): string {
  const plain = /^[A-Za-z_$/(][^:#{}\[\],&*!|>'"%@`\n]*$/.test(s) && !/\s$/.test(s) && !RESERVED.test(s);
  if (plain && !(inFlow && s.includes(','))) return s;
  return JSON.stringify(s);
}

/** A list item like `- head: text`, quoted as one string when the text needs it. */
function lineItem(indent: string, head: string, text?: string): string {
  const startsOdd = /^[\[{"'&*!|>%@`#-]/.test(head);
  if (!text) return `${indent}- ${startsOdd ? JSON.stringify(head) : head}`;
  const plain = q(text) === text && !startsOdd;
  return plain ? `${indent}- ${head}: ${text}` : `${indent}- ${JSON.stringify(`${head}: ${text}`)}`;
}

const CARD_L: Record<Card, string> = { zero_or_one: '|o', one: '||', many: '}o', one_or_many: '}|' };
const CARD_R: Record<Card, string> = { zero_or_one: 'o|', one: '||', many: 'o{', one_or_many: '|{' };

function nodeParts(d: Diagram, n: Node): string[] {
  const parts: string[] = [];
  if (n.label !== humanize(n.id)) parts.push(`label: ${q(n.label, true)}`);
  if (n.kind !== DEFAULT_KIND[d.type]) parts.push(`kind: ${n.kind}`);
  if (n.tech) parts.push(`tech: ${q(n.tech, true)}`);
  if (n.icon) parts.push(`icon: ${n.icon}`);
  if (n.parent) parts.push(`in: ${n.parent}`);
  if (n.color) parts.push(`color: ${n.color}`);
  if (n.highlight) parts.push('highlight: true');
  return parts;
}

export function toYaml(d: Diagram, header?: string): string {
  const out: string[] = [];
  if (header) out.push(...header.split('\n').map((l) => `# ${l}`));
  out.push(`type: ${d.type}`);
  if (d.title) out.push(`title: ${q(d.title)}`);
  if (d.type !== 'sequence') out.push(`direction: ${d.direction}`);
  if (d.theme !== 'clean') out.push(`theme: ${d.theme}`);
  if (d.type === 'sequence') {
    out.push('participants:');
    for (const n of d.nodes) out.push(`  ${n.id}: { ${nodeParts(d, n).join(', ')} }`.replace('{  }', '{}'));
    out.push('messages:');
    writeSeq(d.seq ?? [], '  ', out);
    return out.join('\n') + '\n';
  }
  if (d.groups.length) {
    out.push('groups:');
    for (const g of d.groups) {
      const parts = [`label: ${q(g.label, true)}`];
      if (g.parent) parts.push(`in: ${g.parent}`);
      if (g.color) parts.push(`color: ${g.color}`);
      if (g.highlight) parts.push('highlight: true');
      out.push(`  ${g.id}: { ${parts.join(', ')} }`);
    }
  }
  const isPseudo = (n: Node) => d.type === 'state' && (n.kind === 'start' || n.kind === 'end');
  const pseudo = new Set(d.nodes.filter(isPseudo).map((n) => n.id));
  out.push('nodes:');
  for (const n of d.nodes.filter((n) => !isPseudo(n))) {
    const parts = nodeParts(d, n);
    if (n.fields?.length) {
      out.push(`  ${n.id}:`);
      for (const p of parts) out.push(`    ${p}`);
      out.push('    fields:');
      for (const f of n.fields) {
        const rest = [f.type, ...f.flags].filter(Boolean).join(' ');
        out.push(rest ? `      - ${q(f.name)}: ${q(rest)}` : `      - ${q(f.name)}`);
      }
    } else out.push(`  ${n.id}: { ${parts.join(', ')} }`.replace('{  }', '{}'));
  }
  if (d.edges.length) {
    out.push('edges:');
    const arrow: Record<EdgeStyle, string> = { sync: '->', async: '-.->', bidir: '<->', line: '--' };
    for (const e of d.edges) {
      const from = pseudo.has(e.from) ? '[*]' : e.from;
      const to = pseudo.has(e.to) ? '[*]' : e.to;
      const op = e.card ? `${CARD_L[e.card.from]}${e.card.identifying ? '--' : '..'}${CARD_R[e.card.to]}` : e.highlight && e.style === 'sync' ? '==>' : arrow[e.style];
      if (!e.card && (e.color || (e.highlight && op !== '==>'))) {
        // The one-line form has no room for a color: use the object form.
        const parts = [`from: ${from === '[*]' ? '"[*]"' : from}`, `to: ${to === '[*]' ? '"[*]"' : to}`];
        if (e.label) parts.push(`label: ${q(e.label, true)}`);
        if (e.style !== 'sync') parts.push(`style: ${e.style}`);
        if (e.color) parts.push(`color: ${e.color}`);
        if (e.highlight) parts.push('highlight: true');
        out.push(`  - { ${parts.join(', ')} }`);
      } else out.push(lineItem('  ', `${from} ${op} ${to}`, e.label));
    }
  }
  return out.join('\n') + '\n';
}

function writeSeq(items: SeqItem[], ind: string, out: string[]) {
  const arrow: Record<MessageStyle, string> = { sync: '->', reply: '-->', async: '-.->' };
  for (const it of items) {
    if (it.kind === 'msg') out.push(lineItem(ind, `${it.from} ${it.highlight && it.style === 'sync' ? '==>' : arrow[it.style]} ${it.to}`, it.label));
    else if (it.kind === 'note') {
      const side = it.side === 'over' ? 'over' : it.side === 'left' ? 'left of' : 'right of';
      out.push(lineItem(ind, `note ${side} ${it.over.join(', ')}`, it.text || ' '));
    } else if (it.op === 'alt' || it.op === 'par') {
      out.push(`${ind}- ${it.op}:`);
      for (const b of it.branches) {
        out.push(`${ind}    - when: ${b.when == null ? '""' : q(b.when)}`);
        out.push(`${ind}      do:`);
        if (b.items.length) writeSeq(b.items, `${ind}        `, out);
        else out[out.length - 1] += ' []';
      }
    } else {
      const b = it.branches[0] ?? { items: [] };
      out.push(`${ind}- ${it.op}: ${b.when == null ? '""' : q(b.when)}`);
      out.push(`${ind}  do:`);
      if (b.items.length) writeSeq(b.items, `${ind}    `, out);
      else out[out.length - 1] += ' []';
    }
  }
}

// ---------- manual edit detection ----------

export interface ManualEdit {
  id: string;
  what: 'moved' | 'resized' | 'added';
}

const STRUCTURAL = new Set(['bar', 'frame', 'note', 'guard', 'sep', 'icon']);

/** Changes a person made in draw.io that a plain rebuild would throw away. */
export function manualEdits(m: DrawioModel): ManualEdit[] {
  const out: ManualEdit[] = [];
  for (const c of m.cells) {
    if (STRUCTURAL.has(c.attrs.aiviz_type ?? '') || c.attrs.aiviz_field || c.attrs.aiviz_msg) continue;
    if (c.vertex && !('text' in c.style)) {
      const auto = c.attrs.aiviz_auto?.split(',').map(Number);
      if (!c.attrs.aiviz_kind && !c.attrs.aiviz_type) out.push({ id: c.id, what: 'added' });
      else if (auto && c.geom) {
        const [x, y, w, h] = auto as [number, number, number, number];
        if (Math.abs(c.geom.x - x) > 1 || Math.abs(c.geom.y - y) > 1) out.push({ id: c.id, what: 'moved' });
        else if (Math.abs(c.geom.w - w) > 1 || Math.abs(c.geom.h - h) > 1) out.push({ id: c.id, what: 'resized' });
      }
    } else if (c.edge && !c.attrs.aiviz_edge) out.push({ id: c.id, what: 'added' });
  }
  return out;
}
