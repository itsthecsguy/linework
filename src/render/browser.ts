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
// The text of an HTML label as a person reads it: tags gone, entities decoded.
function plain(html) {
  return html.replace(/<\\/?[a-zA-Z][^<>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\\s+/g, ' ').trim();
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
  // A set loads once. Asked again (the background process and the MCP server keep
  // one page for many commands), the answer is the one remembered, not "nothing new".
  stencilSets: {},
  stencilNames: function (set) {
    if (!this.stencilSets[set]) {
      var before = Object.keys(mxStencilRegistry.stencils);
      mxStencilRegistry.loadStencilSet(STENCIL_PATH + '/' + set, null, null, false);
      this.stencilSets[set] = Object.keys(mxStencilRegistry.stencils).filter(function (k) { return before.indexOf(k) < 0; });
    }
    return this.stencilSets[set];
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
          label: graph.getLabel(cell) ? plain(String(graph.getLabel(cell)).split(/<br\\s*\\/?>/i)[0]) : '',
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
  private constructor(private browser: Browser, private page: Page, private server: http.Server, /** Which browser is drawing, and its version: "Google Chrome 141.0.7390.37". */ readonly engine: string) {}

  static async launch(opts: { scale?: number } = {}): Promise<DrawioBrowser> {
    // Chromium starts while the asset server binds.
    const [{ browser, via }, server] = await Promise.all([launchChromium(), serveAssets()]);
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
      return new DrawioBrowser(browser, page, server, `${via} ${browser.version()}`);
    } catch (e) {
      await browser.close().catch(() => {});
      server.close();
      throw e;
    }
  }

  private fonts = new Set<string>();

  /**
   * Load a team's own font files into the page, so text is measured and drawn in
   * them. Sent as data URLs: the page may not fetch anything but linework's assets.
   */
  async useFonts(faces: Array<{ family: string; weight: number; file: string }>): Promise<void> {
    const fresh = faces.filter((f) => !this.fonts.has(`${f.family}|${f.weight}|${f.file}|${fs.statSync(f.file).mtimeMs}`));
    if (!fresh.length) return;
    const payload = fresh.map((f) => ({ family: f.family, weight: f.weight, data: fs.readFileSync(f.file).toString('base64') }));
    const ok = await this.page.evaluate(async (list) => {
      const out: boolean[] = [];
      for (const f of list) {
        const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
        try {
          const face = new FontFace(f.family, bytes.buffer, { weight: String(f.weight), style: 'normal' });
          document.fonts.add(await face.load());
          out.push(true);
        } catch {
          out.push(false);
        }
      }
      return out;
    }, payload);
    const bad = fresh.filter((_, i) => !ok[i]);
    if (bad.length) throw new Error(`linework: can't load ${bad.map((f) => f.file).join(', ')} as a font. Use a WOFF2, TTF or OTF file.`);
    for (const f of fresh) this.fonts.add(`${f.family}|${f.weight}|${f.file}|${fs.statSync(f.file).mtimeMs}`);
    // Text boxes measured before the font arrived are stale.
    this.seen.clear();
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

  /** Run `fn` once if the browser goes away on its own (it crashed, or something killed it). */
  onGone(fn: () => void): void {
    this.browser.once('disconnected', () => {
      if (!this.closing) fn();
    });
  }

  private closing = false;

  async close() {
    this.closing = true;
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

/** What a Chromium-family browser is called on PATH, most common first. */
const PATH_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'brave', 'brave-browser', 'microsoft-edge', 'microsoft-edge-stable', 'vivaldi', 'vivaldi-stable'];

/**
 * Chromium-family browsers installed where Playwright's own channels don't look:
 * anything on PATH (a distro's `chromium`, Brave, a snap), and the usual app
 * folders on macOS and Windows. Playwright only knows Chrome and Edge in their
 * vendor locations, so without this a Linux machine with `chromium` installed
 * is told it has no browser.
 */
export function systemBrowsers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isFile: (p: string) => boolean = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false,
): string[] {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const found: string[] = [];
  const add = (p: string) => {
    if (!found.includes(p) && isFile(p)) found.push(p);
  };
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const name of PATH_NAMES) for (const d of dirs) add(join(d, platform === 'win32' ? `${name}.exe` : name));
  if (platform === 'darwin') {
    const apps = ['Chromium.app/Contents/MacOS/Chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser', 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary', 'Vivaldi.app/Contents/MacOS/Vivaldi', 'Arc.app/Contents/MacOS/Arc'];
    for (const root of ['/Applications', ...(env.HOME ? [join(env.HOME, 'Applications')] : [])]) for (const a of apps) add(join(root, a));
  }
  if (platform === 'win32') {
    const apps = ['Chromium\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'Vivaldi\\Application\\vivaldi.exe'];
    for (const root of [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']]) if (root) for (const a of apps) add(join(root, a));
  }
  return found;
}

async function launchChromium(): Promise<{ browser: Browser; via: string }> {
  const errors: string[] = [];
  const attempts: Array<{ via: string; launch: () => Promise<Browser> }> = [];
  const custom = process.env.LINEWORK_CHROME;
  if (custom) attempts.push({ via: `LINEWORK_CHROME (${custom})`, launch: () => chromium.launch({ executablePath: custom }) });
  attempts.push({ via: "Playwright's Chromium", launch: () => chromium.launch() });
  attempts.push({ via: 'Google Chrome', launch: () => chromium.launch({ channel: 'chrome' }) });
  attempts.push({ via: 'Microsoft Edge', launch: () => chromium.launch({ channel: 'msedge' }) });
  for (const p of systemBrowsers()) attempts.push({ via: p, launch: () => chromium.launch({ executablePath: p }) });
  for (const a of attempts) {
    try {
      return { browser: await a.launch(), via: a.via };
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
      return { browser: await chromium.launch({ args: ['--single-process', '--no-zygote'] }), via: "Playwright's Chromium (single process)" };
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
          `Fix one of these ways:\n  ${installHint()}\n  install Google Chrome or Chromium\n  set LINEWORK_CHROME=/path/to/chrome\n` +
          `(tried: ${errors.join(' | ')})`,
  );
}
