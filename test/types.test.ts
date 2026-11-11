// Class diagrams and timelines: the spec, the round trip through a built file,
// Mermaid, and Excalidraw. And `sync`, which keeps diagrams in step with YAML.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, importExcalidraw, show, specStamp } from '../src/api.js';
import { readDrawio } from '../src/drawio/read.js';
import { toYaml } from '../src/drawio/show.js';
import { toExcalidraw, type ExcalidrawElement } from '../src/excalidraw/export.js';
import { importMermaid } from '../src/import/mermaid.js';
import { DrawioBrowser } from '../src/render/browser.js';
import { dayOf, isoOf } from '../src/spec/model.js';
import { parseClassEdge, parseMember, parseSpecText, SpecError } from '../src/spec/parse.js';
import { findSpecs, sync } from '../src/sync.js';

const issues = (text: string) => {
  try {
    parseSpecText(text);
    return [];
  } catch (e) {
    return (e as SpecError).issues.map((i) => `${i.path}: ${i.message}`);
  }
};

describe('class diagram specs', () => {
  it('reads members with their visibility, arguments and types', () => {
    expect(parseMember('+ id: uuid')).toEqual({ name: '+id', type: 'uuid', flags: [] });
    expect(parseMember('- total(): Money')).toEqual({ name: '-total()', type: 'Money', flags: [] });
    expect(parseMember('# retry(times: int, wait: Duration): bool')).toEqual({ name: '#retry(times: int, wait: Duration)', type: 'bool', flags: [] });
    expect(parseMember('draft')).toEqual({ name: 'draft', type: undefined, flags: [] });
    expect(parseMember('  ')).toBeNull();
  });

  it('reads every relationship either way round, and puts the parent or owner first', () => {
    expect(parseClassEdge('Animal <|-- Duck')).toMatchObject({ from: 'Animal', to: 'Duck', rel: 'inherits' });
    expect(parseClassEdge('Duck --|> Animal')).toMatchObject({ from: 'Animal', to: 'Duck', rel: 'inherits' });
    expect(parseClassEdge('Card ..|> Payable: can pay')).toMatchObject({ from: 'Payable', to: 'Card', rel: 'implements', label: 'can pay' });
    expect(parseClassEdge('Order *-- Line')).toMatchObject({ from: 'Order', to: 'Line', rel: 'composition' });
    expect(parseClassEdge('Line --o Cart')).toMatchObject({ from: 'Cart', to: 'Line', rel: 'aggregation' });
    expect(parseClassEdge('A --> B')).toMatchObject({ from: 'A', to: 'B', rel: 'association' });
    expect(parseClassEdge('A <.. B')).toMatchObject({ from: 'B', to: 'A', rel: 'dependency' });
    expect(parseClassEdge('A -> B')).toBeNull();
  });

  it('parses the example, and writes it back as the same diagram', () => {
    const d = parseSpecText(fs.readFileSync('examples/billing-class.yaml', 'utf8')).diagram;
    expect(d.type).toBe('class');
    expect(d.nodes.find((n) => n.id === 'PaymentMethod')).toMatchObject({ kind: 'interface', fields: [{ name: '+charge(amount: Money)', type: 'Receipt' }, { name: '+refund(receipt: Receipt)', type: 'void' }] });
    expect(d.edges.map((e) => `${e.from} ${e.rel} ${e.to}`)).toEqual(['PaymentMethod implements Card', 'PaymentMethod implements BankTransfer', 'Invoice composition LineItem', 'Customer aggregation Invoice', 'Invoice dependency PaymentMethod', 'Invoice association InvoiceStatus']);
    expect(parseSpecText(toYaml(d)).diagram).toEqual(d);
    // Plain arrows still work beside the UML ones, and members are only for classes.
    expect(parseSpecText('type: class\nnodes: { A: {}, B: {} }\nedges:\n  - A -> B: uses\n  - { from: A, to: B, rel: inherits, color: red }').diagram.edges).toMatchObject([{ style: 'sync' }, { rel: 'inherits', color: 'red' }]);
    expect(issues('type: flow\nnodes:\n  a: { members: ["+ x: int"] }').join()).toMatch(/members for type: class/);
    expect(issues('type: class\nnodes:\n  A: { kind: service }').join()).toMatch(/Use one of: class, interface, abstract, enum/);
  });

  it('imports a Mermaid classDiagram', () => {
    const r = importMermaid(`classDiagram
      direction LR
      class Animal {
        <<abstract>>
        +String name
        +int age
        +eat(food) void
        #sleep()
      }
      class Duck
      class Shape <<interface>>
      Animal <|-- Duck
      Duck : +swim()
      Duck "1" *-- "many" Feather : has
      Duck ..> Pond
      Shape <|.. Circle
      Circle -- Point`);
    const d = r.diagram;
    expect(d.type).toBe('class');
    expect(d.direction).toBe('LR');
    expect(d.nodes.find((n) => n.id === 'Animal')).toMatchObject({ kind: 'abstract', fields: [{ name: '+name', type: 'String' }, { name: '+age', type: 'int' }, { name: '+eat(food)', type: 'void' }, { name: '#sleep()' }] });
    expect(d.nodes.find((n) => n.id === 'Shape')!.kind).toBe('interface');
    expect(d.nodes.find((n) => n.id === 'Duck')!.fields).toEqual([{ name: '+swim()', type: undefined, flags: [] }]);
    expect(d.edges.map((e) => [e.from, e.rel ?? e.style, e.to, e.label])).toEqual([
      ['Animal', 'inherits', 'Duck', undefined], ['Duck', 'composition', 'Feather', 'has 1 to many'], ['Duck', 'dependency', 'Pond', undefined], ['Shape', 'implements', 'Circle', undefined], ['Circle', 'line', 'Point', undefined],
    ]);
    expect(parseSpecText(toYaml(d)).diagram.edges.length).toBe(5);
  });
});

