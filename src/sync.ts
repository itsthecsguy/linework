// Keep diagrams in step with the YAML specs beside them: docs/arch.yaml builds
// docs/arch.drawio.svg. Every build records which spec it was built from, so a
// diagram is out of date exactly when its YAML has changed since. Moving boxes
// around in draw.io doesn't make it so; editing the YAML does.
import fs from 'node:fs';
import path from 'node:path';
import { build, specStamp, type BuildResult } from './api.js';
import { useConfigFor } from './config.js';
import { readSpecStamp } from './drawio/read.js';
import type { DrawioBrowser } from './render/browser.js';
import { DIAGRAM_TYPES } from './spec/model.js';

export interface SyncItem {
  spec: string;
  out: string;
  /** fresh: built from this spec already. built: was missing or out of date, now rebuilt. stale: out of date, and --check left it. */
  state: 'fresh' | 'built' | 'stale' | 'failed';
  missing?: boolean;
  error?: string;
  result?: BuildResult;
}

const SKIP = new Set(['node_modules', '.git', 'dist', '.github']);
const SPEC_RE = new RegExp(`^type:\\s*["']?(${DIAGRAM_TYPES.join('|')})["']?\\s*(#.*)?$`, 'm');

/** YAML files under the given files and folders that are linework specs, each with the diagram it builds. */
export function findSpecs(roots: string[]): Array<{ spec: string; out: string }> {
  const out: Array<{ spec: string; out: string }> = [];
  const visited = new Set<string>();
  const visit = (p: string, top: boolean) => {
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat) {
      if (top) throw new Error(`${p} doesn't exist`);
      return;
    }
    if (stat.isDirectory()) {
      if (!top && (SKIP.has(path.basename(p)) || path.basename(p).startsWith('.'))) return;
      let real: string;
      try {
        real = fs.realpathSync(p);
      } catch {
        return;
      }
      if (visited.has(real)) return;
      visited.add(real);
      for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name), false);
      return;
    }
    if (!/\.ya?ml$/i.test(p)) {
      if (top) throw new Error(`${p} isn't a YAML spec`);
      return;
    }
    const target = p.replace(/\.ya?ml$/i, '.drawio.svg');
    // A YAML file named on the command line is a spec. One found in a folder has to look like one.
    if (top || fs.existsSync(target) || SPEC_RE.test(fs.readFileSync(p, 'utf8'))) out.push({ spec: p, out: target });
  };
  for (const r of roots.length ? roots : ['.']) visit(r, true);
  return out;
}

export async function sync(
  roots: string[],
  opts: { check?: boolean; browser?: DrawioBrowser | (() => Promise<DrawioBrowser>) } = {},
): Promise<SyncItem[]> {
  let browser: DrawioBrowser | undefined = typeof opts.browser === 'function' ? undefined : opts.browser;
  let ownedBrowser: DrawioBrowser | undefined;
  const getBrowser = async (): Promise<DrawioBrowser> => {
    if (browser) return browser;
    if (typeof opts.browser === 'function') {
      browser = await opts.browser();
      return browser;
    }
    const { DrawioBrowser: Ctor } = await import('./render/browser.js');
    ownedBrowser = await Ctor.launch();
    browser = ownedBrowser;
    return browser;
  };
  const items: SyncItem[] = [];
  try {
    for (const { spec, out } of findSpecs(roots)) {
      const item: SyncItem = { spec, out, state: 'fresh' };
      items.push(item);
      try {
        useConfigFor(out);
        const text = fs.readFileSync(spec, 'utf8');
        const want = specStamp(text);
        let existing: string | undefined;
        try {
          existing = fs.readFileSync(out, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        item.missing = existing === undefined;
        const has = existing !== undefined ? readSpecStamp(existing) : undefined;
        if (has === want) continue;
        if (opts.check) {
          item.state = 'stale';
          continue;
        }
        item.result = await build(text, { out, base: existing, browser: await getBrowser() });
        item.state = 'built';
      } catch (e) {
        item.state = 'failed';
        item.error = (e as Error).message;
      }
    }
  } finally {
    if (ownedBrowser) await ownedBrowser.close();
  }
  return items;
}
