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
import { embedFonts, familiesIn, forgetSubsets } from '../src/render/fonts.js';
import { build } from '../src/api.js';
import { DrawioBrowser } from '../src/render/browser.js';
import { THEMES } from '../src/spec/model.js';
import { contrast, resolveIcon } from '../src/drawio/icons.js';
import { edgeStyle, groupStyle, paintFor, palette } from '../src/drawio/theme.js';
import { COLORS, normalAccent } from '../src/spec/model.js';
import { patchSpec } from '../src/patch.js';
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
    for (const [theme, extra] of [['clean', ''], ['dark', ''], ['midnight', ''], ['paper', ''], ['mono', ''], ['bold', ''], ['blueprint', ''], ['c4', ''], ['clean', ', highlight: true'], ['mono', ', highlight: true']]) {
      const [node, glyph, tile] = await iconFill(theme!, extra);
      expect(contrast(node, glyph), `${theme}${extra}`).toBeGreaterThanOrEqual(3);
      expect(tile).toBe('#ED7100'); // tiled service icons keep their category color
    }
    expect((await iconFill('clean'))[1]).toBe('#232F3E');
  });
});

const hex = (c: string) => /^#[0-9a-f]{6}$/i.test(c);
const styleOf = (s: string, key: string) => new RegExp(`(?:^|;)${key}=([^;]*)`).exec(s)?.[1];

describe('every style is legible', () => {
  it('keeps node text at 4.5:1 or better on its fill, in every color and when highlighted', () => {
    for (const theme of THEMES)
      for (const color of [undefined, ...COLORS])
        for (const highlight of [false, true]) {
          const t = palette(theme);
          const p = paintFor('architecture', 'service', theme, { color, highlight });
          const fill = hex(p.fill) ? p.fill : t.canvas;
          expect(contrast(p.text, fill), `${theme} ${color ?? 'plain'}${highlight ? ' highlighted' : ''}: ${p.text} on ${fill}`).toBeGreaterThanOrEqual(4.5);
        }
  });

  it('keeps edge lines at 3:1 and edge labels at 4.5:1 against the canvas', () => {
    for (const theme of THEMES)
      for (const color of [undefined, ...COLORS])
        for (const highlight of [false, true]) {
          const t = palette(theme);
          const p = t.edgePaint(color, highlight);
          expect(contrast(p.stroke, t.canvas), `${theme} ${color ?? 'plain'} line`).toBeGreaterThanOrEqual(3);
          expect(contrast(p.text, t.canvas), `${theme} ${color ?? 'plain'} label`).toBeGreaterThanOrEqual(4.5);
        }
  });
});

describe('the new styles', () => {
  const grayOnly = (c: string) => !hex(c) || (c.slice(1, 3) === c.slice(3, 5) && c.slice(3, 5) === c.slice(5, 7));
  it('mono uses no color at all, whatever the spec asks for', () => {
    for (const color of [undefined, ...COLORS])
      for (const highlight of [false, true]) {
        const p = paintFor('architecture', 'service', 'mono', { color, highlight });
        const e = palette('mono').edgePaint(color, highlight);
        for (const c of [p.fill, p.stroke, p.text, e.stroke, e.text]) expect(grayOnly(c), `${color} ${c}`).toBe(true);
      }
    // A highlight still stands out: solid black, and a heavier line.
    expect(paintFor('architecture', 'service', 'mono', { highlight: true }).fill).toBe('#111111');
    expect(palette('mono').edgePaint(undefined, true).width).toBeGreaterThan(palette('mono').edgePaint(undefined, false).width);
  });

  it('bold gives nodes a hard shadow and a heavy outline, and leaves edges and groups without one', () => {
    const node = paintFor('architecture', 'service', 'bold');
    expect(node.extra).toContain('shadow=1');
    expect(node.extra).toContain('shadowBlur=0');
    expect(node.strokeWidth).toBeGreaterThanOrEqual(2);
    expect(edgeStyle('sync', 'bold')).not.toContain('shadow=1');
    expect(groupStyle('bold')).not.toContain('shadow=1');
  });

  it('midnight and paper are their own grounds, not dark and clean recolored', () => {
    expect(palette('midnight').canvas).not.toBe(palette('dark').canvas);
    expect(contrast(palette('midnight').canvas, '#FFFFFF')).toBeGreaterThan(12);
    expect(palette('paper').canvas).not.toBe('#FFFFFF');
    expect(contrast(palette('paper').canvas, '#FFFFFF')).toBeLessThan(1.15);
  });

  it('colors a group in an outlined style by its line, never a fill', () => {
    for (const theme of ['mono', 'bold', 'sketch', 'blueprint'] as const) expect(styleOf(groupStyle(theme, { color: 'teal' }), 'fillColor'), theme).toBe('none');
    expect(styleOf(groupStyle('paper', { color: 'teal' }), 'fillColor')).not.toBe('none');
  });
});

