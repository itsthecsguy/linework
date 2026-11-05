// Styles ("themes"). Output is plain draw.io style strings, so a person editing in
// draw.io sees and can change ordinary styles.
//
// Color rules, used by every style:
// - Nodes are neutral unless color means something. Semantic kinds (error, success,
//   start/end) always carry their color. `soft` and `sketch` also tint by kind.
// - `color: <name>` tints a node, group or edge. `highlight: true` makes it the
//   strongest thing on the page: a solid fill for nodes, a thick colored line for edges.
import { kindDef, type Card, type ColorName, type DiagramType, type EdgeStyle, type Look, type MessageStyle, type ThemeName } from '../spec/model.js';

const SYSTEM = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif';
export const FONT_STACK = `IBM Plex Sans, ${SYSTEM}`;

export interface Typeface {
  /** The bundled font. Embedded (subset) into every SVG that uses it. */
  face: 'IBM Plex Sans' | 'Kalam' | 'IBM Plex Mono';
  /** CSS font-family list, bundled font first. */
  family: string;
  size: { label: number; sub: number; edge: number; group: number; field: number };
  /** Weight of node names. */
  strong: number;
  /** Group titles in capitals, as lettering on a technical drawing is. Blueprint only. */
  upperGroups: boolean;
}

const SANS: Typeface = { face: 'IBM Plex Sans', family: FONT_STACK, size: { label: 14, sub: 12, edge: 12, group: 12, field: 13 }, strong: 600, upperGroups: false };
const KALAM: Typeface = { face: 'Kalam', family: `Kalam, Comic Sans MS, ${SYSTEM}`, size: { label: 16, sub: 14, edge: 14, group: 15, field: 15 }, strong: 700, upperGroups: false };
const MONO: Typeface = {
  face: 'IBM Plex Mono',
  family: 'IBM Plex Mono, SF Mono, Menlo, Consolas, monospace',
  size: { label: 13, sub: 11, edge: 11, group: 11, field: 12 },
  strong: 600,
  upperGroups: true,
};

/** Line height draw.io uses for HTML labels. */
export const LINE = 1.2;

export function typeface(theme: ThemeName = 'clean'): Typeface {
  return theme === 'sketch' ? KALAM : theme === 'blueprint' ? MONO : SANS;
}

/** Back-compat: sizes of the default style. */
export const font = SANS.size;

// ---------- colors ----------

interface Swatch {
  /** Soft background. */
  tint: string;
  /** Border on a tinted node. */
  line: string;
  /** Text on the tint. */
  ink: string;
  /** Strong fill for highlighted nodes; white text passes WCAG AA on it. */
  solid: string;
  /** Line color for colored and highlighted edges. */
  edge: string;
}

type Swatches = Record<ColorName, Swatch>;

const LIGHT_SW: Swatches = {
  blue: { tint: '#EEF1FF', line: '#A9B8FF', ink: '#1E36B8', solid: '#2B50F5', edge: '#2B50F5' },
  violet: { tint: '#F5F3FF', line: '#C4B5FD', ink: '#5B21B6', solid: '#7C3AED', edge: '#7C3AED' },
  pink: { tint: '#FDF2F8', line: '#F9A8D4', ink: '#9D174D', solid: '#DB2777', edge: '#DB2777' },
  red: { tint: '#FEF2F2', line: '#FCA5A5', ink: '#991B1B', solid: '#DC2626', edge: '#DC2626' },
  orange: { tint: '#FFF7ED', line: '#FDBA74', ink: '#9A3412', solid: '#C2410C', edge: '#EA580C' },
  amber: { tint: '#FFFBEB', line: '#FCD34D', ink: '#92400E', solid: '#B45309', edge: '#D97706' },
  green: { tint: '#F0FDF4', line: '#86EFAC', ink: '#166534', solid: '#15803D', edge: '#16A34A' },
  teal: { tint: '#F0FDFA', line: '#5EEAD4', ink: '#115E59', solid: '#0F766E', edge: '#0D9488' },
  gray: { tint: '#F4F4F5', line: '#D4D4D8', ink: '#3F3F46', solid: '#52525B', edge: '#71717A' },
};

