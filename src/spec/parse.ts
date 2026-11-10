// YAML spec -> Diagram. Every error says where it is and how to fix it,
// because the reader is usually a model that will retry.
import YAML from 'yaml';
import { parseIcon } from '../drawio/icons.js';
import { z } from 'zod';
import {
  DEFAULT_KIND,
  DIAGRAM_TYPES,
  DIRECTIONS,
  FRAME_OPS,
  KINDS,
  THEMES,
  COLORS,
  normalAccent,
  type ColorName,
  type Card,
  type Diagram,
  type DiagramType,
  type Edge,
  type EdgeStyle,
  type Field,
  type FrameOp,
  type Group,
  type MessageStyle,
  type Node,
  type SeqItem,
} from './model.js';

const scalar = z.union([z.string(), z.number(), z.boolean()]).transform(String);

const FieldInput = z.union([
  scalar,
  z.record(z.string(), z.union([scalar, z.null()])),
  z.strictObject({ name: scalar, type: scalar.optional(), flags: z.array(z.string()).optional() }),
]);

// Checked by hand so a wrong name gets a helpful message.
const ColorInput = z.string();
const HighlightInput = z.boolean();

const NodeInput = z.union([
  scalar,
  z.strictObject({
    label: scalar.optional(),
    kind: z.string().optional(),
    tech: scalar.optional(),
    in: z.string().optional(),
    icon: z.string().optional(),
    fields: z.array(FieldInput).optional(),
    color: ColorInput.optional(),
    highlight: HighlightInput.optional(),
  }),
]);

const GroupInput = z.union([
  scalar,
  z.strictObject({
    label: scalar.optional(),
    in: z.string().optional(),
    color: ColorInput.optional(),
    highlight: HighlightInput.optional(),
  }),
]);

const EdgeObject = z.strictObject({
  from: z.string(),
  to: z.string(),
  label: scalar.optional(),
  style: z.enum(['sync', 'async', 'bidir', 'line']).optional(),
  color: ColorInput.optional(),
  highlight: HighlightInput.optional(),
});

const EdgeInput = z.union([z.string(), EdgeObject, z.record(z.string(), z.union([scalar, z.null()]))]);

// Messages: "a -> b: text", "note over a, b: text", or a frame object.
const MessageInput: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.record(z.string(), z.unknown())]),
);

export const SpecInput = z.strictObject({
  type: z.enum(DIAGRAM_TYPES),
  title: scalar.optional(),
  direction: z.enum(DIRECTIONS).optional(),
  theme: z.enum(THEMES).optional(),
  accent: z.union([scalar, z.null()]).optional(),
  groups: z.record(z.string(), GroupInput).optional(),
  nodes: z.record(z.string(), NodeInput).optional(),
  edges: z.array(EdgeInput).optional(),
  participants: z.record(z.string(), NodeInput).optional(),
  messages: z.array(MessageInput).optional(),
});
export type SpecInput = z.input<typeof SpecInput>;

export interface Issue {
  path: string;
  message: string;
}

export class SpecError extends Error {
  constructor(public issues: Issue[]) {
    super(issues.map((i) => `${i.path ? i.path + ': ' : ''}${i.message}`).join('\n'));
    this.name = 'SpecError';
  }
}

export interface ParseResult {
  diagram: Diagram;
  warnings: Issue[];
}

const ID_RE = /^[A-Za-z_][\w.-]*$/;
const MSG_ARROWS: Record<string, MessageStyle> = { '->': 'sync', '==>': 'sync', '-->': 'reply', '-.->': 'async' };
const MSG_RE = /^\s*(\S+)\s+(-->|-\.->|==>|->)\s+(\S+)\s*$/;
const NOTE_RE = /^\s*note\s+(over|left of|right of)\s+(.+?)\s*$/i;
const ER_RE = /^\s*(\S+)\s+([|}][o|])(--|\.\.)([o|][|{])\s+(\S+)\s*$/;
const CARD_LEFT: Record<string, Card> = { '|o': 'zero_or_one', '||': 'one', '}o': 'many', '}|': 'one_or_many' };
const CARD_RIGHT: Record<string, Card> = { 'o|': 'zero_or_one', '||': 'one', 'o{': 'many', '|{': 'one_or_many' };
const FIELD_FLAGS = new Set(['pk', 'fk', 'uk', 'unique', 'null', 'nullable', 'not_null']);
const ARROWS: Record<string, EdgeStyle> = { '->': 'sync', '==>': 'sync', '-.->': 'async', '<->': 'bidir', '--': 'line' };
const EDGE_RE = /^\s*(\S+)\s+(<->|-\.->|==>|->|--)\s+(\S+)\s*$/;
export const START_ID = '_start';
export const END_ID = '_end';

export function parseSpecText(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new SpecError([{ path: '', message: `invalid YAML: ${(e as Error).message}` }]);
  }
  return parseSpec(raw);
}

