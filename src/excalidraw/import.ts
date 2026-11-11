// Reads an Excalidraw file that export.ts wrote and someone then edited, and
// works out what they changed: text, boxes and arrows added or removed, arrows
// moved to other boxes, colours, paths drawn by hand, and where everything sits.
//
// Every exported element names the draw.io cell it came from (customData.lw), and
// keeps its id. So an element with a known id is the original, one that carries
// a cell but has a new id is a copy somebody made, and one with no cell at all
// was drawn in Excalidraw. The result is a changed spec plus the box each node
// should have; api.ts builds the spec and then moves the boxes.
//
// A sequence diagram is read differently. Its spec is its picture: who comes
// first is left to right, what happens first is top to bottom. So the edits are
// made to the draw.io cells (a message moved down, a participant added on the
// right) and the spec is read off the result, the same way `show` reads a
// diagram someone rearranged in draw.io.
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { absBox, labelLines, readDrawio, type Cell, type DrawioModel } from '../drawio/read.js';
import { datesOn, parseFieldRight, parseFieldText, stripMark, toDiagram, type ShowResult } from '../drawio/show.js';
import { parseMember } from '../spec/parse.js';
import type { InspectCell } from '../render/browser.js';
import { DEFAULT_KIND, FRAME_OPS, KINDS, type Card, type ColorName, type Diagram, type Edge, type EdgeStyle, type Field, type FrameOp, type Look, type Node } from '../spec/model.js';
import { drawnText, type ExcalidrawElement, type ExcalidrawFile, type Origin } from './export.js';

export type Box = { x: number; y: number; w: number; h: number };
type P = { x: number; y: number };

export interface Edits {
  /** The base file's XML, with a sequence diagram's cells already edited. */
  xml: string;
  /** The spec after the edits. */
  diagram: Diagram;
  /** Where each node and group sits in the Excalidraw file, by spec id. Empty for a sequence diagram. */
  boxes: Map<string, Box>;
  /** Arrows whose path a person shaped, by spec edge id: every point from one end to the other. */
  routes: Map<string, P[]>;
  /** What changed, one line each, for the person running the import. */
  changes: string[];
  /** Things in the file that were not brought across, and why. */
  notes: string[];
}

/** What an exported file carries about the diagram it was made from, if any of the shapes holding it survive. */
export function embeddedDoc(file: ExcalidrawFile): NonNullable<Origin['doc']> | undefined {
  for (const e of file.elements) {
    const doc = (e.customData as { lw?: Origin } | undefined)?.lw?.doc;
    if (doc?.spec && !e.isDeleted) return doc;
  }
  return undefined;
}

/** The spec an exported file carries. */
export const embeddedSpec = (file: ExcalidrawFile): string | undefined => embeddedDoc(file)?.spec;

/** The draw.io cells the file's own elements say they draw. */
export function cellsNamed(file: ExcalidrawFile): Set<string> {
  const out = new Set<string>();
  for (const e of file.elements) {
    const o = (e.customData as { lw?: Origin } | undefined)?.lw;
    if (o && !o.lib && e.id === (o.part === 'shape' ? `lw-${o.cell}` : `lw-${o.cell}-${o.part}`)) out.add(o.cell);
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const textOf = (t: ExcalidrawElement | undefined) => (t ? norm(String(t.originalText ?? t.text ?? '')) : '');
const SHAPES = new Set(['rectangle', 'diamond', 'ellipse']);

function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return out && /^[a-z_]/.test(out) ? out : out ? `n_${out}` : '';
}

/** C4 draws a node's second line as "[Container: Go]". The spec holds only "Go". */
function techFromDrawn(s: string): string | undefined {
  const m = /^\[(?:[^:\]]*:\s*)?([^\]]*)\]$/.exec(s);
  if (!m) return s || undefined;
  return /:/.test(s) ? m[1]!.trim() || undefined : undefined;
}

// ---------- colours ----------

/** Where each of linework's colour names sits on the colour wheel, in degrees. */
const HUES: Array<[ColorName, number]> = [['red', 0], ['orange', 26], ['amber', 46], ['green', 135], ['teal', 177], ['blue', 214], ['violet', 265], ['pink', 330], ['red', 360]];

/**
 * The linework colour nearest to one picked in Excalidraw. 'none' for no colour
 * at all: transparent, or white, black and the greys next to them.
 */
export function colorName(value: unknown): ColorName | 'none' | undefined {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s || s === 'transparent') return 'none';
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return undefined;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (sat < 0.16 || d < 0.06) return l > 0.86 || l < 0.2 ? 'none' : 'gray';
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [...HUES].sort((p, q) => Math.abs(p[1] - h) - Math.abs(q[1] - h))[0]![0];
}

// ---------- geometry ----------

const absPoints = (el: ExcalidrawElement): P[] => ((el.points as number[][] | undefined) ?? []).map(([x, y]) => ({ x: el.x + (x ?? 0), y: el.y + (y ?? 0) }));

/** A path without its repeated points and the ones that lie on a straight run. */
export function tidyPath(pts: P[]): P[] {
  const out: P[] = [];
  for (const p of pts) if (!out.length || Math.hypot(p.x - out[out.length - 1]!.x, p.y - out[out.length - 1]!.y) > 0.75) out.push(p);
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]!, b = out[i]!, c = out[i + 1]!;
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (cross / Math.max(1, Math.hypot(c.x - a.x, c.y - a.y)) < 0.75) out.splice(i, 1);
  }
  return out;
}

// ---------- the reader ----------

