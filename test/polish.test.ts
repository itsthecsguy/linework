import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseSpecText } from '../src/spec/parse.js';
import { crossings, keyRows, layout, singular, type Box, type Point } from '../src/layout/layout.js';
import { simplify } from '../src/layout/polish.js';
import { branchSpot, labelSpot } from '../src/drawio/write.js';
import { kindDef } from '../src/spec/model.js';

const spec = (name: string) => parseSpecText(fs.readFileSync(`skills/linework/examples/${name}`, 'utf8')).diagram;
const vert = (a: Point, b: Point) => Math.abs(a.x - b.x) < 0.5;
const horiz = (a: Point, b: Point) => Math.abs(a.y - b.y) < 0.5;

describe('layer order', () => {
  it('runs a flow with a retry loop from its first step down', async () => {
    const d = spec('deploy-flow.yaml');
    const l = await layout(d);
    const y = (id: string) => l.nodes.get(id)!.y;
    // Spec order is reading order: the loop back (fix -> build) is the edge drawn backwards.
    expect(y('push')).toBeLessThan(y('build'));
    expect(y('build')).toBeLessThan(y('ok'));
    expect(y('ok')).toBeLessThan(y('stage'));
    expect(y('stage')).toBeLessThan(y('done'));
  });

  it('starts a state machine at its initial state', async () => {
    const d = spec('job-state.yaml');
    const l = await layout(d);
    const y = (id: string) => l.nodes.get(id)!.y;
    expect(y('queued')).toBeLessThan(y('running'));
    expect(y('running')).toBeLessThan(y('succeeded'));
  });
});

describe('polish', () => {
  it('leaves every route orthogonal', async () => {
    for (const f of ['platform.yaml', 'deploy-flow.yaml', 'refund-flow.yaml', 'job-state.yaml', 'checkout.yaml']) {
      const l = await layout(spec(f));
      for (const [id, e] of l.edges) {
        for (let i = 1; i < e.points.length; i++) expect(vert(e.points[i - 1]!, e.points[i]!) || horiz(e.points[i - 1]!, e.points[i]!), `${f} ${id}`).toBe(true);
      }
    }
  }, 30000);

  it('branches decisions from the diamond points', async () => {
    const d = spec('refund-flow.yaml');
    const l = await layout(d);
    const onPoint = (p: Point, b: Box) => {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const pts = [{ x: cx, y: b.y }, { x: cx, y: b.y + b.h }, { x: b.x, y: cy }, { x: b.x + b.w, y: cy }];
      return pts.some((q) => Math.abs(q.x - p.x) < 1 && Math.abs(q.y - p.y) < 1);
    };
    for (const e of d.edges) {
      const r = l.edges.get(e.id)!;
      if (e.from === 'window' || e.from === 'amount' || e.from === 'approved') expect(onPoint(r.points[0]!, l.nodes.get(e.from)!), e.id).toBe(true);
      if (e.to === 'window' || e.to === 'amount' || e.to === 'approved') expect(onPoint(r.points[r.points.length - 1]!, l.nodes.get(e.to)!), e.id).toBe(true);
    }
  });

  it('draws a self-transition as a loop clear of its state, label outside', async () => {
    const d = spec('job-state.yaml');
    const l = await layout(d);
    const e = d.edges.find((x) => x.from === 'running' && x.to === 'running')!;
    const r = l.edges.get(e.id)!, b = l.nodes.get('running')!;
    expect(r.points).toHaveLength(4);
    const out = r.points[1]!.x;
    expect(Math.min(Math.abs(out - b.x), Math.abs(out - (b.x + b.w)))).toBeGreaterThanOrEqual(20);
    const lab = r.label!;
    expect(lab.x + lab.w <= b.x || lab.x >= b.x + b.w).toBe(true);
  });

  it('simplifies repeated and collinear points', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }, { x: 10, y: 20 }])).toEqual([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 10, y: 20 }]);
  });

  it('moves a group title off an edge that runs through it', async () => {
    const d = spec('gcp-ingest.yaml');
    const l = await layout(d);
    expect(l.titleInset?.get('gcp')).toBeGreaterThan(14);
  });
});

describe('ER key rows', () => {
  it('singularizes table names', () => {
    expect(singular('addresses')).toBe('address');
    expect(singular('categories')).toBe('category');
    expect(singular('orgs')).toBe('org');
    expect(singular('inventory')).toBe('inventory');
  });

  it('pins each relationship to the foreign key and the primary key it names', () => {
    const d = spec('shop-er.yaml');
    const k = keyRows(d);
    const row = (table: string, i: number | undefined) => d.nodes.find((n) => n.id === table)!.fields![i!]!.name;
    const rel = (from: string, to: string) => k.get(d.edges.find((e) => e.from === from && e.to === to)!.id)!;
    expect(row('orders', rel('orders', 'customers').from)).toBe('customer_id');
    expect(row('customers', rel('orders', 'customers').to)).toBe('id');
    expect(row('orders', rel('orders', 'addresses').from)).toBe('shipping_address_id');
    expect(row('order_items', rel('order_items', 'products').from)).toBe('product_id');
  });

  it('attaches relationship lines at the key rows', async () => {
    const d = spec('shop-er.yaml');
    const l = await layout(d);
    const e = d.edges.find((x) => x.from === 'orders' && x.to === 'customers')!;
    const r = l.edges.get(e.id)!, t = l.nodes.get('orders')!;
    const fieldRow = d.nodes.find((n) => n.id === 'orders')!.fields!.findIndex((f) => f.name === 'customer_id');
    const y = r.points[0]!.y - t.y;
    expect(Math.abs(y - (36 + fieldRow * 28 + 14))).toBeLessThan(1);
    expect(crossings(l)).toBe(0);
  });
});

