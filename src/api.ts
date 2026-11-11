// Programmatic API behind the CLI (and later the MCP server).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpecText, type Issue } from './spec/parse.js';
import { layout, type Layout } from './layout/layout.js';
import type { Diagram } from './spec/model.js';
import { edgeCellId, patchEdges, serialize, stampEdgeRoutes, toMxfile } from './drawio/write.js';
import { absBox, fingerprint, readDrawio, specBase, type DrawioModel } from './drawio/read.js';
import { manualEdits, toDiagram, toYaml, type ManualEdit } from './drawio/show.js';
import { merge, type MergeStats } from './drawio/merge.js';
import { sequenceScene } from './layout/sequence.js';
import { PROVIDERS, resolveIcon, stencilSets, type Provider } from './drawio/icons.js';
import { toExcalidraw, type ExcalidrawFile } from './excalidraw/export.js';
import { cellsNamed, embeddedDoc, embeddedSpec, readEdits, setBoxes, setRoutes, type Box } from './excalidraw/import.js';
import { readScene, sceneKind, writeScene } from './excalidraw/file.js';
import { DrawioBrowser, type InspectCell } from './render/browser.js';
import { brokenEdges, check, type CheckResult } from './lint/check.js';
import { fixLabels } from './lint/fixlabels.js';

export interface BuildOptions {
  out: string;
  png?: string;
  /** Overwrite an existing file linework can't read. */
  force?: boolean;
  /** Throw away the existing layout, including hand edits, and lay out from scratch. */
  relayout?: boolean;
  /** Always merge into the existing file, and never fall back to a fresh layout. */
  keepLayout?: boolean;
  /** Merge into this draw.io file text, not whatever is at `out`. */
  base?: string;
  browser?: DrawioBrowser;
}

export interface BuildResult {
  out: string;
  warnings: Issue[];
  check: CheckResult;
  direction: string;
  mode: 'fresh' | 'merge';
  merge?: MergeStats;
  /** Edge labels moved off boxes, lines and each other. */
  labelsMoved: number;
  /** --relayout threw away a layout someone had arranged by hand. */
  discardedLayout?: boolean;
}

async function withBrowser<T>(given: DrawioBrowser | undefined, fn: (b: DrawioBrowser) => Promise<T>): Promise<T> {
  const b = given ?? (await DrawioBrowser.launch());
  try {
    return await fn(b);
  } finally {
    if (!given) await b.close();
  }
}

/**
 * A short stamp of what a spec says, whatever its comments and formatting. A
 * build records it in the diagram (aiviz_spec), which is how `sync` knows
 * whether a diagram was built from the YAML beside it or from an older one.
 */
export function specStamp(specText: string): string {
  return createHash('sha1').update(toYaml(parseSpecText(specText).diagram)).digest('hex').slice(0, 12);
}

