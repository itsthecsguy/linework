import { chromium } from 'playwright-core';
import fs from 'node:fs';
const F = (pkg, file) => `url(data:font/woff2;base64,${fs.readFileSync(`node_modules/@fontsource/${pkg}/files/${file}`).toString('base64')})`;
const fonts = [
  ['Kalam', 'kalam', 'kalam-latin-400-normal.woff2', 'kalam-latin-700-normal.woff2'],
  ['Shantell Sans', 'shantell-sans', 'shantell-sans-latin-400-normal.woff2', 'shantell-sans-latin-600-normal.woff2'],
  ['Caveat', 'caveat', 'caveat-latin-400-normal.woff2', 'caveat-latin-700-normal.woff2'],
  ['Architects Daughter', 'architects-daughter', 'architects-daughter-latin-400-normal.woff2', 'architects-daughter-latin-400-normal.woff2'],
  ['Patrick Hand', 'patrick-hand', 'patrick-hand-latin-400-normal.woff2', 'patrick-hand-latin-400-normal.woff2'],
  ['Inter', 'inter', 'inter-latin-400-normal.woff2', 'inter-latin-600-normal.woff2'],
  ['JetBrains Mono', 'jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2', 'jetbrains-mono-latin-600-normal.woff2'],
];
let css = '', body = '';
for (const [name, pkg, r, b] of fonts) {
  css += `@font-face{font-family:'${name}';font-weight:400;src:${F(pkg, r)}}@font-face{font-family:'${name}';font-weight:700;src:${F(pkg, b)}}`;
  body += `<div style="font-family:'${name}';margin:10px 20px;display:flex;gap:24px;align-items:center"><div style="width:180px;color:#888;font:12px Inter">${name}</div><div style="border:1.5px solid #333;border-radius:8px;padding:8px 16px;text-align:center"><div style="font-weight:700;font-size:15px">Checkout API</div><div style="font-size:12px;color:#666">Go · gRPC 0123</div></div><div style="font-size:13px">read session · OrderPlaced · update status</div></div>`;
}
const b = await chromium.launch(); const p = await b.newPage({ deviceScaleFactor: 2, viewport: { width: 900, height: 600 } });
await p.setContent(`<style>${css}</style>${body}`); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
await p.screenshot({ path: process.argv[2], fullPage: true }); await b.close();
