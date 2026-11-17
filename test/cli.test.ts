// The CLI as a script or an agent drives it: text and exit codes, and the same
// results as one JSON document with --json. Commands run in-process against an
// output sink, the way the background process runs them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { COMMANDS, Exit, OPTIONS, USAGE, nearestCommand, packageVersion, report, run, type IO } from '../src/commands.js';
import { DrawioBrowser, systemBrowsers } from '../src/render/browser.js';
import { SpecError } from '../src/spec/parse.js';

const e2e = process.env.LINEWORK_SKIP_E2E !== '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-cli-'));
const at = (name: string) => path.join(tmp, name);
let browser: DrawioBrowser | undefined;
beforeAll(async () => {
  if (e2e) browser = await DrawioBrowser.launch();
}, 60000);
afterAll(async () => {
  await browser?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run one command line and collect what it printed and the exit code it asked for. */
async function cli(args: string[], stdin = ''): Promise<{ out: string; err: string; code: number; json: any }> {
  let out = '', err = '';
  const io: IO = { out: (t) => void (out += t), err: (t) => void (err += t), stdin: () => stdin, code: 0, warm: true };
  const [cmd, ...rest] = args;
  let code: number;
  try {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
    await run(cmd!, values, positionals, browser && Promise.resolve(browser), io);
    code = io.code;
  } catch (e) {
    code = report(e, io, args.includes('--json'));
  }
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    // text output
  }
  return { out, err, code, json };
}

const SPEC = 'type: flow\nnodes: { a: Hello, b: World }\nedges:\n  - a -> b: next\n';
const BAD = 'type: flow\nnodes: { a: A }\nedges:\n  - a -> zz\n';

describe('errors and usage', () => {
  it('reports a spec error with exit 1, as text and as JSON', () => {
    const sink = () => {
      const lines = { out: '', err: '' };
      const io: IO = { out: (t) => void (lines.out += t), err: (t) => void (lines.err += t), stdin: () => '', code: 0 };
      return { lines, io };
    };
    const e = new SpecError([{ path: 'edges[0]', message: 'node "zz" doesn\'t exist.' }]);
    const text = sink();
    expect(report(e, text.io)).toBe(1);
    expect(text.lines.err).toBe('spec error:\n  edges[0]: node "zz" doesn\'t exist.\n');
    expect(text.lines.out).toBe('');
    const json = sink();
    expect(report(e, json.io, true)).toBe(1);
    expect(JSON.parse(json.lines.out)).toEqual({ ok: false, error: { kind: 'spec', message: 'edges[0]: node "zz" doesn\'t exist.', issues: [{ path: 'edges[0]', message: 'node "zz" doesn\'t exist.' }] } });
    // The text still goes to stderr, for whoever is reading the log.
    expect(json.lines.err).toContain('spec error:');
  });

  it('reports bad usage with exit 2', async () => {
    expect(report(new Exit('usage: linework x', 2), { out() {}, err() {}, stdin: () => '', code: 0 })).toBe(2);
    const noOut = await cli(['build', 'spec.yaml']);
    expect(noOut.code).toBe(2);
    expect(noOut.err).toMatch(/^usage: linework build/);
    const badOption = await cli(['build', '--bogus', '--json']);
    expect(badOption.code).toBe(2);
    expect(badOption.json).toMatchObject({ ok: false, error: { kind: 'usage' } });
    expect(badOption.json.error.message).toBe('Unknown option \'--bogus\'. Run "linework help" for the options.');
  });

  it('suggests the command a typo was meant to be', async () => {
    expect(nearestCommand('buld')).toBe('build');
    expect(nearestCommand('chekc')).toBe('check');
    expect(nearestCommand('instal-browser')).toBe('install-browser');
    expect(nearestCommand('frobnicate')).toBeUndefined();
    const res = await cli(['rendr', 'x.drawio.svg']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('Did you mean "render"?');
  });

  it('documents every command in the usage text', () => {
    for (const c of COMMANDS.filter((c) => c !== 'help')) expect(USAGE, c).toMatch(new RegExp(`^  linework ${c}\\b`, 'm'));
  });

  it('prints its version', async () => {
    const res = await cli(['version']);
    expect(res.out.trim()).toBe(JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('answers the commands that need no browser', async () => {
    const kinds = await cli(['kinds', 'flow', '--json']);
    expect(Object.keys(kinds.json.kinds.flow)).toEqual(['step', 'decision', 'terminal', 'data', 'error']);
    const unknown = await cli(['kinds', 'nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Types: architecture, flow');
    expect((await cli(['schema'])).json.type).toBe('object');
    const sync = await cli(['sync', 'examples/checkout.yaml', '--check', '--json']);
    expect(sync.code).toBe(1);
    expect(sync.json).toEqual({ ok: false, items: [{ spec: 'examples/checkout.yaml', out: 'examples/checkout.drawio.svg', state: 'stale', missing: true }] });
  });
});

describe('finding a browser', () => {
  const having = (...files: string[]) => (p: string) => files.includes(p);

  it('finds a distro Chromium on PATH, which Playwright does not look for', () => {
    expect(systemBrowsers({ PATH: '/usr/local/bin:/usr/bin' }, 'linux', having('/usr/bin/chromium'))).toEqual(['/usr/bin/chromium']);
    expect(systemBrowsers({ PATH: '/snap/bin:/usr/bin' }, 'linux', having('/usr/bin/brave-browser', '/snap/bin/chromium'))).toEqual(['/snap/bin/chromium', '/usr/bin/brave-browser']);
  });

  it('looks in the app folders on macOS and Windows', () => {
    expect(systemBrowsers({ PATH: '/usr/bin', HOME: '/Users/me' }, 'darwin', having('/Users/me/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'))).toEqual([
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Users/me/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
    expect(systemBrowsers({ Path: 'C:\\tools', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', having('C:\\tools\\chromium.exe', 'C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'))).toEqual([
      'C:\\tools\\chromium.exe',
      'C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]);
  });

  it('finds nothing where there is nothing', () => {
    expect(systemBrowsers({}, 'linux', having())).toEqual([]);
    expect(systemBrowsers({ PATH: '/usr/bin' }, 'linux', having('/usr/bin/firefox'))).toEqual([]);
  });
});

describe.runIf(e2e)('drawing commands', () => {
  it('build prints a summary, and the same facts as JSON', async () => {
    const text = await cli(['build', '-', '-o', at('a.drawio.svg'), '--png', at('a.png')], SPEC);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^wrote .*a\.drawio\.svg \(2 nodes, 1 edges, \d+x\d+px, TB\)\npreview .*a\.png\ncheck: 0 errors, 0 warnings, 0 edge crossings\n$/);
    expect(fs.statSync(at('a.png')).size).toBeGreaterThan(1000);

    const res = await cli(['build', '-', '-o', at('b.drawio.svg'), '--json'], SPEC);
    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({ ok: true, out: at('b.drawio.svg'), mode: 'fresh', direction: 'TB', stats: { nodes: 2, edges: 1, crossings: 0 }, check: { errors: 0, warnings: 0, findings: [] }, specWarnings: [] });
    expect(res.json.stats.width).toBeGreaterThan(50);
    // Nothing but the document on stdout.
    expect(res.out.trim().startsWith('{') && res.out.trim().endsWith('}')).toBe(true);
    expect(fs.readFileSync(at('b.drawio.svg'), 'utf8')).toBe(fs.readFileSync(at('a.drawio.svg'), 'utf8'));
  }, 60000);

  it('build fails on a bad spec without writing a file', async () => {
    const res = await cli(['build', '-', '-o', at('bad.drawio.svg'), '--json'], BAD);
    expect(res.code).toBe(1);
    expect(res.json.error.kind).toBe('spec');
    expect(res.json.error.issues[0].path).toBe('edges[0]');
    expect(fs.existsSync(at('bad.drawio.svg'))).toBe(false);
  }, 30000);

  it('set, add and rm change a diagram in place and say what they kept', async () => {
    await cli(['build', '-', '-o', at('p.drawio.svg')], SPEC);
    const add = await cli(['add', at('p.drawio.svg'), 'c: Again', 'b -> c: then', '--json']);
    expect(add.json).toMatchObject({ ok: true, mode: 'merge', stats: { nodes: 3, edges: 2 }, merge: { kept: 2, placed: ['c'] } });
    const set = await cli(['set', at('p.drawio.svg'), 'c.label=Once more']);
    expect(set.out).toContain('merged into the existing layout: kept 3 positions');
    const shown = await cli(['show', at('p.drawio.svg'), '--json']);
    expect(shown.json.spec.nodes).toEqual({ a: { label: 'Hello' }, b: { label: 'World' }, c: { label: 'Once more' } });
    expect(shown.json.yaml).toMatch(/^# linework-base: /);
    const rm = await cli(['rm', at('p.drawio.svg'), 'c', '--json']);
    expect(rm.json).toMatchObject({ stats: { nodes: 2, edges: 1 }, merge: { removed: ['c'] } });
    const bad = await cli(['set', at('p.drawio.svg'), 'nope.label=x', '--json']);
    expect(bad.code).toBe(2);
    expect(bad.json.error.kind).toBe('usage');
  }, 60000);

  it('check exits 1 on errors, and on warnings only with --strict', async () => {
    const file = 'test/fixtures/hand-edited.drawio.svg';
    const res = await cli(['check', file, '--json']);
    const rules = res.json.check.findings.map((f: { rule: string }) => f.rule);
    expect(rules).toContain('edge-through-node');
    expect(res.json.check.errors + res.json.check.warnings).toBe(rules.length);
    expect(res.code).toBe(res.json.check.errors ? 1 : 0);
    expect(res.json.ok).toBe(res.code === 0);
    const strict = await cli(['check', file, '--strict']);
    expect(strict.code).toBe(1);
    expect(strict.out).toMatch(/^check: \d+ errors, \d+ warnings/);
    const clean = await cli(['check', at('a.drawio.svg'), '--strict', '--json']);
    expect(clean.code).toBe(0);
    expect(clean.json.ok).toBe(true);
  }, 60000);

  it('render, tidy and icons answer in JSON too', async () => {
    const render = await cli(['render', at('a.drawio.svg'), '-o', at('r.png'), '--json']);
    expect(render.json).toEqual({ ok: true, out: at('r.png') });
    expect(fs.readFileSync(at('r.png')).subarray(1, 4).toString()).toBe('PNG');
    const tidy = await cli(['tidy', at('a.drawio.svg'), '--json']);
    expect(tidy.json).toMatchObject({ ok: true, rerouted: 0, check: { errors: 0 } });
    const icons = await cli(['icons', 'aws', 'lambda', '--json']);
    expect(icons.json.icons).toContain('aws.lambda');
  }, 60000);

  it('sync rebuilds what is out of date and reports each spec', async () => {
    fs.mkdirSync(at('docs'));
    fs.writeFileSync(at('docs/flow.yaml'), SPEC);
    const first = await cli(['sync', at('docs'), '--json']);
    expect(first.json.items).toMatchObject([{ state: 'built', missing: true, check: { errors: 0 } }]);
    expect((await cli(['sync', at('docs'), '--check', '--json'])).json).toMatchObject({ ok: true, items: [{ state: 'fresh' }] });
    fs.writeFileSync(at('docs/flow.yaml'), SPEC.replace('World', 'There'));
    const stale = await cli(['sync', at('docs'), '--check']);
    expect(stale.code).toBe(1);
    expect(stale.out).toContain('1 diagram is out of date');
  }, 60000);

  it('imports Mermaid, to a spec or straight to a diagram', async () => {
    const spec = await cli(['import', '-', '--json'], 'flowchart LR\n  A[Start] --> B{OK?}\n  B -->|yes| C[Done]\n');
    expect(spec.json.yaml).toContain('type: flow');
    const made = await cli(['import', '-', '-o', at('m.drawio.svg'), '--json'], 'flowchart LR\n  A[Start] --> B{OK?}\n  B -->|yes| C[Done]\n');
    expect(made.json).toMatchObject({ ok: true, stats: { nodes: 3, edges: 2 }, check: { errors: 0 } });
  }, 60000);

  it('doctor proves the machine can draw', async () => {
    const res = await cli(['doctor', '--json']);
    expect(res.code).toBe(0);
    expect(res.json.ok).toBe(true);
    const names = res.json.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['node', 'browser', 'bundled draw.io and fonts', 'test build']));
    expect(res.json.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    const text = await cli(['doctor']);
    expect(text.out).toContain('linework can draw on this machine.');
  }, 60000);

  it('build --watch rebuilds on every save and survives a broken spec', async () => {
    const spec = at('w.yaml'), out = at('w.drawio.svg');
    fs.writeFileSync(spec, SPEC);
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'build', spec, '-o', out, '--watch'], { env: { ...process.env, LINEWORK_NO_DAEMON: '1' } });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    const seen = async (re: RegExp) => {
      for (let i = 0; i < 300 && !re.test(log); i++) await new Promise((r) => setTimeout(r, 100));
      expect(log).toMatch(re);
    };
    try {
      await seen(/watching .*w\.yaml/);
      expect(log).toContain('(2 nodes, 1 edges');
      fs.writeFileSync(spec, BAD);
      await seen(/spec error:\n\s+edges\[0\]/);
      fs.writeFileSync(spec, SPEC + '  - b -> a: back\n');
      await seen(/\(2 nodes, 2 edges/);
      // The summary names a direction, never the spec's "auto".
      expect(log).not.toMatch(/px, auto\)/);
    } finally {
      child.kill('SIGINT');
    }
    // Ctrl+C ends it: 0 from linework, or 130 when the browser's own handler gets there first.
    expect([0, 130]).toContain(await exited);
  }, 60000);
});
