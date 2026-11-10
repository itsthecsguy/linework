// Scene -> draw.io mxfile XML. A scene is the list of cells to write with their final
// geometry, styles and attributes. It comes from a fresh layout (sceneFromLayout) or
// from merging a spec into an existing file (merge.ts). Every cell carries aiviz_*
// attributes so `show` can turn a (possibly hand-edited) file back into a spec.
import type { Diagram } from '../spec/model.js';
import { kindDef } from '../spec/model.js';
import type { Box, Layout, Point } from '../layout/layout.js';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { ICON_PAD, ICON_SIZE, resolveIcon } from './icons.js';
import { CYL_SIZE, ER_HEAD, ER_ROW, edgeStyle, erEdgeStyle, fieldLabel, fieldStyle, groupLabel, groupStyle, nodeLabel, nodeStyle, paintFor, palette, textMiddle, typeface } from './theme.js';
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
  /** Shift of the label from its spot on the line, for labels that sit beside it. */
  labelOffset?: Point;
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
    ...(d.accent ? { aiviz_accent: d.accent } : {}),
    ...(d.title ? { aiviz_title: d.title } : {}),
    ...extra,
  };
}

export function nodeAttrs(d: Diagram, n: Diagram['nodes'][number]): Record<string, string> {
  const shape = kindDef(d.type, n.kind).shape;
  const label =
    shape === 'start' || shape === 'end' ? '' : shape === 'table' ? n.label : nodeLabel(n.label, n.tech, { theme: d, type: d.type, kind: n.kind, color: n.color, highlight: n.highlight });
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
      label: fieldLabel(f.name, f.type, f.flags, d),
      aiviz_field: f.name,
      ...(f.type ? { aiviz_ftype: f.type } : {}),
      ...(f.flags.length ? { aiviz_flags: f.flags.join(' ') } : {}),
    },
    style: fieldStyle(d),
    box: { x: 0, y: ER_HEAD + i * ER_ROW, w: width, h: ER_ROW },
  }));
}

/** Children a node carries: ER field rows, or a cloud icon. */
export function nodeChildren(d: Diagram, n: Diagram['nodes'][number], box: Box): SceneVertex[] {
  const out = fieldRows(d, n, box.w);
  if (n.icon) {
    const paint = paintFor(d.type, n.kind, d, n);
    const fill = /^#[0-9a-f]{6}$/i.test(paint.fill) ? paint.fill : palette(d).canvas;
    const r = resolveIcon(n.icon, { fill, ink: paint.text });
    if (!('error' in r))
      out.push({
        id: `${n.id}__icon`,
        parent: n.id,
        attrs: { label: '', aiviz_type: 'icon' },
        style: r.style,
        // Level with the text, which on a cylinder sits below the lid.
        box: { x: (ICON_PAD - ICON_SIZE) / 2 + 2, y: Math.round(textMiddle(styleFor(d, n), box.h) - ICON_SIZE / 2), w: ICON_SIZE, h: ICON_SIZE },
      });
  }
  return out;
}

