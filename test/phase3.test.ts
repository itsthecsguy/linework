import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseSpecText, SpecError } from '../src/spec/parse.js';
import { estimateMeasure, layout } from '../src/layout/layout.js';
import { sequenceScene } from '../src/layout/sequence.js';
import { readDrawio, absBox } from '../src/drawio/read.js';
import { toDiagram, toYaml } from '../src/drawio/show.js';
import { merge } from '../src/drawio/merge.js';
import { serialize, toMxfile } from '../src/drawio/write.js';
import { importMermaid, mermaidBlocks } from '../src/import/mermaid.js';
import { resolveIcon } from '../src/drawio/icons.js';

const errs = (y: string) => {
  try { parseSpecText(y); } catch (e) { if (e instanceof SpecError) return e.message; throw e; }
  throw new Error('expected SpecError');
};
const plain = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe('sequence spec', () => {
  it('parses messages, notes and nested frames', () => {
    const { diagram } = parseSpecText(`
type: sequence
participants: { a: {}, b: { kind: database } }
messages:
  - a -> b: query
  - b --> a: rows
  - a -.-> b: fire and forget
  - note right of b: cached
  - loop: every 5s
    do:
      - a -> b: poll
      - alt:
          - when: changed
            do: [ "b --> a: diff" ]
          - when: same
            do: []
`);
    expect(diagram.seq!.map((i) => i.kind)).toEqual(['msg', 'msg', 'msg', 'note', 'frame']);
    const loop = diagram.seq![4] as Extract<(typeof diagram.seq)[number], { kind: 'frame' }>;
    expect(loop.op).toBe('loop');
    expect(loop.branches[0]!.when).toBe('every 5s');
    expect((loop.branches[0]!.items[1] as { op: string }).op).toBe('alt');
  });

  it('gives useful errors', () => {
    expect(errs('type: sequence\nparticipants: { a: {} }\nmessages: [a -> c]')).toMatch(/participant "c" doesn't exist/);
    expect(errs('type: sequence\nparticipants: { a: {} }\nnodes: { x: {} }\nmessages: []')).toMatch(/uses participants and messages, not nodes/);
    expect(errs('type: sequence\nparticipants: { a: {} }\nmessages: [{ loop: x }]')).toMatch(/loop needs do/);
    expect(errs('type: architecture\nnodes: { a: {} }\nmessages: []')).toMatch(/participants and messages are for type: sequence/);
  });

  it('round-trips frames and notes through draw.io', async () => {
    const { diagram } = parseSpecText(fs.readFileSync('examples/pay-sequence.yaml', 'utf8'));
    const back = toDiagram(readDrawio(serialize(await sequenceScene(diagram, estimateMeasure))));
    expect(plain(back.diagram.seq)).toEqual(plain(diagram.seq));
  });

  it('reads message order from vertical position, so dragging a message reorders it', async () => {
    const { diagram } = parseSpecText('type: sequence\nparticipants: { a: {}, b: {} }\nmessages: ["a -> b: first", "a -> b: second"]');
    let xml = serialize(await sequenceScene(diagram, estimateMeasure));
    // swap the two rows' y fractions
    const ys = [...xml.matchAll(/exitY=([\d.]+);/g)].map((m) => m[1]!);
    xml = xml.replace(`exitY=${ys[0]};`, 'exitY=TMP;').replace(`exitY=${ys[1]};`, `exitY=${ys[0]};`).replace('exitY=TMP;', `exitY=${ys[1]};`);
    const labels = toDiagram(readDrawio(xml)).diagram.seq!.map((i) => (i as { label?: string }).label);
    expect(labels).toEqual(['second', 'first']);
  });

  it('keeps hand-placed lifeline columns on rebuild', async () => {
    const { diagram } = parseSpecText(fs.readFileSync('examples/pay-sequence.yaml', 'utf8'));
    const scene = await sequenceScene(diagram, estimateMeasure, { keepX: new Map([['stripe', { x: 2000, w: 128 }]]) });
    expect(scene.vertices.find((v) => v.id === 'stripe')!.box.x).toBe(2000);
    expect(scene.vertices.find((v) => v.id === 'db')!.box.x).toBeGreaterThan(2000);
  });
});

describe('ER', () => {
  it('parses fields in every form, including a field called "name"', () => {
    const { diagram } = parseSpecText(`
type: er
nodes:
  t:
    fields:
      - id: uuid pk
      - name: text
      - "email text unique"
      - { name: org_id, type: uuid, flags: [FK] }
      - deleted_at
`);
    expect(diagram.nodes[0]!.fields).toEqual([
      { name: 'id', type: 'uuid', flags: ['pk'] },
      { name: 'name', type: 'text', flags: [] },
      { name: 'email', type: 'text', flags: ['unique'] },
      { name: 'org_id', type: 'uuid', flags: ['fk'] },
      { name: 'deleted_at', type: undefined, flags: [] },
    ]);
  });

  it("reads crow's-foot cardinality and explains mistakes", () => {
    const { diagram } = parseSpecText('type: er\nnodes: { a: {}, b: {} }\nedges: ["a }o..|| b: refs", "a ||--|{ b"]');
    expect(diagram.edges.map((e) => e.card)).toEqual([
      { from: 'many', to: 'one', identifying: false },
      { from: 'one', to: 'one_or_many', identifying: true },
    ]);
    expect(errs('type: er\nnodes: { a: {}, b: {} }\nedges: [a -> b]')).toMatch(/crow's-foot/);
    expect(errs('type: flow\nnodes: { a: { fields: [x] } }')).toMatch(/fields are for type: er/);
  });

  it('round-trips fields and cardinality', async () => {
    const { diagram } = parseSpecText(fs.readFileSync('examples/billing-er.yaml', 'utf8'));
    const back = toDiagram(readDrawio(toMxfile(diagram, await layout(diagram))));
    expect(plain(back.diagram)).toEqual(plain(diagram));
  });

  it('a field added later grows the table in place', async () => {
    const { diagram } = parseSpecText(fs.readFileSync('examples/billing-er.yaml', 'utf8'));
    const old = readDrawio(toMxfile(diagram, await layout(diagram)).replace('aiviz_type="er"', 'aiviz_type="er" aiviz_layout="manual"'));
    const next = parseSpecText(fs.readFileSync('examples/billing-er.yaml', 'utf8').replace('      - status: text', '      - status: text\n      - trial_ends_at: timestamptz null')).diagram;
    const out = readDrawio(serialize(merge(next, old, await layout(next)).scene));
    const before = absBox(old, 'subscriptions')!, after = absBox(out, 'subscriptions')!;
    expect([after.x, after.y]).toEqual([before.x, before.y]);
    expect(after.h).toBeGreaterThan(before.h);
    expect(toDiagram(out).diagram.nodes.find((n) => n.id === 'subscriptions')!.fields!.at(-1)!.name).toBe('trial_ends_at');
  });
});

describe('themes', () => {
  it('a theme change restyles everything and keeps positions', async () => {
    const { diagram } = parseSpecText(fs.readFileSync('examples/checkout.yaml', 'utf8'));
    const old = readDrawio(toMxfile(diagram, await layout(diagram)));
    const dark = parseSpecText(fs.readFileSync('examples/checkout.yaml', 'utf8').replace('title: Checkout', 'title: Checkout\ntheme: dark')).diagram;
    const out = readDrawio(serialize(merge(dark, old, await layout(dark)).scene));
    expect(absBox(out, 'api')).toEqual(absBox(old, 'api'));
    expect(out.byId.get('gw')!.style.fillColor).toBe('#212830');
    expect(out.byId.get('api')!.style.fillColor).toBe('#2B50F5'); // highlighted
    expect(out.meta.aiviz_theme).toBe('dark');
    expect(toDiagram(out).diagram.theme).toBe('dark');
    expect(/background="#0D1117"/.test(out.xml)).toBe(true);
  });

  it('c4 labels carry the element type', async () => {
    const d = parseSpecText('type: architecture\ntheme: c4\nnodes: { api: { tech: Go }, s: { kind: external } }').diagram;
    const xml = toMxfile(d, await layout(d));
    expect(xml).toContain('[Container: Go]');
    expect(xml).toContain('[External system]');
    // and show still reads the plain label and tech back
    expect(toDiagram(readDrawio(xml)).diagram.nodes[0]!.label).toBe('Api');
  });
});

describe('icons', () => {
  it('resolves names and aliases', () => {
    expect((resolveIcon('aws.msk') as { stencil: string }).stencil).toBe('mxgraph.aws4.managed_streaming_for_kafka');
    expect((resolveIcon('gcp.pubsub') as { stencil: string }).stencil).toBe('mxgraph.gcp2.cloud_pubsub');
    expect((resolveIcon('k8s.deployment') as { style: string }).style).toContain('prIcon=deploy');
    expect('error' in resolveIcon('lambda')).toBe(true);
    expect(errs('type: architecture\nnodes: { a: { icon: lambda } }')).toMatch(/should look like aws.lambda/);
  });
});

describe('mermaid import', () => {
  const imp = (f: string) => importMermaid(fs.readFileSync(`test/fixtures/mermaid/${f}`, 'utf8'));

  it('flowchart with subgraphs becomes architecture with groups, tech lines and kinds', () => {
    const { diagram } = imp('checkout.mmd');
    expect(diagram.type).toBe('architecture');
    const byId = Object.fromEntries(diagram.nodes.map((n) => [n.id, n]));
    expect(byId.web).toMatchObject({ label: 'Web app', tech: 'Next.js', kind: 'client' });
    expect(byId.db).toMatchObject({ kind: 'database', parent: 'data' });
    expect(byId.gw!.parent).toBe('vpc'); // mentioned before its subgraph
    expect(diagram.edges.find((e) => e.id === 'api->queue')!.style).toBe('async');
  });

  it('flowchart with decisions becomes a flow, handling chains, & and every label syntax', () => {
    const { diagram, warnings } = imp('gnarly-flow.mmd');
    expect(diagram.type).toBe('flow');
    expect(diagram.direction).toBe('LR');
    expect(diagram.nodes.find((n) => n.id === 'C')!.kind).toBe('decision');
    expect(diagram.edges.map((e) => `${e.from}>${e.to}:${e.label ?? ''}`)).toEqual(['A>B:REST', 'B>C:', 'C>D:yes', 'C>E:no', 'D>F:', 'D>G:', 'G>H:']);
    expect(warnings.join()).toMatch(/styling directives/);
  });

  it('state, sequence and ER import and parse back', () => {
    for (const f of ['payment-state.mmd', 'pay-sequence.mmd', 'billing.mmd', 'refund-flow.mmd']) {
      const { diagram } = imp(f);
      const reparsed = parseSpecText(toYaml(diagram)).diagram;
      expect(plain(reparsed)).toEqual(plain(diagram));
    }
    const seq = imp('pay-sequence.mmd').diagram;
    expect(seq.nodes.find((n) => n.id === 'user')!.kind).toBe('person');
    expect(seq.seq!.some((i) => i.kind === 'frame' && i.op === 'alt' && i.branches.length === 2)).toBe(true);
    const er = imp('billing.mmd').diagram;
    expect(er.nodes.find((n) => n.id === 'user')!.fields).toContainEqual({ name: 'email', type: 'string', flags: ['unique'] });
  });

  it('finds mermaid blocks in markdown', () => {
    expect(mermaidBlocks('# Doc\n```mermaid\ngraph TD\nA-->B\n```\ntext\n```mermaid\nsequenceDiagram\n```\n').length).toBe(2);
  });

  it('rejects diagram types it does not support', () => {
    expect(() => importMermaid('pie\ntitle x')).toThrow(/unsupported Mermaid diagram "pie"/);
  });

  it('consumes inline :::className on flowchart nodes without dropping edges or target nodes', () => {
    const { diagram, warnings } = importMermaid(`flowchart LR
      A[API]:::primary --> B:::secondary & C[Worker]:::accent
      C:::accent -.-> D@{ shape: cyl, label: Orders DB }:::db
    `);
    expect(diagram.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(diagram.edges.map((e) => `${e.from}->${e.to}:${e.style}`)).toEqual(['A->B:sync', 'A->C:sync', 'C->D:async']);
    expect(warnings.join()).toMatch(/styling directives/);
    expect(plain(parseSpecText(toYaml(diagram)).diagram)).toEqual(plain(diagram));
  });

  it('extracts frontmatter title and in-body title lines across diagram types', () => {
    const fmFlow = importMermaid('---\ntitle: "Checkout Flow"\n---\nflowchart LR\n  A --> B\n').diagram;
    expect(fmFlow.title).toBe('Checkout Flow');
    expect(plain(parseSpecText(toYaml(fmFlow)).diagram)).toEqual(plain(fmFlow));

    const fmState = importMermaid('---\ntitle: Order Lifecycle\n---\nstateDiagram-v2\n  [*] --> Open\n').diagram;
    expect(fmState.title).toBe('Order Lifecycle');

    const seqTitle = importMermaid('sequenceDiagram\n  title: Card Payment\n  a->>b: pay\n').diagram;
    expect(seqTitle.title).toBe('Card Payment');
    expect(plain(parseSpecText(toYaml(seqTitle)).diagram)).toEqual(plain(seqTitle));

    const erTitle = importMermaid('erDiagram\n  title Billing Schema\n  USER ||--o{ ORDER : places\n').diagram;
    expect(erTitle.title).toBe('Billing Schema');
    expect(plain(parseSpecText(toYaml(erTitle)).diagram)).toEqual(plain(erTitle));

    const clsTitle = importMermaid('classDiagram\n  title Domain Model\n  class Order\n').diagram;
    expect(clsTitle.title).toBe('Domain Model');
    expect(plain(parseSpecText(toYaml(clsTitle)).diagram)).toEqual(plain(clsTitle));

    const stateTitleId = importMermaid('stateDiagram-v2\n  title --> body\n').diagram;
    expect(stateTitleId.title).toBeUndefined();
    expect(stateTitleId.edges).toHaveLength(1);
    expect(stateTitleId.edges[0]).toMatchObject({ from: 'title', to: 'body' });
  });

  it('splits sequence participant <br/> into label + tech, normalizes <br/> in messages/states, and handles create participant/actor', () => {
    const seq = importMermaid(`sequenceDiagram
      participant api as Checkout API<br/>Go
      create participant db as Orders<br/>Postgres
      create actor support as Support<br/>Tier 2
      api->>db: INSERT<br/>orders
      alt card<br/>declined
        db-->>support: alert<br />operator
      end
    `).diagram;
    expect(seq.nodes.find((n) => n.id === 'api')).toMatchObject({ label: 'Checkout API', tech: 'Go', kind: 'service' });
    expect(seq.nodes.find((n) => n.id === 'db')).toMatchObject({ label: 'Orders', tech: 'Postgres', kind: 'database' });
    expect(seq.nodes.find((n) => n.id === 'support')).toMatchObject({ label: 'Support', tech: 'Tier 2', kind: 'person' });
    expect(seq.seq![0]).toMatchObject({ kind: 'msg', label: 'INSERT orders' });
    const frame = seq.seq![1] as Extract<NonNullable<typeof seq.seq>[number], { kind: 'frame' }>;
    expect(frame.branches[0]!.when).toBe('card declined');
    expect(frame.branches[0]!.items[0]).toMatchObject({ kind: 'msg', label: 'alert operator' });
    expect(JSON.stringify(seq)).not.toContain('<br');
    expect(plain(parseSpecText(toYaml(seq)).diagram)).toEqual(plain(seq));

    const st = importMermaid(`stateDiagram-v2
      state "Waiting<br/>for payment" as wait
      state "In<br/>Review" as review {
        check : Run<br/>fraud check
      }
      wait --> review : submit<br/>order
    `).diagram;
    expect(st.nodes.find((n) => n.id === 'wait')!.label).toBe('Waiting for payment');
    expect(st.nodes.find((n) => n.id === 'check')!.label).toBe('Run fraud check');
    expect(st.groups.find((g) => g.id === 'review')!.label).toBe('In Review');
    expect(st.edges[0]!.label).toBe('submit order');
    expect(JSON.stringify(st)).not.toContain('<br');
    expect(plain(parseSpecText(toYaml(st)).diagram)).toEqual(plain(st));
  });

  it('captures ER display aliases and direction', () => {
    const er = importMermaid(`erDiagram
      direction LR
      ORG ||--o{ USER : employs
      USER["App User"] {
        uuid id PK
      }
      ORG["Organization"]
    `).diagram;
    expect(er.direction).toBe('LR');
    expect(er.nodes.find((n) => n.id === 'user')!.label).toBe('App User');
    expect(er.nodes.find((n) => n.id === 'org')!.label).toBe('Organization');
    expect(plain(parseSpecText(toYaml(er)).diagram)).toEqual(plain(er));
  });

  it('maps classDiagram namespaces (including nested) to groups', () => {
    const { diagram, warnings } = importMermaid(`classDiagram
      Order *-- LineItem
      namespace Domain {
        class Order {
          +id: string
        }
        namespace Sub {
          class LineItem
        }
      }
      namespace Billing {
        class Invoice
      }
    `);
    expect(warnings).toEqual([]);
    expect(diagram.groups).toEqual([
      { id: 'Domain', label: 'Domain' },
      { id: 'Sub', label: 'Sub', parent: 'Domain' },
      { id: 'Billing', label: 'Billing' },
    ]);
    expect(diagram.nodes.find((n) => n.id === 'Order')!.parent).toBe('Domain');
    expect(diagram.nodes.find((n) => n.id === 'LineItem')!.parent).toBe('Sub');
    expect(diagram.nodes.find((n) => n.id === 'Invoice')!.parent).toBe('Billing');
    expect(plain(parseSpecText(toYaml(diagram)).diagram)).toEqual(plain(diagram));
  });

  it('expands Mermaid v11 @{ shape: ... } parsing including lean-r, lean-l, in-out, circle, and unquoted labels', () => {
    const { diagram } = importMermaid(`flowchart LR
      S@{ shape: circle, label: Start } --> I@{ shape: lean-r, label: Input payload }
      I --> D@{ shape: diam, label: Valid? }
      D -->|yes| O@{ shape: lean-l, label: Output record }
      D -->|no| IO@{ shape: in-out, label: Error stream }
      O --> E@{ shape: circle, label: Done }
    `);
    expect(diagram.type).toBe('flow');
    const byId = Object.fromEntries(diagram.nodes.map((n) => [n.id, n]));
    expect(byId.S).toMatchObject({ label: 'Start', kind: 'terminal' });
    expect(byId.I).toMatchObject({ label: 'Input payload', kind: 'data' });
    expect(byId.D).toMatchObject({ label: 'Valid?', kind: 'decision' });
    expect(byId.O).toMatchObject({ label: 'Output record', kind: 'data' });
    expect(byId.IO).toMatchObject({ label: 'Error stream', kind: 'data' });
    expect(byId.E).toMatchObject({ label: 'Done', kind: 'terminal' });
    expect(plain(parseSpecText(toYaml(diagram)).diagram)).toEqual(plain(diagram));
  });
});

describe('activation bars across alt branches', () => {
  it('starts every branch from the calls open at the top of the frame', async () => {
    const { diagram } = parseSpecText(`type: sequence
participants: { svc: {}, cache: {}, db: {} }
messages:
  - svc -> cache: GET
  - alt:
      - when: hit
        do:
          - cache --> svc: value
      - when: miss
        do:
          - cache --> svc: nil
          - svc -> db: SELECT
          - db --> svc: row
`);
    const scene = await sequenceScene(diagram, estimateMeasure);
    const bars = scene.vertices.filter((v) => v.attrs.aiviz_type === 'bar');
    const cacheBars = bars.filter((b) => b.parent.includes('cache'));
    expect(cacheBars).toHaveLength(1);
    // both replies leave from that one bar
    const replies = scene.edges.filter((e) => e.attrs.aiviz_msg === 'reply' && e.source.includes('cache'));
    expect(replies.map((e) => e.source)).toEqual([cacheBars[0]!.id, cacheBars[0]!.id]);
  });
});
