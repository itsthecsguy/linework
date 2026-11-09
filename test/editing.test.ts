// The editing workflow end to end: small spec changes, hand moves, one-line edits.
// Needs Chromium. Set LINEWORK_SKIP_E2E=1 to skip.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DrawioBrowser } from '../src/render/browser.js';
import { build, checkFile, show, tidy } from '../src/api.js';
import { absBox, readDrawio } from '../src/drawio/read.js';
import { toDiagram } from '../src/drawio/show.js';
import YAML from 'yaml';
import { patchFile, patchSpec, PatchError } from '../src/patch.js';

let browser: DrawioBrowser | undefined;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-edit-'));
beforeAll(async () => {
  if (process.env.LINEWORK_SKIP_E2E !== '1') browser = await DrawioBrowser.launch();
}, 60000);
afterAll(async () => { await browser?.close(); });

const spec = fs.readFileSync('examples/checkout.yaml', 'utf8');

/** Spec id -> absolute box, for every node and group. */
function boxes(file: string) {
  const m = readDrawio(fs.readFileSync(file, 'utf8'));
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const [cellId, specId] of toDiagram(m).idMap) {
    const b = absBox(m, cellId);
    if (b) out.set(specId, b);
  }
  return out;
}
const moved = (a: ReturnType<typeof boxes>, b: ReturnType<typeof boxes>) =>
  [...a].filter(([id, box]) => b.has(id) && (Math.abs(b.get(id)!.x - box.x) > 1 || Math.abs(b.get(id)!.y - box.y) > 1)).map(([id]) => id);

/** Move a box the way dragging it in draw.io does: geometry changes, routes stay. */
function drag(file: string, id: string, dx: number, dy: number) {
  const s = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`(&lt;object id=&quot;${id}&quot;[\\s\\S]*?&lt;mxGeometry x=&quot;)(-?\\d+)(&quot; y=&quot;)(-?\\d+)`);
  expect(re.test(s)).toBe(true);
  fs.writeFileSync(file, s.replace(re, (_, a, x, b, y) => a + (+x + dx) + b + (+y + dy)));
}

async function fresh(name: string) {
  const out = path.join(tmp, name);
  await build(spec, { out, browser: browser! });
  return out;
}

describe.runIf(process.env.LINEWORK_SKIP_E2E !== '1')('small spec changes keep the layout', () => {
  it('rebuilding an unchanged spec changes nothing', async () => {
    const out = await fresh('same.drawio.svg');
    const before = fs.readFileSync(out, 'utf8');
    const res = await build(show(out).yaml, { out, browser: browser! });
    expect(res.mode).toBe('merge');
    expect(fs.readFileSync(out, 'utf8')).toBe(before);
  }, 60000);

  it('a renamed label moves no other box', async () => {
    const out = await fresh('rename.drawio.svg');
    const before = boxes(out);
    const res = await build(show(out).yaml.replace('label: Checkout API', 'label: Checkout and payments orchestration API'), { out, browser: browser! });
    expect(res.mode).toBe('merge');
    expect(res.merge!.grown).toContain('api');
    expect(moved(before, boxes(out)).filter((id) => id !== 'api')).toEqual([]);
    expect(res.check.findings).toEqual([]);
  }, 60000);

  it('removing a box closes its group up around the rest', async () => {
    const out = await fresh('remove.drawio.svg');
    const before = boxes(out);
    const yaml = show(out).yaml.replace(/^  cache: .*\n/m, '').replace('  - api -> cache: read session\n', '');
    const res = await build(yaml, { out, browser: browser! });
    const after = boxes(out);
    expect(res.merge!.shrunk).toContain('data');
    expect(after.get('data')!.w).toBeLessThan(before.get('data')!.w);
    expect(after.get('db')).toEqual(before.get('db'));
    expect(res.check.findings).toEqual([]);
  }, 60000);

  it('lays out again when the direction changes or the merge would tangle', async () => {
    const out = await fresh('dir.drawio.svg');
    const res = await build(show(out).yaml.replace('direction: auto', 'direction: LR'), { out, browser: browser! });
    expect(res.mode).toBe('fresh');
    expect(res.direction).toBe('LR');
  }, 60000);

  it('an untouched file is not marked as hand-arranged by a merge', async () => {
    const out = await fresh('mark.drawio.svg');
    await build(show(out).yaml.replace('label: Shopper', 'label: Customer'), { out, browser: browser! });
    expect(readDrawio(fs.readFileSync(out, 'utf8')).meta.aiviz_layout).toBeUndefined();
  }, 60000);
});

