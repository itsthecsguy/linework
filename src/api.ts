// Programmatic API behind the CLI (and later the MCP server).
import fs from 'node:fs';
import path from 'node:path';
import { parseSpecText, type Issue } from './spec/parse.js';
import { layout, type Layout } from './layout/layout.js';
import type { Diagram } from './spec/model.js';
import { edgeCellId, patchEdges, serialize, stampEdgeRoutes, toMxfile } from './drawio/write.js';
import { absBox, fingerprint, readDrawio, specBase, type DrawioModel } from './drawio/read.js';
import { manualEdits, toDiagram, toYaml, type ManualEdit } from './drawio/show.js';
import { merge, type MergeStats } from './drawio/merge.js';
import { sequenceScene } from './layout/sequence.js';
import { resolveIcon, PROVIDERS, type Provider } from './drawio/icons.js';
import { DrawioBrowser } from './render/browser.js';
import { brokenEdges, check, type CheckResult } from './lint/check.js';
import { fixLabels } from './lint/fixlabels.js';

export interface BuildOptions {
  out: string;
  png?: string;
  /** Overwrite an existing file linework can't read. */
  force?: boolean;
  /** Throw away the existing layout, including hand edits, and lay out from scratch. */
  relayout?: boolean;
  browser?: DrawioBrowser;
}

export interface BuildResult {
  out: string;
  warnings: Issue[];
  check: CheckResult;
  direction: string;
  mode: 'fresh' | 'merge';
  merge?: MergeStats;
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

export async function build(specText: string, opts: BuildOptions): Promise<BuildResult> {
  const { diagram, warnings } = parseSpecText(specText);
  const kind = outputKind(opts.out);
  let old: DrawioModel | undefined;
  if (fs.existsSync(opts.out)) {
    try {
      old = readDrawio(fs.readFileSync(opts.out, 'utf8'));
    } catch {
      if (!opts.force) throw new Error(`${opts.out} exists and isn't a draw.io file linework can read. Use --force to overwrite it.`);
    }
  }
  const edits = old ? manualEdits(old) : [];
  // Once a person has touched the layout, every later build merges into it.
  const mode = old && !opts.relayout && (old.meta.aiviz_layout === 'manual' || edits.length > 0) ? 'merge' : 'fresh';
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
          const prev = shown.diagram.nodes.find((n) => n.id === specId);
          const now = diagram.nodes.find((n) => n.id === specId);
          if (!prev || !now || shown.diagram.theme !== diagram.theme) continue;
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
    const l = await layout(diagram, measure);
    let xml: string;
    let stats: MergeStats | undefined;
    if (mode === 'merge') {
      const m = merge(diagram, old!, l, { specIsCurrent: specBase(specText) === fingerprint(old!) });
      stats = m.stats;
      xml = serialize(m.scene);
      if (m.reroute.length) xml = await rerouteInto(b, xml, m.reroute);
      // Kept routes can already be broken, e.g. stale waypoints after someone moved a node.
      const broken = brokenEdges(check(await b.inspect(xml)));
      if (broken.length) {
        xml = await rerouteInto(b, xml, broken);
        stats.rerouted += broken.filter((id) => !m.reroute.includes(id)).length;
      }
    } else xml = await straightenDetours(b, toMxfile(diagram, l), detourEdges(diagram, l));
    xml = (await fixLabels(b, xml)).xml;
    xml = stampEdgeRoutes(xml);
    return finish(b, xml, { mode, warnings, direction: mode === 'merge' ? (old!.meta.aiviz_direction ?? l.direction) : l.direction, edits, old, stats });
  });

  async function finish(
    b: DrawioBrowser,
    xml: string,
    r: { mode: 'fresh' | 'merge'; warnings: Issue[]; direction: string; edits: ManualEdit[]; old?: DrawioModel; stats?: MergeStats },
  ): Promise<BuildResult> {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, kind === 'svg' ? await b.renderSvg(xml) : xml);
    if (opts.png) await b.renderPng(xml, opts.png);
    return {
      out: opts.out,
      warnings: r.warnings,
      check: check(await b.inspect(xml)),
      direction: r.direction,
      mode: r.mode,
      merge: r.stats,
      discardedLayout: !!(opts.relayout && r.old && (r.old.meta.aiviz_layout === 'manual' || r.edits.length > 0)),
    };
  }
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

/** Reroute only the edges check flags as broken. Nothing else changes. */
export async function tidy(file: string, browser?: DrawioBrowser): Promise<{ fixed: number; check: CheckResult }> {
  const text = fs.readFileSync(file, 'utf8');
  const m = readDrawio(text);
  return withBrowser(browser, async (b) => {
    const broken = brokenEdges(check(await b.inspect(m.xml)));
    if (!broken.length) return { fixed: 0, check: check(await b.inspect(m.xml)) };
    const xml = stampEdgeRoutes(await rerouteInto(b, m.xml, broken));
    fs.writeFileSync(file, file.endsWith('.svg') ? await b.renderSvg(xml) : xml);
    return { fixed: broken.length, check: check(await b.inspect(xml)) };
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
    if (out.endsWith('.png')) await b.renderPng(m.xml, out);
    else if (out.endsWith('.svg')) fs.writeFileSync(out, await b.renderSvg(m.xml));
    else throw new Error('render output must end in .png or .svg');
  });
}

export async function checkFile(file: string, browser?: DrawioBrowser): Promise<CheckResult> {
  const m = readDrawio(fs.readFileSync(file, 'utf8'));
  return withBrowser(browser, async (b) => check(await b.inspect(m.xml)));
}

function outputKind(out: string): 'svg' | 'xml' {
  if (out.endsWith('.svg')) return 'svg';
  if (out.endsWith('.drawio') || out.endsWith('.xml')) return 'xml';
  throw new Error(`output must end in .drawio.svg (recommended), .svg or .drawio, got ${out}`);
}

/** Icon names for a provider, optionally filtered. */
export async function listIcons(provider: Provider, filter?: string, browser?: DrawioBrowser): Promise<string[]> {
  return withBrowser(browser, async (b) => {
    const p = PROVIDERS[provider];
    const names = (await b.stencilNames(p.set)).map((n) => n.slice(p.prefix.length));
    return names.filter((n) => !filter || n.includes(filter.toLowerCase())).sort();
  });
}