/** Node style, with room on the left when it has an icon. */
export function styleFor(d: Diagram, n: Diagram['nodes'][number]): string {
  const st = nodeStyle(d.type, n.kind, d, n);
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
  return d.type === 'er' && e.card ? erEdgeStyle(e.card, d, e) : edgeStyle(e.style, d, e, bg);
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

export const groupStyleFor = (d: Diagram, g: Diagram['groups'][number]) => groupStyle(d, g, groupDepth(d, g));

export function groupAttrs(g: Diagram['groups'][number], theme: Diagram['theme'] = 'clean'): Record<string, string> {
  return { label: groupLabel(g.label, theme), aiviz_type: 'group', aiviz_label: g.label, ...lookAttrs(g) };
}

/**
 * Layout sizes a decision's diamond from its text wrapped narrow (see nodeSizes),
 * but draw.io wraps at the diamond's full width, so a long question runs out over
 * the slanted sides. Inset the label to the width layout measured.
 */
function diamondInset(d: Diagram, n: Diagram['nodes'][number], box: Box): string {
  if (kindDef(d.type, n.kind).shape !== 'diamond') return '';
  const text = (box.w - 40) / 1.5;
  const side = Math.max(0, Math.floor((box.w - text - 10) / 2));
  return `spacingLeft=${side};spacingRight=${side};`;
}

/**
 * Where a vertical edge at `x` meets a cylinder's curved top or base, as a
 * fraction of its height. Off centre the curve sits inside the bounding box, and
 * an arrow stopped at the box would float short of it.
 */
function rimY(p: Point, b: Box): number | undefined {
  const top = Math.abs(p.y - b.y) < 0.5, base = Math.abs(p.y - (b.y + b.h)) < 0.5;
  if (!top && !base) return undefined;
  const u = Math.min(1, Math.abs(p.x - (b.x + b.w / 2)) / (b.w / 2));
  const dip = CYL_SIZE * (1 - Math.sqrt(1 - u * u));
  return top ? dip / b.h : (b.h - dip) / b.h;
}

/** Exit/entry constraints so draw.io leaves and enters nodes where ELK did. */
export function portStyle(points: Point[], s: Box, t: Box, cyl: { from?: boolean; to?: boolean } = {}): string {
  const start = points[0]!, end = points[points.length - 1]!;
  const c01 = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));
  const sr = cyl.from ? rimY(start, s) : undefined, tr = cyl.to ? rimY(end, t) : undefined;
  return (
    `exitX=${c01((start.x - s.x) / s.w)};exitY=${c01(sr ?? (start.y - s.y) / s.h)};exitDx=0;exitDy=0;${sr !== undefined ? 'exitPerimeter=0;' : ''}` +
    `entryX=${c01((end.x - t.x) / t.w)};entryY=${c01(tr ?? (end.y - t.y) / t.h)};entryDx=0;entryDy=0;${tr !== undefined ? 'entryPerimeter=0;' : ''}`
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
    const inset = l.titleInset?.get(g.id);
    vertices.push({ id: g.id, parent: g.parent ?? '1', attrs: { ...groupAttrs(g, d.theme), aiviz_auto: autoAttr(box) }, style: groupStyleFor(d, g) + (inset ? `spacingLeft=${inset};` : ''), box });
  }
  for (const n of d.nodes) {
    const box = rel(n.id);
    vertices.push({ id: n.id, parent: n.parent ?? '1', attrs: { ...nodeAttrs(d, n), aiviz_auto: autoAttr(box) }, style: styleFor(d, n) + diamondInset(d, n, box), box });
    vertices.push(...nodeChildren(d, n, box));
  }
  const isCyl = (id: string) => { const n = d.nodes.find((x) => x.id === id); return !!n && kindDef(d.type, n.kind).shape === 'cylinder'; };
  const isDecision = (id: string) => { const n = d.nodes.find((x) => x.id === id); return !!n && kindDef(d.type, n.kind).shape === 'diamond'; };
  // How far an edge shares its first run with a sibling leaving the same point.
  const sharedStem = (id: string, from: string) => {
    const mine = l.edges.get(id)!.points;
    let shared = 0;
    for (const o of d.edges) {
      const pts = o.id !== id && o.from === from && o.to !== from ? l.edges.get(o.id)?.points : undefined;
      if (!pts || pts.length < 2 || mine.length < 2 || Math.hypot(pts[0]!.x - mine[0]!.x, pts[0]!.y - mine[0]!.y) > 1) continue;
      const dir = (p: Point[]) => [Math.sign(Math.round(p[1]!.x - p[0]!.x)), Math.sign(Math.round(p[1]!.y - p[0]!.y))].join();
      if (dir(pts) !== dir(mine)) continue;
      const len = (p: Point[]) => Math.hypot(p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y);
      shared = Math.max(shared, Math.min(len(pts), len(mine)));
    }
    return shared;
  };
  const edges: SceneEdge[] = d.edges.map((e) => {
    const le = l.edges.get(e.id);
    const cyl = { from: isCyl(e.from), to: isCyl(e.to) };
    const base: SceneEdge = { id: edgeCellId(e.id), parent: '1', attrs: edgeAttrs(e), style: edgeStyleFor(d, e, labelBg(d, l, le?.label)), source: e.from, target: e.to };
    if (!le) return base;
    if (e.from === e.to && le.label && e.label && le.points.length === 4) {
      // A self-loop: the label sits beside the loop's outer run, not on it.
      const [, a, b] = le.points as [Point, Point, Point, Point];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return {
        ...base,
        style: base.style + portStyle(le.points, abs(e.from), abs(e.to), cyl),
        points: le.points.slice(1, -1),
        labelX: 0.001,
        labelOffset: { x: le.label.x + le.label.w / 2 - mid.x, y: le.label.y + le.label.h / 2 - mid.y },
      };
    }
    return {
      ...base,
      style: base.style + portStyle(le.points, abs(e.from), abs(e.to), cyl),
      points: le.points.slice(1, -1),
      labelX: le.label && e.label ? ((isDecision(e.from) ? branchSpot(le.points, le.label, l.direction, sharedStem(e.id, e.from)) : undefined) ?? labelSpot(le.points, le.label, l.direction, [...l.nodes].filter(([id]) => id !== e.from && id !== e.to).map(([, b]) => b)) ?? labelFraction(le.points, { x: le.label.x + le.label.w / 2, y: le.label.y + le.label.h / 2 })) : undefined,
    };
  });
  alignLabels(d, l, edges);
  return { name: d.title ?? 'Diagram', background: palette(d).canvas, meta: diagramMeta(d), vertices, edges, raw: [] };
}

