// Copies the parts of draw.io that linework needs from a drawio checkout into assets/drawio.
// The renderer needs the core runtime; `linework edit` also needs the editor UI.
// Usage: node scripts/copy-drawio-assets.mjs [path/to/drawio]   (default: vendor/drawio)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.resolve(process.argv[2] ?? 'vendor/drawio');
const webapp = path.join(root, 'src/main/webapp');
const out = path.resolve('assets/drawio');
const render = ['js/app.min.js', 'js/export-init.js', 'mxgraph/css/common.css', 'js/libavoid-js/libavoid.min.js', 'js/libavoid-js/libavoid-routing.js', 'js/libavoid-js/LICENSE', 'js/diagramly/LibavoidRouting.js', 'js/rough/rough.min.js', 'js/shapes-14-6-5.min.js', 'js/stencils.min.js'];
// Found by recording what the embed editor requests (spikes/editreq.mjs).
const editor = ['index.html', 'js/bootstrap.js', 'js/PreConfig.js', 'js/PostConfig.js', 'js/main.js', 'js/extensions.min.js', 'resources/dia.txt', 'favicon.ico'];
const dirs = ['styles', 'img/clipart'];
fs.rmSync(out, { recursive: true, force: true });
const copy = (f) => {
  fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
  fs.copyFileSync(path.join(webapp, f), path.join(out, f));
};
for (const f of [...render, ...editor]) copy(f);
for (const d of dirs) fs.cpSync(path.join(webapp, d), path.join(out, d), { recursive: true });
// Small UI images only; the big ones are marketing and integration art the editor never shows offline.
for (const f of fs.readdirSync(path.join(webapp, 'images'))) {
  const p = path.join(webapp, 'images', f);
  if (fs.statSync(p).isFile() && fs.statSync(p).size < 32 * 1024) copy(path.join('images', f));
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
const version = execSync('git describe --tags', { cwd: root }).toString().trim();
fs.writeFileSync(path.join(out, 'VERSION'), version + '\n');
console.log(`copied draw.io ${version} runtime and editor to assets/drawio`);
