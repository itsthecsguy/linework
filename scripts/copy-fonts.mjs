// Copies the bundled fonts from @fontsource packages into assets/fonts.
// linework measures text with these and embeds a subset of them in every SVG,
// so text renders the same everywhere and always fits its box.
// Usage: node scripts/copy-fonts.mjs
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('assets/fonts');
const faces = [
  ['ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2', 'plex-sans-400.woff2'],
  ['ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2', 'plex-sans-600.woff2'],
  ['kalam', 'kalam-latin-400-normal.woff2', 'kalam-400.woff2'],
  ['kalam', 'kalam-latin-700-normal.woff2', 'kalam-700.woff2'],
  ['ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2', 'plex-mono-400.woff2'],
  ['ibm-plex-mono', 'ibm-plex-mono-latin-600-normal.woff2', 'plex-mono-600.woff2'],
];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [pkg, file, name] of faces) fs.copyFileSync(path.resolve('node_modules/@fontsource', pkg, 'files', file), path.join(out, name));
for (const pkg of new Set(faces.map((f) => f[0]))) fs.copyFileSync(path.resolve('node_modules/@fontsource', pkg, 'LICENSE'), path.join(out, `${pkg}-LICENSE.txt`));
console.log(`copied ${faces.length} font files to assets/fonts`);
