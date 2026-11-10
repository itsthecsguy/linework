// Styles ("themes"). Output is plain draw.io style strings, so a person editing in
// draw.io sees and can change ordinary styles.
//
// Color rules, used by every style:
// - Nodes are neutral unless color means something. Semantic kinds (error, success,
//   start/end) always carry their color. `soft`, `sketch` and `bold` also tint by kind.
// - `accent:` in the spec swaps the color highlights are drawn in. Nothing else moves.
// - `color: <name>` tints a node, group or edge. `highlight: true` makes it the
//   strongest thing on the page: a solid fill for nodes, a thick colored line for edges.
import { kindDef, type Card, type ColorName, type DiagramType, type EdgeStyle, type Look, type MessageStyle, type ThemeName } from '../spec/model.js';
import { contrast } from './icons.js';

/** A style by name, or anything that carries one and maybe an accent: a Diagram does. */
export type ThemeArg = ThemeName | { theme: ThemeName; accent?: string };
const nameOf = (a: ThemeArg): ThemeName => (typeof a === 'string' ? a : a.theme);

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

export function typeface(theme: ThemeArg = 'clean'): Typeface {
  const name = nameOf(theme);
  return name === 'sketch' ? KALAM : name === 'blueprint' ? MONO : SANS;
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
  /** Text on `solid`, when white doesn't read on it. Brand colors only. */
  onSolid?: string;
}

type Swatches = Record<ColorName, Swatch>;

