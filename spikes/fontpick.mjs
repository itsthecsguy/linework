// Side-by-side typeface candidates on real diagram labels.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const F = (pkg, fam) => [400, 500, 600].map((w) => `@font-face{font-family:"${fam}";font-weight:${w};src:url(data:font/woff2;base64,${fs.readFileSync(`node_modules/@fontsource/${pkg}/files/${pkg}-latin-${w}-normal.woff2`).toString('base64')})}`).join('');
const fonts = [['inter', 'Inter'], ['geist-sans', 'Geist'], ['ibm-plex-sans', 'IBM Plex Sans'], ['instrument-sans', 'Instrument Sans']];
const card = ([, fam]) => `<section style="font-family:'${fam}'"><h4>${fam} <span class="m"></span></h4>
<div class="g"><div class="gt">Production VPC</div>
<div class="row"><div class="n hl"><b>Checkout API</b><i>Go</i></div><div class="n"><b>Fulfillment worker</b><i>Go</i></div></div>
<div class="lab">publishes OrderPlaced</div>
<div class="row"><div class="n"><b>Reconcile the ledger</b><b>against settlement</b><i>Postgres</i></div><div class="n ext"><b>Stripe</b><i>Payments API</i></div></div></div>
<p class="w">Reconcile the ledger against the payment processor settlement report</p></section>`;
const html = `<style>${fonts.map(([p, f]) => F(p, f)).join('')}
body{margin:0;background:#fff;display:grid;grid-template-columns:repeat(2,460px);gap:24px;padding:24px;color:#18181B}
h4{font:500 12px ui-monospace;color:#888;margin:0 0 8px}
.g{background:#F6F6F7;border-radius:12px;padding:14px}.gt{font-weight:600;font-size:12px;color:#71717A;margin-bottom:10px}
.row{display:flex;gap:16px}.n{background:#fff;border:1px solid #E4E4E7;border-radius:8px;padding:12px 16px;display:flex;flex-direction:column;align-items:center;min-width:140px}
.n b{font-weight:600;font-size:14px;line-height:1.2}.n i{font-style:normal;font-size:12px;color:#71717A;margin-top:3px}
.hl{background:#2563EB;border-color:#2563EB;color:#fff}.hl i{color:#DBEAFE}.ext{background:#F4F4F5;border-color:transparent}
.lab{font-size:12px;color:#52525B;margin:10px 0 10px 40px}.w{font-size:14px;display:inline-block;margin:10px 0 0}</style>
${fonts.map(card).join('')}
<script>document.fonts.ready.then(()=>{for(const s of document.querySelectorAll('section')){s.querySelector('.m').textContent=Math.round(s.querySelector('.w').getBoundingClientRect().width)+'px for the test line'}})</script>`;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 2 });
await p.setContent(html); await p.waitForTimeout(400); await p.screenshot({ path: 'out/_fonts.png', fullPage: true }); await b.close();
