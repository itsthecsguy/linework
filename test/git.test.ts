import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cliCommand, gitSetup, shellQuote } from '../src/git.js';

const temps: string[] = [];
const makeTemp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

describe('git-setup', () => {
  it('shell-quotes paths with spaces, quotes, dollar signs and Windows backslashes', () => {
    expect(shellQuote('/usr/local/bin/node', 'linux')).toBe("'/usr/local/bin/node'");
    expect(shellQuote("/home/o'brien/$proj/my dir/cli.js", 'linux')).toBe("'/home/o'\\''brien/$proj/my dir/cli.js'");
    expect(shellQuote('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe("'C:/Program Files/nodejs/node.exe'");
    expect(
      cliCommand({
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        cliPath: 'C:\\Users\\dev\\repo\\src\\cli.ts',
        platform: 'win32',
        hasLinework: false,
      }),
    ).toBe("'C:/Program Files/nodejs/node.exe' 'C:/Users/dev/repo/dist/cli.js'");
    expect(
      cliCommand({
        execPath: '/opt/my node/bin/node',
        cliPath: "/tmp/o'brien/$app/src/cli.ts",
        platform: 'linux',
        hasLinework: false,
      }),
    ).toBe("'/opt/my node/bin/node' '/tmp/o'\\''brien/$app/dist/cli.js'");
  });

  it('writes .gitattributes and configures diff.linework.textconv in a git repo', () => {
    const repo = makeTemp('linework-git-');
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });

    const first = gitSetup(repo);
    expect(first.some((l) => l.includes('.gitattributes'))).toBe(true);
    expect(first.some((l) => l.includes('diff.linework.textconv'))).toBe(true);

    const attrs = fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8');
    expect(attrs).toContain('*.drawio.svg diff=linework');
    expect(attrs).toContain('*.drawio diff=linework');

    const textconv = execFileSync('git', ['config', '--get', 'diff.linework.textconv'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(textconv).toMatch(/show --geometry --quiet$/);
    const cache = execFileSync('git', ['config', '--get', 'diff.linework.cachetextconv'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(cache).toBe('true');

    // Running again does not duplicate .gitattributes entries.
    const second = gitSetup(repo);
    expect(second.some((l) => l.includes('.gitattributes'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, '.gitattributes'), 'utf8')).toBe(attrs);
  });

  it('throws outside a git repository', () => {
    const nonRepo = makeTemp('linework-nogit-');
    expect(() => gitSetup(nonRepo)).toThrow(/isn't inside a git repository/);
  });
});
