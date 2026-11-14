// Keep diagrams in step with the YAML specs beside them: docs/arch.yaml builds
// docs/arch.drawio.svg. Every build records which spec it was built from, so a
// diagram is out of date exactly when its YAML has changed since. Moving boxes
// around in draw.io doesn't make it so; editing the YAML does.
import fs from 'node:fs';
import path from 'node:path';
import { build, specStamp, type BuildResult } from './api.js';
import { readDrawio } from './drawio/read.js';
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
  const visit = (p: string, top: boolean) => {
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat) {
      if (top) throw new Error(`${p} doesn't exist`);
      return;
    }
    if (stat.isDirectory()) {
      if (!top && (SKIP.has(path.basename(p)) || path.basename(p).startsWith('.'))) return;
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

export async function sync(roots: string[], opts: { check?: boolean; browser?: DrawioBrowser } = {}): Promise<SyncItem[]> {
  const items: SyncItem[] = [];
  for (const { spec, out } of findSpecs(roots)) {
    const item: SyncItem = { spec, out, state: 'fresh' };
    items.push(item);
    try {
      const text = fs.readFileSync(spec, 'utf8');
      const want = specStamp(text);
      const has = fs.existsSync(out) ? readDrawio(fs.readFileSync(out, 'utf8')).meta.aiviz_spec : undefined;
      item.missing = !fs.existsSync(out);
      if (has === want) continue;
      if (opts.check) {
        item.state = 'stale';
        continue;
      }
      item.result = await build(text, { out, browser: opts.browser });
      item.state = 'built';
    } catch (e) {
      item.state = 'failed';
      item.error = (e as Error).message;
    }
  }
  return items;
}