export async function build(specText: string, opts: BuildOptions): Promise<BuildResult> {
  const { diagram, warnings } = parseSpecText(specText);
  const stamp = createHash('sha1').update(toYaml(diagram)).digest('hex').slice(0, 12);
  const kind = outputKind(opts.out);
  let old: DrawioModel | undefined;
  if (opts.base != null) old = readDrawio(opts.base);
  else if (fs.existsSync(opts.out)) {
    try {
      old = readDrawio(fs.readFileSync(opts.out, 'utf8'));
    } catch {
      if (!opts.force) throw new Error(`${opts.out} exists and isn't a draw.io file linework can read. Use --force to overwrite it.`);
    }
  }
  const edits = old ? manualEdits(old) : [];
  // Once a person has touched the layout, every later build merges into it. A
  // layout nobody touched is also kept when the spec changed a little: a renamed
  // label or one new box shouldn't move the rest.
  const touched = !!old && (old.meta.aiviz_layout === 'manual' || edits.length > 0);
  let mode: 'fresh' | 'merge' = 'fresh';
  if (old && !opts.relayout) mode = touched || opts.keepLayout || smallChange(old, diagram) ? 'merge' : 'fresh';
  return withBrowser(opts.browser, async (b) => {
    const measure = (r: Array<[string, number, number, string?]>) => b.measure(r);
    for (const n of diagram.nodes) {
      if (!n.icon) continue;
      const r = resolveIcon(n.icon);
      if ('error' in r || !(await b.hasStencil(r.stencil))) {
        warnings.push({ path: `nodes.${n.id}.icon`, message: `no icon named "${n.icon}"; run "linework icons ${n.icon.split('.')[0]} ${n.icon.split('.')[1] ?? ''}" to search. Drawing it without one.` });
        delete n.icon;
      }
    }
    if (diagram.type === 'sequence') {
      let keepX: Map<string, { x: number; w: number }> | undefined;
      let keep: Map<string, { style?: string; label?: string; attrs?: Record<string, string> }> | undefined;
      if (mode === 'merge') {
        const shown = toDiagram(old!);
        keepX = new Map();
        keep = new Map();
        for (const [cellId, specId] of shown.idMap) {
          const c = old!.byId.get(cellId)!;
          const box = absBox(old!, cellId);
          if (box) keepX.set(specId, { x: box.x, w: box.w });
          // A participant somebody drew in another tool is only a place so far: it gets its look here.
          if (c.attrs.aiviz_new) continue;
          const prev = shown.diagram.nodes.find((n) => n.id === specId);
          const now = diagram.nodes.find((n) => n.id === specId);
          if (!prev || !now || shown.diagram.theme !== diagram.theme || (shown.diagram.accent ?? '') !== (diagram.accent ?? '')) continue;
          const { id: _i, value: _v, aiviz_auto: _a, ...attrs } = c.attrs;
          const sameLook = (prev.color ?? '') === (now.color ?? '') && !!prev.highlight === !!now.highlight;
          const { aiviz_color: _c, aiviz_highlight: _h, ...rest } = attrs;
          keep.set(specId, {
            attrs: rest,
            style: prev.kind === now.kind && sameLook ? c.styleRaw : undefined,
            label: prev.label === now.label && prev.tech === now.tech && sameLook ? (c.attrs.label ?? c.label) : undefined,
          });
        }
      }
      const scene = await sequenceScene(diagram, measure, { keepX, keep, extraMeta: mode === 'merge' ? { aiviz_layout: 'manual' } : {} });
      const xml = stampEdgeRoutes(serialize(scene));
      return finish(b, xml, { mode, warnings, direction: 'TB', edits, old });
    }
    if (diagram.type === 'timeline') {
      const { timelineScene } = await import('./layout/timeline.js');
      return finish(b, serialize(await timelineScene(diagram, measure)), { mode: 'fresh', warnings, direction: 'LR', edits, old });
    }
    const l = await layout(diagram, measure);
    let xml: string;
    let stats: MergeStats | undefined;
    let freshXml: string | undefined;
    if (mode === 'merge') {
      const m = merge(diagram, old!, l, { specIsCurrent: specBase(specText) === fingerprint(old!), touched });
      stats = m.stats;
      xml = serialize(m.scene);
      if (m.reroute.length) xml = await rerouteInto(b, xml, m.reroute);
      // Kept routes can already be broken, e.g. stale waypoints after someone moved a node.
      const after = check(await b.inspect(xml));
      const broken = brokenEdges(after);
      if (broken.length) {
        xml = await rerouteInto(b, xml, broken);
        stats.rerouted += broken.filter((id) => !m.reroute.includes(id)).length;
      }
      // Nobody arranged this layout, so there is nothing to protect: when the
      // change doesn't fit into it cleanly, lay it out again.
      if (!touched && !opts.keepLayout) {
        const merged = check(await b.inspect(xml));
        const bad = (c: CheckResult) => c.findings.filter((f) => f.level === 'error').length;
        let redo = bad(merged) > 0;
        if (!redo && (stats.placed.length || merged.stats.crossings)) {
          freshXml = await straightenDetours(b, toMxfile(diagram, l), detourEdges(diagram, l));
          redo = merged.stats.crossings > check(await b.inspect(freshXml)).stats.crossings + 1;
        }
        if (redo) {
          mode = 'fresh';
          stats = undefined;
        }
      }
    }
    if (mode === 'fresh') xml = freshXml ?? (await straightenDetours(b, toMxfile(diagram, l), detourEdges(diagram, l)));
    else xml = xml!;
    const fixed = await fixLabels(b, xml);
    xml = fixed.xml;
    xml = stampEdgeRoutes(xml);
    // Stamping routes changes attributes, not geometry: the cells fixLabels read still hold.
    return finish(b, xml, { mode, warnings, direction: mode === 'merge' ? (old!.meta.aiviz_direction ?? l.direction) : l.direction, edits, old, stats, cells: fixed.cells, labelsMoved: fixed.moved });
  });

  async function finish(
    b: DrawioBrowser,
    xml: string,
    r: { mode: 'fresh' | 'merge'; warnings: Issue[]; direction: string; edits: ManualEdit[]; old?: DrawioModel; stats?: MergeStats; cells?: InspectCell[]; labelsMoved?: number },
  ): Promise<BuildResult> {
    xml = stamped(xml, stamp);
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    // Issued together: the browser renders the preview and lays out the lint pass
    // while node subsets the fonts for the SVG.
    const [file, , cells] = await Promise.all([kind === 'svg' ? b.renderSvg(xml) : xml, opts.png ? b.renderPng(xml, opts.png) : undefined, r.cells ?? b.inspect(xml)]);
    fs.writeFileSync(opts.out, file);
    return {
      out: opts.out,
      warnings: r.warnings,
      check: check(cells),
      direction: r.direction,
      mode: r.mode,
      merge: r.stats,
      labelsMoved: r.labelsMoved ?? 0,
      discardedLayout: !!(opts.relayout && r.old && (r.old.meta.aiviz_layout === 'manual' || r.edits.length > 0)),
    };
  }
}

