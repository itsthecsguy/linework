// Spike: semantic spec -> ELK layout -> draw.io mxfile XML.
// Not production code. Enough to judge layout + theme quality.
import ELK from 'elkjs/lib/elk.bundled.js';
import * as theme from './theme.mjs';

const elk = new ELK();
const snap = (v, g = 8) => Math.round(v / g) * g;
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const EDGE_RE = /^\s*([\w.-]+)\s*(<->|-\.->|-->|->)\s*([\w.-]+)\s*$/;

export function parseEdges(list = []) {
  return list.map((item, i) => {
    let head = item, label = '';
    if (typeof item === 'object') [[head, label]] = Object.entries(item);
    else if (item.includes(':')) [head, label] = [item.slice(0, item.indexOf(':')), item.slice(item.indexOf(':') + 1).trim()];
    const m = EDGE_RE.exec(head);
    if (!m) throw new Error(`edge ${i}: can't parse "${head}". Use "a -> b: label".`);
    return { id: `e${i}`, from: m[1], to: m[3], label: label ?? '', async: m[2] === '-.->' || m[2] === '-->', bidir: m[2] === '<->' };
  });
}

function nodeSize(n, spec) {
  const k = theme.kinds[n.kind] ?? theme.kinds.service;
  if (k.shape === 'dot' || k.shape === 'enddot') return { w: 24, h: 24 };
  const tw = Math.max(theme.textWidth(n.label, theme.font.label, 600), n.tech ? theme.textWidth(n.tech, theme.font.sub) : 0);
  if (k.shape === 'diamond') {
    const w = snap(Math.max(128, tw * 1.5 + 32));
    return { w, h: snap(Math.max(72, w * 0.5)) };
  }
  const minW = spec.type === 'architecture' ? 152 : 128;
  const w = snap(Math.min(208, Math.max(minW, tw + 40)));
  const lines = Math.ceil((tw + 40) / w);
  const h = snap((n.tech ? 52 : 40) + (lines - 1) * 16 + (k.shape === 'cylinder' ? 16 : 0));
  return { w, h };
}

export async function buildGraph(spec) {
  const groups = spec.groups ?? {};
  const nodes = Object.entries(spec.nodes ?? {}).map(([id, n]) => ({ id, ...n, kind: n.kind ?? defaultKind(spec) }));
  const edges = parseEdges(spec.edges);
  if (!spec.direction || spec.direction === 'auto') {
    const a = await buildGraph({ ...spec, direction: 'LR' });
    const b = await buildGraph({ ...spec, direction: 'TB' });
    const score = (g) => {
      const w = g.laid.width, h = g.laid.height;
      return Math.abs(Math.log((w / h) / 1.6)) + (w > 1400 ? (w - 1400) / 400 : 0);
    };
    return score(a) <= score(b) ? a : b;
  }
  const dir = spec.direction === 'LR' ? 'RIGHT' : 'DOWN';

  // Uniform width for box-like nodes in the same diagram reads much calmer.
  const sizes = Object.fromEntries(nodes.map((n) => [n.id, nodeSize(n, spec)]));
  const boxIds = nodes.filter((n) => !['dot', 'enddot', 'diamond'].includes((theme.kinds[n.kind] ?? {}).shape)).map((n) => n.id);
  if (spec.uniformWidth !== false && boxIds.length) {
    const maxW = Math.max(...boxIds.map((id) => sizes[id].w));
    for (const id of boxIds) sizes[id].w = maxW;
  }

  const elkNodes = {};
  const mk = (id, extra = {}) => (elkNodes[id] = { id, children: [], ...extra });
  const root = mk('root', {
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      'elk.spacing.edgeNode': '24',
      'elk.spacing.edgeEdge': '16',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.spacing.edgeLabel': '6',
      'elk.layered.nodePlacement.strategy': process.env.PLACE ?? 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      ...(process.env.ELKX ? JSON.parse(process.env.ELKX) : {}),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.mergeEdges': 'false',
      'elk.edgeLabels.inline': 'true',
      'elk.layered.edgeLabels.sideSelection': 'ALWAYS_UP',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]',
      'elk.json.shapeCoords': 'ROOT',
      'elk.json.edgeCoords': 'ROOT',
    },
    edges: [],
  });
  for (const [id, g] of Object.entries(groups))
    mk(id, { layoutOptions: { 'elk.padding': '[top=44,left=24,bottom=24,right=24]' }, meta: { group: true, label: g.label } });
  for (const [id, g] of Object.entries(groups)) elkNodes[g.in ?? 'root'].children.push(elkNodes[id]);
  for (const n of nodes) {
    const en = mk(n.id, { width: sizes[n.id].w, height: sizes[n.id].h, meta: n });
    delete en.children;
    (elkNodes[n.in ?? 'root'] ?? elkNodes.root).children.push(en);
  }
  for (const e of edges) {
    const labels = e.label
      ? [{ text: e.label, width: theme.textWidth(e.label, theme.font.edge) + 8, height: 16 }]
      : [];
    root.edges.push({ id: e.id, sources: [e.from], targets: [e.to], labels, meta: e });
  }

  const out = await elk.layout(root);
  return { spec, laid: out, edges, nodes, groups };
}

