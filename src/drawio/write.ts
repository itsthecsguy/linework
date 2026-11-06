// Scene -> draw.io mxfile XML. A scene is the list of cells to write with their final
// geometry, styles and attributes. It comes from a fresh layout (sceneFromLayout) or
// from merging a spec into an existing file (merge.ts). Every cell carries aiviz_*
// attributes so `show` can turn a (possibly hand-edited) file back into a spec.
import type { Diagram } from '../spec/model.js';
import { kindDef } from '../spec/model.js';
import type { Box, Layout, Point } from '../layout/layout.js';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { ICON_PAD, ICON_SIZE, resolveIcon } from './icons.js';
import { ER_HEAD, ER_ROW, edgeStyle, erEdgeStyle, fieldLabel, fieldStyle, groupLabel, groupStyle, nodeLabel, nodeStyle, paintFor, palette } from './theme.js';
import type { Look } from '../spec/model.js';

export { ER_HEAD, ER_ROW };

export const FORMAT_VERSION = '1';

export interface SceneVertex {
  id: string;
  parent: string; // '1' for top level, else a group id
  attrs: Record<string, string>; // label + aiviz_* + anything a person added via Edit Data
  style: string;
  box: Box; // relative to parent
}

export interface SceneEdge {
  id: string;
  parent: string;
  attrs: Record<string, string>;
  style: string;
  source: string;
  target: string;
  /** Either computed points + label position, or an <mxGeometry> kept verbatim from the old file. */
  points?: Point[];
  labelX?: number;
  geomRaw?: string;
}

export interface Scene {
  name: string;
  background?: string;
  meta: Record<string, string>; // attributes for the root cell (id "0")
  vertices: SceneVertex[];
  edges: SceneEdge[];
  /** Cells carried over verbatim (text notes, dangling edges). */
  raw: string[];
}

export const xmlEsc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '&#10;');

const r = (v: number) => Math.round(v);
export const autoAttr = (b: Box) => `${r(b.x)},${r(b.y)},${r(b.w)},${r(b.h)}`;

export function edgeCellId(edgeId: string) {
  return 'e_' + edgeId.replace('->', '__').replace('#', '_');
}

export function diagramMeta(d: Diagram, extra: Record<string, string> = {}): Record<string, string> {
  return {
    aiviz_version: FORMAT_VERSION,
    aiviz_type: d.type,
    aiviz_direction: d.direction,
    ...(d.theme !== 'clean' ? { aiviz_theme: d.theme } : {}),
    ...(d.title ? { aiviz_title: d.title } : {}),
    ...extra,
  };
}

export function nodeAttrs(d: Diagram, n: Diagram['nodes'][number]): Record<string, string> {
  const shape = kindDef(d.type, n.kind).shape;
  const label =
    shape === 'start' || shape === 'end' ? '' : shape === 'table' ? n.label : nodeLabel(n.label, n.tech, { theme: d.theme, type: d.type, kind: n.kind, color: n.color, highlight: n.highlight });
  return {
    label,
    aiviz_kind: n.kind,
    aiviz_label: n.label,
    ...(n.tech ? { aiviz_tech: n.tech } : {}),
    ...(n.icon ? { aiviz_icon: n.icon } : {}),
    ...lookAttrs(n),
  };
}

/** color/highlight as cell attributes, so `show` gives them back. */
export function lookAttrs(l: Look): Record<string, string> {
  return { ...(l.color ? { aiviz_color: l.color } : {}), ...(l.highlight ? { aiviz_highlight: '1' } : {}) };
}

export function lookOf(attrs: Record<string, string | undefined>): Look {
  const out: Look = {};
  if (attrs.aiviz_color) out.color = attrs.aiviz_color as Look['color'];
  if (attrs.aiviz_highlight === '1') out.highlight = true;
  return out;
}

/** Field rows of an ER entity, as children stacked under its header. */
export function fieldRows(d: Diagram, n: Diagram['nodes'][number], width: number): SceneVertex[] {
  return (n.fields ?? []).map((f, i) => ({
    id: `${n.id}__${f.name}`,
    parent: n.id,
    attrs: {
      label: fieldLabel(f.name, f.type, f.flags, d.theme),
      aiviz_field: f.name,
      ...(f.type ? { aiviz_ftype: f.type } : {}),
      ...(f.flags.length ? { aiviz_flags: f.flags.join(' ') } : {}),
    },
    style: fieldStyle(d.theme),
    box: { x: 0, y: ER_HEAD + i * ER_ROW, w: width, h: ER_ROW },
  }));
}

