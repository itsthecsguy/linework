import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseSpecText } from '../src/spec/parse.js';
import { estimateMeasure, layout } from '../src/layout/layout.js';
import { sequenceScene } from '../src/layout/sequence.js';
import { serialize, toMxfile } from '../src/drawio/write.js';
import { readDrawio } from '../src/drawio/read.js';
import { manualEdits, toDiagram, toYaml } from '../src/drawio/show.js';

const strip = (d: ReturnType<typeof parseSpecText>['diagram']) => JSON.parse(JSON.stringify(d));

describe('spec -> drawio -> spec', () => {
  for (const f of fs.readdirSync('examples')) {
    it(`round-trips ${f}`, async () => {
      const { diagram } = parseSpecText(fs.readFileSync(`examples/${f}`, 'utf8'));
      const xml = diagram.type === 'sequence' ? serialize(await sequenceScene(diagram, estimateMeasure)) : toMxfile(diagram, await layout(diagram));
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
