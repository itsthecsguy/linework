// Team config: linework.yaml, its themes, names and rules.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, findConfig, loadConfig, setConfigRoot, useConfig, useConfigFor, NO_CONFIG } from '../src/config.js';
import { parseSpecText } from '../src/spec/parse.js';
import { toDiagram, toYaml } from '../src/drawio/show.js';
import { contrast, palette } from '../src/drawio/theme.js';
import { KINDS } from '../src/spec/model.js';
import { DrawioBrowser, type InspectCell } from '../src/render/browser.js';
import { build, checkFile, lintFiles, restyleFiles, show } from '../src/api.js';
import { check } from '../src/lint/check.js';
import { conventions } from '../src/lint/conventions.js';
import { readDrawio } from '../src/drawio/read.js';
import { toMxfile } from '../src/drawio/write.js';
import { layout } from '../src/layout/layout.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-cfg-'));
const write = (rel: string, text: string) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};
afterEach(() => {
  setConfigRoot(undefined);
  useConfig(NO_CONFIG);
});

const ORG = `
statuses:
  new: green
  deprecated: { color: gray, label: Being retired }
components:
  stripe: { label: Stripe, kind: external, tech: Payments }
naming: { case: sentence, maxLength: 24, banned: [microservice] }
rules: { too-wide: off }
`;
const REPO = `
extends: ./org/linework.yaml
theme: acme
lockTheme: true
legend: true
themes:
  acme:
    extends: clean
    text: "#0B1F33"
    border: "#9DB2C7"
    accent: "#0A6E5C"
    radius: 4
    font: { family: Acme Mono, regular: fonts/r.woff2, bold: fonts/b.woff2 }
kinds:
  architecture:
    ml-model: { shape: pill, color: teal, description: a served model }
limits: { nodes: 5 }
rules: { raw-color: error }
`;

function repo() {
  write('a/org/linework.yaml', ORG);
  fs.mkdirSync(path.join(tmp, 'a/fonts'), { recursive: true });
  fs.copyFileSync('assets/fonts/plex-mono-400.woff2', path.join(tmp, 'a/fonts/r.woff2'));
  fs.copyFileSync('assets/fonts/plex-mono-600.woff2', path.join(tmp, 'a/fonts/b.woff2'));
  return write('a/linework.yaml', REPO);
}

