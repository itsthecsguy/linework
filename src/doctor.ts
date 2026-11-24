// `linework doctor`: can this machine draw, and if not, what to fix. Every way
// linework fails to start (old Node, no browser, a sandbox that blocks the
// browser, a broken install) shows up here as one line with its fix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageVersion } from './commands.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** A failed required check means linework can't draw. The others only cost speed. */
  required: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorResult {
  ok: boolean;
  version: string;
  checks: DoctorCheck[];
}

const SELF_TEST = 'type: flow\nnodes: { a: Hello, b: World }\nedges:\n  - a -> b: test\n';

export async function doctor(): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const version = packageVersion();
  checks.push({ name: 'linework', ok: true, required: true, detail: `${version} on ${process.platform} ${process.arch}` });

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: major >= 20, required: true, detail: `${process.versions.node}${major >= 20 ? '' : ' (linework needs 20 or newer)'}`, fix: 'install Node 20 or newer' });

  const { assetsDir, DrawioBrowser } = await import('./render/browser.js');
  const { fontsDir, FACES } = await import('./render/fonts.js');
  try {
    const dir = assetsDir();
    const missing = FACES.filter((f) => !fs.existsSync(path.join(fontsDir(), f.file))).map((f) => f.file);
    if (missing.length) throw new Error(`fonts missing: ${missing.join(', ')}`);
    checks.push({ name: 'bundled draw.io and fonts', ok: true, required: true, detail: dir });
  } catch (e) {
    checks.push({ name: 'bundled draw.io and fonts', ok: false, required: true, detail: (e as Error).message, fix: 'reinstall linework: npm install -g @itsthecsguy/linework@latest' });
  }

  const custom = process.env.LINEWORK_CHROME;
  if (custom) {
    let problem: string | undefined;
    try {
      const st = fs.statSync(custom);
      if (!st.isFile()) problem = `${custom} is not a file, so it is ignored`;
      else if (process.platform !== 'win32') {
        try {
          fs.accessSync(custom, fs.constants.X_OK);
        } catch {
          problem = `${custom} is not executable, so it is ignored`;
        }
      }
    } catch {
      problem = `${custom} doesn't exist, so it is ignored`;
    }
    if (problem) {
      checks.push({
        name: 'LINEWORK_CHROME',
        ok: false,
        required: false,
        detail: problem,
        fix: 'point LINEWORK_CHROME at an executable Chromium-based browser binary, or unset it',
      });
    } else {
      checks.push({
        name: 'LINEWORK_CHROME',
        ok: true,
        required: false,
        detail: `${custom} (override active)`,
      });
    }
  }

  const { findConfig, loadConfig } = await import('./config.js');
  const cfgFile = findConfig(process.cwd());
  if (cfgFile) {
    const relCfg = path.relative(process.cwd(), cfgFile) || cfgFile;
    if (process.env.LINEWORK_NO_CONFIG) {
      checks.push({ name: 'project config', ok: true, required: false, detail: `${relCfg} (ignored: LINEWORK_NO_CONFIG is set)` });
    } else {
      try {
        const cfg = loadConfig(cfgFile);
        checks.push({ name: 'project config', ok: true, required: false, detail: `${relCfg} (theme: ${cfg.theme ?? 'clean'})` });
      } catch (e) {
        const lines = (e as Error).message.split('\n').map((l) => l.trim()).filter(Boolean);
        const summary = lines.length > 1 ? `${lines[0]} ${lines[1]}` : (lines[0] ?? 'invalid config');
        checks.push({
          name: 'project config',
          ok: false,
          required: false,
          detail: summary,
          fix: `fix ${relCfg}, or set LINEWORK_NO_CONFIG=1 to ignore it`,
        });
      }
    }
  }

  const envFlags = (['LINEWORK_CHROME', 'LINEWORK_NO_CONFIG', 'LINEWORK_NO_DAEMON', 'LINEWORK_NO_CACHE', 'LINEWORK_ROOT'] as const)
    .filter((k) => !!process.env[k])
    .map((k) => `${k}=${process.env[k]}`);
  if (envFlags.length) {
    checks.push({ name: 'env overrides', ok: true, required: false, detail: envFlags.join(', ') });
  }

  let browser: Awaited<ReturnType<typeof DrawioBrowser.launch>> | undefined;
  try {
    const t = Date.now();
    browser = await DrawioBrowser.launch();
    checks.push({ name: 'browser', ok: true, required: true, detail: `${browser.engine} (started in ${Date.now() - t}ms)` });
  } catch (e) {
    const [first, ...rest] = (e as Error).message.split('\n');
    const sandboxed = /could not start/.test(first!);
    checks.push({
      name: 'browser',
      ok: false,
      required: true,
      detail: first!,
      fix: sandboxed ? 'run "linework install-browser" once outside the sandbox, or let this command run outside it' : 'linework install-browser\nor install Chrome, Edge or Chromium\nor set LINEWORK_CHROME=/path/to/browser',
    });
    const tried = rest.find((l) => l.startsWith('(tried:'));
    if (tried) checks.push({ name: 'browser attempts', ok: false, required: false, detail: tried });
  }

  if (browser) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-doctor-'));
    try {
      const { build } = await import('./api.js');
      const t = Date.now();
      const res = await build(SELF_TEST, { out: path.join(tmp, 'test.drawio.svg'), png: path.join(tmp, 'test.png'), browser });
      const errors = res.check.findings.filter((f) => f.level === 'error');
      const png = fs.statSync(path.join(tmp, 'test.png')).size;
      if (errors.length || res.check.stats.nodes !== 2 || png < 500) throw new Error(errors[0]?.message ?? `the test diagram came out wrong (${res.check.stats.nodes} nodes, ${png} byte PNG)`);
      checks.push({ name: 'test build', ok: true, required: true, detail: `2 boxes, 1 edge, SVG and PNG in ${Date.now() - t}ms` });
    } catch (e) {
      checks.push({ name: 'test build', ok: false, required: true, detail: (e as Error).message.split('\n')[0]!, fix: 'run "linework daemon stop" and try again; if it still fails, report it with this output' });
    } finally {
      await browser.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  const d = await import('./daemon.js');
  const sock = d.daemonAllowed() ? d.socketPath() : undefined;
  checks.push({
    name: 'background process',
    ok: true,
    required: false,
    detail: !d.daemonAllowed() ? 'off (LINEWORK_NO_DAEMON, CI or Windows): every build starts its own browser' : sock && (await d.daemonAlive()) ? `running at ${sock}` : 'not running; the next build starts it',
  });

  for (const c of checks) if (c.ok) delete c.fix;
  return { ok: checks.every((c) => c.ok || !c.required), version, checks };
}
