// Export to Excalidraw: the label-placement trick on its own, then real files
// converted from built diagrams and checked for the things Excalidraw needs to
// open them (needs Chromium).
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, render } from '../src/api.js';
import { readDrawio } from '../src/drawio/read.js';
import { DrawioBrowser } from '../src/render/browser.js';
import { centreRouteOn, toExcalidraw, type ExcalidrawElement, type ExcalidrawFile } from '../src/excalidraw/export.js';

type P = { x: number; y: number };
const mid = (a: P, b: P) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** Where Excalidraw puts an arrow's label: the middle point, or the middle of the middle segment. */
const labelSpot = (pts: P[]) => (pts.length % 2 ? pts[(pts.length - 1) / 2]! : mid(pts[pts.length / 2 - 1]!, pts[pts.length / 2]!));
const length = (pts: P[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) : 0), 0);

describe('centring a route on its label', () => {
  it('leaves a route alone when its middle is already where the label is', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    expect(centreRouteOn(pts, { x: 0, y: 52 })).toBe(pts);
  });

  it('moves the middle of a straight arrow to a label near one end', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: 200 }];
    const out = centreRouteOn(pts, { x: 0, y: 20 });
    expect(labelSpot(out).y).toBeCloseTo(20, 1);
    expect(labelSpot(out).x).toBe(0);
  });

  it('takes the label off the corner of an L and onto the run it belongs to', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 300, y: 100 }];
    // Three points: Excalidraw would put the label on the bend.
    expect(labelSpot(pts)).toEqual({ x: 0, y: 100 });
    const out = centreRouteOn(pts, { x: 180, y: 100 });
    expect(labelSpot(out).x).toBeCloseTo(180, 1);
    expect(labelSpot(out).y).toBe(100);
  });

  it('adds points only along the route: same ends, same length, same corners in order', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 300 }, { x: 260, y: 300 }];
    for (const label of [{ x: 0, y: 12 }, { x: 60, y: 40 }, { x: 200, y: 250 }, { x: 240, y: 300 }]) {
      const out = centreRouteOn(pts, label);
      expect(out[0]).toEqual(pts[0]);
      expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
      expect(length(out)).toBeCloseTo(length(pts), 6);
      expect(out.filter((p) => pts.some((q) => q.x === p.x && q.y === p.y))).toEqual(pts);
      const spot = labelSpot(out);
      expect(Math.hypot(spot.x - label.x, spot.y - label.y)).toBeLessThan(3);
    }
  });
});

const run = process.env.LINEWORK_SKIP_E2E !== '1';