// Soft: borderless cards, so the tint has to carry the color on its own.
const SOFT_TINT: Record<ColorName, string> = {
  blue: '#E0E6FF',
  violet: '#EDE9FE',
  pink: '#FCE7F3',
  red: '#FEE2E2',
  orange: '#FFEDD5',
  amber: '#FEF3C7',
  green: '#DCFCE7',
  teal: '#CCFBF1',
  gray: '#F4F4F5',
};

const DARK_SW: Swatches = {
  blue: { tint: '#141B47', line: '#2A3A99', ink: '#C7D0FF', solid: '#2B50F5', edge: '#7D93FF' },
  violet: { tint: '#2E1065', line: '#5B21B6', ink: '#DDD6FE', solid: '#7C3AED', edge: '#A78BFA' },
  pink: { tint: '#500724', line: '#9D174D', ink: '#FBCFE8', solid: '#DB2777', edge: '#F472B6' },
  red: { tint: '#450A0A', line: '#991B1B', ink: '#FECACA', solid: '#DC2626', edge: '#F87171' },
  orange: { tint: '#431407', line: '#9A3412', ink: '#FED7AA', solid: '#C2410C', edge: '#FB923C' },
  amber: { tint: '#451A03', line: '#92400E', ink: '#FDE68A', solid: '#B45309', edge: '#FBBF24' },
  green: { tint: '#052E16', line: '#166534', ink: '#BBF7D0', solid: '#15803D', edge: '#4ADE80' },
  teal: { tint: '#042F2E', line: '#115E59', ink: '#99F6E4', solid: '#0F766E', edge: '#2DD4BF' },
  gray: { tint: '#27272A', line: '#52525B', ink: '#E4E4E7', solid: '#52525B', edge: '#A1A1AA' },
};

// Blueprint: light lines on deep blue. Color only changes the line.
const BP_LINE: Record<ColorName, string> = {
  blue: '#93C5FD',
  violet: '#C4B5FD',
  pink: '#F9A8D4',
  red: '#FCA5A5',
  orange: '#FDBA74',
  amber: '#FDE68A',
  green: '#86EFAC',
  teal: '#5EEAD4',
  gray: '#CBD5E1',
};

export interface Paint {
  fill: string;
  stroke: string;
  text: string;
  /** Second line (tech) color. */
  sub: string;
  strokeWidth: number;
  /** Extra draw.io style, e.g. sketch fill settings. */
  extra?: string;
}

interface Theme {
  name: ThemeName;
  type: Typeface;
  canvas: string;
  text: string;
  muted: string;
  edge: string;
  edgeText: string;
  edgeWidth: number;
  accent: ColorName;
  /** Tint nodes by their kind's color, not only semantic kinds. */
  kindColors: boolean;
  radius: number;
  /** Groups. `nested` is the fill one level in; filled groups need no outline. */
  group: { fill: string; nested?: string; stroke: string; dashed: boolean; text: string };
  note: { fill: string; stroke: string; text: string };
  /** Header of an ER table and a lifeline's activation bar, when neutral. */
  well: string;
  paint(color: ColorName | 'neutral' | 'ink', highlight: boolean): Paint;
  edgePaint(color: ColorName | undefined, highlight: boolean): { stroke: string; text: string; width: number };
  /** Appended to every shape and edge style. */
  extra: string;
}

