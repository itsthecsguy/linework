// Run something each time a file is saved. Editors save in different ways
// (write in place, or write a temp file and rename it over the old one), so
// this watches the folder and looks at the file itself to decide.
import fs from 'node:fs';
import path from 'node:path';

export interface Watching {
  /** Resolves when watching stops. */
  done: Promise<void>;
  stop(): void;
}

export interface WatchOptions {
  settle?: number;
  /** Additional files to watch (e.g. linework.yaml). Changes trigger onSave. */
  extra?: string[];
  /** Called if an underlying filesystem watcher emits an error. */
  onError?: (e: Error) => void;
}

const MAX_RETRIES = 3;
const RETRY_MS = 150;

export function watchFile(file: string, onSave: () => Promise<void>, opts: WatchOptions = {}): Watching {
  const full = path.resolve(file);
  const targets = [full, ...new Set((opts.extra ?? []).map((p) => path.resolve(p)).filter((p) => p !== full))];
  const stampOf = (p: string) => {
    try {
      const s = fs.statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '';
    }
  };
  const snapshot = () => targets.map(stampOf);
  let last = snapshot();
  let timer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retries = 0;
  let running = false, again = false, stopped = false;
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));

  const run = async () => {
    if (stopped) return;
    if (running) return void (again = true);
    const now = snapshot();
    const mainNow = now[0]!;
    // Primary file gone (mid-rename) or empty (mid-write): retry a few times in case no trailing event arrives.
    if (!mainNow || mainNow.endsWith(':0')) {
      if (retries < MAX_RETRIES) {
        retries++;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => void run(), RETRY_MS);
      }
      return;
    }
    const extraMidWrite = now.slice(1).some((s, idx) => s.endsWith(':0') && !!last[idx + 1]);
    if (extraMidWrite && retries < MAX_RETRIES) {
      retries++;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void run(), RETRY_MS);
      return;
    }
    retries = 0;
    if (now.every((s, idx) => s === last[idx])) return;
    last = now;
    running = true;
    try {
      await onSave();
    } finally {
      running = false;
      if (again) {
        again = false;
        void run();
      }
    }
  };

  const byDir = new Map<string, Set<string>>();
  for (const t of targets) {
    const dir = path.dirname(t);
    let names = byDir.get(dir);
    if (!names) byDir.set(dir, (names = new Set()));
    names.add(path.basename(t));
  }
  const watchers: fs.FSWatcher[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    finish();
  };
  try {
    for (const [dir, names] of byDir) {
      const watcher = fs.watch(dir, (_event, name) => {
        if (name && !names.has(name.toString())) return;
        retries = 0;
        clearTimeout(retryTimer);
        clearTimeout(timer);
        timer = setTimeout(() => void run(), opts.settle ?? 200);
      });
      watcher.on('error', (err) => {
        opts.onError?.(err);
        stop();
      });
      watchers.push(watcher);
    }
  } catch (e) {
    stop();
    throw e;
  }
  return { done, stop };
}
