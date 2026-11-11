// A timeline: tasks as bars on a date axis, milestones as diamonds, optional
// lanes. Like a sequence diagram, its layout is its meaning (where a bar sits
// is when it happens), so it is drawn by rule and not by ELK. The axis is
// recorded on the diagram, which lets `show` read a bar somebody dragged in
// draw.io or Excalidraw as new dates.
import type { Diagram, Node } from '../spec/model.js';
import { dayOf, isoOf, kindDef } from '../spec/model.js';
import { autoAttr, diagramMeta, lookAttrs, type Scene, type SceneVertex } from '../drawio/write.js';
import { groupLabel, groupStyle, nodeLabel, nodeStyle, palette, type ThemeArg } from '../drawio/theme.js';
import { fontsFor, type Measure } from './layout.js';
import { TextMeasurer } from './text.js';

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const X0 = 40, AXIS_Y = 40, AXIS_H = 28, ROW = 36, BAR = 24, MARK = 18, LANE_HEAD = 26;

/** Where the axis is: the day at x = X0 and the width of a day. Stored on the diagram as aiviz_t0 and aiviz_ppd. */
export interface Axis {
  t0: number;
  ppd: number;
}

export function axisOf(meta: Record<string, string>): Axis | undefined {
  const t0 = Number(meta.aiviz_t0), ppd = Number(meta.aiviz_ppd);
  return Number.isFinite(t0) && ppd > 0 ? { t0, ppd } : undefined;
}

/** The dates a box at this place on the axis stands for. A milestone is one day: the one under its middle. */
export function datesAt(axis: Axis, box: { x: number; w: number }, milestone: boolean): { start: string; end: string } {
  if (milestone) {
    const day = axis.t0 + Math.floor((box.x + box.w / 2 - X0) / axis.ppd);
    return { start: isoOf(day), end: isoOf(day) };
  }
  const start = axis.t0 + Math.round((box.x - X0) / axis.ppd);
  const days = Math.max(1, Math.round(box.w / axis.ppd));
  return { start: isoOf(start), end: isoOf(start + days - 1) };
}

type Unit = 'day' | 'week' | 'month' | 'quarter';

function floorTo(day: number, unit: Unit): number {
  const d = new Date(day * DAY);
  if (unit === 'day') return day;
  if (unit === 'week') return day - ((d.getUTCDay() + 6) % 7); // Monday
  const month = unit === 'quarter' ? d.getUTCMonth() - (d.getUTCMonth() % 3) : d.getUTCMonth();
  return Date.UTC(d.getUTCFullYear(), month, 1) / DAY;
}

function next(day: number, unit: Unit): number {
  if (unit === 'day') return day + 1;
  if (unit === 'week') return day + 7;
  const d = new Date(day * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (unit === 'quarter' ? 3 : 1), 1) / DAY;
}

function tickText(day: number, unit: Unit, first: boolean): string {
  const d = new Date(day * DAY);
  const mon = MONTHS[d.getUTCMonth()]!, year = d.getUTCFullYear();
  if (unit === 'day') return first || d.getUTCDate() === 1 ? `${mon} ${d.getUTCDate()}` : String(d.getUTCDate());
  if (unit === 'week') return `${mon} ${d.getUTCDate()}`;
  if (unit === 'month') return first || d.getUTCMonth() === 0 ? `${mon} ${year}` : mon;
  return `Q${d.getUTCMonth() / 3 + 1} ${year}`;
}

