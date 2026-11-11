// Headless draw.io. Loads the bundled draw.io runtime into Chromium and uses
// its own Graph code to measure, render and inspect diagrams, so what linework
// renders matches what the draw.io editor shows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright-core';
import { FONT_STACK } from '../drawio/theme.js';
import { FACES, embedFonts, fontFaceCss, fontsDir } from './fonts.js';

export function assetsDir() {
  // dist/render/browser.js or src/render/browser.ts -> <pkg>/assets/drawio
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, 'assets', 'drawio');
    if (fs.existsSync(path.join(candidate, 'js', 'app.min.js'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('linework: bundled draw.io runtime not found (assets/drawio). Reinstall linework.');
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
  // Each cell drawn alone, as SVG text: how an icon leaves draw.io for another tool.
  cellSvgs: function (xml, ids) {
    return withGraph(xml, function (graph) {
      return ids.map(function (id) {
        var cell = graph.getModel().getCell(id);
        if (!cell) return null;
        var c = document.createElement('div');
        c.style.cssText = 'position:absolute;left:-99999px;top:0;width:400px;height:400px';
        document.body.appendChild(c);
        var alone = new Graph(c);
        alone.setEnabled(false);
        try {
          var copy = cell.clone();
          copy.geometry = cell.geometry.clone();
          copy.geometry.x = 0;
          copy.geometry.y = 0;
          alone.addCell(copy, alone.getDefaultParent());
          return mxUtils.getXml(alone.getSvg(null, 1, 0, false, null, true, null, null, null, false, false));
        } finally { alone.destroy(); c.remove(); }
      });
    });
  },
  // The outlines an icon's SVG is made of, as points: one list per closed contour,
  // sampled every \`step\` pixels. For tools that draw polygons but not SVG paths.
  iconOutlines: function (svgs, step) {
    var NS = 'http://www.w3.org/2000/svg';
    return svgs.map(function (text) {
      if (!text) return null;
      var holder = document.createElement('div');
      holder.style.cssText = 'position:absolute;left:-99999px;top:0';
      holder.innerHTML = text;
      document.body.appendChild(holder);
      var out = [];
      try {
        var svg = holder.querySelector('svg');
        if (!svg || svg.querySelector('image')) return null;
        var base = svg.getScreenCTM();
        var els = svg.querySelectorAll('path,rect,ellipse,circle,polygon');
        for (var k = 0; k < els.length; k++) {
          var el = els[k];
          var fill = el.getAttribute('fill'), stroke = el.getAttribute('stroke');
          var hasFill = !!fill && fill != 'none', hasStroke = !!stroke && stroke != 'none';
          if (!hasFill && !hasStroke) continue;
          var m = base.inverse().multiply(el.getScreenCTM());
          var subs = el.tagName == 'path' ? ((el.getAttribute('d') || '').match(/M[^M]*/g) || []) : [null];
          for (var j = 0; j < subs.length; j++) {
            var p = el;
            if (subs[j] != null) {
              p = document.createElementNS(NS, 'path');
              p.setAttribute('d', subs[j]);
              el.parentNode.appendChild(p);
            }
            var len = p.getTotalLength();
            if (len > 0) {
              var n = Math.max(8, Math.ceil(len / step)), pts = [];
              for (var i = 0; i < n; i++) {
                var q = p.getPointAtLength((len * i) / n);
                pts.push([q.x * m.a + q.y * m.c + m.e, q.x * m.b + q.y * m.d + m.f]);
              }
              var alpha = function (name) { var v = parseFloat(el.getAttribute(name)); return isNaN(v) ? 1 : v; };
              out.push({ path: k, opacity: alpha('opacity') * alpha(hasFill ? 'fill-opacity' : 'stroke-opacity'), fill: hasFill ? fill : null, stroke: hasStroke ? stroke : null, strokeWidth: +(el.getAttribute('stroke-width') || 1), closed: subs[j] == null || /z\\s*$/i.test(subs[j]), points: pts });
            }
            if (p !== el) p.remove();
          }
        }
      } finally { holder.remove(); }
      return out;
    });
  },
  hasStencil: function (name) {
    return mxStencilRegistry.getStencil(name) != null;
  },
  // Where an edge's label lands at each of several positions along the edge
  // (draw.io's -1..1 x). Moving a label changes nothing else in the diagram, so
  // one decode serves every candidate instead of one full inspect per try.
  labelBoxes: function (xml, id, xs) {
    return withGraph(xml, function (graph) {
      var model = graph.getModel(), cell = model.getCell(id);
      if (!cell) return xs.map(function () { return null; });
      return xs.map(function (x) {
        var g = cell.geometry.clone();
        g.x = x;
        model.setGeometry(cell, g);
        var st = graph.view.getState(cell);
        var tb = st && st.text && st.text.boundingBox;
        return tb ? { x: tb.x, y: tb.y, w: tb.width, h: tb.height } : null;
      });
    });
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

/** One contour of an icon: a filled outline or a stroked line, in the icon's own pixels. */
export interface IconOutline {
  /** Which SVG element it came from. Contours of one element cut holes in each other. */
  path: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  /** 0 to 1. */
  opacity: number;
  closed: boolean;
  points: Array<[number, number]>;
}

export class DrawioBrowser {
  private constructor(private browser: Browser, private page: Page, private server: http.Server) {}

  static async launch(opts: { scale?: number } = {}): Promise<DrawioBrowser> {
    // Chromium starts while the asset server binds.
    const [browser, server] = await Promise.all([launchChromium(), serveAssets()]);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const page = await browser.newPage({ deviceScaleFactor: opts.scale ?? 2 });
      // Nothing else may load: keeps rendering offline and deterministic.
      const own = new RegExp(`^${origin.replace(/[.]/g, '\\.')}/`);
      await page.route((url) => !own.test(url.href), (route) => route.abort());
      await page.goto(`${origin}/host.html`);
      await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, null, { timeout: 30000 });
      // Measuring before a font loads would size every box for the fallback font.
      const ok = await page.evaluate(
        (faces) => Promise.all(faces.map((f) => document.fonts.load(`${f.weight} 16px "${f.family}"`).then((r) => r.length > 0))),
        FACES.map(({ family, weight }) => ({ family, weight })),
      );
      if (ok.includes(false)) throw new Error('linework: bundled fonts failed to load (assets/fonts). Reinstall linework.');
      return new DrawioBrowser(browser, page, server);
    } catch (e) {
      await browser.close().catch(() => {});
      server.close();
      throw e;
    }
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

  /** Each of the cells drawn alone, as SVG text; null for a cell the file doesn't have. */
  cellSvgs(xml: string, ids: string[]): Promise<Array<string | null>> {
    return this.page.evaluate(([x, i]) => (window as any).aiviz.cellSvgs(x, i), [xml, ids] as const);
  }

  /** Each icon SVG as the contours it is made of; null for one that isn't plain shapes. */
  iconOutlines(svgs: Array<string | null>, step = 0.2): Promise<Array<IconOutline[] | null>> {
    return this.page.evaluate(([s, st]) => (window as any).aiviz.iconOutlines(s, st), [svgs, step] as const);
  }

  hasStencil(name: string): Promise<boolean> {
    return this.page.evaluate((n) => (window as any).aiviz.hasStencil(n), name);
  }

  // inspect is a pure function of the XML, and a build asks about the same XML
  // more than once (lint, label fixing, the final check).
  private seen = new Map<string, Promise<InspectCell[]>>();

  inspect(xml: string): Promise<InspectCell[]> {
    let hit = this.seen.get(xml);
    if (!hit) {
      hit = this.page.evaluate((x) => (window as any).aiviz.inspect(x), xml);
      hit.catch(() => this.seen.delete(xml));
      if (this.seen.size >= 8) this.seen.delete(this.seen.keys().next().value!);
      this.seen.set(xml, hit);
    }
    // Callers may change the cells; each gets its own copy.
    return hit.then((cells) => structuredClone(cells));
  }

  /** Label boxes for edge `id` with its label at each draw.io position in `xs`. */
  labelBoxes(xml: string, id: string, xs: number[]): Promise<Array<InspectCell['textBox']>> {
    return this.page.evaluate(([x, i, p]) => (window as any).aiviz.labelBoxes(x, i, p), [xml, id, xs] as const);
  }

  async close() {
    await this.browser.close();
    this.server.closeAllConnections();
    this.server.close();
  }
}

/**
 * The draw.io runtime is 16MB of script. Served from a local port, Chromium reads
 * it straight off the socket; through Playwright's request interception every
 * byte would cross the DevTools protocol first.
 */
function serveAssets(): Promise<http.Server> {
  const dir = assetsDir();
  const fonts = fontsDir();
  const html = host();
  const send = (res: http.ServerResponse, status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname === '/' || pathname === '/host.html') return send(res, 200, 'text/html', html);
    if (pathname.startsWith('/aiviz-fonts/')) {
      const f = FACES.find((x) => `/aiviz-fonts/${x.file}` === pathname);
      return f ? send(res, 200, 'font/woff2', fs.readFileSync(path.join(fonts, f.file))) : send(res, 404, 'text/plain', '');
    }
    const file = path.join(dir, path.normalize(decodeURIComponent(pathname)));
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'text/plain', '');
    send(res, 200, TYPES[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file));
  });
  // A server that's only waiting on a browser that already exited shouldn't keep node alive.
  server.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Playwright-core's own installer, so the Chromium build always matches the version we run. */
export function browserInstallCommand(): string[] {
  const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json');
  return [process.execPath, path.join(path.dirname(pkg), 'cli.js'), 'install', 'chromium', '--only-shell'];
}

function installHint(): string {
  return 'linework install-browser';
}

async function launchChromium(): Promise<Browser> {
  const errors: string[] = [];
  const attempts: Array<() => Promise<Browser>> = [];
  if (process.env.LINEWORK_CHROME) attempts.push(() => chromium.launch({ executablePath: process.env.LINEWORK_CHROME }));
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
  // A browser that exists but dies on launch is almost always a sandbox (Codex,
  // seatbelt, containers without --no-sandbox) blocking it, not a missing install.
  const crashed = errors.some((m) => !/doesn't exist|is not found|not installed|ENOENT/i.test(m));
  if (crashed) {
    // Playwright's headless shell still starts under macOS seatbelt (Codex's sandbox)
    // when it runs as one process. Only as a fallback: single-process mode is less robust.
    try {
      return await chromium.launch({ args: ['--single-process', '--no-zygote'] });
    } catch (e) {
      errors.push((e as Error).message.split('\n')[0]!);
    }
  }
  throw new Error(
    crashed
      ? 'linework found a Chromium-based browser but it could not start. If this runs inside a sandbox (an AI agent\'s sandbox, a container), the sandbox is probably blocking it.\n' +
          `Fix: run this command outside the sandbox, or allow it to launch a browser. Linework can start inside some sandboxes (Codex's included) if Playwright's own Chromium is installed: run \`${installHint()}\` once, outside the sandbox.\n` +
          `(tried: ${errors.join(' | ')})`
      : 'linework needs a Chromium-based browser to lay out and render diagrams, and none was found.\n' +
          `Fix one of these ways:\n  ${installHint()}\n  install Google Chrome\n  set LINEWORK_CHROME=/path/to/chrome\n` +
          `(tried: ${errors.join(' | ')})`,
  );
}
