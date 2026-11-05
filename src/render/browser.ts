// Headless draw.io. Loads the bundled draw.io runtime into Chromium and uses
// its own Graph code to measure, render and inspect diagrams, so what aiviz
// renders matches what the draw.io editor shows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { FONT_STACK } from '../drawio/theme.js';
import { FACES, embedFonts, fontFaceCss, fontsDir } from './fonts.js';

const ORIGIN = 'http://aiviz.local';

export function assetsDir() {
  // dist/render/browser.js or src/render/browser.ts -> <pkg>/assets/drawio
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, 'assets', 'drawio');
    if (fs.existsSync(path.join(candidate, 'js', 'app.min.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('aiviz: bundled draw.io runtime not found (assets/drawio). Reinstall aiviz.');
}

const host = () => `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="js/export-init.js"></script>
<link rel="stylesheet" href="mxgraph/css/common.css">
<script src="js/app.min.js"></script>
<script src="js/shapes-14-6-5.min.js"></script>
<script src="js/stencils.min.js"></script>
<script src="js/libavoid-js/libavoid.min.js"></script>
<script src="js/libavoid-js/libavoid-routing.js"></script>
<script src="js/diagramly/LibavoidRouting.js"></script>
<script src="js/rough/rough.min.js"></script>
<style>body{margin:0;background:#fff} #out{display:inline-block}
${fontFaceCss((f) => `/aiviz-fonts/${f}`)}</style>
</head><body><div id="out"></div><script>
window.FONT_STACK = ${JSON.stringify(FONT_STACK)};
function decodeInto(graph, xml) {
  var doc = mxUtils.parseXml(xml);
  var node = Editor.extractGraphModel(doc.documentElement, false);
  new mxCodec(node.ownerDocument).decode(node, graph.getModel());
  var bg = node.getAttribute('background');
  graph.background = bg && bg != 'none' ? bg : '#ffffff';
}
function withGraph(xml, fn) {
  var c = document.createElement('div');
  c.style.cssText = 'position:absolute;left:-99999px;top:0;width:4000px;height:4000px';
  document.body.appendChild(c);
  var graph = new Graph(c);
  graph.setEnabled(false);
  try { decodeInto(graph, xml); return fn(graph); } finally { graph.destroy(); c.remove(); }
}
var ctx = document.createElement('canvas').getContext('2d');
window.aiviz = {
  measure: function (reqs) {
    return reqs.map(function (r) {
      if (!r[0]) return 0;
      ctx.font = r[2] + ' ' + r[1] + 'px ' + (r[3] || window.FONT_STACK);
      return Math.ceil(ctx.measureText(r[0]).width);
    });
  },
  render: function (xml, embed) {
    return withGraph(xml, function (graph) {
      var svg = graph.getSvg(graph.background, 1, 16, false, null, true, null, null, null, false, false);
      if (embed) svg.setAttribute('content', xml);
      var out = document.getElementById('out');
      out.innerHTML = '';
      out.appendChild(svg.cloneNode(true));
      return Graph.xmlDeclaration + '\\n' + (embed ? Graph.svgFileComment + '\\n' : '') + Graph.svgDoctype + '\\n' + mxUtils.getXml(svg);
    });
  },
  // Route the given edges around vertices with draw.io's libavoid router (the same
  // code as Arrange > Layout > Orthogonal routing). Returns mxGraphModel XML.
  reroute: function (xml, edgeIds) {
    return withGraph(xml, function (graph) {
      var model = graph.getModel();
      var cells = edgeIds.map(function (id) { return model.getCell(id); }).filter(Boolean);
      if (cells.length && globalThis.Avoid) {
        model.beginUpdate();
        try { LibavoidRouting.routeCells(graph, globalThis.Avoid, cells, null, true); } finally { model.endUpdate(); }
      }
      return mxUtils.getXml(new mxCodec().encode(model));
    });
  },
  // Names of stencils in a bundled set, e.g. stencilNames('aws4.xml').
  stencilNames: function (set) {
    var before = Object.keys(mxStencilRegistry.stencils);
    mxStencilRegistry.loadStencilSet(STENCIL_PATH + '/' + set, null, null, false);
    return Object.keys(mxStencilRegistry.stencils).filter(function (k) { return before.indexOf(k) < 0; });
  },
  hasStencil: function (name) {
    return mxStencilRegistry.getStencil(name) != null;
  },
  inspect: function (xml) {
    return withGraph(xml, function (graph) {
      var model = graph.getModel(), out = [];
      for (var id in model.cells) {
        var cell = model.cells[id];
        if (!cell || (!cell.vertex && !cell.edge)) continue;
        var st = graph.view.getState(cell);
        if (!st) continue;
        var style = st.style || {};
        var tb = st.text && st.text.boundingBox;
        out.push({
          id: cell.id,
          vertex: !!cell.vertex,
          edge: !!cell.edge,
          parent: cell.parent ? cell.parent.id : null,
          container: style.container == '1' || (cell.value && cell.value.getAttribute && cell.value.getAttribute('aiviz_type') == 'group'),
          text: style.text != null || style.shape == 'text',
          shape: style.shape || null,
          aivizType: (cell.value && cell.value.getAttribute && cell.value.getAttribute('aiviz_type')) || null,
          source: cell.edge && cell.source ? cell.source.id : null,
          target: cell.edge && cell.target ? cell.target.id : null,
          box: { x: st.x, y: st.y, w: st.width, h: st.height },
          textBox: tb ? { x: tb.x, y: tb.y, w: tb.width, h: tb.height } : null,
          label: graph.getLabel(cell) ? String(graph.getLabel(cell)).split(/<br\\s*\\/?>/i)[0].replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim() : '',
          points: st.absolutePoints ? st.absolutePoints.filter(Boolean).map(function (p) { return { x: p.x, y: p.y }; }) : null,
        });
      }
      return out;
    });
  },
};
window.ready = true;
</script></body></html>`;

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png' };

export interface InspectCell {
  id: string;
  vertex: boolean;
  edge: boolean;
  parent: string | null;
  container: boolean;
  text: boolean;
  shape: string | null;
  aivizType: string | null;
  source: string | null;
  target: string | null;
  box: { x: number; y: number; w: number; h: number };
  textBox: { x: number; y: number; w: number; h: number } | null;
  label: string;
  points: Array<{ x: number; y: number }> | null;
}

export class DrawioBrowser {
  private constructor(private browser: Browser, private page: Page) {}

  static async launch(opts: { scale?: number } = {}): Promise<DrawioBrowser> {
    const browser = await launchChromium();
    const page = await browser.newPage({ deviceScaleFactor: opts.scale ?? 2 });
    const dir = assetsDir();
    const fonts = fontsDir();
    const html = host();
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/' || url.pathname === '/host.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      if (url.pathname.startsWith('/aiviz-fonts/')) {
        const f = FACES.find((x) => `/aiviz-fonts/${x.file}` === url.pathname);
        return f ? route.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(path.join(fonts, f.file)) }) : route.fulfill({ status: 404, body: '' });
      }
      const file = path.join(dir, path.normalize(url.pathname));
      if (!file.startsWith(dir) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: fs.readFileSync(file) });
    });
    // Nothing else may load: keeps rendering offline and deterministic.
    await page.route(/^(?!http:\/\/aiviz\.local\/).*/, (route) => route.abort());
    await page.goto(`${ORIGIN}/host.html`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, null, { timeout: 30000 });
    // Measuring before a font loads would size every box for the fallback font.
    const ok = await page.evaluate(
      (faces) => Promise.all(faces.map((f) => document.fonts.load(`${f.weight} 16px "${f.family}"`).then((r) => r.length > 0))),
      FACES.map(({ family, weight }) => ({ family, weight })),
    );
    if (ok.includes(false)) throw new Error('aiviz: bundled fonts failed to load (assets/fonts). Reinstall aiviz.');
    return new DrawioBrowser(browser, page);
  }

  measure(reqs: Array<[string, number, number, string?]>): Promise<number[]> {
    return this.page.evaluate((r) => (window as any).aiviz.measure(r), reqs);
  }

  /** Returns .drawio.svg text with the model embedded. */
  async renderSvg(xml: string): Promise<string> {
    return embedFonts(await this.page.evaluate((x) => (window as any).aiviz.render(x, true), xml));
  }

  /** Renders and screenshots the diagram. Writes `file` when given; always returns the PNG bytes. */
  async renderPng(xml: string, file?: string): Promise<Buffer> {
    await this.page.evaluate((x) => (window as any).aiviz.render(x, false), xml);
    return this.page.locator('#out svg').screenshot({ path: file, omitBackground: false });
  }

  /** Reroutes the given edge cells with libavoid. Returns mxGraphModel XML. */
  reroute(xml: string, edgeIds: string[]): Promise<string> {
    return this.page.evaluate(([x, ids]) => (window as any).aiviz.reroute(x, ids), [xml, edgeIds] as const);
  }

  stencilNames(set: string): Promise<string[]> {
    return this.page.evaluate((s) => (window as any).aiviz.stencilNames(s), set);
  }

  hasStencil(name: string): Promise<boolean> {
    return this.page.evaluate((n) => (window as any).aiviz.hasStencil(n), name);
  }

  inspect(xml: string): Promise<InspectCell[]> {
    return this.page.evaluate((x) => (window as any).aiviz.inspect(x), xml);
  }

  close() {
    return this.browser.close();
  }
}

async function launchChromium(): Promise<Browser> {
  const errors: string[] = [];
  const attempts: Array<() => Promise<Browser>> = [];
  if (process.env.AIVIZ_CHROME) attempts.push(() => chromium.launch({ executablePath: process.env.AIVIZ_CHROME }));
  attempts.push(() => chromium.launch());
  attempts.push(() => chromium.launch({ channel: 'chrome' }));
  attempts.push(() => chromium.launch({ channel: 'msedge' }));
  for (const a of attempts) {
    try {
      return await a();
    } catch (e) {
      errors.push((e as Error).message.split('\n')[0]!);
    }
  }
  throw new Error(
    'aiviz needs a Chromium-based browser to lay out and render diagrams, and none was found.\n' +
      'Fix one of these ways:\n  npx playwright install chromium\n  install Google Chrome\n  set AIVIZ_CHROME=/path/to/chrome\n' +
      `(tried: ${errors.join(' | ')})`,
  );
}
