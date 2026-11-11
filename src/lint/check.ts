// Layout lint, computed from geometry draw.io itself produced (see DrawioBrowser.inspect),
// so it also works on files people edited by hand.
import type { InspectCell } from '../render/browser.js';

type Box = { x: number; y: number; w: number; h: number };
type P = { x: number; y: number };

export interface Finding {
  level: 'error' | 'warning';
  rule: string;
  message: string;
  /** Edge cell id, for rules a reroute can fix. */
  edge?: string;
  /** Edge cell ids whose labels are involved, for rules moving a label can fix. */
  labelEdges?: string[];
}

export interface CheckResult {
  findings: Finding[];
  stats: { nodes: number; edges: number; crossings: number; width: number; height: number };
}

const inter = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const shrink = (b: Box, d: number): Box => ({ x: b.x + d, y: b.y + d, w: Math.max(0, b.w - 2 * d), h: Math.max(0, b.h - 2 * d) });
const inside = (a: Box, b: Box, tol = 1) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;

function segHitsBox(a: P, b: P, r: Box): boolean {
  // Liang–Barsky clip
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const edges: Array<[number, number]> = [[-dx, a.x - r.x], [dx, r.x + r.w - a.x], [-dy, a.y - r.y], [dy, r.y + r.h - a.y]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-6;
}

function segsCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const near = (p: P, q: P) => Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1;
  if (near(a, c) || near(a, d) || near(b, c) || near(b, d)) return false;
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

export function check(cells: InspectCell[]): CheckResult {
  const findings: Finding[] = [];
  const byId = new Map(cells.map((c) => [c.id, c]));
  const name = (c: InspectCell) => (c.label ? `"${c.label.slice(0, 40)}"` : c.id);
  // Sequence scaffolding (lifelines, frames, activation bars, guards) isn't an obstacle, nor is a timeline's axis.
  const scaffold = (c: InspectCell) => c.shape === 'umlLifeline' || c.shape === 'umlFrame' || ['bar', 'guard', 'frame', 'grid', 'tick', 'lane'].includes(c.aivizType ?? '');
  const nodes = cells.filter((c) => c.vertex && !c.container && !c.text && !scaffold(c));
  const containers = cells.filter((c) => c.vertex && c.container);
  const edges = cells.filter((c) => c.edge && c.points && c.points.length >= 2);
  function ancestors(id: string | null): Set<string> {
    const s = new Set<string>();
    for (let p = id ? byId.get(id)?.parent : null; p; p = byId.get(p)?.parent ?? null) s.add(p);
    return s;
  }

  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!;
      if (ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue;
      if (inter(a.box, b.box) > 4) findings.push({ level: 'error', rule: 'overlap', message: `${name(a)} and ${name(b)} overlap` });
    }

  for (const n of [...nodes, ...containers]) {
    const p = n.parent ? byId.get(n.parent) : undefined;
    if (p?.container && !inside(n.box, p.box, 2))
      findings.push({ level: 'warning', rule: 'outside-group', message: `${name(n)} sticks out of its group ${name(p)}` });
  }

  // A box drawn inside a group reads as a member of it.
  const groups = containers.filter((g) => !scaffold(g));
  for (const n of nodes) {
    const mine = ancestors(n.id);
    for (const g of groups)
      if (!mine.has(g.id) && inter(n.box, g.box) > 0.25 * n.box.w * n.box.h)
        findings.push({ level: 'warning', rule: 'in-other-group', message: `${name(n)} sits inside ${name(g)} but isn't in that group; move it out, or put it in the group` });
  }

  for (const e of edges) {
    const pts = e.points!;
    const skip = new Set([e.source, e.target, ...ancestors(e.source), ...ancestors(e.target)]);
    // A line through a group it has no end in looks like it connects to something there.
    for (const g of groups) {
      if (skip.has(g.id)) continue;
      const r = shrink(g.box, 6);
      if (pts.some((p, i) => i < pts.length - 1 && segHitsBox(p, pts[i + 1]!, r)))
        findings.push({ level: 'warning', rule: 'edge-through-group', message: `edge ${edgeName(e, byId)} runs through ${name(g)}, which neither end is in` });
    }
    for (const n of nodes) {
      if (skip.has(n.id)) continue;
      const r = shrink(n.box, 3);
      for (let i = 0; i < pts.length - 1; i++)
        if (segHitsBox(pts[i]!, pts[i + 1]!, r)) {
          findings.push({ level: 'error', rule: 'edge-through-node', message: `edge ${edgeName(e, byId)} passes through ${name(n)}`, edge: e.id });
          break;
        }
    }
    // A route that doubles back through its own source or target (stale waypoints after a move).
    for (const endId of [e.source, e.target]) {
      const n = endId ? byId.get(endId) : undefined;
      if (!n || n.container) continue;
      const r = shrink(n.box, 4);
      // Skip the segment that attaches to this node: on diamonds and cylinders it
      // legitimately starts inside the bounding box.
      const isSource = endId === e.source;
      const back = pts.slice(0, -1).some((p, i) => {
        if (isSource ? i === 0 : i === pts.length - 2) return false;
        const q = pts[i + 1]!;
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        return mid.x > r.x && mid.x < r.x + r.w && mid.y > r.y && mid.y < r.y + r.h;
      });
      if (back) {
        findings.push({ level: 'error', rule: 'edge-through-endpoint', message: `edge ${edgeName(e, byId)} doubles back through ${name(n)}`, edge: e.id });
        break;
      }
    }
  }

  for (const n of nodes) {
    if (!n.textBox || !n.label) continue;
    // A label set beside its shape on purpose (a timeline bar too short for its name) has nothing to fit in.
    if (n.textBox.x >= n.box.x + n.box.w - 1) continue;
    if (n.textBox.w > n.box.w + 2 || n.textBox.h > n.box.h + 2)
      findings.push({ level: 'warning', rule: 'label-overflow', message: `label of ${name(n)} doesn't fit its shape; shorten it` });
  }

  const edgeLabels = edges.filter((e) => e.textBox && e.label);
  const grow = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m });
  for (const e of edgeLabels) {
    // A label touching a box reads as part of it, so keep a few px clear.
    for (const n of nodes)
      if (inter(e.textBox!, grow(n.box, 3)) > 4)
        findings.push({ level: 'warning', rule: 'label-on-node', message: `label "${e.label}" on edge ${edgeName(e, byId)} covers ${name(n)}`, labelEdges: [e.id] });
    // Same for a group's title.
    for (const g of containers)
      if (!scaffold(g) && g.label && g.textBox && inter(e.textBox!, grow(g.textBox, 2)) > 4)
        findings.push({ level: 'warning', rule: 'label-on-node', message: `label "${e.label}" on edge ${edgeName(e, byId)} covers the title of ${name(g)}`, labelEdges: [e.id] });
    // A label sitting on another edge, or on a group's border, hides part of that line.
    const tb = grow(e.textBox!, -2);
    const lines = [
      ...edges.filter((o) => o !== e).map((o) => ({ what: `edge ${edgeName(o, byId)}`, pts: o.points!, box: tb })),
      ...containers.filter((g) => !scaffold(g)).map((g) => ({
        box: grow(e.textBox!, 3),
        what: `the border of ${name(g)}`,
        pts: [
          { x: g.box.x, y: g.box.y },
          { x: g.box.x + g.box.w, y: g.box.y },
          { x: g.box.x + g.box.w, y: g.box.y + g.box.h },
          { x: g.box.x, y: g.box.y + g.box.h },
          { x: g.box.x, y: g.box.y },
        ],
      })),
    ];
    for (const o of lines) {
      const hit = o.pts.some((p, k) => {
        const q = o.pts[k + 1];
        if (!q) return false;
        const x1 = Math.min(p.x, q.x), x2 = Math.max(p.x, q.x), y1 = Math.min(p.y, q.y), y2 = Math.max(p.y, q.y);
        return x1 <= o.box.x + o.box.w && x2 >= o.box.x && y1 <= o.box.y + o.box.h && y2 >= o.box.y;
      });
      if (hit) {
        findings.push({ level: 'warning', rule: 'label-on-edge', message: `label "${e.label}" on edge ${edgeName(e, byId)} sits on ${o.what}`, labelEdges: [e.id] });
        break;
      }
    }
  }
  for (let i = 0; i < edgeLabels.length; i++)
    for (let j = i + 1; j < edgeLabels.length; j++)
      if (inter(edgeLabels[i]!.textBox!, edgeLabels[j]!.textBox!) > 6)
        findings.push({ level: 'warning', rule: 'label-collision', message: `edge labels "${edgeLabels[i]!.label}" and "${edgeLabels[j]!.label}" overlap`, labelEdges: [edgeLabels[j]!.id, edgeLabels[i]!.id] });

  let crossings = 0;
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!.points!, b = edges[j]!.points!;
      for (let s = 0; s < a.length - 1; s++) for (let t = 0; t < b.length - 1; t++) if (segsCross(a[s]!, a[s + 1]!, b[t]!, b[t + 1]!)) crossings++;
    }

  // A table's field rows are parts of one node, not nodes of their own.
  const isRow = (n: InspectCell) => {
    const p = n.parent ? byId.get(n.parent) : undefined;
    return !!p && p.shape === 'swimlane';
  };
  const real = nodes.filter((n) => (n.box.w > 30 || n.box.h > 30) && !isRow(n));
  if (real.length > 20) findings.push({ level: 'warning', rule: 'too-big', message: `${real.length} nodes; consider splitting into two diagrams` });
  if (crossings > Math.max(3, edges.length / 3)) findings.push({ level: 'warning', rule: 'crossings', message: `${crossings} edge crossings; try direction: LR/TB, reordering nodes, or splitting` });

  const all = cells.filter((c) => c.vertex).map((c) => c.box);
  const minX = Math.min(...all.map((b) => b.x)), maxX = Math.max(...all.map((b) => b.x + b.w));
  const minY = Math.min(...all.map((b) => b.y)), maxY = Math.max(...all.map((b) => b.y + b.h));
  // A doc column is ~800px; past this, text shrinks below readable size when embedded.
  if (maxX - minX > 1400)
    findings.push({ level: 'warning', rule: 'too-wide', message: `${Math.round(maxX - minX)}px wide; embedded in a doc, its text shrinks to about ${Math.round((800 / (maxX - minX)) * 13)}px. Try direction: TB, fewer nodes per row, or splitting it` });
  return {
    findings: dedupe(findings),
    stats: { nodes: nodes.filter((n) => !ancestors(n.id).size || !nodes.some((p) => ancestors(n.id).has(p.id))).length + cells.filter((c) => c.shape === 'umlLifeline').length, edges: edges.length, crossings, width: Math.round(maxX - minX), height: Math.round(maxY - minY) },
  };
}

function edgeName(e: InspectCell, byId: Map<string, InspectCell>) {
  const lab = (id: string | null) => (id ? byId.get(id)?.label || id : '?');
  return `${lab(e.source)} -> ${lab(e.target)}`;
}

function dedupe(f: Finding[]) {
  const seen = new Set<string>();
  return f.filter((x) => (seen.has(x.message) ? false : (seen.add(x.message), true)));
}

/** Edge cell ids whose routes are broken in a way rerouting fixes. */
export function brokenEdges(res: CheckResult): string[] {
  return [...new Set(res.findings.filter((f) => f.edge).map((f) => f.edge!))];
}
