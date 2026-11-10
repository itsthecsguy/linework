// Reads an Excalidraw file that export.ts wrote and someone then edited, and
// works out what they changed: text, boxes and arrows added or removed, arrows
// moved to other boxes, and where everything now sits.
//
// Every exported element names the draw.io cell it came from (customData.lw), and
// keeps its id. So an element with a known id is the original, one that carries
// a cell but has a new id is a copy somebody made, and one with no cell at all
// was drawn in Excalidraw. The result is a changed spec plus the box each node
// should have; api.ts builds the spec and then moves the boxes.
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { labelLines, readDrawio, type DrawioModel } from '../drawio/read.js';
import { toDiagram, type ShowResult } from '../drawio/show.js';
import type { InspectCell } from '../render/browser.js';
import { DEFAULT_KIND, KINDS, type Diagram, type Edge, type Node } from '../spec/model.js';
import { drawnText, type ExcalidrawElement, type ExcalidrawFile, type Origin } from './export.js';

export type Box = { x: number; y: number; w: number; h: number };

export interface Edits {
  /** The base file's XML, with message and note text already changed. */
  xml: string;
  /** The spec after the edits. */
  diagram: Diagram;
  /** Where each node and group sits in the Excalidraw file, by spec id. Empty for a sequence diagram. */
  boxes: Map<string, Box>;
  /** What changed, one line each, for the person running the import. */
  changes: string[];
  /** Things in the file that were not brought across, and why. */
  notes: string[];
}

