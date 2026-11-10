// A built diagram as an Excalidraw scene (.excalidraw). The .drawio.svg stays the
// file linework builds into; this is a copy to open and edit in Excalidraw, and
// import.ts reads the edits back.
//
// Every element says which draw.io cell it came from and what part of it it is
// (customData.lw), which is how an edited file is matched to the diagram again.
//
// Geometry comes from draw.io's own renderer (inspect), so hand edits and routed
// edges carry over exactly. What Excalidraw has no shape for is assembled from
// parts and grouped: a cylinder is two ellipses and a body, a table is boxes and
// text. Icons become embedded SVG images.
import { fingerprint, labelLines, type Cell, type DrawioModel } from '../drawio/read.js';
import { toDiagram, toYaml } from '../drawio/show.js';
import type { DrawioBrowser, InspectCell } from '../render/browser.js';

type Box = { x: number; y: number; w: number; h: number };
type P = { x: number; y: number };

export interface ExcalidrawElement {
  id: string;
  type: 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'line' | 'text' | 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  groupIds: string[];
  boundElements: Array<{ id: string; type: 'text' | 'arrow' }>;
  [key: string]: unknown;
}

export interface ExcalidrawFile {
  type: 'excalidraw';
  version: 2;
  source: string;
  elements: ExcalidrawElement[];
  appState: { viewBackgroundColor: string; gridSize: null; theme: 'light' };
  files: Record<string, { mimeType: string; id: string; dataURL: string; created: number; lastRetrieved: number }>;
}

/** Excalidraw's line height for text. */
const LINE_HEIGHT = 1.25;

/** Excalidraw's font ids, and a font to measure with that sets about as wide. */
const FONTS = {
  hand: { id: 5, css: 'Kalam, cursive' }, // Excalifont
  code: { id: 3, css: 'IBM Plex Mono, monospace' }, // Cascadia
  normal: { id: 2, css: 'Liberation Sans, Helvetica, Arial, sans-serif' }, // Helvetica
};
type Font = (typeof FONTS)[keyof typeof FONTS];
const fontOf = (family = ''): Font => (/Kalam/i.test(family) ? FONTS.hand : /Mono/i.test(family) ? FONTS.code : FONTS.normal);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 2147483647;
}

const color = (c: string | undefined, fallback = 'transparent') => (!c || c === 'none' ? 'transparent' : c === 'default' ? fallback : c);
const num = (s: string | undefined, d: number) => (s != null && s !== '' && Number.isFinite(+s) ? +s : d);
const r2 = (n: number) => Math.round(n * 100) / 100;

type Anchor = { cx: number; cy: number } | { left: number; cy: number } | { right: number; cy: number };

interface PendingText {
  el: ExcalidrawElement;
  size: number;
  font: Font;
  /** Where the text goes once it is measured: its centre, or its left or right edge at a vertical centre. */
  at: Anchor;
  /** Break lines to fit this width. Excalidraw wraps text bound to a shape itself, but only once it is edited. */
  wrap?: number;
  /** Texts that share a key are stacked in order, and the stack is centred on `at.cy`. */
  stack?: string;
}

/** What linework records on each element: the draw.io cell it draws, and which part of it. */
export interface Origin {
  cell: string;
  part: string;
  /** On a few elements: the diagram's spec, so the file can be imported without its .drawio.svg. */
  doc?: { v: 1; spec: string; base: string };
}

/** Greedy line breaking, given a width for any string. */
export function wrapLines(text: string, max: number, width: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && width(next) > max) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Excalidraw sizes an arrowhead to half its last segment, up to 15px. A point this far from the end keeps heads the size draw.io draws them. */
const HEAD_RUN = 16;

/** A point `d` short of the end of the route's last segment, when that segment is long enough to take one. */
function headPoint(pts: P[], atStart: boolean): P | undefined {
  const end = atStart ? pts[0]! : pts[pts.length - 1]!, prev = atStart ? pts[1]! : pts[pts.length - 2]!;
  const len = Math.hypot(end.x - prev.x, end.y - prev.y);
  return len > HEAD_RUN + 8 ? lerp(end, prev, HEAD_RUN / len) : undefined;
}

