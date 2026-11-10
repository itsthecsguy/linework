// A built diagram as an Excalidraw scene (.excalidraw). One way: the .drawio.svg
// stays the file linework reads and merges into; this is a copy to open, restyle
// and present in Excalidraw.
//
// Geometry comes from draw.io's own renderer (inspect), so hand edits and routed
// edges carry over exactly. What Excalidraw has no shape for is assembled from
// parts and grouped: a cylinder is two ellipses and a body, a table is boxes and
// text. Icons become embedded SVG images.
import { labelLines, type Cell, type DrawioModel } from '../drawio/read.js';
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

interface PendingText {
  el: ExcalidrawElement;
  size: number;
  font: Font;
  /** Where the text goes once it is measured: its centre, or its left or right edge at a vertical centre. */
  at: { cx: number; cy: number } | { left: number; cy: number } | { right: number; cy: number };
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

export async function toExcalidraw(m: DrawioModel, b: DrawioBrowser): Promise<ExcalidrawFile> {
  const inspected = await b.inspect(m.xml);
  const geo = new Map(inspected.map((c) => [c.id, c]));
  const background = /<mxGraphModel[^>]*\sbackground="(#[0-9a-fA-F]{6})"/.exec(m.xml)?.[1] ?? '#FFFFFF';

  const elements: ExcalidrawElement[] = [];
  const texts: PendingText[] = [];
  /** Cell id to the element arrows attach to. */
  const anchors = new Map<string, ExcalidrawElement>();
  const icons: Array<{ cell: string; el: ExcalidrawElement }> = [];

  const make = (id: string, type: ExcalidrawElement['type'], box: Box, s: Record<string, string>, over: Record<string, unknown> = {}): ExcalidrawElement => {
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
      ...over,
    };
    elements.push(el);
    return el;
  };

  /** draw.io's corner radius, as the nearest thing Excalidraw has: round or not. */
  const corners = (s: Record<string, string>) => {
    if (s.rounded !== '1') return null;
    const radius = s.absoluteArcSize === '1' ? num(s.arcSize, 20) / 2 : 99;
    return radius >= 5 ? { type: 3 } : null;
  };

  const text = (id: string, lines: string[], s: Record<string, string>, at: PendingText['at'], over: Record<string, unknown> = {}): ExcalidrawElement | undefined => {
    if (!lines.length) return undefined;
    const font = fontOf(s.fontFamily);
    // Excalidraw's handwriting sets wider than the one linework draws with.
    const size = Math.round(num(s.fontSize, 14) * (font === FONTS.hand ? 0.88 : 1));
    const value = lines.join('\n');
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
    texts.push({ el, size, font, at });
    return el;
  };

  /** Text that lives in a shape or on an arrow: Excalidraw keeps it centred there. */
  const bind = (owner: ExcalidrawElement, lines: string[], s: Record<string, string>, centre: P, over: Record<string, unknown> = {}) => {
    const t = text(`${owner.id}-text`, lines, s, { cx: centre.x, cy: centre.y }, { containerId: owner.id, ...over });
    if (t) owner.boundElements.push({ id: t.id, type: 'text' });
    return t;
  };

  const group = (id: string, ...els: Array<ExcalidrawElement | undefined>) => {
    for (const el of els) el?.groupIds.push(id);
  };

  const centreOf = (g: InspectCell): P => (g.textBox ? { x: g.textBox.x + g.textBox.w / 2, y: g.textBox.y + g.textBox.h / 2 } : { x: g.box.x + g.box.w / 2, y: g.box.y + g.box.h / 2 });

  // ---------- vertices ----------

  const vertex = (c: Cell, g: InspectCell) => {
    const s = c.style;
    const id = `lw-${c.id}`;
    const box = g.box;
    const lines = labelLines(c.label);
    const kind = c.attrs.aiviz_type;
    const parent = c.parent ? m.byId.get(c.parent) : undefined;

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
        group(tableGroup, text(`${id}-name`, name ? [name] : [], s, { left: box.x + 14, cy }));
        const muted = /color:\s*(#[0-9a-fA-F]{6})/.exec(c.label)?.[1];
        group(tableGroup, text(`${id}-type`, right ? [right] : [], { ...s, ...(muted ? { fontColor: muted } : {}) }, { right: box.x + box.w - 14, cy }));
        return;
      }
      const tb = g.textBox ?? box;
      text(id, lines, s, { left: tb.x, cy: tb.y + tb.h / 2 });
      return;
    }

    if (kind === 'group' || (g.container && s.shape !== 'umlLifeline' && s.shape !== 'swimlane')) {
      const el = make(id, 'rectangle', box, s, { roundness: corners(s) });
      const tb = g.textBox;
      const title = text(`${id}-title`, lines, s, tb ? { left: tb.x, cy: tb.y + tb.h / 2 } : { left: box.x + 14, cy: box.y + 18 });
      group(`${id}-group`, el, title);
      return;
    }

