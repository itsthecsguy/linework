// Merge a spec into an existing diagram without throwing away anyone's layout work.
//
// Rules:
// - Every node and group that already exists stays where it is. A node only grows,
//   around its centre, if its new label no longer fits.
// - New nodes go next to a neighbour, at the same offset the fresh ELK layout gives
//   them, then nudge to the nearest free spot.
// - Groups grow to contain their members. They never shrink, so hand-sized groups keep their size.
// - Edges between untouched nodes keep their route, style and label position exactly.
//   New edges, and edges touching nodes that moved or grew, get rerouted with libavoid.
// - Restyles survive unless the node's kind changes. Custom data (Edit Data) survives.
// - Cells the spec can't describe, like text notes and dangling arrows, are carried over as-is.
import type { Diagram, Node } from '../spec/model.js';
import type { Box, Layout } from '../layout/layout.js';
import { absBox, type Cell, type DrawioModel } from './read.js';
import { manualEdits, toDiagram } from './show.js';
import { autoAttr, diagramMeta, edgeAttrs, edgeCellId, edgeStyleFor, nodeChildren, styleFor, groupAttrs, groupStyleFor, nodeAttrs, routeAttr, type Scene, type SceneEdge, type SceneVertex } from './write.js';
import type { Look } from '../spec/model.js';
import { palette } from './theme.js';
import { kindDef } from '../spec/model.js';

export interface MergeStats {
  kept: number;
  handMoved: number;
  placed: string[];
  grown: string[];
  /** Groups that closed up after members left. */
  shrunk: string[];
  removed: string[];
  rerouted: number;
  carried: number;
  /** Hand-added shapes kept because the spec was written before they existed. */
  keptUnknown: string[];
}

export interface MergeResult {
  scene: Scene;
  /** Edge cell ids to route with libavoid after serializing. */
  reroute: string[];
  stats: MergeStats;
}

const GAP = 24;
const PAD = { top: 40, left: 20, right: 20, bottom: 20 };
const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const overlaps = (a: Box, b: Box, m = 0) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
const PORT_KEYS = ['exitX', 'exitY', 'exitDx', 'exitDy', 'exitPerimeter', 'entryX', 'entryY', 'entryDx', 'entryDy', 'entryPerimeter'];

function withoutKeys(style: string, keys: string[]) {
  return style
    .split(';')
    .filter((p) => p && !keys.includes(p.split('=')[0]!))
    .join(';') + ';';
}

function ownAttrs(c: Cell): Record<string, string> {
  // color/highlight come from the spec every time, so dropping one in the spec drops it here.
  const { id: _id, value: _value, aiviz_auto: _auto, aiviz_color: _c, aiviz_highlight: _h, ...rest } = c.attrs;
  return rest;
}

const sameLookOf = (a?: Look, b?: Look) => (a?.color ?? '') === (b?.color ?? '') && !!a?.highlight === !!b?.highlight;