describe('harder specs', () => {
  const stress = (name: string) => parseSpecText(fs.readFileSync(`test/fixtures/stress/${name}`, 'utf8')).diagram;

  it('draws only the loop edge backwards in a flow with a late merge', async () => {
    const d = stress('incident-flow.yaml');
    const l = await layout(d);
    const y = (id: string) => l.nodes.get(id)!.y;
    // Both fixes lead down into the check; "new findings" is the one edge going back up.
    expect(y('revert')).toBeLessThan(y('fixed'));
    expect(y('mitigate')).toBeLessThan(y('fixed'));
    expect(y('investigate')).toBeLessThan(y('rollback'));
    expect(y('fixed')).toBeLessThan(y('escalate'));
    expect(crossings(l)).toBeLessThanOrEqual(3);
  }, 30000);

  it('wraps a long decision wider instead of taller', async () => {
    const d = stress('incident-flow.yaml');
    const l = await layout(d);
    const ack = l.nodes.get('ack')!, step = l.nodes.get('page2')!;
    expect(ack.h).toBeLessThan(2.5 * step.h);
  }, 30000);

  it('keeps a 24-node architecture orthogonal with few crossings', async () => {
    const d = stress('platform-24.yaml');
    const l = await layout(d);
    expect(crossings(l)).toBeLessThanOrEqual(10);
    for (const [id, e] of l.edges)
      for (let i = 1; i < e.points.length; i++) expect(vert(e.points[i - 1]!, e.points[i]!) || horiz(e.points[i - 1]!, e.points[i]!), id).toBe(true);
  }, 30000);
});

