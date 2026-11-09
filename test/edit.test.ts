// The loop the tool exists for: an agent builds a diagram, a person moves a node
// in `linework edit` and saves, the agent edits the spec again, and the move survives.
// Needs Chromium.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { build, show } from '../src/api.js';
import { startEditor } from '../src/edit/server.js';
import { absBox, readDrawio } from '../src/drawio/read.js';

const run = process.env.LINEWORK_SKIP_E2E !== '1';

async function launch(): Promise<Browser> {
  // Same order as the tool: LINEWORK_CHROME first, then Playwright's Chromium, Chrome, Edge.
  const own = process.env.LINEWORK_CHROME ? [{ executablePath: process.env.LINEWORK_CHROME }] : [];
  for (const o of [...own, {}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await chromium.launch(o);
    } catch {}
  }
  throw new Error('no Chromium');
}

const apiBox = (file: string) => absBox(readDrawio(fs.readFileSync(file, 'utf8')), 'api')!;

describe.runIf(run)('linework edit', () => {
  it('saves a hand edit that the next build keeps', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-edit-'));
    const file = path.join(tmp, 'checkout.drawio.svg');
    await build(fs.readFileSync('examples/checkout.yaml', 'utf8'), { out: file });
    const before = apiBox(file);

    const session = await startEditor(file);
    const browser = await launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(session.url);
      const frame = () => page.frames().find((f) => f.url().includes('embed=1'))!;
      await page.waitForFunction(() => !!document.querySelector('iframe')?.contentWindow?.document.querySelector('.geDiagramContainer svg'), null, { timeout: 60000 });
      await page.waitForTimeout(1500);
      // Select the "Checkout API" node by its label and nudge it with the keyboard.
      const pos = await frame().evaluate(() => {
        const el = [...document.querySelectorAll('.geDiagramContainer foreignObject *')].find((d) => d.childElementCount === 0 && d.textContent?.trim() === 'Checkout API')!;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.click(pos.x, pos.y);
      await page.waitForTimeout(300);
      for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');
      await page.waitForTimeout(800); // draw.io batches arrow-key nudges before committing them
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
      await expect.poll(() => apiBox(file).x, { timeout: 15000 }).toBeGreaterThan(before.x);
    } finally {
      await browser.close();
      await session.close();
    }
    const moved = apiBox(file);
    expect(moved.x - before.x).toBe(48);

    // The agent picks up the file and adds a node.
    const spec = show(file).yaml.replace('nodes:\n', 'nodes:\n  audit: { label: Audit log, kind: storage }\n').replace('edges:\n', 'edges:\n  - api -> audit: append\n');
    const res = await build(spec, { out: file });
    expect(res.mode).toBe('merge');
    expect(res.merge!.placed).toContain('audit');
    expect(apiBox(file)).toEqual(moved);
    expect((await session.done).saves).toBe(1);
  }, 120000);
});
