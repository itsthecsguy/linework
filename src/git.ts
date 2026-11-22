// `linework git-setup`: make `git diff` show diagram changes as spec changes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PATTERNS = ['*.drawio.svg diff=linework', '*.drawio diff=linework'];

function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Shell-quote an argument for git's POSIX sh textconv runner (converting Windows backslashes). */
export function shellQuote(s: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? s.replace(/\\/g, '/') : s;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** The command git should run. Prefer a stable name over this machine's paths. */
export function cliCommand(opts?: { execPath?: string; cliPath?: string; platform?: NodeJS.Platform; hasLinework?: boolean }): string {
  const platform = opts?.platform ?? process.platform;
  const sep = platform === 'win32' ? '\\' : '/';
  const cli = opts?.cliPath ?? fileURLToPath(new URL('./cli.js', import.meta.url));
  if (opts?.hasLinework ?? onPath('linework')) return 'linework';
  if (cli.includes(`${sep}_npx${sep}`)) return 'npx -y @itsthecsguy/linework';
  const execPath = opts?.execPath ?? process.execPath;
  const built = cli.replace(/\.ts$/, '.js').replace(`${sep}src${sep}`, `${sep}dist${sep}`);
  return `${shellQuote(execPath, platform)} ${shellQuote(built, platform)}`;
}

export function gitSetup(cwd = process.cwd()): string[] {
  let top: string;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error(`${cwd} isn't inside a git repository. Run git-setup in the repo whose diagrams you want readable diffs for.`);
  }
  const done: string[] = [];
  const attrs = path.join(top, '.gitattributes');
  const existing = fs.existsSync(attrs) ? fs.readFileSync(attrs, 'utf8') : '';
  const missing = PATTERNS.filter((p) => !existing.split('\n').some((l) => l.trim() === p));
  if (missing.length) {
    fs.writeFileSync(attrs, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
    done.push(`added to .gitattributes: ${missing.join(', ')}`);
  }
  const cmd = `${cliCommand()} show --geometry --quiet`;
  execFileSync('git', ['config', 'diff.linework.textconv', cmd], { cwd: top });
  execFileSync('git', ['config', 'diff.linework.cachetextconv', 'true'], { cwd: top });
  done.push(`set git config diff.linework.textconv to: ${cmd}  (this repo only)`);
  return done;
}
