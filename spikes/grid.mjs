// node spikes/grid.mjs out.png cols width img1 img2 ...  -> contact sheet
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const [out, cols, width, ...imgs] = process.argv.slice(2);
const cell = (f) => `<figure><figcaption>${path.basename(f, '.png')}</figcaption><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}"></figure>`;
const html = `<style>body{margin:0;font:12px Inter,system-ui;background:#e5e5e5}main{display:grid;grid-template-columns:repeat(${cols},${width}px);gap:10px;padding:10px;align-items:start}figure{margin:0;background:#fff}figcaption{padding:3px 6px}img{width:100%;display:block}</style><main>${imgs.map(cell).join('')}</main>`;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 10 + cols * (+width + 10), height: 400 } });
await p.setContent(html); await p.screenshot({ path: out, fullPage: true }); await b.close();