function lightPaint(sw: Swatches, neutral: { fill: string; stroke: string }, text: string, muted: string, accent: ColorName) {
  return (color: ColorName | 'neutral' | 'ink', highlight: boolean): Paint => {
    if (highlight) {
      const s = sw[color === 'neutral' || color === 'ink' ? accent : color];
      return { fill: s.solid, stroke: s.solid, text: '#FFFFFF', sub: 'rgba(255,255,255,0.78)', strokeWidth: 1 };
    }
    if (color === 'ink') return { fill: text, stroke: text, text: '#FFFFFF', sub: muted, strokeWidth: 1 };
    if (color === 'neutral') return { ...neutral, text, sub: muted, strokeWidth: 1 };
    const s = sw[color];
    return { fill: s.tint, stroke: s.line, text, sub: s.ink, strokeWidth: 1 };
  };
}

const CLEAN: Theme = {
  name: 'clean',
  type: SANS,
  canvas: '#FFFFFF',
  text: '#17171C',
  muted: '#6B6B76',
  edge: '#A0A0AB',
  edgeText: '#52525C',
  edgeWidth: 1.25,
  accent: 'blue',
  kindColors: false,
  radius: 10,
  group: { fill: '#F5F5F7', nested: '#EBEBEF', stroke: 'none', dashed: false, text: '#6B6B76' },
  note: { fill: '#FFF4CC', stroke: 'none', text: '#5C4300' },
  well: '#F3F3F5',
  paint: lightPaint(LIGHT_SW, { fill: '#FFFFFF', stroke: '#DADAE0' }, '#17171C', '#6B6B76', 'blue'),
  edgePaint: (color, hl) => {
    const s = LIGHT_SW[color ?? 'blue'];
    if (hl) return { stroke: s.edge, text: s.ink, width: 2 };
    return color ? { stroke: s.edge, text: s.ink, width: 1.25 } : { stroke: CLEAN.edge, text: CLEAN.edgeText, width: 1.25 };
  },
  extra: '',
};

const SOFT: Theme = {
  ...CLEAN,
  name: 'soft',
  kindColors: true,
  radius: 12,
  group: { fill: '#F7F7F9', nested: '#EFEFF3', stroke: 'none', dashed: false, text: '#6B6B76' },
  paint: (color, hl) => {
    if (hl || color === 'ink') return CLEAN.paint(color, hl);
    const c = color === 'neutral' ? 'gray' : color;
    return { fill: SOFT_TINT[c], stroke: 'none', text: c === 'gray' ? '#17171C' : LIGHT_SW[c].ink, sub: c === 'gray' ? '#6B6B76' : LIGHT_SW[c].ink + 'B3', strokeWidth: 1 };
  },
};

const DARK: Theme = {
  name: 'dark',
  type: SANS,
  canvas: '#0D1117',
  text: '#E6EDF3',
  muted: '#9198A1',
  edge: '#6E7681',
  edgeText: '#9198A1',
  edgeWidth: 1.25,
  accent: 'blue',
  kindColors: false,
  radius: 10,
  group: { fill: '#151B23', nested: '#1C232D', stroke: 'none', dashed: false, text: '#9198A1' },
  note: { fill: '#3A2F0B', stroke: 'none', text: '#F8E3A1' },
  well: '#262C36',
  paint: (color, hl) => {
    if (hl) {
      const s = DARK_SW[color === 'neutral' || color === 'ink' ? 'blue' : color];
      return { fill: s.solid, stroke: s.solid, text: '#FFFFFF', sub: 'rgba(255,255,255,0.78)', strokeWidth: 1 };
    }
    if (color === 'ink') return { fill: '#E6EDF3', stroke: '#E6EDF3', text: '#0D1117', sub: '#59636E', strokeWidth: 1 };
    if (color === 'neutral') return { fill: '#212830', stroke: '#3D444D', text: '#E6EDF3', sub: '#9198A1', strokeWidth: 1 };
    const s = DARK_SW[color];
    return { fill: s.tint, stroke: s.line, text: '#E6EDF3', sub: s.ink, strokeWidth: 1 };
  },
  edgePaint: (color, hl) => {
    const s = DARK_SW[color ?? 'blue'];
    if (hl) return { stroke: s.edge, text: s.ink, width: 2 };
    return color ? { stroke: s.edge, text: s.ink, width: 1.25 } : { stroke: DARK.edge, text: DARK.edgeText, width: 1.25 };
  },
  extra: '',
};

