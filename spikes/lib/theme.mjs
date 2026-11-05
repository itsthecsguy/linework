// Candidate "clean" theme. Everything here becomes draw.io style strings,
// so a human editing in draw.io sees normal, editable styles.

export const font = {
  family: 'Inter',
  source: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600',
  label: 13,
  sub: 11,
  edge: 11,
};

export const ink = {
  text: '#0F172A',
  muted: '#64748B',
  edge: '#64748B',
  edgeText: '#475569',
  canvas: '#FFFFFF',
};

// One hue family per kind. fill is a very light tint, stroke is the mid tone.
export const kinds = {
  person:   { fill: '#FDF4FF', stroke: '#C026D3', shape: 'person' },
  client:   { fill: '#F0F9FF', stroke: '#0284C7', shape: 'box' },
  service:  { fill: '#EEF2FF', stroke: '#4F46E5', shape: 'box' },
  function: { fill: '#EEF2FF', stroke: '#4F46E5', shape: 'box', dashed: true },
  database: { fill: '#ECFDF5', stroke: '#059669', shape: 'cylinder' },
  cache:    { fill: '#ECFDF5', stroke: '#059669', shape: 'box' },
  storage:  { fill: '#ECFDF5', stroke: '#059669', shape: 'cylinder' },
  queue:    { fill: '#FFF7ED', stroke: '#D97706', shape: 'pill' },
  topic:    { fill: '#FFF7ED', stroke: '#D97706', shape: 'pill' },
  external: { fill: '#F8FAFC', stroke: '#94A3B8', shape: 'box', dashed: true },
  // flow + state kinds
  step:     { fill: '#FFFFFF', stroke: '#94A3B8', shape: 'box' },
  decision: { fill: '#FFFBEB', stroke: '#D97706', shape: 'diamond' },
  terminal: { fill: '#F1F5F9', stroke: '#475569', shape: 'pill' },
  state:    { fill: '#EEF2FF', stroke: '#4F46E5', shape: 'box' },
  final:    { fill: '#ECFDF5', stroke: '#059669', shape: 'box' },
  error:    { fill: '#FEF2F2', stroke: '#DC2626', shape: 'box' },
  start:    { fill: '#334155', stroke: '#334155', shape: 'dot' },
  end:      { fill: '#334155', stroke: '#334155', shape: 'enddot' },
};

const fontStyle = () =>
  `fontFamily=${font.family};fontSource=${encodeURIComponent(font.source)};fontColor=${ink.text};`;

export function nodeStyle(kind) {
  const k = kinds[kind] ?? kinds.service;
  const base =
    `html=1;whiteSpace=wrap;${fontStyle()}fontSize=${font.label};` +
    `fillColor=${k.fill};strokeColor=${k.stroke};strokeWidth=1.5;` +
    (k.dashed ? 'dashed=1;dashPattern=6 4;' : '');
  switch (k.shape) {
    case 'cylinder':
      return `shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=8;${base}`;
    case 'pill':
      return `rounded=1;arcSize=50;${base}`;
    case 'diamond':
      return `rhombus;${base}`;
    case 'person':
      return `rounded=1;absoluteArcSize=1;arcSize=16;${base}`;
    case 'dot':
      return `ellipse;aspect=fixed;${base}`;
    case 'enddot':
      return `ellipse;shape=doubleEllipse;aspect=fixed;margin=4;${base}fillColor=${k.fill};`;
    default:
      return `rounded=1;absoluteArcSize=1;arcSize=16;${base}`;
  }
}

export function groupStyle() {
  return (
    `rounded=1;absoluteArcSize=1;arcSize=20;html=1;whiteSpace=wrap;container=1;collapsible=0;` +
    `fillColor=#F8FAFC;strokeColor=#CBD5E1;strokeWidth=1;dashed=1;dashPattern=4 4;` +
    `verticalAlign=top;align=left;spacingLeft=14;spacingTop=8;` +
    `${fontStyle()}fontSize=${font.sub};fontStyle=1;fontColor=${ink.muted};`
  );
}

export function edgeStyle({ async = false, bidir = false } = {}) {
  return (
    `edgeStyle=orthogonalEdgeStyle;rounded=1;arcSize=12;html=1;` +
    `strokeColor=${ink.edge};strokeWidth=1.5;endArrow=blockThin;endFill=1;endSize=7;` +
    (bidir ? 'startArrow=blockThin;startFill=1;startSize=7;' : 'startArrow=none;') +
    (async ? 'dashed=1;dashPattern=6 4;' : '') +
    `${fontStyle()}fontSize=${font.edge};fontColor=${ink.edgeText};labelBackgroundColor=${ink.canvas};`
  );
}

export function nodeLabel(label, tech) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const main = `<span style="font-weight:600">${esc(label)}</span>`;
  return tech
    ? `${main}<br><span style="font-size:${font.sub}px;color:${ink.muted}">${esc(tech)}</span>`
    : main;
}

// Rough Inter metrics. The real tool should measure in the browser.
export function textWidth(s, size, weight = 400) {
  const avg = weight >= 600 ? 0.6 : 0.56;
  return Math.ceil(String(s).length * size * avg);
}
