#!/usr/bin/env node
import module from 'node:module';
import { parseArgs } from 'node:util';

// Node 22.1+ can keep compiled bytecode for linework's modules on disk, which
// takes about a quarter off loading them on every run after the first. Older
// Node has no such call. NODE_DISABLE_COMPILE_CACHE=1 turns it off.
(module as { enableCompileCache?: () => unknown }).enableCompileCache?.();

async function main(argv: string[]): Promise<void> {
  const { OPTIONS, USAGE, needsBrowser, run, report, processIO } = await import('./commands.js');
  const [cmd, ...rest] = argv;
  if (cmd === 'daemon') return daemon(rest[0]);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    process.exitCode = report(e);
    return;
  }
  const { values, positionals } = parsed;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || values.help) return void process.stdout.write(USAGE);

  const draws = needsBrowser(cmd, values);
  // A custom render scale needs its own page, so that one runs here.
  const shareable = draws && !(cmd === 'render' && values.scale) && !values['no-daemon'];
  if (shareable) {
    // Chromium, draw.io and ELK may already be warm in the background process.
    const { viaDaemon } = await import('./daemon.js');
    const stdin = positionals[0] === '-' && (cmd === 'build' || cmd === 'import') ? processIO.stdin() : undefined;
    const code = await viaDaemon({ argv, cwd: process.cwd(), stdin }, processIO.out, processIO.err);
    if (code !== undefined) return exitWhenFlushed(code);
    if (stdin !== undefined) processIO.stdin = () => stdin;
  }

  // Commands that draw start Chromium first and load the rest of linework while it
  // boots and loads draw.io: the two take about the same time, so they overlap.
  const launching = draws ? import('./render/browser.js').then((m) => m.DrawioBrowser.launch({ scale: cmd === 'render' && values.scale ? Number(values.scale) : 2 })) : undefined;
  // A failure here surfaces where the browser is awaited; don't report it twice.
  launching?.catch(() => {});
  let failed = false;
  try {
    await run(cmd, values, positionals, launching);
  } catch (e) {
    failed = true;
    process.exitCode = report(e);
  } finally {
    if (launching) await (await launching.catch(() => undefined))?.close();
  }
  // The next drawing command finds the browser already running.
  if (shareable && !failed) (await import('./daemon.js')).startDaemon();
  // The font subsetter's WebAssembly keeps node alive for ~100ms after the work
  // is done, with nothing left to run. A drawing command is finished here.
  if (launching) await exitWhenFlushed(Number(process.exitCode ?? 0));
}

async function daemon(sub: string | undefined): Promise<void> {
  const d = await import('./daemon.js');
  if (sub === 'run') return d.serve();
  if (sub === 'stop') return void console.log((await d.stopDaemon()) ? 'stopped' : 'not running');
  if (sub === 'status' || !sub) {
    const sock = d.daemonAllowed() ? d.socketPath() : undefined;
    const fs = await import('node:fs');
    return void console.log(!sock ? 'off (LINEWORK_NO_DAEMON, CI or Windows)' : fs.existsSync(sock) ? `running at ${sock}` : 'not running; the next build starts it');
  }
  console.error('usage: linework daemon [status|stop]');
  process.exitCode = 2;
}

function exitWhenFlushed(code: number): Promise<never> {
  return new Promise(() => {
    let pending = 2;
    const done = () => --pending === 0 && process.exit(code);
    process.stdout.write('', done);
    process.stderr.write('', done);
  });
}

main(process.argv.slice(2)).catch(async (e) => {
  const { report } = await import('./commands.js');
  process.exit(report(e));
});
