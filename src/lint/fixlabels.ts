// Slide edge labels along their edges until they stop colliding with other labels
// or sitting on nodes. Only label positions change; routes and nodes stay put.
// Spots in the middle of a straight run come first, so a label never ends up
// wedged into a bend when there's a clear stretch of line for it.
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import type { DrawioBrowser } from '../render/browser.js';
import { check, type Finding } from './check.js';

const OFFSETS = [-0.35, 0.35, -0.65, 0.65, -0.15, 0.15, -0.85, 0.85];
const LABEL_RULES = new Set(['label-collision', 'label-on-node', 'label-on-edge']);

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

export async function fixLabels(b: DrawioBrowser, xml: string, maxRounds = 6): Promise<{ xml: string; moved: number }> {
  let cur = xml;
  let score = check(await b.inspect(cur)).findings.filter((f) => LABEL_RULES.has(f.rule)).length;
  let moved = 0;
  for (let round = 0; round < maxRounds && score > 0; round++) {
    const cells = await b.inspect(cur);
    const res = check(cells);
    const targets = labelEdges(res.findings);
    let improved = false;
    for (const id of targets) {
      const doc = new DOMParser().parseFromString(cur, 'text/xml');
      const g = edgeGeometry(doc, id);
      if (!g) continue;
      const base = Number(g.getAttribute('x') ?? 0);
      const cell = cells.find((c) => c.id === id);
      const spots = cell?.points && cell.textBox ? runSpots(cell.points, cell.textBox) : [];
      const tries = [...spots, ...OFFSETS.map((off) => Math.max(-0.9, Math.min(0.9, base + off)))];
      let best: { xml: string; score: number } | undefined;
      for (const x of tries) {
        g.setAttribute('x', x.toFixed(3));
        const candidate = new XMLSerializer().serializeToString(doc);
        const s = check(await b.inspect(candidate)).findings.filter((f) => LABEL_RULES.has(f.rule)).length;
        if (s < (best?.score ?? score)) best = { xml: candidate, score: s };
        if (s === 0) break;
      }
      if (best) {
        cur = best.xml;
        score = best.score;
        moved++;
        improved = true;
        if (score === 0) break;
      }
    }
    if (!improved) break;
  }
  cur = await matchLabelBackgrounds(b, cur);
  return { xml: cur, moved };
}

/**
 * A label's backing has to match what it sits on: the fill of the smallest group
 * under it, or the canvas. Run after labels move, since a move can carry a label
 * from the canvas onto a group or back.
 */
export async function matchLabelBackgrounds(b: DrawioBrowser, xml: string): Promise<string> {
  const cells = await b.inspect(xml);
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
