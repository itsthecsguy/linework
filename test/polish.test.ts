import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseSpecText } from '../src/spec/parse.js';
import { crossings, keyRows, layout, singular, type Box, type Point } from '../src/layout/layout.js';
import { simplify } from '../src/layout/polish.js';

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