export function merge(d: Diagram, old: DrawioModel, fresh: Layout, opts: { specIsCurrent?: boolean; touched?: boolean } = {}): MergeResult {
  const shown = toDiagram(old);
  const cellOf = new Map<string, Cell>();
  for (const [cellId, specId] of shown.idMap) cellOf.set(specId, old.byId.get(cellId)!);
  const oldNodes = new Map(shown.diagram.nodes.map((n) => [n.id, n]));
  const oldGroups = new Map(shown.diagram.groups.map((g) => [g.id, g]));
  const handEdits = new Map(manualEdits(old).map((e) => [e.id, e.what]));
  // A theme change restyles everything; positions still stay.
  const themeChanged = shown.diagram.theme !== d.theme || (shown.diagram.accent ?? '') !== (d.accent ?? '');
  const isTable = (n: Node) => kindDef(d.type, n.kind).shape === 'table';

  const abs = new Map<string, Box>(); // final absolute boxes for nodes
  const changed = new Set<string>(); // nodes whose box differs from the old file
  const stats: MergeStats = { kept: 0, handMoved: 0, placed: [], grown: [], shrunk: [], removed: [], rerouted: 0, carried: 0, keptUnknown: [] };

  // 1. Existing nodes stay put.
  for (const n of d.nodes) {
    const c = cellOf.get(n.id);
    if (!c || !oldNodes.has(n.id)) continue;
    const b = absBox(old, c.id);
    if (!b) continue;
    const prev = oldNodes.get(n.id)!;
    const f = fresh.natural.get(n.id)!; // its own size, not the diagram-wide width
    let box = b;
    const kindChanged = prev.kind !== n.kind;
    const textChanged = prev.label !== n.label || prev.tech !== n.tech;
    const handSized = handEdits.get(c.id) === 'resized';
    if (isTable(n)) {
      // Tables are as tall as their fields; keep any extra width someone gave them.
      const w = Math.max(b.w, f.w);
      if (Math.abs(f.h - b.h) > 1 || w > b.w + 1) {
        box = { x: b.x, y: b.y, w, h: f.h };
        changed.add(n.id);
        stats.grown.push(n.id);
      }
    } else if (kindChanged || (textChanged && !handSized && (f.w > b.w + 1 || f.h > b.h + 1))) {
      const w = kindChanged ? f.w : Math.max(b.w, f.w);
      const h = kindChanged ? f.h : Math.max(b.h, f.h);
      const cc = center(b);
      box = { x: cc.x - w / 2, y: cc.y - h / 2, w, h };
      changed.add(n.id);
      stats.grown.push(n.id);
    }
    if (handEdits.has(c.id)) stats.handMoved++;
    stats.kept++;
    abs.set(n.id, box);
  }

  // 2. New nodes go next to a neighbour.
  const preds = (id: string) => d.edges.filter((e) => e.to === id).map((e) => e.from);
  const succs = (id: string) => d.edges.filter((e) => e.from === id).map((e) => e.to);
  const ancestors = (gid: string | undefined): Set<string> => {
    const s = new Set<string>();
    for (let g = gid; g; g = d.groups.find((x) => x.id === g)?.parent) s.add(g);
    return s;
  };
  const oldGroupBox = (gid: string) => {
    const c = cellOf.get(gid);
    return c && oldGroups.has(gid) ? absBox(old, c.id) : undefined;
  };
  // New box-like nodes match the most common width already in the diagram.
  const widths = new Map<number, number>();
  for (const [id, b] of abs) {
    const k = d.nodes.find((n) => n.id === id)?.kind;
    if (k && !['start', 'end', 'decision'].includes(k)) widths.set(b.w, (widths.get(b.w) ?? 0) + 1);
  }
  const commonW = [...widths].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const sizeOf = (n: Node) => {
    const nat = fresh.natural.get(n.id)!;
    const boxy = !['start', 'end', 'decision'].includes(n.kind);
    return { w: boxy ? Math.max(nat.w, commonW) : nat.w, h: nat.h };
  };
  const memberOf = (nodeId: string, gid: string) => ancestors(d.nodes.find((x) => x.id === nodeId)?.parent).has(gid);
  const pending = d.nodes.filter((n) => !abs.has(n.id));
  while (pending.length) {
    let i = pending.findIndex((n) => [...preds(n.id), ...succs(n.id)].some((m) => abs.has(m)));
    if (i < 0) i = 0;
    const n = pending.splice(i, 1)[0]!;
    const f = { ...fresh.nodes.get(n.id)!, ...sizeOf(n) };
    const anchor = [...preds(n.id), ...succs(n.id)].find((m) => abs.has(m));
    let cand: Box;
    if (anchor) {
      const fa = center(fresh.nodes.get(anchor)!), a = center(abs.get(anchor)!), fc = center(f);
      cand = { x: a.x + (fc.x - fa.x) - f.w / 2, y: a.y + (fc.y - fa.y) - f.h / 2, w: f.w, h: f.h };
    } else {
      cand = fallbackSpot(n, f, abs, fresh, oldGroupBox(n.parent ?? ''));
    }
    abs.set(n.id, freeSpot(cand, n, abs, d, ancestors(n.parent), oldGroupBox, memberOf));
    changed.add(n.id);
    stats.placed.push(n.id);
  }

  // 3. Groups: keep their box, grow to fit members, deepest first.
  const depth = (gid: string): number => ancestors(gid).size;
  const gabs = new Map<string, Box>();
  for (const g of [...d.groups].sort((a, b) => depth(b.id) - depth(a.id))) {
    const kids = [
      ...d.nodes.filter((n) => n.parent === g.id).map((n) => abs.get(n.id)!),
      ...d.groups.filter((x) => x.parent === g.id).map((x) => gabs.get(x.id)!),
    ].filter(Boolean);
    const need = kids.length ? padded(union(kids)) : undefined;
    let prev = oldGroupBox(g.id);
    // A group nobody sized by hand closes up when members leave it. Each side
    // moves in by as much as its outermost member did, so the padding stays.
    const gc = cellOf.get(g.id);
    if (prev && kids.length && gc && !handEdits.has(gc.id)) {
      const was = [
        ...shown.diagram.nodes.filter((n) => n.parent === g.id).map((n) => absBox(old, cellOf.get(n.id)!.id)),
        ...shown.diagram.groups.filter((x) => x.parent === g.id).map((x) => oldGroupBox(x.id)),
      ].filter((b): b is Box => !!b);
      if (was.length) {
        const a = union(was), z = union(kids);
        const l = Math.max(0, z.x - a.x), t = Math.max(0, z.y - a.y);
        const r = Math.max(0, a.x + a.w - (z.x + z.w)), bt = Math.max(0, a.y + a.h - (z.y + z.h));
        if (l + t + r + bt > 1) {
          prev = { x: prev.x + l, y: prev.y + t, w: prev.w - l - r, h: prev.h - t - bt };
          stats.shrunk.push(g.id);
        }
      }
    }
    const box = prev ? (need ? union([prev, need]) : prev) : need ?? { x: 0, y: 0, w: 200, h: 120 };
    const before = oldGroupBox(g.id);
    if (before && (box.w > before.w + 1 || box.h > before.h + 1) && !stats.shrunk.includes(g.id)) stats.grown.push(g.id);
    gabs.set(g.id, box);
  }

  // 4. Build the scene.
  const absOf = (id: string) => abs.get(id) ?? gabs.get(id)!;
  const rel = (id: string, parent?: string): Box => {
    const a = absOf(id);
    if (!parent) return a;
    const p = gabs.get(parent)!;
    return { ...a, x: a.x - p.x, y: a.y - p.y };
  };
  const vertices: SceneVertex[] = [];
  for (const g of d.groups) {
    const c = oldGroups.has(g.id) ? cellOf.get(g.id) : undefined;
    const box = rel(g.id, g.parent);
    const prev = oldGroups.get(g.id);
    const attrs = { ...(c ? ownAttrs(c) : {}), ...groupAttrs(g, d.theme) };
    const groupSame = !!c && !themeChanged && sameLookOf(prev, g) && prev?.parent === g.parent;
    if (c && prev?.label === g.label && c.attrs.label != null && !themeChanged) attrs.label = c.attrs.label;
    attrs.aiviz_auto = autoAttr(box); // hand moves are now part of the layout
    vertices.push({ id: g.id, parent: g.parent ?? '1', attrs, style: groupSame ? c!.styleRaw : groupStyleFor(d, g), box });
  }
  for (const n of d.nodes) {
    const c = oldNodes.has(n.id) ? cellOf.get(n.id) : undefined;
    const prev = oldNodes.get(n.id);
    const box = rel(n.id, n.parent);
    const attrs = { ...(c ? ownAttrs(c) : {}), ...nodeAttrs(d, n) };
    const lookSame = sameLookOf(prev, n);
    if (c && prev && prev.label === n.label && prev.tech === n.tech && !themeChanged && lookSame) attrs.label = c.attrs.label ?? c.label;
    attrs.aiviz_auto = autoAttr(box);
    // Keep a person's styling, unless the kind changed or it's a shape they added
    // without picking any colours (draw.io's default black outline).
    const unstyled = c && !c.attrs.aiviz_kind && !c.style.fillColor && !c.style.strokeColor;
    const style = c && prev?.kind === n.kind && prev?.icon === n.icon && lookSame && !unstyled && !themeChanged ? c.styleRaw : styleFor(d, n);
    vertices.push({ id: n.id, parent: n.parent ?? '1', attrs, style, box });
    vertices.push(...nodeChildren(d, n, box));
  }

  const outIds = new Set<string>(vertices.map((v) => v.id));
  const reroute: string[] = [];
  const edges: SceneEdge[] = [];
  for (const e of d.edges) {
    const oldCellId = shown.edgeCells.get(e.id);
    const oc = oldCellId ? old.byId.get(oldCellId) : undefined;
    const prev = shown.diagram.edges.find((x) => x.id === e.id);
    const id = edgeCellId(e.id);
    const sameEnds = !!prev && !changed.has(e.from) && !changed.has(e.to);
    // A route nobody adjusted is stale once a person moves either end.
    const endMovedByHand = [e.from, e.to].some((n) => {
      const c = cellOf.get(n);
      return c && handEdits.has(c.id);
    });
    const routeUntouched = !oc?.attrs.aiviz_auto || oc.attrs.aiviz_auto === routeAttr(oc.geom?.points ?? []);
    const stale = endMovedByHand && routeUntouched;
    let keepParent = oc?.parent && (oc.parent === '1' || outIds.has(oc.parent)) ? oc.parent : undefined;
    // A route stored relative to a group is stale once that group's corner moves.
    if (keepParent && keepParent !== '1') {
      const was = oldGroupBox(keepParent), now = gabs.get(keepParent);
      if (!was || !now || Math.abs(was.x - now.x) > 0.5 || Math.abs(was.y - now.y) > 0.5) keepParent = undefined;
    }
    const attrs: Record<string, string> = { ...(oc ? ownAttrs(oc) : {}), ...edgeAttrs(e) };
    if (oc && (prev?.label ?? '') === (e.label ?? '') && oc.attrs.label != null) attrs.label = oc.attrs.label;
    let style: string;
    const unstyledEdge = oc && !oc.attrs.aiviz_edge && !oc.style.strokeColor;
    const sameLook = prev?.style === e.style && prev?.rel === e.rel && JSON.stringify(prev?.card) === JSON.stringify(e.card) && sameLookOf(prev, e);
    if (oc && sameLook && !unstyledEdge && !themeChanged) style = oc.styleRaw;
    else {
      // Arrow style or theme changed: take the theme style, keep where the edge attaches.
      const ports = oc ? PORT_KEYS.filter((k) => k in oc.style).map((k) => `${k}=${oc.style[k]};`).join('') : '';
      style = edgeStyleFor(d, e) + ports;
    }
    if (oc && sameEnds && keepParent && !stale) {
      edges.push({ id, parent: keepParent, attrs, style, source: e.from, target: e.to, geomRaw: oc.geomRaw });
    } else {
      edges.push({ id, parent: '1', attrs, style: withoutKeys(style, PORT_KEYS), source: e.from, target: e.to, points: [] });
      reroute.push(id);
    }
  }
  stats.rerouted = reroute.length;

  // 5. Carry over what the spec can't express.
  const raw: string[] = [];
  // A spec written before someone added shapes by hand doesn't know about them.
  // Deleting them would silently destroy their work, so keep them.
  if (!opts.specIsCurrent) {
    const specIds = new Set(d.nodes.map((n) => n.id));
    for (const [cellId, specId] of shown.idMap) {
      const c = old.byId.get(cellId)!;
      if (specIds.has(specId) || c.attrs.aiviz_kind || c.attrs.aiviz_type || outIds.has(cellId)) continue;
      raw.push(c.raw);
      outIds.add(cellId);
      stats.keptUnknown.push(specId);
    }
    const specEdges = new Set(d.edges.map((e) => e.id));
    for (const [eid, cellId] of shown.edgeCells) {
      const c = old.byId.get(cellId)!;
      if (specEdges.has(eid) || c.attrs.aiviz_edge) continue;
      if (c.source && c.target && outIds.has(c.source) && outIds.has(c.target)) raw.push(c.raw);
    }
  }
  for (const cid of shown.skipped) {
    const c = old.byId.get(cid)!;
    const parentOk = !c.parent || c.parent === '1' || outIds.has(c.parent);
    const endsOk = (!c.source || outIds.has(c.source)) && (!c.target || outIds.has(c.target));
    if (parentOk && endsOk && !outIds.has(cid)) raw.push(c.raw);
  }
  stats.carried = raw.length - stats.keptUnknown.length;
  const kept = new Set([...outIds, ...stats.keptUnknown]);
  for (const id of [...oldNodes.keys(), ...oldGroups.keys()]) if (!kept.has(id)) stats.removed.push(id);

  const { id: _id, label: _label, ...oldMeta } = old.meta;
  return {
    scene: {
      name: d.title ?? old.name,
      // 'manual' marks a layout a person arranged; a merge into a machine layout doesn't.
      meta: { ...withoutTheme(oldMeta), ...diagramMeta(d, opts.touched === false ? {} : { aiviz_layout: 'manual' }) },
      background: palette(d.theme).canvas,
      vertices,
      edges,
      raw,
    },
    reroute,
    stats,
  };
}

