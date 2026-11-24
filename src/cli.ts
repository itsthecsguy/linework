#!/usr/bin/env node
import module from 'node:module';
import { parseArgs } from 'node:util';
import type { DrawioBrowser } from './render/browser.js';

// Node 22.1+ can keep compiled bytecode for linework's modules on disk, which
// takes about a quarter off loading them on every run after the first. Older
// Node has no such call. NODE_DISABLE_COMPILE_CACHE=1 turns it off.
(module as { enableCompileCache?: () => unknown }).enableCompileCache?.();

async function main(argv: string[]): Promise<void> {
  const { OPTIONS, USAGE, needsBrowser, renderScale, run, report, processIO } = await import('./commands.js');
  const [cmd, ...rest] = argv;
  if (cmd === 'daemon') return daemon(rest[0]);
  if (cmd === '--version' || cmd === '-v' || cmd === '-V') return void console.log((await import('./commands.js')).packageVersion());
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    process.exitCode = report(e, processIO, rest.includes('--json'));
    return;
  }
  const { values, positionals } = parsed;
  let scale = 2;
  try {
    if (cmd === 'render' && values.scale !== undefined) scale = renderScale(values.scale);
  } catch (e) {
    process.exitCode = report(e, processIO, values.json);
    return;
  }
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || values.help) return void process.stdout.write(USAGE);

  const draws = needsBrowser(cmd, values, positionals);
  // A custom render scale needs its own page, so that one runs here.
  // So does anything that keeps running, or that can take minutes.
  const shareable = draws && !(cmd === 'render' && values.scale) && !values['no-daemon'] && !values.watch && cmd !== 'library';
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
  // `sync` defers launch via a lazy factory so an all-fresh sync never boots Chromium.
  const lazy = draws && cmd === 'sync';
  let launching: Promise<DrawioBrowser> | undefined =
    draws && !lazy ? import('./render/browser.js').then((m) => m.DrawioBrowser.launch({ scale })) : undefined;
  // A failure here surfaces where the browser is awaited; don't report it twice.
  launching?.catch(() => {});
  const getBrowser = lazy
    ? () => {
        if (!launching) {
          launching = import('./render/browser.js').then((m) => m.DrawioBrowser.launch({ scale }));
          launching.catch(() => {});
        }
        return launching;
      }
    : undefined;
  let failed = false;
  try {
    await run(cmd, values, positionals, getBrowser ?? launching);
  } catch (e) {
    failed = true;
    process.exitCode = report(e, processIO, values.json);
  } finally {
    if (launching) await (await launching.catch(() => undefined))?.close();
  }
  // The next drawing command finds the browser already running.
  if (shareable && !failed && launching) (await import('./daemon.js')).startDaemon();
  // The font subsetter's WebAssembly keeps node alive for ~100ms after the work
  // is done, with nothing left to run. A drawing command is finished here.
  if (launching) await exitWhenFlushed(Number(process.exitCode ?? 0));
}

async function daemon(sub: string | undefined): Promise<void> {
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(
      'usage: linework daemon [status|stop]\n\nBuilds after the first reuse a background process that keeps the browser running.\nIt exits after 5 idle minutes. Turn it off with LINEWORK_NO_DAEMON=1 or --no-daemon.',
    );
    return;
  }
  const d = await import('./daemon.js');
  if (sub === 'run') return d.serve();
  if (sub === 'stop') return void console.log((await d.stopDaemon()) ? 'stopped' : 'not running');
  if (sub === 'status' || !sub) {
    const sock = d.daemonAllowed() ? d.socketPath() : undefined;
    return void console.log(!sock ? 'off (LINEWORK_NO_DAEMON, CI or Windows)' : (await d.daemonAlive()) ? `running at ${sock}` : 'not running; the next build starts it');
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
  const { report, processIO } = await import('./commands.js');
  process.exit(report(e, processIO, process.argv.includes('--json')));
});
