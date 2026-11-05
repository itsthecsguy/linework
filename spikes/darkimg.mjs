// How do .drawio.svg files look in an <img> when the reader uses dark mode?
import fs from 'node:fs';
import { chromium } from 'playwright';
const [out, ...files] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 1300 } });
let html = '<body style="margin:0;display:flex;gap:8px">';
for (const scheme of ['light', 'dark'])
  for (const f of files)
    html += `<div style="background:${scheme === 'dark' ? '#0d1117' : '#fff'};padding:8px;color-scheme:${scheme}"><div style="color:${scheme === 'dark' ? '#ccc' : '#333'};font:12px sans-serif">${scheme}: ${f.split('/').pop()}</div><img style="width:330px" src="data:image/svg+xml;base64,${fs.readFileSync(f).toString('base64')}"></div>`;
await p.emulateMedia({ colorScheme: 'dark' });
await p.setContent(html);
await p.waitForTimeout(500);
await p.screenshot({ path: out, fullPage: true });
await b.close();
