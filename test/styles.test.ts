// Styles, color and highlight: spec parsing, round trips, merge restyling, text
// wrapping, font embedding, and a real build in every style (needs Chromium).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpecText, SpecError } from '../src/spec/parse.js';
import { estimateMeasure, layout } from '../src/layout/layout.js';
import { TextMeasurer } from '../src/layout/text.js';
import { sequenceScene } from '../src/layout/sequence.js';
import { readDrawio } from '../src/drawio/read.js';
import { toDiagram, toYaml } from '../src/drawio/show.js';
import { merge } from '../src/drawio/merge.js';
import { serialize, toMxfile } from '../src/drawio/write.js';
import { importMermaid } from '../src/import/mermaid.js';
import { embedFonts, familiesIn } from '../src/render/fonts.js';
import { build } from '../src/api.js';
import { DrawioBrowser } from '../src/render/browser.js';
import { THEMES } from '../src/spec/model.js';
import { contrast } from '../src/drawio/icons.js';
import { runSpots } from '../src/lint/fixlabels.js';

const errs = (y: string) => {
  try {
    parseSpecText(y);
  } catch (e) {
    if (e instanceof SpecError) return e.message;
    throw e;
  }
  throw new Error('expected SpecError');
};

const SPEC = `
type: architecture
groups:
  vpc: { label: VPC, color: teal }
nodes:
  web: { label: Web, kind: client }
  api: { label: API, highlight: true, in: vpc }
  db: { label: DB, kind: database, color: green, in: vpc }
  dlq: { label: Dead letters, kind: queue }
edges:
  - web ==> api: HTTPS
  - api -> db: SQL
  - { from: api, to: dlq, label: on failure, style: async, color: red }
`;

describe('color and highlight in the spec', () => {
  it('parses color, highlight and the ==> arrow', () => {
    const { diagram } = parseSpecText(SPEC);
    expect(diagram.groups[0]).toMatchObject({ id: 'vpc', color: 'teal' });
    expect(diagram.nodes.find((n) => n.id === 'api')).toMatchObject({ highlight: true });
    expect(diagram.nodes.find((n) => n.id === 'db')).toMatchObject({ color: 'green' });
    expect(diagram.edges[0]).toMatchObject({ from: 'web', to: 'api', style: 'sync', highlight: true });
    expect(diagram.edges[2]).toMatchObject({ style: 'async', color: 'red' });
  });

  it('names the allowed colors when one is wrong', () => {
    expect(errs('type: flow\nnodes: { a: { color: chartreuse } }')).toMatch(/unknown color "chartreuse".*blue, violet/);
  });

  it('warns when so much is highlighted that nothing stands out', () => {
    const nodes = 'abcdefgh'.split('').map((c) => `  ${c}: { highlight: true }`).join('\n');
    const { warnings } = parseSpecText(`type: flow\nnodes:\n${nodes}\nedges:\n  - a -> b`);
    expect(warnings.some((w) => w.path === 'highlight')).toBe(true);
  });

  it('round-trips through show', async () => {
    const { diagram } = parseSpecText(SPEC);
    const yaml = toYaml(toDiagram(readDrawio(toMxfile(diagram, await layout(diagram)))).diagram);
    expect(yaml).toContain('vpc: { label: VPC, color: teal }');
    expect(yaml).toContain('highlight: true');
    expect(yaml).toContain('color: green');
    expect(yaml).toContain('- web ==> api: HTTPS');
    expect(yaml).toContain('- { from: api, to: dlq, label: on failure, style: async, color: red }');
    const again = parseSpecText(yaml).diagram;
    expect(again.edges.map((e) => [e.id, e.color, e.highlight])).toEqual(diagram.edges.map((e) => [e.id, e.color, e.highlight]));
  });

  it('sequence messages take ==> and round-trip', async () => {
    const { diagram } = parseSpecText('type: sequence\nparticipants: { a: {}, b: { highlight: true } }\nmessages:\n  - a ==> b: go\n  - b --> a: ok');
    expect(diagram.seq![0]).toMatchObject({ kind: 'msg', highlight: true, style: 'sync' });
    const scene = await sequenceScene(diagram, estimateMeasure);
    const yaml = toYaml(toDiagram(readDrawio(serialize(scene))).diagram);
    expect(yaml).toContain('- a ==> b: go');
    expect(yaml).toContain('b: { highlight: true }');
  });

  it('Mermaid thick links become highlights', () => {
    const r = importMermaid('flowchart LR\n  A ==> B\n  B --> C');
    expect(r.diagram.edges.map((e) => !!e.highlight)).toEqual([true, false]);
  });
});