describe('accent', () => {
  it('reads a color name or a hex color, and normalizes the hex', () => {
    expect(normalAccent('Teal')).toBe('teal');
    expect(normalAccent('#e11d48')).toBe('#E11D48');
    expect(normalAccent('e11d48')).toBe('#E11D48');
    expect(normalAccent('#f0a')).toBe('#FF00AA');
    expect(normalAccent('chartreuse')).toBeUndefined();
    expect(normalAccent('#12345')).toBeUndefined();
    expect(parseSpecText('type: flow\naccent: "#e11d48"\nnodes: { a: {} }').diagram.accent).toBe('#E11D48');
    expect(parseSpecText('type: sequence\naccent: green\nparticipants: { a: {}, b: {} }\nmessages:\n  - a -> b: go').diagram.accent).toBe('green');
    expect(parseSpecText('type: flow\nnodes: { a: {} }').diagram.accent).toBeUndefined();
  });

  it('explains a bad accent, and an unquoted hex that YAML ate as a comment', () => {
    expect(errs('type: flow\naccent: chartreuse\nnodes: { a: {} }')).toMatch(/accent is a color name.*got "chartreuse"/);
    expect(errs('type: flow\naccent: #E11D48\nnodes: { a: {} }')).toMatch(/quote it/);
  });

  it('draws highlights in the accent and leaves everything else alone', () => {
    for (const theme of THEMES) {
      const d = { theme, accent: '#E11D48' };
      // An unhighlighted node, and a highlight with its own color, don't change.
      expect(paintFor('architecture', 'service', d), theme).toEqual(paintFor('architecture', 'service', theme));
      expect(paintFor('architecture', 'service', d, { highlight: true, color: 'green' }), theme).toEqual(paintFor('architecture', 'service', theme, { highlight: true, color: 'green' }));
      expect(palette(d).edgePaint('green', true), theme).toEqual(palette(theme).edgePaint('green', true));
      expect(palette(d).edgePaint(undefined, false), theme).toEqual(palette(theme).edgePaint(undefined, false));
      const hi = paintFor('architecture', 'service', d, { highlight: true });
      expect(hi, theme).not.toEqual(paintFor('architecture', 'service', theme, { highlight: true }));
      expect(contrast(hi.text, hi.fill), `${theme} text on ${hi.fill}`).toBeGreaterThanOrEqual(4.5);
      const edge = palette(d).edgePaint(undefined, true);
      expect(contrast(edge.stroke, palette(theme).canvas), `${theme} edge`).toBeGreaterThanOrEqual(3);
      expect(contrast(edge.text, palette(theme).canvas), `${theme} edge label`).toBeGreaterThanOrEqual(4.5);
    }
    expect(paintFor('architecture', 'service', { theme: 'clean', accent: '#E11D48' }, { highlight: true }).fill).toBe('#E11D48');
  });

  it('keeps a pale brand color readable: dark text on it, and a darker line on a light canvas', () => {
    const d = { theme: 'clean' as const, accent: '#FFD400' };
    const hi = paintFor('architecture', 'service', d, { highlight: true });
    expect(hi.fill).toBe('#FFD400');
    expect(contrast(hi.text, hi.fill)).toBeGreaterThanOrEqual(4.5);
    expect(palette(d).edgePaint(undefined, true).stroke).not.toBe('#FFD400');
  });

  it('a named accent uses the style\'s own version of that color', () => {
    expect(paintFor('architecture', 'service', { theme: 'paper', accent: 'teal' }, { highlight: true })).toEqual(paintFor('architecture', 'service', 'paper', { highlight: true, color: 'teal' }));
    expect(palette({ theme: 'dark', accent: 'green' }).edgePaint(undefined, true)).toEqual(palette('dark').edgePaint('green', true));
  });

  it('round-trips through the file, and set changes or clears it', async () => {
    const { diagram } = parseSpecText(`accent: "#E11D48"\n${SPEC}`);
    const m = readDrawio(toMxfile(diagram, await layout(diagram)));
    expect(m.byId.get('api')!.style.fillColor).toBe('#E11D48');
    const shown = toDiagram(m).diagram;
    expect(shown.accent).toBe('#E11D48');
    const yaml = toYaml(shown);
    expect(yaml).toContain('accent: "#E11D48"');
    expect(parseSpecText(yaml).diagram.accent).toBe('#E11D48');
    expect(parseSpecText(patchSpec(yaml, [{ op: 'set', args: ['accent=teal'] }])).diagram.accent).toBe('teal');
    expect(parseSpecText(patchSpec(yaml, [{ op: 'set', args: ['accent='] }])).diagram.accent).toBeUndefined();
  });

  it('restyles a built diagram when only the accent changes, without moving it', async () => {
    const before = parseSpecText(SPEC).diagram;
    const old = readDrawio(toMxfile(before, await layout(before)));
    const after = parseSpecText(`accent: "#E11D48"\n${SPEC}`).diagram;
    const out = readDrawio(serialize(merge(after, old, await layout(after)).scene));
    expect(out.byId.get('api')!.style.fillColor).toBe('#E11D48');
    expect(out.byId.get('api')!.geom).toEqual(old.byId.get('api')!.geom);
    expect(out.meta.aiviz_accent).toBe('#E11D48');
    const back = readDrawio(serialize(merge(before, out, await layout(before)).scene));
    expect(back.byId.get('api')!.style.fillColor).toBe(old.byId.get('api')!.style.fillColor);
    expect(back.meta.aiviz_accent).toBeUndefined();
  });
});

