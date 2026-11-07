// Bundled fonts. The headless browser measures and renders with them, and every
// SVG gets a subset of the faces it uses (only the glyphs in its text), so a
// diagram looks the same on GitHub, in a browser and in a doc, and text that fit
// when linework sized the boxes still fits wherever it is shown.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import subsetFont from 'subset-font';
import { assetsDir } from './browser.js';

export interface Face {
  family: string;
  weight: number;
  file: string;
}

export const FACES: Face[] = [
  { family: 'IBM Plex Sans', weight: 400, file: 'plex-sans-400.woff2' },
  { family: 'IBM Plex Sans', weight: 600, file: 'plex-sans-600.woff2' },
  { family: 'Kalam', weight: 400, file: 'kalam-400.woff2' },
  { family: 'Kalam', weight: 700, file: 'kalam-700.woff2' },
  { family: 'IBM Plex Mono', weight: 400, file: 'plex-mono-400.woff2' },
  { family: 'IBM Plex Mono', weight: 600, file: 'plex-mono-600.woff2' },
];

export function fontsDir(): string {
  return path.join(path.dirname(assetsDir()), 'fonts');
}

/** @font-face rules pointing at the font files, for pages that can fetch them. */
export function fontFaceCss(url: (file: string) => string): string {
  return FACES.map((f) => `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;src:url(${url(f.file)}) format("woff2");}`).join('\n');
}

const cache = new Map<string, Buffer>();
const read = (f: Face) => {
  let b = cache.get(f.file);
  if (!b) cache.set(f.file, (b = fs.readFileSync(path.join(fontsDir(), f.file))));
  return b;
};

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m),
  );

const STYLE_RE = /<style id="aiviz-fonts"[^>]*>[\s\S]*?<\/style>/g;

/** Families from FACES that the SVG asks for. */
export function familiesIn(svg: string): string[] {
  const used = new Set<string>();
  for (const m of svg.matchAll(/font-family(?:\s*:\s*|=")(?:&quot;|["'])?([^,;"'&<]+)/g)) used.add(m[1]!.trim());
  return [...new Set(FACES.map((f) => f.family))].filter((f) => used.has(f));
}

/**
 * Put subset copies of the bundled fonts the SVG uses into its <defs>. Replaces
 * a previous embed, so it's safe to run on a file again after an edit.
 */
export async function embedFonts(svg: string): Promise<string> {
  svg = svg.replace(STYLE_RE, '');
  const families = familiesIn(svg);
  if (!families.length) return svg;
  let text = '';
  for (const m of svg.matchAll(/>([^<>]+)</g)) text += decode(m[1]!);
  // Blueprint's group titles use CSS text-transform, so they need the capitals too.
  text = [...new Set(text + text.toUpperCase() + ' ')].join('');
  const rules: string[] = [];
  for (const f of FACES.filter((x) => families.includes(x.family))) {
    const sub = await subset(f, text);
    rules.push(`@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;src:url(data:font/woff2;base64,${sub.toString('base64')}) format("woff2");}`);
  }
  const style = `<style id="aiviz-fonts" type="text/css">${rules.join('')}</style>`;
  if (/<defs\s*\/>/.test(svg)) return svg.replace(/<defs\s*\/>/, `<defs>${style}</defs>`);
  if (/<defs[^>]*>/.test(svg)) return svg.replace(/<defs[^>]*>/, (m) => m + style);
  return svg.replace(/<svg\b[^>]*>/, (m) => `${m}<defs>${style}</defs>`);
}

// ---------- subset cache ----------
//
// Compressing a subset to WOFF2 is most of embedFonts' time, and rebuilding a
// diagram after a small edit usually needs the same characters again. A subset
// depends only on the font file and the set of characters (not their order), so
// that pair is the key. Kept in memory and in the user's own cache folder, never
// a shared temp dir: whatever is there ends up inside the SVGs.

const memo = new Map<string, Buffer>();
const fileHash = new Map<string, string>();

/** Drop the in-memory copies, so the next lookup reads the disk cache. For tests. */
export function forgetSubsets(): void {
  memo.clear();
}

function cacheDir(): string | undefined {
  if (process.env.LINEWORK_NO_CACHE) return undefined;
  const home = os.homedir();
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'darwin' ? path.join(home, 'Library', 'Caches') : process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') : path.join(home, '.cache'));
  return path.join(base, 'linework', 'fonts');
}

async function subset(f: Face, text: string): Promise<Buffer> {
  const font = read(f);
  let fh = fileHash.get(f.file);
  if (!fh) fileHash.set(f.file, (fh = crypto.createHash('sha256').update(font).digest('hex')));
  const chars = [...new Set(text)].sort().join('');
  const key = crypto.createHash('sha256').update(`${fh}\0${chars}`).digest('hex').slice(0, 32);
  const hit = memo.get(key);
  if (hit) return hit;
  const dir = cacheDir();
  const file = dir && path.join(dir, `${key}.woff2`);
  let out: Buffer | undefined;
  try {
    const b = file ? fs.readFileSync(file) : undefined;
    // A WOFF2 file starts with its signature; anything else is a broken write.
    if (b && b.subarray(0, 4).toString('latin1') === 'wOF2') out = b;
  } catch {
    // not cached yet
  }
  if (!out) {
    out = await subsetFont(font, text, { targetFormat: 'woff2' });
    if (file) {
      try {
        fs.mkdirSync(dir!, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, file);
      } catch {
        // A read-only or full disk only costs the cache.
      }
    }
  }
  if (memo.size >= 64) memo.delete(memo.keys().next().value!);
  memo.set(key, out);
  return out;
}
