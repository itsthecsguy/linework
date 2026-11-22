import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseSpecText } from '../src/spec/parse.js';
import { estimateMeasure, layout } from '../src/layout/layout.js';
import { sequenceScene } from '../src/layout/sequence.js';
import { timelineScene } from '../src/layout/timeline.js';
import { serialize, toMxfile } from '../src/drawio/write.js';
import { absBox, readDrawio } from '../src/drawio/read.js';
import { manualEdits, toDiagram, toYaml } from '../src/drawio/show.js';
import { deriveTheme, erEdgeStyle, groupStyle, palette, setCustomThemes } from '../src/drawio/theme.js';

const strip = (d: ReturnType<typeof parseSpecText>['diagram']) => JSON.parse(JSON.stringify(d));

describe('spec -> drawio -> spec', () => {
  for (const f of fs.readdirSync('examples')) {
    it(`round-trips ${f}`, async () => {
      const { diagram } = parseSpecText(fs.readFileSync(`examples/${f}`, 'utf8'));
      const xml = diagram.type === 'sequence' ? serialize(await sequenceScene(diagram, estimateMeasure)) : diagram.type === 'timeline' ? serialize(await timelineScene(diagram, estimateMeasure)) : toMxfile(diagram, await layout(diagram));
      const back = toDiagram(readDrawio(xml));
      expect(back.notes).toEqual([]);
      expect(strip(back.diagram)).toEqual(strip(diagram));
      // and the YAML that show prints parses back to the same thing
      expect(strip(parseSpecText(toYaml(back.diagram)).diagram)).toEqual(strip(diagram));
      expect(manualEdits(readDrawio(xml))).toEqual([]);
    });
  }
});

describe('reading hand-edited files', () => {
  const text = fs.readFileSync('test/fixtures/hand-edited.drawio.svg', 'utf8');

  it('inflates the compressed page draw.io writes on save', () => {
    const m = readDrawio(text);
    expect(m.cells.length).toBeGreaterThan(20);
    expect(m.xml).toContain('<mxGraphModel');
  });

  it('picks up renamed labels and hand-added shapes', () => {
    const { diagram } = toDiagram(readDrawio(text));
    expect(diagram.nodes.find((n) => n.id === 'db')?.label).toBe('Orders (primary)');
    expect(diagram.nodes.find((n) => n.id === 'audit_log')?.kind).toBe('database');
    expect(diagram.edges.find((e) => e.to === 'audit_log')?.label).toBe('append');
  });

  it('detects moved and added cells', () => {
    const edits = manualEdits(readDrawio(text));
    expect(edits).toContainEqual({ id: 'api', what: 'moved' });
    expect(edits.filter((e) => e.what === 'added').length).toBe(2);
  });
});

describe('YAML quoting', () => {
  it('quotes risky labels', () => {
    const y = toYaml({
      type: 'flow', direction: 'auto', theme: 'clean', groups: [],
      nodes: [{ id: 'a', label: 'Yes', kind: 'step' }, { id: 'b', label: 'x: y, z', kind: 'step' }],
      edges: [{ id: 'a->b', from: 'a', to: 'b', label: 'no', style: 'sync' }, { id: 'a->b#2', from: 'a', to: 'b', label: '#1', style: 'sync' }],
    });
    const { diagram } = parseSpecText(y);
    expect(diagram.nodes.map((n) => n.label)).toEqual(['Yes', 'x: y, z']);
    expect(diagram.edges.map((e) => e.label)).toEqual(['no', '#1']);
  });
});

