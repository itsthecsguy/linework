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

  it('ships the same examples in the skill', () => {
    const shipped = fs.readdirSync('skills/linework/examples').sort();
    expect(shipped).toEqual(fs.readdirSync('examples').sort());
    for (const f of shipped) expect(fs.readFileSync(`skills/linework/examples/${f}`, 'utf8'), f).toBe(fs.readFileSync(`examples/${f}`, 'utf8'));
  });

  it('keeps the guide an agent loads on every diagram small', () => {
    expect(fs.statSync('skills/linework/SKILL.md').size).toBeLessThan(8500);
  });

  it('keeps the skill header within the Agent Skills limits', () => {
    const fm = fs.readFileSync('skills/linework/SKILL.md', 'utf8').split('---\n')[1]!;
    expect(fm).toMatch(/^name: linework$/m);
    expect(fm.match(/^description: (.*)$/m)![1]!.length).toBeLessThanOrEqual(1024);
    expect(fm.match(/^compatibility: (.*)$/m)![1]!.length).toBeLessThanOrEqual(500);
  });

  it('parses the snippets in the skill guide and its spec reference', () => {
    const md = fs.readFileSync('skills/linework/SKILL.md', 'utf8') + fs.readFileSync('skills/linework/references/spec.md', 'utf8');
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

  it('collects accent errors alongside other spec issues', () => {
    const out = errs('type: flow\naccent: notacolor\nnodes: { a: { kind: nope } }\n');
    expect(out).toMatch(/nodes\.a\.kind: unknown kind/);
    expect(out).toMatch(/accent: accent is a color name/);
  });

  it('rejects unknown keys on sequence frames and branches, and allows status on messages', () => {
    expect(errs('type: sequence\nparticipants: { a: {}, b: {} }\nmessages:\n  - alt:\n      - when: ok\n        messages: []\n        do: []\n')).toMatch(/unknown key\(s\) "messages"\. Allowed here: when, do\./);
    expect(errs('type: sequence\nparticipants: { a: {}, b: {} }\nmessages:\n  - opt: ok\n    extra: 1\n    do: []\n')).toMatch(/unknown key\(s\) "extra"\. Allowed here: opt, do\./);
    expect(errs('type: sequence\nparticipants: { a: {}, b: {} }\nmessages:\n  - { from: a, to: b, status: beta }\n')).toMatch(/messages\[0\]\.status: status needs a "statuses:" section/);
    expect(errs('type: flow\ngroups: { g: { extra: 1 } }\nnodes: { a: {} }\n')).toMatch(/Allowed here: label, in, color, status, highlight\./);
  });

  it('rejects nested timeline groups', () => {
    expect(errs('type: timeline\ngroups: { a: {}, b: { in: a } }\nnodes:\n  t: { start: 2026-01-01, end: 2026-01-05, in: b }\n')).toMatch(/groups\.b\.in: timeline lanes cannot be nested/);
  });

  it('suggests fixes for mistyped kinds, colors, themes and common key aliases', () => {
    expect(errs('type: architecture\nnodes: { a: { kind: databse } }')).toContain('Did you mean "database"?');
    expect(errs('type: sequence\nparticipants: { a: { kind: servce } }\nmessages: []')).toContain('Did you mean "service"?');
    expect(errs('type: flow\nnodes: { a: { color: grey } }')).toContain('Did you mean "gray"?');
    expect(errs('type: flow\nnodes: { a: { color: purple } }')).toContain('Did you mean "violet"?');
    expect(errs('type: flow\ntheme: drak\nnodes: { a: A }')).toContain('Did you mean "dark"?');
    expect(errs('type: architecture\nnodes: { a: { name: API, group: vpc, type: service, subtitle: Go } }')).toContain('Did you mean "label" / "in" / "kind" / "tech"?');
    expect(errs('type: flow\nnodes: { a: A, b: B }\nedges:\n  - { from: a, to: b, source: a }')).toContain('Did you mean "from"?');
    expect(errs('type: sequence\nparticipants: { a: {}, b: {} }\nmessages:\n  - alt:\n      - condition: ok\n        steps: []\n        do: []\n')).toContain('Did you mean "when" / "do"?');
  });

  it('gives actionable hints for YAML quoting traps, --> arrows, and null entries', () => {
    expect(errs('type: state\nnodes: { idle: {} }\nedges:\n  - [*] -> idle\n')).toMatch(/quote state edges containing \[\*\]/);
    expect(errs('type: flow\nnodes: { a: A, b: B }\nedges:\n  - a -> b: auth: ok\n')).toMatch(/quote edge lines whose label contains ": "/);
    expect(errs('type: flow\nnodes: { a: A, b: B }\nedges:\n  - a --> b: next\n')).toMatch(/use "->" \(call\) or "-\.->" \(async\)/);
    expect(errs('type: architecture\nnodes:\n  stripe:\n')).toContain('write "stripe: {}" or "stripe: Label"');
    expect(errs('type: architecture\ngroups:\n  vpc:\nnodes: { a: A }\n')).toContain('write "vpc: {}" or "vpc: Label"');
  });

  it('rejects disallowed fields on sequence participants and rel on non-class edges', () => {
    const seqOut = errs('type: sequence\nparticipants:\n  a: { in: vpc, icon: aws.lambda, members: ["+ x"], start: 2026-01-01 }\nmessages: []\n');
    expect(seqOut).toContain('participants.a.in:');
    expect(seqOut).toContain('participants.a.icon:');
    expect(seqOut).toContain('participants.a.members:');
    expect(seqOut).toContain('participants.a.start:');
    expect(errs('type: flow\nnodes: { a: A, b: B }\nedges:\n  - { from: a, to: b, rel: inherits }\n')).toMatch(/edges\[0\]\.rel: rel \("inherits"\) is only for type: class/);
  });
});