/** Children a node carries: ER field rows, or a cloud icon. */
export function nodeChildren(d: Diagram, n: Diagram['nodes'][number], box: Box): SceneVertex[] {
  const out = fieldRows(d, n, box.w);
  if (n.icon) {
    const paint = paintFor(d.type, n.kind, d.theme, n);
    const fill = /^#[0-9a-f]{6}$/i.test(paint.fill) ? paint.fill : palette(d.theme).canvas;
    const r = resolveIcon(n.icon, { fill, ink: paint.text });
    if (!('error' in r))
      out.push({
        id: `${n.id}__icon`,
        parent: n.id,
        attrs: { label: '', aiviz_type: 'icon' },
        style: r.style,
        box: { x: (ICON_PAD - ICON_SIZE) / 2 + 2, y: Math.round((box.h - ICON_SIZE) / 2), w: ICON_SIZE, h: ICON_SIZE },
      });
  }
  return out;
}

/** Node style, with room on the left when it has an icon. */
export function styleFor(d: Diagram, n: Diagram['nodes'][number]): string {
  const st = nodeStyle(d.type, n.kind, d.theme, n);
  return n.icon ? `${st}align=left;spacingLeft=${ICON_PAD};` : st;
}

/** An edge label inside a filled group gets the group's fill behind it, not the canvas. */
function labelBg(d: Diagram, l: Layout, label?: Box): string | undefined {
  if (!label) return undefined;
  const cx = label.x + label.w / 2, cy = label.y + label.h / 2;
  let best: { area: number; fill: string } | undefined;
  for (const g of d.groups) {
    const b = l.groups.get(g.id);
    if (!b || cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) continue;
    const fill = /fillColor=([^;]+)/.exec(groupStyleFor(d, g))?.[1];
    if (fill && fill !== 'none' && (!best || b.w * b.h < best.area)) best = { area: b.w * b.h, fill };
  }
  return best?.fill;
}

export function edgeStyleFor(d: Diagram, e: Diagram['edges'][number], bg?: string): string {
  return d.type === 'er' && e.card ? erEdgeStyle(e.card, d.theme, e) : edgeStyle(e.style, d.theme, e, bg);
}

export function edgeAttrs(e: Diagram['edges'][number]): Record<string, string> {
  return { label: e.label ?? '', aiviz_edge: e.id, ...lookAttrs(e) };
}

/** How deep a group sits: 0 at the top, 1 inside another group, and so on. */
export function groupDepth(d: Diagram, g: Diagram['groups'][number]): number {
  let n = 0;
  for (let p = g.parent; p && n < 20; p = d.groups.find((x) => x.id === p)?.parent) n++;
  return n;
}

export const groupStyleFor = (d: Diagram, g: Diagram['groups'][number]) => groupStyle(d.theme, g, groupDepth(d, g));

export function groupAttrs(g: Diagram['groups'][number], theme: Diagram['theme'] = 'clean'): Record<string, string> {
  return { label: groupLabel(g.label, theme), aiviz_type: 'group', aiviz_label: g.label, ...lookAttrs(g) };
}

/** Exit/entry constraints so draw.io leaves and enters nodes where ELK did. */
export function portStyle(points: Point[], s: Box, t: Box): string {
  const start = points[0]!, end = points[points.length - 1]!;
  const c01 = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));
  return (
    `exitX=${c01((start.x - s.x) / s.w)};exitY=${c01((start.y - s.y) / s.h)};exitDx=0;exitDy=0;` +
    `entryX=${c01((end.x - t.x) / t.w)};entryY=${c01((end.y - t.y) / t.h)};entryDx=0;entryDy=0;`
  );
}