describe('core pipeline regressions', () => {
  it('handles cyclic parent references in absBox without hanging', () => {
    const m = readDrawio(
      '<mxfile><diagram id="d" name="D"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
        '<mxCell id="a" vertex="1" parent="b"><mxGeometry x="10" y="20" width="40" height="30" as="geometry"/></mxCell>' +
        '<mxCell id="b" vertex="1" parent="a"><mxGeometry x="5" y="5" width="40" height="30" as="geometry"/></mxCell>' +
        '</root></mxGraphModel></diagram></mxfile>',
    );
    expect(absBox(m, 'a')).toEqual({ x: 15, y: 25, w: 40, h: 30 });
  });

  it('does not double-wrap c4 brackets for custom c4-based themes', async () => {
    setCustomThemes([deriveTheme('c4_corp', 'c4', { accent: 'red' })]);
    try {
      const { diagram } = parseSpecText('type: architecture\ntheme: c4_corp\nnodes:\n  api: { tech: Go }\n  user: { kind: person }\nedges:\n  - user -> api\n');
      const xml = toMxfile(diagram, await layout(diagram));
      const back = toDiagram(readDrawio(xml)).diagram;
      expect(back.nodes.find((n) => n.id === 'api')!.tech).toBe('Go');
      expect(back.nodes.find((n) => n.id === 'user')!.tech).toBeUndefined();
    } finally {
      setCustomThemes([]);
    }
  });

  it('styles outlined colored groups and blueprint highlights accurately, and passes labelBg to erEdgeStyle', () => {
    expect(groupStyle('sketch', { color: 'red' })).toContain('strokeColor=#DC2626;');
    expect(groupStyle('bold', { color: 'green' })).toContain('strokeColor=#15803D;');
    expect(palette({ theme: 'blueprint', accent: 'red' }).paint('neutral', true).fill).toBe('#B91C1C');
    expect(palette('blueprint').paint('green', true).fill).toBe('#15803D');
    expect(palette({ theme: 'blueprint', accent: 'red' }).edgePaint(undefined, true).stroke).toBe('#B91C1C');
    expect(erEdgeStyle({ from: 'one', to: 'many', identifying: true }, 'clean', {}, '#F5F5F7')).toContain('labelBackgroundColor=#F5F5F7;');
  });

  it('keeps sequence guards inside frames, widens for kept headers, and reserves room for left/right notes', async () => {
    const { diagram } = parseSpecText(
      'type: sequence\nparticipants: { a: {}, b: {} }\nmessages:\n  - note left of a: A wide left-side note\n  - note right of a: A note between\n  - alt:\n      - when: very long first branch condition text\n        do:\n          - a -> b: call\n      - when: second branch\n        do:\n          - b --> a: reply\n',
    );
    const scene = await sequenceScene(diagram, estimateMeasure, { keepX: new Map([['a', { x: 200, w: 300 }]]) });
    const a = scene.vertices.find((v) => v.id === 'a')!;
    const b = scene.vertices.find((v) => v.id === 'b')!;
    expect(b.box.x).toBeGreaterThanOrEqual(a.box.x + a.box.w + 24);
    const frame = scene.vertices.find((v) => v.attrs.aiviz_type === 'frame')!;
    const g0 = scene.vertices.find((v) => v.attrs.aiviz_guard === `${frame.id}:0`)!;
    const g1 = scene.vertices.find((v) => v.attrs.aiviz_guard === `${frame.id}:1`)!;
    expect(g0.box.x + g0.box.w).toBeLessThanOrEqual(frame.box.x + frame.box.w);
    expect(g1.box.x).toBeLessThan(g0.box.x);
    const back = toDiagram(readDrawio(serialize(scene)));
    expect(strip(back.diagram)).toEqual(strip(diagram));
    // Without keepX, a left-of-first-participant note keeps positive x.
    const fresh = await sequenceScene(diagram, estimateMeasure);
    const leftNote = fresh.vertices.find((v) => v.attrs.aiviz_note === 'left')!;
    expect(leftNote.box.x).toBeGreaterThanOrEqual(24);
  });

  it('avoids timeline internal cell ID collisions and preserves empty timeline lanes', async () => {
    const { diagram } = parseSpecText(
      'type: timeline\ngroups: { empty_lane: Empty, work: Work }\nnodes:\n  tick_0: { at: 2026-01-15 }\n  grid_0: { start: 2026-01-16, end: 2026-01-20 }\n  axis: { start: 2026-01-05, end: 2026-01-12, in: work }\n',
    );
    const scene = await timelineScene(diagram, estimateMeasure);
    const ids = scene.vertices.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    const back = toDiagram(readDrawio(serialize(scene)));
    expect(strip(back.diagram)).toEqual(strip(diagram));
  });
});
