// The loop the tool exists for: an agent builds a diagram, a person moves a node
// in `linework edit` and saves, the agent edits the spec again, and the move survives.
// Plus fast HTTP-only tests for the editor server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import { build, show } from '../src/api.js';
import { useConfig } from '../src/config.js';
import { startEditor } from '../src/edit/server.js';
import { absBox, readDrawio } from '../src/drawio/read.js';
import { DrawioBrowser } from '../src/render/browser.js';
import { fontsDir } from '../src/render/fonts.js';

const run = process.env.LINEWORK_SKIP_E2E !== '1';
const apiBox = (file: string) => absBox(readDrawio(fs.readFileSync(file, 'utf8')), 'api')!;

const MINIMAL_XML = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
const MINIMAL_SVG = (font = 'IBM Plex Sans') =>
  `<svg xmlns="http://www.w3.org/2000/svg" content="${MINIMAL_XML.replace(/"/g, '&quot;')}"><defs/><text style="font-family:&quot;${font}&quot;">Hello</text></svg>`;

describe('linework edit server (HTTP)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-edit-http-'));

  afterAll(() => {
    useConfig();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a side-copy and returns 409 when the file changed on disk', async () => {
    const file = path.join(tmp, 'conflict.drawio.svg');
    fs.writeFileSync(file, MINIMAL_SVG());
    const oldMtime = fs.statSync(file).mtimeMs;
    const session = await startEditor(file);
    try {
      const base = session.url.replace(/\/$/, '');
      // Modify the file on disk with a bumped mtime.
      fs.writeFileSync(file, MINIMAL_SVG() + '<!-- disk -->');
      const bumped = new Date(oldMtime + 5000);
      fs.utimesSync(file, bumped, bumped);

      const savedSvg = MINIMAL_SVG() + '<!-- editor -->';
      const data = `data:image/svg+xml;base64,${Buffer.from(savedSvg, 'utf8').toString('base64')}`;
      const res = await fetch(`${base}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data, mtime: oldMtime }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { conflict: string; error: string; mtime: number };
      expect(body.error).toMatch(/changed on disk/);
      expect(body.conflict).toMatch(/conflict\.edited-/);
      expect(fs.readFileSync(file, 'utf8')).toContain('<!-- disk -->');

      // Repeat save against the same stale disk version reuses the same conflict copy.
      const savedSvg2 = MINIMAL_SVG() + '<!-- editor-2 -->';
      const data2 = `data:image/svg+xml;base64,${Buffer.from(savedSvg2, 'utf8').toString('base64')}`;
      const res2 = await fetch(`${base}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: data2, mtime: oldMtime }),
      });
      expect(res2.status).toBe(409);
      const body2 = (await res2.json()) as { conflict: string };
      expect(body2.conflict).toBe(body.conflict);

      // /latest returns the latest on-disk XML and mtime.
      const latest = (await (await fetch(`${base}/latest`)).json()) as { xml: string; mtime: number };
      expect(latest.xml).toContain('<mxfile');
      expect(latest.mtime).toBe(body.mtime);

      // force: true overwrites the original file cleanly.
      const forceRes = await fetch(`${base}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: data2, mtime: oldMtime, force: true }),
      });
      expect(forceRes.status).toBe(200);
      expect(fs.readFileSync(file, 'utf8')).toContain('<!-- editor-2 -->');
    } finally {
      await session.close();
    }
    const done = await session.done;
    expect(done.conflicts.length).toBe(1);
    expect(done.saves).toBe(2);
    expect(fs.existsSync(done.conflicts[0]!)).toBe(true);
    expect(fs.readFileSync(done.conflicts[0]!, 'utf8')).toContain('<!-- editor-2 -->');
  });

  it('serves dark-aware host UI with dirty guard, disconnect backup, and SSE disk-change events', async () => {
    const darkXml = '<mxfile><diagram><mxGraphModel background="#0D1117"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
    const darkSvg = `<svg xmlns="http://www.w3.org/2000/svg" content="${darkXml.replace(/"/g, '&quot;')}"><defs/></svg>`;
    const file = path.join(tmp, 'dark.drawio.svg');
    fs.writeFileSync(file, darkSvg);
    const session = await startEditor(file);
    const ac = new AbortController();
    try {
      const base = session.url.replace(/\/$/, '');
      const html = await (await fetch(session.url)).text();
      expect(html).toContain('dark=1');
      expect(html).toContain('autosave: 1');
      expect(html).toContain('beforeunload');
      expect(html).toContain('Download backup');
      expect(html).toContain('prefers-color-scheme:dark');

      const sseRes = await fetch(`${base}/events`, { signal: ac.signal });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
      const reader = sseRes.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // Read initial comment, then bump the file on disk and expect a changed event.
      const first = await reader.read();
      buf += dec.decode(first.value, { stream: true });
      const oldMtime = fs.statSync(file).mtimeMs;
      fs.writeFileSync(file, darkSvg + '<!-- external -->');
      const bumped = new Date(oldMtime + 5000);
      fs.utimesSync(file, bumped, bumped);
      const deadline = Date.now() + 5000;
      while (!buf.includes('event: changed') && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 500)),
        ]);
        if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
        if (chunk.done) break;
      }
      expect(buf).toContain('event: changed');
    } finally {
      ac.abort();
      await session.close();
    }
  });

  it('blocks path traversal under /app/ and returns 400 on malformed URIs', async () => {
    const file = path.join(tmp, 'sec.drawio.svg');
    fs.writeFileSync(file, MINIMAL_SVG());
    const session = await startEditor(file);
    try {
      const origin = new URL(session.url).origin;
      const hostRes = await fetch(session.url);
      expect(hostRes.status).toBe(200);
      expect(await hostRes.text()).toContain('postMessage(JSON.stringify(m), location.origin)');

      expect((await fetch(`${origin}/app/..%2F..%2Fpackage.json`)).status).toBe(404);
      expect((await fetch(`${origin}/app/..%2Ffonts%2Fplex-sans-400.woff2`)).status).toBe(404);
      expect((await fetch(`${origin}/app/%E0%A4%A`)).status).toBe(400);
      // Server remains healthy after a malformed URI.
      expect((await fetch(session.url)).status).toBe(200);
    } finally {
      await session.close();
    }
  });

  it('serves and embeds custom theme fonts from linework.yaml on save', async () => {
    const proj = path.join(tmp, 'custom-font-proj');
    fs.mkdirSync(proj, { recursive: true });
    const fontSrc = path.join(fontsDir(), 'plex-sans-400.woff2');
    const fontBoldSrc = path.join(fontsDir(), 'plex-sans-600.woff2');
    fs.copyFileSync(fontSrc, path.join(proj, 'brand-400.woff2'));
    fs.copyFileSync(fontBoldSrc, path.join(proj, 'brand-600.woff2'));
    fs.writeFileSync(
      path.join(proj, 'linework.yaml'),
      `theme: brand\nthemes:\n  brand:\n    extends: clean\n    font:\n      family: BrandSans\n      regular: ./brand-400.woff2\n      bold: ./brand-600.woff2\n`,
    );
    const file = path.join(proj, 'arch.drawio.svg');
    fs.writeFileSync(file, MINIMAL_SVG('BrandSans'));
    const mtime = fs.statSync(file).mtimeMs;

    const session = await startEditor(file);
    try {
      const origin = new URL(session.url).origin;
      const base = session.url.replace(/\/$/, '');
      const indexHtml = await (await fetch(`${origin}/app/index.html`)).text();
      expect(indexHtml).toContain('font-family:"BrandSans"');
      expect(indexHtml).toContain('/aiviz-fonts/custom-0.woff2');

      const fontRes = await fetch(`${origin}/aiviz-fonts/custom-0.woff2`);
      expect(fontRes.status).toBe(200);
      expect(fontRes.headers.get('content-type')).toBe('font/woff2');

      const data = `data:image/svg+xml;base64,${Buffer.from(MINIMAL_SVG('BrandSans'), 'utf8').toString('base64')}`;
      const saveRes = await fetch(`${base}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data, mtime }),
      });
      expect(saveRes.status).toBe(200);
      const saved = fs.readFileSync(file, 'utf8');
      expect(saved).toContain('<style id="aiviz-fonts"');
      expect(saved).toContain('font-family:"BrandSans"');
    } finally {
      await session.close();
    }
  });
});

describe.runIf(run)('linework edit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-edit-'));
  let b: DrawioBrowser;

  beforeAll(async () => {
    b = await DrawioBrowser.launch();
  }, 60000);

  afterAll(async () => {
    await b?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('saves a hand edit that the next build keeps', async () => {
    const file = path.join(tmp, 'checkout.drawio.svg');
    await build(fs.readFileSync('examples/checkout.yaml', 'utf8'), { out: file, browser: b });
    const before = apiBox(file);

    const session = await startEditor(file);
    const page = await (b as unknown as { browser: Browser }).browser.newPage({ viewport: { width: 1400, height: 900 } });
    try {
      await page.goto(session.url);
      const frame = () => page.frames().find((f) => f.url().includes('embed=1'))!;
      await page.waitForFunction(
        () => {
          const doc = document.querySelector('iframe')?.contentWindow?.document;
          if (!doc) return false;
          const el = [...doc.querySelectorAll('.geDiagramContainer foreignObject *')].find((d) => d.childElementCount === 0 && d.textContent?.trim() === 'Checkout API');
          return !!el && el.getBoundingClientRect().width > 0;
        },
        null,
        { timeout: 60000 },
      );
      // Select the "Checkout API" node by its label and nudge it with the keyboard.
      const labelPos = () =>
        frame().evaluate(() => {
          const el = [...document.querySelectorAll('.geDiagramContainer foreignObject *')].find((d) => d.childElementCount === 0 && d.textContent?.trim() === 'Checkout API')!;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
      const pos = await labelPos();
      await page.mouse.click(pos.x, pos.y);
      await frame().waitForFunction(() => !!document.querySelector('.geDiagramContainer svg [style*="cursor: move"], .geDiagramContainer svg [style*="cursor: nw-resize"], .geDiagramContainer svg [stroke="#00a8ff"]'), null, { timeout: 10000 });
      for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
      await expect.poll(async () => (await labelPos()).x, { timeout: 10000 }).toBeGreaterThan(pos.x + 20);
      await page.waitForTimeout(800); // draw.io batches arrow-key nudges before committing them
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
      await expect.poll(() => apiBox(file).x, { timeout: 15000 }).toBeGreaterThan(before.x);
    } finally {
      await page.close();
      await session.close();
    }
    const moved = apiBox(file);
    expect(moved.x - before.x).toBe(48);

    // The agent picks up the file and adds a node.
    const spec = show(file).yaml.replace('nodes:\n', 'nodes:\n  audit: { label: Audit log, kind: storage }\n').replace('edges:\n', 'edges:\n  - api -> audit: append\n');
    const res = await build(spec, { out: file, browser: b });
    expect(res.mode).toBe('merge');
    expect(res.merge!.placed).toContain('audit');
    expect(apiBox(file)).toEqual(moved);
    expect((await session.done).saves).toBe(1);
  }, 120000);
});