/**
 * Whether the new spec is close enough to an untouched file to keep its layout:
 * same type, direction and theme, and only a few new boxes. Sequence diagrams
 * always lay out again; their rows follow message order either way.
 */
function smallChange(old: DrawioModel, d: Diagram): boolean {
  if (d.type === 'sequence' || d.type === 'timeline') return false;
  let prev: Diagram;
  try {
    prev = toDiagram(old).diagram;
  } catch {
    return false;
  }
  if (prev.type !== d.type || prev.direction !== d.direction || prev.theme !== d.theme) return false;
  const had = new Set(prev.nodes.map((n) => n.id));
  const added = d.nodes.filter((n) => !had.has(n.id)).length;
  const kept = d.nodes.length - added;
  return kept > 0 && added <= Math.max(2, Math.ceil(d.nodes.length / 4));
}

/**
 * Edges whose route is far longer than the gap between their ends. Layered layout
 * draws one edge of every cycle backwards, so the reply in a call-and-callback pair
 * (api -> stripe, stripe -> api) can loop around a whole group.
 */
export function detourEdges(d: Diagram, l: Layout): string[] {
  const out: string[] = [];
  for (const e of d.edges) {
    const r = l.edges.get(e.id), a = l.nodes.get(e.from), z = l.nodes.get(e.to);
    if (!r || !a || !z || r.points.length < 2) continue;
    let len = 0;
    for (let i = 0; i < r.points.length - 1; i++) len += Math.abs(r.points[i + 1]!.x - r.points[i]!.x) + Math.abs(r.points[i + 1]!.y - r.points[i]!.y);
    const gap =
      Math.max(0, Math.abs(a.x + a.w / 2 - (z.x + z.w / 2)) - (a.w + z.w) / 2) +
      Math.max(0, Math.abs(a.y + a.h / 2 - (z.y + z.h / 2)) - (a.h + z.h) / 2);
    if (len > 2 * gap + 240) out.push(edgeCellId(e.id));
  }
  return out;
}

/**
 * Reroute detours with libavoid. Keep the new routes when they're much shorter and
 * cost at most a couple of crossings each: a short hop with a crossing reads better
 * than a line wrapped around half the diagram.
 */
