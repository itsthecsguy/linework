// `aiviz git-setup`: make `git diff` show diagram changes as spec changes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PATTERNS = ['*.drawio.svg diff=aiviz', '*.drawio diff=aiviz'];

function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The command git should run. Prefer a stable name over this machine's paths. */
export function aivizCommand(): string {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (onPath('aiviz')) return 'aiviz';
  if (cli.includes(`${path.sep}_npx${path.sep}`)) return 'npx -y aiviz';
  return `"${process.execPath}" "${cli.replace(/\.ts$/, '.js').replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`)}"`;
}

export function gitSetup(cwd = process.cwd()): string[] {
  let top: string;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('not inside a git repository');
  }
  const done: string[] = [];
  const attrs = path.join(top, '.gitattributes');
  const existing = fs.existsSync(attrs) ? fs.readFileSync(attrs, 'utf8') : '';
  const missing = PATTERNS.filter((p) => !existing.split('\n').some((l) => l.trim() === p));
  if (missing.length) {
    fs.writeFileSync(attrs, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
    done.push(`added to .gitattributes: ${missing.join(', ')}`);
  }
  const cmd = `${aivizCommand()} show --geometry --quiet`;
  execFileSync('git', ['config', 'diff.aiviz.textconv', cmd], { cwd: top });
  execFileSync('git', ['config', 'diff.aiviz.cachetextconv', 'true'], { cwd: top });
  done.push(`set git config diff.aiviz.textconv to: ${cmd}  (this repo only)`);
  return done;
}