export function sceneFromLayout(d: Diagram, l: Layout): Scene {
  const parentOf = new Map<string, string | undefined>();
  for (const g of d.groups) parentOf.set(g.id, g.parent);
  for (const n of d.nodes) parentOf.set(n.id, n.parent);
  const abs = (id: string): Box => l.nodes.get(id) ?? l.groups.get(id)!;
  const rel = (id: string): Box => {
    const a = abs(id), p = parentOf.get(id);
    if (!p) return a;
    const pb = abs(p);
    return { ...a, x: a.x - pb.x, y: a.y - pb.y };
  };
  const vertices: SceneVertex[] = [];
  for (const g of d.groups) {
    const box = rel(g.id);
    vertices.push({ id: g.id, parent: g.parent ?? '1', attrs: { ...groupAttrs(g, d.theme), aiviz_auto: autoAttr(box) }, style: groupStyleFor(d, g), box });
  }
  for (const n of d.nodes) {
    const box = rel(n.id);
    vertices.push({ id: n.id, parent: n.parent ?? '1', attrs: { ...nodeAttrs(d, n), aiviz_auto: autoAttr(box) }, style: styleFor(d, n), box });
    vertices.push(...nodeChildren(d, n, box));
  }
  const edges: SceneEdge[] = d.edges.map((e) => {
    const le = l.edges.get(e.id);
    const base: SceneEdge = { id: edgeCellId(e.id), parent: '1', attrs: edgeAttrs(e), style: edgeStyleFor(d, e, labelBg(d, l, le?.label)), source: e.from, target: e.to };
    if (!le) return base;
    return {
      ...base,
      style: base.style + portStyle(le.points, abs(e.from), abs(e.to)),
      points: le.points.slice(1, -1),
      labelX: le.label && e.label ? (labelSpot(le.points, le.label) ?? labelFraction(le.points, { x: le.label.x + le.label.w / 2, y: le.label.y + le.label.h / 2 })) : undefined,
    };
  });
  return { name: d.title ?? 'Diagram', background: palette(d.theme).canvas, meta: diagramMeta(d), vertices, edges, raw: [] };
}

const attrString = (attrs: Record<string, string>) =>
  Object.entries(attrs)
    .filter(([k]) => k !== 'id')
    .map(([k, v]) => ` ${k}="${xmlEsc(v)}"`)
    .join('');

export function serialize(scene: Scene): string {
  // Parents before children.
  const parentOf = new Map(scene.vertices.map((v) => [v.id, v.parent]));
  const depth = (id: string): number => {
    const p = parentOf.get(id);
    return p && p !== '1' ? 1 + depth(p) : 0;
  };
  // Containers first (outermost first), then everything else in its original order,
  // which show() reads back and ELK uses as a placement hint.
  const isParent = new Set(scene.vertices.map((v) => v.parent));
  const containers = scene.vertices.filter((v) => isParent.has(v.id) || v.attrs.aiviz_type === 'group').sort((a, b) => depth(a.id) - depth(b.id));
  const vertices = [...containers, ...scene.vertices.filter((v) => !containers.includes(v))];
  const cells: string[] = [];
  for (const v of vertices) {
    const b = v.box;
    cells.push(
      `<object id="${xmlEsc(v.id)}"${attrString({ label: '', ...v.attrs })}>` +
        `<mxCell style="${xmlEsc(v.style)}" vertex="1" parent="${xmlEsc(v.parent)}">` +
        `<mxGeometry x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" as="geometry"/></mxCell></object>`,
    );
  }
  cells.push(...scene.raw);
  for (const e of scene.edges) {
    const geom =
      e.geomRaw ??
      `<mxGeometry ${e.labelX ? `x="${e.labelX.toFixed(3)}" ` : ''}relative="1" as="geometry">` +
        (e.points?.length ? `<Array as="points">${e.points.map((p) => `<mxPoint x="${r(p.x)}" y="${r(p.y)}"/>`).join('')}</Array>` : '') +
        `</mxGeometry>`;
    cells.push(
      `<object id="${xmlEsc(e.id)}"${attrString({ label: '', ...e.attrs })}>` +
        `<mxCell style="${xmlEsc(e.style)}" edge="1" parent="${xmlEsc(e.parent)}"` +
        (e.source ? ` source="${xmlEsc(e.source)}"` : '') +
        (e.target ? ` target="${xmlEsc(e.target)}"` : '') +
        `>${geom}</mxCell></object>`,
    );
  }
  return (
    `<mxfile host="aiviz" agent="aiviz"><diagram id="aiviz" name="${xmlEsc(scene.name)}">` +
    `<mxGraphModel grid="1" gridSize="8" guides="1" tooltips="1" connect="1" arrows="1" page="0" background="${scene.background ?? '#FFFFFF'}" math="0" shadow="0">` +
    `<root><object id="0"${attrString({ label: '', ...scene.meta })}><mxCell/></object><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`
  );
}