describe('timeline specs', () => {
  it('knows a date from something that only looks like one', () => {
    expect(isoOf(dayOf('2026-03-09')!)).toBe('2026-03-09');
    expect(dayOf('2026-02-30')).toBeUndefined();
    expect(dayOf('March 9')).toBeUndefined();
    expect(dayOf('2028-02-29')! - dayOf('2028-02-28')!).toBe(1);
  });

  it('parses tasks and milestones, and says what is wrong with a bad one', () => {
    const d = parseSpecText(fs.readFileSync('examples/launch-timeline.yaml', 'utf8')).diagram;
    expect(d.nodes.find((n) => n.id === 'api')).toMatchObject({ kind: 'task', start: '2026-01-12', end: '2026-02-13', parent: 'build' });
    expect(d.nodes.find((n) => n.id === 'ga')).toMatchObject({ kind: 'milestone', start: '2026-03-23' });
    expect(d.nodes.find((n) => n.id === 'ga')!.end).toBeUndefined();
    expect(parseSpecText(toYaml(d)).diagram).toEqual(d);
    expect(issues('type: timeline\nnodes:\n  a: { start: 2026-01-10, end: 2026-01-02 }').join()).toMatch(/ends \(2026-01-02\) before it starts/);
    expect(issues('type: timeline\nnodes:\n  a: { start: next week }').join()).toMatch(/isn't a date. Write dates as YYYY-MM-DD/);
    expect(issues('type: timeline\nnodes:\n  a: { label: A }').join()).toMatch(/a task needs dates/);
    expect(issues('type: timeline\nnodes:\n  a: { at: 2026-01-02 }\nedges:\n  - a -> a').join()).toMatch(/a timeline has no edges/);
    expect(issues('type: flow\nnodes:\n  a: { start: 2026-01-02 }').join()).toMatch(/start, end and at are for type: timeline/);
  });

  it('imports a Mermaid gantt chart: sections, durations, "after", milestones', () => {
    const r = importMermaid(`gantt
      title Release plan
      dateFormat YYYY-MM-DD
      section Build
      Design      :done, des1, 2026-01-05, 2026-01-12
      API         :active, api, after des1, 3w
      Hardening   :crit, 10d
      section Ship
      Freeze      :milestone, m1, 2026-02-16, 0d
      Rollout     :after m1, 2026-03-02`);
    expect(r.diagram.type).toBe('timeline');
    expect(r.diagram.title).toBe('Release plan');
    expect(r.diagram.groups.map((g) => g.label)).toEqual(['Build', 'Ship']);
    expect(r.diagram.nodes.map((n) => [n.label, n.kind, n.start, n.end, n.parent])).toEqual([
      ['Design', 'done', '2026-01-05', '2026-01-11', 'build'],
      ['API', 'task', '2026-01-12', '2026-02-01', 'build'],
      ['Hardening', 'risk', '2026-02-02', '2026-02-11', 'build'],
      ['Freeze', 'milestone', '2026-02-16', undefined, 'ship'],
      ['Rollout', 'task', '2026-02-16', '2026-03-01', 'ship'],
    ]);
    expect(r.diagram.nodes[1]!.highlight).toBe(true);
    expect(() => parseSpecText(toYaml(r.diagram))).not.toThrow();
  });
});

describe('finding specs to sync', () => {
  it('pairs each spec with its diagram and leaves other YAML alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-find-'));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.hidden'));
    fs.writeFileSync(path.join(dir, 'docs', 'arch.yaml'), 'type: architecture\nnodes: { a: {} }\n');
    fs.writeFileSync(path.join(dir, 'docs', 'plan.yml'), '# a plan\ntype: timeline\nnodes: {}\n');
    fs.writeFileSync(path.join(dir, 'docs', 'config.yaml'), 'type: module\nname: x\n');
    fs.writeFileSync(path.join(dir, 'docs', 'old.yaml'), 'whatever: 1\n');
    fs.writeFileSync(path.join(dir, 'docs', 'old.drawio.svg'), '<svg/>');
    fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'a.yaml'), 'type: flow\n');
    fs.writeFileSync(path.join(dir, '.hidden', 'a.yaml'), 'type: flow\n');
    const rel = (p: string) => path.relative(dir, p);
    expect(findSpecs([dir]).map((s) => [rel(s.spec), rel(s.out)])).toEqual([['docs/arch.yaml', 'docs/arch.drawio.svg'], ['docs/old.yaml', 'docs/old.drawio.svg'], ['docs/plan.yml', 'docs/plan.drawio.svg']]);
    // Named outright, a file is taken at its word.
    expect(findSpecs([path.join(dir, 'docs', 'config.yaml')]).length).toBe(1);
    expect(() => findSpecs([path.join(dir, 'nope')])).toThrow(/doesn't exist/);
  });

  it('stamps a spec by what it says, not how it is written', () => {
    const a = 'type: flow\nnodes:\n  a: Start\n  b: End\nedges:\n  - a -> b\n';
    expect(specStamp(a)).toBe(specStamp(`# a comment\n${a.replace('a: Start', 'a:   { label: Start }')}`));
    expect(specStamp(a)).not.toBe(specStamp(a.replace('End', 'Finish')));
  });
});

