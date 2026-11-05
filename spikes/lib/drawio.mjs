// Headless draw.io: serves the vendored webapp and drives its real Graph/mxCodec
// code in Chromium. Used for rendering and for round-trip tests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const WEBAPP = path.resolve(import.meta.dirname, '../../vendor/drawio/src/main/webapp');

const HOST_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="js/export-init.js"></script>
<link rel="stylesheet" href="mxgraph/css/common.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=block">
<script src="js/app.min.js"></script>
<script src="js/extensions.min.js"></script>
<style>body{margin:0;background:#fff} #out{display:inline-block}</style>
</head><body><div id="out"></div><script>
function decodeInto(graph, xml) {
  var doc = mxUtils.parseXml(xml);
  var node = Editor.extractGraphModel(doc.documentElement, false);
  new mxCodec(node.ownerDocument).decode(node, graph.getModel());
}
window.renderXml = async function (xml, opts) {
  opts = opts || {};
  var c = document.createElement('div');
  c.style.cssText = 'position:absolute;left:-99999px;width:2000px;height:2000px';
  document.body.appendChild(c);
  var graph = new Graph(c);
  decodeInto(graph, xml);
  await document.fonts.ready;
  var svg = graph.getSvg('#ffffff', 1, opts.border == null ? 16 : opts.border, false, null, true, null, null, null, false, true);
  if (opts.embed) svg.setAttribute('content', xml);
  var text = Graph.xmlDeclaration + '\\n' + (opts.embed ? Graph.svgFileComment + '\\n' : '') + Graph.svgDoctype + '\\n' + mxUtils.getXml(svg);
  var out = document.getElementById('out');
  out.innerHTML = '';
  out.appendChild(svg);
  graph.destroy(); c.remove();
  await document.fonts.ready;
  return text;
};
// Simulates what the editor does on save: decode, apply a user edit, re-encode.
window.roundTrip = function (xml, edit) {
  var c = document.createElement('div');
  document.body.appendChild(c);
  var ui = new Graph(c);
  decodeInto(ui, xml);
  var model = ui.getModel();
  model.beginUpdate();
  try { (new Function('graph', 'model', edit))(ui, model); } finally { model.endUpdate(); }
  var enc = new mxCodec().encode(model);
  var out = mxUtils.getXml(enc);
  ui.destroy(); c.remove();
  return out;
};
window.ready = true;
</script></body></html>`;

export async function startDrawio() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/' || url === '/host.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(HOST_PAGE);
    }
    const file = path.join(WEBAPP, url);
    if (!file.startsWith(WEBAPP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'text/xml', '.txt': 'text/plain' }[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`http://127.0.0.1:${port}/host.html`);
  await page.waitForFunction(() => window.ready === true);
  return {
    page,
    async render(xml, outBase) {
      const svg = await page.evaluate(([x]) => window.renderXml(x, { embed: true }), [xml]);
      fs.writeFileSync(`${outBase}.drawio.svg`, svg);
      await page.waitForTimeout(150);
      await page.locator('#out svg').screenshot({ path: `${outBase}.png` });
      return svg;
    },
    roundTrip: (xml, edit) => page.evaluate(([x, e]) => window.roundTrip(x, e), [xml, edit]),
    async close() {
      await browser.close();
      server.close();
    },
  };
}
