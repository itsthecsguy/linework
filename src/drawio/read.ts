// Read .drawio.svg / .drawio / plain mxfile XML into a flat list of cells.
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';

export interface Cell {
  id: string;
  attrs: Record<string, string>; // attributes of the <object> wrapper (label, aiviz_*), or {value} for plain cells
  label: string;
  style: Record<string, string>;
  styleRaw: string;
  vertex: boolean;
  edge: boolean;
  parent?: string;
  source?: string;
  target?: string;
  geom?: { x: number; y: number; w: number; h: number; points: Array<{ x: number; y: number }> };
  /** The cell's XML exactly as stored (object wrapper included), for carrying it over unchanged. */
  raw: string;
  /** The <mxGeometry> element's XML, for keeping hand-tuned edge routes and label positions. */
  geomRaw?: string;
}

export interface DrawioModel {
  /** The full mxfile XML (decompressed), for re-rendering. */
  xml: string;
  cells: Cell[];
  byId: Map<string, Cell>;
  /** Attributes on the root object (id "0"), where linework keeps diagram-level metadata. */
  meta: Record<string, string>;
  /** Name of the first page. */
  name: string;
}

export function extractMxfile(text: string): string {
  const t = text.trimStart();
  if (t.startsWith('<mxfile') || t.startsWith('<mxGraphModel')) return text;
  if (t.startsWith('<?xml') || t.startsWith('<svg') || t.startsWith('<!DOCTYPE')) {
    const m = /<svg\b[^>]*\scontent="([^"]*)"/s.exec(text);
    if (!m) throw new Error('this SVG has no embedded draw.io diagram (no content attribute). Was it exported without "include a copy of my diagram"?');
    return decodeEntities(m[1]!);
  }
  throw new Error('not a draw.io file: expected .drawio.svg, .drawio or mxfile XML');
}

function decodeEntities(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** draw.io stores pages compressed by default: base64(deflateRaw(encodeURIComponent(xml))). */
export function inflatePage(data: string): string {
  const buf = zlib.inflateRawSync(Buffer.from(data.trim(), 'base64'));
  return decodeURIComponent(buf.toString('utf8'));
}

export function readDrawio(text: string): DrawioModel {
  let xml = extractMxfile(text);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  let modelEl: Element | null = null;
  let name = 'Page-1';
  const rootEl = doc.documentElement!;
  if (rootEl.nodeName === 'mxGraphModel') modelEl = rootEl;
  else {
    const diagrams = rootEl.getElementsByTagName('diagram');
    if (diagrams.length === 0) throw new Error('mxfile has no <diagram>');
    if (diagrams.length > 1) process.emitWarning?.('linework: file has several pages; only the first is used');
    const diag = diagrams[0]!;
    name = diag.getAttribute('name') ?? name;
    const inner = diag.getElementsByTagName('mxGraphModel')[0];
    if (inner) modelEl = inner;
    else {
      const pageXml = inflatePage(diag.textContent ?? '');
      modelEl = new DOMParser().parseFromString(pageXml, 'text/xml').documentElement!;
      // Normalise to an uncompressed mxfile so downstream tools can read it.
      xml = `<mxfile><diagram id="${diag.getAttribute('id') ?? 'p1'}" name="${(diag.getAttribute('name') ?? 'Page-1').replace(/"/g, '&quot;')}">${pageXml}</diagram></mxfile>`;
    }
  }
  const root = modelEl.getElementsByTagName('root')[0];
  if (!root) throw new Error('mxGraphModel has no <root>');

  const cells: Cell[] = [];
  const ser = new XMLSerializer();
  let meta: Record<string, string> = {};
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    let attrs: Record<string, string> = {};
    let cellEl: Element = el;
    if (el.nodeName === 'object' || el.nodeName === 'UserObject') {
      attrs = attrMap(el);
      const inner = firstChildEl(el, 'mxCell');
      if (!inner) continue;
      cellEl = inner;
    } else if (el.nodeName !== 'mxCell') continue;
    const c = attrMap(cellEl);
    const id = attrs.id ?? c.id;
    if (id == null) continue;
    if (id === '0') {
      meta = attrs;
      continue;
    }
    const label = attrs.label ?? c.value ?? '';
    const styleRaw = c.style ?? '';
    const g = firstChildEl(cellEl, 'mxGeometry');
    let geom: Cell['geom'];
    if (g) {
      const ga = attrMap(g);
      const arr = firstChildEl(g, 'Array');
      const points: Array<{ x: number; y: number }> = [];
      if (arr) for (let p = arr.firstChild; p; p = p.nextSibling) if (p.nodeType === 1) {
        const pa = attrMap(p as Element);
        points.push({ x: +(pa.x ?? 0), y: +(pa.y ?? 0) });
      }
      geom = { x: +(ga.x ?? 0), y: +(ga.y ?? 0), w: +(ga.width ?? 0), h: +(ga.height ?? 0), points };
    }
    cells.push({
      raw: ser.serializeToString(el),
      geomRaw: g ? ser.serializeToString(g) : undefined,
      id,
      attrs: Object.keys(attrs).length ? attrs : { value: label },
      label,
      style: parseStyle(styleRaw),
      styleRaw,
      vertex: c.vertex === '1',
      edge: c.edge === '1',
      parent: c.parent,
      source: c.source,
      target: c.target,
      geom,
    });
  }
  return { xml, cells, byId: new Map(cells.map((c) => [c.id, c])), meta, name };
}

export function parseStyle(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) out[part] = '1'; // bare names like "ellipse" or "rhombus"
    else out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function attrMap(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    out[a.name] = a.value;
  }
  return out;
}

function firstChildEl(el: Element, name: string): Element | null {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.nodeName === name) return n as Element;
  return null;
}

/** Visible text lines of an HTML label. */
export function labelLines(html: string): string[] {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Absolute box of a vertex, summing the offsets of the groups it sits in. */
export function absBox(m: DrawioModel, id: string): { x: number; y: number; w: number; h: number } | undefined {
  const c = m.byId.get(id);
  if (!c?.geom) return undefined;
  let { x, y } = c.geom;
  for (let p = c.parent ? m.byId.get(c.parent) : undefined; p?.geom && p.vertex; p = p.parent ? m.byId.get(p.parent) : undefined) {
    x += p.geom.x;
    y += p.geom.y;
  }
  return { x, y, w: c.geom.w, h: c.geom.h };
}

/** Short fingerprint of a diagram's content; `show` stamps it so `build` can tell a stale spec. */
export function fingerprint(m: DrawioModel): string {
  return createHash('sha1').update(m.cells.map((c) => c.raw).join('')).digest('hex').slice(0, 12);
}

const BASE_RE = /^#\s*(?:linework|aiviz)-base:\s*([0-9a-f]{6,40})/m;
export function specBase(specText: string): string | undefined {
  return BASE_RE.exec(specText)?.[1];
}
