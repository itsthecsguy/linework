// A background process that keeps Chromium, draw.io and ELK warm between builds.
// Starting those is most of a build: about 0.8s of a 1s run. The first drawing
// command starts this process as it exits; later ones hand their work to it and
// finish in a fraction of the time. It exits after a few idle minutes.
//
// It listens on a Unix socket in a folder only the user can open, and only runs
// the same commands the CLI runs. LINEWORK_NO_DAEMON=1 turns it off.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface Request {
  argv: string[];
  cwd: string;
  stdin?: string;
}
export type Reply = { t: 'out' | 'err'; d: string } | { t: 'exit'; code: number };

const IDLE_MS = Number(process.env.LINEWORK_DAEMON_IDLE ?? 300) * 1000;
const cliPath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');

/** Off on Windows (no Unix sockets with file permissions), in CI, and on request. */
export function daemonAllowed(): boolean {
  return process.platform !== 'win32' && !process.env.LINEWORK_NO_DAEMON && !process.env.CI && typeof process.getuid === 'function';
}

/**
 * The socket for this exact build of linework and this browser setting, so an
 * upgrade or a different LINEWORK_CHROME never talks to a stale process.
 * Undefined when no private folder can be had.
 */
export function socketPath(): string | undefined {
  const uid = process.getuid!();
  const dir = process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'linework') : path.join(os.tmpdir(), `linework-${uid}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    // Someone else's folder, or one others can write to, could hold a fake socket.
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) return undefined;
    let stamp = '';
    try {
      stamp = String(fs.statSync(cliPath()).mtimeMs);
    } catch {
      // running from source
    }
    const key = crypto.createHash('sha256').update([cliPath(), stamp, process.version, process.env.LINEWORK_CHROME ?? '', process.env.LINEWORK_NO_CACHE ?? ''].join('\0')).digest('hex').slice(0, 12);
    return path.join(dir, `${key}.sock`);
  } catch {
    return undefined;
  }
}

/**
 * Run a command in the background process. Resolves with its exit code, or
 * undefined when no such process is running (the caller then runs it itself).
 */
export function viaDaemon(req: Request, out: (t: string) => void, err: (t: string) => void): Promise<number | undefined> {
  const sock = daemonAllowed() ? socketPath() : undefined;
  if (!sock || !fs.existsSync(sock)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const c = net.createConnection(sock);
    let buf = '';
    let started = false;
    let code: number | undefined;
    // A process that died without cleaning up leaves a socket nobody answers.
    c.once('error', () => {
      if (!started) fs.rmSync(sock, { force: true });
      resolve(started ? 1 : undefined);
    });
    c.once('connect', () => c.write(JSON.stringify(req) + '\n'));
    c.setEncoding('utf8');
    c.on('data', (chunk: string) => {
      started = true;
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, i)) as Reply;
        buf = buf.slice(i + 1);
        if (msg.t === 'out') out(msg.d);
        else if (msg.t === 'err') err(msg.d);
        else if (msg.t === 'exit') code = msg.code;
      }
    });
    c.once('close', () => resolve(code ?? (started ? 1 : undefined)));
  });
}

/** Start the background process, detached, unless one is already listening. */
export function startDaemon(): void {
  if (!daemonAllowed()) return;
  const sock = socketPath();
  if (!sock || fs.existsSync(sock)) return;
  try {
    spawn(process.execPath, [cliPath(), 'daemon', 'run'], { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref();
  } catch {
    // No background process only costs speed.
  }
}

/** Ask a running background process to stop. Returns whether one was running. */
export async function stopDaemon(): Promise<boolean> {
  const code = await viaDaemon({ argv: ['daemon', 'stop'], cwd: process.cwd() }, () => {}, () => {});
  return code === 0;
}

/** The background process itself. Returns when it has shut down. */
export async function serve(): Promise<void> {
  const sock = daemonAllowed() ? socketPath() : undefined;
  if (!sock) return;
  // One per socket: if another answers, leave it to it.
  if (fs.existsSync(sock)) {
    const alive = await new Promise<boolean>((r) => {
      const c = net.createConnection(sock);
      c.once('connect', () => (c.destroy(), r(true)));
      c.once('error', () => r(false));
    });
    if (alive) return;
    fs.rmSync(sock, { force: true });
  }
  const { DrawioBrowser } = await import('./render/browser.js');
  const { run, warmUp, report, OPTIONS } = await import('./commands.js');
  const { parseArgs } = await import('node:util');
  const browser = await DrawioBrowser.launch({ scale: 2 });
  await warmUp();

  let idle: NodeJS.Timeout;
  let queue: Promise<unknown> = Promise.resolve();
  const server = net.createServer({ allowHalfOpen: true });
  const shutdown = async () => {
    clearTimeout(idle);
    server.close();
    fs.rmSync(sock, { force: true });
    await browser.close().catch(() => {});
    process.exit(0);
  };
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => void shutdown(), IDLE_MS);
  };

  server.on('connection', (c) => {
    clearTimeout(idle);
    c.setEncoding('utf8');
    c.on('error', () => {});
    let buf = '';
    c.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      const send = (m: Reply) => void (c.writable && c.write(JSON.stringify(m) + '\n'));
      // One command at a time: they share the page and the working directory.
      queue = queue.then(async () => {
        let code = 0;
        try {
          const req = JSON.parse(line) as Request;
          if (req.argv[0] === 'daemon' && req.argv[1] === 'stop') {
            send({ t: 'exit', code: 0 });
            c.end();
            return void shutdown();
          }
          const io = { out: (d: string) => send({ t: 'out', d }), err: (d: string) => send({ t: 'err', d }), stdin: () => req.stdin ?? '', code: 0, warm: true };
          try {
            process.chdir(req.cwd);
            const [cmd, ...rest] = req.argv;
            const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS });
            await run(cmd!, values, positionals, Promise.resolve(browser), io);
            code = io.code;
          } catch (e) {
            code = report(e, io);
          }
        } catch {
          code = 1;
        }
        send({ t: 'exit', code });
        c.end();
        arm();
      });
    });
  });
  // The socket is created with the folder's protection already in place.
  const mask = process.umask(0o077);
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(sock, resolve));
  process.umask(mask);
  arm();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(sig, () => void shutdown());
  await new Promise(() => {});
}
