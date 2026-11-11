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
import { centreRouteOn, iconPolygons, simplify, toExcalidraw, wrapLines, type ExcalidrawElement, type ExcalidrawFile, type Origin } from '../src/excalidraw/export.js';
import { colorName, embeddedSpec, readEdits, setBoxes, setLabels, tidyPath } from '../src/excalidraw/import.js';
import { embedInPng, embedInSvg, readScene, sceneFromSvg } from '../src/excalidraw/file.js';
import { buildLibrary } from '../src/excalidraw/library.js';
import { concatBuffers, seal, shareLink, shareable, splitBuffers, unseal } from '../src/excalidraw/share.js';
import { watchFile } from '../src/watch.js';
import { importExcalidraw, show } from '../src/api.js';
import { parseSpecText } from '../src/spec/parse.js';

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

describe('wrapping text to a width', () => {
  const width = (s: string) => s.length * 10;
  it('breaks at spaces, keeps a long word whole, and keeps line breaks already there', () => {
    expect(wrapLines('Queue for manual review', 120, width)).toEqual(['Queue for', 'manual', 'review']);
    expect(wrapLines('Supercalifragilistic word', 50, width)).toEqual(['Supercalifragilistic', 'word']);
    expect(wrapLines('one\ntwo three', 1000, width)).toEqual(['one', 'two three']);
  });
});

describe('editing draw.io XML', () => {
  const xml = '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<object id="g" label="G"><mxCell style="x" vertex="1" parent="1"><mxGeometry x="100" y="100" width="300" height="200" as="geometry"/></mxCell></object>' +
    '<object id="a" label="A"><mxCell style="x" vertex="1" parent="g"><mxGeometry x="20" y="30" width="120" height="40" as="geometry"/></mxCell></object>' +
    '<mxCell id="t" value="T" style="shape=swimlane;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="200" height="90" as="geometry"/></mxCell>' +
    '</root></mxGraphModel></diagram></mxfile>';
  const geomOf = (text: string, id: string) => readDrawio(text).byId.get(id)!.geom!;
  const now = new Map([['g', { x: 100, y: 100, w: 300, h: 200 }], ['a', { x: 120, y: 130, w: 120, h: 40 }], ['t', { x: 0, y: 0, w: 200, h: 90 }]]);

  it('places a cell relative to the group it sits in', () => {
    const out = setBoxes(xml, new Map([['a', { x: 200, y: 150, w: 120, h: 40 }]]), now);
    expect(geomOf(out, 'a')).toMatchObject({ x: 100, y: 50, w: 120, h: 40 });
  });

  it('keeps a child where it is on the page when only its group moves', () => {
    const out = setBoxes(xml, new Map([['g', { x: 150, y: 80, w: 300, h: 200 }], ['a', { x: 120, y: 130, w: 120, h: 40 }]]), now);
    expect(geomOf(out, 'g')).toMatchObject({ x: 150, y: 80 });
    expect(geomOf(out, 'a')).toMatchObject({ x: -30, y: 50 });
  });

  it('moves a table without resizing it', () => {
    const out = setBoxes(xml, new Map([['t', { x: 40, y: 60, w: 999, h: 999 }]]), now);
    expect(geomOf(out, 't')).toMatchObject({ x: 40, y: 60, w: 200, h: 90 });
  });

  it('sets a label as text, not markup, on either kind of cell', () => {
    const m = readDrawio(setLabels(xml, new Map([['a', 'x < y & z'], ['t', 'Orders']])));
    expect(m.byId.get('a')!.label).toBe('x &lt; y &amp; z');
    expect(m.byId.get('t')!.label).toBe('Orders');
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
    // A name with a second line is two texts, the second smaller, both inside the box.
    const [label, tech] = [f.elements.find((e) => e.id === 'lw-api-label')!, f.elements.find((e) => e.id === 'lw-api-tech')!];
    expect([label.text, tech.text]).toEqual(['Checkout API', 'Go']);
    expect(tech.fontSize as number).toBeLessThan(label.fontSize as number);
    expect(tech.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
    for (const t of [label, tech]) {
      expect(t.x).toBeGreaterThanOrEqual(el.x);
      expect(t.x + t.width).toBeLessThanOrEqual(el.x + el.width);
      expect(t.y).toBeGreaterThanOrEqual(el.y);
      expect(t.y + t.height).toBeLessThanOrEqual(el.y + el.height);
      expect(t.groupIds.some((g) => el.groupIds.includes(g))).toBe(true);
    }
    // A name alone is the box's own label, as Excalidraw users expect.
    expect(f.elements.find((e) => e.containerId === 'lw-user')!.text).toBe('Shopper');
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
    expect(of(sketch, 'rectangle').filter((e) => e.strokeColor !== 'transparent').every((e) => e.roughness === 1)).toBe(true);
    expect(of(sketch, 'text').every((e) => e.fontFamily === 5)).toBe(true);
    const bold = await convert('checkout', 'bold');
    const shadow = bold.elements.find((e) => e.id === 'lw-api-shadow')!;
    const api = bold.elements.find((e) => e.id === 'lw-api')!;
    expect([shadow.x - api.x, shadow.y - api.y]).toEqual([3, 3]);
    expect(bold.elements.indexOf(shadow)).toBeLessThan(bold.elements.indexOf(api));
    expect((await convert('checkout')).elements.every((e) => e.roughness === 0)).toBe(true);
  }, 120000);

  it('uses right-angle arrows that Excalidraw reroutes, attached just outside the box edge', async () => {
    const f = await convert('checkout');
    const byId = new Map(f.elements.map((e) => [e.id, e]));
    const arrows = of(f, 'arrow');
    expect(arrows.every((a) => a.elbowed === true)).toBe(true);
    for (const a of arrows) {
      const pts = a.points as number[][];
      // Every segment runs along an axis: Excalidraw refuses a slanted elbow arrow.
      for (let i = 1; i < pts.length; i++) expect(Math.min(Math.abs(pts[i]![0]! - pts[i - 1]![0]!), Math.abs(pts[i]![1]! - pts[i - 1]![1]!)), a.id).toBeLessThan(0.5);
      for (const key of ['startBinding', 'endBinding'] as const) {
        const bind = a[key] as { elementId: string; fixedPoint: [number, number] };
        expect(byId.has(bind.elementId)).toBe(true);
        // On an edge means just past it (-0.05 or 1.05): at exactly 0 or 1 Excalidraw misreads the side.
        expect(bind.fixedPoint.some((t) => t === -0.05 || t === 1.05), `${a.id} ${key} ${bind.fixedPoint}`).toBe(true);
        expect(bind.fixedPoint.every((t) => t !== 0 && t !== 1)).toBe(true);
      }
    }
  }, 60000);

  it('keeps arrowheads small with a point a short way from the end', async () => {
    const f = await convert('checkout');
    const a = f.elements.find((e) => e.id === 'lw-e_user__web')!;
    const pts = a.points as number[][];
    const [end, prev] = [pts[pts.length - 1]!, pts[pts.length - 2]!];
    expect(Math.hypot(end[0]! - prev[0]!, end[1]! - prev[1]!)).toBeCloseTo(16, 1);
  }, 60000);

  it('draws a queue with round ends and a slanted data box, each under a cover that takes the label and arrows', async () => {
    const f = await convert('checkout');
    const outline = f.elements.find((e) => e.id === 'lw-queue-outline')!;
    const cover = f.elements.find((e) => e.id === 'lw-queue')!;
    expect(outline.type).toBe('line');
    const pts = outline.points as number[][];
    expect(pts.length).toBeGreaterThan(20);
    expect(pts[pts.length - 1]).toEqual(pts[0]); // closed, so Excalidraw fills it
    const ys = pts.map((p) => outline.y + p[1]!), xs = pts.map((p) => outline.x + p[0]!);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map(Math.round)).toEqual([cover.x, cover.x + cover.width, cover.y, cover.y + cover.height].map(Math.round));
    expect([cover.strokeColor, cover.backgroundColor]).toEqual(['transparent', 'transparent']);
    expect(f.elements.indexOf(cover)).toBeGreaterThan(f.elements.indexOf(outline));
    expect(cover.boundElements.some((x) => x.type === 'arrow')).toBe(true);
    const flow = await convert('deploy-flow');
    const data = flow.elements.filter((e) => e.id.endsWith('-outline') && (e.points as number[][]).length === 5);
    for (const d of data) expect(flow.elements.find((e) => e.id === d.id.replace('-outline', ''))!.type).toBe('rectangle');
  }, 60000);

  it('marks every element with the cell it draws, and carries the spec on a few shapes', async () => {
    for (const name of ['checkout', 'pay-sequence', 'shop-er']) {
      const f = await convert(name);
      for (const e of f.elements) {
        const o = (e.customData as { lw: Origin }).lw;
        expect(o.cell.length, e.id).toBeGreaterThan(0);
        expect(e.id).toBe(o.part === 'shape' ? `lw-${o.cell}` : `lw-${o.cell}-${o.part}`);
      }
      const carriers = f.elements.filter((e) => (e.customData as { lw: Origin }).lw.doc);
      expect(carriers.length, name).toBeGreaterThanOrEqual(2);
      expect(parseSpecText(embeddedSpec(f)!).diagram.nodes.length, name).toBeGreaterThan(2);
    }
  }, 60000);

  it('render writes the file, and says so when the extension is wrong', async () => {
    const svg = path.join(tmp, 'checkout-clean.drawio.svg');
    const out = path.join(tmp, 'out.excalidraw');
    await render(svg, out, b);
    const f = JSON.parse(fs.readFileSync(out, 'utf8')) as ExcalidrawFile;
    expect(f.type).toBe('excalidraw');
    expect(f.elements.length).toBeGreaterThan(10);
    await expect(render(svg, path.join(tmp, 'out.pdf'), b)).rejects.toThrow(/\.png, \.svg, \.excalidraw/);
  }, 60000);
});

