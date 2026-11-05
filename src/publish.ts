// `aiviz publish`: copy diagrams into a Google Drive folder synced by Google
// Drive for desktop, so draw.io's Google Docs add-on can insert them and later
// refresh them. Each file always lands at the same path, which keeps its Drive
// file id, so "Update diagrams" in Docs picks up new versions.
//
// Edits can come back the other way: someone opens the diagram from Docs in
// draw.io, which saves to the Drive copy. publish notices that the Drive copy
// changed since it wrote it, refuses to overwrite it, and `--pull` copies it back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MANIFEST = '.aiviz-publish.json';

export interface PublishItem {
  file: string;
  dest: string;
  action: 'published' | 'unchanged' | 'pulled' | 'conflict';
}

/** Google Drive for desktop folders on this machine. */
export function driveFolders(): string[] {
  const found: string[] = [];
  if (process.platform === 'darwin') {
    const cs = path.join(os.homedir(), 'Library', 'CloudStorage');
    if (fs.existsSync(cs))
      for (const d of fs.readdirSync(cs))
        if (d.startsWith('GoogleDrive-')) {
          const my = fs.readdirSync(path.join(cs, d)).find((n) => n === 'My Drive' || n === 'Meine Ablage' || /^my drive$/i.test(n));
          if (my) found.push(path.join(cs, d, my));
        }
  } else if (process.platform === 'win32') {
    for (const letter of 'GHIJKLMNOPQRSTUVWXYZ') {
      const p = `${letter}:\\My Drive`;
      if (fs.existsSync(p)) found.push(p);
    }
  }
  return found;
}

function projectName(cwd: string): string {
  try {
    return path.basename(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
  } catch {
    return path.basename(cwd);
  }
}

function projectRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return cwd;
  }
}

const sha = (buf: Buffer) => crypto.createHash('sha1').update(buf).digest('hex');

/**
 * Where publish writes. An explicit `to` is used as is. Otherwise the single
 * Google Drive folder on this machine, under aiviz/<project>.
 */
export function publishDir(to: string | undefined, cwd = process.cwd()): string {
  if (to) return path.resolve(cwd, to);
  if (process.env.AIVIZ_PUBLISH_DIR) return path.resolve(cwd, process.env.AIVIZ_PUBLISH_DIR);
  const drives = driveFolders();
  if (drives.length === 1) return path.join(drives[0]!, 'aiviz', projectName(cwd));
  if (drives.length > 1) throw new Error(`found several Google Drive folders; pick one with --to:\n${drives.map((d) => '  ' + d).join('\n')}`);
  throw new Error(
    'no Google Drive folder found. Install Google Drive for desktop (it syncs a local folder to Drive), or pass --to <folder> to publish into any synced folder.',
  );
}

export function publish(files: string[], opts: { to?: string; pull?: boolean; force?: boolean; cwd?: string } = {}): PublishItem[] {
  const cwd = opts.cwd ?? process.cwd();
  const dir = publishDir(opts.to, cwd);
  const root = projectRoot(cwd);
  const manifestPath = path.join(dir, MANIFEST);
  const manifest: Record<string, string> = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const items: PublishItem[] = [];
  for (const f of files) {
    const src = path.resolve(cwd, f);
    if (!fs.existsSync(src)) throw new Error(`${f} doesn't exist`);
    if (!/\.(drawio\.svg|drawio\.png|drawio|svg)$/.test(src)) throw new Error(`${f}: publish takes .drawio.svg or .drawio files`);
    // Keep the project's folder structure so two diagrams with the same name don't collide.
    const rel = path.relative(root, src).startsWith('..') ? path.basename(src) : path.relative(root, src);
    const dest = path.join(dir, rel);
    const key = rel.split(path.sep).join('/');
    const srcBuf = fs.readFileSync(src);
    const destBuf = fs.existsSync(dest) ? fs.readFileSync(dest) : undefined;
    // Changed in Drive since we last wrote it: someone edited it from Docs or Drive.
    const editedInDrive = !!destBuf && manifest[key] !== undefined && sha(destBuf) !== manifest[key];
    if (opts.pull) {
      if (!destBuf) throw new Error(`${dest} doesn't exist, so there is nothing to pull`);
      if (sha(destBuf) !== sha(srcBuf)) {
        fs.writeFileSync(src, destBuf);
        items.push({ file: src, dest, action: 'pulled' });
      } else items.push({ file: src, dest, action: 'unchanged' });
      manifest[key] = sha(destBuf);
      continue;
    }
    if (editedInDrive && sha(destBuf!) !== sha(srcBuf) && !opts.force) {
      items.push({ file: src, dest, action: 'conflict' });
      continue;
    }
    if (destBuf && sha(destBuf) === sha(srcBuf)) {
      manifest[key] = sha(srcBuf);
      items.push({ file: src, dest, action: 'unchanged' });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Overwrite in place (not delete and recreate) so Drive keeps the same file id.
    fs.writeFileSync(dest, srcBuf);
    manifest[key] = sha(srcBuf);
    items.push({ file: src, dest, action: 'published' });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return items;
}
