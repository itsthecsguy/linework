// Cleanup on ELK's geometry before it is written: the small faults a careful
// person would fix by hand. ELK spreads ports along a box's side and then bends
// each edge back toward its target, which leaves short S-jogs right at the box.
// Decisions should branch from the diamond's points, not its slanted sides.
// Self-loops come out 10px wide with their label on the node.
import type { Diagram } from '../spec/model.js';
import { kindDef } from '../spec/model.js';
import type { Box, Layout, Point } from './layout.js';

/** Map the layout so the flow runs top to bottom, do the work, map back. */
function frame(dir: Layout['direction']) {
  const to = (p: Point): Point => (dir === 'TB' ? p : dir === 'BT' ? { x: p.x, y: -p.y } : dir === 'LR' ? { x: p.y, y: p.x } : { x: p.y, y: -p.x });
  const from = (p: Point): Point => (dir === 'TB' ? p : dir === 'BT' ? { x: p.x, y: -p.y } : dir === 'LR' ? { x: p.y, y: p.x } : { x: -p.y, y: p.x });
  const box = (b: Box, f: (p: Point) => Point): Box => {
    const a = f({ x: b.x, y: b.y }), c = f({ x: b.x + b.w, y: b.y + b.h });
    return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) };
  };
  return { to, from, boxTo: (b: Box) => box(b, to), boxFrom: (b: Box) => box(b, from) };
}

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;
const vert = (a: Point, b: Point) => near(a.x, b.x);
const horiz = (a: Point, b: Point) => near(a.y, b.y);

/** Drop repeated points and points in the middle of a straight run. */
export function simplify(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && near(last.x, p.x) && near(last.y, p.y)) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((vert(prev, last) && vert(last, p)) || (horiz(prev, last) && horiz(last, p)))) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

function segHits(a: Point, b: Point, r: Box, pad = 0): boolean {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return x1 > r.x - pad && x0 < r.x + r.w + pad && y1 > r.y - pad && y0 < r.y + r.h + pad;
}

export interface PolishInput {
  /** Width of each group's title text, for keeping edges off it. */
  groupTitle: Map<string, { w: number; h: number }>;
  /** Default left inset of a group title, as in the group style. */
  titleInset: number;
  /** Top band of a group that holds its title. */
  groupTop: number;
}