async function straightenDetours(b: DrawioBrowser, xml: string, ids: string[]): Promise<string> {
  if (!ids.length) return xml;
  const candidate = await rerouteInto(b, xml, ids);
  const [before, after] = [await b.inspect(xml), await b.inspect(candidate)];
  const length = (cells: typeof before) =>
    cells.filter((c) => ids.includes(c.id)).reduce((sum, c) => sum + (c.points ?? []).reduce((s, p, i, a) => (i ? s + Math.abs(p.x - a[i - 1]!.x) + Math.abs(p.y - a[i - 1]!.y) : 0), 0), 0);
  const [c0, c1] = [check(before), check(after)];
  const errors = (c: CheckResult) => c.findings.filter((f) => f.level === 'error').length;
  const keep = errors(c1) <= errors(c0) && c1.stats.crossings <= c0.stats.crossings + 2 * ids.length && length(after) < 0.6 * length(before);
  return keep ? candidate : xml;
}

async function rerouteInto(b: DrawioBrowser, xml: string, edgeIds: string[]): Promise<string> {
  return patchEdges(xml, await b.reroute(xml, edgeIds), edgeIds);
}

/**
 * Repair a diagram after hand edits: reroute edges that are broken or were left
 * behind when someone moved a box, and move labels off whatever they landed on.
 * Boxes, groups and routes a person drew stay where they are.
 */
export async function tidy(file: string, browser?: DrawioBrowser): Promise<{ fixed: number; labels: number; check: CheckResult }> {
  const text = fs.readFileSync(file, 'utf8');
  const m = readDrawio(text);
  if (m.meta.aiviz_type && m.meta.aiviz_type !== 'sequence') {
    // The file's own spec merged into itself: positions stay, hand moves become
    // part of the layout, and only stale routes and colliding labels change.
    const res = await build(show(file).yaml, { out: file, keepLayout: true, browser });
    return { fixed: res.merge?.rerouted ?? 0, labels: res.labelsMoved, check: res.check };
  }
  return withBrowser(browser, async (b) => {
    const broken = brokenEdges(check(await b.inspect(m.xml)));
    if (!broken.length) return { fixed: 0, labels: 0, check: check(await b.inspect(m.xml)) };
    const xml = stampEdgeRoutes(await rerouteInto(b, m.xml, broken));
    fs.writeFileSync(file, file.endsWith('.svg') ? await b.renderSvg(xml) : xml);
    return { fixed: broken.length, labels: 0, check: check(await b.inspect(xml)) };
  });
}

export function show(file: string, opts: { geometry?: boolean } = {}): { yaml: string; notes: string[]; edits: ManualEdit[] } {
  const m = readDrawio(fs.readFileSync(file, 'utf8'));
  const { diagram, notes, idMap } = toDiagram(m);
  let yaml = toYaml(diagram, `linework-base: ${fingerprint(m)}  (keep this line; it tells build this spec includes the latest hand edits)`);
  if (opts.geometry) {
    // Positions as comments: invisible to build, but they make `git diff` show moves.
    const lines = ['# geometry (x,y width x height)'];
    for (const [cellId, specId] of idMap) {
      const b = absBox(m, cellId);
      if (b) lines.push(`#   ${specId}: ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`);
    }
    yaml += lines.join('\n') + '\n';
  }
  return { yaml, notes, edits: manualEdits(m) };
}

export async function render(file: string, out: string, browser?: DrawioBrowser): Promise<void> {
  const m = readDrawio(fs.readFileSync(file, 'utf8'));
  await withBrowser(browser, async (b) => {
    const scene = sceneKind(out);
    if (scene) fs.writeFileSync(out, await writeScene(scene, await toExcalidraw(m, b), m, b));
    else if (out.endsWith('.png')) await b.renderPng(m.xml, out);
    else if (out.endsWith('.svg')) fs.writeFileSync(out, await b.renderSvg(m.xml));
    else throw new Error('render output must end in .png, .svg, .excalidraw, .excalidraw.svg or .excalidraw.png');
  });
}

/** Store a diagram at excalidraw.com and return the link that opens it there. Sends the drawing, encrypted, to excalidraw.com. */
export async function share(file: string, browser?: DrawioBrowser): Promise<{ url: string; images: number }> {
  const { shareLink } = await import('./excalidraw/share.js');
  if (sceneKind(file) || /\.excalidraw\./i.test(file)) return shareLink(readScene(file));
  const m = readDrawio(fs.readFileSync(file, 'utf8'));
  // A link carries no images, so icons go as shapes.
  return withBrowser(browser, async (b) => shareLink(await toExcalidraw(m, b, { icons: 'vector' })));
}

