// The background process: the first drawing command starts it, later ones use it.
// Needs Chromium and Unix sockets. Set LINEWORK_SKIP_E2E=1 to skip.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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

  it('starts after the first build and gives the same file from then on', async () => {
    const first = cli(['build', '-', '-o', 'a.drawio.svg'], spec);
    expect(first.status).toBe(0);
    for (let i = 0; i < 100 && !sockets().length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(sockets()).toHaveLength(1);
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
  }, 30000);
});