const SKETCH_INK = '#1E1E1E';
const SKETCH: Theme = {
  name: 'sketch',
  type: KALAM,
  canvas: '#FFFFFF',
  text: SKETCH_INK,
  muted: '#5C5C66',
  edge: '#3F3F46',
  edgeText: '#3F3F46',
  edgeWidth: 1.5,
  accent: 'red',
  kindColors: true,
  radius: 8,
  group: { fill: 'none', stroke: '#71717A', dashed: true, text: '#3F3F46' },
  note: { fill: '#FEF08A', stroke: SKETCH_INK, text: SKETCH_INK },
  well: '#E4E4E7',
  paint: (color, hl) => {
    // Solid pastel fills: hachure lines look the part but run through the text.
    const solid = 'fillStyle=solid;';
    if (color === 'ink') return { fill: SKETCH_INK, stroke: SKETCH_INK, text: '#FFFFFF', sub: '#5C5C66', strokeWidth: 1.5, extra: solid };
    if (hl) {
      const s = LIGHT_SW[color === 'neutral' ? 'red' : color];
      return { fill: s.line, stroke: s.solid, text: SKETCH_INK, sub: s.ink, strokeWidth: 2.5, extra: solid };
    }
    if (color === 'neutral') return { fill: '#FFFFFF', stroke: SKETCH_INK, text: SKETCH_INK, sub: '#5C5C66', strokeWidth: 1.5, extra: solid };
    return { fill: SOFT_TINT[color], stroke: SKETCH_INK, text: SKETCH_INK, sub: '#5C5C66', strokeWidth: 1.5, extra: solid };
  },
  edgePaint: (color, hl) => {
    if (!color && !hl) return { stroke: SKETCH.edge, text: SKETCH.edgeText, width: 1.5 };
    const s = LIGHT_SW[color ?? 'red'];
    return { stroke: s.solid, text: s.ink, width: hl ? 2.5 : 1.5 };
  },
  extra: 'sketch=1;curveFitting=1;jiggle=2;',
};

const BP_BG = '#0F3460';
const BP_INK = '#EAF2FF';
const BP_HI = '#FFD43B';
const BLUEPRINT: Theme = {
  name: 'blueprint',
  type: MONO,
  canvas: BP_BG,
  text: BP_INK,
  muted: '#9DB8DF',
  edge: '#9DB8DF',
  edgeText: '#C9DBF5',
  edgeWidth: 1.25,
  accent: 'amber',
  kindColors: false,
  radius: 4,
  group: { fill: 'none', stroke: '#5B82B8', dashed: true, text: '#9DB8DF' },
  note: { fill: '#16467E', stroke: '#5B82B8', text: BP_INK },
  well: '#16467E',
  paint: (color, hl) => {
    if (hl) return { fill: BP_HI, stroke: BP_HI, text: BP_BG, sub: '#3A4A63', strokeWidth: 1 };
    if (color === 'ink') return { fill: BP_INK, stroke: BP_INK, text: BP_BG, sub: BP_BG, strokeWidth: 1 };
    if (color === 'neutral') return { fill: BP_BG, stroke: BP_INK, text: BP_INK, sub: '#9DB8DF', strokeWidth: 1.25 };
    return { fill: BP_BG, stroke: BP_LINE[color], text: BP_INK, sub: BP_LINE[color], strokeWidth: 1.25 };
  },
  edgePaint: (color, hl) => {
    if (hl) return { stroke: BP_HI, text: BP_HI, width: 2 };
    return color ? { stroke: BP_LINE[color], text: BP_LINE[color], width: 1.25 } : { stroke: BLUEPRINT.edge, text: BLUEPRINT.edgeText, width: 1.25 };
  },
  extra: '',
};