/** Write an Excalidraw library: every node kind ('shapes'), or a cloud provider's icons as ready nodes. */
export async function library(set: string, out: string, opts: { theme?: string; filter?: string | string[]; browser?: DrawioBrowser } = {}): Promise<{ out: string; items: number }> {
  if (!out.endsWith('.excalidrawlib')) throw new Error(`a library file must end in .excalidrawlib, got ${out}`);
  const { buildLibrary } = await import('./excalidraw/library.js');
  return withBrowser(opts.browser, async (b) => {
    // Several filters pick several services: "lambda s3 sqs".
    const filters = [opts.filter ?? []].flat().map((f) => f.toLowerCase());
    const all = set in PROVIDERS ? await listIcons(set as Provider, undefined, b) : undefined;
    const names = all?.filter((n) => !filters.length || filters.some((f) => n.includes(f)));
    const lib = await buildLibrary(set, b, { theme: opts.theme as Diagram['theme'] | undefined, filters, names });
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(lib) + '\n');
    return { out, items: lib.libraryItems.length };
  });
}

export interface ImportResult {
  out: string;
  /** What the Excalidraw file changed, one line each. Empty when it matches the diagram. */
  changes: string[];
  /** Things in the file that were not brought across. */
  notes: string[];
  check: CheckResult;
  /** The diagram did not exist yet and was built from the spec the Excalidraw file carries. */
  created: boolean;
}

/**
 * Bring edits made in Excalidraw back into a diagram. `file` is an .excalidraw
 * that `render` wrote; `out` is the .drawio.svg it came from (or, when that is
 * gone, where to rebuild it from the spec the file carries).
 *
 * The spec changes first (text, boxes and arrows added or removed), built as any
 * edited spec is. Then every box is put where it sits in Excalidraw, and the
 * arrows on the ones that moved are routed again.
 */