/** The point at a draw.io label fraction (-1..1) along a route, and the run it sits on. */
function spotAt(pts: Point[], frac: number): { p: Point; a: Point; b: Point } | undefined {
  const lens = pts.slice(1).map((b, i) => Math.hypot(b.x - pts[i]!.x, b.y - pts[i]!.y));
  let at = ((frac + 1) / 2) * lens.reduce((x, y) => x + y, 0);
  for (let i = 0; i < lens.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, len = lens[i]!;
    if (at <= len + 1e-6 || i === lens.length - 1) {
      const t = len ? Math.min(1, at / len) : 0;
      return { p: { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }, a, b };
    }
    at -= len;
  }
  return undefined;
}

/**
 * Labels on neighbouring parallel runs (two edges dropping side by side) sit at
 * whatever height each run's midpoint gives, often a few px apart. Put them on
 * one line when each can move there and stay on its own run.
 */
function alignLabels(d: Diagram, l: Layout, edges: SceneEdge[]) {
  const h = Math.ceil(typeface(d.theme).size.edge * 1.2) + 4;
  const spots = edges.flatMap((se) => {
    const e = d.edges.find((x) => edgeCellId(x.id) === se.id);
    const le = e && l.edges.get(e.id);
    if (!le || se.labelX === undefined || se.labelOffset || !e!.label) return [];
    const s = spotAt(le.points, se.labelX);
    if (!s) return [];
    const vertical = Math.abs(s.a.x - s.b.x) < 0.5;
    if (!vertical && Math.abs(s.a.y - s.b.y) >= 0.5) return [];
    return [{ se, pts: le.points, ...s, vertical }];
  });
  for (const vertical of [true, false]) {
    const along = (p: Point) => (vertical ? p.y : p.x), across = (p: Point) => (vertical ? p.x : p.y);
    const group = spots.filter((s) => s.vertical === vertical).sort((a, b) => along(a.p) - along(b.p));
    for (let i = 0; i < group.length; ) {
      let j = i + 1;
      while (j < group.length && along(group[j]!.p) - along(group[i]!.p) <= 8) j++;
      const set = group.slice(i, j);
      i = j;
      if (set.length < 2) continue;
      // Side by side on different runs, not one run's labels stacked.
      const xs = set.map((s) => across(s.p));
      if (Math.max(...xs) - Math.min(...xs) < 20) continue;
      const target = Math.round(set.reduce((m, s) => m + along(s.p), 0) / set.length);
      const fits = set.every((s) => {
        const lo = Math.min(along(s.a), along(s.b)) + h / 2 + 4, hi = Math.max(along(s.a), along(s.b)) - h / 2 - 4;
        return target >= lo && target <= hi;
      });
      if (!fits) continue;
      for (const s of set) {
        const c = vertical ? { x: s.p.x, y: target } : { x: target, y: s.p.y };
        s.se.labelX = labelFraction(s.pts, c);
      }
    }
  }
}

const attrString = (attrs: Record<string, string>) =>
  Object.entries(attrs)
    .filter(([k]) => k !== 'id')
    .map(([k, v]) => ` ${k}="${xmlEsc(v)}"`)
    .join('');