describe.runIf(run)('Excalidraw files', () => {
  let b: DrawioBrowser;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-excalidraw-'));
  beforeAll(async () => {
    b = await DrawioBrowser.launch();
  }, 60000);
  afterAll(async () => {
    await b?.close();
  });

  const convert = async (example: string, theme?: string): Promise<ExcalidrawFile> => {
    const src = fs.readFileSync(`examples/${example}.yaml`, 'utf8');
    const out = path.join(tmp, `${example}-${theme ?? 'clean'}.drawio.svg`);
    await build(theme ? src.replace(/^type:.*$/m, (l) => `${l}\ntheme: ${theme}`) : src, { out, browser: b });
    return toExcalidraw(readDrawio(fs.readFileSync(out, 'utf8')), b);
  };

  /** What Excalidraw needs of any file, whatever is drawn in it. */
  const sound = (f: ExcalidrawFile, name: string) => {
    expect(f.type).toBe('excalidraw');
    const byId = new Map(f.elements.map((e) => [e.id, e]));
    expect(byId.size, `${name}: ids are unique`).toBe(f.elements.length);
    for (const e of f.elements) {
      for (const k of ['x', 'y', 'width', 'height'] as const) expect(Number.isFinite(e[k]), `${name} ${e.id}.${k}`).toBe(true);
      expect(String(e.strokeColor), `${name} ${e.id} stroke`).toMatch(/^(transparent|#[0-9a-fA-F]{6}|rgba?\(.*\))$/);
      // Both sides of every attachment agree, or Excalidraw drops it on load.
      for (const bound of e.boundElements) {
        const other = byId.get(bound.id);
        expect(other, `${name}: ${e.id} lists ${bound.id}`).toBeDefined();
        if (bound.type === 'text') expect(other!.containerId).toBe(e.id);
        else expect([(other!.startBinding as { elementId: string } | null)?.elementId, (other!.endBinding as { elementId: string } | null)?.elementId]).toContain(e.id);
      }
      if (e.type === 'text') {
        expect(String(e.text).length, `${name} ${e.id} has text`).toBeGreaterThan(0);
        expect(e.width, `${name} ${e.id} measured`).toBeGreaterThan(0);
        if (e.containerId) expect(byId.get(e.containerId as string)?.boundElements.some((x) => x.id === e.id), `${name}: ${e.containerId} lists ${e.id}`).toBe(true);
      }
      if (e.type === 'arrow' || e.type === 'line') {
        const pts = e.points as number[][];
        expect(pts.length).toBeGreaterThanOrEqual(2);
        expect(pts[0]).toEqual([0, 0]);
        for (const key of ['startBinding', 'endBinding'] as const) {
          const bind = e[key] as { elementId: string } | null;
          if (bind) expect(byId.get(bind.elementId)?.boundElements.some((x) => x.id === e.id), `${name}: ${bind.elementId} lists ${e.id}`).toBe(true);
        }
      }
      if (e.type === 'image') expect(f.files[e.fileId as string]?.dataURL, `${name} ${e.id} image`).toMatch(/^data:image\/svg\+xml;base64,/);
    }
  };

  const of = (f: ExcalidrawFile, type: ExcalidrawElement['type']) => f.elements.filter((e) => e.type === type);
  const textOf = (f: ExcalidrawFile) => of(f, 'text').map((e) => String(e.text));

  it('converts every example into a file Excalidraw can open', async () => {
    for (const name of fs.readdirSync('examples').map((x) => x.replace('.yaml', ''))) sound(await convert(name), name);
  }, 240000);

  it('keeps every box where draw.io drew it, with its label inside and its arrows attached', async () => {
    const f = await convert('checkout');
    const m = readDrawio(fs.readFileSync(path.join(tmp, 'checkout-clean.drawio.svg'), 'utf8'));
    const cells = await b.inspect(m.xml);
    const api = cells.find((c) => c.id === 'api')!;
    const el = f.elements.find((e) => e.id === 'lw-api')!;
    expect([el.x, el.y, el.width, el.height]).toEqual([api.box.x, api.box.y, api.box.w, api.box.h]);
    const label = f.elements.find((e) => e.containerId === 'lw-api')!;
    expect(String(label.text)).toContain('Checkout API');
    expect(label.x).toBeGreaterThanOrEqual(el.x);
    expect(label.x + label.width).toBeLessThanOrEqual(el.x + el.width);
    // Every edge between two boxes is an arrow attached at both ends.
    const arrows = of(f, 'arrow');
    expect(arrows.length).toBe(m.cells.filter((c) => c.edge).length);
    for (const a of arrows) expect(a.startBinding && a.endBinding, a.id).toBeTruthy();
  }, 60000);

  it('puts each arrow label where linework placed it', async () => {
    const f = await convert('refund-flow');
    const m = readDrawio(fs.readFileSync(path.join(tmp, 'refund-flow-clean.drawio.svg'), 'utf8'));
    const cells = new Map((await b.inspect(m.xml)).map((c) => [c.id, c]));
    let checked = 0;
    for (const a of of(f, 'arrow')) {
      const tb = cells.get(a.id.slice(3))?.textBox;
      if (!tb || !a.boundElements.some((x) => x.type === 'text')) continue;
      const spot = labelSpot((a.points as number[][]).map(([x, y]) => ({ x: a.x + x!, y: a.y + y! })));
      expect(Math.hypot(spot.x - (tb.x + tb.w / 2), spot.y - (tb.y + tb.h / 2)), a.id).toBeLessThan(8);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  }, 60000);

  it('embeds cloud icons as images, one file per distinct icon, grouped with their node', async () => {
    const f = await convert('serverless-aws');
    const images = of(f, 'image');
    expect(images.length).toBeGreaterThan(4);
    expect(Object.keys(f.files).length).toBeLessThan(images.length); // two Lambdas share one file
    for (const img of images) {
      const node = f.elements.find((e) => e.id === img.id.replace(/__icon$/, ''))!;
      expect(node.groupIds.some((g) => img.groupIds.includes(g)), img.id).toBe(true);
      expect(Buffer.from(f.files[img.fileId as string]!.dataURL.split(',')[1]!, 'base64').toString()).toContain('<svg');
    }
  }, 60000);

  it('draws a sequence diagram: heads, dashed stems, messages with their text above the line', async () => {
    const f = await convert('pay-sequence');
    expect(of(f, 'line').filter((e) => e.strokeStyle === 'dashed' && e.id.endsWith('-line')).length).toBe(5);
    expect(textOf(f)).toEqual(expect.arrayContaining(['Shopper', 'POST /checkout', 'alt', '[succeeded]', 'idempotent on event id']));
    const msg = f.elements.find((e) => e.type === 'text' && e.text === 'POST /checkout')!;
    const arrow = f.elements.find((e) => e.type === 'arrow' && e.groupIds.some((g) => msg.groupIds.includes(g)))!;
    expect(msg.containerId).toBeNull();
    expect(msg.y + msg.height).toBeLessThanOrEqual(arrow.y + 2);
  }, 60000);

  it('draws an ER table as a grouped body, header and rows, with crow\'s feet on the lines', async () => {
    const f = await convert('shop-er');
    const group = 'lw-orders-group';
    const parts = f.elements.filter((e) => e.groupIds.includes(group));
    expect(parts.filter((e) => e.type === 'rectangle').length).toBe(2);
    expect(parts.filter((e) => e.type === 'text').map((e) => String(e.text))).toEqual(expect.arrayContaining(['Orders', 'customer_id', 'uuid FK']));
    expect(of(f, 'arrow').some((a) => /^crowfoot/.test(String(a.endArrowhead)) || /^crowfoot/.test(String(a.startArrowhead)))).toBe(true);
  }, 60000);

  it('carries the style across: canvas, hand-drawn roughness, and the bold shadow', async () => {
    expect((await convert('checkout', 'midnight')).appState.viewBackgroundColor).toBe('#101727');
    const sketch = await convert('checkout', 'sketch');
    expect(of(sketch, 'rectangle').every((e) => e.roughness === 1)).toBe(true);
    expect(of(sketch, 'text').every((e) => e.fontFamily === 5)).toBe(true);
    const bold = await convert('checkout', 'bold');
    const shadow = bold.elements.find((e) => e.id === 'lw-api-shadow')!;
    const api = bold.elements.find((e) => e.id === 'lw-api')!;
    expect([shadow.x - api.x, shadow.y - api.y]).toEqual([3, 3]);
    expect(bold.elements.indexOf(shadow)).toBeLessThan(bold.elements.indexOf(api));
    expect((await convert('checkout')).elements.every((e) => e.roughness === 0)).toBe(true);
  }, 120000);

  it('render writes the file, and says so when the extension is wrong', async () => {
    const svg = path.join(tmp, 'checkout-clean.drawio.svg');
    const out = path.join(tmp, 'out.excalidraw');
    await render(svg, out, b);
    const f = JSON.parse(fs.readFileSync(out, 'utf8')) as ExcalidrawFile;
    expect(f.type).toBe('excalidraw');
    expect(f.elements.length).toBeGreaterThan(10);
    await expect(render(svg, path.join(tmp, 'out.pdf'), b)).rejects.toThrow(/\.png, \.svg or \.excalidraw/);
  }, 60000);
});
