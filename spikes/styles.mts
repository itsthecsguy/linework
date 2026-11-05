// Renders every example in every style into out/styles, for eyeballing.
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/api.js';
import { DrawioBrowser } from '../src/render/browser.js';
import { THEMES } from '../src/spec/model.js';

const only = process.argv.slice(2);
const themes = only.filter((a) => (THEMES as readonly string[]).includes(a));
const names = only.filter((a) => !themes.includes(a));
const b = await DrawioBrowser.launch();
fs.mkdirSync('out/styles', { recursive: true });
for (const f of fs.readdirSync('examples').filter((f) => f.endsWith('.yaml'))) {
  const name = f.replace('.yaml', '');
  if (names.length && !names.includes(name)) continue;
  const src = fs.readFileSync(path.join('examples', f), 'utf8');
  for (const t of themes.length ? themes : THEMES) {
    const spec = /^theme:/m.test(src) ? src.replace(/^theme:.*$/m, `theme: ${t}`) : src.replace(/^type:.*$/m, (m) => `${m}\ntheme: ${t}`);
    const out = `out/styles/${name}-${t}.drawio.svg`;
    if (fs.existsSync(out)) fs.rmSync(out);
    const r = await build(spec, { out, png: out.replace('.drawio.svg', '.png'), browser: b });
    const issues = r.check.findings.map((i) => JSON.stringify(i));
    console.log(`${name}-${t}: ${(fs.statSync(out).size / 1024).toFixed(1)}KB${issues.length ? '\n  ' + issues.join('\n  ') : ''}`);
  }
}
await b.close();