export function polish(d: Diagram, l: Layout, inp: PolishInput): void {
  const f = frame(l.direction);
  const shapeOf = (id: string) => { const n = d.nodes.find((x) => x.id === id); return n ? kindDef(d.type, n.kind).shape : undefined; };
  const nodes = new Map([...l.nodes].map(([k, b]) => [k, f.boxTo(b)]));
  // Corners are rounded; an edge leaving inside the arc looks detached.
  const R = 8;

  type E = { id: string; from: string; to: string; pts: Point[]; label: boolean };
  const edges: E[] = [];
  for (const e of d.edges) {
    const le = l.edges.get(e.id);
    if (le) edges.push({ id: e.id, from: e.from, to: e.to, pts: le.points.map(f.to), label: !!le.label });
  }
  const others = (self: E) => edges.filter((x) => x !== self);
  const usedAt = (id: string, x: number, skip: E, side: 'top' | 'bottom') =>
    others(skip).some((o) => {
      const p = o.from === id ? o.pts[0]! : o.to === id ? o.pts[o.pts.length - 1]! : undefined;
      const b = nodes.get(id)!;
      return p && near(p.y, side === 'top' ? b.y : b.y + b.h, 1) && Math.abs(p.x - x) < 10;
    });
  // A vertical run no other edge already runs along.
  const free = (a: Point, b: Point, self: E) =>
    others(self).every((o) =>
      o.pts.slice(1).every((q, i) => {
        const p = o.pts[i]!;
        // Two labelled runs side by side need room for the labels between them.
        if (!vert(p, q) || Math.abs(p.x - a.x) > (self.label || o.label ? 44 : 8)) return true;
        return Math.min(Math.max(p.y, q.y), Math.max(a.y, b.y)) - Math.max(Math.min(p.y, q.y), Math.min(a.y, b.y)) <= 0;
      }),
    );
  const clear = (a: Point, b: Point, except: string[]) => [...nodes].every(([k, r]) => except.includes(k) || !segHits(a, b, r, 6));

  // Edges out of a decision wait until the decision pass below has picked the
  // point they leave from; their start stub isn't a route to straighten toward.
  // Two passes: a jog can be blocked by another edge's stub that the first pass removes.
  const dejog = (fromDecisions: boolean) => {
  for (let pass = 0; pass < 2; pass++)
  for (const e of edges) {
    // Tables keep their edges on the key rows.
    if (e.from === e.to || shapeOf(e.from) === 'table' || shapeOf(e.to) === 'table') continue;
    if ((shapeOf(e.from) === 'diamond') !== fromDecisions) continue;
    const s = nodes.get(e.from)!, t = nodes.get(e.to)!;
    let p = simplify(e.pts);
    // Start: p0 on the box, a short leg, a jog sideways, then the real run.
    for (let guard = 0; guard < 2 && p.length >= 4; guard++) {
      const [p0, p1, p2] = [p[0]!, p[1]!, p[2]!];
      const side = near(p0.y, s.y + s.h, 1) ? 'bottom' : near(p0.y, s.y, 1) ? 'top' : undefined;
      if (!side || !vert(p0, p1) || !horiz(p1, p2) || shapeOf(e.from) === 'diamond') break;
      const p3 = p[3]!, np = { x: p2.x, y: p0.y };
      // Only a short leg is a jog; a long one is the route itself.
      // The run p2-p3 is already there; only the piece added at the box is new.
      if (!vert(p2, p3) || !free(np, p2, e)) break;
      if (p2.x < s.x + R || p2.x > s.x + s.w - R || usedAt(e.from, p2.x, e, side) || !clear(np, p3, [e.from, e.to])) break;
      p = simplify([np, ...p.slice(3)]);
    }
    // End: the mirror image.
    for (let guard = 0; guard < 2 && p.length >= 4; guard++) {
      const n = p.length;
      const [q0, q1, q2] = [p[n - 1]!, p[n - 2]!, p[n - 3]!];
      const side = near(q0.y, t.y, 1) ? 'top' : near(q0.y, t.y + t.h, 1) ? 'bottom' : undefined;
      if (!side || !vert(q0, q1) || !horiz(q1, q2) || shapeOf(e.to) === 'diamond') break;
      const q3 = p[n - 4]!, nq = { x: q2.x, y: q0.y };
      if (!vert(q3, q2) || !free(q2, nq, e)) break;
      if (q2.x < t.x + R || q2.x > t.x + t.w - R || usedAt(e.to, q2.x, e, side) || !clear(q3, nq, [e.from, e.to])) break;
      p = simplify([...p.slice(0, n - 3), nq]);
    }
    e.pts = p;
  }
  };
  dejog(false);

  // A Z between boxes that overlap side to side (down, across, down) can be one
  // straight drop through the overlap.
  for (const e of edges) {
    if (e.from === e.to || [e.from, e.to].some((id) => ['table', 'diamond'].includes(shapeOf(id) ?? ''))) continue;
    const p = simplify(e.pts);
    if (p.length !== 4) continue;
    const s = nodes.get(e.from)!, t = nodes.get(e.to)!;
    const [a, b, c, z] = p as [Point, Point, Point, Point];
    if (!vert(a, b) || !horiz(b, c) || !vert(c, z) || !near(a.y, s.y + s.h, 1) || !near(z.y, t.y, 1)) continue;
    const lo = Math.max(s.x, t.x) + R, hi = Math.min(s.x + s.w, t.x + t.w) - R;
    if (hi < lo) continue;
    const x = Math.round(Math.min(hi, Math.max(lo, (a.x + z.x) / 2)));
    const top = { x, y: a.y }, bot = { x, y: z.y };
    if (usedAt(e.from, x, e, 'bottom') || usedAt(e.to, x, e, 'top') || !clear(top, bot, [e.from, e.to]) || !free(top, bot, e)) continue;
    e.pts = [top, bot];
    const le = l.edges.get(e.id)!;
    if (le.label) {
      const lb = f.boxTo(le.label);
      le.label = f.boxFrom({ ...lb, x: x - lb.w / 2, y: (top.y + bot.y) / 2 - lb.h / 2 });
    }
  }

  // Decisions: leave from the diamond's bottom or side points, enter at the top point.
  for (const n of d.nodes) {
    if (kindDef(d.type, n.kind).shape !== 'diamond') continue;
    const b = nodes.get(n.id)!;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const outs = edges.filter((e) => e.from === n.id && e.to !== n.id);
    // The run each edge settles into once it is clear of the diamond. ELK usually
    // leaves on a short stub and turns; when it leaves straight down instead, the
    // first segment is the run.
    const runAt = (p: Point[]) => {
      if (p.length >= 2 && vert(p[0]!, p[1]!) && p[1]!.y > b.y + b.h + 24) return 0;
      for (let i = 1; i < p.length - 1; i++) if (vert(p[i]!, p[i + 1]!) && p[i + 1]!.y > b.y + b.h + 1) return i;
      return -1;
    };
    const runX = (e: E) => {
      const i = runAt(e.pts);
      return (i >= 0 ? e.pts[i]! : e.pts[e.pts.length - 1]!).x;
    };
    // Points from the start of that run on.
    const tail = (e: E) => {
      const i = runAt(e.pts);
      return i >= 0 ? e.pts.slice(i) : e.pts.slice(-1);
    };
    const sorted = [...outs].sort((a, c) => runX(a) - runX(c));
    let bottomTaken = false;
    // One branch per side point: a second one there would hide the first.
    const taken = { left: false, right: false };
    // A branch whose run sits under the diamond would have to fork off the bottom
    // point next to its sibling. Move the run out past the side point instead, so
    // each branch leaves from its own corner: side point, a short stub, then down.
    const sideStep = (e: E, rest: Point[], left: boolean): Point[] | undefined => {
      if (rest.length < 2) return undefined;
      const lab = l.edges.get(e.id)?.label;
      // Far enough out that the branch label, centred on the run, clears the diamond.
      const out = Math.max(24, lab ? Math.ceil(f.boxTo(lab).w / 2) + 8 : 0);
      const beside = left ? b.x - out : b.x + b.w + out;
      const end = rest[1]!, t = nodes.get(e.to)!;
      // A run that drops straight into the target has to stay over the target.
      const drops = rest.length === 2;
      if (drops ? ['diamond', 'table'].includes(shapeOf(e.to) ?? '') || !near(end.y, t.y, 1) : !horiz(end, rest[2]!) || end.y < b.y + b.h + 12) return undefined;
      // Into the target's middle when that is already clear of the diamond, else just beside the diamond.
      const mid = t.x + t.w / 2;
      const tries = drops && (left ? mid <= beside : mid >= beside) ? [mid, beside] : [beside];
      const sideP = { x: left ? b.x : b.x + b.w, y: cy };
      for (const nx of tries) {
        if (drops && (nx < t.x + R || nx > t.x + t.w - R || usedAt(e.to, nx, e, 'top'))) continue;
        const a = { x: nx, y: cy }, c = { x: nx, y: end.y };
        if (!clear(sideP, a, [n.id]) || !clear(a, c, [n.id, e.to]) || !free(a, c, e)) continue;
        if (!drops && !clear(c, rest[2]!, [n.id, e.to])) continue;
        return simplify([sideP, a, c, ...rest.slice(2)]);
      }
      return undefined;
    };
    // The edge closest to straight down gets the bottom point.
    const nearest = (list: E[]) => list.reduce<E | undefined>((m, e) => (!m || Math.abs(runX(e) - cx) < Math.abs(runX(m) - cx) ? e : m), undefined);
    // Or, failing that, the one whose target reaches under the bottom point, so it can drop straight.
    const reaches = (e: E) => {
      const t = nodes.get(e.to)!, rest = tail(e);
      return rest.length === 2 && near(rest[1]!.y, t.y, 1) && !['diamond', 'table'].includes(shapeOf(e.to) ?? '') && cx >= t.x + 16 && cx <= t.x + t.w - 16;
    };
    const mid = nearest(sorted);
    const straight = mid && Math.abs(runX(mid) - cx) < 12 ? mid : nearest(sorted.filter(reaches));
    // The middle branch goes last: whether it can drop straight depends on where
    // its siblings ended up, not on the stubs ELK gave them at the bottom point.
    for (const e of [...sorted.filter((x) => x !== straight), ...(straight ? [straight] : [])]) {
      const x = runX(e), rest = tail(e);
      const bottom = { x: cx, y: b.y + b.h };
      // A run that starts on the diamond itself: what follows is from its far end on.
      const onEdge = rest[0]!.y <= b.y + b.h + 1 && rest.length > 1;
      if (e === straight && Math.abs(x - cx) < 12) {
        const run = onEdge ? rest.slice(1) : rest;
        e.pts = simplify([bottom, { x: cx, y: run[0]!.y }, ...run.slice(1)]);
        if (!near(run[0]!.x, cx)) e.pts = simplify([bottom, { x: cx, y: run[0]!.y }, ...run]);
        bottomTaken = true;
        continue;
      }
      const t = nodes.get(e.to)!, floor = { x: cx, y: t.y };
      if (e === straight && reaches(e) && !usedAt(e.to, cx, e, 'top') && clear(bottom, floor, [n.id, e.to]) && free(bottom, floor, e)) {
        e.pts = [bottom, floor];
        bottomTaken = true;
        continue;
      }
      const left = x < cx;
      const sideP = { x: left ? b.x : b.x + b.w, y: cy };
      const corner = { x, y: cy };
      const key = left ? 'left' : 'right';
      if (!taken[key]) {
        const sideOk = (left ? x < b.x - 10 : x > b.x + b.w + 10) && clear(sideP, corner, [n.id]) && clear(corner, rest[0]!, [n.id, e.to]);
        const pts = sideOk ? simplify([sideP, corner, ...rest]) : sideStep(e, rest, left);
        if (pts) {
          e.pts = pts;
          taken[key] = true;
          continue;
        }
      }
      // Branches that both head down fork from the bottom point on a short stem.
      // Such a run turns onto the stem below the point.
      const y = onEdge ? b.y + b.h + 16 : Math.min(rest[0]!.y, b.y + b.h + 16);
      e.pts = simplify([bottom, { x: cx, y }, { x, y }, ...(onEdge ? rest.slice(1) : rest)]);
      bottomTaken = true;
    }
    for (const e of edges.filter((x) => x.to === n.id && x.from !== n.id)) {
      const p = e.pts, m = p.length;
      const last = p[m - 1]!, prev = p[m - 2];
      if (!prev || !vert(prev, last) || prev.y > last.y || near(last.x, cx)) {
        if (prev && vert(prev, last) && prev.y <= last.y) e.pts[m - 1] = { x: cx, y: b.y };
        continue;
      }
      // Arriving sideways and then dropping to a port beside the top point: carry
      // the sideways run on to the middle. Stepping down first leaves a small kink.
      const before = p[m - 3];
      const across = { x: cx, y: prev.y };
      if (before && horiz(before, prev) && !near(before.x, cx) && clear(prev, across, [e.from, n.id]) && clear(across, { x: cx, y: b.y }, [e.from, n.id])) {
        e.pts = simplify([...p.slice(0, m - 2), across, { x: cx, y: b.y }]);
        continue;
      }
      const y = Math.max(prev.y, b.y - 16);
      e.pts = simplify([...p.slice(0, m - 1), { x: last.x, y }, { x: cx, y }, { x: cx, y: b.y }]);
    }
    // Branches that join above a decision meet at one height, not a few px apart.
    const joins = edges.flatMap((e) => {
      const p = e.pts, m = p.length;
      if (e.to !== n.id || e.from === n.id || m < 4) return [];
      const [up, a, c, top] = [p[m - 4]!, p[m - 3]!, p[m - 2]!, p[m - 1]!];
      const ok = vert(up, a) && up.y < a.y && horiz(a, c) && near(c.x, cx) && vert(c, top) && near(top.y, b.y, 1);
      return ok ? [{ e, a, c }] : [];
    });
    if (joins.length > 1) {
      const y = Math.max(...joins.map((j) => j.a.y));
      for (const j of joins) {
        if (near(j.a.y, y) || y - j.a.y > 24) continue;
        const na = { x: j.a.x, y }, nc = { x: cx, y };
        if (!clear(na, nc, [j.e.from, n.id])) continue;
        const m = j.e.pts.length;
        j.e.pts = simplify([...j.e.pts.slice(0, m - 3), na, nc, j.e.pts[m - 1]!]);
      }
    }
  }

  dejog(true);

  // Self-loops: wide enough to read as a loop, label outside it.
  for (const e of edges) {
    if (e.from !== e.to) continue;
    const b = nodes.get(e.from)!, le = l.edges.get(e.id)!;
    const ys = [b.y + b.h * 0.28, b.y + b.h * 0.72];
    const pts = e.pts;
    const leftSide = pts.some((p) => p.x < b.x - 1);
    const xo = leftSide ? b.x - 24 : b.x + b.w + 24;
    const edgeX = leftSide ? b.x : b.x + b.w;
    e.pts = [{ x: edgeX, y: ys[0]! }, { x: xo, y: ys[0]! }, { x: xo, y: ys[1]! }, { x: edgeX, y: ys[1]! }];
    if (le.label) {
      const lb = f.boxTo(le.label);
      le.label = f.boxFrom({ ...lb, x: leftSide ? xo - 6 - lb.w : xo + 6, y: b.y + b.h / 2 - lb.h / 2 });
    }
  }

  for (const e of edges) {
    const le = l.edges.get(e.id)!;
    le.points = e.pts.map(f.from);
  }

  // A one-column group is only as wide as its node, so an edge dropping into the
  // node's middle crosses the title. ELK ignores a minimum size on groups it lays
  // out with their children, so widen them here: evenly to both sides, when the
  // added strips hold nothing else.
  const owner = new Map<string, string | undefined>([...d.groups.map((g) => [g.id, g.parent] as const), ...d.nodes.map((n) => [n.id, n.parent] as const)]);
  const within = (id: string | undefined, gid: string): boolean => !!id && (id === gid || within(owner.get(id), gid));
  const depth = (gid: string): number => { let k = 0; for (let p = owner.get(gid); p; p = owner.get(p)) k++; return k; };
  for (const gid of [...l.groups.keys()].sort((a, b) => depth(b) - depth(a))) {
    const g = l.groups.get(gid)!, tt = inp.groupTitle.get(gid);
    if (!tt) continue;
    const half = Math.ceil((2 * (tt.w + inp.titleInset + 10) - g.w) / 2);
    if (half <= 0) continue;
    const strips = [{ x: g.x - half, y: g.y, w: half, h: g.h }, { x: g.x + g.w, y: g.y, w: half, h: g.h }];
    const hits = (r: Box) => strips.some((s) => r.x < s.x + s.w + 8 && r.x + r.w > s.x - 8 && r.y < s.y + s.h && r.y + r.h > s.y);
    const parent = owner.get(gid) ? l.groups.get(owner.get(gid)!) : undefined;
    const fits =
      (!parent || (g.x - half >= parent.x + 8 && g.x + g.w + half <= parent.x + parent.w - 8)) &&
      [...l.nodes].every(([id, b]) => within(id, gid) || !hits(b)) &&
      [...l.groups].every(([id, b]) => id === gid || within(id, gid) || within(gid, id) || !hits(b)) &&
      [...l.edges.values()].every((le) => le.points.slice(1).every((q, i) => strips.every((s) => !segHits(le.points[i]!, q, s))));
    if (fits) l.groups.set(gid, { ...g, x: g.x - half, w: g.w + 2 * half });
  }
  // Keep the drawing clear of the canvas edge after widening.
  const left = Math.min(...[...l.groups.values(), ...l.nodes.values()].map((b) => b.x));
  if (left < 16) {
    const dx = 16 - left;
    const mv = (b: Box): Box => ({ ...b, x: b.x + dx });
    for (const m of [l.nodes, l.groups]) for (const [k, b] of m) m.set(k, mv(b));
    for (const le of l.edges.values()) {
      le.points = le.points.map((p) => ({ ...p, x: p.x + dx }));
      if (le.label) le.label = mv(le.label);
    }
  }
  l.width = Math.max(l.width, ...[...l.groups.values(), ...l.nodes.values()].map((b) => b.x + b.w + 16));

  // Group titles: slide a title right when an edge runs through it.
  for (const [gid, g] of l.groups) {
    const tt = inp.groupTitle.get(gid);
    if (!tt) continue;
    const segs = [...l.edges.values()].flatMap((le) => le.points.slice(1).map((p, i) => [le.points[i]!, p] as const));
    const blocked = (x: number) => {
      const r = { x: g.x + x - 6, y: g.y + 4, w: tt.w + 12, h: Math.min(inp.groupTop, tt.h + 14) };
      return segs.some(([a, b]) => segHits(a, b, r));
    };
    if (!blocked(inp.titleInset)) continue;
    // The other top corner reads as a choice; a title halfway along reads as an accident.
    const right = Math.floor(g.w - tt.w - inp.titleInset);
    if (right > inp.titleInset && !blocked(right)) {
      (l.titleInset ??= new Map()).set(gid, right);
      continue;
    }
    for (let x = inp.titleInset + 8; x + tt.w + 14 <= g.w; x += 8) {
      if (!blocked(x)) {
        (l.titleInset ??= new Map()).set(gid, x);
        break;
      }
    }
  }
}