function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w)), y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

function padded(b: Box): Box {
  return { x: b.x - PAD.left, y: b.y - PAD.top, w: b.w + PAD.left + PAD.right, h: b.h + PAD.top + PAD.bottom };
}

/** No placed neighbour: put it after everything else, in the layout direction. */
function fallbackSpot(n: Node, f: Box, abs: Map<string, Box>, fresh: Layout, groupBox?: Box): Box {
  const all = [...abs.values()];
  const area = groupBox ? { ...groupBox, y: groupBox.y + PAD.top, h: groupBox.h - PAD.top } : all.length ? union(all) : { x: 0, y: 0, w: 0, h: 0 };
  if (fresh.direction === 'LR' || fresh.direction === 'RL') return { x: area.x + area.w + GAP * 2, y: area.y, w: f.w, h: f.h };
  return { x: area.x, y: area.y + area.h + GAP * 2, w: f.w, h: f.h };
}

/** Nearest spot to `cand` on a 8px grid that doesn't collide with placed nodes or foreign groups. */
function freeSpot(
  cand: Box,
  n: Node,
  abs: Map<string, Box>,
  d: Diagram,
  myGroups: Set<string>,
  groupBox: (g: string) => Box | undefined,
  memberOf: (nodeId: string, gid: string) => boolean,
): Box {
  const obstacles: Box[] = [];
  for (const [id, b] of abs) if (id !== n.id) obstacles.push(b);
  for (const g of d.groups) {
    if (myGroups.has(g.id)) continue;
    const b = groupBox(g.id);
    if (b) obstacles.push(b);
  }
  // Its own groups grow to hold it. That growth must not swallow a box that
  // isn't in the group, or the picture says something the spec doesn't.
  const mine = [...myGroups].map((g) => ({ g, box: groupBox(g) })).filter((x): x is { g: string; box: Box } => !!x.box);
  const swallows = (b: Box) =>
    mine.some(({ g, box }) => {
      const grown = union([box, padded(b)]);
      if (grown.w <= box.w + 1 && grown.h <= box.h + 1) return false;
      for (const [id, o] of abs) if (id !== n.id && !memberOf(id, g) && overlaps(grown, o) && !overlaps(box, o)) return true;
      return false;
    });
  const ok = (b: Box) => obstacles.every((o) => !overlaps(b, o, GAP)) && !swallows(b);
  const snap = (v: number) => Math.round(v / 8) * 8;
  const start = { ...cand, x: snap(cand.x), y: snap(cand.y) };
  if (ok(start)) return start;
  for (let r = 1; r <= 80; r++) {
    const ring: Box[] = [];
    for (let k = -r; k <= r; k++) {
      ring.push({ ...start, x: start.x + k * 16, y: start.y - r * 16 }, { ...start, x: start.x + k * 16, y: start.y + r * 16 });
      ring.push({ ...start, x: start.x - r * 16, y: start.y + k * 16 }, { ...start, x: start.x + r * 16, y: start.y + k * 16 });
    }
    ring.sort((a, b) => Math.hypot(a.x - start.x, a.y - start.y) - Math.hypot(b.x - start.x, b.y - start.y));
    const hit = ring.find(ok);
    if (hit) return hit;
  }
  return start;
}


function withoutTheme(meta: Record<string, string>) {
  const { aiviz_theme: _t, aiviz_accent: _a, ...rest } = meta;
  return rest;
}
