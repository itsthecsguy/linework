// Merge rules, without a browser (no rerouting; that's covered in e2e).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseSpecText } from '../src/spec/parse.js';
import { layout } from '../src/layout/layout.js';
import { absBox, readDrawio } from '../src/drawio/read.js';
import { manualEdits, toDiagram, toYaml } from '../src/drawio/show.js';
import { merge } from '../src/drawio/merge.js';
import { serialize, stampEdgeRoutes, toMxfile } from '../src/drawio/write.js';

const fixture = readDrawio(fs.readFileSync('test/fixtures/hand-edited.drawio.svg', 'utf8'));
// Add a free-floating text note, which the spec can't express.
const withNote = readDrawio(
  fixture.xml.replace('</root>', '<mxCell id="note1" value="TODO: confirm retention" style="text;html=1;" vertex="1" parent="1"><mxGeometry x="600" y="20" width="160" height="30" as="geometry"/></mxCell></root>'),
);

function edited() {
  let y = toYaml(toDiagram(withNote).diagram);
  y = y.replace('  email: { label: SendGrid, kind: external, tech: Email }\n', '').replace('  - worker -> email: receipt\n', '');
  y = y.replace('gw: { label: API gateway,', 'gw: { label: Edge gateway,');
  y = y.replace('  stripe: {', '  fraud: { label: Fraud check, tech: Python, in: vpc }\n  stripe: {');
  y = y.replace('  - api -> stripe: charge\n', '  - api -> fraud: score order\n  - fraud -> stripe: charge\n');
  return parseSpecText(y).diagram;
}

describe('merge', async () => {
  const d = edited();
  const res = merge(d, withNote, await layout(d));
  const out = readDrawio(serialize(res.scene));
  const box = (id: string) => absBox(out, id)!;
  const oldBox = (id: string) => absBox(withNote, id)!;

  it('keeps every existing node exactly where it was, including hand moves', () => {
    for (const id of ['api', 'db', 'cache', 'worker', 'queue', 'user', 'web', 'stripe']) expect(box(id)).toEqual(oldBox(id));
    // gw was renamed, so it may resize to fit the new text, around the same centre.
    const c = (b: { x: number; y: number; w: number; h: number }) => [b.x + b.w / 2, b.y + b.h / 2];
    expect(c(box('gw'))).toEqual(c(oldBox('gw')));
  });

  it('keeps hand-added shapes at their position, under a readable id', () => {
    const hand = withNote.cells.find((c) => c.label === 'Audit log')!;
    expect(box('audit_log')).toEqual(absBox(withNote, hand.id));
  });

  it('places new nodes without overlapping anything, inside their group', () => {
    const f = box('fraud');
    for (const c of out.cells.filter((c) => c.vertex && c.id !== 'fraud' && c.attrs.aiviz_type !== 'group' && !('text' in c.style))) {
      const o = absBox(out, c.id)!;
      const overlap = f.x < o.x + o.w && o.x < f.x + f.w && f.y < o.y + o.h && o.y < f.y + f.h;
      expect(overlap, `fraud overlaps ${c.id}`).toBe(false);
    }
    const vpc = box('vpc');
    expect(f.x >= vpc.x && f.y >= vpc.y && f.x + f.w <= vpc.x + vpc.w && f.y + f.h <= vpc.y + vpc.h).toBe(true);
    expect(res.stats.placed).toEqual(['fraud']);
  });

  it('grows groups to fit but never shrinks them', () => {
    expect(box('vpc').w).toBeGreaterThan(oldBox('vpc').w);
    expect(box('data')).toEqual(oldBox('data'));
  });

  it('removes deleted nodes and their edges', () => {
    expect(out.byId.has('email')).toBe(false);
    expect(out.cells.some((c) => c.edge && c.target === 'email')).toBe(false);
    expect(res.stats.removed).toEqual(['email']);
  });

  it('applies label changes and keeps hand-edited labels and restyles', () => {
    expect(out.byId.get('gw')!.label).toContain('Edge gateway');
    expect(out.byId.get('db')!.label).toBe('Orders (primary)');
    expect(out.byId.get('cache')!.styleRaw).toContain('FEF9C3');
  });

  it('themes hand-added shapes that were left in draw.io default style', () => {
    expect(out.byId.get('audit_log')!.style.fillColor).toBeDefined();
  });

  it('carries over cells the spec cannot express', () => {
    expect(out.byId.get('note1')?.label).toBe('TODO: confirm retention');
    expect(res.stats.carried).toBe(1);
  });

  it('reroutes new edges and stale routes next to hand-moved nodes, keeps the rest', () => {
    expect(res.reroute).toContain('e_api__fraud');
    expect(res.reroute).toContain('e_fraud__stripe');
    expect(res.reroute).toContain('e_api__db'); // api was moved by hand, route untouched since
    expect(res.reroute).not.toContain('e_user__web');
    const kept = out.cells.find((c) => c.id === 'e_user__web')!;
    expect(kept.geomRaw).toBe(withNote.cells.find((c) => c.attrs.aiviz_edge === 'user->web')!.geomRaw);
  });

  it('marks the file as hand-laid-out and absorbs the hand moves', () => {
    expect(out.meta.aiviz_layout).toBe('manual');
    expect(manualEdits(out)).toEqual([]);
  });

  it('round-trips through show', () => {
    expect(JSON.parse(JSON.stringify(toDiagram(out).diagram))).toEqual(JSON.parse(JSON.stringify(d)));
  });
});

describe('edge route stamps', () => {
  it('keeps a route a person adjusted', async () => {
    const d = parseSpecText(fs.readFileSync('examples/checkout.yaml', 'utf8')).diagram;
    let xml = stampEdgeRoutes(toMxfile(d, await layout(d)));
    // person moves api and hand-tunes the api->db route
    xml = xml
      .replace(/(<object id="api"[\s\S]*?<mxGeometry x=")(\d+)/, (_, a, x) => a + (+x + 40))
      .replace(/(<object id="e_api__db"[\s\S]*?<Array as="points">)/, '$1<mxPoint x="5" y="5"/>');
    const old = readDrawio(xml);
    const res = merge(d, old, await layout(d));
    expect(res.reroute).not.toContain('e_api__db');
    expect(res.reroute).toContain('e_api__cache');
  });
});

describe('stale specs', () => {
  it('keeps hand-added shapes a stale spec does not mention, deletes them when the spec is current', async () => {
    const spec = toYaml(toDiagram(fixture).diagram).replace('  audit_log: { kind: database }\n', '').replace('  - worker -> audit_log: append\n', '');
    const d = parseSpecText(spec).diagram;
    const l = await layout(d);
    const stale = merge(d, fixture, l, { specIsCurrent: false });
    expect(stale.stats.keptUnknown).toEqual(['audit_log']);
    expect(readDrawio(serialize(stale.scene)).cells.some((c) => c.label === 'Audit log')).toBe(true);
    const current = merge(d, fixture, l, { specIsCurrent: true });
    expect(current.stats.keptUnknown).toEqual([]);
    expect(readDrawio(serialize(current.scene)).cells.some((c) => c.label === 'Audit log')).toBe(false);
  });

  it('show stamps a fingerprint build can match', async () => {
    const { show } = await import('../src/api.js');
    const { fingerprint, specBase } = await import('../src/drawio/read.js');
    const text = show('test/fixtures/hand-edited.drawio.svg').yaml;
    expect(specBase(text)).toBe(fingerprint(fixture));
    expect(parseSpecText(text).diagram.nodes.length).toBe(11);
  });
});