describe.runIf(run)('edits made in Excalidraw come back', () => {
  let b: DrawioBrowser;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-roundtrip-'));
  beforeAll(async () => {
    b = await DrawioBrowser.launch();
  }, 60000);
  afterAll(async () => {
    await b?.close();
  });

  /** Build an example, export it, let `edit` change the Excalidraw file as a person would, and import it. */
  const roundTrip = async (example: string, edit: (f: ExcalidrawFile, el: (id: string) => ExcalidrawElement) => void, name = example) => {
    const out = path.join(tmp, `${name}.drawio.svg`);
    fs.rmSync(out, { force: true });
    await build(fs.readFileSync(`examples/${example}.yaml`, 'utf8'), { out, browser: b });
    const before = fs.readFileSync(out, 'utf8');
    const f = await toExcalidraw(readDrawio(before), b);
    edit(f, (id) => {
      const e = f.elements.find((x) => x.id === id);
      if (!e) throw new Error(`no element ${id}`);
      return e;
    });
    const file = path.join(tmp, `${name}.excalidraw`);
    fs.writeFileSync(file, JSON.stringify(f));
    const res = await importExcalidraw(file, out, { browser: b });
    const after = fs.readFileSync(out, 'utf8');
    return { res, out, file, before, after, spec: parseSpecText(show(out).yaml).diagram, cells: new Map((await b.inspect(readDrawio(after).xml)).map((c) => [c.id, c])) };
  };
  const retype = (t: ExcalidrawElement, text: string) => Object.assign(t, { text, originalText: text });
  /** What Excalidraw adds when someone draws a box and types in it. */
  const drawBox = (f: ExcalidrawFile, id: string, type: 'rectangle' | 'diamond', box: [number, number, number, number], label: string) => {
    const base = { angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, isDeleted: false, link: null, locked: false };
    f.elements.push({ ...base, id, type, x: box[0], y: box[1], width: box[2], height: box[3], boundElements: [{ id: `${id}-t`, type: 'text' }] });
    f.elements.push({ ...base, id: `${id}-t`, type: 'text', x: box[0] + 10, y: box[1] + 10, width: box[2] - 20, height: 25, boundElements: [], text: label, originalText: label, containerId: id, fontSize: 20, fontFamily: 5 });
  };
  const drawArrow = (f: ExcalidrawFile, id: string, from: ExcalidrawElement, to: ExcalidrawElement, over: Record<string, unknown> = {}) => {
    const [x0, y0, x1, y1] = [from.x + from.width / 2, from.y + from.height, to.x + to.width / 2, to.y];
    f.elements.push({ id, type: 'arrow', x: x0, y: y0, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0), points: [[0, 0], [x1 - x0, y1 - y0]], groupIds: [], boundElements: [], isDeleted: false, strokeStyle: 'solid', startBinding: { elementId: from.id, focus: 0, gap: 1 }, endBinding: { elementId: to.id, focus: 0, gap: 1 }, endArrowhead: 'arrow', startArrowhead: null, ...over });
  };

  it('changes nothing, and writes nothing, when the file was not edited', async () => {
    for (const example of ['checkout', 'pay-sequence', 'shop-er', 'refund-flow', 'job-state']) {
      const r = await roundTrip(example, () => {});
      expect(r.res.changes, example).toEqual([]);
      expect(r.after === r.before, example).toBe(true);
    }
  }, 240000);

  it('reads new text: a name, a second line, a group title and an arrow label', async () => {
    const r = await roundTrip('checkout', (f, el) => {
      retype(f.elements.find((e) => e.containerId === 'lw-user')!, 'Customer');
      retype(el('lw-api-label'), 'Checkout\nservice'); // wrapped by Excalidraw: still one name
      retype(el('lw-db-tech'), 'Aurora');
      retype(el('lw-vpc-title'), 'Prod account');
      retype(f.elements.find((e) => e.containerId === 'lw-e_api__db')!, 'read and write');
    });
    const node = (id: string) => r.spec.nodes.find((n) => n.id === id)!;
    expect(node('user').label).toBe('Customer');
    expect(node('api')).toMatchObject({ label: 'Checkout service', tech: 'Go', highlight: true });
    expect(node('db')).toMatchObject({ label: 'Orders', tech: 'Aurora', kind: 'database' });
    expect(r.spec.groups.find((g) => g.id === 'vpc')!.label).toBe('Prod account');
    expect(r.spec.edges.find((e) => e.id === 'api->db')!.label).toBe('read and write');
    expect(r.res.changes.length).toBe(5);
    // Nothing moved, so nothing else did: every other box is where it was.
    const was = new Map((await b.inspect(readDrawio(r.before).xml)).map((c) => [c.id, c.box]));
    for (const id of ['web', 'gw', 'queue', 'cache', 'stripe']) expect(r.cells.get(id)!.box, id).toEqual(was.get(id));
  }, 120000);

  it('removes a deleted second line, a deleted label, a deleted arrow and a deleted box with its arrows', async () => {
    const r = await roundTrip('checkout', (f, el) => {
      el('lw-web-tech').isDeleted = true;
      f.elements.find((e) => e.containerId === 'lw-e_user__web')!.isDeleted = true;
      el('lw-e_api__cache').isDeleted = true;
      for (const e of f.elements) if ((e.customData as { lw: Origin }).lw.cell === 'email') e.isDeleted = true;
    });
    expect(r.spec.nodes.find((n) => n.id === 'web')!.tech).toBeUndefined();
    expect(r.spec.edges.find((e) => e.id === 'user->web')!.label).toBeUndefined();
    expect(r.spec.edges.map((e) => e.id)).not.toContain('api->cache');
    expect(r.spec.nodes.map((n) => n.id)).not.toContain('email');
    expect(r.spec.edges.some((e) => e.to === 'email')).toBe(false);
    expect(r.cells.has('email')).toBe(false);
    expect(r.res.check.findings.filter((x) => x.level === 'error')).toEqual([]);
  }, 120000);

  it('puts a moved box where Excalidraw has it and reroutes its arrows, leaving the rest alone', async () => {
    const r = await roundTrip('checkout', (f, el) => {
      for (const e of f.elements) if (e.groupIds.some((g) => el('lw-stripe').groupIds.includes(g))) Object.assign(e, { x: e.x + 150, y: e.y - 120 });
    });
    const was = new Map((await b.inspect(readDrawio(r.before).xml)).map((c) => [c.id, c]));
    const [old, now] = [was.get('stripe')!.box, r.cells.get('stripe')!.box];
    expect([now.x - old.x, now.y - old.y]).toEqual([150, -120]);
    expect(r.res.changes).toEqual(['moved or resized 1 box']);
    // The arrow into it ends on it again, and no arrow runs through a box.
    const end = r.cells.get('e_api__stripe')!.points!.at(-1)!;
    expect(end.x).toBeGreaterThanOrEqual(now.x - 1);
    expect(end.x).toBeLessThanOrEqual(now.x + now.w + 1);
    expect(Math.abs(end.y - now.y)).toBeLessThan(2);
    expect(r.res.check.findings.filter((x) => x.level === 'error')).toEqual([]);
    for (const id of ['web', 'gw', 'api', 'db', 'email']) expect(r.cells.get(id)!.box, id).toEqual(was.get(id)!.box);
    // A second import of the same file finds nothing left to do.
    const again = await importExcalidraw(r.file, r.out, { browser: b });
    expect(again.changes).toEqual([]);
  }, 120000);

  it('adds a box and an arrow drawn in Excalidraw, in the group they were drawn in, at the place they were drawn', async () => {
    const r = await roundTrip('checkout', (f, el) => {
      const api = el('lw-api'), vpc = el('lw-vpc');
      drawBox(f, 'new1', 'rectangle', [vpc.x + 20, api.y, 150, 60], 'Fraud check');
      drawArrow(f, 'arrow1', api, f.elements.find((e) => e.id === 'new1')!, { strokeStyle: 'dashed' });
      const t = { id: 'arrow1-t', type: 'text' as const, x: 0, y: 0, width: 40, height: 20, groupIds: [], boundElements: [], isDeleted: false, text: 'score', originalText: 'score', containerId: 'arrow1' };
      f.elements.push(t);
      drawBox(f, 'blank', 'rectangle', [900, 900, 80, 40], '');
      f.elements.find((e) => e.id === 'blank-t')!.isDeleted = true;
    });
    const fraud = r.spec.nodes.find((n) => n.id === 'fraud_check')!;
    expect(fraud).toMatchObject({ label: 'Fraud check', kind: 'service', parent: 'vpc' });
    expect(r.spec.edges.find((e) => e.id === 'api->fraud_check')).toMatchObject({ label: 'score', style: 'async' });
    const vpc = (await b.inspect(readDrawio(r.before).xml)).find((c) => c.id === 'vpc')!.box;
    const api = (await b.inspect(readDrawio(r.before).xml)).find((c) => c.id === 'api')!.box;
    expect(r.cells.get('fraud_check')!.box).toMatchObject({ x: vpc.x + 20, y: api.y, w: 150, h: 60 });
    expect(r.res.notes.join(' ')).toMatch(/1 shape drawn in Excalidraw has no text/);
    expect(r.res.changes).toEqual(expect.arrayContaining(['added "Fraud check"', 'added an arrow from "Checkout API" to "Fraud check": score']));
  }, 120000);

  it('makes a copied box a new node of the same kind, and a drawn diamond a decision', async () => {
    const r = await roundTrip('refund-flow', (f, el) => {
      // Excalidraw's duplicate: new ids and a new group, the same customData.
      const src = el('lw-deny');
      const copies = f.elements.filter((e) => e === src || e.containerId === src.id).map((e) => ({ ...structuredClone(e), id: `copy-${e.id}`, x: e.x + 300 }));
      copies.find((e) => e.type === 'text')!.containerId = 'copy-lw-deny';
      retype(copies.find((e) => e.type === 'text')!, 'Escalate');
      copies.find((e) => e.type !== 'text')!.boundElements = [{ id: copies.find((e) => e.type === 'text')!.id, type: 'text' }];
      f.elements.push(...copies);
      drawBox(f, 'dia', 'diamond', [600, 300, 180, 90], 'Fraud flag?');
    });
    expect(r.spec.nodes.find((n) => n.id === 'escalate')).toMatchObject({ label: 'Escalate', kind: 'error' });
    expect(r.spec.nodes.find((n) => n.id === 'fraud_flag')).toMatchObject({ label: 'Fraud flag?', kind: 'decision' });
    expect(r.spec.nodes.find((n) => n.id === 'deny')!.label).toBe('Deny with reason');
  }, 120000);

  it('follows an arrow dragged to another box, by attachment or by where it now ends', async () => {
    const r = await roundTrip('checkout', (f, el) => {
      (el('lw-e_worker__email').endBinding as { elementId: string }).elementId = 'lw-stripe';
      // Detached, but its end dropped on the cache.
      const a = el('lw-e_api__db'), cache = el('lw-cache');
      a.endBinding = null;
      const pts = a.points as number[][];
      pts[pts.length - 1] = [cache.x + cache.width / 2 - a.x, cache.y - a.y];
    });
    const ids = r.spec.edges.map((e) => e.id);
    expect(ids).toContain('worker->stripe');
    expect(ids).not.toContain('worker->email');
    expect(ids).toContain('api->cache#2');
    expect(ids).not.toContain('api->db');
    expect(r.spec.edges.find((e) => e.id === 'api->cache#2')!.label).toBe('SQL');
  }, 120000);

  it('moves a box dragged out of its group out of it in the spec too, and drops a deleted group but keeps its boxes', async () => {
    const r = await roundTrip('checkout', (f, el) => {
      for (const e of f.elements) if (e.groupIds.some((g) => el('lw-cache').groupIds.includes(g))) Object.assign(e, { x: e.x - 400 });
    });
    expect(r.spec.nodes.find((n) => n.id === 'cache')!.parent).toBeUndefined();
    expect(r.spec.nodes.find((n) => n.id === 'db')!.parent).toBe('data');
    const gone = await roundTrip('checkout', (f) => {
      for (const e of f.elements) if ((e.customData as { lw: Origin }).lw.cell === 'data') e.isDeleted = true;
    }, 'checkout-nogroup');
    expect(gone.spec.groups.map((g) => g.id)).toEqual(['vpc']);
    expect(gone.spec.nodes.find((n) => n.id === 'db')!.parent).toBe('vpc');
  }, 180000);

  /** A message as a person sees it: the arrow, found by the text over it. */
  const message = (f: ExcalidrawFile, text: string) => {
    const t = f.elements.find((e) => e.type === 'text' && e.text === text)!;
    return f.elements.filter((e) => e.groupIds.some((g) => t.groupIds.includes(g)) || e.id === t.containerId || e === t);
  };
  const line = (f: ExcalidrawFile, id: string, from: [number, number], to: [number, number], label?: string, over: Record<string, unknown> = {}) => {
    f.elements.push({ id, type: 'arrow', x: from[0], y: from[1], width: Math.abs(to[0] - from[0]), height: Math.abs(to[1] - from[1]), points: [[0, 0], [to[0] - from[0], to[1] - from[1]]], groupIds: [], boundElements: label ? [{ id: `${id}-t`, type: 'text' }] : [], isDeleted: false, strokeStyle: 'solid', strokeColor: '#1e1e1e', startBinding: null, endBinding: null, endArrowhead: 'arrow', startArrowhead: null, ...over });
    if (label) f.elements.push({ id: `${id}-t`, type: 'text', x: from[0], y: from[1], width: 60, height: 20, groupIds: [], boundElements: [], isDeleted: false, text: label, originalText: label, containerId: id });
  };
  const freeText = (f: ExcalidrawFile, id: string, at: [number, number], text: string) =>
    f.elements.push({ id, type: 'text', x: at[0], y: at[1], width: 120, height: 20 * text.split('\n').length, groupIds: [], boundElements: [], isDeleted: false, text, originalText: text, containerId: null });
  const stemX = (el: (id: string) => ExcalidrawElement, id: string) => el(`lw-${id}`).x + el(`lw-${id}`).width / 2;
  type Msg = { kind: string; from?: string; to?: string; label?: string; text?: string; style?: string; branches?: Array<{ items: Msg[] }> };
  const flat = (items: Msg[]): Msg[] => items.flatMap((i) => (i.kind === 'frame' ? i.branches!.flatMap((br) => flat(br.items)) : [i]));

  it('reads text edits to a sequence diagram', async () => {
    const r = await roundTrip('pay-sequence', (f) => {
      const byText = (t: string) => f.elements.find((e) => e.type === 'text' && e.text === t)!;
      retype(byText('POST /checkout'), 'POST /v2/checkout');
      retype(byText('Shopper'), 'Buyer');
      retype(byText('idempotent on event id'), 'safe to retry');
      retype(byText('[declined]'), 'card refused');
    });
    const yaml = show(r.out).yaml;
    expect(yaml).toContain('POST /v2/checkout');
    expect(yaml).toContain('label: Buyer');
    expect(yaml).toContain('safe to retry');
    expect(yaml).toContain('card refused');
    expect(r.spec.nodes.length).toBe(5);
    expect(r.res.changes.length).toBe(4);
  }, 120000);

  it('adds a participant, a message and a note drawn in a sequence diagram, where they were drawn', async () => {
    const r = await roundTrip('pay-sequence', (f, el) => {
      const db = el('lw-db');
      // A box level with the other participants is one more of them.
      drawBox(f, 'ledger', 'rectangle', [db.x + db.width + 60, db.y, 140, db.height], 'Ledger');
      const after = message(f, 'create PaymentIntent').find((e) => e.type === 'arrow')!;
      line(f, 'post', [stemX(el, 'api'), after.y + 12], [db.x + db.width + 130, after.y + 12], 'record charge');
      line(f, 'back', [db.x + db.width + 130, after.y + 20], [stemX(el, 'api'), after.y + 20], 'ok', { strokeStyle: 'dashed' });
      // A box anywhere lower down is a note over whichever lines it covers.
      drawBox(f, 'memo', 'rectangle', [stemX(el, 'user') - 60, after.y + 26, 120, 30], 'tell support');
      line(f, 'stray', [5, 5], [stemX(el, 'api'), 5]);
    }, 'seq-add');
    expect(r.spec.nodes.map((n) => n.id)).toEqual(['user', 'web', 'api', 'stripe', 'db', 'ledger']);
    const seq = flat(r.spec.seq as Msg[]);
    const at = seq.findIndex((i) => i.label === 'create PaymentIntent');
    expect(seq.slice(at + 1, at + 4)).toMatchObject([
      { kind: 'msg', from: 'api', to: 'ledger', label: 'record charge', style: 'sync' },
      { kind: 'msg', from: 'ledger', to: 'api', label: 'ok', style: 'reply' },
      { kind: 'note', text: 'tell support' },
    ]);
    expect(seq[at + 4]).toMatchObject({ label: 'client_secret', from: 'stripe' });
    expect(r.res.changes).toEqual(expect.arrayContaining(['added participant "Ledger"', 'added a message from "Checkout API" to "Ledger": record charge', 'added a note: "tell support"']));
    expect(r.res.notes.join(' ')).toMatch(/1 arrow drawn in Excalidraw doesn't run between two participants/);
    expect(r.res.check.findings.filter((x) => x.level === 'error')).toEqual([]);
    // The result is a clean diagram again: exporting and importing it changes nothing.
    const again = path.join(tmp, 'seq-add-again.excalidraw');
    await render(r.out, again, b);
    expect((await importExcalidraw(again, r.out, { browser: b })).changes).toEqual([]);
  }, 120000);

  it('removes, reorders and reconnects messages, and drops a participant with everything on its line', async () => {
    const r = await roundTrip('pay-sequence', (f, el) => {
      // "Click Pay" dragged down past the next message.
      const first = message(f, 'Click "Pay"'), second = message(f, 'POST /checkout').find((e) => e.type === 'arrow')!;
      const gap = second.y - first.find((e) => e.type === 'arrow')!.y;
      for (const e of first) e.y += gap + 10;
      for (const e of message(f, 'result page')) e.isDeleted = true;
      // The declined reply dragged from the web app's line to the shopper's.
      const reply = message(f, 'card_declined').find((e) => e.type === 'arrow')!;
      const pts = reply.points as number[][];
      const endX = reply.x + pts[pts.length - 1]![0]!;
      pts[pts.length - 1]![0]! += stemX(el, 'user') - endX;
      for (const e of f.elements) if ((e.customData as { lw: Origin }).lw.cell === 'db' || e.groupIds.includes('lw-db-group')) e.isDeleted = true;
    }, 'seq-edit');
    const seq = flat(r.spec.seq as Msg[]);
    expect(seq.slice(0, 2).map((i) => i.label)).toEqual(['POST /checkout', 'Click "Pay"']);
    expect(seq.some((i) => i.label === 'result page')).toBe(false);
    expect(seq.find((i) => i.label === 'card_declined')).toMatchObject({ from: 'stripe', to: 'user' });
    expect(r.spec.nodes.map((n) => n.id)).toEqual(['user', 'web', 'api', 'stripe']);
    expect(seq.some((i) => i.from === 'db' || i.to === 'db')).toBe(false);
    // The frame is still there, with both its branches.
    const frame = (r.spec.seq as Msg[]).find((i) => i.kind === 'frame')!;
    expect(frame.branches!.length).toBe(2);
    expect(r.res.changes).toEqual(expect.arrayContaining(['removed participant "Orders DB"', 'removed the message "result page"', 'the message "card_declined" now runs from "Stripe" to "Shopper"', 'put the messages in a new order']));
    expect(r.res.check.findings.filter((x) => x.level === 'error')).toEqual([]);
  }, 120000);

  it('reads a sequence diagram the same after the whole drawing is dragged somewhere else', async () => {
    const r = await roundTrip('pay-sequence', (f) => {
      for (const e of f.elements) Object.assign(e, { x: e.x + 300, y: e.y - 140 });
    }, 'seq-shift');
    expect(r.res.changes).toEqual([]);
  }, 120000);

  it('reads columns added, renamed, retyped, removed and reordered in a table, and a table drawn from scratch', async () => {
    const r = await roundTrip('shop-er', (f, el) => {
      const orders = el('lw-orders');
      freeText(f, 'c1', [orders.x + 14, orders.y + orders.height + 4], 'notes text null');
      for (const part of ['name', 'type']) el(`lw-addresses__city-${part}`).isDeleted = true;
      retype(el('lw-products__sku-name'), 'code');
      retype(el('lw-products__title-type'), 'varchar(80) unique');
      // Swap two rows of inventory.
      const [wh, on] = [el('lw-inventory__warehouse-name'), el('lw-inventory__on_hand-name')];
      const [y1, y2] = [wh.y, on.y];
      for (const part of ['name', 'type']) {
        el(`lw-inventory__warehouse-${part}`).y = y2;
        el(`lw-inventory__on_hand-${part}`).y = y1;
      }
      drawBox(f, 'coupons', 'rectangle', [orders.x, orders.y + orders.height + 200, 220, 110], 'Coupons');
      f.elements.find((e) => e.id === 'coupons-t')!.y = orders.y + orders.height + 204;
      freeText(f, 'c2', [orders.x + 14, orders.y + orders.height + 240], 'id uuid pk\ncode: text unique');
      drawArrow(f, 'rel', el('lw-orders'), f.elements.find((e) => e.id === 'coupons')!);
    }, 'er-columns');
    const table = (id: string) => r.spec.nodes.find((n) => n.id === id)!;
    expect(table('orders').fields!.at(-1)).toEqual({ name: 'notes', type: 'text', flags: ['null'] });
    expect(table('addresses').fields!.map((x) => x.name)).toEqual(['id', 'customer_id', 'line1', 'country']);
    expect(table('products').fields!.find((x) => x.name === 'code')).toMatchObject({ type: 'text', flags: ['unique'] });
    expect(table('products').fields!.find((x) => x.name === 'title')).toMatchObject({ type: 'varchar(80)', flags: ['unique'] });
    expect(table('inventory').fields!.map((x) => x.name)).toEqual(['product_id', 'on_hand', 'warehouse']);
    expect(table('coupons')).toMatchObject({ kind: 'entity', label: 'Coupons', fields: [{ name: 'id', type: 'uuid', flags: ['pk'] }, { name: 'code', type: 'text', flags: ['unique'] }] });
    expect(r.spec.edges.find((e) => e.from === 'orders' && e.to === 'coupons')!.card).toBeDefined();
    expect(r.res.changes).toEqual(expect.arrayContaining([
      'added column "notes" to "Orders"', 'removed column "city" from "Addresses"', 'renamed column "sku" to "code" in "Products"',
      '"Products".title is now varchar(80) unique', 'reordered the columns of "Inventory"', 'added table "Coupons"',
    ]));
    // The tables grew or shrank to their rows.
    expect(r.cells.has('orders__notes')).toBe(true);
    expect(r.cells.has('addresses__city')).toBe(false);
    expect(r.res.check.findings.filter((x) => x.level === 'error')).toEqual([]);
    const again = path.join(tmp, 'er-again.excalidraw');
    await render(r.out, again, b);
    expect((await importExcalidraw(again, r.out, { browser: b })).changes).toEqual([]);
  }, 120000);

  it('reads colors and line styles picked in Excalidraw as the nearest of linework\'s', async () => {
    const r = await roundTrip('checkout', (f, el) => {
      // Excalidraw's own palette: a red fill, a blue stroke, a green group.
      for (const e of f.elements) if (e.type !== 'text' && e.type !== 'image' && (e.customData as { lw: Origin }).lw.cell === 'stripe') e.backgroundColor = '#ffc9c9';
      el('lw-e_api__db').strokeColor = '#1971c2';
      el('lw-vpc').strokeColor = '#2f9e44';
      el('lw-e_user__web').strokeStyle = 'dashed';
      Object.assign(el('lw-e_web__gw'), { startArrowhead: 'arrow' });
    }, 'colors');
    expect(r.spec.nodes.find((n) => n.id === 'stripe')!.color).toBe('red');
    expect(r.spec.edges.find((e) => e.id === 'api->db')!.color).toBe('blue');
    expect(r.spec.groups.find((g) => g.id === 'vpc')!.color).toBe('green');
    expect(r.spec.edges.find((e) => e.id === 'user->web')!.style).toBe('async');
    expect(r.spec.edges.find((e) => e.id === 'web->gw')!.style).toBe('bidir');
    expect(r.res.changes.length).toBe(5);
    // Nothing moved for it.
    const was = new Map((await b.inspect(readDrawio(r.before).xml)).map((c) => [c.id, c.box]));
    for (const id of ['web', 'gw', 'api', 'db', 'stripe']) expect(r.cells.get(id)!.box, id).toEqual(was.get(id));
    // The same file again asks for nothing new: its colors already are the diagram's.
    expect((await importExcalidraw(r.file, r.out, { browser: b })).changes).toEqual([]);
    // Back to no color at all.
    const f = await toExcalidraw(readDrawio(fs.readFileSync(r.out, 'utf8')), b);
    for (const e of f.elements) if (e.type !== 'text' && e.type !== 'image' && (e.customData as { lw: Origin }).lw.cell === 'stripe') e.backgroundColor = 'transparent';
    fs.writeFileSync(r.file, JSON.stringify(f));
    const cleared = await importExcalidraw(r.file, r.out, { browser: b });
    expect(cleared.changes).toEqual(['"Stripe" is back to its own color']);
    expect(parseSpecText(show(r.out).yaml).diagram.nodes.find((n) => n.id === 'stripe')!.color).toBeUndefined();
  }, 120000);

  it('names the nearest color for anything Excalidraw offers', () => {
    const cases: Record<string, string> = {
      '#e03131': 'red', '#ffc9c9': 'red', '#e8590c': 'orange', '#f08c00': 'orange', '#ffec99': 'amber', '#2f9e44': 'green', '#b2f2bb': 'green',
      '#099268': 'teal', '#0c8599': 'teal', '#1971c2': 'blue', '#a5d8ff': 'blue', '#6741d9': 'violet', '#d0bfff': 'violet', '#c2255c': 'pink', '#fcc2d7': 'pink',
      '#868e96': 'gray', '#1e1e1e': 'none', '#ffffff': 'none', transparent: 'none',
    };
    for (const [hex, want] of Object.entries(cases)) expect(colorName(hex), hex).toBe(want);
    expect(colorName('rgb(1,2,3)')).toBeUndefined();
  });

  it('keeps an arrow path a person drew, and reroutes the ones Excalidraw routed itself', async () => {
    let detour = 0;
    let picked = '';
    const r = await roundTrip('checkout', (f) => {
      // A straight right-angle arrow, given a bump by dragging its middle out.
      const straight = f.elements.find((e) => e.type === 'arrow' && e.elbowed && tidyPath((e.points as number[][]).map(([x, y]) => ({ x: x!, y: y! }))).length === 2)!;
      picked = straight.id;
      const pts = straight.points as number[][];
      const end = pts[pts.length - 1]!;
      const horizontal = Math.abs(end[0]!) > Math.abs(end[1]!);
      const [a, c] = horizontal ? [end[0]! / 3, (2 * end[0]!) / 3] : [end[1]! / 3, (2 * end[1]!) / 3];
      detour = horizontal ? straight.y - 28 : straight.x - 28;
      straight.points = horizontal ? [[0, 0], [a, 0], [a, -28], [c, -28], [c, 0], end] : [[0, 0], [0, a], [-28, a], [-28, c], [0, c], end];
      straight.fixedSegments = [{ index: 3, start: straight.points[2], end: straight.points[3] }];
    }, 'route');
    const cellId = picked.slice(3);
    const route = r.cells.get(cellId)!.points!;
    const horizontal = Math.abs(route[0]!.x - route.at(-1)!.x) > Math.abs(route[0]!.y - route.at(-1)!.y);
    expect(route.some((p) => Math.abs((horizontal ? p.y : p.x) - detour) < 1.5), JSON.stringify(route)).toBe(true);
    expect(r.res.changes).toEqual([expect.stringMatching(/^kept the path drawn for the arrow from/)]);
    // The same file again: the path is already the diagram's.
    expect((await importExcalidraw(r.file, r.out, { browser: b })).changes).toEqual([]);
  }, 120000);

  it('writes and reads Excalidraw\'s image files: a picture with the drawing inside it', async () => {
    const src = path.join(tmp, 'img-src.drawio.svg');
    await build(fs.readFileSync('examples/checkout.yaml', 'utf8'), { out: src, browser: b });
    const plain = await toExcalidraw(readDrawio(fs.readFileSync(src, 'utf8')), b);
    for (const ext of ['svg', 'png'] as const) {
      const file = path.join(tmp, `img.excalidraw.${ext}`);
      await render(src, file, b);
      const bytes = fs.readFileSync(file);
      if (ext === 'svg') {
        expect(bytes.toString('utf8')).toMatch(/<svg[^>]*><!-- svg-source:excalidraw --><metadata><!-- payload-type:application\/vnd\.excalidraw\+json -->/);
        expect(bytes.toString('utf8')).not.toContain('mxfile');
      } else expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect(readScene(file).elements.map((e) => e.id)).toEqual(plain.elements.map((e) => e.id));
      expect(readScene(file).files).toEqual(plain.files);
      const res = await importExcalidraw(file, src, { browser: b });
      expect(res.changes, ext).toEqual([]);
    }
    // Edited and saved again as a picture, the edit comes back.
    const scene = readScene(path.join(tmp, 'img.excalidraw.png'));
    retype(scene.elements.find((e) => e.containerId === 'lw-user')!, 'Member');
    const edited = path.join(tmp, 'img-edited.excalidraw.png');
    fs.writeFileSync(edited, embedInPng(fs.readFileSync(path.join(tmp, 'img.excalidraw.png')), JSON.stringify(scene)));
    expect((await importExcalidraw(edited, src, { browser: b })).changes).toEqual(['renamed "Shopper" to "Member"']);
    expect(() => readScene(src)).toThrow(/no Excalidraw scene in it/);
    // Text that is not Latin-1 survives the trip.
    expect(sceneFromSvg(embedInSvg('<svg xmlns="x" content="&lt;a&gt;"><g/></svg>', '{"type":"excalidraw","t":"naïve ✓ 日本"}'))).toBe('{"type":"excalidraw","t":"naïve ✓ 日本"}');
  }, 120000);

  it('keeps an ER table\'s columns, renames it, moves it and adds a relationship', async () => {
    const r = await roundTrip('shop-er', (f, el) => {
      retype(el('lw-orders-title'), 'Purchases');
      for (const e of f.elements) if (e.groupIds.includes('lw-inventory-group')) Object.assign(e, { y: e.y + 200 });
      drawArrow(f, 'rel', el('lw-inventory'), el('lw-payments'));
    });
    const orders = r.spec.nodes.find((n) => n.id === 'orders')!;
    expect(orders.label).toBe('Purchases');
    expect(orders.fields!.length).toBeGreaterThan(3);
    expect(r.spec.edges.find((e) => e.from === 'inventory' && e.to === 'payments')!.card).toBeDefined();
    const was = (await b.inspect(readDrawio(r.before).xml)).find((c) => c.id === 'inventory')!.box;
    expect(r.cells.get('inventory')!.box).toMatchObject({ x: was.x, y: was.y + 200, w: was.w, h: was.h });
  }, 120000);

  it('gives a stale file the last word without doing its edits twice', async () => {
    // Excalidraw keeps the file open: the second save still describes the first export.
    const r = await roundTrip('pay-sequence', (f) => {
      for (const e of message(f, 'result page')) e.isDeleted = true;
      retype(f.elements.find((e) => e.type === 'text' && e.text === 'mark paid')!, 'mark as paid');
    }, 'seq-stale');
    expect(r.res.changes.length).toBe(2);
    expect((await importExcalidraw(r.file, r.out, { browser: b })).changes).toEqual([]);
    const f = JSON.parse(fs.readFileSync(r.file, 'utf8')) as ExcalidrawFile;
    for (const e of message(f, 'show error')) e.isDeleted = true;
    fs.writeFileSync(r.file, JSON.stringify(f));
    const third = await importExcalidraw(r.file, r.out, { browser: b });
    expect(third.changes).toContain('removed the message "show error"');
    const labels = flat(parseSpecText(show(r.out).yaml).diagram.seq as Msg[]).map((i) => i.label ?? i.text);
    expect(labels).toEqual(['Click "Pay"', 'POST /checkout', 'insert order (pending)', 'order id', 'create PaymentIntent', 'client_secret', 'client_secret', 'confirmCardPayment', 'webhook payment_succeeded', 'mark as paid', 'idempotent on event id', 'card_declined']);

    // The same for boxes and arrows somebody drew: imported once, they are not added again.
    const c = await roundTrip('checkout', (f2, el) => {
      const api = el('lw-api');
      drawBox(f2, 'new1', 'rectangle', [api.x + 20, api.y + api.height + 200, 150, 50], 'Fraud check');
      drawArrow(f2, 'arr1', api, f2.elements.find((e) => e.id === 'new1')!);
    }, 'stale-box');
    expect(c.spec.nodes.some((n) => n.id === 'fraud_check')).toBe(true);
    expect((await importExcalidraw(c.file, c.out, { browser: b })).changes).toEqual([]);
    const d = parseSpecText(show(c.out).yaml).diagram;
    expect(d.nodes.filter((n) => n.label === 'Fraud check').length).toBe(1);
    expect(d.edges.filter((e) => e.to === 'fraud_check').length).toBe(1);
  }, 180000);

  it('reads a node dragged in from a linework library as that kind of node, with its icon', async () => {
    const lib = await buildLibrary('aws', b, { names: ['lambda', 'not_a_real_icon'] });
    const shapes = await buildLibrary('shapes', b, { theme: 'soft' });
    expect(lib.libraryItems.map((i) => i.name)).toEqual(['aws.lambda']);
    expect(shapes.libraryItems.map((i) => i.name)).toEqual(expect.arrayContaining(['service', 'database', 'queue', 'decision', 'terminal', 'start', 'end']));
    for (const item of [...lib.libraryItems, ...shapes.libraryItems]) {
      // A library holds no images, and every element says what it is a part of.
      expect(item.elements.some((e) => e.type === 'image'), item.name).toBe(false);
      for (const e of item.elements) expect((e.customData as { lw: Origin }).lw.lib?.kind, `${item.name} ${e.id}`).toBeTruthy();
      expect(Math.min(...item.elements.map((e) => e.x))).toBe(0);
    }
    expect(lib.libraryItems[0]!.elements.filter((e) => e.type === 'line').length).toBeGreaterThan(1);
    /** What Excalidraw does when an item is dropped: new ids, new groups, a new place. */
    const drop = (f: ExcalidrawFile, item: (typeof lib.libraryItems)[number], at: [number, number], tag: string, label?: string) => {
      for (const e of item.elements) {
        const copy = { ...structuredClone(e), id: `${tag}-${e.id}`, x: e.x + at[0], y: e.y + at[1], groupIds: e.groupIds.map((g) => `${tag}-${g}`), boundElements: e.boundElements.map((x) => ({ ...x, id: `${tag}-${x.id}` })), ...(e.containerId ? { containerId: `${tag}-${e.containerId}` } : {}) };
        if (label && copy.type === 'text') Object.assign(copy, { text: label, originalText: label });
        f.elements.push(copy);
      }
    };
    const r = await roundTrip('serverless-aws', (f) => {
      const far = Math.max(...f.elements.map((e) => e.y + e.height));
      drop(f, lib.libraryItems[0]!, [40, far + 80], 'p1', 'Resize images');
      drop(f, shapes.libraryItems.find((i) => i.name === 'queue')!, [320, far + 80], 'p2', 'Dead letters');
    }, 'library');
    expect(r.spec.nodes.find((n) => n.label === 'Resize images')).toMatchObject({ kind: 'service', icon: 'aws.lambda' });
    expect(r.spec.nodes.find((n) => n.label === 'Dead letters')).toMatchObject({ kind: 'queue' });
    expect(r.cells.has('resize_images__icon')).toBe(true);
    // Dropped into a flowchart, where there are no queues or icons, it is a plain step.
    const flow = await roundTrip('refund-flow', (f) => drop(f, lib.libraryItems[0]!, [0, -200], 'p3', 'Notify'), 'library-flow');
    expect(flow.spec.nodes.find((n) => n.label === 'Notify')).toMatchObject({ kind: 'step' });
    expect(flow.spec.nodes.find((n) => n.label === 'Notify')!.icon).toBeUndefined();
  }, 180000);

  it('draws icons as shapes when asked: every hole filled with what shows through it', async () => {
    const out = path.join(tmp, 'vector.drawio.svg');
    await build(fs.readFileSync('examples/serverless-aws.yaml', 'utf8'), { out, browser: b });
    const m = readDrawio(fs.readFileSync(out, 'utf8'));
    const [images, shapes] = [await toExcalidraw(m, b), await toExcalidraw(m, b, { icons: 'vector' })];
    const n = images.elements.filter((e) => e.type === 'image').length;
    expect(n).toBeGreaterThan(3);
    expect(shapes.elements.some((e) => e.type === 'image')).toBe(false);
    expect(shapes.files).toEqual({});
    const parts = shapes.elements.filter((e) => /-i\d+$/.test(e.id));
    expect(new Set(parts.map((e) => (e.customData as { lw: Origin }).lw.cell)).size).toBe(n);
    for (const e of parts) {
      expect(String(e.backgroundColor) + String(e.strokeColor), e.id).toMatch(/#[0-9a-f]{6}/i);
      const img = images.elements.find((x) => x.id === `lw-${(e.customData as { lw: Origin }).lw.cell}`)!;
      // Inside the icon's box, in the icon's group.
      const xs = (e.points as number[][]).map((p) => e.x + p[0]!);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(img.x - 1);
      expect(Math.max(...xs)).toBeLessThanOrEqual(img.x + img.width + 1);
      expect(e.groupIds).toEqual(expect.arrayContaining(img.groupIds));
    }
    // Importing the shapes version back changes nothing either.
    const file = path.join(tmp, 'vector.excalidraw');
    fs.writeFileSync(file, JSON.stringify(shapes));
    expect((await importExcalidraw(file, out, { browser: b })).changes).toEqual([]);
    // A ring: the hole takes the color under it, and is painted after the ring whatever the order.
    const ring = (r: number): Array<[number, number]> => Array.from({ length: 24 }, (_, i) => [10 + r * Math.cos((i * Math.PI) / 12), 10 + r * Math.sin((i * Math.PI) / 12)]);
    const o = (path_: number, pts: Array<[number, number]>, fill: string) => ({ path: path_, fill, stroke: null, strokeWidth: 1, opacity: 1, closed: true, points: pts });
    const polys = iconPolygons([o(0, [[0, 0], [20, 0], [20, 20], [0, 20]], '#ff0000'), o(1, ring(3), '#ffffff'), o(1, ring(8), '#ffffff')], '#000000');
    expect(polys.map((p) => p.fill)).toEqual(['#ff0000', '#ffffff', '#ff0000']);
    expect(simplify([[0, 0], [1, 0.001], [2, 0], [2, 2]], 0.05)).toEqual([[0, 0], [2, 0], [2, 2]]);
  }, 120000);

  it('rebuilds the diagram from the spec in the file when the .drawio.svg is gone', async () => {
    const src = path.join(tmp, 'gone-src.drawio.svg');
    await build(fs.readFileSync('examples/job-state.yaml', 'utf8'), { out: src, browser: b });
    const f = await toExcalidraw(readDrawio(fs.readFileSync(src, 'utf8')), b);
    retype(f.elements.find((e) => e.type === 'text' && e.text === 'Queued')!, 'Waiting');
    const file = path.join(tmp, 'gone.excalidraw');
    fs.writeFileSync(file, JSON.stringify(f));
    const out = path.join(tmp, 'gone-out.drawio.svg');
    const res = await importExcalidraw(file, out, { browser: b });
    expect(res.created).toBe(true);
    const d = parseSpecText(show(out).yaml).diagram;
    expect(d.nodes.find((n) => n.id === 'queued')!.label).toBe('Waiting');
    expect(d.nodes.length).toBe(parseSpecText(fs.readFileSync('examples/job-state.yaml', 'utf8')).diagram.nodes.length);
    // With every shape that carried the spec deleted, it says what it needs.
    for (const e of f.elements) delete (e.customData as { lw: Origin }).lw.doc;
    fs.writeFileSync(file, JSON.stringify(f));
    await expect(importExcalidraw(file, path.join(tmp, 'nowhere.drawio.svg'), { browser: b })).rejects.toThrow(/doesn't carry the diagram's spec/);
  }, 120000);

  it('refuses a file linework did not write', async () => {
    const out = path.join(tmp, 'foreign.drawio.svg');
    await build(fs.readFileSync('examples/checkout.yaml', 'utf8'), { out, browser: b });
    const m = readDrawio(fs.readFileSync(out, 'utf8'));
    const cells = await b.inspect(m.xml);
    const foreign = { type: 'excalidraw', version: 2, source: 'x', elements: [], appState: { viewBackgroundColor: '#fff', gridSize: null, theme: 'light' }, files: {} } as ExcalidrawFile;
    expect(() => readEdits(foreign, m, cells)).toThrow(/was not written by linework/);
    expect(() => readEdits({} as ExcalidrawFile, m, cells)).toThrow(/not an Excalidraw file/);
  }, 60000);

  // Saved by Excalidraw 0.18 itself after a person-like session in its editor
  // (drag, rename, delete, draw a box and an arrow), not written by hand.
  it('reads files the real Excalidraw editor saved', async () => {
    const out = path.join(tmp, 'real-checkout.drawio.svg');
    await build(fs.readFileSync('examples/checkout.yaml', 'utf8'), { out, browser: b });
    const res = await importExcalidraw('test/fixtures/excalidraw/checkout-edited.excalidraw', out, { browser: b });
    expect(res.changes).toEqual(expect.arrayContaining(['renamed "Shopper" to "Customer"', 'db: "Postgres" is now "Aurora"', 'added "Fraud check"', 'removed "SendGrid"', 'added an arrow from "Checkout API" to "Fraud check"']));
    const d = parseSpecText(show(out).yaml).diagram;
    expect(d.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['fraud_check', 'user', 'stripe']));
    expect(d.nodes.map((n) => n.id)).not.toContain('email');
    expect(res.check.findings.filter((x) => x.level === 'error')).toEqual([]);

    // A sequence diagram: a node pasted from the shapes library and dragged up beside the
    // participants, an arrow drawn to it, a message deleted, one dragged down, a color picked.
    const seq = path.join(tmp, 'real-seq.drawio.svg');
    await build(fs.readFileSync('examples/pay-sequence.yaml', 'utf8'), { out: seq, browser: b });
    const res3 = await importExcalidraw('test/fixtures/excalidraw/pay-sequence-edited.excalidraw', seq, { browser: b });
    expect(res3.changes).toEqual(['added participant "Mobile app"', 'removed the message "result page"', 'added a message from "Checkout API" to "Mobile app": push receipt', 'put the messages in a new order', '"Stripe" is now red']);
    const d3 = parseSpecText(show(seq).yaml).diagram;
    expect(d3.nodes.at(-1)).toMatchObject({ label: 'Mobile app', kind: 'client' });
    expect(d3.nodes.find((n) => n.id === 'stripe')!.color).toBe('red');
    expect(flat(d3.seq as Msg[]).slice(0, 2).map((i) => i.label)).toEqual(['POST /checkout', 'Click "Pay"']);
    expect(res3.check.findings).toEqual([]);
    expect((await importExcalidraw('test/fixtures/excalidraw/pay-sequence-edited.excalidraw', seq, { browser: b })).changes).toEqual([]);

    const flow = path.join(tmp, 'real-flow.drawio.svg');
    await build(fs.readFileSync('examples/refund-flow.yaml', 'utf8'), { out: flow, browser: b });
    const res2 = await importExcalidraw('test/fixtures/excalidraw/refund-flow-edited.excalidraw', flow, { browser: b });
    expect(res2.changes).toEqual(expect.arrayContaining(['added "Email customer"', 'added "Fraud flag?"']));
    const d2 = parseSpecText(show(flow).yaml).diagram;
    expect(d2.nodes.find((n) => n.id === 'fraud_flag')!.kind).toBe('decision');
    expect(d2.edges.find((e) => e.from === 'review' && e.to === 'approved')!.label).toBe('decided');
  }, 120000);
});