export function serialize(scene: Scene): string {
  const parentOf = new Map(scene.vertices.map((v) => [v.id, v.parent]));
  // Every cell after its parent, otherwise in the scene's order, which is spec
  // order: show() reads it back and ELK uses it as a placement hint. Groups go
  // first so nodes can sit in them; a node's own children (icon, table rows)
  // already follow it.
  const groups = scene.vertices.filter((v) => v.attrs.aiviz_type === 'group');
  const rest = scene.vertices.filter((v) => v.attrs.aiviz_type !== 'group');
  const placed = new Set(['1']);
  const vertices: SceneVertex[] = [];
  for (const list of [groups, rest]) {
    let todo = [...list];
    while (todo.length) {
      const left: SceneVertex[] = [];
      for (const v of todo) {
        if (placed.has(v.parent) || !parentOf.has(v.parent)) {
          vertices.push(v);
          placed.add(v.id);
        } else left.push(v);
      }
      // A cycle or a dangling parent: write the rest as they are rather than drop them.
      if (left.length === todo.length) {
        vertices.push(...left);
        break;
      }
      todo = left;
    }
  }
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
        (e.labelOffset ? `<mxPoint x="${r(e.labelOffset.x)}" y="${r(e.labelOffset.y)}" as="offset"/>` : '') +
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
export function labelSpot(pts: Point[], label: { w: number; h: number }, dir?: Layout['direction'], avoid: Box[] = []): number | undefined {
  let total = 0;
  let best: { room: number; at: number; along: boolean; a: Point; b: Point; start: number; len: number } | undefined;
  // Runs along the flow belong to one edge; runs across it are often shared
  // corridors where several edges' labels would stack up. Prefer the former.
  const flowVertical = dir === 'TB' || dir === 'BT';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const vertical = Math.abs(b.x - a.x) < Math.abs(b.y - a.y);
    const room = len - (vertical ? label.h : label.w) - 20;
    const along = dir ? vertical === flowVertical : true;
    const better = !best || (along && !best.along) || (along === best.along && room > best.room);
    if (room >= 0 && better) best = { room, at: total + len / 2, along, a, b, start: total, len };
    total += len;
  }
  if (!best || !total) return undefined;
  // Halfway along a long run can be right beside a box the edge only passes, where
  // the label reads as that box's caption. Slide along the run to the nearest
  // spot past the box, with a little air; stay in the middle when there is none.
  const { a, b, start, len } = best;
  const vertical = Math.abs(b.x - a.x) < Math.abs(b.y - a.y);
  const half = (vertical ? label.h : label.w) / 2 + 10;
  // Beside: level with the box along the run, and within 12px of it across the run.
  const beside = (at: number, air: number) => {
    const t = (at - start) / len, cx = a.x + t * (b.x - a.x), cy = a.y + t * (b.y - a.y);
    const px = vertical ? 12 : air, py = vertical ? air : 12;
    const r = { x: cx - label.w / 2 - px, y: cy - label.h / 2 - py, w: label.w + 2 * px, h: label.h + 2 * py };
    return avoid.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
  };
  // Level by a few px or more: a label that only grazes the box's end is fine where it is.
  if (beside(best.at, -4))
    for (let step = 4; step <= len / 2 - half; step += 4)
      for (const at of [best.at - step, best.at + step]) if (!beside(at, 4)) return (at / total) * 2 - 1;
  return (best.at / total) * 2 - 1;
}

/**
 * A branch label ("yes", "no") belongs to its decision, so it sits where the
 * branch leaves the diamond, not halfway to the next step: on the run out of the
 * diamond's point when that has room, otherwise at the start of the first run
 * along the flow, or of a long arm that forks off a short stem. `stem` is how much of the first run a sibling branch shares;
 * the label starts past it, so it doesn't cover the place where they part.
 */
export function branchSpot(pts: Point[], label: { w: number; h: number }, dir: Layout['direction'], stem = 0): number | undefined {
  const flowVertical = dir === 'TB' || dir === 'BT';
  const lens = pts.slice(1).map((b, i) => Math.hypot(b.x - pts[i]!.x, b.y - pts[i]!.y));
  const total = lens.reduce((x, y) => x + y, 0);
  let before = 0;
  for (let i = 0; i < lens.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!, len = lens[i]!;
    const vertical = Math.abs(b.x - a.x) < Math.abs(b.y - a.y);
    const size = vertical ? label.h : label.w;
    const lead = i === 0 && stem > 0 ? stem + 6 : 10;
    // A long arm across the flow, straight after the stem out of the point, is
    // nearer the diamond than the drop at its far end.
    const arm = i === 1 && len >= 96 && lens[0]! <= 24;
    if ((i === 0 || arm || vertical === flowVertical) && len >= lead + size + 10) return ((before + lead + size / 2) / total) * 2 - 1;
    before += len;
  }
  return undefined;
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