const orthogonal = (pts: P[]) => pts.every((p, i) => !i || Math.abs(p.x - pts[i - 1]!.x) < 0.5 || Math.abs(p.y - pts[i - 1]!.y) < 0.5);

/** The outline of a box with fully round ends, as points. */
function pillOutline(w: number, h: number, steps = 10): Array<[number, number]> {
  const r = Math.min(w, h) / 2;
  const arc = (cx: number, from: number) => Array.from({ length: steps + 1 }, (_, i): [number, number] => {
    const a = from + (Math.PI * i) / steps;
    return [r2(cx + r * Math.cos(a)), r2(r + r * Math.sin(a))];
  });
  // Right end from top to bottom, then the left end from bottom to top.
  return [...arc(w - r, -Math.PI / 2), ...arc(r, Math.PI / 2)];
}


/** Arrowheads: draw.io's name to Excalidraw's. */
const HEADS: Record<string, string | null> = {
  none: null,
  block: 'triangle',
  classic: 'triangle',
  open: 'arrow',
  ERmandOne: 'crowfoot_one',
  ERzeroToOne: 'crowfoot_one',
  ERzeroToMany: 'crowfoot_many',
  ERoneToMany: 'crowfoot_one_or_many',
};

function distToSegment(p: P, a: P, b: P): { d: number; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { d: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)), t };
}

/** The route's nearest point to `p`: which segment, how far along it, and how far off. */
function nearest(pts: P[], p: P): { i: number; t: number; d: number } {
  let best = { i: 0, t: 0, d: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const r = distToSegment(p, pts[i]!, pts[i + 1]!);
    if (r.d < best.d) best = { i, ...r };
  }
  return best;
}

const lerp = (a: P, b: P, t: number): P => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * Excalidraw puts an arrow's label at the middle of its path: the middle point when
 * the count is odd, the middle of the middle segment when even. That is often a
 * corner. Given where linework put the label, add points along the straight runs
 * (which changes nothing drawn) until the middle of the path is that spot.
 */
export function centreRouteOn(pts: P[], label: P): P[] {
  const n = pts.length;
  const natural = n % 2 ? pts[(n - 1) / 2]! : lerp(pts[n / 2 - 1]!, pts[n / 2]!, 0.5);
  const hit = nearest(pts, label);
  const a = pts[hit.i]!, b = pts[hit.i + 1]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 4) return pts;
  // Keep clear of the segment's ends so the two new points stay in order.
  const at = Math.max(2, Math.min(len - 2, hit.t * len));
  const spot = lerp(a, b, at / len);
  if (Math.hypot(spot.x - natural.x, spot.y - natural.y) <= 6) return pts;
  const half = Math.min(4, at / 2, (len - at) / 2);
  const before = pts.slice(0, hit.i + 1), after = pts.slice(hit.i + 1);
  const lo = (at - half) / len, hi = (at + half) / len;
  // The label's segment is the middle one when as many points come before it as after.
  const padLeft = Math.max(0, after.length - before.length), padRight = Math.max(0, before.length - after.length);
  const left = Array.from({ length: padLeft }, (_, k) => lerp(a, b, (lo * (k + 1)) / (padLeft + 1)));
  const right = Array.from({ length: padRight }, (_, k) => lerp(a, b, hi + ((1 - hi) * (k + 1)) / (padRight + 1)));
  return [...before, ...left, lerp(a, b, lo), lerp(a, b, hi), ...right, ...after];
}