// C4-PlantUML's colours for architecture kinds; other diagram types use `clean`.
const C4_KIND: Record<string, { fill: string; stroke: string; text: string; type: string }> = {
  person: { fill: '#08427B', stroke: '#073B6F', text: '#FFFFFF', type: 'Person' },
  external: { fill: '#999999', stroke: '#8A8A8A', text: '#FFFFFF', type: 'External system' },
};
const C4_CONTAINER = { fill: '#438DD5', stroke: '#3C7FC0', text: '#FFFFFF', type: 'Container' };
const C4: Theme = { ...CLEAN, name: 'c4', group: { fill: 'none', stroke: '#444444', dashed: true, text: '#444444' }, edge: '#707070', edgeText: '#444444' };

const THEMES_BY_NAME: Record<ThemeName, Theme> = { clean: CLEAN, soft: SOFT, dark: DARK, sketch: SKETCH, blueprint: BLUEPRINT, c4: C4 };

export function palette(theme: ThemeName = 'clean'): Theme {
  return THEMES_BY_NAME[theme] ?? CLEAN;
}

const fontPart = (t: Theme, size: number, color: string) => `fontFamily=${t.type.family};fontSize=${size};fontColor=${color};`;

/** How a node of this kind looks. */
export function paintFor(type: DiagramType, kind: string, theme: ThemeName, look: Look = {}): Paint {
  const t = palette(theme);
  if (theme === 'c4' && type === 'architecture' && !look.highlight && !look.color) {
    const c = C4_KIND[kind] ?? C4_CONTAINER;
    return { fill: c.fill, stroke: c.stroke, text: c.text, sub: 'rgba(255,255,255,0.8)', strokeWidth: 1 };
  }
  const k = kindDef(type, kind);
  // A highlight is the style's accent unless the spec names a color.
  if (look.highlight) return t.paint(look.color ?? 'neutral', true);
  const base = look.color ?? (k.color === 'ink' || k.color === 'neutral' || t.kindColors || k.semantic ? k.color : 'neutral');
  return t.paint(base, false);
}

const dashes = (t: Theme) => (t.name === 'sketch' ? 'dashed=1;dashPattern=8 6;' : 'dashed=1;dashPattern=5 4;');

export function nodeStyle(type: DiagramType, kind: string, theme: ThemeName = 'clean', look: Look = {}): string {
  const k = kindDef(type, kind);
  const t = palette(theme);
  const c = paintFor(type, kind, theme, look);
  // Soft cards have no border; a dashed kind still needs one to show its dashes.
  const stroke = c.stroke === 'none' && k.dashed ? '#A1A1AA' : c.stroke;
  const base =
    `html=1;whiteSpace=wrap;spacingLeft=${PAD_X - 4};spacingRight=${PAD_X - 4};${fontPart(t, t.type.size.label, c.text)}` +
    `fillColor=${c.fill};strokeColor=${stroke};strokeWidth=${c.strokeWidth};` +
    (k.dashed ? dashes(t) : '') +
    t.extra +
    (c.extra ?? '');
  const r = t.radius;
  switch (k.shape) {
    case 'cylinder':
      return `shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=7;${base}`;
    case 'pill':
      return `rounded=1;arcSize=50;${base}`;
    case 'diamond':
      return `rhombus;${base}spacingLeft=0;spacingRight=0;`;
    case 'parallelogram':
      return `shape=parallelogram;perimeter=parallelogramPerimeter;fixedSize=1;size=14;${base}`;
    case 'start':
      return `ellipse;aspect=fixed;${base}`;
    case 'end':
      return `ellipse;shape=endState;aspect=fixed;${base}`;
    case 'table': {
      // An entity: header (startSize) with field rows stacked inside.
      const neutral = !look.highlight && !look.color && !(t.kindColors && k.color !== 'neutral');
      const head = neutral && theme !== 'c4' ? t.well : c.fill;
      const border = stroke === 'none' ? head : neutral && theme !== 'c4' ? palette(theme).paint('neutral', false).stroke : stroke;
      return (
        `shape=swimlane;childLayout=stackLayout;horizontal=1;startSize=${ER_HEAD};horizontalStack=0;resizeParent=1;resizeParentMax=0;` +
        `resizeLast=0;collapsible=0;marginBottom=0;rounded=1;absoluteArcSize=1;arcSize=${r + 2};swimlaneFillColor=${t.canvas};fontStyle=1;` +
        base.replace(/fillColor=[^;]*;strokeColor=[^;]*;/, `fillColor=${head};strokeColor=${border};`)
      );
    }
    default:
      return `rounded=1;absoluteArcSize=1;arcSize=${r * 2};${base}`;
  }
}

