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

export function watchFile(file: string, onSave: () => Promise<void>, opts: { settle?: number } = {}): Watching {
  const full = path.resolve(file);
  const stamp = () => {
    try {
      const s = fs.statSync(full);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '';
    }
  };
  let last = stamp();
  let timer: NodeJS.Timeout | undefined;
  let running = false, again = false, stopped = false;
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));

  const run = async () => {
    if (stopped) return;
    if (running) return void (again = true);
    const now = stamp();
    // Gone (mid-rename), empty (mid-write) or just as it was.
    if (!now || now.endsWith(':0') || now === last) return;
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
  const watcher = fs.watch(path.dirname(full), (_event, name) => {
    if (name && path.basename(full) !== name.toString()) return;
    clearTimeout(timer);
    timer = setTimeout(() => void run(), opts.settle ?? 200);
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    watcher.close();
    finish();
  };
  watcher.on('error', stop);
  return { done, stop };
}
