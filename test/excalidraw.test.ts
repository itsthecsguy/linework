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
import { centreRouteOn, toExcalidraw, wrapLines, type ExcalidrawElement, type ExcalidrawFile, type Origin } from '../src/excalidraw/export.js';
import { embeddedSpec, readEdits, setBoxes, setLabels } from '../src/excalidraw/import.js';
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
    await expect(render(svg, path.join(tmp, 'out.pdf'), b)).rejects.toThrow(/\.png, \.svg or \.excalidraw/);
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

  it('reads text edits to a sequence diagram, and says what it will not read', async () => {
    const r = await roundTrip('pay-sequence', (f) => {
      const byText = (t: string) => f.elements.find((e) => e.type === 'text' && e.text === t)!;
      retype(byText('POST /checkout'), 'POST /v2/checkout');
      retype(byText('Shopper'), 'Buyer');
      retype(byText('idempotent on event id'), 'safe to retry');
      drawBox(f, 'extra', 'rectangle', [0, 900, 100, 50], 'Auditor');
    });
    const yaml = show(r.out).yaml;
    expect(yaml).toContain('POST /v2/checkout');
    expect(yaml).toContain('label: Buyer');
    expect(yaml).toContain('safe to retry');
    expect(r.spec.nodes.length).toBe(5);
    expect(r.res.notes.join(' ')).toMatch(/not read back into a sequence diagram/);
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

    const flow = path.join(tmp, 'real-flow.drawio.svg');
    await build(fs.readFileSync('examples/refund-flow.yaml', 'utf8'), { out: flow, browser: b });
    const res2 = await importExcalidraw('test/fixtures/excalidraw/refund-flow-edited.excalidraw', flow, { browser: b });
    expect(res2.changes).toEqual(expect.arrayContaining(['added "Email customer"', 'added "Fraud flag?"']));
    const d2 = parseSpecText(show(flow).yaml).diagram;
    expect(d2.nodes.find((n) => n.id === 'fraud_flag')!.kind).toBe('decision');
    expect(d2.edges.find((e) => e.from === 'review' && e.to === 'approved')!.label).toBe('decided');
  }, 120000);
});