describe.runIf(process.env.LINEWORK_SKIP_E2E !== '1')('after a hand move', () => {
  it('tidy reroutes the edges left behind, keeps every box, and settles', async () => {
    const out = await fresh('tidy.drawio.svg');
    drag(out, 'stripe', 140, -560);
    const before = boxes(out);
    const res = await tidy(out, browser!);
    expect(res.fixed).toBeGreaterThan(0);
    expect(moved(before, boxes(out))).toEqual([]);
    expect(res.check.findings.filter((f) => f.level === 'error')).toEqual([]);
    expect(res.check.findings.filter((f) => /charge/.test(f.message))).toEqual([]);
    // The move is now part of the layout: a second run has nothing to do.
    const again = await tidy(out, browser!);
    expect(again.fixed).toBe(0);
    expect(again.labels).toBe(0);
  }, 60000);

  it('a new box does not stretch its group over boxes outside it', async () => {
    const out = await fresh('grow.drawio.svg');
    drag(out, 'stripe', 140, -560);
    const res = await patchFile(out, [{ op: 'add', args: ['fraud: { label: Fraud check, in: vpc }', 'api -> fraud: score'] }], { browser: browser! });
    expect(res.merge!.placed).toEqual(['fraud']);
    expect(res.check.findings.filter((f) => f.rule === 'in-other-group')).toEqual([]);
    const b = boxes(out), vpc = b.get('vpc')!, stripe = b.get('stripe')!;
    const apart = stripe.x >= vpc.x + vpc.w || stripe.x + stripe.w <= vpc.x || stripe.y >= vpc.y + vpc.h || stripe.y + stripe.h <= vpc.y;
    expect(apart).toBe(true);
  }, 60000);

  it('check flags a box dragged into a group it is not in', async () => {
    const out = await fresh('foreign.drawio.svg');
    const b = boxes(out);
    drag(out, 'stripe', Math.round(b.get('gw')!.x - 180 - b.get('stripe')!.x), Math.round(b.get('gw')!.y - b.get('stripe')!.y));
    const res = await checkFile(out, browser!);
    expect(res.findings.some((f) => f.rule === 'in-other-group' && /Stripe/.test(f.message))).toBe(true);
  }, 60000);
});

describe('one-line edits', () => {
  const yaml = 'type: architecture\ngroups:\n  vpc: { label: VPC }\nnodes:\n  api: { label: API, in: vpc }\n  db: { kind: database, in: vpc }\n  ext: Stripe\nedges:\n  - api -> db: SQL\n  - api ==> ext\n';
  const parsed = (s: string) => JSON.parse(JSON.stringify(YAML.parse(s)));

  it('sets and clears fields', () => {
    const out = parsed(patchSpec(yaml, [{ op: 'set', args: ['api.label=Checkout API: v2', 'api.highlight=true', 'db.kind=', 'ext.tech=Payments', 'theme=dark'] }]));
    expect(out.nodes.api).toEqual({ label: 'Checkout API: v2', in: 'vpc', highlight: true });
    expect(out.nodes.db).toEqual({ in: 'vpc' });
    expect(out.nodes.ext).toEqual({ label: 'Stripe', tech: 'Payments' });
    expect(out.theme).toBe('dark');
  });

  it('adds boxes, groups and edges', () => {
    const out = parsed(patchSpec(yaml, [{ op: 'add', args: ['group data: { label: Data, in: vpc }', 'cache: { kind: cache, in: data }', 'audit', 'api -> cache: read'] }]));
    expect(out.groups.data).toEqual({ label: 'Data', in: 'vpc' });
    expect(out.nodes.cache).toEqual({ kind: 'cache', in: 'data' });
    expect(out.nodes.audit).toEqual({});
    expect(out.edges.at(-1)).toBe('api -> cache: read');
  });

  it('removes a box with its edges, an edge, and a group without its members', () => {
    const out = parsed(patchSpec(yaml, [{ op: 'rm', args: ['db', 'api ==> ext', 'vpc'] }]));
    expect(Object.keys(out.nodes)).toEqual(['api', 'ext']);
    expect(out.edges).toEqual([]);
    expect(out.groups).toBeUndefined();
    expect(out.nodes.api).toEqual({ label: 'API' });
  });

  it('says what exists when a name is wrong', () => {
    expect(() => patchSpec(yaml, [{ op: 'set', args: ['nope.label=x'] }])).toThrow(PatchError);
    expect(() => patchSpec(yaml, [{ op: 'set', args: ['nope.label=x'] }])).toThrow(/api, db, ext, vpc/);
    expect(() => patchSpec(yaml, [{ op: 'rm', args: ['db -> api'] }])).toThrow(/no edge/);
    expect(() => patchSpec(yaml, [{ op: 'add', args: ['api: {}'] }])).toThrow(/already exists/);
  });

  it('keeps the base line show stamps', () => {
    expect(patchSpec('# linework-base: abc123  (keep this line)\n' + yaml, [{ op: 'set', args: ['title=Checkout'] }])).toMatch(/^# linework-base: abc123/);
  });
});