const run = process.env.LINEWORK_SKIP_E2E !== '1';

describe.runIf(run)('new diagram types, built', () => {
  let b: DrawioBrowser;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-types-'));
  beforeAll(async () => {
    b = await DrawioBrowser.launch();
  }, 60000);
  afterAll(async () => {
    await b?.close();
  });
  const errors = (r: { check: { findings: Array<{ level: string }> } }) => r.check.findings.filter((f) => f.level === 'error');

  it('builds a class diagram that reads back as its spec, parents above children', async () => {
    const out = path.join(tmp, 'class.drawio.svg');
    const src = fs.readFileSync('examples/billing-class.yaml', 'utf8');
    const res = await build(src, { out, browser: b });
    expect(errors(res)).toEqual([]);
    expect(res.check.findings.filter((f) => f.level === 'warning')).toEqual([]);
    expect(parseSpecText(show(out).yaml).diagram).toEqual(parseSpecText(src).diagram);
    const cells = new Map((await b.inspect(readDrawio(fs.readFileSync(out, 'utf8')).xml)).map((c) => [c.id, c]));
    expect(cells.get('PaymentMethod')!.box.y).toBeLessThan(cells.get('Card')!.box.y);
    expect(cells.get('Invoice')!.box.y).toBeLessThan(cells.get('LineItem')!.box.y);
    expect(cells.get('PaymentMethod')!.label).toBe('«interface» PaymentMethod');
    const m = readDrawio(fs.readFileSync(out, 'utf8'));
    expect(m.byId.get('e_PaymentMethod__Card')!.style).toMatchObject({ startArrow: 'block', startFill: '0', dashed: '1', endArrow: 'none' });
    expect(m.byId.get('e_Invoice__LineItem')!.style).toMatchObject({ startArrow: 'diamondThin', startFill: '1' });
    // A changed spec merges in, as for any other type.
    const again = await build(src.replace('      - "+ email: string"', '      - "+ email: string"\n      - "+ name: string"'), { out, browser: b });
    expect(again.mode).toBe('merge');
    expect(parseSpecText(show(out).yaml).diagram.nodes.find((n) => n.id === 'Customer')!.fields!.length).toBe(3);
  }, 120000);

  it('takes a class diagram to Excalidraw and back: UML arrowheads out, members and classes in', async () => {
    const out = path.join(tmp, 'class-x.drawio.svg');
    await build(fs.readFileSync('examples/billing-class.yaml', 'utf8'), { out, browser: b });
    const f = await toExcalidraw(readDrawio(fs.readFileSync(out, 'utf8')), b);
    const el = (id: string) => f.elements.find((e) => e.id === id)!;
    expect(el('lw-e_PaymentMethod__Card')).toMatchObject({ startArrowhead: 'triangle_outline', endArrowhead: null, strokeStyle: 'dashed' });
    expect(el('lw-e_Invoice__LineItem').startArrowhead).toBe('diamond');
    expect(el('lw-e_Customer__Invoice').startArrowhead).toBe('diamond_outline');
    const file = path.join(tmp, 'class-x.excalidraw');
    fs.writeFileSync(file, JSON.stringify(f));
    expect((await importExcalidraw(file, out, { browser: b })).changes).toEqual([]);
    const retype = (t: ExcalidrawElement, text: string) => Object.assign(t, { text, originalText: text });
    retype(el('lw-PaymentMethod-title'), '«interface» Payable');
    retype(el('lw-Customer__+email-type'), 'Email');
    const inv = el('lw-Invoice');
    f.elements.push({ id: 'm1', type: 'text', x: inv.x + 14, y: inv.y + inv.height + 4, width: 120, height: 20, groupIds: [], boundElements: [], isDeleted: false, text: '+ void(): void', originalText: '+ void(): void', containerId: null });
    fs.writeFileSync(file, JSON.stringify(f));
    const res = await importExcalidraw(file, out, { browser: b });
    const d = parseSpecText(show(out).yaml).diagram;
    expect(d.nodes.find((n) => n.id === 'PaymentMethod')).toMatchObject({ label: 'Payable', kind: 'interface' });
    expect(d.nodes.find((n) => n.id === 'Customer')!.fields![1]).toMatchObject({ name: '+email', type: 'Email' });
    expect(d.nodes.find((n) => n.id === 'Invoice')!.fields!.at(-1)).toMatchObject({ name: '+void()', type: 'void' });
    expect(d.edges.find((e) => e.id === 'PaymentMethod->Card')!.rel).toBe('implements');
    expect(res.changes.length).toBe(3);
    expect(errors(res)).toEqual([]);
  }, 120000);

  it('draws a timeline to scale: bars where their dates are, lanes around their tasks', async () => {
    const out = path.join(tmp, 'tl.drawio.svg');
    const src = fs.readFileSync('examples/launch-timeline.yaml', 'utf8');
    const res = await build(src, { out, browser: b });
    expect(res.check.findings).toEqual([]);
    expect(parseSpecText(show(out).yaml).diagram).toEqual(parseSpecText(src).diagram);
    const m = readDrawio(fs.readFileSync(out, 'utf8'));
    const ppd = Number(m.meta.aiviz_ppd);
    const cells = new Map((await b.inspect(m.xml)).map((c) => [c.id, c]));
    const box = (id: string) => cells.get(id)!.box;
    // Five weeks is 33 days from its first to its last; two bars a fortnight apart start 14 days apart.
    expect(box('api').w / ppd).toBeCloseTo(33, 0);
    expect((box('web').x - box('api').x) / ppd).toBeCloseTo(14, 0);
    expect(box('beta').x).toBeGreaterThan(box('freeze').x);
    for (const id of ['api', 'web', 'migrate', 'freeze']) {
      expect(box(id).y, id).toBeGreaterThan(box('build').y);
      expect(box(id).y + box(id).h, id).toBeLessThan(box('build').y + box('build').h);
    }
    expect(box('design').y).toBeLessThan(box('build').y);
    expect([...cells.values()].filter((c) => c.aivizType === 'tick').map((c) => c.label).slice(0, 3)).toEqual(['Jan 5', 'Jan 12', 'Jan 19']);
  }, 120000);

  it('reads a bar dragged along the axis as new dates, in draw.io or Excalidraw', async () => {
    const out = path.join(tmp, 'tl-move.drawio.svg');
    await build(fs.readFileSync('examples/launch-timeline.yaml', 'utf8'), { out, browser: b });
    const m = readDrawio(fs.readFileSync(out, 'utf8'));
    const ppd = Number(m.meta.aiviz_ppd);
    const f = await toExcalidraw(m, b);
    // A week later, and a week longer; the milestone a week earlier; the whole drawing somewhere else.
    for (const e of f.elements) {
      const cell = (e.customData as { lw: { cell: string } }).lw.cell;
      if (cell === 'beta') Object.assign(e, { x: e.x + 7 * ppd, ...(e.id === 'lw-beta' ? { width: e.width + 7 * ppd } : {}) });
      if (cell === 'ga') e.x -= 7 * ppd;
      Object.assign(e, { x: e.x + 500, y: e.y + 90 });
    }
    const bar = f.elements.find((e) => e.id === 'lw-cleanup')!;
    f.elements.push({ ...structuredClone(bar), id: 'new', x: bar.x, y: bar.y + 36, customData: undefined, boundElements: [{ id: 'new-t', type: 'text' }] } as unknown as ExcalidrawElement);
    f.elements.push({ id: 'new-t', type: 'text', x: bar.x, y: bar.y + 40, width: 60, height: 20, groupIds: [], boundElements: [], isDeleted: false, text: 'Retro', originalText: 'Retro', containerId: 'new' });
    const file = path.join(tmp, 'tl-move.excalidraw');
    fs.writeFileSync(file, JSON.stringify(f));
    const res = await importExcalidraw(file, out, { browser: b });
    expect(res.changes).toEqual(expect.arrayContaining(['"Beta (5% of traffic)" now runs 2026-03-16 to 2026-04-03', '"General availability" is now on 2026-03-16', 'added "Retro"']));
    const d = parseSpecText(show(out).yaml).diagram;
    expect(d.nodes.find((n) => n.id === 'retro')).toMatchObject({ kind: 'task', start: '2026-03-23', end: '2026-04-03', parent: 'rollout' });
    expect(d.nodes.find((n) => n.id === 'api')).toMatchObject({ start: '2026-01-12', end: '2026-02-13' });
    expect(res.check.findings).toEqual([]);
    expect((await importExcalidraw(file, out, { browser: b })).changes).toEqual([]);
  }, 120000);

  it('sync builds what is missing, rebuilds what changed, and --check only looks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-sync-'));
    const spec = path.join(dir, 'arch.yaml'), out = path.join(dir, 'arch.drawio.svg');
    fs.copyFileSync('examples/checkout.yaml', spec);
    fs.copyFileSync('examples/launch-timeline.yaml', path.join(dir, 'plan.yaml'));
    expect((await sync([dir], { check: true })).map((i) => [i.state, i.missing])).toEqual([['stale', true], ['stale', true]]);
    expect(fs.existsSync(out)).toBe(false);
    expect((await sync([dir], { browser: b })).map((i) => i.state)).toEqual(['built', 'built']);
    expect((await sync([dir], { check: true })).map((i) => i.state)).toEqual(['fresh', 'fresh']);
    const before = fs.readFileSync(out, 'utf8');
    // A comment is not a change. A new label is, and the layout stays.
    fs.appendFileSync(spec, '# reviewed\n');
    expect((await sync([dir], { browser: b })).map((i) => i.state)).toEqual(['fresh', 'fresh']);
    expect(fs.readFileSync(out, 'utf8')).toBe(before);
    fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('Shopper', 'Buyer'));
    expect((await sync([dir], { check: true })).map((i) => i.state)).toEqual(['stale', 'fresh']);
    const res = await sync([dir], { browser: b });
    expect(res.map((i) => i.state)).toEqual(['built', 'fresh']);
    expect(res[0]!.result!.mode).toBe('merge');
    expect(show(out).yaml).toContain('Buyer');
    fs.writeFileSync(path.join(dir, 'broken.yaml'), 'type: flow\nnodes:\n  a: { kind: nope }\n');
    const bad = await sync([dir], { check: true });
    expect(bad.find((i) => i.spec.endsWith('broken.yaml'))).toMatchObject({ state: 'failed', error: expect.stringMatching(/unknown kind/) });
  }, 180000);
});
