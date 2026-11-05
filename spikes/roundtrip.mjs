// Round-trip test through the real draw.io editor in embed mode (proto=json),
// which is the same protocol the VS Code extension uses to load and save files.
// 1. load our generated diagram  2. make edits through the editor's own graph API
// 3. export as xmlsvg (what gets written to a .drawio.svg)  4. check our metadata.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import YAML from 'yaml';
import { chromium } from 'playwright';
import { buildGraph, toMxfile } from './lib/build.mjs';

const WEBAPP = path.resolve(import.meta.dirname, '../vendor/drawio/src/main/webapp');
const spec = YAML.parse(fs.readFileSync(path.join(import.meta.dirname, 'specs/checkout.yaml'), 'utf8'));
const xml = process.env.FILE
  ? /content="([^"]*)"/.exec(fs.readFileSync(process.env.FILE, 'utf8'))[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&')
  : toMxfile(await buildGraph(spec));

const HOST = `<!DOCTYPE html><html><body style="margin:0">
<iframe id="f" style="width:1400px;height:900px;border:0" src="/index.html?embed=1&proto=json&offline=1&pwa=0&stealth=1&lang=en&dev=0"></iframe>
<script>
window.events = [];
window.addEventListener('message', (e) => {
  if (typeof e.data !== 'string') return;
  const m = JSON.parse(e.data);
  window.events.push(m);
  if (m.event === 'init') document.getElementById('f').contentWindow.postMessage(JSON.stringify({ action: 'load', xml: window.XML, autosave: 0 }), '*');
});
window.send = (msg) => document.getElementById('f').contentWindow.postMessage(JSON.stringify(msg), '*');
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/host.html') return res.writeHead(200, { 'content-type': 'text/html' }), res.end(HOST);
  const file = path.join(WEBAPP, url);
  if (!file.startsWith(WEBAPP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404), res.end();
  const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.xml': 'text/xml', '.txt': 'text/plain' }[path.extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.addInitScript((x) => (window.XML = x), xml);
await page.goto(`http://127.0.0.1:${server.address().port}/host.html`);
await page.waitForFunction(() => window.events.some((e) => e.event === 'load'), null, { timeout: 60000 });
console.log('editor loaded diagram');

const frame = page.frames().find((f) => f.url().includes('embed=1'));
// The editor instance isn't a global in embed mode. Capture it by patching a
// prototype method, then trigger one export so the patch fires.
await frame.evaluate(() => {
  const orig = Editor.prototype.getGraphXml;
  Editor.prototype.getGraphXml = function (...a) { window.__editor = this; return orig.apply(this, a); };
});
await page.evaluate(() => window.send({ action: 'export', format: 'xml' }));
await frame.waitForFunction(() => !!window.__editor, null, { timeout: 30000 });
await page.evaluate(() => (window.events = []));
console.log('captured editor');

// The edits a human would make.
await frame.evaluate(() => {
  const graph = window.__editor.graph, model = graph.getModel();
  model.beginUpdate();
  try {
    const api = model.getCell('api');
    graph.moveCells([api], 96, 40);                                   // drag a node
    graph.cellLabelChanged(model.getCell('db'), 'Orders (primary)', false); // edit label text
    graph.setCellStyles('fillColor', '#FEF9C3', [model.getCell('cache')]);  // restyle
    const v = graph.insertVertex(graph.getDefaultParent(), null, 'Audit log', 40, 1400, 160, 48, 'shape=cylinder3;whiteSpace=wrap;html=1;'); // hand-added shape
    graph.insertEdge(graph.getDefaultParent(), null, 'append', model.getCell('worker'), v);
  } finally { model.endUpdate(); }
  window.__editor.setModified(true);
});

// Export exactly as the embed protocol does for .drawio.svg saves.
await page.evaluate(() => window.send({ action: 'export', format: 'xmlsvg' }));
await page.waitForFunction(() => window.events.some((e) => e.event === 'export'), null, { timeout: 30000 });
const exp = await page.evaluate(() => window.events.find((e) => e.event === 'export'));
const svg = Buffer.from(exp.data.split(',')[1], 'base64').toString('utf8');
fs.writeFileSync(path.join(import.meta.dirname, 'out/checkout.edited.drawio.svg'), svg);

// Pull the model back out of the SVG the way `aiviz show` would.
const content = /content="([^"]*)"/.exec(svg)[1]
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
let model = content;
const diag = /<diagram[^>]*>([^<]+)<\/diagram>/.exec(content);
const compressed = !!diag;
if (diag) model = decodeURIComponent(zlib.inflateRawSync(Buffer.from(diag[1], 'base64')).toString('utf8'));

const objects = [...model.matchAll(/<object ([^>]*)>\s*<mxCell([^>]*)>\s*<mxGeometry([^>]*)/g)].map((m) => {
  const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  const g = Object.fromEntries([...m[3].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  return { ...a, geom: g };
});
const byId = Object.fromEntries(objects.map((o) => [o.id, o]));
const checks = [
  ['diagram compressed in saved file', compressed, 'info'],
  ['every node keeps aiviz_kind', (process.env.FILE ? [...xml.matchAll(/<object id="([^"]+)"[^>]*aiviz_kind=/g)].map((m) => m[1]) : Object.keys(spec.nodes)).every((id) => byId[id]?.aiviz_kind), 'must'],
  ['tech metadata kept', byId.api?.aiviz_tech === 'Go', 'must'],
  ['aiviz_auto kept on moved node', !!byId.api?.aiviz_auto, 'must'],
  ['moved node geometry differs from aiviz_auto (pin detection works)', byId.api && `${byId.api.geom.x},${byId.api.geom.y}` !== byId.api.aiviz_auto.split(',').slice(0, 2).join(','), 'must'],
  ['edge metadata kept', objects.some((o) => ['api->db'].includes(o.aiviz_edge?.replace(/&gt;/g, '>'))), 'must'],
  ['group metadata kept', byId.vpc?.aiviz_type === 'group', 'must'],
  ['edited label kept and still has metadata', /Orders \(primary\)/.test(byId.db?.label ?? '') && byId.db?.aiviz_kind === 'database', 'must'],
  ['root metadata (aiviz_type on cell 0) kept', !process.env.FILE || /<object[^>]*id="0"[^>]*aiviz_type="architecture"|<object[^>]*aiviz_type="architecture"[^>]*id="0"/.test(model), 'must'],
  ['restyle kept', /FEF9C3/.test(model), 'must'],
  ['hand-added shape present (plain mxCell, no metadata)', /value="Audit log"/.test(model), 'must'],
];
let fail = 0;
for (const [name, ok, level] of checks) {
  console.log(`${level === 'info' ? 'INFO' : ok ? 'PASS' : 'FAIL'}  ${name}${level === 'info' ? `: ${ok}` : ''}`);
  if (!ok && level === 'must') fail++;
}
console.log('api auto vs now:', byId.api?.aiviz_auto, byId.api?.geom);
console.log('db label after edit:', byId.db?.label);
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