/** Horizontal text padding inside a node, each side. */
export const PAD_X = 16;
/** Vertical text padding inside a node, each side. */
export const PAD_Y = 12;
export const ER_HEAD = 36;
export const ER_ROW = 28;

export function fieldStyle(theme: ThemeName = 'clean'): string {
  const t = palette(theme);
  return (
    'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;spacingLeft=0;spacingRight=0;overflow=fill;' +
    `rotatable=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;whiteSpace=wrap;${fontPart(t, t.type.size.field, t.text)}`
  );
}

export function groupStyle(theme: ThemeName = 'clean', look: Look = {}, depth = 0): string {
  const t = palette(theme);
  let { fill, stroke, text } = t.group;
  if (depth > 0 && t.group.nested) fill = t.group.nested;
  if (look.color || look.highlight) {
    const p = t.paint(look.color ?? t.accent, false);
    fill = theme === 'blueprint' || theme === 'sketch' ? 'none' : p.fill;
    // A colored ground carries the color; only a highlight adds an outline.
    stroke = look.highlight ? t.edgePaint(look.color, true).stroke : t.group.stroke === 'none' ? 'none' : p.stroke;
    text = p.sub;
  }
  return (
    `rounded=1;absoluteArcSize=1;arcSize=${t.radius * 2 + 4};html=1;whiteSpace=wrap;container=1;collapsible=0;` +
    `fillColor=${fill};strokeColor=${stroke};strokeWidth=${look.highlight ? 1.5 : 1};` +
    (t.group.dashed ? dashes(t) : '') +
    'verticalAlign=top;align=left;spacingLeft=14;spacingTop=9;' +
    `${fontPart(t, t.type.size.group, text)}fontStyle=1;${t.extra}`
  );
}

/** Group title HTML: sentence case, except blueprint's drafting capitals. */
export function groupLabel(label: string, theme: ThemeName = 'clean'): string {
  return typeface(theme).upperGroups ? `<span style="text-transform:uppercase;letter-spacing:0.06em">${esc(label)}</span>` : esc(label);
}

const ARROW = 'endArrow=block;endFill=1;endSize=5;';
const START_ARROW = 'startArrow=block;startFill=1;startSize=5;';

export function edgeStyle(style: EdgeStyle, theme: ThemeName = 'clean', look: Look = {}, labelBg?: string): string {
  const t = palette(theme);
  const p = t.edgePaint(look.color, !!look.highlight);
  const ends = style === 'line' ? 'endArrow=none;startArrow=none;' : style === 'bidir' ? `${ARROW}${START_ARROW}` : `${ARROW}startArrow=none;`;
  return (
    'edgeStyle=orthogonalEdgeStyle;rounded=1;arcSize=16;html=1;' +
    `strokeColor=${p.stroke};strokeWidth=${p.width};${ends}` +
    (style === 'async' ? dashes(t) : '') +
    `${fontPart(t, t.type.size.edge, p.text)}${look.highlight ? 'fontStyle=1;' : ''}labelBackgroundColor=${labelBg ?? t.canvas};labelPadding=1 5;${t.extra}`
  );
}

const ER_END: Record<Card, string> = { one: 'ERmandOne', zero_or_one: 'ERzeroToOne', many: 'ERzeroToMany', one_or_many: 'ERoneToMany' };

