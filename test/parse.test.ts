import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseSpecText, SpecError } from '../src/spec/parse.js';

const errs = (yaml: string) => {
  try {
    parseSpecText(yaml);
  } catch (e) {
    if (e instanceof SpecError) return e.issues.map((i) => `${i.path}: ${i.message}`).join('\n');
    throw e;
  }
  throw new Error('expected a SpecError');
};

describe('parse', () => {
  it('parses every example', () => {
    for (const f of fs.readdirSync('examples')) {
      const { diagram } = parseSpecText(fs.readFileSync(`examples/${f}`, 'utf8'));
      expect(diagram.nodes.length).toBeGreaterThan(0);
    }
  });

  it('parses the snippets in SKILL.md', () => {
    const md = fs.readFileSync('skill/aiviz/SKILL.md', 'utf8');
    const blocks = [...md.matchAll(/```yaml\n(type:[\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const b of blocks) parseSpecText(b);
  });

  it('reads edge forms', () => {
    const { diagram } = parseSpecText(`
type: architecture
nodes: { a: {}, b: {}, order-events: {} }
edges:
  - a -> b
  - a -> b: HTTPS
  - a -.-> order-events: OrderPlaced
  - a <-> b
  - a -- b
  - "a -> b: SELECT: x"
  - { from: b, to: a, label: back }
`);
    expect(diagram.edges.map((e) => [e.id, e.style, e.label])).toEqual([
      ['a->b', 'sync', undefined],
      ['a->b#2', 'sync', 'HTTPS'],
      ['a->order-events', 'async', 'OrderPlaced'],
      ['a->b#3', 'bidir', undefined],
      ['a->b#4', 'line', undefined],
      ['a->b#5', 'sync', 'SELECT: x'],
      ['b->a', 'sync', 'back'],
    ]);
  });

  it('keeps yes/no and numbers as label text', () => {
    const { diagram } = parseSpecText(`
type: flow
nodes: { d: { kind: decision }, x: {}, y: {} }
edges:
  - d -> x: yes
  - d -> y: 404
`);
    expect(diagram.edges.map((e) => e.label)).toEqual(['yes', '404']);
  });

  it('defaults labels and kinds', () => {
    const { diagram } = parseSpecText('type: architecture\nnodes:\n  order_db: {}\n  api: Checkout API\n');
    expect(diagram.nodes).toEqual([
      { id: 'order_db', label: 'Order db', kind: 'service', tech: undefined, parent: undefined },
      { id: 'api', label: 'Checkout API', kind: 'service', tech: undefined, parent: undefined },
    ]);
  });

  it('turns [*] into start and per-source end nodes', () => {
    const { diagram } = parseSpecText(`
type: state
nodes: { a: {}, b: {} }
edges: ["[*] -> a", "a -> b", "a -> [*]", "b -> [*]"]
`);
    expect(diagram.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual(['_start:start', 'a:state', 'b:state', '_end_a:end', '_end_b:end']);
  });

  it('suggests close matches for unknown nodes', () => {
    expect(errs('type: architecture\nnodes: { api: {} }\nedges: [apii -> api]')).toMatch(/node "apii" doesn't exist. Did you mean "api"\?/);
  });

  it('lists valid kinds for the type', () => {
    expect(errs('type: flow\nnodes: { a: { kind: database } }')).toMatch(/unknown kind "database" for a flow diagram. Use one of: step, decision/);
  });

  it('explains arrows without spaces', () => {
    expect(errs('type: flow\nnodes: { a: {}, b: {} }\nedges: [a->b]')).toMatch(/spaces around the arrow/);
  });

  it('rejects unknown keys with the allowed list', () => {
    expect(errs('type: flow\nnodes: { a: { lable: A } }')).toMatch(/unknown key\(s\) "lable". Allowed here: label, kind, tech, in/);
    expect(errs('type: flow\nnode: {}')).toMatch(/nodes is required|unknown key/);
  });

  it('catches group problems', () => {
    expect(errs('type: architecture\ngroups: { a: { in: b }, b: { in: a } }\nnodes: { x: {} }')).toMatch(/cycle/);
    expect(errs('type: architecture\nnodes: { x: { in: vcp } }\ngroups: { vpc: {} }')).toMatch(/group "vcp" doesn't exist. Did you mean "vpc"/);
    expect(errs('type: architecture\ngroups: { g: {} }\nnodes: { x: {} }\nedges: [x -> g]')).toMatch(/is a group/);
  });

  it('only allows [*] in state diagrams', () => {
    expect(errs('type: flow\nnodes: { a: {} }\nedges: ["[*] -> a"]')).toMatch(/only for state diagrams/);
  });

  it('warns about unlabeled decision edges and big diagrams', () => {
    const { warnings } = parseSpecText('type: flow\nnodes: { d: { kind: decision }, a: {}, b: {} }\nedges: [d -> a, "d -> b: no"]');
    expect(warnings.map((w) => w.message).join()).toMatch(/label every edge leaving a decision/);
  });
});
