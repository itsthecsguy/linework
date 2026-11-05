// Diagram -> absolute geometry, via ELK layered.
import ElkModule from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge, ELK as ElkApi } from 'elkjs/lib/elk-api.js';
import { kindDef, type Diagram, type Direction, type ThemeName } from '../spec/model.js';
import { ER_HEAD, ER_ROW, FIELD_PAD, LINE, PAD_X, PAD_Y, typeface } from '../drawio/theme.js';
import { TextMeasurer, type FontSpec } from './text.js';
import { ICON_PAD } from '../drawio/icons.js';

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
  const go = (dir: Exclude<Direction, 'auto'>) => run(d, dir, sizes, labels, groupMin, groupTop);
  if (d.direction !== 'auto') return { ...(await go(d.direction)), natural };
  // Pick the direction whose result fits a document page best.
  const [tb, lr] = await Promise.all([go('TB'), go('LR')]);
  return { ...(score(tb) <= score(lr) ? tb : lr), natural };
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
      const t = textOf(n, fonts.maxText * 0.7);
      const w = snap(Math.max(128, t.width * 1.5 + 40));
      sizes.set(n.id, { w, h: snap(Math.max(72, w * 0.5, t.lines * fonts.line * 2 + 24)) });
      continue;
    }
    const extra = shapeExtra(shape, !!n.icon);
    const t = textOf(n, fonts.maxText);
    sizes.set(n.id, { w: snap(Math.max(minW, t.width + 2 * PAD_X + extra)), h: boxHeight(t.lines, fonts, shape) });
  }
  const natural = new Map([...sizes].map(([k, v]) => [k, { ...v }]));
  // Boxes of nearly the same width read calmer at exactly the same width. Boxes
  // much wider than the rest keep their own width rather than stretching every box.
  const uniform = d.nodes.filter((n) => !['start', 'end', 'diamond', 'table'].includes(kindDef(d.type, n.kind).shape));
  const sorted = [...uniform].sort((a, b) => sizes.get(a.id)!.w - sizes.get(b.id)!.w);
  let cluster: typeof sorted = [];
  const flush = () => {
    const w = Math.max(0, ...cluster.map((n) => sizes.get(n.id)!.w));
    for (const n of cluster) {
      const s = sizes.get(n.id)!;
      if (s.w === w) continue;
      s.w = w;
      // A wider box may fit the text on fewer lines.
      const shape = kindDef(d.type, n.kind).shape;
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
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
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
    byId.set(n.id, en);
    byId.get(n.parent ?? '__root')!.children!.push(en);
  }
  root.edges = d.edges.map((e, i): ElkExtendedEdge => ({
    id: e.id,
    sources: [e.from],
    targets: [e.to],
    labels: labels[i] ? [{ text: e.label!, width: labels[i]!.w, height: labels[i]!.h }] : [],
  }));

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
      points: [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y })),
      label: lab && lab.x != null ? { x: lab.x, y: lab.y!, w: lab.width!, h: lab.height! } : undefined,
    });
  }
  return { direction: dir, width: out.width!, height: out.height!, nodes, groups, edges };
}
