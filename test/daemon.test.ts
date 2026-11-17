// The background process: the first drawing command starts it, later ones use it.
// Needs Chromium and Unix sockets. Set LINEWORK_SKIP_E2E=1 to skip.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const skip = process.env.LINEWORK_SKIP_E2E === '1' || process.platform === 'win32' || !fs.existsSync('dist/cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-'));
// Its own socket folder, so the test never talks to a developer's running process.
const env = { ...process.env, XDG_RUNTIME_DIR: tmp, CI: '', LINEWORK_NO_DAEMON: '' };
const cli = (args: string[], input?: string) => spawnSync(process.execPath, [path.resolve('dist/cli.js'), ...args], { env, input, encoding: 'utf8', cwd: tmp });
const sockets = () => (fs.existsSync(path.join(tmp, 'linework')) ? fs.readdirSync(path.join(tmp, 'linework')).filter((f) => f.endsWith('.sock')) : []);

afterAll(() => {
  cli(['daemon', 'stop']);
});

describe.runIf(!skip)('background process', () => {
  const spec = fs.existsSync('examples/checkout.yaml') ? fs.readFileSync('examples/checkout.yaml', 'utf8') : '';
  let own = '';

  it('starts after the first build and gives the same file from then on', async () => {
    const first = cli(['build', '-', '-o', 'a.drawio.svg'], spec);
    expect(first.status).toBe(0);
    for (let i = 0; i < 100 && !sockets().length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(sockets()).toHaveLength(1);
    own = sockets()[0]!;
    expect(cli(['daemon', 'status']).stdout).toMatch(/^running/);

    const second = cli(['build', '-', '-o', 'b.drawio.svg'], spec);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/check: 0 errors/);
    // Relative paths resolve against the caller's folder, not the process's.
    expect(fs.readFileSync(path.join(tmp, 'b.drawio.svg'), 'utf8')).toBe(fs.readFileSync(path.join(tmp, 'a.drawio.svg'), 'utf8'));
  }, 60000);

  it('reports errors and exit codes the same way', () => {
    const bad = cli(['build', '-', '-o', 'bad.drawio.svg'], 'type: flow\nnodes: { a: A }\nedges:\n  - a -> zz\n');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/spec error:\n\s+edges\[0\]/);
    expect(cli(['set', 'a.drawio.svg', 'nope.label=x']).status).toBe(2);
  }, 30000);

  it('stops on request and cleans up its socket', async () => {
    expect(cli(['daemon', 'stop']).stdout.trim()).toBe('stopped');
    for (let i = 0; i < 50 && sockets().length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(sockets()).toEqual([]);
    // A socket nobody answers (its process was killed) is not a running process.
    const dead = path.join(tmp, 'linework', own);
    const stale = spawnSync(process.execPath, ['-e', `const net=require('net');const s=net.createServer().listen(${JSON.stringify(dead)},()=>{console.log(1);setTimeout(()=>process.kill(process.pid,'SIGKILL'),50)})`]);
    expect(stale.stdout.toString()).toContain('1');
    expect(fs.existsSync(dead)).toBe(true);
    expect(cli(['daemon', 'status']).stdout).toMatch(/^not running/);
    expect(fs.existsSync(dead)).toBe(false);
  }, 30000);
});

// Its own folder and a short idle time, so these never meet the process above.
describe.runIf(!skip)('background process: staying healthy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-'));
  const env2 = { ...env, XDG_RUNTIME_DIR: dir, LINEWORK_DAEMON_IDLE: '3' };
  const run = (args: string[], input?: string) => spawnSync(process.execPath, [path.resolve('dist/cli.js'), ...args], { env: env2, input, encoding: 'utf8', cwd: dir });
  const socks = () => (fs.existsSync(path.join(dir, 'linework')) ? fs.readdirSync(path.join(dir, 'linework')).filter((f) => f.endsWith('.sock')) : []);
  const until = async (ok: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end && !ok(); ) await new Promise((r) => setTimeout(r, 100));
    return ok();
  };
  const spec = fs.existsSync('examples/checkout.yaml') ? fs.readFileSync('examples/checkout.yaml', 'utf8') : '';
  const start = async () => {
    expect(run(['build', '-', '-o', 'a.drawio.svg'], spec).status).toBe(0);
    expect(await until(() => socks().length === 1, 10000)).toBe(true);
  };
  afterAll(() => void run(['daemon', 'stop']));

  it('still exits when idle after a connection that asked for nothing', async () => {
    await start();
    // What a second process does to see whether this one is alive.
    await new Promise<void>((resolve, reject) => {
      const c = net.createConnection(path.join(dir, 'linework', socks()[0]!));
      c.once('connect', () => (c.destroy(), resolve()));
      c.once('error', reject);
    });
    expect(await until(() => socks().length === 0, 12000)).toBe(true);
  }, 40000);

  it.runIf(process.platform === 'linux')('gives way to a new one when its browser dies', async () => {
    await start();
    // The process whose environment names this test's folder, and the browser it started.
    const mine = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
      try {
        return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('daemon\0run') && fs.readFileSync(`/proc/${p}/environ`, 'utf8').includes(`XDG_RUNTIME_DIR=${dir}`);
      } catch {
        return false;
      }
    });
    expect(mine).toHaveLength(1);
    const children = spawnSync('pgrep', ['-P', mine[0]!], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    expect(children.length).toBeGreaterThan(0);
    for (const pid of children) process.kill(Number(pid), 'SIGKILL');
    expect(await until(() => socks().length === 0, 10000)).toBe(true);
    // The next command draws on its own and starts a fresh one.
    const again = run(['build', '-', '-o', 'b.drawio.svg'], spec);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/check: 0 errors/);
  }, 60000);
});
