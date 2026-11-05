// Bundled fonts. The headless browser measures and renders with them, and every
// SVG gets a subset of the faces it uses (only the glyphs in its text), so a
// diagram looks the same on GitHub, in a browser and in a doc, and text that fit
// when aiviz sized the boxes still fits wherever it is shown.
import fs from 'node:fs';
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
    const sub = await subsetFont(read(f), text, { targetFormat: 'woff2' });
    rules.push(`@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;src:url(data:font/woff2;base64,${sub.toString('base64')}) format("woff2");}`);
  }
  const style = `<style id="aiviz-fonts" type="text/css">${rules.join('')}</style>`;
  if (/<defs\s*\/>/.test(svg)) return svg.replace(/<defs\s*\/>/, `<defs>${style}</defs>`);
  if (/<defs[^>]*>/.test(svg)) return svg.replace(/<defs[^>]*>/, (m) => m + style);
  return svg.replace(/<svg\b[^>]*>/, (m) => `${m}<defs>${style}</defs>`);
}