    if (s.shape === 'umlLifeline') {
      const headH = num(s.size, 48);
      const head = make(id, 'rectangle', { ...box, h: headH }, s, { strokeStyle: 'solid', roundness: corners(s) });
      bind(head, lines, s, { x: box.x + box.w / 2, y: box.y + headH / 2 });
      const cx = box.x + box.w / 2;
      const stem = make(`${id}-line`, 'line', { x: cx, y: box.y + headH, w: 0, h: box.h - headH }, s, {
        backgroundColor: 'transparent',
        strokeStyle: 'dashed',
        points: [[0, 0], [0, r2(box.h - headH)]],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
      });
      group(`${id}-group`, head, stem);
      return;
    }

    if (s.shape === 'swimlane') {
      // An ER table: a body, a header across the top, and the title in it.
      const head = num(s.startSize, 36);
      const body = make(id, 'rectangle', box, { ...s, fillColor: s.swimlaneFillColor ?? background }, { roundness: corners(s) });
      const top = make(`${id}-head`, 'rectangle', { ...box, h: head }, s, { roundness: corners(s) });
      const title = text(`${id}-title`, lines, s, { cx: box.x + box.w / 2, cy: box.y + head / 2 });
      group(`${id}-group`, body, top, title);
      anchors.set(c.id, body);
      return;
    }

    const hasIcon = m.byId.has(`${c.id}__icon`);
    const label = (owner: ExcalidrawElement, extra: Array<ExcalidrawElement | undefined> = []) => {
      // Beside an icon the label is set left of centre, which a bound label can't be.
      if (hasIcon && g.textBox) {
        const t = text(`${id}-text`, lines, s, { left: g.textBox.x, cy: g.textBox.y + g.textBox.h / 2 });
        group(`${id}-group`, owner, ...extra, t);
      } else {
        bind(owner, lines, s, centreOf(g));
        if (extra.length) group(`${id}-group`, owner, ...extra);
      }
      anchors.set(c.id, owner);
    };

    if (s.rhombus === '1') return label(make(id, 'diamond', box, s));

    if (s.ellipse === '1') {
      const outer = make(id, 'ellipse', box, s.shape === 'endState' ? { ...s, fillColor: 'none' } : s);
      if (s.shape !== 'endState') return label(outer);
      const inset = Math.max(3, box.w * 0.2);
      const dot = make(`${id}-dot`, 'ellipse', { x: box.x + inset, y: box.y + inset, w: box.w - 2 * inset, h: box.h - 2 * inset }, s);
      group(`${id}-group`, outer, dot);
      anchors.set(c.id, outer);
      return;
    }

    if (s.shape === 'cylinder3') {
      const lid = num(s.size, 7) * 2;
      const plain = { ...s, dashed: '0' };
      const base = make(`${id}-base`, 'ellipse', { x: box.x, y: box.y + box.h - lid, w: box.w, h: lid }, s);
      const body = make(id, 'rectangle', { x: box.x, y: box.y + lid / 2, w: box.w, h: box.h - lid }, { ...plain, strokeColor: 'none' });
      const side = (suffix: string, x: number) =>
        make(`${id}-${suffix}`, 'line', { x, y: box.y + lid / 2, w: 0, h: box.h - lid }, s, {
          backgroundColor: 'transparent',
          points: [[0, 0], [0, r2(box.h - lid)]],
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: null,
        });
      const sides = color(s.strokeColor) === 'transparent' ? [] : [side('left', box.x), side('right', box.x + box.w)];
      const top = make(`${id}-lid`, 'ellipse', { x: box.x, y: box.y, w: box.w, h: lid }, s);
      return label(body, [base, ...sides, top]);
    }

    if (s.shape === 'parallelogram') {
      const lean = num(s.size, 14);
      // A closed line, which Excalidraw fills. Its points count from the first one.
      const poly = make(id, 'line', { ...box, x: box.x + lean }, s, {
        points: [[0, 0], [r2(box.w - lean), 0], [r2(box.w - 2 * lean), r2(box.h)], [-lean, r2(box.h)], [0, 0]],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
      });
      const c0 = centreOf(g);
      group(`${id}-group`, poly, text(`${id}-text`, lines, s, { cx: c0.x, cy: c0.y }));
      return;
    }

    if (kind === 'frame') {
      const el = make(id, 'rectangle', box, s, { roundness: corners(s) });
      const tb = g.textBox;
      group(`${id}-group`, el, text(`${id}-title`, lines, s, tb ? { left: tb.x + 2, cy: tb.y + tb.h / 2 } : { left: box.x + 10, cy: box.y + 12 }));
      return;
    }