export async function importExcalidraw(file: string, out: string, opts: { browser?: DrawioBrowser; png?: string } = {}): Promise<ImportResult> {
  const data: ExcalidrawFile = readScene(file);
  outputKind(out);
  return withBrowser(opts.browser, async (b) => {
    let created = false;
    if (!fs.existsSync(out)) {
      const spec = embeddedSpec(data);
      if (!spec) throw new Error(`${out} doesn't exist, and ${file} doesn't carry the diagram's spec to rebuild it from. Point -o at the .drawio.svg this was exported from.`);
      await build(spec, { out, browser: b });
      created = true;
    }
    const current = readDrawio(fs.readFileSync(out, 'utf8'));
    let base = current;
    // A sequence diagram's cells are numbered by row, so once the diagram has
    // changed (an earlier import of this same file, say) the file's elements no
    // longer name the right ones. The file carries the spec it was drawn from:
    // read its edits against that, and let the file have the last word.
    const doc = embeddedDoc(data);
    if (current.meta.aiviz_type === 'sequence' && doc && doc.base !== fingerprint(current)) {
      const tmp = path.join(os.tmpdir(), `linework-import-${process.pid}-${Date.now()}.drawio`);
      try {
        await build(doc.spec, { out: tmp, browser: b });
        const then = readDrawio(fs.readFileSync(tmp, 'utf8'));
        if ([...cellsNamed(data)].every((id) => then.byId.has(id))) base = then;
      } catch {
        // The carried spec doesn't build any more: fall back to matching against the diagram as it is.
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    // The file as export would write it now: what a colour, a line style or a path is compared with.
    const edits = readEdits(data, base, await b.inspect(base.xml), await toExcalidraw(base, b));
    const specOf = (m: DrawioModel, d = toDiagram(m).diagram) => toYaml(d, `linework-base: ${fingerprint(m)}`);
    // Nothing to bring across: leave the diagram exactly as it is.
    const same = base !== current && toYaml(edits.diagram) === toYaml(toDiagram(current).diagram);
    if (!edits.changes.length || same) return { out, changes: [], notes: edits.notes, check: check(await b.inspect(current.xml)), created };
    const edited = readDrawio(edits.xml);
    let res = await build(specOf(edited, edits.diagram), { out, base: edits.xml, keepLayout: true, browser: b, png: opts.png });

    if (edits.boxes.size || edits.routes.size) {
      // Excalidraw has the last word on where things are. That covers boxes the
      // person moved, boxes they drew, any the build above shifted to make room,
      // and the arrows whose path they drew themselves.
      const built = readDrawio(fs.readFileSync(out, 'utf8'));
      const cells = await b.inspect(built.xml);
      const now = new Map(cells.map((c) => [c.id, c.box as Box]));
      const cellOf = new Map([...toDiagram(built).idMap].map(([cell, spec]) => [spec, cell]));
      const want = new Map<string, Box>();
      for (const [specId, box] of edits.boxes) {
        const cellId = cellOf.get(specId);
        const at = cellId ? now.get(cellId) : undefined;
        if (!cellId || !at) continue;
        if (Math.abs(at.x - box.x) > 0.75 || Math.abs(at.y - box.y) > 0.75 || Math.abs(at.w - box.w) > 0.75 || Math.abs(at.h - box.h) > 0.75) want.set(cellId, box);
      }
      if (want.size || edits.routes.size) {
        let xml = want.size ? setBoxes(built.xml, want, now) : built.xml;
        const after = new Map((await b.inspect(xml)).map((c) => [c.id, c.box as Box]));
        const pinned = new Map<string, { points: Array<{ x: number; y: number }>; from?: Box; to?: Box }>();
        for (const [edgeId, points] of edits.routes) {
          const c = built.byId.get(edgeCellId(edgeId));
          if (c) pinned.set(c.id, { points, from: after.get(c.source ?? ''), to: after.get(c.target ?? '') });
        }
        const shifted = (id?: string) => {
          const p = id ? now.get(id) : undefined, q = id ? after.get(id) : undefined;
          return !!p && !!q && (Math.abs(p.x - q.x) > 0.75 || Math.abs(p.y - q.y) > 0.75 || Math.abs(p.w - q.w) > 0.75 || Math.abs(p.h - q.h) > 0.75);
        };
        const stale = built.cells.filter((c) => c.edge && !pinned.has(c.id) && (shifted(c.source) || shifted(c.target))).map((c) => c.id);
        if (stale.length) xml = await rerouteInto(b, xml, stale);
        if (pinned.size) xml = setRoutes(xml, pinned);
        const moved = readDrawio(xml);
        res = await build(specOf(moved), { out, base: xml, keepLayout: true, browser: b, png: opts.png });
      }
    }
    return { out, changes: edits.changes, notes: edits.notes, check: res.check, created };
  });
}

export async function checkFile(file: string, browser?: DrawioBrowser): Promise<CheckResult> {
  const m = readDrawio(fs.readFileSync(file, 'utf8'));
  return withBrowser(browser, async (b) => check(await b.inspect(m.xml)));
}

/** Record on the diagram's root which spec it was built from. Not a cell, so nothing drawn or fingerprinted changes. */
function stamped(xml: string, stamp: string): string {
  return xml.replace(/<object id="0"([^>]*)>/, (_all, attrs: string) => `<object id="0"${attrs.replace(/\saiviz_spec="[^"]*"/, '')} aiviz_spec="${stamp}">`);
}

function outputKind(out: string): 'svg' | 'xml' {
  if (out.endsWith('.svg')) return 'svg';
  if (out.endsWith('.drawio') || out.endsWith('.xml')) return 'xml';
  throw new Error(`output must end in .drawio.svg (recommended), .svg or .drawio, got ${out}`);
}

/** Icon names for a provider, optionally filtered. */
export async function listIcons(provider: Provider, filter?: string, browser?: DrawioBrowser): Promise<string[]> {
  return withBrowser(browser, async (b) => {
    const names = new Set<string>();
    for (const p of stencilSets(provider)) for (const n of await b.stencilNames(p.set)) names.add(n.slice(p.prefix.length));
    return [...names].filter((n) => !filter || n.includes(filter.toLowerCase())).sort();
  });
}