/** The spec's accent, checked. Unquoted, `accent: #E11D48` is a YAML comment and arrives as null. */
function accentOf(raw: string | null | undefined): { accent?: string } {
  if (raw === undefined) return {};
  const accent = normalAccent(raw ?? undefined);
  if (accent) return { accent };
  const hint = raw === null ? 'YAML reads an unquoted # as a comment, so quote it' : `got "${raw}"`;
  throw new SpecError([{ path: 'accent', message: `accent is a color name (${COLORS.join(', ')}) or a hex color in quotes, like accent: "#E11D48" (${hint}).` }]);
}

export function parseSpec(raw: unknown): ParseResult {
  const res = SpecInput.safeParse(raw);
  if (!res.success) throw new SpecError(res.error.issues.map(zodIssue));
  const spec = res.data;
  const type = spec.type;
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  if (type === 'sequence') return parseSequence(spec);
  if (spec.participants || spec.messages) {
    throw new SpecError([{ path: spec.participants ? 'participants' : 'messages', message: `participants and messages are for type: sequence. A ${type} diagram uses nodes and edges.` }]);
  }
  if (!spec.nodes) throw new SpecError([{ path: 'nodes', message: 'nodes is required: a map of id -> { label, kind, tech, in }' }]);

  const groups: Group[] = [];
  for (const [id, g] of Object.entries(spec.groups ?? {})) {
    if (!ID_RE.test(id)) issues.push({ path: `groups.${id}`, message: badId(id) });
    const obj = typeof g === 'string' ? { label: g } : g;
    groups.push({ id, label: obj.label ?? humanize(id), parent: obj.in, ...look(obj, `groups.${id}`, issues) });
  }
  const groupIds = new Set(groups.map((g) => g.id));

  const nodes: Node[] = [];
  for (const [id, n] of Object.entries(spec.nodes)) {
    const path = `nodes.${id}`;
    if (!ID_RE.test(id)) issues.push({ path, message: badId(id) });
    if (groupIds.has(id)) issues.push({ path, message: `"${id}" is already a group id. Node and group ids must be unique.` });
    const obj = typeof n === 'string' ? { label: n } : n;
    const kind = obj.kind ?? DEFAULT_KIND[type];
    if (!KINDS[type][kind]) {
      issues.push({ path: `${path}.kind`, message: `unknown kind "${kind}" for a ${type} diagram. Use one of: ${Object.keys(KINDS[type]).join(', ')}.` });
    }
    const node: Node = { id, label: obj.label ?? humanize(id), kind, tech: obj.tech, parent: obj.in, ...look(obj, path, issues) };
    if ('icon' in obj && obj.icon) {
      const ic = parseIcon(obj.icon);
      if (type !== 'architecture') warnings.push({ path: `${path}.icon`, message: 'icons only show on architecture diagrams' });
      else if ('error' in ic) issues.push({ path: `${path}.icon`, message: ic.error });
      else node.icon = `${ic.provider}.${ic.name}`;
    }
    if ('fields' in obj && obj.fields) {
      if (type !== 'er') issues.push({ path: `${path}.fields`, message: 'fields are for type: er' });
      else node.fields = obj.fields.map((f, i) => parseField(f, `${path}.fields[${i}]`, issues)).filter((f): f is Field => !!f);
    }
    nodes.push(node);
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  if (nodes.length === 0) issues.push({ path: 'nodes', message: 'add at least one node' });

  for (const item of [...groups, ...nodes]) {
    if (item.parent && !groupIds.has(item.parent)) {
      const where = groupIds.has(item.id) ? 'groups' : 'nodes';
      issues.push({ path: `${where}.${item.id}.in`, message: `group "${item.parent}" doesn't exist.${suggest(item.parent, groupIds)}` });
    }
  }
  for (const g of groups) {
    const seen = new Set<string>();
    for (let p: string | undefined = g.id; p; p = groups.find((x) => x.id === p)?.parent) {
      if (seen.has(p)) {
        issues.push({ path: `groups.${g.id}.in`, message: 'groups are nested in a cycle' });
        break;
      }
      seen.add(p);
    }
  }

  // Edges
  const edges: Edge[] = [];
  const counts = new Map<string, number>();
  let needStart = false;
  const endFor = new Set<string>(); // one end dot per source keeps edges from piling up
  (spec.edges ?? []).forEach((item, i) => {
    const path = `edges[${i}]`;
    let parsed: { from: string; to: string; label?: string; style: EdgeStyle; color?: ColorName; highlight?: boolean } | null = null;
    if (type === 'er') {
      let text: string | null = null;
      if (typeof item === 'string') text = item;
      else if (!('from' in item)) {
        const entries = Object.entries(item);
        if (entries.length === 1) text = entries[0]![1] == null ? entries[0]![0] : `${entries[0]![0]}: ${entries[0]![1]}`;
      }
      if (text == null) {
        issues.push({ path, message: 'write ER relationships like "- users }o--|| orgs: belongs to"' });
        return;
      }
      parsed = parseErEdge(text, path, issues);
    } else if (typeof item === 'string') parsed = parseEdgeString(item, path, issues);
    else if ('from' in item && 'to' in item && typeof item.from === 'string') {
      const o = item as z.infer<typeof EdgeObject>;
      parsed = { from: o.from, to: o.to, label: o.label, style: o.style ?? 'sync', ...look(o, path, issues) };
    } else {
      const entries = Object.entries(item);
      if (entries.length !== 1) {
        issues.push({ path, message: 'write each edge as one line, like "- api -> db: SQL"' });
        return;
      }
      const [head, label] = entries[0]!;
      parsed = parseEdgeString(label == null ? head : `${head}: ${label}`, path, issues);
    }
    if (!parsed) return;
    for (const end of ['from', 'to'] as const) {
      const id = parsed[end];
      if (id === '[*]') {
        if (type !== 'state') {
          issues.push({ path, message: '[*] is only for state diagrams. Add a terminal node instead.' });
          return;
        }
        if (end === 'from') { parsed.from = START_ID; needStart = true; }
        else { endFor.add(parsed.from); parsed.to = `${END_ID}_${parsed.from === START_ID ? 'start' : parsed.from}`; }
        continue;
      }
      if (groupIds.has(id)) {
        issues.push({ path, message: `"${id}" is a group. Connect edges to nodes inside it instead.` });
        return;
      }
      if (!nodeIds.has(id)) issues.push({ path, message: `node "${id}" doesn't exist.${suggest(id, nodeIds)} Declare it under nodes: first.` });
    }
    const base = `${parsed.from}->${parsed.to}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    edges.push({ id: n === 1 ? base : `${base}#${n}`, ...parsed });
  });
  if (needStart && !nodeIds.has(START_ID)) nodes.unshift({ id: START_ID, label: '', kind: 'start' });
  for (const from of endFor) nodes.push({ id: `${END_ID}_${from === START_ID ? 'start' : from}`, label: '', kind: 'end' });

  if (issues.length) throw new SpecError(issues);

  // Warnings: things that produce worse diagrams but still render.
  const real = nodes.filter((n) => n.kind !== 'start' && n.kind !== 'end');
  if (real.length > 20) warnings.push({ path: 'nodes', message: `${real.length} nodes is a lot for one diagram. Consider splitting it; 12 or fewer reads best.` });
  if (type === 'flow') {
    for (const n of nodes.filter((n) => n.kind === 'decision')) {
      const out = edges.filter((e) => e.from === n.id);
      if (out.some((e) => !e.label)) warnings.push({ path: `nodes.${n.id}`, message: 'label every edge leaving a decision, e.g. "yes"/"no"' });
      if (n.label.length > 40) warnings.push({ path: `nodes.${n.id}`, message: `a diamond holds little text; shorten "${n.label.slice(0, 24)}..." to a short question and put the detail in the step before it` });
    }
  }
  highlightWarning(real, edges, warnings);
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  for (const n of real) if (edges.length && !linked.has(n.id)) warnings.push({ path: `nodes.${n.id}`, message: 'not connected to anything' });

  return {
    diagram: { type, title: spec.title, direction: spec.direction ?? 'auto', theme: spec.theme ?? 'clean', ...accentOf(spec.accent), groups, nodes, edges },
    warnings,
  };
}

function parseErEdge(s: string, path: string, issues: Issue[]) {
  const colon = s.indexOf(':');
  const head = colon >= 0 ? s.slice(0, colon) : s;
  const label = colon >= 0 ? s.slice(colon + 1).trim() : '';
  const m = ER_RE.exec(head);
  if (!m) {
    issues.push({
      path,
      message: `can't read relationship "${s}". Use Mermaid crow's-foot notation with spaces around it, e.g. "orders }o--|| users: placed by". Ends: || one, |o zero or one, }o / o{ many, }| / |{ one or many. Middle: -- identifying, .. non-identifying.`,
    });
    return null;
  }
  return {
    from: m[1]!,
    to: m[5]!,
    label: label || undefined,
    style: 'line' as EdgeStyle,
    card: { from: CARD_LEFT[m[2]!]!, to: CARD_RIGHT[m[4]!]!, identifying: m[3] === '--' },
  };
}

function parseField(f: unknown, path: string, issues: Issue[]): Field | null {
  let name: string, rest: string;
  if (typeof f === 'string' || typeof f === 'number' || typeof f === 'boolean') {
    const parts = String(f).trim().split(/\s+/);
    name = parts.shift() ?? '';
    rest = parts.join(' ');
  } else if (f && typeof f === 'object' && Object.keys(f).length === 1) {
    // "- name: text" is a field called "name" of type text, not the long form.
    const [k, v] = Object.entries(f as Record<string, unknown>)[0]!;
    name = k;
    rest = v == null ? '' : String(v);
  } else if (f && typeof f === 'object' && 'name' in f) {
    const o = f as { name: string; type?: string; flags?: string[] };
    return { name: String(o.name), type: o.type, flags: (o.flags ?? []).map((x) => x.toLowerCase()) };
  } else {
    issues.push({ path, message: 'write a field as "name: type flags", e.g. "- id: uuid pk"' });
    return null;
  }
  const flags: string[] = [];
  const type: string[] = [];
  for (const tok of rest.split(/\s+/).filter(Boolean)) (FIELD_FLAGS.has(tok.toLowerCase()) ? flags : type).push(tok.toLowerCase() === 'nullable' ? 'null' : FIELD_FLAGS.has(tok.toLowerCase()) ? tok.toLowerCase() : tok);
  return { name, type: type.join(' ') || undefined, flags };
}

// ---------- sequence ----------

function parseSequence(spec: z.infer<typeof SpecInput>): ParseResult {
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  for (const k of ['nodes', 'edges', 'groups', 'direction'] as const)
    if (spec[k] !== undefined) issues.push({ path: k, message: `a sequence diagram uses participants and messages, not ${k}` });
  if (!spec.participants) issues.push({ path: 'participants', message: 'participants is required: an ordered map of id -> { label, kind }' });
  const nodes: Node[] = [];
  for (const [id, n] of Object.entries(spec.participants ?? {})) {
    const path = `participants.${id}`;
    if (!ID_RE.test(id)) issues.push({ path, message: badId(id) });
    const obj = typeof n === 'string' ? { label: n } : n;
    const kind = obj.kind ?? 'service';
    if (!KINDS.sequence[kind]) issues.push({ path: `${path}.kind`, message: `unknown kind "${kind}" for a sequence diagram. Use one of: ${Object.keys(KINDS.sequence).join(', ')}.` });
    if ('fields' in obj && obj.fields) issues.push({ path: `${path}.fields`, message: 'fields are for type: er' });
    nodes.push({ id, label: obj.label ?? humanize(id), kind, tech: obj.tech, ...look(obj, path, issues) });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const need = (id: string, path: string) => {
    if (!ids.has(id)) issues.push({ path, message: `participant "${id}" doesn't exist.${suggest(id, ids)} Declare it under participants: first.` });
  };
  const items = (list: unknown[], path: string): SeqItem[] =>
    list.flatMap((item, i) => {
      const p = `${path}[${i}]`;
      const r = seqItem(item, p);
      return r ? [r] : [];
    });
  const seqItem = (item: unknown, path: string): SeqItem | null => {
    if (typeof item === 'string') return seqString(item, path);
    if (!item || typeof item !== 'object') {
      issues.push({ path, message: 'expected a message like "a -> b: text"' });
      return null;
    }
    const o = item as Record<string, unknown>;
    const op = Object.keys(o).find((k) => (FRAME_OPS as readonly string[]).includes(k)) as FrameOp | undefined;
    if (op) {
      const v = o[op];
      if (op === 'alt' || op === 'par') {
        if (!Array.isArray(v)) {
          issues.push({ path, message: `${op} takes a list of branches: - ${op}: [ { when: condition, do: [messages] }, ... ]` });
          return null;
        }
        const branches = v.map((b, j) => {
          const bo = (b ?? {}) as Record<string, unknown>;
          if (!Array.isArray(bo.do)) issues.push({ path: `${path}.${op}[${j}]`, message: 'each branch needs do: [messages]' });
          return { when: bo.when == null ? undefined : String(bo.when), items: items(Array.isArray(bo.do) ? bo.do : [], `${path}.${op}[${j}].do`) };
        });
        return { kind: 'frame', op, branches };
      }
      if (!Array.isArray(o.do)) {
        issues.push({ path, message: `${op} needs do: [messages], e.g. - ${op}: every 5s\n    do:\n      - a -> b: poll` });
        return null;
      }
      return { kind: 'frame', op, branches: [{ when: v == null ? undefined : String(v), items: items(o.do, `${path}.do`) }] };
    }
    const entries = Object.entries(o);
    if (entries.length === 1) {
      const [head, label] = entries[0]!;
      return seqString(label == null ? head : `${head}: ${label}`, path);
    }
    issues.push({ path, message: `unknown item. Use a message "a -> b: text", a note "note over a: text", or a frame (${FRAME_OPS.join(', ')}).` });
    return null;
  };
  const seqString = (s: string, path: string): SeqItem | null => {
    const colon = s.indexOf(':');
    const head = colon >= 0 ? s.slice(0, colon) : s;
    const text = colon >= 0 ? s.slice(colon + 1).trim() : '';
    const note = NOTE_RE.exec(head);
    if (note) {
      const over = note[2]!.split(',').map((x) => x.trim()).filter(Boolean);
      over.forEach((id) => need(id, path));
      const side = note[1]!.toLowerCase().startsWith('left') ? 'left' : note[1]!.toLowerCase().startsWith('right') ? 'right' : 'over';
      return { kind: 'note', over, side, text };
    }
    const m = MSG_RE.exec(head);
    if (!m) {
      issues.push({ path, message: `can't read "${s}". Messages: "a -> b: call", "b --> a: reply", "a -.-> b: async", "a ==> b: highlighted call". Notes: "note over a: text". Spaces around the arrow.` });
      return null;
    }
    need(m[1]!, path);
    need(m[3]!, path);
    return { kind: 'msg', from: m[1]!, to: m[3]!, label: text || undefined, style: MSG_ARROWS[m[2]!]!, ...(m[2] === '==>' ? { highlight: true } : {}) };
  };
  const seq = items(spec.messages ?? [], 'messages');
  if (issues.length) throw new SpecError(issues);
  const msgs: Array<{ highlight?: boolean }> = [];
  const flat = (xs: SeqItem[]) => xs.forEach((x) => (x.kind === 'msg' ? msgs.push(x) : x.kind === 'frame' ? x.branches.forEach((b) => flat(b.items)) : 0));
  flat(seq);
  highlightWarning(nodes, msgs, warnings);
  if (nodes.length > 8) warnings.push({ path: 'participants', message: `${nodes.length} participants is wide; 6 or fewer fits a doc page` });
  return { diagram: { type: 'sequence', title: spec.title, direction: 'auto', theme: spec.theme ?? 'clean', ...accentOf(spec.accent), groups: [], nodes, edges: [], seq }, warnings };
}

function parseEdgeString(s: string, path: string, issues: Issue[]) {
  const colon = s.indexOf(':');
  const head = colon >= 0 ? s.slice(0, colon) : s;
  const label = colon >= 0 ? s.slice(colon + 1).trim() : '';
  const m = EDGE_RE.exec(head);
  if (!m) {
    issues.push({ path, message: `can't read edge "${s}". Write it as "from -> to: label", with spaces around the arrow. Arrows: -> (call), ==> (highlighted call), -.-> (async), <-> (two-way), -- (no arrow).` });
    return null;
  }
  return { from: m[1]!, to: m[3]!, label: label || undefined, style: ARROWS[m[2]!]!, ...(m[2] === '==>' ? { highlight: true } : {}) };
}

function look(o: { color?: string; highlight?: boolean }, path: string, issues: Issue[]): { color?: ColorName; highlight?: boolean } {
  const out: { color?: ColorName; highlight?: boolean } = {};
  if (o.color != null) {
    const c = o.color.toLowerCase();
    if ((COLORS as readonly string[]).includes(c)) out.color = c as ColorName;
    else issues.push({ path: `${path}.color`, message: `unknown color "${o.color}". Use one of: ${COLORS.join(', ')}.` });
  }
  if (o.highlight) out.highlight = true;
  return out;
}

/** Emphasis only works when it's rare. */
function highlightWarning(nodes: Array<{ highlight?: boolean }>, edges: Array<{ highlight?: boolean }>, warnings: Issue[]) {
  const hn = nodes.filter((i) => i.highlight).length, he = edges.filter((i) => i.highlight).length;
  if (hn > Math.max(2, nodes.length / 4) || he > Math.max(4, edges.length / 3))
    warnings.push({
      path: 'highlight',
      message: `${hn} nodes and ${he} edges are highlighted. Highlight the one path or part the reader should see first; with this many, nothing stands out. Use color: for categories instead.`,
    });
}

function zodIssue(i: z.core.$ZodIssue): Issue {
  const path = i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '');
  if (i.code === 'unrecognized_keys') {
    const known: Record<string, string> = {
      '': 'type, title, direction, theme, accent, groups, nodes, edges (or participants, messages for sequence)',
    };
    const where =
      path.startsWith('nodes') || path.startsWith('participants')
        ? 'label, kind, tech, in, icon, fields, color, highlight'
        : path.startsWith('groups')
          ? 'label, in, color, highlight'
          : path.startsWith('edges')
            ? 'from, to, label, style, color, highlight'
            : known[''];
    return { path, message: `unknown key(s) ${i.keys.map((k) => `"${k}"`).join(', ')}. Allowed here: ${where}.` };
  }
  if (i.code === 'invalid_value' && path === 'type') return { path, message: `type must be one of: ${DIAGRAM_TYPES.join(', ')}` };
  if (i.code === 'invalid_value' && path === 'theme') return { path, message: `theme must be one of: ${THEMES.join(', ')}` };
  if (i.code === 'invalid_value' && path === 'direction') return { path, message: `direction must be one of: ${DIRECTIONS.join(', ')}` };
  if (i.code === 'invalid_type' && path === 'nodes') return { path, message: 'nodes is required: a map of id -> { label, kind, tech, in }' };
  if (i.code === 'invalid_union') return { path, message: path.startsWith('edges') ? 'each edge is a string like "a -> b: label"' : 'expected a label string or an object' };
  return { path, message: i.message };
}

function badId(id: string) {
  return `"${id}" isn't a valid id. Use letters, digits, _ . or - and start with a letter, e.g. order_db.`;
}

export function humanize(id: string) {
  const s = id.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function suggest(id: string, pool: Set<string>) {
  let best: string | undefined, bestD = Infinity;
  for (const p of pool) {
    const d = lev(id.toLowerCase(), p.toLowerCase());
    if (d < bestD) [best, bestD] = [p, d];
  }
  return best && bestD <= Math.max(2, Math.floor(id.length / 3)) ? ` Did you mean "${best}"?` : '';
}

function lev(a: string, b: string) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export function jsonSchema() {
  return z.toJSONSchema(SpecInput, { io: 'input' });
}

export type { DiagramType };