export async function timelineScene(d: Diagram, measure: Measure, opts: { extraMeta?: Record<string, string> } = {}): Promise<Scene> {
  const theme: ThemeArg = d;
  const t = palette(theme);
  const fonts = fontsFor(theme);
  const tm = new TextMeasurer(measure);
  const items = d.nodes.map((n) => ({ n, start: dayOf(n.start)!, end: dayOf(n.end ?? n.start)!, milestone: kindDef(d.type, n.kind).shape === 'diamond' }));
  await tm.prepare([...d.nodes.map((n) => [n.label, fonts.label] as const), ...d.groups.map((g) => [g.label, fonts.group] as const)]);

  // ---------- the axis: a unit whose ticks have room for their labels ----------
  const lo = Math.min(...items.map((i) => i.start)), hi = Math.max(...items.map((i) => i.end));
  const span = hi - lo + 1;
  const unit: Unit = span <= 21 ? 'day' : span <= 150 ? 'week' : span <= 900 ? 'month' : 'quarter';
  const t0 = floorTo(lo, unit);
  let t1 = next(floorTo(hi, unit), unit);
  if (unit === 'day') t1 = hi + 1;
  const least = { day: 30, week: 8, month: 1.7, quarter: 0.72 }[unit];
  const ppd = Math.round(Math.min(44, Math.max(least, 760 / (t1 - t0))) * 100) / 100;
  const x = (day: number) => X0 + (day - t0) * ppd;
  const right = x(t1);

  // ---------- rows: tasks outside any lane first, then each lane's ----------
  const vertices: SceneVertex[] = [];
  const bars: SceneVertex[] = [];
  let y = AXIS_Y + AXIS_H + 10;
  let reach = right;
  const place = (i: (typeof items)[number]) => {
    const n = i.n;
    const textW = tm.width(n.label, fonts.label);
    const box = i.milestone
      ? { x: x(i.start + 0.5) - MARK / 2, y: y + (ROW - MARK) / 2, w: MARK, h: MARK }
      : { x: x(i.start), y: y + (ROW - BAR) / 2, w: Math.max(ppd, (i.end - i.start + 1) * ppd), h: BAR };
    // The name goes in the bar when it fits, and beside it when it doesn't.
    const fits = !i.milestone && textW + 20 <= box.w;
    if (!fits) reach = Math.max(reach, box.x + box.w + 8 + textW);
    const base = nodeStyle(d.type, n.kind, theme, n).replace(/whiteSpace=wrap;/, '');
    bars.push({
      id: n.id,
      parent: '1',
      attrs: {
        label: nodeLabel(n.label, undefined, { theme, type: d.type, kind: n.kind, color: fits ? n.color : undefined, highlight: fits ? n.highlight : false }),
        aiviz_kind: n.kind,
        aiviz_label: n.label,
        aiviz_start: n.start!,
        ...(n.end && n.end !== n.start ? { aiviz_end: n.end } : {}),
        ...(n.parent ? { aiviz_lane: n.parent } : {}),
        ...lookAttrs(n),
        aiviz_auto: autoAttr(box),
      },
      style: base + (fits ? '' : `labelPosition=right;verticalLabelPosition=middle;align=left;spacingLeft=8;fontColor=${t.text};`),
      box,
    });
    y += ROW;
  };
  for (const i of items.filter((i) => !i.n.parent)) place(i);
  const lanes: Array<{ id: string; top: number; bottom: number }> = [];
  for (const g of d.groups) {
    const mine = items.filter((i) => i.n.parent === g.id);
    if (!mine.length) continue;
    y += 10;
    const top = y;
    y += LANE_HEAD;
    for (const i of mine) place(i);
    y += 6;
    lanes.push({ id: g.id, top, bottom: y });
  }
  const bottom = y + 4;
  const width = reach + 16 - (X0 - 16);

  // Lanes go under everything else: bands across the chart, named at the top left.
  for (const lane of lanes) {
    const g = d.groups.find((x) => x.id === lane.id)!;
    const box = { x: X0 - 16, y: lane.top, w: width, h: lane.bottom - lane.top };
    vertices.push({
      id: g.id,
      parent: '1',
      attrs: { label: groupLabel(g.label, theme), aiviz_type: 'lane', aiviz_label: g.label, ...lookAttrs(g), aiviz_auto: autoAttr(box) },
      style: groupStyle(theme, g, 0).replace(/container=1;/, 'container=0;'),
      box,
    });
  }
  // The axis: a label at each tick and a faint line down the chart.
  const tickStyle = `text;html=1;align=left;verticalAlign=middle;fontFamily=${t.type.family};fontSize=${t.type.size.edge};fontColor=${t.muted};`;
  const lineStyle = `rounded=0;html=1;fillColor=${t.edge};strokeColor=none;opacity=22;`;
  let k = 0;
  for (let day = t0; day < t1; day = next(day, unit), k++) {
    vertices.push({ id: `tick_${k}`, parent: '1', attrs: { label: tickText(day, unit, k === 0), aiviz_type: 'tick' }, style: tickStyle, box: { x: x(day) + 5, y: AXIS_Y, w: Math.max(30, next(day, unit) * ppd - day * ppd - 6), h: AXIS_H } });
    vertices.push({ id: `grid_${k}`, parent: '1', attrs: { label: '', aiviz_type: 'grid' }, style: lineStyle, box: { x: x(day), y: AXIS_Y + 2, w: 1, h: bottom - AXIS_Y - 2 } });
  }
  vertices.push({ id: 'axis', parent: '1', attrs: { label: '', aiviz_type: 'grid' }, style: lineStyle.replace('opacity=22', 'opacity=70'), box: { x: X0, y: AXIS_Y + AXIS_H, w: right - X0, h: 1 } });
  vertices.push(...bars);

  return {
    name: d.title ?? 'Timeline',
    meta: diagramMeta(d, { aiviz_t0: String(t0), aiviz_ppd: String(ppd), ...opts.extraMeta }),
    background: t.canvas,
    vertices,
    edges: [],
    raw: [],
  };
}

export type { Node };
