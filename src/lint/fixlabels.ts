// Slide edge labels along their edges until they stop colliding with other labels
// or sitting on nodes. Only label positions change; routes and nodes stay put.
// Spots in the middle of a straight run come first, so a label never ends up
// wedged into a bend when there's a clear stretch of line for it.
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import type { DrawioBrowser, InspectCell } from '../render/browser.js';
import { check, segHitsBox, type Finding } from './check.js';

const OFFSETS = [-0.35, 0.35, -0.65, 0.65, -0.15, 0.15, -0.85, 0.85];
const LABEL_RULES = new Set(['label-collision', 'label-on-node', 'label-on-edge']);

type Box = { x: number; y: number; w: number; h: number };
const inter = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const grow = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, w: Math.max(0, b.w + 2 * m), h: Math.max(0, b.h + 2 * m) });
const scaffold = (c: InspectCell) => c.shape === 'umlLifeline' || c.shape === 'umlFrame' || ['bar', 'guard', 'frame', 'grid', 'tick', 'lane'].includes(c.aivizType ?? '');

function edgeGeometry(doc: ReturnType<DOMParser['parseFromString']>, id: string): Element | undefined {
  const objs = doc.getElementsByTagName('object');
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i]!;
    if (o.getAttribute('id') !== id) continue;
    return (o.getElementsByTagName('mxGeometry')[0] as Element | undefined) ?? undefined;
  }
  return undefined;
}

type P = { x: number; y: number };

/** Label positions (draw.io's -1..1 along the path) on straight runs, roomiest run first. */
export function runSpots(pts: P[], label: { w: number; h: number }): number[] {
  const segs: Array<{ start: number; len: number; need: number }> = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const vertical = Math.abs(b.x - a.x) < Math.abs(b.y - a.y);
    segs.push({ start: total, len, need: (vertical ? label.h : label.w) / 2 + 10 });
    total += len;
  }
  if (!total) return [];
  const out: number[] = [];
  for (const sg of segs.filter((x) => x.len >= 2 * x.need).sort((x, y) => y.len - x.len))
    for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const at = sg.start + Math.min(sg.len - sg.need, Math.max(sg.need, t * sg.len));
      const f = (at / total) * 2 - 1;
      if (!out.some((o) => Math.abs(o - f) * total < 16)) out.push(f);
    }
  return out;
}

function labelEdges(findings: Finding[]): string[] {
  return [...new Set(findings.filter((f) => LABEL_RULES.has(f.rule) && f.labelEdges).flatMap((f) => f.labelEdges!))];
}

/**
 * Returns the fixed XML and its cells. Only label backgrounds change after the
 * cells are read, and those don't move anything, so the cells stay valid for it.
 */
