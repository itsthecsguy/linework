// The normalized diagram model every other module works from.
// The YAML the AI writes is parsed into this by parse.ts.

export const DIAGRAM_TYPES = ['architecture', 'flow', 'state', 'sequence', 'er'] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

export const DIRECTIONS = ['auto', 'TB', 'LR', 'BT', 'RL'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const THEMES = ['clean', 'soft', 'dark', 'midnight', 'paper', 'mono', 'bold', 'sketch', 'blueprint', 'c4'] as const;
export type ThemeName = (typeof THEMES)[number];

export const COLORS = ['blue', 'violet', 'pink', 'red', 'orange', 'amber', 'green', 'teal', 'gray'] as const;
export type ColorName = (typeof COLORS)[number];

/** An accent as the spec may write it: a color name, #RGB, #RRGGBB or bare RRGGBB. Undefined when it is none of those. */
export function normalAccent(raw: string | undefined): string | undefined {
  const s = raw?.trim().toLowerCase();
  if (!s) return undefined;
  if ((COLORS as readonly string[]).includes(s)) return s;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return undefined;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return `#${h.toUpperCase()}`;
}

export type Shape = 'box' | 'cylinder' | 'pill' | 'diamond' | 'parallelogram' | 'start' | 'end' | 'table';

export interface KindDef {
  shape: Shape;
  /** Color in styles that tint by kind (soft, sketch). */
  color: ColorName | 'neutral' | 'ink';
  /** The color means something (error, success), so every style shows it. */
  semantic?: boolean;
  dashed?: boolean;
  description: string;
}

// Kinds are per diagram type so the AI gets a short, relevant list.
export const KINDS: Record<DiagramType, Record<string, KindDef>> = {
  architecture: {
    service: { shape: 'box', color: 'violet', description: 'your own service, API or app server (default)' },
    person: { shape: 'box', color: 'pink', description: 'a human user or role' },
    client: { shape: 'box', color: 'blue', description: 'browser app, mobile app, CLI' },
    function: { shape: 'box', color: 'violet', dashed: true, description: 'serverless function or job' },
    database: { shape: 'cylinder', color: 'green', description: 'relational or document database' },
    cache: { shape: 'box', color: 'green', description: 'Redis, Memcached, CDN cache' },
    storage: { shape: 'cylinder', color: 'green', description: 'object or file storage, data lake' },
    queue: { shape: 'pill', color: 'amber', description: 'queue, topic or event stream' },
    external: { shape: 'box', color: 'gray', dashed: true, description: 'third-party system you do not own' },
  },
  flow: {
    step: { shape: 'box', color: 'neutral', description: 'an action or process step (default)' },
    decision: { shape: 'diamond', color: 'amber', description: 'a yes/no or multi-way branch; label outgoing edges' },
    terminal: { shape: 'pill', color: 'gray', description: 'start or end of the flow' },
    data: { shape: 'parallelogram', color: 'blue', description: 'input or output data' },
    error: { shape: 'box', color: 'red', semantic: true, description: 'failure or rejection path' },
  },
  state: {
    state: { shape: 'box', color: 'violet', description: 'a state (default)' },
    success: { shape: 'box', color: 'green', semantic: true, description: 'a successful terminal state' },
    error: { shape: 'box', color: 'red', semantic: true, description: 'a failure state' },
    start: { shape: 'start', color: 'ink', description: 'initial pseudo-state; usually written as [*] in edges' },
    end: { shape: 'end', color: 'ink', description: 'final pseudo-state; usually written as [*] in edges' },
  },
  sequence: {
    service: { shape: 'box', color: 'violet', description: 'your own service or component (default)' },
    person: { shape: 'box', color: 'pink', description: 'a human actor' },
    client: { shape: 'box', color: 'blue', description: 'browser, mobile app, CLI' },
    function: { shape: 'box', color: 'violet', dashed: true, description: 'serverless function or job' },
    database: { shape: 'box', color: 'green', description: 'relational or document database' },
    cache: { shape: 'box', color: 'green', description: 'Redis, Memcached, CDN cache' },
    storage: { shape: 'box', color: 'green', description: 'object or file storage' },
    queue: { shape: 'box', color: 'amber', description: 'queue, topic or event stream' },
    external: { shape: 'box', color: 'gray', dashed: true, description: 'third-party system' },
  },
  er: {
    entity: { shape: 'table', color: 'violet', description: 'a table or entity (default)' },
    view: { shape: 'table', color: 'blue', dashed: true, description: 'a view or derived table' },
    external: { shape: 'table', color: 'gray', dashed: true, description: 'a table owned by another system' },
  },
};

export const DEFAULT_KIND: Record<DiagramType, string> = { architecture: 'service', flow: 'step', state: 'state', sequence: 'service', er: 'entity' };

export type EdgeStyle = 'sync' | 'async' | 'bidir' | 'line';

/** Color and emphasis a spec can set on a node, group, edge or message. */
export interface Look {
  color?: ColorName;
  highlight?: boolean;
}

export interface Group extends Look {
  id: string;
  label: string;
  parent?: string;
}

export interface Field {
  name: string;
  type?: string;
  /** Lowercase markers: pk, fk, unique, null. */
  flags: string[];
}

export interface Node extends Look {
  id: string;
  label: string;
  kind: string;
  tech?: string;
  parent?: string;
  /** ER only. */
  fields?: Field[];
  /** Architecture only: an icon name like "aws.lambda". */
  icon?: string;
}

/** ER cardinality at one end of a relationship. */
export type Card = 'one' | 'zero_or_one' | 'many' | 'one_or_many';

export interface Edge extends Look {
  /** Stable id: "from->to", with "#2", "#3" for repeats. Used to match edges across edits. */
  id: string;
  from: string;
  to: string;
  label?: string;
  style: EdgeStyle;
  /** ER only: cardinality at each end, and whether the relationship is identifying (solid line). */
  card?: { from: Card; to: Card; identifying: boolean };
}

export type MessageStyle = 'sync' | 'reply' | 'async';
export const FRAME_OPS = ['alt', 'par', 'opt', 'loop', 'critical', 'break'] as const;
export type FrameOp = (typeof FRAME_OPS)[number];

export type SeqItem =
  | { kind: 'msg'; from: string; to: string; label?: string; style: MessageStyle; highlight?: boolean; color?: ColorName }
  | { kind: 'note'; over: string[]; side: 'over' | 'left' | 'right'; text: string }
  | { kind: 'frame'; op: FrameOp; branches: Array<{ when?: string; items: SeqItem[] }> };

export interface Diagram {
  type: DiagramType;
  title?: string;
  direction: Direction;
  theme: ThemeName;
  /** What a highlight is drawn in: a color name, or a brand color as #RRGGBB. Default: the style's own. */
  accent?: string;
  /** Sequence only: messages, notes and frames in order. Participants are `nodes`. */
  seq?: SeqItem[];
  groups: Group[];
  nodes: Node[];
  edges: Edge[];
}

export function kindDef(type: DiagramType, kind: string): KindDef {
  return KINDS[type][kind] ?? KINDS[type][DEFAULT_KIND[type]]!;
}