export function readEdits(file: ExcalidrawFile, base: DrawioModel, cells: InspectCell[], pristine?: ExcalidrawFile): Edits {
  if (file?.type !== 'excalidraw' || !Array.isArray(file.elements)) throw new Error('not an Excalidraw file: expected {"type": "excalidraw", "elements": [...]}');
  const live = file.elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const originOf = (e: ExcalidrawElement) => (e.customData as { lw?: Origin } | undefined)?.lw;
  const ownId = (o: Origin) => (o.part === 'shape' ? `lw-${o.cell}` : `lw-${o.cell}-${o.part}`);
  /** Still the element export wrote, as against a copy of it. */
  const isOriginal = (e: ExcalidrawElement) => {
    const o = originOf(e);
    return !!o && e.id === ownId(o);
  };
  if (!live.some(isOriginal)) throw new Error('this Excalidraw file was not written by linework (or nothing linework drew is left in it), so there is nothing to match it to. Export one with: linework render <file.drawio.svg> -o <file.excalidraw>');

  /** What export wrote, element by element: how a new colour, line style or path is told from the old one. */
  const was = new Map((pristine?.elements ?? []).map((e) => [e.id, e]));
  const shapeOf = (cell: string) => {
    const e = byId.get(`lw-${cell}`);
    return e && isOriginal(e) ? e : undefined;
  };
  const partsOf = (cell: string) => live.filter((e) => originOf(e)?.cell === cell && isOriginal(e));
  const boundText = (owner: ExcalidrawElement) => live.find((t) => t.type === 'text' && t.containerId === owner.id);
  /** A part of the same drawing as `owner`: export's own, or the matching one in a copy. */
  const partOf = (owner: ExcalidrawElement, part: string) => {
    const cell = originOf(owner)?.cell;
    return live.find((t) => {
      const o = originOf(t);
      return o?.cell === cell && o?.part === part && t !== owner && t.groupIds.some((g) => owner.groupIds.includes(g));
    });
  };
  const boxOf = (e: ExcalidrawElement): Box => ({ x: e.x, y: e.y, w: e.width, h: e.height });
  const drawn = new Map(cells.map((c) => [c.id, c]));

  const changes: string[] = [];
  const notes: string[] = [];
  const routes = new Map<string, P[]>();

  /**
   * The colour somebody gave a drawing in Excalidraw, when it is not the one
   * export wrote. `has` is the colour the spec already gives it: a file imported
   * a second time differs from the diagram in every shade, and asks for nothing.
   */
  const recolour = (els: ExcalidrawElement[], has?: string): ColorName | 'none' | undefined => {
    const picked: Array<ColorName | 'none'> = [];
    for (const key of ['backgroundColor', 'strokeColor'] as const) {
      for (const e of els) {
        const p = was.get(e.id);
        if (!p || e.type === 'text' || e.type === 'image') continue;
        const now = String(e[key] ?? '').toLowerCase(), then = String(p[key] ?? '').toLowerCase();
        const name = now !== then ? colorName(now) : undefined;
        if (name) picked.push(name);
      }
    }
    if (has && picked.includes(has as ColorName)) return undefined;
    return picked.find((c) => c !== 'none') ?? picked[0];
  };
  /** Set or clear `target.color`; true when that changed it. */
  const paint = (target: Look, name: ColorName | 'none' | undefined, what: string): boolean => {
    if (name === undefined) return false;
    if (name === 'none') {
      if (!target.color) return false;
      delete target.color;
      changes.push(`${what} is back to its own color`);
      return true;
    }
    if (target.color === name) return false;
    target.color = name;
    changes.push(`${what} is now ${name}`);
    return true;
  };

  const type = base.meta.aiviz_type ?? toDiagram(base).diagram.type;
  if (type === 'sequence') return sequenceEdits();

  const shown: ShowResult = toDiagram(base);
  const m = base;
  const d = shown.diagram;
  const groupIds = new Set(d.groups.map((g) => g.id));
  const cellOf = new Map([...shown.idMap].map(([cell, spec]) => [spec, cell]));

  // ---------- nodes and groups export wrote ----------

  const boxes = new Map<string, Box>();
  const removed = new Set<string>();
  /** Excalidraw element id to the node it stands for. */
  const nodeOfElement = new Map<string, string>();

  for (const [cellId, specId] of shown.idMap) {
    const c = m.byId.get(cellId)!;
    const el = shapeOf(cellId);
    if (!el) {
      removed.add(specId);
      continue;
    }
    for (const part of partsOf(cellId)) nodeOfElement.set(part.id, specId);
    boxes.set(specId, boxOf(el));

    if (groupIds.has(specId)) {
      const g = d.groups.find((x) => x.id === specId)!;
      const now = textOf(partOf(el, 'title'));
      if (now && now !== norm(labelLines(c.label).join(' '))) {
        changes.push(`renamed group "${g.label}" to "${now}"`);
        g.label = now;
      }
      paint(g, recolour(partsOf(cellId), g.color), `group "${g.label}"`);
      continue;
    }
    const n = d.nodes.find((x) => x.id === specId)!;
    const text = drawnText(c);
    // The node's name is separate text when export set it beside an icon or over a second line; otherwise it is the shape's own.
    const labelEl = partOf(el, 'label') ?? partOf(el, 'title') ?? boundText(el);
    const now = type === 'class' ? stripMark(textOf(labelEl)) : textOf(labelEl);
    if (now && now !== (type === 'class' ? stripMark(norm(text.label)) : norm(text.label))) {
      changes.push(`renamed "${n.label}" to "${now}"`);
      n.label = now;
    }
    if (text.tech) {
      const techNow = textOf(partOf(el, 'tech'));
      if (techNow !== norm(text.tech)) {
        const next = techFromDrawn(techNow);
        changes.push(next ? `${specId}: "${n.tech ?? ''}" is now "${next}"` : `${specId}: removed "${n.tech ?? text.tech}"`);
        if (next) n.tech = next;
        else delete n.tech;
      }
    }
    paint(n, recolour(partsOf(cellId).filter((p) => originOf(p)?.part !== 'shadow'), n.color), `"${n.label}"`);
  }

  // ---------- boxes drawn or copied in Excalidraw ----------

  const used = new Set([...d.nodes.map((n) => n.id), ...d.groups.map((g) => g.id)]);
  const claim = (want: string) => {
    let id = want || 'node', k = 2;
    while (used.has(id)) id = `${want || 'node'}_${k++}`;
    used.add(id);
    return id;
  };
  const added: Node[] = [];
  /** Nodes whose box in this file is one somebody drew, imported before. */
  const redrawn = new Set<string>();
  let unlabelled = 0;
  for (const e of live) {
    if (!SHAPES.has(e.type) || isOriginal(e)) continue;
    const o = originOf(e);
    if (o && o.part !== 'shape') continue; // a copied part of a drawing; its shape speaks for it
    const kinds = KINDS[type as keyof typeof KINDS];
    // A copy of a node in this diagram, or a node dragged in from a linework library.
    const source: Pick<Node, 'kind' | 'icon' | 'color'> | undefined = o?.lib
      ? { kind: kinds[o.lib.kind] ? o.lib.kind : DEFAULT_KIND[type as keyof typeof DEFAULT_KIND], ...(o.lib.icon && type === 'architecture' ? { icon: o.lib.icon } : {}) }
      : o ? d.nodes.find((n) => n.id === shown.idMap.get(o.cell)) : undefined;
    if (o && !source) continue; // a copied group: not something a spec can clone
    const label = textOf(partOf(e, 'label') ?? partOf(e, 'title') ?? boundText(e));
    // Only a start or end dot goes without a name.
    if (!label && !(source && ['start', 'end'].includes(source.kind))) {
      if (!o) unlabelled++;
      continue;
    }
    // A box this file added on an earlier import is that node, not one more like it.
    const again = [...removed].find((id) => norm(d.nodes.find((n) => n.id === id)?.label ?? '\0') === label);
    if (again) {
      removed.delete(again);
      nodeOfElement.set(e.id, again);
      for (const part of live) if (part !== e && part.groupIds.some((g) => e.groupIds.includes(g)) && originOf(part)?.cell === o?.cell) nodeOfElement.set(part.id, again);
      boxes.set(again, boxOf(e));
      redrawn.add(again);
      continue;
    }
    const kind = source?.kind ?? (e.type === 'diamond' && kinds.decision ? 'decision' : e.type === 'diamond' && kinds.milestone ? 'milestone' : DEFAULT_KIND[type as keyof typeof DEFAULT_KIND]);
    const node: Node = { id: claim(slug(label) || (label ? '' : kind)), label, kind, ...(source?.icon ? { icon: source.icon } : {}), ...(source?.color ? { color: source.color } : {}) };
    const tech = source ? techFromDrawn(textOf(partOf(e, 'tech'))) : undefined;
    if (tech) node.tech = tech;
    // A box drawn in one of Excalidraw's colours keeps it, as the nearest of linework's.
    if (!o) {
      const picked = [colorName(e.backgroundColor), colorName(e.strokeColor)].find((c) => c && c !== 'none');
      if (picked && picked !== 'none') node.color = picked;
    }
    added.push(node);
    nodeOfElement.set(e.id, node.id);
    for (const part of live) if (part !== e && part.groupIds.some((g) => e.groupIds.includes(g)) && originOf(part)?.cell === o?.cell) nodeOfElement.set(part.id, node.id);
    boxes.set(node.id, boxOf(e));
    changes.push(type === 'er' || type === 'class' ? `added table "${label}"` : `added "${label || node.id}"`);
  }
  if (unlabelled) notes.push(`${unlabelled} shape${unlabelled === 1 ? '' : 's'} drawn in Excalidraw ${unlabelled === 1 ? 'has' : 'have'} no text, so ${unlabelled === 1 ? 'it was' : 'they were'} left out. Give a box a label to make it part of the diagram.`);

  // ---------- removals ----------

  for (const id of removed) {
    const g = d.groups.find((x) => x.id === id);
    if (g) {
      // A deleted group lets go of what was in it.
      for (const item of [...d.nodes, ...d.groups]) if (item.parent === id) item.parent = g.parent;
      d.groups = d.groups.filter((x) => x.id !== id);
      changes.push(`removed group "${g.label}"`);
    } else {
      const n = d.nodes.find((x) => x.id === id);
      d.nodes = d.nodes.filter((x) => x.id !== id);
      if (n) changes.push(`removed "${n.label || id}"`);
    }
    boxes.delete(id);
  }
  d.nodes.push(...added);
  const nodeIds = new Set(d.nodes.map((n) => n.id));

  const tabular = type === 'er' || type === 'class';
  if (tabular) tableColumns();

  // ---------- which group each node sits in ----------

  const groupBoxes = d.groups.map((g) => ({ id: g.id, box: boxes.get(g.id) })).filter((g): g is { id: string; box: Box } => !!g.box);
  const inside = (p: P, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  if (!tabular) {
    for (const n of d.nodes) {
      const b = boxes.get(n.id);
      if (!b) continue;
      const centre = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const within = (slack: number) => groupBoxes.filter((g) => inside(centre, { ...g.box, h: g.box.h + slack })).sort((p, q) => p.box.w * p.box.h - q.box.w * q.box.h)[0]?.id;
      // A row added under a timeline lane's last one sits just below the lane until it is drawn again.
      const holder = within(0) ?? (type === 'timeline' ? within(34) : undefined);
      if (holder === n.parent) continue;
      const isNew = added.includes(n);
      if (!isNew) changes.push(holder ? `moved "${n.label}" into ${holder}` : `moved "${n.label}" out of ${n.parent}`);
      if (holder) n.parent = holder;
      else delete n.parent;
    }
  }

  // ---------- arrows ----------

  const nodeAt = (p: P): string | undefined => {
    const pad = 10;
    return [...boxes]
      .filter(([id, b]) => nodeIds.has(id) && inside(p, { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }))
      .sort((p1, p2) => p1[1].w * p1[1].h - p2[1].w * p2[1].h)[0]?.[0];
  };
  /** The node an arrow's end is on: the one it is attached to, else the one it visibly touches. */
  const endOf = (arrow: ExcalidrawElement, which: 'start' | 'end'): string | undefined => {
    const bound = arrow[which === 'start' ? 'startBinding' : 'endBinding'] as { elementId?: string } | null | undefined;
    const viaBinding = bound?.elementId ? nodeOfElement.get(bound.elementId) : undefined;
    if (viaBinding && nodeIds.has(viaBinding)) return viaBinding;
    const pts = absPoints(arrow);
    const p = pts[which === 'start' ? 0 : pts.length - 1];
    return p ? nodeAt(p) : undefined;
  };
  const arrowLabel = (arrow: ExcalidrawElement) => textOf(boundText(arrow) ?? partOf(arrow, 'text'));
  const name = (id: string) => d.nodes.find((n) => n.id === id)?.label || id;

  /**
   * Whether a person shaped this arrow's path. Excalidraw's right-angle arrows
   * route themselves, and remember only the segments someone dragged. Any other
   * arrow keeps the points it was given, so one whose bends differ from the
   * ones export wrote (or that was drawn with bends) was shaped by hand.
   */
  const shaped = (el: ExcalidrawElement, then?: ExcalidrawElement): boolean => {
    if (el.elbowed) return Array.isArray(el.fixedSegments) && el.fixedSegments.length > 0;
    const now = tidyPath(absPoints(el)).slice(1, -1);
    if (!then) return now.length > 0;
    const before = tidyPath(absPoints(then)).slice(1, -1);
    return now.length !== before.length || now.some((p, i) => Math.hypot(p.x - before[i]!.x, p.y - before[i]!.y) > 1.5);
  };
  const HEAD_CARD: Record<string, Card> = { crowfoot_one: 'one', crowfoot_many: 'many', crowfoot_one_or_many: 'one_or_many' };
  /** Line style and arrowheads somebody changed, as the spec says them. */
  const restyle = (e: Edge, el: ExcalidrawElement, then: ExcalidrawElement | undefined) => {
    // A class relationship's marks mean something a line style can't say; those stay as the spec has them.
    if (!then || e.rel) return;
    const dashed = (x: ExcalidrawElement) => x.strokeStyle === 'dashed' || x.strokeStyle === 'dotted';
    const headsChanged = (el.startArrowhead ?? null) !== (then.startArrowhead ?? null) || (el.endArrowhead ?? null) !== (then.endArrowhead ?? null);
    if (!headsChanged && dashed(el) === dashed(then)) return;
    const what = `the arrow from "${name(e.from)}" to "${name(e.to)}"`;
    if (e.card) {
      const next = { ...e.card };
      if (dashed(el) !== dashed(then)) next.identifying = !dashed(el);
      if ((el.startArrowhead ?? null) !== (then.startArrowhead ?? null)) next.from = HEAD_CARD[String(el.startArrowhead)] ?? next.from;
      if ((el.endArrowhead ?? null) !== (then.endArrowhead ?? null)) next.to = HEAD_CARD[String(el.endArrowhead)] ?? next.to;
      if (JSON.stringify(next) === JSON.stringify(e.card)) return;
      e.card = next;
      changes.push(`the relationship between "${name(e.from)}" and "${name(e.to)}" is now ${next.from.replace(/_/g, ' ')} to ${next.to.replace(/_/g, ' ')}${next.identifying ? '' : ', dashed'}`);
      return;
    }
    const start = !!el.startArrowhead, end = !!el.endArrowhead;
    const next: EdgeStyle = !start && !end ? 'line' : start && end ? 'bidir' : dashed(el) ? 'async' : 'sync';
    if (start && !end) [e.from, e.to] = [e.to, e.from];
    if (next === e.style && !(start && !end)) return;
    e.style = next;
    changes.push(start && !end ? `${what} now points the other way` : `${what} is now ${next === 'line' ? 'a plain line' : next === 'bidir' ? 'two-way' : next === 'async' ? 'dashed' : 'solid'}`);
  };

  const kept: Edge[] = [];
  const taken = new Set<string>();
  const pathOf = new Map<Edge, P[]>();
  for (const e of d.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue; // went with its node
    const cellId = shown.edgeCells.get(e.id);
    const c = cellId ? m.byId.get(cellId) : undefined;
    if (!cellId || !c) {
      kept.push(e);
      continue;
    }
    // An arrow this file added on an earlier import is that arrow, not one more.
    const el = shapeOf(cellId) ?? live.find((a) => a.type === 'arrow' && !isOriginal(a) && !taken.has(a.id) && endOf(a, 'start') === e.from && endOf(a, 'end') === e.to);
    if (!el) {
      changes.push(`removed the arrow from "${name(e.from)}" to "${name(e.to)}"`);
      continue;
    }
    taken.add(el.id);
    const from = endOf(el, 'start') ?? e.from, to = endOf(el, 'end') ?? e.to;
    if (from !== e.from || to !== e.to) {
      changes.push(`the arrow from "${name(e.from)}" to "${name(e.to)}" now runs from "${name(from)}" to "${name(to)}"`);
      e.from = from;
      e.to = to;
    }
    const before = norm(labelLines(c.label).join(' '));
    const now = arrowLabel(el);
    if (now !== before) {
      changes.push(now ? (before ? `relabelled "${before}" to "${now}"` : `labelled the arrow from "${name(e.from)}" to "${name(e.to)}" "${now}"`) : `removed the label "${before}"`);
      if (now) e.label = now;
      else delete e.label;
    }
    const then = was.get(el.id);
    paint(e, recolour([el], e.color), `the arrow from "${name(e.from)}" to "${name(e.to)}"`);
    restyle(e, el, then);
    if (then && shaped(el, then)) {
      // A path that is already the diagram's (imported before) is not a change.
      const path = tidyPath(absPoints(el)), has = tidyPath(drawn.get(cellId)?.points ?? []);
      if (path.length !== has.length || path.some((p, i) => Math.hypot(p.x - has[i]!.x, p.y - has[i]!.y) > 2.5)) {
        pathOf.set(e, path);
        changes.push(`kept the path drawn for the arrow from "${name(e.from)}" to "${name(e.to)}"`);
      }
    }
    kept.push(e);
  }
  let loose = 0;
  for (const el of live) {
    if (el.type !== 'arrow' || isOriginal(el) || taken.has(el.id)) continue;
    const from = endOf(el, 'start'), to = endOf(el, 'end');
    if (!from || !to) {
      loose++;
      continue;
    }
    const o = originOf(el);
    const sourceCell = o?.cell;
    const source = sourceCell ? d.edges.find((x) => shown.edgeCells.get(x.id) === sourceCell) : undefined;
    const label = arrowLabel(el);
    const picked = source ? undefined : colorName(el.strokeColor);
    const start = !!el.startArrowhead, end = !!el.endArrowhead;
    const edge: Edge = {
      id: '',
      from,
      to,
      style: source?.style ?? (type === 'er' ? 'line' : !start && !end ? 'line' : start && end ? 'bidir' : el.strokeStyle === 'dashed' ? 'async' : 'sync'),
      ...(label ? { label } : {}),
      ...(source?.color ? { color: source.color } : picked && picked !== 'none' ? { color: picked } : {}),
      ...(source?.rel ? { rel: source.rel } : {}),
      ...(type === 'er' ? { card: source?.card ?? { from: 'one', to: 'many', identifying: false } } : {}),
    };
    kept.push(edge);
    if (shaped(el)) pathOf.set(edge, tidyPath(absPoints(el)));
    changes.push(`added an arrow from "${name(from)}" to "${name(to)}"${label ? `: ${label}` : ''}`);
  }
  if (loose) notes.push(`${loose} arrow${loose === 1 ? '' : 's'} drawn in Excalidraw ${loose === 1 ? "doesn't" : "don't"} start and end on a box, so ${loose === 1 ? 'it was' : 'they were'} left out.`);
  // Ids follow the ends: "a->b", then "a->b#2" for a second arrow between the same two.
  const seen = new Map<string, number>();
  for (const e of kept) {
    const key = `${e.from}->${e.to}`;
    const k = (seen.get(key) ?? 0) + 1;
    seen.set(key, k);
    e.id = k === 1 ? key : `${key}#${k}`;
    const path = pathOf.get(e);
    if (path) routes.set(e.id, path);
  }
  d.edges = kept;

  if (type === 'timeline') timelineDates();

  // A moved box is not news line by line; say how many.
  let moved = 0;
  for (const [id, b] of boxes) {
    const before = drawn.get(cellOf.get(id) ?? '')?.box;
    if (before && (Math.abs(before.x - b.x) > 1 || Math.abs(before.y - b.y) > 1 || Math.abs(before.w - b.w) > 1 || Math.abs(before.h - b.h) > 1)) moved++;
  }
  if (moved) changes.push(`moved or resized ${moved} box${moved === 1 ? '' : 'es'}`);

  return { xml: base.xml, diagram: d, boxes, routes, changes, notes };

  // ---------- a timeline's dates ----------

  /**
   * On a timeline, where a bar sits is when it happens. A bar dragged along the
   * axis or stretched has new dates, one drawn in gets the dates under it, and
   * top to bottom is the order. The diagram is then drawn again from those
   * dates, so no box is put anywhere by hand.
   */
  function timelineDates() {
    // The axis may have been dragged along with everything else.
    const axisEl = shapeOf('axis'), axisWas = drawn.get('axis')?.box;
    const dx = axisEl && axisWas ? axisEl.x - axisWas.x : 0;
    const rowsBefore = d.nodes.filter((n) => !added.includes(n)).map((n) => n.id);
    for (const n of [...d.nodes]) {
      const b = boxes.get(n.id), before = drawn.get(cellOf.get(n.id) ?? '')?.box;
      if (!b) continue;
      const single = KINDS.timeline[n.kind]?.shape === 'diamond';
      if (!added.includes(n) && before && Math.abs(b.x - dx - before.x) <= 1.5 && Math.abs(b.w - before.w) <= 1.5) continue;
      const dates = datesOn(base.meta, { x: b.x - dx, w: b.w }, single);
      if (!dates) {
        if (added.includes(n)) d.nodes.splice(d.nodes.indexOf(n), 1);
        continue;
      }
      const same = n.start === dates.start && (single || (n.end ?? n.start) === dates.end);
      n.start = dates.start;
      if (single) delete n.end;
      else n.end = dates.end;
      if (!same && !added.includes(n)) changes.push(single ? `"${n.label}" is now on ${dates.start}` : `"${n.label}" now runs ${dates.start} to ${dates.end}`);
    }
    const yOf = (n: Node) => boxes.get(n.id)?.y ?? 0;
    d.nodes.sort((a, b) => yOf(a) - yOf(b));
    if (d.nodes.filter((n) => rowsBefore.includes(n.id)).map((n) => n.id).join() !== rowsBefore.filter((id) => d.nodes.some((n) => n.id === id)).join()) changes.push('put the rows in a new order');
    boxes.clear();
  }

  // ---------- an ER table's columns ----------

  /**
   * A table's rows are loose text in Excalidraw: a name on the left, its type on
   * the right. Text typed into a table (or just under its last row) is a new
   * column, a deleted name is a dropped one, and the order is top to bottom.
   */
  function tableColumns() {
    const tables = d.nodes.map((n) => ({ n, box: boxes.get(n.id) })).filter((t): t is { n: Node; box: Box } => !!t.box);
    // Text nobody attached to anything, that export did not write: a column somebody typed, or a copied one.
    const loose = live.filter((t) => t.type === 'text' && !t.containerId && !isOriginal(t) && !['title', 'label', 'tech', 'text'].includes(originOf(t)?.part ?? ''));
    const holderOf = (t: ExcalidrawElement) => {
      const c = { x: t.x + t.width / 2, y: t.y + t.height / 2 };
      // A row typed below the last one sits just outside the table until the table grows.
      return tables.filter(({ box }) => c.x >= box.x && c.x <= box.x + box.w && c.y >= box.y && c.y <= box.y + box.h + 44).sort((p, q) => p.box.w * p.box.h - q.box.w * q.box.h)[0]?.n;
    };
    const typed = new Map<Node, ExcalidrawElement[]>();
    for (const t of loose) {
      const n = holderOf(t);
      if (n) typed.set(n, [...(typed.get(n) ?? []), t]);
    }
    for (const { n } of tables) {
      const rows: Array<{ y: number; field: Field; old?: number }> = [];
      const cellId = cellOf.get(n.id);
      if (cellId && !added.includes(n) && !redrawn.has(n.id)) {
        const rowCells = m.cells.filter((r) => r.vertex && r.parent === cellId).sort((a, b) => (a.geom?.y ?? 0) - (b.geom?.y ?? 0));
        (n.fields ?? []).forEach((f, i) => {
          const row = rowCells[i];
          const nameEl = row ? byId.get(`lw-${row.id}-name`) : undefined;
          if (!row || !nameEl || !textOf(nameEl)) {
            changes.push(`removed column "${f.name}" from "${n.label}"`);
            return;
          }
          const field: Field = { ...f, flags: [...f.flags] };
          const nameNow = type === 'class' ? textOf(nameEl).replace(/^([+\-#~])\s+/, '$1') : textOf(nameEl).replace(/\s+/g, '_');
          if (nameNow !== f.name) {
            changes.push(`renamed column "${f.name}" to "${nameNow}" in "${n.label}"`);
            field.name = nameNow;
          }
          const rightThen = textOf(was.get(`lw-${row.id}-type`)) || [f.type, ...f.flags.filter((x) => x !== 'pk' && x !== 'fk'), ...f.flags.filter((x) => x === 'pk' || x === 'fk').map((x) => x.toUpperCase())].filter(Boolean).join(' ');
          const rightNow = textOf(byId.get(`lw-${row.id}-type`));
          if (rightNow !== norm(rightThen)) {
            const right = type === 'class' ? { type: rightNow || undefined, flags: [] } : parseFieldRight(rightNow);
            field.type = right.type;
            field.flags = right.flags;
            changes.push(rightNow ? `"${n.label}".${field.name} is now ${rightNow}` : `"${n.label}".${field.name} has no type now`);
          }
          rows.push({ y: nameEl.y + nameEl.height / 2, field, old: i });
        });
      }
      // Text on one line is one column: a name, then perhaps its type.
      const lines: ExcalidrawElement[][] = [];
      for (const t of [...(typed.get(n) ?? [])].sort((a, b) => a.y - b.y)) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(line[0]!.y + line[0]!.height / 2 - (t.y + t.height / 2)) < 12) line.push(t);
        else lines.push([t]);
      }
      for (const line of lines) {
        // A multi-line text box is several columns.
        const texts = line.length === 1 ? String(line[0]!.originalText ?? line[0]!.text ?? '').split('\n') : [line.sort((a, b) => a.x - b.x).map(textOf).join(' ')];
        texts.forEach((text, k) => {
          const field = type === 'class' ? parseMember(text) : parseFieldText(text);
          if (!field) return;
          rows.push({ y: line[0]!.y + (line.length === 1 ? ((k + 0.5) * line[0]!.height) / texts.length : line[0]!.height / 2), field });
          if (!added.includes(n) && !redrawn.has(n.id)) changes.push(`added column "${field.name}" to "${n.label}"`);
        });
      }
      rows.sort((a, b) => a.y - b.y);
      // A column typed in earlier and imported is, on the next import, a row that is "gone" and text that is "new".
      for (const r of rows) {
        const gone = changes.indexOf(`removed column "${r.field.name}" from "${n.label}"`), came = changes.indexOf(`added column "${r.field.name}" to "${n.label}"`);
        if (r.old == null && gone >= 0 && came >= 0) {
          changes.splice(Math.max(gone, came), 1);
          changes.splice(Math.min(gone, came), 1);
          const before = n.fields?.find((f) => f.name === r.field.name);
          if (before && JSON.stringify(before) !== JSON.stringify(r.field)) changes.push(`"${n.label}".${r.field.name} is now ${[r.field.type, ...r.field.flags].filter(Boolean).join(' ')}`);
        }
      }
      if (redrawn.has(n.id) && JSON.stringify(rows.map((r) => r.field)) !== JSON.stringify(n.fields ?? [])) changes.push(`changed the columns of "${n.label}"`);
      const kept = rows.filter((r) => r.old != null).map((r) => r.old!);
      if (kept.some((v, i) => i && v < kept[i - 1]!)) changes.push(`reordered the columns of "${n.label}"`);
      const names = new Set<string>();
      const fields = rows.map((r) => r.field).filter((f) => {
        if (!names.has(f.name)) return names.add(f.name), true;
        notes.push(`"${n.label}" has two columns called "${f.name}"; kept the first.`);
        return false;
      });
      if (fields.length) n.fields = fields;
      else delete n.fields;
    }
  }

  // ---------- sequence diagrams ----------

  function sequenceEdits(): Edits {
    const x = new Xml(base.xml);
    const lifelines = base.cells.filter((c) => c.vertex && c.style.shape === 'umlLifeline');
    const isLane = new Set(lifelines.map((c) => c.id));
    /** The participant a cell belongs to: itself, or the lifeline its activation bar sits on. */
    const laneOf = (cellId?: string): string | undefined => {
      for (let c = cellId ? base.byId.get(cellId) : undefined; c; c = c.parent ? base.byId.get(c.parent) : undefined) if (isLane.has(c.id)) return c.id;
      return undefined;
    };
    const labelOf = (c: Cell) => norm(labelLines(c.label).join(' '));
    const laneName = new Map(lifelines.map((c) => [c.id, labelLines(c.label)[0] ?? c.id]));
    const first = lifelines[0];
    const top0 = first ? (absBox(base, first.id)?.y ?? 0) : 0;
    const lifeH = first?.geom?.h || 400;
    const headH = Number(first?.style.size) || 48;

    // Everything is read relative to the participants still there, so a drawing dragged as a whole reads the same.
    const heads = lifelines.map((c) => ({ c, el: shapeOf(c.id) })).filter((h): h is { c: Cell; el: ExcalidrawElement } => !!h.el);
    const refTop = heads.length ? Math.min(...heads.map((h) => h.el.y)) : top0;
    const leftmost = [...heads].sort((a, b) => a.el.x - b.el.x)[0];
    const dx = leftmost ? leftmost.el.x - (drawn.get(leftmost.c.id)?.box.x ?? leftmost.el.x) : 0;
    const dy = refTop - top0;
    const far = (a: P, b: P | undefined, tol = 3) => !b || Math.abs(a.x - dx - b.x) > tol || Math.abs(a.y - dy - b.y) > tol;

    const gone = new Set<string>();
    /** Remove a cell, what sits in it and the arrows that end on it. */
    const drop = (id: string) => {
      const todo = [id];
      while (todo.length) {
        const cur = todo.pop()!;
        if (gone.has(cur)) continue;
        gone.add(cur);
        x.remove(cur);
        for (const c of base.cells) if (c.parent === cur || c.source === cur || c.target === cur) todo.push(c.id);
      }
    };
    const relabel = (c: Cell, el: ExcalidrawElement | undefined, what = 'renamed') => {
      const before = labelOf(c), now = textOf(el);
      if (!now || now === before) return;
      x.attr(c.id, 'label', escapeHtml(now));
      changes.push(`${what} "${before}" to "${now}"`);
    };

    // ---------- participants ----------

    const alongTop = (e: ExcalidrawElement) => e.y + e.height / 2 >= refTop - 24 && e.y + e.height / 2 <= refTop + headH + 24;
    const taken = new Set<string>();
    /** A box somebody drew that an earlier import already made part of the diagram. */
    const redrawnBox = (label: string, top: boolean) => {
      const hit = live.find((e) => SHAPES.has(e.type) && !isOriginal(e) && !taken.has(e.id) && alongTop(e) === top && textOf(partOf(e, 'label') ?? boundText(e)) === norm(label));
      if (hit) taken.add(hit.id);
      return hit;
    };
    const lanes: Array<{ id: string; cx: number; w: number }> = [];
    let shifted = 0;
    for (const c of lifelines) {
      const el = shapeOf(c.id) ?? redrawnBox(laneName.get(c.id) ?? '', true);
      if (!el) {
        changes.push(`removed participant "${laneName.get(c.id)}"`);
        drop(c.id);
        continue;
      }
      lanes.push({ id: c.id, cx: el.x + el.width / 2, w: el.width });
      const before = drawn.get(c.id)?.box;
      if (before && Math.abs(el.x - dx - before.x) > 3) {
        x.box(c.id, { x: el.x - dx });
        shifted++;
      }
    }
    const orderThen = lifelines.filter((c) => !gone.has(c.id)).map((c) => c.id).sort((a, b) => (drawn.get(a)?.box.x ?? 0) - (drawn.get(b)?.box.x ?? 0));
    const orderNow = [...lanes].sort((a, b) => a.cx - b.cx).map((l) => l.id);
    if (orderThen.join() !== orderNow.join()) changes.push('put the participants in a new order');
    else if (shifted) changes.push(`moved ${shifted} participant${shifted === 1 ? '' : 's'}`);

    // ---------- boxes drawn or copied: a participant along the top, a note anywhere else ----------

    const used = new Set(base.cells.map((c) => c.id));
    const claim = (want: string) => {
      let id = want || 'participant', k = 2;
      while (used.has(id)) id = `${want || 'participant'}_${k++}`;
      used.add(id);
      return id;
    };
    let unlabelled = 0, extra = 0;
    const addedCells = new Set<string>();
    const redrawnNotes = new Set<string>();
    for (const c of base.cells) {
      if (!c.vertex || c.attrs.aiviz_type !== 'note' || shapeOf(c.id)) continue;
      const hit = redrawnBox(labelOf(c), false);
      if (!hit) continue;
      redrawnNotes.add(c.id);
      const before = drawn.get(c.id)?.box;
      if (before && far({ x: hit.x, y: hit.y }, { x: before.x, y: before.y })) x.box(c.id, { x: hit.x - dx, y: hit.y - dy });
    }
    for (const e of live) {
      if (!SHAPES.has(e.type) || isOriginal(e) || taken.has(e.id)) continue;
      const o = originOf(e);
      if (o && o.part !== 'shape') continue;
      const source = o ? base.byId.get(o.cell) : undefined;
      const libKind = o?.lib && KINDS.sequence[o.lib.kind] ? o.lib.kind : undefined;
      const label = textOf(partOf(e, 'label') ?? boundText(e));
      if (!label) {
        if (!o) unlabelled++;
        continue;
      }
      if (alongTop(e) && (!source || isLane.has(source.id))) {
        const id = claim(slug(label));
        const tech = source ? techFromDrawn(textOf(partOf(e, 'tech'))) : undefined;
        const picked = source ? undefined : [colorName(e.backgroundColor), colorName(e.strokeColor)].find((c) => c && c !== 'none');
        x.add('vertex', id, { label: escapeHtml(label) + (tech ? `<br>${escapeHtml(tech)}` : ''), aiviz_kind: source?.attrs.aiviz_kind ?? libKind ?? 'service', aiviz_new: '1', ...(source?.attrs.aiviz_color ? { aiviz_color: source.attrs.aiviz_color } : picked ? { aiviz_color: picked } : {}) }, `shape=umlLifeline;size=${headH};`, { box: { x: e.x - dx, y: top0, w: Math.max(e.width, 80), h: lifeH } });
        lanes.push({ id, cx: e.x + e.width / 2, w: e.width });
        laneName.set(id, label);
        addedCells.add(id);
        changes.push(`added participant "${label}"`);
      } else if (!source || source.attrs.aiviz_type === 'note') {
        x.add('vertex', claim(`note_x${++extra}`), { label: escapeHtml(label), aiviz_type: 'note' }, 'shape=note;', { box: { x: e.x - dx, y: e.y - dy, w: e.width, h: e.height } });
        changes.push(`added a note: "${label}"`);
      }
    }
    if (unlabelled) notes.push(`${unlabelled} shape${unlabelled === 1 ? '' : 's'} drawn in Excalidraw ${unlabelled === 1 ? 'has' : 'have'} no text, so ${unlabelled === 1 ? 'it was' : 'they were'} left out. A labelled box along the top is a participant; one lower down is a note.`);

    /** The participant whose line runs through `px`. */
    const laneAt = (px: number): string | undefined => {
      const hit = [...lanes].sort((a, b) => Math.abs(a.cx - px) - Math.abs(b.cx - px))[0];
      return hit && Math.abs(hit.cx - px) <= Math.max(40, hit.w / 2) ? hit.id : undefined;
    };
    const yFrac = (py: number) => ((py - dy - top0) / lifeH).toFixed(4);
    const ends = (id: string, from: string, to: string, a: P, z: P) => {
      x.cellAttr(id, 'source', from);
      x.cellAttr(id, 'target', to);
      x.style(id, { exitX: '0.5', exitY: yFrac(a.y), entryX: '0.5', entryY: yFrac(z.y), exitDx: '0', exitDy: '0', entryDx: '0', entryDy: '0' });
    };

    // ---------- messages ----------

    const rowThen: Array<[string, number]> = [], rowNow: Array<[string, number]> = [];
    for (const c of base.cells) {
      if (!c.edge || gone.has(c.id)) continue;
      const from0 = laneOf(c.source), to0 = laneOf(c.target);
      if (!from0 || !to0) continue;
      const label = labelOf(c);
      const el = shapeOf(c.id) ?? live.find((a) => {
        if (a.type !== 'arrow' || isOriginal(a) || taken.has(a.id)) return false;
        const pts = absPoints(a);
        return pts.length > 1 && laneAt(pts[0]!.x) === from0 && laneAt(pts[pts.length - 1]!.x) === to0 && textOf(boundText(a) ?? partOf(a, 'text')) === label;
      });
      if (el) taken.add(el.id);
      if (!el) {
        changes.push(label ? `removed the message "${label}"` : `removed a message from "${laneName.get(from0)}" to "${laneName.get(to0)}"`);
        drop(c.id);
        continue;
      }
      relabel(c, boundText(el) ?? partOf(el, 'text'));
      const tint = recolour([el], c.attrs.aiviz_color);
      if (tint !== undefined && (tint === 'none' ? !!c.attrs.aiviz_color : c.attrs.aiviz_color !== tint)) {
        x.attr(c.id, 'aiviz_color', tint === 'none' ? undefined : tint);
        changes.push(tint === 'none' ? `the message "${label}" is back to its own color` : `the message "${label}" is now ${tint}`);
      }
      const pts = absPoints(el), a = pts[0], z = pts[pts.length - 1];
      const before = drawn.get(c.id)?.points;
      if (!a || !z || !before?.length) continue;
      rowThen.push([c.id, before[0]!.y]);
      rowNow.push([c.id, a.y - dy]);
      if (!far(a, before[0]) && !far(z, before[before.length - 1])) continue;
      const from = laneAt(a.x) ?? from0, to = laneAt(z.x) ?? to0;
      ends(c.id, from, to, a, z);
      if (from !== from0 || to !== to0) changes.push(`${label ? `the message "${label}"` : 'a message'} now runs from "${laneName.get(from)}" to "${laneName.get(to)}"`);
    }
    let loose = 0;
    for (const el of live) {
      if (el.type !== 'arrow' || isOriginal(el) || taken.has(el.id)) continue;
      const pts = absPoints(el), a = pts[0], z = pts[pts.length - 1];
      const from = a ? laneAt(a.x) : undefined, to = z ? laneAt(z.x) : undefined;
      if (!a || !z || !from || !to) {
        loose++;
        continue;
      }
      const source = originOf(el) ? base.byId.get(originOf(el)!.cell) : undefined;
      const label = textOf(boundText(el) ?? partOf(el, 'text'));
      const style = source?.attrs.aiviz_msg ?? (el.strokeStyle === 'dashed' || el.strokeStyle === 'dotted' ? 'reply' : 'sync');
      const picked = source ? source.attrs.aiviz_color : colorName(el.strokeColor);
      const id = claim(`m_x${++extra}`);
      x.add('edge', id, { label: escapeHtml(label), aiviz_msg: style, ...(picked && picked !== 'none' ? { aiviz_color: picked } : {}) }, 'html=1;', {});
      ends(id, from, to, a, z);
      changes.push(`added a message from "${laneName.get(from)}" to "${laneName.get(to)}"${label ? `: ${label}` : ''}`);
    }
    if (loose) notes.push(`${loose} arrow${loose === 1 ? '' : 's'} drawn in Excalidraw ${loose === 1 ? "doesn't" : "don't"} run between two participants' lines, so ${loose === 1 ? 'it was' : 'they were'} left out.`);

    // ---------- notes and frames ----------

    for (const c of base.cells) {
      if (!c.vertex || gone.has(c.id)) continue;
      const kind = c.attrs.aiviz_type;
      const el = shapeOf(c.id);
      const before = drawn.get(c.id)?.box;
      const movedTo = el && before && (far({ x: el.x, y: el.y }, { x: before.x, y: before.y }) || Math.abs(el.width - before.w) > 3 || Math.abs(el.height - before.h) > 3) ? el : undefined;
      if (kind === 'note') {
        if (!el && redrawnNotes.has(c.id)) continue;
        if (!el) {
          changes.push(`removed the note "${labelOf(c)}"`);
          drop(c.id);
          continue;
        }
        relabel(c, boundText(el) ?? partOf(el, 'text'), 'changed the note');
        rowThen.push([c.id, before?.y ?? 0]);
        rowNow.push([c.id, el.y - dy]);
        if (movedTo) {
          x.box(c.id, { x: el.x - dx, y: el.y - dy, w: el.width });
          // Which participants it is over is read from where it now sits.
          if (Math.abs(el.x - dx - before!.x) > 3 || Math.abs(el.width - before!.w) > 3) {
            x.attr(c.id, 'aiviz_over', undefined);
            x.attr(c.id, 'aiviz_note', undefined);
          }
        }
      } else if (kind === 'frame') {
        const op = c.attrs.aiviz_frame ?? labelOf(c);
        if (!el) {
          changes.push(`removed the ${op} frame`);
          for (const o of base.cells) if (o.attrs.aiviz_guard?.startsWith(`${c.id}:`) || o.attrs.aiviz_sep?.startsWith(`${c.id}:`)) drop(o.id);
          drop(c.id);
          continue;
        }
        const opNow = textOf(partOf(el, 'title')).toLowerCase() as FrameOp;
        if (opNow && opNow !== op && FRAME_OPS.includes(opNow)) {
          x.attr(c.id, 'aiviz_frame', opNow);
          x.attr(c.id, 'label', opNow);
          changes.push(`the ${op} frame is now ${opNow}`);
        }
        if (movedTo) x.box(c.id, { x: el.x - dx, y: el.y - dy, w: el.width, h: el.height });
      } else if (kind === 'guard') {
        if (!el) {
          changes.push(`removed the condition "${labelOf(c)}"`);
          drop(c.id);
          continue;
        }
        const now = textOf(el);
        if (now && now !== labelOf(c)) {
          const text = /^\[.*\]$/.test(now) ? now : `[${now}]`;
          x.attr(c.id, 'label', escapeHtml(text));
          changes.push(`changed the condition "${labelOf(c)}" to "${text}"`);
        }
        if (movedTo) x.box(c.id, { x: el.x - dx, y: el.y - dy });
      }
    }
    // A branch divider somebody deleted joins the branches on either side of it.
    for (const c of base.cells) {
      if (!c.edge || gone.has(c.id) || c.attrs.aiviz_type !== 'sep' || shapeOf(c.id)) continue;
      const [frame, k] = (c.attrs.aiviz_sep ?? '').split(':');
      changes.push(`joined two branches of the ${base.byId.get(frame ?? '')?.attrs.aiviz_frame ?? ''} frame`.replace('  ', ' '));
      for (const o of base.cells) if (o.attrs.aiviz_guard === `${frame}:${k}`) drop(o.id);
      drop(c.id);
    }

    const order = (rows: Array<[string, number]>) => rows.filter(([id]) => !gone.has(id)).sort((p, q) => p[1] - q[1]).map(([id]) => id).join();
    if (order(rowThen) !== order(rowNow)) changes.push('put the messages in a new order');

    const xml = changes.length ? x.toString() : base.xml;
    const model = changes.length ? readDrawio(xml) : base;
    const shownNow = toDiagram(model);
    const dNow = shownNow.diagram;

    // ---------- what each participant says and looks like ----------

    for (const [cellId, specId] of shownNow.idMap) {
      const c = model.byId.get(cellId)!;
      const el = shapeOf(cellId);
      const n = dNow.nodes.find((p) => p.id === specId);
      if (!el || !n || addedCells.has(cellId)) continue;
      const text = drawnText(c);
      const now = textOf(partOf(el, 'label') ?? boundText(el));
      if (now && now !== norm(text.label)) {
        changes.push(`renamed "${n.label}" to "${now}"`);
        n.label = now;
      }
      if (text.tech) {
        const techNow = textOf(partOf(el, 'tech'));
        if (techNow !== norm(text.tech)) {
          const next = techFromDrawn(techNow);
          changes.push(next ? `${specId}: "${n.tech ?? ''}" is now "${next}"` : `${specId}: removed "${n.tech ?? text.tech}"`);
          if (next) n.tech = next;
          else delete n.tech;
        }
      }
      paint(n, recolour([el], n.color), `"${n.label}"`);
    }
    // Moving a message across a frame's edge changes the spec without changing the order.
    if (!changes.length) {
      const model2 = readDrawio(x.toString());
      const d2 = toDiagram(model2).diagram;
      if (JSON.stringify(d2.seq) !== JSON.stringify(dNow.seq)) return { xml: model2.xml, diagram: d2, boxes: new Map(), routes, changes: ['moved messages or notes to another place'], notes };
    }
    return { xml, diagram: dNow, boxes: new Map(), routes, changes, notes };
  }
}

// ---------- draw.io XML edits ----------

function cellElement(doc: ReturnType<DOMParser['parseFromString']>, id: string): { holder: Element; cell: Element } | undefined {
  for (const tag of ['object', 'UserObject', 'mxCell']) {
    const list = doc.getElementsByTagName(tag);
    for (let i = 0; i < list.length; i++) {
      const el = list[i] as Element;
      if (el.getAttribute('id') !== id) continue;
      const cell = tag === 'mxCell' ? el : (el.getElementsByTagName('mxCell')[0] as Element | undefined);
      if (cell) return { holder: el, cell };
    }
  }
  return undefined;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const round = (n: number) => String(Math.round(n * 100) / 100);

/** A draw.io file open for small edits: one parse, any number of changes, one write. */
export class Xml {
  private doc: ReturnType<DOMParser['parseFromString']>;
  constructor(xml: string) {
    this.doc = new DOMParser().parseFromString(xml, 'text/xml');
  }

  has(id: string): boolean {
    return !!cellElement(this.doc, id);
  }

  remove(id: string) {
    const hit = cellElement(this.doc, id);
    hit?.holder.parentNode?.removeChild(hit.holder);
  }

  /** Set (or with undefined, drop) an attribute of the cell's wrapper: its label or one of linework's own. */
  attr(id: string, name: string, value: string | undefined) {
    const hit = cellElement(this.doc, id);
    if (!hit) return;
    const key = hit.holder.nodeName === 'mxCell' && name === 'label' ? 'value' : name;
    if (value == null) hit.holder.removeAttribute(key);
    else hit.holder.setAttribute(key, value);
  }

  /** Set an attribute of the mxCell itself: parent, source, target. */
  cellAttr(id: string, name: string, value: string) {
    cellElement(this.doc, id)?.cell.setAttribute(name, value);
  }

  /** Change keys of the cell's style, keeping the rest and their order. undefined removes a key. */
  style(id: string, patch: Record<string, string | undefined>) {
    const cell = cellElement(this.doc, id)?.cell;
    if (!cell) return;
    const left = new Map(Object.entries(patch));
    const parts = (cell.getAttribute('style') ?? '').split(';').filter(Boolean).flatMap((part) => {
      const key = part.includes('=') ? part.slice(0, part.indexOf('=')) : part;
      if (!left.has(key)) return [part];
      const v = left.get(key);
      left.delete(key);
      return v == null ? [] : [`${key}=${v}`];
    });
    for (const [k, v] of left) if (v != null) parts.push(`${k}=${v}`);
    cell.setAttribute('style', parts.join(';') + ';');
  }

  /** Set some of a vertex's geometry, in the coordinates of the cell it sits in. */
  box(id: string, to: Partial<Box>) {
    const geom = cellElement(this.doc, id)?.cell.getElementsByTagName('mxGeometry')[0] as Element | undefined;
    if (!geom) return;
    for (const [k, attr] of [['x', 'x'], ['y', 'y'], ['w', 'width'], ['h', 'height']] as const) if (to[k] != null) geom.setAttribute(attr, round(to[k]!));
  }

  /** Give an edge these waypoints, in page coordinates, in place of whatever route it had. */
  waypoints(id: string, pts: P[]) {
    const hit = cellElement(this.doc, id);
    const geom = hit?.cell.getElementsByTagName('mxGeometry')[0] as Element | undefined;
    if (!hit || !geom) return;
    hit.cell.setAttribute('parent', '1');
    const old = geom.getElementsByTagName('Array');
    for (let i = old.length - 1; i >= 0; i--) geom.removeChild(old[i]!);
    if (!pts.length) return;
    const arr = this.doc.createElement('Array');
    arr.setAttribute('as', 'points');
    for (const p of pts) {
      const el = this.doc.createElement('mxPoint');
      el.setAttribute('x', round(p.x));
      el.setAttribute('y', round(p.y));
      arr.appendChild(el);
    }
    geom.insertBefore(arr, geom.firstChild);
  }

  add(kind: 'vertex' | 'edge', id: string, attrs: Record<string, string>, style: string, opts: { box?: Box; parent?: string }) {
    const root = this.doc.getElementsByTagName('root')[0] as Element | undefined;
    if (!root) return;
    const holder = this.doc.createElement('object');
    holder.setAttribute('id', id);
    for (const [k, v] of Object.entries({ label: '', ...attrs })) holder.setAttribute(k, v);
    const cell = this.doc.createElement('mxCell');
    cell.setAttribute('style', style);
    cell.setAttribute(kind, '1');
    cell.setAttribute('parent', opts.parent ?? '1');
    const geom = this.doc.createElement('mxGeometry');
    if (opts.box) {
      geom.setAttribute('x', round(opts.box.x));
      geom.setAttribute('y', round(opts.box.y));
      geom.setAttribute('width', round(opts.box.w));
      geom.setAttribute('height', round(opts.box.h));
    } else geom.setAttribute('relative', '1');
    geom.setAttribute('as', 'geometry');
    cell.appendChild(geom);
    holder.appendChild(cell);
    root.appendChild(holder);
  }

  toString(): string {
    return new XMLSerializer().serializeToString(this.doc);
  }
}

/** Replace the text of the given cells. Labels are HTML, so the text is escaped. */
export function setLabels(xml: string, labels: Map<string, string>): string {
  const x = new Xml(xml);
  for (const [id, label] of labels) x.attr(id, 'label', escapeHtml(label));
  return x.toString();
}

/**
 * Put cells at absolute boxes. draw.io positions a cell relative to the cell it
 * sits in, so each is written relative to where its parent ends up. `now` is
 * where every cell is before the change. A table keeps its size: its rows are
 * laid out to it.
 */
export function setBoxes(xml: string, want: Map<string, Box>, now: Map<string, Box>): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  for (const [id, box] of want) {
    const hit = cellElement(doc, id);
    const geom = hit?.cell.getElementsByTagName('mxGeometry')[0] as Element | undefined;
    if (!hit || !geom) continue;
    const parentId = hit.cell.getAttribute('parent') ?? '';
    const parent = want.get(parentId) ?? now.get(parentId) ?? { x: 0, y: 0, w: 0, h: 0 };
    geom.setAttribute('x', round(box.x - parent.x));
    geom.setAttribute('y', round(box.y - parent.y));
    if (!/shape=swimlane/.test(hit.cell.getAttribute('style') ?? '')) {
      geom.setAttribute('width', round(box.w));
      geom.setAttribute('height', round(box.h));
    }
  }
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Give edges the paths a person drew. `pts` runs from one end to the other in
 * page coordinates; the ends become where the arrow leaves and enters its boxes,
 * and what is between them becomes draw.io waypoints.
 */
export function setRoutes(xml: string, routes: Map<string, { points: P[]; from?: Box; to?: Box }>): string {
  const x = new Xml(xml);
  const at = (p: P, b: Box | undefined, key: 'exit' | 'entry'): Record<string, string | undefined> => {
    if (!b || b.w <= 0 || b.h <= 0) return {};
    const f = (v: number) => String(Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000);
    return { [`${key}X`]: f((p.x - b.x) / b.w), [`${key}Y`]: f((p.y - b.y) / b.h), [`${key}Dx`]: '0', [`${key}Dy`]: '0', [`${key}Perimeter`]: undefined };
  };
  for (const [id, r] of routes) {
    if (r.points.length < 2 || !x.has(id)) continue;
    x.waypoints(id, r.points.slice(1, -1));
    x.style(id, { ...at(r.points[0]!, r.from, 'exit'), ...at(r.points[r.points.length - 1]!, r.to, 'entry') });
  }
  return x.toString();
}