export async function fixLabels(b: DrawioBrowser, xml: string, maxRounds = 6): Promise<{ xml: string; moved: number; cells: InspectCell[] }> {
  let cur = xml;
  const cells = await b.inspect(cur);
  const active = cells.filter((c) => c.aivizType !== 'legend');
  const nodeBoxes = active.filter((c) => c.vertex && !c.container && !c.text && !scaffold(c)).map((n) => grow(n.box, 3));
  const containers = active.filter((c) => c.vertex && c.container && !scaffold(c));
  const groupTitles = containers.filter((g) => g.label && g.textBox).map((g) => grow(g.textBox!, 2));
  const groupBorders = containers.map((g) => [
    { x: g.box.x, y: g.box.y },
    { x: g.box.x + g.box.w, y: g.box.y },
    { x: g.box.x + g.box.w, y: g.box.y + g.box.h },
    { x: g.box.x, y: g.box.y + g.box.h },
    { x: g.box.x, y: g.box.y },
  ]);
  const edges = active.filter((c) => c.edge && c.points && c.points.length >= 2);
  const edgeLabels = edges.filter((e) => e.textBox && e.label);

  // Lightweight label-only scorer for candidate positions of one edge's label.
  const scoreLabel = (id: string, tb: Box | null): number => {
    if (!tb) return 0;
    let hits = 0;
    for (const nb of nodeBoxes) if (inter(tb, nb) > 4) hits++;
    for (const gt of groupTitles) if (inter(tb, gt) > 4) hits++;
    const inner = grow(tb, -2);
    let onLine = false;
    for (const o of edges) {
      if (o.id === id) continue;
      const pts = o.points!;
      for (let k = 0; k < pts.length - 1; k++) {
        if (segHitsBox(pts[k]!, pts[k + 1]!, inner)) {
          onLine = true;
          break;
        }
      }
      if (onLine) break;
    }
    if (!onLine) {
      const outer = grow(tb, 3);
      for (const pts of groupBorders) {
        for (let k = 0; k < pts.length - 1; k++) {
          if (segHitsBox(pts[k]!, pts[k + 1]!, outer)) {
            onLine = true;
            break;
          }
        }
        if (onLine) break;
      }
    }
    if (onLine) hits++;
    for (const o of edgeLabels) {
      if (o.id !== id && o.textBox && inter(tb, o.textBox) > 6) hits++;
    }
    return hits;
  };

  let moved = 0;
  for (let round = 0; round < maxRounds; round++) {
    const targets = labelEdges(check(cells).findings);
    if (!targets.length) break;
    const doc = new DOMParser().parseFromString(cur, 'text/xml');
    let improved = false;
    for (const id of targets) {
      const g = edgeGeometry(doc, id);
      if (!g) continue;
      const base = Number(g.getAttribute('x') ?? 0);
      const cell = cells.find((c) => c.id === id);
      const curScore = scoreLabel(id, cell?.textBox ?? null);
      if (curScore === 0) continue;
      const spots = cell?.points && cell.textBox ? runSpots(cell.points, cell.textBox) : [];
      const tries = [...spots, ...OFFSETS.map((off) => Math.max(-0.9, Math.min(0.9, base + off)))].map((x) => Number(x.toFixed(3)));
      const boxes = await b.labelBoxes(cur, id, tries);
      let best: { x: number; score: number; box: InspectCell['textBox'] } | undefined;
      for (let i = 0; i < tries.length; i++) {
        const s = scoreLabel(id, boxes[i]!);
        if (s < (best?.score ?? curScore)) best = { x: tries[i]!, score: s, box: boxes[i]! };
        if (s === 0) break;
      }
      if (best) {
        g.setAttribute('x', best.x.toFixed(3));
        if (cell) cell.textBox = best.box;
        moved++;
        improved = true;
      }
    }
    if (!improved) break;
    cur = new XMLSerializer().serializeToString(doc);
  }
  const finalCells = moved ? await b.inspect(cur) : cells;
  cur = await matchLabelBackgrounds(b, cur, finalCells);
  return { xml: cur, moved, cells: finalCells };
}

/**
 * A label's backing has to match what it sits on: the fill of the smallest group
 * under it, or the canvas. Run after labels move, since a move can carry a label
 * from the canvas onto a group or back.
 */
export async function matchLabelBackgrounds(b: DrawioBrowser, xml: string, known?: InspectCell[]): Promise<string> {
  const cells = known ?? (await b.inspect(xml));
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const canvas = doc.getElementsByTagName('mxGraphModel')[0]?.getAttribute('background') ?? '#FFFFFF';
  const styleOf = new Map<string, Element>();
  const objs = doc.getElementsByTagName('object');
  for (let i = 0; i < objs.length; i++) {
    const cell = objs[i]!.getElementsByTagName('mxCell')[0] as Element | undefined;
    if (cell) styleOf.set(objs[i]!.getAttribute('id') ?? '', cell);
  }
  const fillOf = (id: string) => /(?:^|;)fillColor=([^;]+)/.exec(styleOf.get(id)?.getAttribute('style') ?? '')?.[1];
  const groups = cells.filter((c) => c.aivizType === 'group');
  let changed = false;
  for (const e of cells.filter((c) => c.edge && c.textBox && c.label)) {
    const el = styleOf.get(e.id);
    const style = el?.getAttribute('style') ?? '';
    if (!el || !/labelBackgroundColor=/.test(style)) continue;
    const cx = e.textBox!.x + e.textBox!.w / 2, cy = e.textBox!.y + e.textBox!.h / 2;
    let bg = canvas, area = Infinity;
    for (const g of groups) {
      const r = g.box, f = fillOf(g.id);
      if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h || !f || f === 'none' || r.w * r.h >= area) continue;
      bg = f;
      area = r.w * r.h;
    }
    const next = style.replace(/labelBackgroundColor=[^;]*/, `labelBackgroundColor=${bg}`);
    if (next !== style) {
      el.setAttribute('style', next);
      changed = true;
    }
  }
  return changed ? new XMLSerializer().serializeToString(doc) : xml;
}