/** A node label's second line (what it's built with), with the size and color its HTML gives it. */
export function techLine(c: Cell): { text: string; style: Record<string, string> } | undefined {
  const m = /<br\s*\/?>\s*<span style="font-size:(\d+)px;color:([^"]+)">([\s\S]*)<\/span>\s*$/i.exec(c.label);
  if (!m) return undefined;
  const value = labelLines(m[3]!).join(' ');
  return value ? { text: value, style: { ...c.style, fontSize: m[1]!, ...(/^#[0-9a-f]{6}$/i.test(m[2]!) ? { fontColor: m[2]! } : {}) } } : undefined;
}

/** The text a node is drawn with: its name, and its second line when it has one. Export writes these; import compares against them. */
export function drawnText(c: Cell): { label: string; tech?: string } {
  const lines = labelLines(c.label);
  const tech = techLine(c);
  return tech ? { label: lines.slice(0, -1).join(' ') || lines[0] || '', tech: tech.text } : { label: lines.join(' ') };
}

export async function toExcalidraw(m: DrawioModel, b: DrawioBrowser): Promise<ExcalidrawFile> {
  const inspected = await b.inspect(m.xml);
  const geo = new Map(inspected.map((c) => [c.id, c]));
  const background = /<mxGraphModel[^>]*\sbackground="(#[0-9a-fA-F]{6})"/.exec(m.xml)?.[1] ?? '#FFFFFF';

  const elements: ExcalidrawElement[] = [];
  const texts: PendingText[] = [];
  /** Cell id to the element arrows attach to. */
  const anchors = new Map<string, ExcalidrawElement>();
  const icons: Array<{ cell: string; el: ExcalidrawElement }> = [];
  /** A sequence diagram's participants: no arrow attaches to them, but they can carry the spec. */
  const heads: ExcalidrawElement[] = [];
  /** The cell being drawn; every element made meanwhile is a part of it. */
  let cell = '';

  const make = (id: string, type: ExcalidrawElement['type'], box: Box, s: Record<string, string>, over: Record<string, unknown> = {}): ExcalidrawElement => {
    const own = `lw-${cell}`;
    const origin: Origin = { cell, part: id === own ? 'shape' : id.slice(own.length + 1) };
    const el: ExcalidrawElement = {
      id,
      type,
      x: r2(box.x),
      y: r2(box.y),
      width: r2(box.w),
      height: r2(box.h),
      angle: 0,
      strokeColor: color(s.strokeColor, '#1E1E1E'),
      backgroundColor: color(s.fillColor),
      fillStyle: 'solid',
      strokeWidth: num(s.strokeWidth, 1),
      strokeStyle: s.dashed === '1' ? 'dashed' : 'solid',
      roughness: s.sketch === '1' ? 1 : 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: hash(id),
      version: 1,
      versionNonce: hash(`${id}#`),
      isDeleted: false,
      boundElements: [],
      updated: 1,
      link: null,
      locked: false,
      customData: { lw: origin },
      ...over,
    };
    elements.push(el);
    return el;
  };

  const LINE = { lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null };

  /** draw.io's corner radius, as the nearest thing Excalidraw has: round or not. */
  const corners = (s: Record<string, string>) => {
    if (s.rounded !== '1') return null;
    const radius = s.absoluteArcSize === '1' ? num(s.arcSize, 20) / 2 : 99;
    return radius >= 5 ? { type: 3 } : null;
  };

  const text = (id: string, value: string, s: Record<string, string>, at: Anchor, over: Record<string, unknown> = {}, more: Pick<PendingText, 'wrap' | 'stack'> = {}): ExcalidrawElement | undefined => {
    if (!value) return undefined;
    const font = fontOf(s.fontFamily);
    // Excalidraw's handwriting sets wider than the one linework draws with.
    const size = Math.round(num(s.fontSize, 14) * (font === FONTS.hand ? 0.88 : 1));
    const el = make(id, 'text', { x: 0, y: 0, w: 0, h: 0 }, {}, {
      strokeColor: color(s.fontColor, '#1E1E1E'),
      backgroundColor: 'transparent',
      strokeWidth: 1,
      strokeStyle: 'solid',
      text: value,
      originalText: value,
      fontSize: size,
      fontFamily: font.id,
      textAlign: 'cx' in at ? 'center' : 'left' in at ? 'left' : 'right',
      verticalAlign: 'middle',
      containerId: null,
      autoResize: true,
      lineHeight: LINE_HEIGHT,
      ...over,
    });
    texts.push({ el, size, font, at, ...more });
    return el;
  };

  /** Text that lives in a shape or on an arrow: Excalidraw keeps it centred there. */
  const bind = (owner: ExcalidrawElement, value: string, s: Record<string, string>, centre: P, over: Record<string, unknown> = {}) => {
    const t = text(`${owner.id}-text`, value, s, { cx: centre.x, cy: centre.y }, { containerId: owner.id, ...over }, owner.type === 'arrow' ? {} : { wrap: owner.width - 12 });
    if (t) owner.boundElements.push({ id: t.id, type: 'text' });
    return t;
  };

  const group = (id: string, ...els: Array<ExcalidrawElement | undefined>) => {
    for (const el of els) el?.groupIds.push(id);
  };

  /** A shape with no line or fill, laid over a drawing made of parts: what arrows attach to and what a person grabs. */
  const cover = (id: string, box: Box) => make(id, 'rectangle', box, {}, { strokeColor: 'transparent', backgroundColor: 'transparent' });

  const centreOf = (g: InspectCell): P => (g.textBox ? { x: g.textBox.x + g.textBox.w / 2, y: g.textBox.y + g.textBox.h / 2 } : { x: g.box.x + g.box.w / 2, y: g.box.y + g.box.h / 2 });

  // ---------- vertices ----------

  const vertex = (c: Cell, g: InspectCell) => {
    const s = c.style;
    const id = `lw-${c.id}`;
    const box = g.box;
    const lines = labelLines(c.label);
    const whole = lines.join('\n');
    const kind = c.attrs.aiviz_type;
    const parent = c.parent ? m.byId.get(c.parent) : undefined;

    if (kind === 'bar') return; // drawn after the lifelines, below

    if (kind === 'icon' || /^mxgraph\./.test(s.shape ?? '')) {
      const el = make(id, 'image', box, {}, { strokeColor: 'transparent', backgroundColor: 'transparent', fileId: null, status: 'saved', scale: [1, 1], crop: null });
      icons.push({ cell: c.id, el });
      // An icon belongs to the node it sits in.
      const owner = c.id.endsWith('__icon') ? c.id.slice(0, -'__icon'.length) : undefined;
      if (owner && m.byId.has(owner)) group(`lw-${owner}-group`, el);
      return;
    }

    if (s.text === '1') {
      if (parent?.style.shape === 'swimlane') {
        // An ER field row: name on the left, type and keys on the right.
        const cellsOf = [...c.label.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => labelLines(x[1]!).join(' '));
        const [name, right] = cellsOf.length ? cellsOf : [lines.join(' '), ''];
        const cy = box.y + box.h / 2;
        const tableGroup = `lw-${parent.id}-group`;
        group(tableGroup, text(`${id}-name`, name ?? '', s, { left: box.x + 14, cy }));
        const muted = /color:\s*(#[0-9a-fA-F]{6})/.exec(c.label)?.[1];
        group(tableGroup, text(`${id}-type`, right ?? '', { ...s, ...(muted ? { fontColor: muted } : {}) }, { right: box.x + box.w - 14, cy }));
        return;
      }
      const tb = g.textBox ?? box;
      text(id, whole, s, { left: tb.x, cy: tb.y + tb.h / 2 });
      return;
    }

    if (kind === 'group' || (g.container && s.shape !== 'umlLifeline' && s.shape !== 'swimlane')) {
      const el = make(id, 'rectangle', box, s, { roundness: corners(s) });
      const tb = g.textBox;
      const title = text(`${id}-title`, lines.join(' '), s, tb ? { left: tb.x, cy: tb.y + tb.h / 2 } : { left: box.x + 14, cy: box.y + 18 });
      group(`${id}-group`, el, title);
      return;
    }

    if (s.shape === 'umlLifeline') {
      const headH = num(s.size, 48);
      const head = make(id, 'rectangle', { ...box, h: headH }, s, { strokeStyle: 'solid', roundness: corners(s) });
      heads.push(head);
      const tech = techLine(c);
      const centre = { x: box.x + box.w / 2, y: box.y + headH / 2 };
      if (tech) {
        const key = `${id}-stack`;
        group(`${id}-group`, text(`${id}-label`, drawnText(c).label, s, { cx: centre.x, cy: centre.y }, {}, { wrap: box.w - 16, stack: key }), text(`${id}-tech`, tech.text, tech.style, { cx: centre.x, cy: centre.y }, {}, { wrap: box.w - 16, stack: key }));
      } else bind(head, whole, s, centre);
      const stem = make(`${id}-line`, 'line', { x: centre.x, y: box.y + headH, w: 0, h: box.h - headH }, s, { ...LINE, backgroundColor: 'transparent', strokeStyle: 'dashed', points: [[0, 0], [0, r2(box.h - headH)]] });
      group(`${id}-group`, head, stem);
      return;
    }

    if (s.shape === 'swimlane') {
      // An ER table: a body, a header across the top, and the title in it.
      const head = num(s.startSize, 36);
      const body = make(id, 'rectangle', box, { ...s, fillColor: s.swimlaneFillColor ?? background }, { roundness: corners(s) });
      const top = make(`${id}-head`, 'rectangle', { ...box, h: head }, s, { roundness: corners(s) });
      const title = text(`${id}-title`, lines.join(' '), s, { cx: box.x + box.w / 2, cy: box.y + head / 2 });
      group(`${id}-group`, body, top, title);
      anchors.set(c.id, body);
      return;
    }

    const hasIcon = m.byId.has(`${c.id}__icon`);
    const tech = techLine(c);
    /**
     * The node's text. A name alone is bound to the shape, the way Excalidraw labels
     * a box. A name with a second line, or one beside an icon, is set as separate
     * text where draw.io drew it: bound text is one size and always centred.
     */
    const label = (owner: ExcalidrawElement, parts: Array<ExcalidrawElement | undefined> = []) => {
      anchors.set(c.id, owner);
      if (!tech && !hasIcon) {
        bind(owner, whole, s, centreOf(g));
        if (parts.length) group(`${id}-group`, ...parts, owner);
        return;
      }
      const centre = centreOf(g);
      const at: Anchor = hasIcon && g.textBox ? { left: g.textBox.x, cy: centre.y } : { cx: centre.x, cy: centre.y };
      const room = hasIcon && g.textBox ? box.x + box.w - g.textBox.x - 8 : box.w - 16;
      const key = `${id}-stack`;
      const name = text(`${id}-label`, drawnText(c).label, s, at, {}, { wrap: room, stack: key });
      const second = tech ? text(`${id}-tech`, tech.text, tech.style, at, {}, { wrap: room, stack: key }) : undefined;
      group(`${id}-group`, ...parts, owner, name, second);
    };

    if (s.rhombus === '1') return label(make(id, 'diamond', box, s));

    if (s.ellipse === '1') {
      if (s.shape !== 'endState') return label(make(id, 'ellipse', box, s));
      const inset = Math.max(3, box.w * 0.2);
      const dot = make(`${id}-dot`, 'ellipse', { x: box.x + inset, y: box.y + inset, w: box.w - 2 * inset, h: box.h - 2 * inset }, s);
      const outer = make(id, 'ellipse', box, { ...s, fillColor: 'none' });
      group(`${id}-group`, dot, outer);
      anchors.set(c.id, outer);
      return;
    }

    if (s.shape === 'cylinder3') {
      const lid = num(s.size, 7) * 2;
      const base = make(`${id}-base`, 'ellipse', { x: box.x, y: box.y + box.h - lid, w: box.w, h: lid }, s);
      const body = make(`${id}-body`, 'rectangle', { x: box.x, y: box.y + lid / 2, w: box.w, h: box.h - lid }, { ...s, dashed: '0', strokeColor: 'none' });
      const side = (suffix: string, x: number) => make(`${id}-${suffix}`, 'line', { x, y: box.y + lid / 2, w: 0, h: box.h - lid }, s, { ...LINE, backgroundColor: 'transparent', points: [[0, 0], [0, r2(box.h - lid)]] });
      const sides = color(s.strokeColor) === 'transparent' ? [] : [side('left', box.x), side('right', box.x + box.w)];
      const top = make(`${id}-lid`, 'ellipse', { x: box.x, y: box.y, w: box.w, h: lid }, s);
      // The cover goes on last: Excalidraw draws a shape's label straight after the shape.
      return label(cover(id, box), [base, body, ...sides, top]);
    }

    if (s.shape === 'parallelogram') {
      const lean = num(s.size, 14);
      // A closed line, which Excalidraw fills. Its points count from the first one.
      const poly = make(`${id}-outline`, 'line', { ...box, x: box.x + lean }, s, { ...LINE, points: [[0, 0], [r2(box.w - lean), 0], [r2(box.w - 2 * lean), r2(box.h)], [-lean, r2(box.h)], [0, 0]] });
      return label(cover(id, box), [poly]);
    }

    const isPill = s.rounded === '1' && s.absoluteArcSize !== '1' && num(s.arcSize, 0) >= 50;
    const shadowOf = (draw: (sid: string, bx: Box, st: Record<string, string>) => ExcalidrawElement) => {
      if (s.shadow !== '1') return [];
      // A hard drop shadow (the bold style): the same outline again, behind and offset.
      const ink = s.shadowColor ?? '#111111';
      return [draw(`${id}-shadow`, { ...box, x: box.x + num(s.shadowOffsetX, 3), y: box.y + num(s.shadowOffsetY, 3) }, { ...s, fillColor: ink, strokeColor: ink, dashed: '0' })];
    };

    if (isPill && box.w > box.h) {
      // Round ends: Excalidraw's own corners stop at a quarter of the height.
      const outline = pillOutline(box.w, box.h);
      const [x0, y0] = outline[0]!;
      const draw = (sid: string, bx: Box, st: Record<string, string>) =>
        make(sid, 'line', { ...bx, x: bx.x + x0, y: bx.y + y0 }, st, { ...LINE, points: [...outline, outline[0]!].map(([x, y]) => [r2(x - x0), r2(y - y0)]) });
      const shadow = shadowOf(draw);
      const outlineEl = draw(`${id}-outline`, box, s);
      return label(cover(id, box), [...shadow, outlineEl]);
    }

    const rect = (sid: string, bx: Box, st: Record<string, string>) => make(sid, 'rectangle', bx, st, { roundness: corners(st) });
    const shadow = shadowOf(rect);
    const el = rect(id, box, s);
    if (kind === 'note') {
      bind(el, whole, s, centreOf(g), { textAlign: 'left' });
      return;
    }
    if (kind === 'frame') {
      const tb = g.textBox;
      group(`${id}-group`, el, text(`${id}-title`, whole, s, tb ? { left: tb.x + 2, cy: tb.y + tb.h / 2 } : { left: box.x + 10, cy: box.y + 12 }));
      return;
    }
    label(el, shadow);
  };

  // ---------- edges ----------

  const edge = (c: Cell, g: InspectCell) => {
    const pts = g.points;
    if (!pts || pts.length < 2) return;
    const s = c.style;
    const id = `lw-${c.id}`;
    const value = labelLines(c.label).join('\n');
    const tb = value ? g.textBox : null;
    const centre = tb ? { x: tb.x + tb.w / 2, y: tb.y + tb.h / 2 } : undefined;
    const head = (name: string | undefined, fallback: string | null) => (name === undefined ? fallback : name in HEADS ? HEADS[name]! : 'triangle');
    const endHead = head(s.endArrow, 'triangle'), startHead = head(s.startArrow, null);
    const isArrow = !!(endHead || startHead);

    let route = pts;
    if (endHead === 'triangle' || endHead === 'arrow') {
      const p = headPoint(route, false);
      if (p) route = [...route.slice(0, -1), p, route[route.length - 1]!];
    }
    if (startHead === 'triangle' || startHead === 'arrow') {
      const p = headPoint(route, true);
      if (p) route = [route[0]!, p, ...route.slice(1)];
    }
    // A label on the line is bound to the arrow, which masks the line behind it.
    // One set beside the line (a sequence message) stays where it is, as its own text.
    const onLine = !!centre && isArrow && nearest(pts, centre).d <= 6;
    if (onLine) route = centreRouteOn(route, centre!);

    const attach = (cellId: string | undefined, p: P) => {
      // A field row stands for its table.
      const owner = cellId && !anchors.has(cellId) ? m.byId.get(cellId)?.parent : cellId;
      const target = owner ? anchors.get(owner) : undefined;
      if (!target) return undefined;
      // Only where the arrow really ends at the shape: a sequence message ends on a lifeline's stem, not its head.
      const pad = 8;
      if (p.x < target.x - pad || p.x > target.x + target.width + pad || p.y < target.y - pad || p.y > target.y + target.height + pad) return undefined;
      // Where on the shape, as fractions of its box. Excalidraw reads the side an
      // arrow leaves by from this, and only gets it right for a point just outside.
      // "On the edge" allows a few pixels: draw.io ends an arrow on a cylinder's curved lid, just inside its box.
      const out = (at: number, size: number) => (at <= 4 ? -0.05 : at >= size - 4 ? 1.05 : r2((at / size) * 1000) / 1000);
      return { target, binding: { elementId: target.id, focus: 0, gap: 1, fixedPoint: [out(p.x - target.x, target.width), out(p.y - target.y, target.height)] } };
    };
    const from = isArrow ? attach(c.source, pts[0]!) : undefined;
    const to = isArrow ? attach(c.target, pts[pts.length - 1]!) : undefined;
    // Excalidraw's own right-angle arrows: rounded corners, and a route that
    // follows when a box is moved. They need both ends on a shape.
    const elbowed = isArrow && !!from && !!to && from.target !== to.target && orthogonal(pts);

    const o = route[0]!;
    const xs = route.map((p) => p.x), ys = route.map((p) => p.y);
    const el = make(id, isArrow ? 'arrow' : 'line', { x: o.x, y: o.y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, s, {
      ...LINE,
      backgroundColor: 'transparent',
      points: route.map((p) => [r2(p.x - o.x), r2(p.y - o.y)]),
      startArrowhead: startHead,
      endArrowhead: endHead,
      ...(isArrow ? { elbowed, ...(elbowed ? { fixedSegments: null, startIsSpecial: null, endIsSpecial: null } : {}) } : {}),
    });
    for (const [key, hit] of [['startBinding', from], ['endBinding', to]] as const) {
      if (!hit) continue;
      el[key] = elbowed ? hit.binding : { elementId: hit.binding.elementId, focus: 0, gap: 1 };
      if (!hit.target.boundElements.some((x) => x.id === el.id)) hit.target.boundElements.push({ id: el.id, type: 'arrow' });
    }

    if (!centre) return;
    if (onLine) bind(el, value, s, centre);
    else group(`${id}-group`, el, text(`${id}-text`, value, s, { cx: centre.x, cy: centre.y }));
  };

  for (const c of m.cells) {
    const g = geo.get(c.id);
    if (!g || !c.vertex) continue;
    cell = c.id;
    vertex(c, g);
  }
  // A sequence diagram's activation bars sit on the lifelines' stems, so they come after them.
  for (const c of m.cells) {
    const g = geo.get(c.id);
    if (!g || !c.vertex || c.attrs.aiviz_type !== 'bar') continue;
    cell = c.id;
    make(`lw-${c.id}`, 'rectangle', g.box, c.style);
  }
  // Edges after every shape exists to attach to. They also draw on top, as in draw.io.
  for (const c of m.cells) {
    const g = geo.get(c.id);
    if (!g || !c.edge) continue;
    cell = c.id;
    edge(c, g);
  }

  // ---------- text sizes, icons ----------

  const key = (s: string, t: PendingText) => `${t.size}|${t.font.id}|${s}`;
  const strings = new Map<string, [string, number, number, string]>();
  for (const t of texts) {
    const value = String(t.el.text);
    for (const piece of [...value.split('\n'), ...(t.wrap ? value.split(/\s+/) : []), ' ']) strings.set(key(piece, t), [piece, t.size, 400, t.font.css]);
  }
  const measured = await b.measure([...strings.values()]);
  const widthOf = new Map([...strings.keys()].map((k, i) => [k, measured[i]!]));
  for (const t of texts) {
    const width = (s: string) => widthOf.get(key(s, t)) ?? s.split(' ').reduce((sum, w, i) => sum + (widthOf.get(key(w, t)) ?? 0) + (i ? (widthOf.get(key(' ', t)) ?? 4) : 0), 0);
    const lines = t.wrap ? wrapLines(String(t.el.text), t.wrap, width) : String(t.el.text).split('\n');
    t.el.text = lines.join('\n');
    const w = Math.max(...lines.map(width), 1);
    t.el.width = r2(w);
    t.el.height = r2(lines.length * t.size * LINE_HEIGHT);
    t.el.x = r2('cx' in t.at ? t.at.cx - w / 2 : 'left' in t.at ? t.at.left : t.at.right - w);
    t.el.y = r2(t.at.cy - t.el.height / 2);
  }
  // Stacked text (a name over what it's built with): the pair is centred, not each line.
  const stacks = new Map<string, PendingText[]>();
  for (const t of texts) if (t.stack) stacks.set(t.stack, [...(stacks.get(t.stack) ?? []), t]);
  for (const stack of stacks.values()) {
    const total = stack.reduce((sum, t) => sum + t.el.height, 0);
    let y = stack[0]!.at.cy - total / 2;
    for (const t of stack) {
      t.el.y = r2(y);
      y += t.el.height;
    }
  }

  const files: ExcalidrawFile['files'] = {};
  const svgs = icons.length ? await b.cellSvgs(m.xml, icons.map((i) => i.cell)) : [];
  icons.forEach((icon, i) => {
    const svg = svgs[i];
    if (!svg) {
      elements.splice(elements.indexOf(icon.el), 1);
      return;
    }
    const dataURL = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    // The same icon drawn twice is stored once.
    const fileId = `lw${hash(dataURL).toString(16)}${svg.length.toString(16)}`;
    files[fileId] = { mimeType: 'image/svg+xml', id: fileId, dataURL, created: 1, lastRetrieved: 1 };
    icon.el.fileId = fileId;
  });

  // Parts of one node move together: the shape joins the group its icon or label made.
  for (const el of elements) {
    const own = `${el.id}-group`;
    if (elements.some((o) => o !== el && o.groupIds.includes(own)) && !el.groupIds.includes(own)) el.groupIds.push(own);
  }

  // The spec rides along on a few shapes, so the file can be imported even
  // without the .drawio.svg it came from. Three copies: any one may be deleted.
  try {
    const doc: Origin['doc'] = { v: 1, spec: toYaml(toDiagram(m).diagram), base: fingerprint(m) };
    const carriers = [...anchors.values(), ...heads];
    for (const i of new Set([0, Math.floor(carriers.length / 2), carriers.length - 1])) {
      const el = carriers[i];
      if (el) (el.customData as { lw: Origin }).lw.doc = doc;
    }
  } catch {
    // Not a diagram linework can read as a spec: the copy still opens, it just can't be imported alone.
  }

  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://github.com/itsthecsguy/linework',
    elements,
    appState: { viewBackgroundColor: background, gridSize: null, theme: 'light' },
    files,
  };
}
