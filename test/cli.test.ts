// The CLI as a script or an agent drives it: text and exit codes, and the same
// results as one JSON document with --json. Commands run in-process against an
// output sink, the way the background process runs them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { COMMANDS, Exit, OPTIONS, USAGE, nearestCommand, needsBrowser, packageVersion, report, run, type IO } from '../src/commands.js';
import { ConfigError, useConfig } from '../src/config.js';
import { DrawioBrowser, systemBrowsers } from '../src/render/browser.js';
import { SpecError } from '../src/spec/parse.js';
import { findSpecs } from '../src/sync.js';

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

  it('reports ConfigError with exit 2 and valid JSON on stdout', () => {
    const lines = { out: '', err: '' };
    const io: IO = { out: (t) => void (lines.out += t), err: (t) => void (lines.err += t), stdin: () => '', code: 0 };
    const e = new ConfigError('linework.yaml', ['theme: unknown']);
    expect(report(e, io, true)).toBe(2);
    expect(lines.err).toContain('linework.yaml error in');
    expect(JSON.parse(lines.out)).toEqual({ ok: false, error: { kind: 'usage', message: `linework.yaml error in ${e.message}` } });
  });

  it('skips launching a browser for sync --check and share of .excalidraw files', () => {
    const v = (args: string[]) => parseArgs({ args, allowPositionals: true, options: OPTIONS });
    const syncCheck = v(['--check']);
    expect(needsBrowser('sync', syncCheck.values, syncCheck.positionals)).toBe(false);
    const syncBuild = v([]);
    expect(needsBrowser('sync', syncBuild.values, syncBuild.positionals)).toBe(true);
    const shareExc = v(['diagram.excalidraw']);
    expect(needsBrowser('share', shareExc.values, shareExc.positionals)).toBe(false);
    const shareExcJson = v(['diagram.excalidraw.json']);
    expect(needsBrowser('share', shareExcJson.values, shareExcJson.positionals)).toBe(false);
    const shareSvg = v(['diagram.drawio.svg']);
    expect(needsBrowser('share', shareSvg.values, shareSvg.positionals)).toBe(true);
  });

  it('prevents infinite loops on directory symlinks in findSpecs', () => {
    const dir = at('loop-test');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub/a.yaml'), SPEC);
    fs.symlinkSync(dir, path.join(dir, 'sub/back'));
    const found = findSpecs([dir]);
    expect(found.map((f) => path.basename(f.spec))).toEqual(['a.yaml']);
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
    const cfg = await cli(['config', tmp, '--json']);
    expect(cfg.code).toBe(0);
    expect(cfg.json).toMatchObject({ ok: true, path: null, theme: 'clean', lockTheme: false });
    const listNew = await cli(['new']);
    expect(listNew.code).toBe(0);
    expect(listNew.out).toContain('built-in examples:');
    expect(listNew.out).toContain('architecture');
    const listNewJson = await cli(['new', '--json']);
    expect(listNewJson.code).toBe(0);
    expect(listNewJson.json.ok).toBe(true);
    expect(listNewJson.json.examples.some((e: { name: string; type?: string }) => e.name === 'checkout' && e.type === 'architecture')).toBe(true);
    const newOut = at('nested/dir/starter.yaml');
    const wroteNew = await cli(['new', 'checkout', '-o', newOut]);
    expect(wroteNew.code).toBe(0);
    expect(wroteNew.out).toContain('next: linework build');
    expect(fs.readFileSync(newOut, 'utf8')).toContain('type: architecture');
    // Diagram type aliases work too (e.g. `linework new sequence`)
    const seqAlias = await cli(['new', 'sequence', '--json']);
    expect(seqAlias.code).toBe(0);
    expect(seqAlias.json).toMatchObject({ ok: true, type: 'sequence' });
    expect(seqAlias.json.yaml).toContain('type: sequence');

    // `linework config` prints custom themes, hand styles, and template names
    const cfgDir = at('cfg-fmt');
    fs.mkdirSync(path.join(cfgDir, 'tpls'), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'tpls/service.yaml'), 'type: architecture\ntitle: Svc\nnodes: { a: A }\n');
    fs.writeFileSync(
      path.join(cfgDir, 'linework.yaml'),
      'theme: corp\nhandStyles: reset\ntemplates: ./tpls\nthemes:\n  corp:\n    extends: clean\n    accent: "#0A6E5C"\n',
    );
    const cfgText = await cli(['config', cfgDir]);
    useConfig();
    expect(cfgText.code).toBe(0);
    expect(cfgText.out).toContain('custom themes: corp (extends clean)');
    expect(cfgText.out).toContain('hand styles: reset');
    expect(cfgText.out).toContain('templates:');
    expect(cfgText.out).toContain('(service)');

    // `linework daemon --help` exits 0 with usage
    const daemonHelp = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'daemon', '--help'], { encoding: 'utf8' });
    expect(daemonHelp.status).toBe(0);
    expect(daemonHelp.stdout).toContain('usage: linework daemon');
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

  it('lint and restyle answer in JSON and respect config', async () => {
    const dir = at('team');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'linework.yaml'), 'theme: clean\nlockTheme: true\n');
    const d = path.join(dir, 'd.drawio.svg');
    // Build a clean diagram under the config
    const built = await cli(['build', '-', '-o', d, '--json'], SPEC);
    expect(built.code).toBe(0);
    const lintOk = await cli(['lint', dir, '--json']);
    expect(lintOk.code).toBe(0);
    expect(lintOk.json).toMatchObject({ ok: true, errors: 0, warnings: 0 });
    expect(lintOk.json.files).toHaveLength(1);
    const cfgJson = await cli(['config', dir, '--json']);
    expect(cfgJson.code).toBe(0);
    expect(cfgJson.json).toMatchObject({ ok: true, theme: 'clean', lockTheme: true });
    const restyleJson = await cli(['restyle', dir, '--json']);
    expect(restyleJson.code).toBe(0);
    expect(restyleJson.json).toMatchObject({ ok: true });
    expect(restyleJson.json.files).toHaveLength(1);
    const emptyDir = at('empty-lint');
    fs.mkdirSync(emptyDir, { recursive: true });
    const lintEmpty = await cli(['lint', emptyDir]);
    expect(lintEmpty.code).toBe(0);
    expect(lintEmpty.out).toContain('no .drawio.svg or .drawio files found');
  }, 60000);

  it('sync honors linework.yaml when checking stamps', async () => {
    const dir = at('sync-cfg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'linework.yaml'), 'theme: soft\nstatuses:\n  new: green\n');
    fs.writeFileSync(path.join(dir, 's.yaml'), 'type: flow\nnodes:\n  a: { label: Hello, status: new }\n  b: World\nedges:\n  - a -> b\n');
    const built = await cli(['sync', dir, '--json']);
    expect(built.code).toBe(0);
    expect(built.json.items).toMatchObject([{ state: 'built' }]);
    const checked = await cli(['sync', dir, '--check', '--json']);
    expect(checked.code).toBe(0);
    expect(checked.json).toMatchObject({ ok: true, items: [{ state: 'fresh' }] });
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

    // Doctor warns on invalid project config and non-file LINEWORK_CHROME without failing required checks.
    const badProj = at('bad-doc-cfg');
    fs.mkdirSync(badProj, { recursive: true });
    fs.writeFileSync(path.join(badProj, 'linework.yaml'), 'theme: nonexistent_theme\n');
    const prevCwd = process.cwd();
    const prevChrome = process.env.LINEWORK_CHROME;
    process.chdir(badProj);
    try {
      const badCfgDoc = await cli(['doctor', '--json']);
      expect(badCfgDoc.code).toBe(0);
      const checks = badCfgDoc.json.checks as Array<{ name: string; ok: boolean; required: boolean; detail: string }>;
      expect(checks.find((c) => c.name === 'project config')).toMatchObject({ ok: false, required: false });

      process.env.LINEWORK_CHROME = badProj; // a directory, not an executable file
      const badChromeDoc = await cli(['doctor', '--json']);
      const chromeChecks = badChromeDoc.json.checks as Array<{ name: string; ok: boolean; required: boolean; detail: string }>;
      const chromeCheck = chromeChecks.find((c) => c.name === 'LINEWORK_CHROME');
      expect(chromeCheck).toMatchObject({ ok: false, required: false });
      expect(chromeCheck!.detail).toContain('is not a file');
      expect(chromeChecks.some((c) => c.name === 'env overrides' && c.detail.includes('LINEWORK_CHROME='))).toBe(true);
    } finally {
      process.chdir(prevCwd);
      if (prevChrome === undefined) delete process.env.LINEWORK_CHROME;
      else process.env.LINEWORK_CHROME = prevChrome;
    }
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