    const rect = (over: Record<string, unknown> = {}) => make(id, 'rectangle', box, s, { roundness: corners(s), ...over });
    if (s.shadow === '1') {
      // A hard drop shadow (the bold style): the same box again, behind and offset.
      const off = { x: num(s.shadowOffsetX, 3), y: num(s.shadowOffsetY, 3) };
      const ink = s.shadowColor ?? '#111111';
      const shadow = make(`${id}-shadow`, 'rectangle', { ...box, x: box.x + off.x, y: box.y + off.y }, { ...s, fillColor: ink, strokeColor: ink, dashed: '0' }, { roundness: corners(s) });
      return label(rect(), [shadow]);
    }
    const el = rect();
    if (kind === 'note') {
      bind(el, lines, s, centreOf(g));
      return;
    }
    label(el);
  };

  // ---------- edges ----------

  const edge = (c: Cell, g: InspectCell) => {
    const pts = g.points;
    if (!pts || pts.length < 2) return;
    const s = c.style;
    const id = `lw-${c.id}`;
    const lines = labelLines(c.label);
    const tb = lines.length ? g.textBox : null;
    const centre = tb ? { x: tb.x + tb.w / 2, y: tb.y + tb.h / 2 } : undefined;
    // A label on the line is bound to the arrow, which masks the line behind it.
    // One set beside the line (a sequence message) stays where it is, as its own text.
    const onLine = !!centre && nearest(pts, centre).d <= 6;
    const route = onLine ? centreRouteOn(pts, centre!) : pts;
    const o = route[0]!;
    const xs = route.map((p) => p.x), ys = route.map((p) => p.y);
    const head = (name: string | undefined, fallback: string | null) => (name === undefined ? fallback : name in HEADS ? HEADS[name]! : 'triangle');
    const endHead = head(s.endArrow, 'triangle'), startHead = head(s.startArrow, null);
    const el = make(id, endHead || startHead ? 'arrow' : 'line', { x: o.x, y: o.y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, s, {
      backgroundColor: 'transparent',
      points: route.map((p) => [r2(p.x - o.x), r2(p.y - o.y)]),
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: startHead,
      endArrowhead: endHead,
      ...(endHead || startHead ? { elbowed: false } : {}),
    });

    if (el.type === 'arrow') {
      const attach = (cellId: string | undefined, p: P, key: 'startBinding' | 'endBinding') => {
        // A field row stands for its table.
        const owner = cellId && !anchors.has(cellId) ? m.byId.get(cellId)?.parent : cellId;
        const target = owner ? anchors.get(owner) : undefined;
        if (!target) return;
        // Only where the arrow really ends at the shape: a sequence message ends on a lifeline's stem, not its head.
        const pad = 8;
        if (p.x < target.x - pad || p.x > target.x + target.width + pad || p.y < target.y - pad || p.y > target.y + target.height + pad) return;
        el[key] = { elementId: target.id, focus: 0, gap: 1 };
        if (!target.boundElements.some((x) => x.id === el.id)) target.boundElements.push({ id: el.id, type: 'arrow' });
      };
      attach(c.source, route[0]!, 'startBinding');
      attach(c.target, route[route.length - 1]!, 'endBinding');
    }

    if (!centre) return;
    if (onLine && el.type === 'arrow') bind(el, lines, s, centre);
    else group(`${id}-group`, el, text(`${id}-text`, lines, s, { cx: centre.x, cy: centre.y }));
  };

  for (const c of m.cells) {
    const g = geo.get(c.id);
    if (!g) continue;
    if (c.vertex) vertex(c, g);
  }
  // Edges after every shape exists to attach to. They also draw on top, as in draw.io.
  for (const c of m.cells) {
    const g = geo.get(c.id);
    if (g && c.edge) edge(c, g);
  }

  // ---------- text sizes, icons ----------

  const widths = await b.measure(texts.flatMap((t) => String(t.el.text).split('\n').map((line): [string, number, number, string] => [line, t.size, 400, t.font.css])));
  let k = 0;
  for (const t of texts) {
    const lines = String(t.el.text).split('\n');
    const w = Math.max(...lines.map(() => widths[k++]!), 1);
    const h = lines.length * t.size * LINE_HEIGHT;
    t.el.width = r2(w);
    t.el.height = r2(h);
    t.el.x = r2('cx' in t.at ? t.at.cx - w / 2 : 'left' in t.at ? t.at.left : t.at.right - w);
    t.el.y = r2(t.at.cy - h / 2);
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

  // Parts of one node move together: the icon and label join the shape's group.
  for (const el of elements) {
    const own = `${el.id}-group`;
    if (elements.some((o) => o !== el && o.groupIds.includes(own)) && !el.groupIds.includes(own)) el.groupIds.push(own);
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