export function erEdgeStyle(card: { from: Card; to: Card; identifying: boolean }, theme: ThemeName = 'clean', look: Look = {}): string {
  const t = palette(theme);
  const p = t.edgePaint(look.color, !!look.highlight);
  return (
    'edgeStyle=orthogonalEdgeStyle;rounded=1;arcSize=16;html=1;' +
    `strokeColor=${p.stroke};strokeWidth=${p.width};startArrow=${ER_END[card.from]};endArrow=${ER_END[card.to]};startFill=0;endFill=0;startSize=10;endSize=10;` +
    (card.identifying ? '' : dashes(t)) +
    `${fontPart(t, t.type.size.edge, p.text)}labelBackgroundColor=${t.canvas};labelPadding=1 5;${t.extra}`
  );
}

export function cardFromArrow(arrow: string | undefined): Card | undefined {
  return (Object.entries(ER_END).find(([, v]) => v === arrow)?.[0] as Card | undefined) ?? undefined;
}

export function lifelineStyle(kind: string, theme: ThemeName = 'clean', headH = 48, look: Look = {}): string {
  const t = palette(theme);
  const c = paintFor('sequence', kind, theme, look);
  const k = kindDef('sequence', kind);
  const stroke = c.stroke === 'none' ? (k.dashed ? '#A1A1AA' : c.fill) : c.stroke;
  // The lifeline's dashed stem uses the stroke colour: keep it quiet even when the head is loud.
  return (
    `shape=umlLifeline;perimeter=lifelinePerimeter;container=1;collapsible=0;recursiveResize=0;outlineConnect=0;size=${headH};` +
    `html=1;whiteSpace=wrap;rounded=1;absoluteArcSize=1;arcSize=${t.radius * 2};fillColor=${c.fill};strokeColor=${stroke};strokeWidth=${Math.min(1.5, c.strokeWidth)};` +
    `spacingLeft=${PAD_X - 4};spacingRight=${PAD_X - 4};` +
    (k.dashed ? dashes(t) : '') +
    `${fontPart(t, t.type.size.label, c.text)}${t.extra}${c.extra ?? ''}`
  );
}

export function activationStyle(kind: string, theme: ThemeName = 'clean', look: Look = {}): string {
  const t = palette(theme);
  // A highlighted participant's bar is tinted, not solid: the head already shouts.
  const c = look.highlight ? t.paint(look.color ?? (theme === 'sketch' ? 'red' : t.accent), false) : paintFor('sequence', kind, theme, look);
  const neutral = c.stroke === t.paint('neutral', false).stroke && c.fill === t.paint('neutral', false).fill;
  const fill = neutral ? t.well : c.fill;
  const stroke = c.stroke === 'none' ? fill : neutral ? t.edge : c.stroke;
  return `html=1;points=[];perimeter=orthogonalPerimeter;outlineConnect=0;targetShapes=umlLifeline;portConstraint=eastwest;fillColor=${fill};strokeColor=${stroke};strokeWidth=1;${t.extra}${c.extra ?? ''}`;
}

export function messageStyle(style: MessageStyle, theme: ThemeName = 'clean', self = false, look: Look = {}): string {
  const t = palette(theme);
  const p = t.edgePaint(look.color, !!look.highlight);
  const arrow = style === 'sync' ? 'endArrow=block;endFill=1;' : 'endArrow=open;endFill=0;';
  return (
    `html=1;verticalAlign=bottom;${arrow}endSize=6;strokeWidth=${p.width};strokeColor=${p.stroke};` +
    (style === 'reply' ? dashes(t) : '') +
    (self ? 'edgeStyle=orthogonalEdgeStyle;rounded=1;align=left;spacingLeft=6;verticalAlign=middle;' : '') +
    `${fontPart(t, t.type.size.edge, p.text)}${look.highlight ? 'fontStyle=1;' : ''}labelBackgroundColor=${t.canvas};labelPadding=1 5;${t.extra}`
  );
}