describe('share links', () => {
  it('frames buffers the way Excalidraw does and seals a scene only its key opens', async () => {
    const parts = [Buffer.from('one'), Buffer.from(''), Buffer.from('three, longer')];
    const joined = concatBuffers(...parts);
    expect([...joined.subarray(0, 8)]).toEqual([0, 0, 0, 1, 0, 0, 0, 3]);
    expect(splitBuffers(joined).map(String)).toEqual(['one', '', 'three, longer']);
    const text = JSON.stringify({ type: 'excalidraw', note: 'naïve ✓' });
    const a = await seal(text), z = await seal(text);
    expect(a.key).toMatch(/^[\w-]{22}$/);
    expect(a.key).not.toBe(z.key);
    expect(Buffer.from(a.payload).includes(Buffer.from('excalidraw"'))).toBe(false);
    expect(JSON.parse(splitBuffers(a.payload)[0]!.toString())).toEqual({ version: 2, compression: 'pako@1', encryption: 'AES-GCM' });
    expect(await unseal(a.payload, a.key)).toBe(text);
    await expect(unseal(a.payload, z.key)).rejects.toThrow();
  });

  it('leaves images out, posts once, and builds the link from the id and the key', async () => {
    const el = (id: string, type: string) => ({ id, type, x: 0, y: 0, width: 1, height: 1, groupIds: [], boundElements: [] }) as unknown as ExcalidrawElement;
    const scene = { type: 'excalidraw', version: 2, source: 'x', elements: [el('a', 'rectangle'), el('b', 'image')], appState: { viewBackgroundColor: '#fff', gridSize: null, theme: 'light' }, files: { f: { mimeType: 'image/svg+xml', id: 'f', dataURL: 'data:', created: 1, lastRetrieved: 1 } } } as ExcalidrawFile;
    expect(shareable(scene).images).toBe(1);
    expect(JSON.parse(shareable(scene).text)).toMatchObject({ elements: [{ id: 'a' }], files: {} });
    const calls: Array<{ url: string; body: Uint8Array }> = [];
    const post = (async (url: string, init: { body: Uint8Array }) => {
      calls.push({ url, body: init.body });
      return new Response(JSON.stringify({ id: 'abc123' }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await shareLink(scene, post);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://json.excalidraw.com/api/v2/post/');
    const m = /^https:\/\/excalidraw\.com\/#json=abc123,([\w-]{22})$/.exec(res.url)!;
    expect(m).toBeTruthy();
    expect(JSON.parse(await unseal(calls[0]!.body, m[1]!)).elements.length).toBe(1);
    const refuse = (async () => new Response(JSON.stringify({ error_class: 'RequestTooLargeError' }), { status: 413 })) as unknown as typeof fetch;
    await expect(shareLink(scene, refuse)).rejects.toThrow(/too large/);
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(shareLink(scene, down)).rejects.toThrow(/couldn't reach excalidraw\.com/);
  });
});

describe('watching a file', () => {
  it('runs once per save, however the editor writes it, and not for other files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-watch-'));
    const file = path.join(dir, 'a.excalidraw');
    fs.writeFileSync(file, 'one');
    let runs = 0;
    const w = watchFile(file, async () => void runs++, { settle: 40 });
    const settle = () => new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
    await settle();
    expect(runs).toBe(0);
    fs.writeFileSync(file, 'two!');
    await settle();
    expect(runs).toBe(1);
    // Saved by writing beside it and renaming over it.
    fs.writeFileSync(path.join(dir, 'a.excalidraw.tmp'), 'three!!');
    fs.renameSync(path.join(dir, 'a.excalidraw.tmp'), file);
    await settle();
    expect(runs).toBe(2);
    w.stop();
    await w.done;
    fs.writeFileSync(file, 'four!!!!');
    await settle();
    expect(runs).toBe(2);
  });
});