/** The spec an exported file carries, if any of the shapes holding it survive. */
export function embeddedSpec(file: ExcalidrawFile): string | undefined {
  for (const e of file.elements) {
    const doc = (e.customData as { lw?: Origin } | undefined)?.lw?.doc;
    if (doc?.spec && !e.isDeleted) return doc.spec;
  }
  return undefined;
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

export function readEdits(file: ExcalidrawFile, base: DrawioModel, cells: InspectCell[]): Edits {
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

  const shapeOf = (cell: string) => {
    const e = byId.get(`lw-${cell}`);
    return e && isOriginal(e) ? e : undefined;
  };
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

  const changes: string[] = [];
  const notes: string[] = [];
  const type = base.meta.aiviz_type ?? toDiagram(base).diagram.type;
  const sequence = type === 'sequence';

  // ---------- sequence messages and notes: their text lives in the draw.io cells ----------

  const relabel = new Map<string, string>();
  if (sequence) {
    for (const c of base.cells) {
      const isNote = c.vertex && c.attrs.aiviz_type === 'note';
      if (!c.edge && !isNote) continue;
      const was = norm(labelLines(c.label).join(' '));
      if (!was) continue;
      const el = shapeOf(c.id);
      if (!el) {
        notes.push(`"${was}" was deleted in Excalidraw. Removing a message or note isn't read back; edit the spec for that.`);
        continue;
      }
      const now = textOf(boundText(el) ?? partOf(el, 'text'));
      if (now && now !== was) {
        relabel.set(c.id, now);
        changes.push(`renamed "${was}" to "${now}"`);
      }
    }
  }
  const xml = relabel.size ? setLabels(base.xml, relabel) : base.xml;
  const m = relabel.size ? readDrawio(xml) : base;
  const shown: ShowResult = toDiagram(m);
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
      if (sequence) notes.push(`${specId} was deleted in Excalidraw. Removing a participant isn't read back; edit the spec for that.`);
      else removed.add(specId);
      continue;
    }
    for (const part of live) if (originOf(part)?.cell === cellId && isOriginal(part)) nodeOfElement.set(part.id, specId);
    if (!sequence) boxes.set(specId, boxOf(el));

    if (groupIds.has(specId)) {
      const g = d.groups.find((x) => x.id === specId)!;
      const now = textOf(partOf(el, 'title'));
      if (now && now !== norm(labelLines(c.label).join(' '))) {
        changes.push(`renamed group "${g.label}" to "${now}"`);
        g.label = now;
      }
      continue;
    }
    const n = d.nodes.find((x) => x.id === specId)!;
    const drawn = drawnText(c);
    // The node's name is separate text when export set it beside an icon or over a second line; otherwise it is the shape's own.
    const labelEl = partOf(el, 'label') ?? partOf(el, 'title') ?? boundText(el);
    const now = textOf(labelEl);
    if (now && now !== norm(drawn.label)) {
      changes.push(`renamed "${n.label}" to "${now}"`);
      n.label = now;
    }
    if (drawn.tech) {
      const techNow = textOf(partOf(el, 'tech'));
      if (techNow !== norm(drawn.tech)) {
        const next = techFromDrawn(techNow);
        changes.push(next ? `${specId}: "${n.tech ?? ''}" is now "${next}"` : `${specId}: removed "${n.tech ?? drawn.tech}"`);
        if (next) n.tech = next;
        else delete n.tech;
      }
    }
  }

  if (sequence) {
    for (const e of live) if (!originOf(e) && (SHAPES.has(e.type) || e.type === 'arrow')) {
      notes.push('Shapes and arrows added in Excalidraw are not read back into a sequence diagram; add the participant or message to the spec.');
      break;
    }
    return { xml, diagram: d, boxes, changes, notes };
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
  let unlabelled = 0;
  for (const e of live) {
    if (!SHAPES.has(e.type) || isOriginal(e)) continue;
    const o = originOf(e);
    if (o && o.part !== 'shape') continue; // a copied part of a drawing; its shape speaks for it
    const source = o ? d.nodes.find((n) => n.id === shown.idMap.get(o.cell)) : undefined;
    if (o && !source) continue; // a copied group or table: not something a spec can clone
    const label = textOf(partOf(e, 'label') ?? boundText(e));
    if (!label) {
      if (!o) unlabelled++;
      continue;
    }
    if (type === 'er') {
      notes.push(`"${label}" was drawn in Excalidraw. A new table needs its columns, so add it to the spec instead.`);
      continue;
    }
    const kinds = KINDS[type as keyof typeof KINDS];
    const kind = source?.kind ?? (e.type === 'diamond' && kinds.decision ? 'decision' : DEFAULT_KIND[type as keyof typeof DEFAULT_KIND]);
    const node: Node = { id: claim(slug(label)), label, kind, ...(source?.icon ? { icon: source.icon } : {}), ...(source?.color ? { color: source.color } : {}) };
    const tech = source ? techFromDrawn(textOf(partOf(e, 'tech'))) : undefined;
    if (tech) node.tech = tech;
    added.push(node);
    nodeOfElement.set(e.id, node.id);
    for (const part of live) if (part !== e && part.groupIds.some((g) => e.groupIds.includes(g)) && originOf(part)?.cell === o?.cell) nodeOfElement.set(part.id, node.id);
    boxes.set(node.id, boxOf(e));
    changes.push(`added "${label}"`);
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

  // ---------- which group each node sits in ----------

  const groupBoxes = d.groups.map((g) => ({ id: g.id, box: boxes.get(g.id) })).filter((g): g is { id: string; box: Box } => !!g.box);
  const inside = (p: { x: number; y: number }, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  if (type !== 'er') {
    for (const n of d.nodes) {
      const b = boxes.get(n.id);
      if (!b) continue;
      const centre = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const holder = groupBoxes.filter((g) => inside(centre, g.box)).sort((p, q) => p.box.w * p.box.h - q.box.w * q.box.h)[0]?.id;
      if (holder === n.parent) continue;
      const isNew = added.includes(n);
      if (!isNew) changes.push(holder ? `moved "${n.label}" into ${holder}` : `moved "${n.label}" out of ${n.parent}`);
      if (holder) n.parent = holder;
      else delete n.parent;
    }
  }

  // ---------- arrows ----------

  const nodeAt = (p: { x: number; y: number }): string | undefined => {
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
    const pts = arrow.points as number[][] | undefined;
    const p = pts?.[which === 'start' ? 0 : pts.length - 1];
    return p ? nodeAt({ x: arrow.x + p[0]!, y: arrow.y + p[1]! }) : undefined;
  };
  const arrowLabel = (arrow: ExcalidrawElement) => textOf(boundText(arrow) ?? partOf(arrow, 'text'));
  const name = (id: string) => d.nodes.find((n) => n.id === id)?.label || id;

  const kept: Edge[] = [];
  for (const e of d.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue; // went with its node
    const cellId = shown.edgeCells.get(e.id);
    const c = cellId ? m.byId.get(cellId) : undefined;
    if (!cellId || !c) {
      kept.push(e);
      continue;
    }
    const el = shapeOf(cellId);
    if (!el) {
      changes.push(`removed the arrow from "${name(e.from)}" to "${name(e.to)}"`);
      continue;
    }
    const from = endOf(el, 'start') ?? e.from, to = endOf(el, 'end') ?? e.to;
    if (from !== e.from || to !== e.to) {
      changes.push(`the arrow from "${name(e.from)}" to "${name(e.to)}" now runs from "${name(from)}" to "${name(to)}"`);
      e.from = from;
      e.to = to;
    }
    const was = norm(labelLines(c.label).join(' '));
    const now = arrowLabel(el);
    if (now !== was) {
      changes.push(now ? (was ? `relabelled "${was}" to "${now}"` : `labelled the arrow from "${name(e.from)}" to "${name(e.to)}" "${now}"`) : `removed the label "${was}"`);
      if (now) e.label = now;
      else delete e.label;
    }
    kept.push(e);
  }
  let loose = 0;
  for (const el of live) {
    if (el.type !== 'arrow' || isOriginal(el)) continue;
    const from = endOf(el, 'start'), to = endOf(el, 'end');
    if (!from || !to) {
      loose++;
      continue;
    }
    const o = originOf(el);
    const sourceCell = o?.cell;
    const source = sourceCell ? d.edges.find((x) => shown.edgeCells.get(x.id) === sourceCell) : undefined;
    const label = arrowLabel(el);
    const edge: Edge = {
      id: '',
      from,
      to,
      style: source?.style ?? (el.strokeStyle === 'dashed' ? 'async' : 'sync'),
      ...(label ? { label } : {}),
      ...(source?.color ? { color: source.color } : {}),
      ...(type === 'er' ? { card: source?.card ?? { from: 'one', to: 'many', identifying: false } } : {}),
    };
    kept.push(edge);
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
  }
  d.edges = kept;

  // A moved box is not news line by line; say how many.
  const before = new Map(cells.map((c) => [c.id, c.box]));
  let moved = 0;
  for (const [id, b] of boxes) {
    const was = before.get(cellOf.get(id) ?? '');
    if (was && (Math.abs(was.x - b.x) > 1 || Math.abs(was.y - b.y) > 1 || Math.abs(was.w - b.w) > 1 || Math.abs(was.h - b.h) > 1)) moved++;
  }
  if (moved) changes.push(`moved or resized ${moved} box${moved === 1 ? '' : 'es'}`);

  return { xml, diagram: d, boxes, changes, notes };
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

/** Replace the text of the given cells. Labels are HTML, so the text is escaped. */
export function setLabels(xml: string, labels: Map<string, string>): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  for (const [id, label] of labels) {
    const hit = cellElement(doc, id);
    if (!hit) continue;
    hit.holder.setAttribute(hit.holder.nodeName === 'mxCell' ? 'value' : 'label', escapeHtml(label));
  }
  return new XMLSerializer().serializeToString(doc);
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
    geom.setAttribute('x', String(Math.round((box.x - parent.x) * 100) / 100));
    geom.setAttribute('y', String(Math.round((box.y - parent.y) * 100) / 100));
    if (!/shape=swimlane/.test(hit.cell.getAttribute('style') ?? '')) {
      geom.setAttribute('width', String(Math.round(box.w * 100) / 100));
      geom.setAttribute('height', String(Math.round(box.h * 100) / 100));
    }
  }
  return new XMLSerializer().serializeToString(doc);
}