export function frameStyle(theme: ThemeName = 'clean'): string {
  const t = palette(theme);
  const line = t.name === 'dark' ? '#3D444D' : t.name === 'clean' || t.name === 'soft' || t.name === 'c4' ? '#DADAE0' : t.muted;
  // The operator (alt, loop, opt) sits in the corner as a small label, not a UML tab.
  return (
    `rounded=1;absoluteArcSize=1;arcSize=${t.radius * 2};whiteSpace=wrap;html=1;container=0;verticalAlign=top;align=left;spacing=0;spacingLeft=10;spacingTop=4;` +
    `fillColor=none;strokeColor=${line};strokeWidth=1;${fontPart(t, t.type.size.group, t.muted)}fontStyle=1;${t.extra}`
  );
}

export function guardStyle(theme: ThemeName = 'clean'): string {
  const t = palette(theme);
  return `text;html=1;align=left;verticalAlign=middle;labelBackgroundColor=${t.canvas};${fontPart(t, t.type.size.edge, t.muted)}`;
}

export function separatorStyle(theme: ThemeName = 'clean'): string {
  const t = palette(theme);
  return `endArrow=none;dashed=1;dashPattern=4 4;html=1;strokeColor=${t.name === 'dark' ? '#3D444D' : t.name === 'clean' || t.name === 'soft' || t.name === 'c4' ? '#DADAE0' : t.muted};`;
}

export function noteStyle(theme: ThemeName = 'clean'): string {
  const t = palette(theme);
  const shape = t.name === 'sketch' ? 'shape=note;size=10;' : `rounded=1;absoluteArcSize=1;arcSize=${t.radius};`;
  return `${shape}whiteSpace=wrap;html=1;fillColor=${t.note.fill};strokeColor=${t.note.stroke};strokeWidth=1;${fontPart(t, t.type.size.edge, t.note.text)}align=left;spacingLeft=10;spacingRight=10;${t.extra}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface LabelOpts extends Look {
  theme?: ThemeName;
  type?: DiagramType;
  kind?: string;
}

/** HTML label: strong name, optional quieter tech line. C4 adds the element type. */
export function nodeLabel(label: string, tech?: string, opts: LabelOpts = {}): string {
  const theme = opts.theme ?? 'clean';
  const tf = typeface(theme);
  const main = `<span style="font-weight:${tf.strong}">${esc(label)}</span>`;
  const sub = (text: string, color: string) => `${main}<br><span style="font-size:${tf.size.sub}px;color:${color}">${esc(text)}</span>`;
  const p = paintFor(opts.type ?? 'architecture', opts.kind ?? '', theme, opts);
  if (theme === 'c4' && opts.type === 'architecture' && !opts.highlight && !opts.color) {
    const t = (C4_KIND[opts.kind ?? ''] ?? C4_CONTAINER).type;
    return sub(`[${tech ? `${t}: ${tech}` : t}]`, p.sub);
  }
  return tech ? sub(tech, p.sub) : main;
}

/** One ER field row: name on the left, type and key markers on the right. */
export function fieldLabel(name: string, type: string | undefined, flags: string[], theme: ThemeName = 'clean'): string {
  const t = palette(theme);
  const keys = flags.filter((f) => f === 'pk' || f === 'fk').map((f) => f.toUpperCase());
  const rest = flags.filter((f) => f !== 'pk' && f !== 'fk');
  const nameHtml = keys.includes('PK') ? `<span style="font-weight:${t.type.strong}">${esc(name)}</span>` : esc(name);
  const right = [type, ...rest, ...keys].filter(Boolean).join(' ');
  return `<table style="width:100%;height:100%;border-collapse:collapse"><tr><td style="padding:0 6px 0 ${FIELD_PAD}px">${nameHtml}</td><td style="text-align:right;padding:0 ${FIELD_PAD}px 0 6px;color:${t.muted}">${esc(right)}</td></tr></table>`;
}

export const FIELD_PAD = 14;