describe('merge and looks', () => {
  it('restyles a node when its highlight changes, and drops it when removed', async () => {
    const { diagram } = parseSpecText(SPEC);
    const old = readDrawio(toMxfile(diagram, await layout(diagram)));
    const solid = old.byId.get('api')!.style.fillColor;
    const plain = parseSpecText(SPEC.replace(', highlight: true', '')).diagram;
    const out = readDrawio(serialize(merge(plain, old, await layout(plain)).scene));
    expect(out.byId.get('api')!.style.fillColor).not.toBe(solid);
    expect(out.byId.get('api')!.attrs.aiviz_highlight).toBeUndefined();
    expect(toDiagram(out).diagram.nodes.find((n) => n.id === 'api')!.highlight).toBeUndefined();
  });
});

describe('icons on dark fills', () => {
  const iconFill = async (theme: string, extra = '') => {
    const { diagram } = parseSpecText(`type: architecture\ntheme: ${theme}\nnodes:\n  u: { label: Users, kind: person, icon: aws.users${extra} }\n  l: { label: Fn, icon: aws.lambda }`);
    const m = readDrawio(toMxfile(diagram, await layout(diagram)));
    return [m.byId.get('u')!.style.fillColor!, m.byId.get('u__icon')!.style.fillColor!, m.byId.get('l__icon')!.style.fillColor!];
  };
  it('switches a glyph icon to a color that shows against its node', async () => {
    for (const [theme, extra] of [['clean', ''], ['dark', ''], ['blueprint', ''], ['c4', ''], ['clean', ', highlight: true']]) {
      const [node, glyph, tile] = await iconFill(theme!, extra);
      expect(contrast(node, glyph), `${theme}${extra}`).toBeGreaterThanOrEqual(3);
      expect(tile).toBe('#ED7100'); // tiled service icons keep their category color
    }
    expect((await iconFill('clean'))[1]).toBe('#232F3E');
  });
});

describe('the clean look', () => {
  it('draws groups as grounds, one step darker when nested, with sentence-case titles', async () => {
    const { diagram } = parseSpecText('type: architecture\ngroups:\n  vpc: Production VPC\n  data: { label: Data tier, in: vpc }\nnodes:\n  a: { in: data }\n  b: { in: vpc }\nedges:\n  - b -> a');
    const m = readDrawio(toMxfile(diagram, await layout(diagram)));
    const [vpc, data] = [m.byId.get('vpc')!, m.byId.get('data')!];
    expect(vpc.style.strokeColor).toBe('none');
    expect(vpc.style.fillColor).not.toBe(data.style.fillColor);
    expect(vpc.attrs.label).toBe('Production VPC');
  });

  it('reads sequence frames and notes back by attribute, not by shape', async () => {
    const spec = 'type: sequence\nparticipants: { a: {}, b: {} }\nmessages:\n  - alt:\n      - when: ok\n        do:\n          - a -> b: go\n  - note over a: careful';
    const scene = await sequenceScene(parseSpecText(spec).diagram, estimateMeasure);
    const yaml = toYaml(toDiagram(readDrawio(serialize(scene))).diagram);
    expect(yaml).toMatch(/alt:\s+- when: ok/);
    expect(yaml).toContain('note over a: careful');
  });

  it('puts a moved label mid-run on the longest straight stretch first', () => {
    // A short hop right, then a long run down: the first spot is halfway down the long run.
    const spots = runSpots([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 400 }], { w: 60, h: 16 });
    expect(spots[0]).toBeCloseTo(((40 + 200) / 440) * 2 - 1, 3);
    expect(spots.every((f) => f > ((40 + 18) / 440) * 2 - 1)).toBe(true); // never in the bend
  });
});