const LIGHT_SW: Swatches = {
  blue: { tint: '#EEF1FF', line: '#A9B8FF', ink: '#1E36B8', solid: '#2B50F5', edge: '#2B50F5' },
  violet: { tint: '#F5F3FF', line: '#C4B5FD', ink: '#5B21B6', solid: '#7C3AED', edge: '#7C3AED' },
  pink: { tint: '#FDF2F8', line: '#F9A8D4', ink: '#9D174D', solid: '#DB2777', edge: '#DB2777' },
  red: { tint: '#FEF2F2', line: '#FCA5A5', ink: '#991B1B', solid: '#DC2626', edge: '#DC2626' },
  orange: { tint: '#FFF7ED', line: '#FDBA74', ink: '#9A3412', solid: '#C2410C', edge: '#EA580C' },
  // Ochre, not orange: the two read as one color at line weight otherwise
  amber: { tint: '#FFFBEB', line: '#FCD34D', ink: '#92400E', solid: '#B45309', edge: '#A16207' },
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

// Blueprint: a drafting sheet. Blue ink on pale paper; color only changes the line.
const BP_LINE: Record<ColorName, string> = {
  blue: '#1D4ED8',
  violet: '#6D28D9',
  pink: '#BE185D',
  red: '#B91C1C',
  orange: '#C2410C',
  amber: '#A16207',
  green: '#15803D',
  teal: '#0F766E',
  gray: '#5E6E85',
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
  /** A highlighted node in a brand color, where the style's highlight isn't a plain solid fill. */
  brand?(sw: Swatch, base: Paint): Paint;
  /** Set by `accent:` when it is a hex color: the swatch made from it. */
  custom?: Swatch;
}

function lightPaint(sw: Swatches, neutral: { fill: string; stroke: string }, text: string, muted: string, accent: ColorName) {
  return (color: ColorName | 'neutral' | 'ink', highlight: boolean): Paint => {
    if (highlight) {
      const s = sw[color === 'neutral' || color === 'ink' ? accent : color];
      return { fill: s.solid, stroke: s.solid, text: '#FFFFFF', sub: 'rgba(255,255,255,0.9)', strokeWidth: 1 };
    }
    if (color === 'ink') return { fill: text, stroke: text, text: '#FFFFFF', sub: 'rgba(255,255,255,0.72)', strokeWidth: 1 };
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
  edge: '#868691',
  edgeText: '#52525C',
  edgeWidth: 1.25,
  accent: 'blue',
  kindColors: false,
  radius: 10,
  group: { fill: '#F5F5F7', nested: '#EBEBEF', stroke: 'none', dashed: false, text: '#61616C' },
  note: { fill: '#FFF4CC', stroke: 'none', text: '#5C4300' },
  well: '#F3F3F5',
  paint: lightPaint(LIGHT_SW, { fill: '#FFFFFF', stroke: '#C4C4CC' }, '#17171C', '#6B6B76', 'blue'),
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
  group: { fill: '#F7F7F9', nested: '#EFEFF3', stroke: 'none', dashed: false, text: '#61616C' },
  paint: (color, hl) => {
    if (hl || color === 'ink') return CLEAN.paint(color, hl);
    const c = color === 'neutral' ? 'gray' : color;
    return { fill: SOFT_TINT[c], stroke: 'none', text: c === 'gray' ? '#17171C' : LIGHT_SW[c].ink, sub: c === 'gray' ? '#6B6B76' : LIGHT_SW[c].ink + 'E0', strokeWidth: 1 };
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
      return { fill: s.solid, stroke: s.solid, text: '#FFFFFF', sub: 'rgba(255,255,255,0.9)', strokeWidth: 1 };
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
  accent: 'blue',
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
      const c = color === 'neutral' ? 'blue' : color;
      // A marker pass: a stronger tint than any kind's, under the accent's line
      return { fill: c === 'blue' ? '#B9C6FF' : LIGHT_SW[c].line, stroke: LIGHT_SW[c].solid, text: SKETCH_INK, sub: LIGHT_SW[c].ink, strokeWidth: 2.5, extra: solid };
    }
    if (color === 'neutral') return { fill: '#FFFFFF', stroke: SKETCH_INK, text: SKETCH_INK, sub: '#5C5C66', strokeWidth: 1.5, extra: solid };
    return { fill: SOFT_TINT[color], stroke: SKETCH_INK, text: SKETCH_INK, sub: '#5C5C66', strokeWidth: 1.5, extra: solid };
  },
  edgePaint: (color, hl) => {
    if (!color && !hl) return { stroke: SKETCH.edge, text: SKETCH.edgeText, width: 1.5 };
    const s = LIGHT_SW[color ?? 'blue'];
    return { stroke: s.solid, text: s.ink, width: hl ? 2.5 : 1.5 };
  },
  brand: (sw, base) => ({ ...base, fill: mix(sw.solid, '#FFFFFF', 0.62), stroke: legible(sw.solid, '#FFFFFF', SKETCH_INK, 3), sub: sw.ink }),
  extra: 'sketch=1;curveFitting=1;jiggle=2;',
};

const BP_PAPER = '#F6F8FC';
const BP_INK = '#1B2F55';
const BP_LINE_INK = '#3F5F96';
const BP_HI = '#1D4ED8';
const BLUEPRINT: Theme = {
  name: 'blueprint',
  type: MONO,
  canvas: BP_PAPER,
  text: BP_INK,
  muted: '#5A6F92',
  edge: '#6F86AD',
  edgeText: '#4A5F84',
  edgeWidth: 1.25,
  accent: 'blue',
  kindColors: false,
  radius: 4,
  group: { fill: 'none', stroke: '#7489AF', dashed: true, text: '#5A6F92' },
  note: { fill: '#EAF0FA', stroke: '#9DB0D0', text: BP_INK },
  well: '#EAF0FA',
  paint: (color, hl) => {
    if (hl) return { fill: BP_HI, stroke: BP_HI, text: '#FFFFFF', sub: 'rgba(255,255,255,0.8)', strokeWidth: 1 };
    if (color === 'ink') return { fill: BP_INK, stroke: BP_INK, text: '#FFFFFF', sub: '#C9D5EA', strokeWidth: 1 };
    if (color === 'neutral') return { fill: '#FFFFFF', stroke: BP_LINE_INK, text: BP_INK, sub: '#5A6F92', strokeWidth: 1.25 };
    return { fill: '#FFFFFF', stroke: BP_LINE[color], text: BP_INK, sub: BP_LINE[color], strokeWidth: 1.25 };
  },
  edgePaint: (color, hl) => {
    if (hl) return { stroke: BP_HI, text: BP_HI, width: 2 };
    return color ? { stroke: BP_LINE[color], text: BP_LINE[color], width: 1.25 } : { stroke: BLUEPRINT.edge, text: BLUEPRINT.edgeText, width: 1.25 };
  },
  extra: '',
};

// Midnight: a second dark style. Navy ground, softer contrast than `dark`.
const MID_SW: Swatches = {
  blue: { tint: '#1C2C54', line: '#3B5BA8', ink: '#C5D5FF', solid: '#3D63DD', edge: '#88A6F7' },
  violet: { tint: '#2A2452', line: '#5B4BA8', ink: '#D8D0FF', solid: '#6D55D9', edge: '#A99BF5' },
  pink: { tint: '#3D1F3D', line: '#8E4583', ink: '#F5C9EC', solid: '#B5479F', edge: '#E08ACF' },
  red: { tint: '#40202A', line: '#96404F', ink: '#F7C6CC', solid: '#C8475A', edge: '#EC8794' },
  orange: { tint: '#40281C', line: '#96592F', ink: '#F8D2B5', solid: '#B85C22', edge: '#EBA06C' },
  amber: { tint: '#3A3018', line: '#8C742B', ink: '#F2E3A6', solid: '#946F12', edge: '#E3C25E' },
  green: { tint: '#1B3529', line: '#3B7A57', ink: '#BFEBD0', solid: '#2E7D55', edge: '#7FD0A2' },
  teal: { tint: '#16343A', line: '#2F7A85', ink: '#B4EAF0', solid: '#237583', edge: '#6CCBD8' },
  gray: { tint: '#243150', line: '#44536F', ink: '#D5DCEA', solid: '#4B5A78', edge: '#93A0B8' },
};
const MID_TEXT = '#E2E8F5';
const MIDNIGHT: Theme = {
  name: 'midnight',
  type: SANS,
  canvas: '#101727',
  text: MID_TEXT,
  muted: '#93A0B8',
  edge: '#64748B',
  edgeText: '#9AA7BD',
  edgeWidth: 1.25,
  accent: 'blue',
  kindColors: false,
  radius: 10,
  group: { fill: '#162036', nested: '#1D2946', stroke: 'none', dashed: false, text: '#93A0B8' },
  note: { fill: '#3B3418', stroke: 'none', text: '#F2E3A6' },
  well: '#243150',
  paint: (color, hl) => {
    if (hl) {
      const s = MID_SW[color === 'neutral' || color === 'ink' ? 'blue' : color];
      return { fill: s.solid, stroke: s.solid, text: '#FFFFFF', sub: 'rgba(255,255,255,0.9)', strokeWidth: 1 };
    }
    if (color === 'ink') return { fill: MID_TEXT, stroke: MID_TEXT, text: '#101727', sub: '#4B5A78', strokeWidth: 1 };
    if (color === 'neutral') return { fill: '#1B2540', stroke: '#44536F', text: MID_TEXT, sub: '#93A0B8', strokeWidth: 1 };
    const s = MID_SW[color];
    return { fill: s.tint, stroke: s.line, text: MID_TEXT, sub: s.ink, strokeWidth: 1 };
  },
  edgePaint: (color, hl) => {
    const s = MID_SW[color ?? 'blue'];
    if (hl) return { stroke: s.edge, text: s.ink, width: 2 };
    return color ? { stroke: s.edge, text: s.ink, width: 1.25 } : { stroke: MIDNIGHT.edge, text: MIDNIGHT.edgeText, width: 1.25 };
  },
  extra: '',
};

// Paper: warm cream stock, brown ink, earth-toned accents. For long reads.
const PAPER_SW: Swatches = {
  blue: { tint: '#E8EDF2', line: '#A9B9CC', ink: '#2F4A6B', solid: '#3B5B85', edge: '#4A6C99' },
  violet: { tint: '#EEE9F2', line: '#BDB0CF', ink: '#54406F', solid: '#6A5290', edge: '#7A62A0' },
  pink: { tint: '#F5E6EA', line: '#D9AEBB', ink: '#7E3550', solid: '#9C4667', edge: '#AD5576' },
  red: { tint: '#F6E3DD', line: '#DFA899', ink: '#7F2C1D', solid: '#A63D2A', edge: '#B5492F' },
  orange: { tint: '#F8E8D8', line: '#E3B58C', ink: '#7F4416', solid: '#B4532A', edge: '#C0622F' },
  amber: { tint: '#F7EDCB', line: '#DCC37A', ink: '#6E5210', solid: '#8A6510', edge: '#94700F' },
  green: { tint: '#E6EEDD', line: '#A9C294', ink: '#3A5626', solid: '#4C7033', edge: '#5A803D' },
  teal: { tint: '#DFEEEA', line: '#97C3B8', ink: '#245A50', solid: '#2F7265', edge: '#3A8375' },
  gray: { tint: '#EFE9DD', line: '#CDBFA9', ink: '#4E4336', solid: '#6B5D4D', edge: '#8C7B68' },
};
const PAPER: Theme = {
  name: 'paper',
  type: SANS,
  canvas: '#FAF6EE',
  text: '#2B2118',
  muted: '#756553',
  edge: '#8C7B68',
  edgeText: '#5E4F3F',
  edgeWidth: 1.25,
  accent: 'orange',
  kindColors: false,
  radius: 8,
  group: { fill: '#F1EADB', nested: '#E8DEC9', stroke: 'none', dashed: false, text: '#6B5B49' },
  note: { fill: '#F6E7B4', stroke: 'none', text: '#5C4300' },
  well: '#EFE7D6',
  paint: lightPaint(PAPER_SW, { fill: '#FFFDF8', stroke: '#CDBFA9' }, '#2B2118', '#756553', 'orange'),
  edgePaint: (color, hl) => {
    const s = PAPER_SW[color ?? 'orange'];
    if (hl) return { stroke: s.edge, text: s.ink, width: 2 };
    return color ? { stroke: s.edge, text: s.ink, width: 1.25 } : { stroke: PAPER.edge, text: PAPER.edgeText, width: 1.25 };
  },
  extra: '',
};

// Mono: black ink, no color. For print, papers and RFCs. A color in the spec
// becomes a gray ground; a highlight is solid black, or a heavy line on an edge.
const MONO_INK = '#111111';
const MONO_PAINT: Paint = { fill: '#FFFFFF', stroke: MONO_INK, text: MONO_INK, sub: '#4D4D4D', strokeWidth: 1.25 };
const MONO_THEME: Theme = {
  name: 'mono',
  type: SANS,
  canvas: '#FFFFFF',
  text: MONO_INK,
  muted: '#4D4D4D',
  edge: MONO_INK,
  edgeText: MONO_INK,
  edgeWidth: 1.25,
  accent: 'gray',
  kindColors: false,
  radius: 4,
  group: { fill: 'none', stroke: '#6B6B6B', dashed: true, text: '#333333' },
  note: { fill: '#F2F2F2', stroke: MONO_INK, text: MONO_INK },
  well: '#E8E8E8',
  paint: (color, hl) => {
    if (hl) return { fill: MONO_INK, stroke: MONO_INK, text: '#FFFFFF', sub: 'rgba(255,255,255,0.85)', strokeWidth: 1.25 };
    if (color === 'ink') return { fill: '#4D4D4D', stroke: '#4D4D4D', text: '#FFFFFF', sub: 'rgba(255,255,255,0.85)', strokeWidth: 1.25 };
    if (color === 'neutral') return MONO_PAINT;
    return { ...MONO_PAINT, fill: '#E8E8E8' };
  },
  edgePaint: (_color, hl) => ({ stroke: MONO_INK, text: MONO_INK, width: hl ? 2.5 : 1.25 }),
  extra: '',
};

// Bold: thick black outlines, flat bright fills and a hard drop shadow. For slides.
const BOLD_INK = '#111111';
const BOLD_FILL: Record<ColorName, string> = {
  blue: '#9DBEFF',
  violet: '#C9B8FF',
  pink: '#FFA8D5',
  red: '#FF9A8F',
  orange: '#FFB878',
  amber: '#FFDD57',
  green: '#93E6A6',
  teal: '#84E3D7',
  gray: '#E7E5DF',
};
const BOLD_SHADOW = `shadow=1;shadowColor=${BOLD_INK};shadowOffsetX=3;shadowOffsetY=3;shadowBlur=0;shadowOpacity=100;`;
const boldPaint = (fill: string, text = BOLD_INK): Paint => ({ fill, stroke: BOLD_INK, text, sub: text === BOLD_INK ? '#333333' : 'rgba(255,255,255,0.92)', strokeWidth: 2, extra: BOLD_SHADOW });
const BOLD: Theme = {
  name: 'bold',
  type: SANS,
  canvas: '#FFFDF5',
  text: BOLD_INK,
  muted: '#4A4A4A',
  edge: BOLD_INK,
  edgeText: BOLD_INK,
  edgeWidth: 2,
  accent: 'blue',
  kindColors: true,
  radius: 6,
  group: { fill: 'none', stroke: BOLD_INK, dashed: true, text: BOLD_INK },
  note: { fill: '#FFF3A8', stroke: BOLD_INK, text: BOLD_INK },
  well: '#E7E5DF',
  paint: (color, hl) => {
    if (hl) return { ...boldPaint(LIGHT_SW[color === 'neutral' || color === 'ink' ? 'blue' : color].solid, '#FFFFFF'), strokeWidth: 2.5 };
    if (color === 'ink') return boldPaint(BOLD_INK, '#FFFFFF');
    return boldPaint(color === 'neutral' ? '#FFFFFF' : BOLD_FILL[color]);
  },
  brand: (sw, base) => ({ ...base, fill: sw.solid, text: sw.onSolid ?? '#FFFFFF', sub: sw.onSolid ?? 'rgba(255,255,255,0.92)' }),
  edgePaint: (color, hl) => {
    const stroke = color ? LIGHT_SW[color].solid : hl ? LIGHT_SW.blue.solid : BOLD_INK;
    return { stroke, text: color || hl ? LIGHT_SW[color ?? 'blue'].ink : BOLD_INK, width: hl ? 3.5 : 2 };
  },
  extra: '',
};

// ---------- accent ----------

const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** `a` mixed toward `b`: 0 is all `a`, 1 is all `b`. */
function mix(a: string, b: string, t: number): string {
  const [x, y] = [hexRgb(a), hexRgb(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** `color`, moved toward `toward` only as far as it takes to stand `ratio` clear of `on`. */
function legible(color: string, on: string, toward: string, ratio: number): string {
  for (let t = 0; t <= 1; t += 0.1) {
    const c = mix(color, toward, t);
    if (contrast(c, on) >= ratio) return c;
  }
  return toward;
}

/** A swatch for a brand color, fitted to the style's canvas and text. */
function brandSwatch(hex: string, t: Theme): Swatch {
  const onSolid = contrast('#FFFFFF', hex) >= 4.5 || contrast('#FFFFFF', hex) >= contrast('#17171C', hex) ? '#FFFFFF' : '#17171C';
  return {
    tint: mix(hex, t.canvas, 0.9),
    line: mix(hex, t.canvas, 0.5),
    ink: legible(hex, t.canvas, t.text, 4.5),
    solid: hex,
    edge: legible(hex, t.canvas, t.text, 3),
    onSolid,
  };
}

const accented = new Map<string, Theme>();

/** The style with its highlight color swapped for the spec's `accent:`. */
function withAccent(t: Theme, accent: string): Theme {
  const key = `${t.name} ${accent}`;
  const hit = accented.get(key);
  if (hit) return hit;
  const plain = (c: ColorName | 'neutral' | 'ink' | undefined) => c === undefined || c === 'neutral' || c === 'ink';
  let out: Theme;
  if (!accent.startsWith('#')) {
    // A named color: the style already knows how to draw it.
    const name = accent as ColorName;
    out = { ...t, accent: name, paint: (c, hl) => t.paint(hl && plain(c) ? name : c, hl), edgePaint: (c, hl) => t.edgePaint(hl && !c ? name : c, hl) };
  } else {
    const sw = brandSwatch(accent, t);
    out = {
      ...t,
      custom: sw,
      paint: (c, hl) => {
        const base = t.paint(c, hl);
        if (!hl || !plain(c)) return base;
        if (t.brand) return t.brand(sw, base);
        const on = sw.onSolid ?? '#FFFFFF';
        return { ...base, fill: sw.solid, stroke: sw.solid, text: on, sub: on };
      },
      edgePaint: (c, hl) => {
        const base = t.edgePaint(c, hl);
        return hl && !c ? { ...base, stroke: sw.edge, text: sw.ink } : base;
      },
    };
  }
  accented.set(key, out);
  return out;
}

// C4's convention (a dark person, blue containers, gray external systems) in
// quieter tones than C4-PlantUML's, so a highlight still stands out, with white text at 4.5:1 or better on each.
// Other diagram types use `clean`.
const C4_KIND: Record<string, { fill: string; stroke: string; text: string; type: string }> = {
  person: { fill: '#1E3466', stroke: '#1E3466', text: '#FFFFFF', type: 'Person' },
  external: { fill: '#626A7A', stroke: '#626A7A', text: '#FFFFFF', type: 'External system' },
};
const C4_CONTAINER = { fill: '#456A9E', stroke: '#456A9E', text: '#FFFFFF', type: 'Container' };
const C4: Theme = { ...CLEAN, name: 'c4', group: { fill: 'none', stroke: '#444444', dashed: true, text: '#444444' }, edge: '#707070', edgeText: '#444444' };

const THEMES_BY_NAME: Record<ThemeName, Theme> = { clean: CLEAN, soft: SOFT, dark: DARK, midnight: MIDNIGHT, paper: PAPER, mono: MONO_THEME, bold: BOLD, sketch: SKETCH, blueprint: BLUEPRINT, c4: C4 };

export function palette(theme: ThemeArg = 'clean'): Theme {
  const t = THEMES_BY_NAME[nameOf(theme)] ?? CLEAN;
  const accent = typeof theme === 'string' ? undefined : theme.accent;
  return accent ? withAccent(t, accent) : t;
}

/** The tinted (not solid) paint of the accent: a highlighted group's ground, a highlighted lifeline's bar. */
function accentTint(t: Theme, fallback: ColorName = t.accent): Paint {
  const p = t.paint(t.custom ? 'neutral' : fallback, false);
  return t.custom ? { ...p, fill: t.custom.tint, stroke: t.custom.line, sub: t.custom.ink } : p;
}

const fontPart = (t: Theme, size: number, color: string) => `fontFamily=${t.type.family};fontSize=${size};fontColor=${color};`;

/** How a node of this kind looks. */
export function paintFor(type: DiagramType, kind: string, theme: ThemeArg, look: Look = {}): Paint {
  const t = palette(theme);
  if (t.name === 'c4' && type === 'architecture' && !look.highlight && !look.color) {
    const c = C4_KIND[kind] ?? C4_CONTAINER;
    return { fill: c.fill, stroke: c.stroke, text: c.text, sub: 'rgba(255,255,255,0.92)', strokeWidth: 1 };
  }
  const k = kindDef(type, kind);
  // A highlight is the style's accent unless the spec names a color.
  if (look.highlight) return t.paint(look.color ?? 'neutral', true);
  const base = look.color ?? (k.color === 'ink' || k.color === 'neutral' || t.kindColors || k.semantic ? k.color : 'neutral');
  return t.paint(base, false);
}

const dashes = (t: Theme) => (t.name === 'sketch' ? 'dashed=1;dashPattern=8 6;' : 'dashed=1;dashPattern=5 4;');

export function nodeStyle(type: DiagramType, kind: string, theme: ThemeArg = 'clean', look: Look = {}): string {
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
      // With an outline the lid is drawn, and the text centres on the face below
      // it. Without one (soft) the lid is invisible: centre on the whole shape.
      return `shape=cylinder3;boundedLbl=${stroke === 'none' ? 0 : 1};backgroundOutline=1;size=${CYL_SIZE};${base}`;
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
      const head = neutral && t.name !== 'c4' ? t.well : c.fill;
      const border = stroke === 'none' ? head : neutral && t.name !== 'c4' ? t.paint('neutral', false).stroke : stroke;
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

/** Depth of a cylinder's lid and base curve. */
export const CYL_SIZE = 7;

/**
 * Vertical centre of a node's text, from the top of its box. draw.io bounds a
 * cylinder's label between its lid (2 x size) and 0.3 x size above the base.
 */
export function textMiddle(style: string, h: number): number {
  if (!/shape=cylinder3/.test(style) || !/boundedLbl=1/.test(style)) return h / 2;
  return (2 * CYL_SIZE + h - 0.3 * CYL_SIZE) / 2;
}

/** Horizontal text padding inside a node, each side. */
export const PAD_X = 16;
/** Vertical text padding inside a node, each side. */
export const PAD_Y = 12;
export const ER_HEAD = 36;
export const ER_ROW = 28;

export function fieldStyle(theme: ThemeArg = 'clean'): string {
  const t = palette(theme);
  return (
    'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;spacingLeft=0;spacingRight=0;overflow=fill;' +
    `rotatable=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;whiteSpace=wrap;${fontPart(t, t.type.size.field, t.text)}`
  );
}

/** Styles whose groups are outlines: a colored one changes its line, never gains a fill. */
const OUTLINED = new Set<ThemeName>(['blueprint', 'sketch', 'mono', 'bold']);

/** Left inset of a group's title. */
export const GROUP_INSET = 14;

export function groupStyle(theme: ThemeArg = 'clean', look: Look = {}, depth = 0): string {
  const t = palette(theme);
  let { fill, stroke, text } = t.group;
  if (depth > 0 && t.group.nested) fill = t.group.nested;
  if (look.color || look.highlight) {
    const p = look.color ? t.paint(look.color, false) : accentTint(t);
    fill = OUTLINED.has(t.name) ? 'none' : p.fill;
    // A colored ground carries the color; only a highlight adds an outline.
    stroke = look.highlight ? t.edgePaint(look.color, true).stroke : t.group.stroke === 'none' ? 'none' : p.stroke;
    text = p.sub;
  }
  return (
    `rounded=1;absoluteArcSize=1;arcSize=${t.radius * 2 + 4};html=1;whiteSpace=wrap;container=1;collapsible=0;` +
    `fillColor=${fill};strokeColor=${stroke};strokeWidth=${look.highlight ? 1.5 : 1};` +
    (t.group.dashed ? dashes(t) : '') +
    `verticalAlign=top;align=left;spacingLeft=${GROUP_INSET};spacingTop=9;` +
    `${fontPart(t, t.type.size.group, text)}fontStyle=1;${t.extra}`
  );
}

/** Group title HTML: sentence case, except blueprint's drafting capitals. */
export function groupLabel(label: string, theme: ThemeArg = 'clean'): string {
  return typeface(theme).upperGroups ? `<span style="text-transform:uppercase;letter-spacing:0.06em">${esc(label)}</span>` : esc(label);
}

const ARROW = 'endArrow=block;endFill=1;endSize=5;';
const START_ARROW = 'startArrow=block;startFill=1;startSize=5;';

export function edgeStyle(style: EdgeStyle, theme: ThemeArg = 'clean', look: Look = {}, labelBg?: string): string {
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

export function erEdgeStyle(card: { from: Card; to: Card; identifying: boolean }, theme: ThemeArg = 'clean', look: Look = {}): string {
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

export function lifelineStyle(kind: string, theme: ThemeArg = 'clean', headH = 48, look: Look = {}): string {
  const t = palette(theme);
  const c = paintFor('sequence', kind, theme, look);
  const k = kindDef('sequence', kind);
  // The dashed stem takes the stroke color, so a highlighted head keeps the plain
  // participant line: the accent stays on the head and the highlighted messages.
  const quiet = t.paint('neutral', false).stroke;
  const stroke = look.highlight ? (quiet === 'none' ? t.edge : quiet) : c.stroke === 'none' ? (k.dashed ? '#A1A1AA' : c.fill) : c.stroke;
  return (
    `shape=umlLifeline;perimeter=lifelinePerimeter;container=1;collapsible=0;recursiveResize=0;outlineConnect=0;size=${headH};` +
    `html=1;whiteSpace=wrap;rounded=1;absoluteArcSize=1;arcSize=${t.radius * 2};fillColor=${c.fill};strokeColor=${stroke};strokeWidth=${Math.min(1.5, c.strokeWidth)};` +
    `spacingLeft=${PAD_X - 4};spacingRight=${PAD_X - 4};` +
    (k.dashed ? dashes(t) : '') +
    `${fontPart(t, t.type.size.label, c.text)}${t.extra}${c.extra ?? ''}`
  );
}

export function activationStyle(kind: string, theme: ThemeArg = 'clean', look: Look = {}): string {
  const t = palette(theme);
  // A highlighted participant's bar is tinted, not solid: the head already shouts.
  const c = look.highlight ? (look.color ? t.paint(look.color, false) : accentTint(t, t.name === 'sketch' ? 'red' : t.accent)) : paintFor('sequence', kind, theme, look);
  const neutral = c.stroke === t.paint('neutral', false).stroke && c.fill === t.paint('neutral', false).fill;
  const fill = neutral ? t.well : c.fill;
  const stroke = c.stroke === 'none' ? fill : neutral ? t.edge : c.stroke;
  return `html=1;points=[];perimeter=orthogonalPerimeter;outlineConnect=0;targetShapes=umlLifeline;portConstraint=eastwest;fillColor=${fill};strokeColor=${stroke};strokeWidth=1;${t.extra}${c.extra ?? ''}`;
}

export function messageStyle(style: MessageStyle, theme: ThemeArg = 'clean', self = false, look: Look = {}): string {
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

/** Padding of a sequence frame's operator tab, and its inset from the frame's corner. */
export const FRAME_TAB_X = 9, FRAME_TAB_Y = 3, FRAME_TAB_INSET = 4;

export function frameStyle(theme: ThemeArg = 'clean'): string {
  const t = palette(theme);
  // The operator (alt, loop, opt) sits in a small tab in the frame's corner: UML's
  // pentagon, drawn as a chip, inset the same from both sides so its square corner
  // stays inside the frame's rounded one. draw.io draws an HTML label's background
  // 1px left of and 3.5px below where its spacing puts it; the +1 and -3.5 cancel that.
  return (
    `rounded=1;absoluteArcSize=1;arcSize=${t.radius * 2};whiteSpace=wrap;html=1;container=0;verticalAlign=top;align=left;spacing=0;spacingLeft=${FRAME_TAB_X + FRAME_TAB_INSET + 1};spacingTop=${FRAME_TAB_Y + FRAME_TAB_INSET - 3.5};` +
    `labelBackgroundColor=${t.well};labelPadding=${FRAME_TAB_Y} ${FRAME_TAB_X};` +
    `fillColor=none;strokeColor=${t.edge};strokeWidth=1;${fontPart(t, t.type.size.group, t.text)}fontStyle=1;${t.extra}`
  );
}

export function guardStyle(theme: ThemeArg = 'clean'): string {
  const t = palette(theme);
  return `text;html=1;align=left;verticalAlign=middle;labelBackgroundColor=${t.canvas};${fontPart(t, t.type.size.edge, t.muted)}`;
}

export function separatorStyle(theme: ThemeArg = 'clean'): string {
  const t = palette(theme);
  return `endArrow=none;dashed=1;dashPattern=4 4;html=1;strokeColor=${t.edge};`;
}

export function noteStyle(theme: ThemeArg = 'clean'): string {
  const t = palette(theme);
  const shape = t.name === 'sketch' ? 'shape=note;size=10;' : `rounded=1;absoluteArcSize=1;arcSize=${t.radius};`;
  return `${shape}whiteSpace=wrap;html=1;fillColor=${t.note.fill};strokeColor=${t.note.stroke};strokeWidth=1;${fontPart(t, t.type.size.edge, t.note.text)}align=left;spacingLeft=10;spacingRight=10;${t.extra}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface LabelOpts extends Look {
  theme?: ThemeArg;
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
  if (nameOf(theme) === 'c4' && opts.type === 'architecture' && !opts.highlight && !opts.color) {
    const t = (C4_KIND[opts.kind ?? ''] ?? C4_CONTAINER).type;
    return sub(`[${tech ? `${t}: ${tech}` : t}]`, p.sub);
  }
  return tech ? sub(tech, p.sub) : main;
}

/** One ER field row: name on the left, type and key markers on the right. */
export function fieldLabel(name: string, type: string | undefined, flags: string[], theme: ThemeArg = 'clean'): string {
  const t = palette(theme);
  const keys = flags.filter((f) => f === 'pk' || f === 'fk').map((f) => f.toUpperCase());
  const rest = flags.filter((f) => f !== 'pk' && f !== 'fk');
  const nameHtml = keys.includes('PK') ? `<span style="font-weight:${t.type.strong}">${esc(name)}</span>` : esc(name);
  const right = [type, ...rest, ...keys].filter(Boolean).join(' ');
  return `<table style="width:100%;height:100%;border-collapse:collapse"><tr><td style="padding:0 6px 0 ${FIELD_PAD}px">${nameHtml}</td><td style="text-align:right;padding:0 ${FIELD_PAD}px 0 6px;color:${t.muted}">${esc(right)}</td></tr></table>`;
}

export const FIELD_PAD = 14;
