// Spike: custom sequence layout using draw.io's native UML lifeline + frame shapes,
// so a human can drag lifelines and messages stay attached.
import * as theme from './theme.mjs';
import { wrap } from './build.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MSG_RE = /^\s*([\w.-]+)\s*(-->|->)\s*([\w.-]+)\s*$/;

export function buildSequence(spec) {
  const parts = Object.entries(spec.participants).map(([id, p]) => ({ id, ...p }));
  const idx = Object.fromEntries(parts.map((p, i) => [p.id, i]));

  // Flatten messages; frames are {frame: 'alt', label, branches: [{label, messages}]}
  const rows = [];
  const frames = [];
  const walk = (list, depth) => {
    for (const item of list) {
      if (item.frame) {
        const f = { kind: item.frame, label: item.label, start: rows.length, branches: [], depth };
        rows.push({ spacer: true });
        for (const [bi, b] of (item.branches ?? [{ messages: item.messages }]).entries()) {
          if (bi > 0) { f.branches.push({ label: b.label, at: rows.length }); rows.push({ spacer: true }); }
          else f.firstLabel = b.label;
          walk(b.messages, depth + 1);
        }
        f.end = rows.length;
        rows.push({ spacer: true, small: true });
        frames.push(f);
        continue;
      }
      let head = item, label = '';
      if (typeof item === 'object') [[head, label]] = Object.entries(item);
      const m = MSG_RE.exec(head);
      if (!m) throw new Error(`message "${head}": use "a -> b: text" or "a --> b: text"`);
      rows.push({ from: m[1], to: m[3], label, ret: m[2] === '-->' });
    }
  };
  walk(spec.messages, 0);

  // Column widths: wide enough for the header and for every message label between neighbours.
  const headW = parts.map((p) => Math.max(128, Math.ceil((theme.textWidth(p.label, theme.font.label, 600) + 32) / 8) * 8));
  const gap = parts.map(() => 72);
  for (const r of rows) {
    if (r.spacer || r.from === r.to) continue;
    const a = Math.min(idx[r.from], idx[r.to]), b = Math.max(idx[r.from], idx[r.to]);
    const need = theme.textWidth(r.label, theme.font.edge) + 40;
    const span = b - a;
    for (let i = a; i < b; i++) gap[i] = Math.max(gap[i], Math.ceil(need / span));
  }
  const xs = [];
  let x = 40;
  parts.forEach((p, i) => {
    xs.push(x);
    x += headW[i] + (i < parts.length - 1 ? Math.max(0, gap[i] - headW[i] / 2 - headW[i + 1] / 2) + 48 : 0);
  });
  const headH = 48, top = 24, rowH = 40;
  const ys = [];
  let y = top + headH + 32;
  for (const r of rows) { ys.push(y); y += r.small ? 16 : r.spacer ? 36 : rowH; }
  const lifeH = y - top + 16;

  const cells = [];
  parts.forEach((p, i) => {
    const k = theme.kinds[p.kind ?? 'service'] ?? theme.kinds.service;
    const style =
      `shape=umlLifeline;perimeter=lifelinePerimeter;container=1;collapsible=0;recursiveResize=0;outlineConnect=0;` +
      `size=${headH};html=1;whiteSpace=wrap;rounded=1;absoluteArcSize=1;arcSize=16;` +
      `fillColor=${k.fill};strokeColor=${k.stroke};strokeWidth=1.5;` +
      `fontFamily=${theme.font.family};fontSource=${encodeURIComponent(theme.font.source)};fontSize=${theme.font.label};fontColor=${theme.ink.text};`;
    cells.push(
      `<object id="${esc(p.id)}" label="${esc(theme.nodeLabel(p.label, p.tech))}" aiviz_kind="${esc(p.kind ?? 'service')}">` +
        `<mxCell style="${esc(style)}" vertex="1" parent="1"><mxGeometry x="${xs[i]}" y="${top}" width="${headW[i]}" height="${lifeH}" as="geometry"/></mxCell></object>`,
    );
  });
  const cx = (id) => xs[idx[id]] + headW[idx[id]] / 2;

  // Frames first so messages draw on top.
  const frameCells = [];
  for (const f of frames) {
    const involved = new Set();
    rows.slice(f.start, f.end).forEach((r) => r.from && (involved.add(idx[r.from]), involved.add(idx[r.to])));
    const lo = Math.min(...involved), hi = Math.max(...involved);
    const fx = cx(parts[lo].id) - 72 + f.depth * 8, fx2 = cx(parts[hi].id) + 72 - f.depth * 8;
    const fy = ys[f.start] - 4, fy2 = ys[f.end];
    const style =
      `shape=umlFrame;whiteSpace=wrap;html=1;width=48;height=22;boundedLbl=1;verticalAlign=middle;align=center;` +
      `fillColor=none;strokeColor=#94A3B8;strokeWidth=1;swimlaneFillColor=none;` +
      `fontFamily=${theme.font.family};fontSize=${theme.font.sub};fontStyle=1;fontColor=${theme.ink.muted};`;
    frameCells.push(`<mxCell id="f${f.start}" value="${esc(f.kind)}" style="${esc(style)}" vertex="1" parent="1"><mxGeometry x="${fx}" y="${fy}" width="${fx2 - fx}" height="${fy2 - fy}" as="geometry"/></mxCell>`);
    const guard = (text, yy, id) =>
      text &&
      frameCells.push(
        `<mxCell id="${id}" value="${esc(`[${text}]`)}" style="text;html=1;align=left;verticalAlign=middle;labelBackgroundColor=#FFFFFF;fontFamily=${theme.font.family};fontSize=${theme.font.sub};fontColor=${theme.ink.muted};" vertex="1" parent="1"><mxGeometry x="${fx + 56}" y="${yy}" width="${Math.max(80, theme.textWidth(text, 11) + 16)}" height="22" as="geometry"/></mxCell>`,
      );
    guard(f.firstLabel, fy, `g${f.start}`);
    for (const b of f.branches) {
      frameCells.push(`<mxCell id="d${b.at}" style="endArrow=none;dashed=1;dashPattern=4 4;strokeColor=#94A3B8;html=1;" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${fx}" y="${ys[b.at] + 8}" as="sourcePoint"/><mxPoint x="${fx2}" y="${ys[b.at] + 8}" as="targetPoint"/></mxGeometry></mxCell>`);
      guard(b.label, ys[b.at] + 10, `g${b.at}`);
    }
  }
  cells.push(...frameCells);

  rows.forEach((r, i) => {
    if (r.spacer) return;
    const yy = ys[i];
    const s = idx[r.from], t = idx[r.to];
    const fy = (yy - top) / lifeH;
    let style =
      `html=1;verticalAlign=bottom;endArrow=${r.ret ? 'open' : 'blockThin'};endFill=1;endSize=7;strokeWidth=1.5;strokeColor=${theme.ink.edge};` +
      `fontFamily=${theme.font.family};fontSource=${encodeURIComponent(theme.font.source)};fontSize=${theme.font.edge};fontColor=${theme.ink.edgeText};labelBackgroundColor=#FFFFFF;` +
      (r.ret ? 'dashed=1;dashPattern=6 4;' : '');
    let geom;
    if (s === t) {
      style += `edgeStyle=orthogonalEdgeStyle;rounded=1;align=left;spacingLeft=6;verticalAlign=middle;exitX=0.5;exitY=${fy.toFixed(4)};entryX=0.5;entryY=${((yy + 20 - top) / lifeH).toFixed(4)};`;
      geom = `<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="${cx(r.from) + 40}" y="${yy}"/><mxPoint x="${cx(r.from) + 40}" y="${yy + 20}"/></Array></mxGeometry>`;
    } else {
      style += `exitX=0.5;exitY=${fy.toFixed(4)};entryX=0.5;entryY=${fy.toFixed(4)};`;
      geom = `<mxGeometry relative="1" as="geometry"/>`;
    }
    cells.push(
      `<object id="m${i}" label="${esc(r.label)}" aiviz_msg="${esc(`${r.from}->${r.to}`)}"><mxCell style="${esc(style)}" edge="1" parent="1" source="${esc(r.from)}" target="${esc(r.to)}">${geom}</mxCell></object>`,
    );
  });
  return wrap(spec.title ?? 'Sequence', cells);
}