describe('text wrapping', () => {
  const tm = new TextMeasurer(async (reqs) => reqs.map(([t]) => t.length * 10));
  const f = { size: 14, weight: 400, family: 'x' };
  it('keeps short text on one line and wraps long text at word boundaries', async () => {
    await tm.prepare([['Queue for manual review', f]]);
    expect(tm.wrap('Queue for manual review', f, 1000).lines).toEqual(['Queue for manual review']);
    const w = tm.wrap('Queue for manual review', f, 120);
    expect(w.lines).toEqual(['Queue for', 'manual', 'review']);
    expect(w.width).toBeLessThanOrEqual(121);
  });

  it('gives a long label a taller box, not a wider one', async () => {
    const short = parseSpecText('type: flow\nnodes: { a: { label: Ship it } }').diagram;
    const long = parseSpecText('type: flow\nnodes: { a: { label: Reconcile the ledger against the payment processor settlement report } }').diagram;
    const [s, l] = [(await layout(short)).nodes.get('a')!, (await layout(long)).nodes.get('a')!];
    expect(l.h).toBeGreaterThan(s.h);
    expect(l.w).toBeLessThan(260);
  });
});

describe('fonts', () => {
  it('finds which bundled families an SVG uses', () => {
    expect(familiesIn('<div style="font-family: IBM Plex Sans, sans-serif">x</div><text font-family="Kalam, cursive">y</text>')).toEqual(['IBM Plex Sans', 'Kalam']);
    expect(familiesIn('<text font-family="Arial">y</text>')).toEqual([]);
  });

  it('embeds a small subset, once, even when run twice', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><defs/><text font-family="IBM Plex Sans, sans-serif">Checkout API</text></svg>';
    const once = await embedFonts(svg);
    const twice = await embedFonts(once);
    expect(once).toMatch(/<style id="aiviz-fonts"[^>]*>@font-face\{font-family:"IBM Plex Sans";font-weight:400/);
    expect(twice.match(/aiviz-fonts/g)!.length).toBe(1);
    expect(once.length - svg.length).toBeLessThan(20000); // a subset, not the 24KB face
  });
});

const run = process.env.AIVIZ_SKIP_E2E !== '1';

describe.runIf(run)('every style builds clean', () => {
  it('builds each example in each style with no lint findings and embedded fonts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiviz-styles-'));
    const b = await DrawioBrowser.launch();
    try {
      for (const name of ['checkout', 'pay-sequence', 'billing-er', 'refund-flow']) {
        const src = fs.readFileSync(`examples/${name}.yaml`, 'utf8');
        for (const theme of THEMES) {
          const out = path.join(tmp, `${name}-${theme}.drawio.svg`);
          const r = await build(src.replace(/^type:.*$/m, (m) => `${m}\ntheme: ${theme}`), { out, browser: b });
          expect(r.check.findings.map((f) => `${name}/${theme}: ${f.rule} ${f.message}`)).toEqual([]);
          const svg = fs.readFileSync(out, 'utf8');
          expect(svg).toContain('id="aiviz-fonts"');
          expect(svg).toContain(theme === 'sketch' ? 'font-family:"Kalam"' : theme === 'blueprint' ? 'font-family:"IBM Plex Mono"' : 'font-family:"IBM Plex Sans"');
        }
      }
    } finally {
      await b.close();
    }
  }, 300000);
});