/** Fresh build: spec + layout -> XML. */
export function toMxfile(d: Diagram, l: Layout): string {
  return serialize(sceneFromLayout(d, l));
}

/**
 * Where a label reads best: centred on the edge's longest straight run, clear of
 * the boxes at either end and of the bends. ELK puts labels right next to the
 * source node, which reads as a caption of that node. Returns draw.io's -1..1
 * fraction, or undefined when no run is long enough.
 */
function labelSpot(pts: Point[], label: { w: number; h: number }): number | undefined {
  let total = 0;
  let best: { room: number; at: number } | undefined;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const vertical = Math.abs(b.x - a.x) < Math.abs(b.y - a.y);
    const room = len - (vertical ? label.h : label.w) - 20;
    if (room >= 0 && (!best || room > best.room)) best = { room, at: total + len / 2 };
    total += len;
  }
  return best && total ? (best.at / total) * 2 - 1 : undefined;
}

// draw.io positions edge labels by fraction along the path, -1..1.
// Project ELK's label centre onto the route and convert.
function labelFraction(pts: Point[], c: Point) {
  let total = 0;
  let best = { d: Infinity, at: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const t = len ? Math.max(0, Math.min(1, ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / (len * len))) : 0;
    const d = Math.hypot(c.x - (a.x + t * (b.x - a.x)), c.y - (a.y + t * (b.y - a.y)));
    if (d < best.d) best = { d, at: total + t * len };
    total += len;
  }
  return total ? (best.at / total) * 2 - 1 : 0;
}

export const routeAttr = (pts: Array<{ x: number; y: number }>) => pts.map((p) => `${r(p.x)},${r(p.y)}`).join(' ');

/**
 * Record each linework edge's route as aiviz_auto, so a later merge can tell a route
 * nobody touched (safe to reroute) from one a person adjusted (keep).
 */
export function stampEdgeRoutes(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const objects = doc.getElementsByTagName('object');
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i]!;
    if (!o.getAttribute('aiviz_edge')) continue;
    const geom = o.getElementsByTagName('mxGeometry')[0];
    const pts: Array<{ x: number; y: number }> = [];
    const arr = geom?.getElementsByTagName('Array')[0];
    if (arr) {
      const ps = arr.getElementsByTagName('mxPoint');
      for (let j = 0; j < ps.length; j++) pts.push({ x: +(ps[j]!.getAttribute('x') ?? 0), y: +(ps[j]!.getAttribute('y') ?? 0) });
    }
    (o as Element).setAttribute('aiviz_auto', routeAttr(pts));
  }
  return new XMLSerializer().serializeToString(doc);
}

function cellById(doc: Document | ReturnType<DOMParser['parseFromString']>, id: string): Element | undefined {
  for (const tag of ['object', 'UserObject', 'mxCell']) {
    const els = doc.getElementsByTagName(tag);
    for (let i = 0; i < els.length; i++) {
      const el = els[i]!;
      if (el.getAttribute('id') !== id) continue;
      if (tag === 'mxCell') return el as Element;
      const inner = el.getElementsByTagName('mxCell')[0];
      if (inner) return inner as Element;
    }
  }
  return undefined;
}

/**
 * Copy the style and geometry of the given edges from a model the browser rerouted
 * back into our own XML. Only those edges change; everything else stays byte-stable.
 */
export function patchEdges(ours: string, routedModel: string, ids: string[]): string {
  const doc = new DOMParser().parseFromString(ours, 'text/xml');
  const routed = new DOMParser().parseFromString(routedModel, 'text/xml');
  for (const id of ids) {
    const src = cellById(routed, id), dst = cellById(doc, id);
    if (!src || !dst) continue;
    dst.setAttribute('style', src.getAttribute('style') ?? '');
    const sg = src.getElementsByTagName('mxGeometry')[0];
    const dg = dst.getElementsByTagName('mxGeometry')[0];
    if (sg && dg) dst.replaceChild(doc.importNode(sg, true), dg);
  }
  return new XMLSerializer().serializeToString(doc);
}