describe('loading', () => {
  it('finds the nearest config above a file and merges what it extends', () => {
    const file = repo();
    expect(findConfig(path.join(tmp, 'a/docs/deep/x.drawio.svg'))).toBe(file);
    const cfg = loadConfig(file);
    expect(cfg.theme).toBe('acme');
    expect(cfg.statuses.deprecated).toEqual({ color: 'gray', label: 'Being retired' });
    expect(cfg.statuses.new!.label).toBe('New');
    expect(cfg.components.stripe!.kind).toBe('external');
    expect(cfg.rules).toEqual({ 'too-wide': 'off', 'raw-color': 'error' });
    expect(cfg.limits).toEqual({ nodes: 5, width: 1400 });
    expect(cfg.fonts.map((f) => f.weight)).toEqual([400, 600]);
  });

  it('rejects a theme whose text would be hard to read, naming the pair', () => {
    const f = write('b/linework.yaml', 'themes:\n  pale: { extends: clean, text: "#AAAAAA" }\n');
    expect(() => loadConfig(f)).toThrow(ConfigError);
    expect(() => loadConfig(f)).toThrow(/text on a box is #AAAAAA on #FFFFFF, a contrast of 2\.3:1/);
  });

  it('says what is wrong with unknown keys, built-in names and missing fonts', () => {
    expect(() => loadConfig(write('c/linework.yaml', 'colour: red\n'))).toThrow(/colour/);
    expect(() => loadConfig(write('d/linework.yaml', 'themes:\n  dark: { extends: clean }\n'))).toThrow(/built-in theme/);
    expect(() => loadConfig(write('e/linework.yaml', 'themes:\n  x: { font: { family: X, regular: nope.woff2, bold: nope.woff2 } }\n'))).toThrow(/nope\.woff2 doesn't exist/);
    expect(() => loadConfig(write('f/linework.yaml', 'lockTheme: true\n'))).toThrow(/lockTheme needs theme/);
    expect(() => loadConfig(write('g/linework.yaml', 'extends: ./g2.yaml\n'))).toThrow(/doesn't exist/);
  });

  it('gives a custom theme readable text on its accent', () => {
    const cfg = useConfig(loadConfig(repo()));
    const hi = palette('acme').paint('neutral', true);
    expect(hi.fill).toBe('#0A6E5C');
    expect(contrast(hi.text, hi.fill)).toBeGreaterThanOrEqual(4.5);
    expect(palette('acme').radius).toBe(4);
    expect(palette('acme').type.family).toMatch(/^Acme Mono, /);
    expect(cfg.themes[0]!.base).toBe('clean');
  });

  it('keeps config discovery, extends and custom fonts inside rootBoundary', () => {
    const outer = write('bound/linework.yaml', 'theme: dark\n');
    const innerDir = path.join(tmp, 'bound/inner');
    fs.mkdirSync(innerDir, { recursive: true });
    expect(findConfig(innerDir)).toBe(outer);
    expect(findConfig(innerDir, innerDir)).toBeUndefined();
    setConfigRoot(innerDir);
    expect(findConfig(innerDir)).toBeUndefined();

    const escExtends = write('bound/inner/ext/linework.yaml', 'extends: ../../linework.yaml\n');
    expect(() => loadConfig(escExtends, innerDir)).toThrow(ConfigError);
    expect(() => loadConfig(escExtends, innerDir)).toThrow(/resolves outside/);

    fs.mkdirSync(path.join(tmp, 'bound/fonts'), { recursive: true });
    fs.copyFileSync('assets/fonts/plex-mono-400.woff2', path.join(tmp, 'bound/fonts/r.woff2'));
    const escFont = write('bound/inner/fnt/linework.yaml', 'themes:\n  x: { font: { family: X, regular: ../../fonts/r.woff2, bold: ../../fonts/r.woff2 } }\n');
    expect(() => loadConfig(escFont, innerDir)).toThrow(ConfigError);
    expect(() => loadConfig(escFont, innerDir)).toThrow(/resolves outside/);
  });

  it('flags 2-word title-cased labels and punctuation-bounded banned terms', async () => {
    const cfgFile = write('conv/linework.yaml', 'naming: { case: sentence, banned: ["C++", ".NET"] }\n');
    const cfg = useConfig(loadConfig(cfgFile));
    const { diagram } = parseSpecText('type: flow\nnodes:\n  a: Payment Service\n  b: Legacy C++ worker\n  c: Old .NET app\nedges:\n  - a -> b\n  - b -> c\n');
    const m = readDrawio(toMxfile(diagram, await layout(diagram)));
    const findings = conventions(m, toDiagram(m), cfg);
    expect(findings.some((f) => f.rule === 'naming-case' && f.message.includes('Payment Service'))).toBe(true);
    expect(findings.filter((f) => f.rule === 'naming-banned').map((f) => f.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('C++'), expect.stringContaining('.NET')]),
    );
  });

  it('handles empty diagrams, table rows, and segment box hits in check()', () => {
    expect(check([]).stats).toEqual({ nodes: 0, edges: 0, crossings: 0, width: 0, height: 0 });
    const cell = (overrides: Partial<InspectCell>): InspectCell => ({
      id: 'c',
      vertex: true,
      edge: false,
      parent: '1',
      container: false,
      text: false,
      shape: null,
      aivizType: null,
      source: null,
      target: null,
      box: { x: 0, y: 0, w: 100, h: 40 },
      textBox: null,
      label: '',
      points: null,
      ...overrides,
    });
    const tbl = cell({ id: 't1', container: true, shape: 'swimlane', box: { x: 0, y: 0, w: 160, h: 90 }, label: 'Users' });
    const row1 = cell({ id: 'r1', parent: 't1', box: { x: 0, y: 30, w: 160, h: 24 }, label: 'id' });
    const row2 = cell({ id: 'r2', parent: 't1', box: { x: 0, y: 54, w: 160, h: 24 }, label: 'email' });
    expect(check([tbl, row1, row2]).stats.nodes).toBe(0);

    const n1 = cell({ id: 'n1', box: { x: 0, y: 0, w: 40, h: 40 }, label: 'A' });
    const n2 = cell({ id: 'n2', box: { x: 200, y: 200, w: 40, h: 40 }, label: 'B' });
    const e1 = cell({ id: 'e1', vertex: false, edge: true, source: 'n1', target: 'n2', points: [{ x: 40, y: 40 }, { x: 200, y: 200 }], label: 'diag', textBox: { x: 150, y: 50, w: 40, h: 16 } });
    const e2 = cell({ id: 'e2', vertex: false, edge: true, source: 'n1', target: 'n2', points: [{ x: 40, y: 40 }, { x: 200, y: 200 }] });
    expect(check([n1, n2, e1, e2]).findings.some((f) => f.rule === 'label-on-edge')).toBe(false);
  });
});

describe('specs under a config', () => {
  const SPEC = `type: architecture
nodes:
  api: { label: Checkout API }
  model: { kind: ml-model, status: new }
  stripe: {}
edges:
  - api -> model
  - api -> stripe
`;
  it('applies the default theme, shared components, statuses and team kinds', () => {
    useConfig(loadConfig(repo()));
    const { diagram } = parseSpecText(SPEC);
    expect(diagram.theme).toBe('acme');
    expect(diagram.nodes.find((n) => n.id === 'stripe')).toMatchObject({ label: 'Stripe', kind: 'external', tech: 'Payments' });
    expect(diagram.nodes.find((n) => n.id === 'model')).toMatchObject({ kind: 'ml-model', status: 'new', color: 'green' });
  });

  it('refuses another theme when the theme is locked, an unknown status, and a status with no config', () => {
    useConfig(loadConfig(repo()));
    expect(() => parseSpecText(SPEC + 'theme: dark\n')).toThrow(/sets every diagram to theme "acme"/);
    expect(() => parseSpecText(SPEC.replace('status: new', 'status: shiny'))).toThrow(/defines: new, deprecated/);
    useConfig(NO_CONFIG);
    expect(() => parseSpecText(SPEC.replace('kind: ml-model, ', ''))).toThrow(/needs a "statuses:" section/);
  });

  it('forgets team kinds and themes when the config goes away', () => {
    useConfig(loadConfig(repo()));
    expect(KINDS.architecture['ml-model']).toBeDefined();
    useConfig(NO_CONFIG);
    expect(KINDS.architecture['ml-model']).toBeUndefined();
    expect(() => parseSpecText('type: flow\ntheme: acme\nnodes: { a: A }\n')).toThrow(/unknown theme "acme"/);
  });

  it('writes back only what differs from the shared component and the default theme', () => {
    useConfig(loadConfig(repo()));
    const y = toYaml(parseSpecText(SPEC.replace('stripe: {}', 'stripe: { kind: service }')).diagram);
    expect(y).not.toMatch(/^theme:/m);
    expect(y).toMatch(/stripe: \{ kind: service \}/);
    expect(y).toMatch(/model: \{ kind: ml-model, status: new \}/);
    expect(toYaml(parseSpecText(SPEC).diagram)).toMatch(/stripe: \{\}/);
  });
});

let browser: DrawioBrowser | undefined;
const e2e = process.env.LINEWORK_SKIP_E2E !== '1';
beforeAll(async () => {
  if (e2e) browser = await DrawioBrowser.launch();
}, 60000);
afterAll(async () => {
  await browser?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(e2e)('a repo with a config', () => {
  const SPEC = `type: architecture
groups: { svc: Checkout Service Boundary }
nodes:
  web: { label: Web app, kind: client }
  api: { label: Checkout API, in: svc, highlight: true }
  model: { label: Fraud scorer, kind: ml-model, in: svc, status: new }
  stripe: { kind: service }
  audit: { label: Audit log, color: red }
edges:
  - web ==> api: HTTPS
  - api -> model: score
  - api -> stripe: charge
  - api -> audit
`;
  const out = () => path.join(tmp, 'a/docs/checkout.drawio.svg');

  it('draws in the team theme and font, with a legend, and reports team rules', async () => {
    repo();
    const res = await build(SPEC, { out: out(), browser: browser! });
    const svg = fs.readFileSync(out(), 'utf8');
    expect(svg).toContain(`font-family="'Acme Mono', `);
    expect(svg).toMatch(/@font-face\{font-family:"Acme Mono";font-weight:600/);
    expect(svg).toContain('#0A6E5C');
    expect(svg).toContain('legend_0_label');
    const rules = res.check.findings.map((f) => `${f.level}:${f.rule}`).sort();
    expect(rules).toEqual(['error:raw-color', 'warning:component-drift', 'warning:naming-case', 'warning:naming-length']);
    expect(res.check.findings.find((f) => f.rule === 'naming-case')!.message).toContain('"Checkout service boundary"');
  }, 60000);

  it('reads back without the legend and rebuilds to the same file', async () => {
    const before = fs.readFileSync(out(), 'utf8');
    const yaml = show(out()).yaml;
    expect(yaml).not.toMatch(/legend/);
    expect(yaml).toMatch(/status: new/);
    await build(yaml, { out: out(), browser: browser! });
    expect(fs.readFileSync(out(), 'utf8')).toBe(before);
  }, 60000);

  it('lints a folder and restyles what drifted, keeping positions', async () => {
    // A diagram drawn before the team had a config, and a box recolored by hand.
    const legacy = path.join(tmp, 'a/docs/legacy.drawio.svg');
    useConfig(NO_CONFIG);
    const other = path.join(tmp, 'elsewhere/legacy.drawio.svg');
    await build('type: flow\ntheme: dark\nnodes: { a: Start, b: Finish }\nedges:\n  - a -> b\n', { out: other, browser: browser! });
    fs.copyFileSync(other, legacy);
    fs.writeFileSync(out(), fs.readFileSync(out(), 'utf8').replace(/(&lt;object id=&quot;web&quot;[\s\S]*?fillColor=)#FFFFFF/, '$1#FFCC00'));

    const lint = await lintFiles([path.join(tmp, 'a/docs')], browser!);
    const byFile = Object.fromEntries(lint.map((r) => [path.basename(r.file), r.check!.findings.map((f) => f.rule)]));
    expect(byFile['legacy.drawio.svg']).toContain('off-theme');
    expect(byFile['checkout.drawio.svg']).toContain('hand-styled');

    const geo = show(out(), { geometry: true }).yaml.split('# geometry')[1];
    const res = await restyleFiles([path.join(tmp, 'a/docs')], browser!);
    expect(res.every((r) => !r.error)).toBe(true);
    expect(show(out(), { geometry: true }).yaml.split('# geometry')[1]).toBe(geo);
    const after = await checkFile(legacy, browser!);
    expect(after.findings.map((f) => f.rule)).not.toContain('off-theme');
    expect((await checkFile(out(), browser!)).findings.map((f) => f.rule)).not.toContain('hand-styled');
    expect(show(legacy).yaml).not.toMatch(/^theme:/m);
  }, 90000);

  it('leaves a repo with no config exactly as before', async () => {
    const plain = path.join(tmp, 'plain/x.drawio.svg');
    const res = await build(fs.readFileSync('examples/checkout.yaml', 'utf8'), { out: plain, browser: browser! });
    expect(useConfigFor(plain).path).toBeUndefined();
    expect(res.check.findings).toEqual([]);
    expect(fs.readFileSync(plain, 'utf8')).not.toContain('legend_');
  }, 60000);
});
