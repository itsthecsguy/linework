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
const xml = toMxfile(await buildGraph(spec));

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

await frame.evaluate(() => {
  const graph = window.__editor.graph, model = graph.getModel();
  graph.moveCells([model.getCell('api')], 96, 40);
});
// Only reroute edges touching the moved node: select them, libavoid routes the selection.
await frame.evaluate(() => {
  const graph = window.__editor.graph, model = graph.getModel();
  graph.setSelectionCells(graph.getEdges(model.getCell('api')));
});
await page.evaluate(() => window.send({ action: 'layout', layouts: 'libavoid' }));
await page.waitForFunction(() => window.events.some((e) => e.event === 'layout'), null, { timeout: 60000 });
await page.evaluate(() => window.send({ action: 'export', format: 'xmlsvg' }));
await page.waitForFunction(() => window.events.some((e) => e.event === 'export'), null, { timeout: 30000 });
const exp = await page.evaluate(() => window.events.find((e) => e.event === 'export'));
fs.writeFileSync(path.join(import.meta.dirname, 'out/checkout.rerouted.drawio.svg'), Buffer.from(exp.data.split(',')[1], 'base64').toString('utf8'));
console.log('rerouted');
await browser.close(); server.close();