describe('decisions', () => {
  const stress = (name: string) => parseSpecText(fs.readFileSync(`test/fixtures/stress/${name}`, 'utf8')).diagram;
  const flows = () => [spec('refund-flow.yaml'), spec('deploy-flow.yaml'), stress('incident-flow.yaml')];
  const decisions = (d: ReturnType<typeof spec>) => d.nodes.filter((n) => kindDef(d.type, n.kind).shape === 'diamond');

  it('gives each branch its own point of the diamond', async () => {
    for (const d of flows()) {
      const l = await layout(d);
      for (const n of decisions(d)) {
        const starts = d.edges.filter((e) => e.from === n.id).map((e) => l.edges.get(e.id)!.points[0]!);
        const keys = new Set(starts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`));
        expect(keys.size, `${d.title}: ${n.id}`).toBe(starts.length);
      }
    }
  }, 30000);

  it('drops the middle branch straight down when its target is underneath', async () => {
    const d = parseSpecText('type: flow\ndirection: TB\nnodes:\n  q: { label: Ready?, kind: decision }\n  a: { label: Ship it }\n  b: { label: Hold }\nedges:\n  - q -> a: "yes"\n  - q -> b: "no"\n').diagram;
    const l = await layout(d);
    const q = l.nodes.get('q')!;
    const routes = ['a', 'b'].map((to) => l.edges.get(d.edges.find((e) => e.to === to)!.id)!.points);
    // Two targets side by side under one decision: one branch per side point, each an L.
    for (const r of routes) {
      expect(Math.abs(r[0]!.y - (q.y + q.h / 2))).toBeLessThan(1);
      expect(r).toHaveLength(3);
    }
    expect(routes[0]![0]!.x).not.toBe(routes[1]![0]!.x);
  });

  it('joins branches above a decision at one height, without a step', async () => {
    const d = stress('incident-flow.yaml');
    const l = await layout(d);
    for (const n of decisions(d)) {
      const b = l.nodes.get(n.id)!, cx = b.x + b.w / 2;
      const into = d.edges.filter((e) => e.to === n.id).map((e) => l.edges.get(e.id)!.points);
      const heights = new Set<number>();
      for (const p of into) {
        const m = p.length;
        // Every branch arrives at the top point.
        expect(Math.abs(p[m - 1]!.x - cx), n.id).toBeLessThan(1);
        expect(Math.abs(p[m - 1]!.y - b.y), n.id).toBeLessThan(1);
        // No run between two bends is a few px long: that is the kink.
        for (let i = 1; i < m - 2; i++) expect(Math.hypot(p[i + 1]!.x - p[i]!.x, p[i + 1]!.y - p[i]!.y), n.id).toBeGreaterThan(10);
        if (m >= 3 && horiz(p[m - 3]!, p[m - 2]!)) heights.add(Math.round(p[m - 2]!.y));
      }
      expect(heights.size, n.id).toBeLessThanOrEqual(1);
    }
  }, 30000);

  it('keeps a diamond flat, so a two-line question is not the biggest thing in the flow', async () => {
    const d = stress('incident-flow.yaml');
    const l = await layout(d);
    const ack = l.nodes.get('ack')!;
    expect(ack.h).toBeLessThan(0.45 * ack.w);
    // Still room for the text: two lines sit inside the middle of the diamond.
    expect(ack.h).toBeGreaterThanOrEqual(104);
    for (const n of decisions(d)) expect(l.nodes.get(n.id)!.h, n.id).toBeGreaterThanOrEqual(72);
  });

  describe('labels on a long run', () => {
    const label = { w: 100, h: 18 };
    const pts = [{ x: 500, y: 0 }, { x: 500, y: 600 }];
    const centre = (frac: number) => ((frac + 1) / 2) * 600;

    it('sit halfway when nothing is beside them', () => {
      expect(centre(labelSpot(pts, label, 'TB')!)).toBeCloseTo(300);
      expect(centre(labelSpot(pts, label, 'TB', [{ x: 0, y: 280, w: 100, h: 40 }])!)).toBeCloseTo(300);
    });

    it('slide clear of a box the edge only passes', () => {
      // A box whose side is 1px from where the label would sit: it would read as the box's caption.
      const box = { x: 300, y: 270, w: 149, h: 60 };
      const y = centre(labelSpot(pts, label, 'TB', [box])!);
      expect(Math.abs(y - 300)).toBeGreaterThanOrEqual(30 + 9 + 4);
      expect(Math.abs(y - 300)).toBeLessThanOrEqual(48);
    });

    it('stay put next to a box they are not level with', () => {
      // The box ends just above the label: nothing to mistake for a caption.
      expect(centre(labelSpot(pts, label, 'TB', [{ x: 300, y: 230, w: 149, h: 60 }])!)).toBeCloseTo(300);
    });

    it('stay halfway when the whole run is crowded', () => {
      expect(centre(labelSpot(pts, label, 'TB', [{ x: 300, y: 0, w: 149, h: 600 }])!)).toBeCloseTo(300);
    });
  });

  describe('branch labels', () => {
    const label = { w: 30, h: 18 };
    // Distance along the route from its start to the label's centre.
    const along = (pts: Point[], frac: number) => ((frac + 1) / 2) * pts.slice(1).reduce((t, p, i) => t + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);

    it('sit just below the diamond on a straight drop, however long the edge', () => {
      const pts = [{ x: 100, y: 100 }, { x: 100, y: 600 }];
      expect(along(pts, branchSpot(pts, label, 'TB')!)).toBeCloseTo(19);
    });

    it('sit on the run out of a side point when it has room', () => {
      const pts = [{ x: 200, y: 100 }, { x: 320, y: 100 }, { x: 320, y: 400 }];
      expect(along(pts, branchSpot(pts, label, 'TB')!)).toBeCloseTo(25);
    });

    it('sit at the top of the drop when the stub out of the side point is short', () => {
      const pts = [{ x: 200, y: 100 }, { x: 224, y: 100 }, { x: 224, y: 400 }];
      expect(along(pts, branchSpot(pts, label, 'TB')!)).toBeCloseTo(24 + 19);
    });

    it('start past a stem shared with a sibling branch', () => {
      const pts = [{ x: 100, y: 100 }, { x: 100, y: 300 }];
      expect(along(pts, branchSpot(pts, label, 'TB', 16)!)).toBeCloseTo(16 + 6 + 9);
    });

    it('follow the flow when it runs left to right', () => {
      const pts = [{ x: 100, y: 100 }, { x: 100, y: 76 }, { x: 400, y: 76 }];
      // The stub up out of the top point is too short; the label opens the run along the flow.
      expect(along(pts, branchSpot(pts, label, 'LR')!)).toBeCloseTo(24 + 25);
    });

    it('sit on a long arm that forks off the bottom point, not at the far drop', () => {
      const pts = [{ x: 300, y: 100 }, { x: 300, y: 116 }, { x: 60, y: 116 }, { x: 60, y: 300 }];
      expect(along(pts, branchSpot(pts, label, 'TB')!)).toBeCloseTo(16 + 25);
      // A short arm: the top of the drop is close enough, and reads better.
      const short = [{ x: 300, y: 100 }, { x: 300, y: 116 }, { x: 240, y: 116 }, { x: 240, y: 300 }];
      expect(along(short, branchSpot(short, label, 'TB')!)).toBeCloseTo(16 + 60 + 19);
    });

    it('give up when no run has room, so the usual placement takes over', () => {
      expect(branchSpot([{ x: 0, y: 0 }, { x: 0, y: 20 }], label, 'TB')).toBeUndefined();
    });
  });
});