describe('Azure icons', () => {
  it('draws from both sets: the newer one for services the older lacks, and where both have one', () => {
    const stencil = (i: string) => (resolveIcon(i) as { stencil: string }).stencil;
    expect(stencil('azure.functions')).toBe('mxgraph.mscae.cloud.functions');
    expect(stencil('azure.cosmos')).toBe('mxgraph.mscae.cloud.cosmos_db');
    expect(stencil('azure.keyvault')).toBe('mxgraph.mscae.cloud.key_vault');
    expect(stencil('azure.service_bus')).toBe('mxgraph.mscae.cloud.service_bus');
    expect(stencil('azure.vm')).toBe('mxgraph.azure.virtual_machine');
    expect(stencil('azure.sql_database')).toBe('mxgraph.azure.sql_database');
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

  it('caches subsets by character set, and ignores a broken cache file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-cache-'));
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = dir;
    try {
      const svg = (t: string) => `<svg xmlns="http://www.w3.org/2000/svg"><defs/><text font-family="IBM Plex Mono, monospace">${t}</text></svg>`;
      const face = (s: string) => /url\(data:font\/woff2;base64,([^)]+)\)/.exec(s)![1];
      const a = await embedFonts(svg('Queue zebra'));
      const files = fs.readdirSync(path.join(dir, 'linework', 'fonts'));
      expect(files.length).toBeGreaterThan(0);
      // Same characters in another order: the same subset.
      expect(face(await embedFonts(svg('zebra Queue')))).toBe(face(a));
      // A truncated file in the cache is rebuilt, not embedded.
      const other = svg('Kalam-free text 42');
      const before = new Set(fs.readdirSync(path.join(dir, 'linework', 'fonts')));
      const fresh = await embedFonts(other);
      const added = fs.readdirSync(path.join(dir, 'linework', 'fonts')).filter((f) => !before.has(f));
      expect(added.length).toBeGreaterThan(0);
      for (const f of added) fs.writeFileSync(path.join(dir, 'linework', 'fonts', f), 'junk');
      forgetSubsets();
      expect(face(await embedFonts(other.replace('42', '24')))).toBe(face(fresh));
      for (const f of added) expect(fs.readFileSync(path.join(dir, 'linework', 'fonts', f)).subarray(0, 4).toString('latin1')).toBe('wOF2');
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
});

const run = process.env.LINEWORK_SKIP_E2E !== '1';

describe.runIf(run)('fixes from agent runs', () => {
  it('reroutes a call-and-callback pair instead of looping it around a group', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-agent-'));
    const out = path.join(tmp, 'checkout.drawio.svg');
    const r = await build(fs.readFileSync('test/fixtures/agent-checkout.yaml', 'utf8'), { out });
    expect(r.check.findings.map((f) => f.message)).toEqual([]);
    const m = readDrawio(fs.readFileSync(out, 'utf8'));
    const pts = m.byId.get('e_api__stripe')!.geom!.points; // waypoints only
    const len = pts.reduce((s, p, i) => (i ? s + Math.abs(p.x - pts[i - 1]!.x) + Math.abs(p.y - pts[i - 1]!.y) : 0), 0);
    expect(len).toBeLessThan(500);
  }, 60000);
});

describe.runIf(run)('every style builds clean', () => {
  it('builds each example in each style with no lint findings and embedded fonts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-styles-'));
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