function defaultKind(spec) {
  return { flow: 'step', state: 'state' }[spec.type] ?? 'service';
}

// Walk ELK result and emit draw.io cells. Children of groups use parent-relative coords.
export function toMxfile({ spec, laid, edges }, { name = spec.title ?? 'Diagram', waypoints = true } = {}) {
  const abs = {};
  const parentOf = {};
  const cells = [];
  const walk = (n, parent) => {
    for (const c of n.children ?? []) {
      abs[c.id] = { x: c.x, y: c.y, w: c.width, h: c.height };
      parentOf[c.id] = parent;
      walk(c, c.id);
    }
  };
  walk(laid, 'root');
  const rel = (id) => {
    const a = abs[id], p = parentOf[id];
    return p === 'root' ? a : { ...a, x: a.x - abs[p].x, y: a.y - abs[p].y };
  };
  const pid = (id) => (parentOf[id] === 'root' ? '1' : parentOf[id]);
  const all = [];
  const collect = (n) => (n.children ?? []).forEach((c) => (all.push(c), collect(c)));
  collect(laid);

  for (const c of all) {
    const g = rel(c.id);
    const geom = `<mxGeometry x="${Math.round(g.x)}" y="${Math.round(g.y)}" width="${Math.round(g.w)}" height="${Math.round(g.h)}" as="geometry"/>`;
    const auto = `${Math.round(g.x)},${Math.round(g.y)},${Math.round(g.w)},${Math.round(g.h)}`;
    if (c.meta?.group) {
      cells.push(
        `<object id="${esc(c.id)}" label="${esc(c.meta.label)}" aiviz_type="group" aiviz_auto="${auto}">` +
          `<mxCell style="${esc(theme.groupStyle())}" vertex="1" parent="${esc(pid(c.id))}">${geom}</mxCell></object>`,
      );
    } else {
      const n = c.meta;
      const k = theme.kinds[n.kind] ?? {};
      const label = k.shape === 'dot' || k.shape === 'enddot' ? '' : theme.nodeLabel(n.label ?? n.id, n.tech);
      cells.push(
        `<object id="${esc(n.id)}" label="${esc(label)}" aiviz_kind="${esc(n.kind)}"${n.tech ? ` aiviz_tech="${esc(n.tech)}"` : ''} aiviz_auto="${auto}">` +
          `<mxCell style="${esc(theme.nodeStyle(n.kind))}" vertex="1" parent="${esc(pid(c.id))}">${geom}</mxCell></object>`,
      );
    }
  }

  const laidEdges = Object.fromEntries((laid.edges ?? []).map((e) => [e.id, e]));
  for (const e of edges) {
    const le = laidEdges[e.id];
    const sec = le?.sections?.[0];
    let style = theme.edgeStyle(e);
    let pts = '';
    let labelX = 0;
    if (sec) {
      const s = abs[e.from], t = abs[e.to];
      const c01 = (v) => Math.min(1, Math.max(0, +v.toFixed(3)));
      style +=
        `exitX=${c01((sec.startPoint.x - s.x) / s.w)};exitY=${c01((sec.startPoint.y - s.y) / s.h)};exitDx=0;exitDy=0;` +
        `entryX=${c01((sec.endPoint.x - t.x) / t.w)};entryY=${c01((sec.endPoint.y - t.y) / t.h)};entryDx=0;entryDy=0;`;
      if (waypoints && sec.bendPoints?.length)
        pts = `<Array as="points">${sec.bendPoints.map((p) => `<mxPoint x="${Math.round(p.x)}" y="${Math.round(p.y)}"/>`).join('')}</Array>`;
      const lab = le.labels?.[0];
      if (lab && e.label) labelX = labelFraction([sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint], { x: lab.x + lab.width / 2, y: lab.y + lab.height / 2 });
    }
    cells.push(
      `<object id="${esc(e.id)}" label="${esc(e.label)}" aiviz_edge="${esc(`${e.from}->${e.to}`)}">` +
        `<mxCell style="${esc(style)}" edge="1" parent="1" source="${esc(e.from)}" target="${esc(e.to)}">` +
        `<mxGeometry ${labelX ? `x="${labelX.toFixed(3)}" ` : ''}relative="1" as="geometry">${pts}</mxGeometry></mxCell></object>`,
    );
  }
  return wrap(name, cells);
}

// draw.io places edge labels by relative position along the path (-1..1).
// Project ELK's label centre onto the route and convert.
function labelFraction(pts, c) {
  let total = 0, best = { d: Infinity, at: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const t = len ? Math.max(0, Math.min(1, ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / (len * len))) : 0;
    const px = a.x + t * (b.x - a.x), py = a.y + t * (b.y - a.y);
    const d = Math.hypot(c.x - px, c.y - py);
    if (d < best.d) best = { d, at: total + t * len };
    total += len;
  }
  return total ? (best.at / total) * 2 - 1 : 0;
}

export function wrap(name, cells) {
  return (
    `<mxfile host="aiviz" agent="aiviz-spike"><diagram id="aiviz" name="${esc(name)}">` +
    `<mxGraphModel grid="1" gridSize="8" guides="1" page="0" background="#FFFFFF"><root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
    cells.join('') +
    `</root></mxGraphModel></diagram></mxfile>`
  );
}
