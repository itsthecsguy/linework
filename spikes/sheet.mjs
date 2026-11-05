import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
const [out, ...files] = process.argv.slice(2);
const html = path.resolve('out/_sheet.html');
fs.writeFileSync(html, `<body style="margin:0;display:flex;gap:24px;align-items:flex-start;background:#fff;font:14px sans-serif">` +
  files.map(f => `<figure style="margin:0"><figcaption>${path.basename(f)}</figcaption><img src="${path.basename(f)}" style="width:520px;border:1px solid #ddd"></figure>`).join('') + `</body>`);
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 520 * files.length + 24 * files.length, height: 800 } });
await p.goto('file://' + html); await p.waitForTimeout(400);
await p.screenshot({ path: out, fullPage: true }); await b.close(); fs.unlinkSync(html);
