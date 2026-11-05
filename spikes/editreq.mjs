// Which webapp files does the embed editor actually request?
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const WEBAPP = path.resolve(import.meta.dirname, '../vendor/drawio/src/main/webapp');
const xml = /content="([^"]*)"/.exec(fs.readFileSync(process.argv[2], 'utf8'))[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
const HOST = `<!DOCTYPE html><html><body style="margin:0">
<iframe id="f" style="width:1400px;height:900px;border:0" src="/index.html?embed=1&proto=json&offline=1&pwa=0&stealth=1&lang=en&dev=0&libraries=1&ui=kennedy"></iframe>
<script>
window.events = [];
window.addEventListener('message', (e) => { if (typeof e.data !== 'string') return; const m = JSON.parse(e.data); window.events.push(m);
  if (m.event === 'init') document.getElementById('f').contentWindow.postMessage(JSON.stringify({ action: 'load', xml: window.XML, autosave: 1 }), '*'); });
window.send = (msg) => document.getElementById('f').contentWindow.postMessage(JSON.stringify(msg), '*');
</script></body></html>`;
const hits = new Map(); const missing = new Set();
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/host.html') return res.writeHead(200, { 'content-type': 'text/html' }), res.end(HOST);
  const file = path.join(WEBAPP, url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { missing.add(url); return res.writeHead(404), res.end(); }
  hits.set(url, fs.statSync(file).size);
  const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.xml': 'text/xml', '.txt': 'text/plain' }[path.extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type }); fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const external = new Set();
page.on('request', (r) => { if (!r.url().includes('127.0.0.1')) external.add(r.url().slice(0, 100)); });
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.addInitScript((x) => (window.XML = x), xml);
await page.goto(`http://127.0.0.1:${server.address().port}/host.html`);
await page.waitForFunction(() => window.events.some((e) => e.event === 'load'), null, { timeout: 60000 });
await page.waitForTimeout(3000);
const frame = page.frames().find((f) => f.url().includes('embed=1'));
// open every sidebar palette so lazy assets load
await frame.evaluate(() => document.querySelectorAll('.geSidebarContainer a.geTitle').forEach((a) => a.click()));
await page.waitForTimeout(2000);
// select a node so the format panel loads, then open menus and dialogs
await page.mouse.click(733, 420); await page.waitForTimeout(1000);
for (const tab of await frame.$$('.geFormatTitle')) { await tab.click().catch(() => {}); await page.waitForTimeout(300); }
for (const m of ['File', 'Edit', 'View', 'Arrange', 'Extras', 'Help']) {
  const el = await frame.$(`a.geItem:text-is("${m}")`); if (!el) continue; await el.click(); await page.waitForTimeout(500); await page.keyboard.press('Escape');
}
const more = await frame.$('text=More Shapes'); if (more) { await more.click(); await page.waitForTimeout(2500); await page.screenshot({ path: process.argv[3].replace('.png', '-more.png') }); await page.keyboard.press('Escape'); }
await page.waitForTimeout(1000);
await page.screenshot({ path: process.argv[3] });
const total = [...hits.values()].reduce((a, b) => a + b, 0);
console.log('files', hits.size, 'bytes', total);
const byDir = {}; for (const [u, s] of hits) { const d = u.split('/').slice(0, 3).join('/'); byDir[d] = (byDir[d] ?? 0) + s; }
console.log(Object.entries(byDir).sort((a, b) => b[1] - a[1]).map(([d, s]) => `${(s / 1024).toFixed(0)}K ${d}`).join('\n'));
console.log('missing', [...missing].slice(0, 20));
console.log('external', [...external].slice(0, 20));
fs.writeFileSync(process.argv[4], JSON.stringify([...hits.keys()].sort(), null, 1));
await browser.close(); server.close();
