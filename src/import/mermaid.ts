// Mermaid -> aiviz Diagram. Covers the subset people actually use in design docs:
// flowchart/graph, stateDiagram(-v2), sequenceDiagram and erDiagram. Styling
// directives (classDef, style, linkStyle, click) are dropped with a warning.
import { humanize } from '../spec/parse.js';
import type { Card, Diagram, EdgeStyle, FrameOp, Group, MessageStyle, Node, SeqItem } from '../spec/model.js';

export interface ImportResult {
  diagram: Diagram;
  warnings: string[];
}

export function importMermaid(src: string): ImportResult {
  const lines = src
    .replace(/^---[\s\S]*?\n---\s*\n/, '') // front matter
    .split('\n')
    .map((l) => l.replace(/%%.*$/, '').trimEnd())
    .filter((l) => l.trim());
  const head = (lines[0] ?? '').trim();
  if (/^(flowchart|graph)\b/i.test(head)) return flowchart(lines);
  if (/^stateDiagram(-v2)?\b/.test(head)) return stateDiagram(lines);
  if (/^sequenceDiagram\b/.test(head)) return sequenceDiagram(lines);
  if (/^erDiagram\b/.test(head)) return erDiagram(lines);
  throw new Error(`unsupported Mermaid diagram "${head.split(/\s/)[0]}". aiviz imports flowchart/graph, stateDiagram, sequenceDiagram and erDiagram.`);
}

/** Pull ```mermaid blocks out of a Markdown document. */
export function mermaidBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]!);
}

const clean = (s: string) =>
  s
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^`(.*)`$/s, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/&quot;/g, '"')
    .replace(/#quot;/g, '"')
    .trim();

const brSplit = (s: string) => clean(s).split(/<br\s*\/?>|\\n/i).map((x) => x.replace(/<[^>]+>/g, '').trim()).filter(Boolean);

function safeId(raw: string, used: Set<string>, prefer?: string): string {
  let id = (prefer ?? raw).replace(/[^\w.-]+/g, '_').replace(/^[^A-Za-z_]+/, '');
  if (!id) id = 'n';
  const base = id;
  let k = 2;
  while (used.has(id)) id = `${base}_${k++}`;
  used.add(id);
  return id;
}

// ---------- flowchart ----------

const SHAPES: Array<[string, string, string]> = [
  ['(((', ')))', 'circle'],
  ['([', '])', 'stadium'],
  ['[(', ')]', 'cylinder'],
  ['[[', ']]', 'subroutine'],
  ['((', '))', 'circle'],
  ['{{', '}}', 'hexagon'],
  ['[/', '/]', 'para'],
  ['[\\', '\\]', 'para'],
  ['[/', '\\]', 'trap'],
  ['[\\', '/]', 'trap'],
  ['[', ']', 'rect'],
  ['(', ')', 'round'],
  ['{', '}', 'diamond'],
  ['>', ']', 'flag'],
];

interface FNode { id: string; text?: string; shape?: string }

function flowchart(lines: string[]): ImportResult {
  const warnings = new Set<string>();
  const dirTok = /^(?:flowchart|graph)\s+(TD|TB|BT|RL|LR)/i.exec(lines[0]!.trim())?.[1]?.toUpperCase();
  const direction = dirTok === 'TD' ? 'TB' : ((dirTok as Diagram['direction']) ?? 'auto');
  const nodes = new Map<string, FNode & { group?: string }>();
  const order: string[] = [];
  const edges: Array<{ from: string; to: string; label?: string; style: EdgeStyle; highlight?: boolean }> = [];
  const groups: Array<{ raw: string; label: string; parent?: string }> = [];
  const stack: string[] = [];

  const touch = (n: FNode) => {
    const cur = nodes.get(n.id);
    if (!cur) {
      nodes.set(n.id, { ...n, group: stack[stack.length - 1] });
      order.push(n.id);
    } else {
      if (n.text != null) cur.text = n.text;
      if (n.shape) cur.shape = n.shape;
      // Mermaid puts a node in the subgraph that mentions it, even if it was used earlier.
      if (!cur.group && stack.length) cur.group = stack[stack.length - 1];
    }
  };

  for (const raw of lines.slice(1)) {
    for (const stmt of splitStatements(raw.trim())) {
      if (!stmt) continue;
      let m: RegExpExecArray | null;
      if ((m = /^subgraph\s+(.+)$/.exec(stmt))) {
        const body = m[1]!.trim();
        const g = /^([\w.-]+)\s*\[(.*)\]$/.exec(body) ?? /^([\w.-]+)\s+\[(.*)\]$/.exec(body);
        const rawId = g ? g[1]! : body.replace(/^"|"$/g, '');
        const label = g ? clean(g[2]!) : clean(body);
        groups.push({ raw: rawId, label, parent: stack[stack.length - 1] });
        stack.push(rawId);
        continue;
      }
      if (stmt === 'end') {
        stack.pop();
        continue;
      }
      if (/^(classDef|class|style|linkStyle|click|accTitle|accDescr)\b/.test(stmt)) {
        warnings.add('styling directives (classDef, style, click, ...) are dropped; aiviz applies its own theme');
        continue;
      }
      if (/^direction\s+/.test(stmt)) continue;
      parseChain(stmt, touch, edges, warnings);
    }
  }

  // Pick a type: diamonds mean a process; cylinders or subgraphs mean architecture.
  const shapes = [...nodes.values()].map((n) => n.shape);
  const type: Diagram['type'] = shapes.includes('diamond') ? 'flow' : shapes.includes('cylinder') || groups.length ? 'architecture' : 'flow';

  const used = new Set<string>();
  const gid = new Map<string, string>();
  for (const g of groups) gid.set(g.raw, safeId(g.raw, used));
  const nid = new Map<string, string>();
  for (const id of order) nid.set(id, safeId(id, used));

  const outGroups: Group[] = groups.map((g) => ({ id: gid.get(g.raw)!, label: g.label, parent: g.parent ? gid.get(g.parent) : undefined }));
  const outNodes: Node[] = order.map((raw) => {
    const n = nodes.get(raw)!;
    const parts = brSplit(n.text ?? raw);
    const label = parts[0] ?? raw;
    const node: Node = { id: nid.get(raw)!, label, kind: kindFor(type, n.shape, label), parent: n.group ? gid.get(n.group) : undefined };
    if (type === 'architecture' && parts.length > 1) node.tech = parts.slice(1).join(' ');
    else if (parts.length > 1) node.label = parts.join(' ');
    return node;
  });
  const counts = new Map<string, number>();
  const outEdges = edges.map((e) => {
    const from = nid.get(e.from)!, to = nid.get(e.to)!;
    const base = `${from}->${to}`;
    const k = (counts.get(base) ?? 0) + 1;
    counts.set(base, k);
    return { id: k === 1 ? base : `${base}#${k}`, from, to, label: e.label, style: e.style, ...(e.highlight ? { highlight: true } : {}) };
  });
  return { diagram: { type, direction, theme: 'clean', groups: outGroups, nodes: outNodes, edges: outEdges }, warnings: [...warnings] };
}

function splitStatements(line: string): string[] {
  // Split on ';' outside brackets and quotes.
  const out: string[] = [];
  let depth = 0, q = false, cur = '';
  for (const ch of line) {
    if (ch === '"') q = !q;
    if (!q && '[({'.includes(ch)) depth++;
    if (!q && '])}'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === ';' && !q && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const ID_AT = /^[\w.À-￿-]+?(?=\s|$|[\[({>&|]|-->|---|-\.|==|--|<--|<==)/u;

function parseNodeAt(s: string, pos: number): { node: FNode; end: number } | null {
  const rest = s.slice(pos);
  const idm = ID_AT.exec(rest) ?? /^[\w.-]+/.exec(rest);
  if (!idm) return null;
  let end = pos + idm[0].length;
  const node: FNode = { id: idm[0] };
  // new-style shape syntax: A@{ shape: cyl, label: "x" }
  const at = /^@\{([^}]*)\}/.exec(s.slice(end));
  if (at) {
    const lab = /label:\s*"([^"]*)"/.exec(at[1]!);
    const shape = /shape:\s*([\w-]+)/.exec(at[1]!)?.[1];
    node.text = lab?.[1];
    node.shape = shape === 'cyl' || shape === 'database' ? 'cylinder' : shape === 'diam' || shape === 'decision' ? 'diamond' : shape === 'stadium' || shape === 'terminal' ? 'stadium' : 'rect';
    return { node, end: end + at[0].length };
  }
  for (const [open, close, shape] of SHAPES) {
    if (!s.startsWith(open, end)) continue;
    const textStart = end + open.length;
    let i = textStart;
    if (s[i] === '"') {
      const qEnd = s.indexOf('"', i + 1);
      if (qEnd < 0) continue;
      i = qEnd + 1;
    }
    const closeAt = s.indexOf(close, i);
    if (closeAt < 0) continue;
    node.text = s.slice(textStart, closeAt);
    node.shape = shape;
    end = closeAt + close.length;
    break;
  }
  return { node, end };
}

function parseEdgeAt(s: string, pos: number): { style: EdgeStyle; label?: string; end: number; thick?: boolean } | null {
  const rest = s.slice(pos);
  // "-- text -->", "== text ==>", "-. text .->"
  let m = /^\s*(<)?(--|==|-\.)\s+([^>|]+?)\s+(-{2,}|={2,}|\.+-)(>|o|x)?(?=\s|[\w"])/.exec(rest);
  if (m) return { style: styleOf(m[1], m[2]! + m[4]!, m[5]), label: clean(m[3]!), end: pos + m[0].length, thick: m[2] === '==' };
  // "-->", "---", "-.->", "==>", "<-->", "--o", "--x", with optional "|text|"
  m = /^\s*(<)?(-{2,}|={2,}|-\.+-?|\.-+)(>|o|x)?\s*(?:\|([^|]*)\|)?/.exec(rest);
  if (m && /[-=.]/.test(m[2]!) && m[0].trim()) return { style: styleOf(m[1], m[2]!, m[3]), label: m[4] != null ? clean(m[4]) : undefined, end: pos + m[0].length, thick: m[2]!.startsWith('=') };
  return null;
}

function styleOf(back: string | undefined, line: string, head: string | undefined): EdgeStyle {
  const arrow = head === '>' || head === 'x' || head === 'o';
  if (back && arrow) return 'bidir';
  if (!arrow && !back) return 'line';
  if (line.includes('.')) return 'async';
  return 'sync';
}

function parseChain(stmt: string, touch: (n: FNode) => void, edges: Array<{ from: string; to: string; label?: string; style: EdgeStyle; highlight?: boolean }>, warnings: Set<string>) {
  let pos = 0;
  const readGroup = (): string[] | null => {
    const ids: string[] = [];
    for (;;) {
      while (stmt[pos] === ' ') pos++;
      const r = parseNodeAt(stmt, pos);
      if (!r) return ids.length ? ids : null;
      touch(r.node);
      ids.push(r.node.id);
      pos = r.end;
      const amp = /^\s*&\s*/.exec(stmt.slice(pos));
      if (!amp) return ids;
      pos += amp[0].length;
    }
  };
  let left = readGroup();
  if (!left) {
    warnings.add(`skipped a line aiviz couldn't read: "${stmt.slice(0, 60)}"`);
    return;
  }
  for (;;) {
    const e = parseEdgeAt(stmt, pos);
    if (!e) break;
    pos = e.end;
    const right = readGroup();
    if (!right) break;
    // Mermaid's thick links (==>) mark what matters: aiviz's highlight.
    for (const a of left) for (const b of right) edges.push({ from: a, to: b, label: e.label || undefined, style: e.style, ...(e.thick ? { highlight: true } : {}) });
    left = right;
  }
}

function kindFor(type: Diagram['type'], shape: string | undefined, label: string): string {
  if (type === 'flow') {
    if (shape === 'diamond') return 'decision';
    if (shape === 'stadium' || shape === 'circle') return 'terminal';
    if (shape === 'para' || shape === 'cylinder') return 'data';
    if (/\b(error|fail|reject|deny|denied)/i.test(label)) return 'error';
    return 'step';
  }
  if (shape === 'cylinder') return /bucket|s3|blob|storage|lake/i.test(label) ? 'storage' : 'database';
  if (/^(users?|customers?|admins?|shoppers?|operators?|developers?|actors?)$/i.test(label)) return 'person';
  if (/\b(browser|mobile|frontend|front-end|web ?app|spa|cli|ios|android)\b/i.test(label)) return 'client';
  if (/\b(queue|kafka|sqs|pub\/?sub|topic|stream|rabbit|kinesis|nats)\b/i.test(label) || shape === 'stadium') return 'queue';
  if (/\b(redis|cache|memcache|cdn)\b/i.test(label)) return 'cache';
  if (/\b(stripe|twilio|sendgrid|auth0|okta|github|slack|third.party|external)\b/i.test(label)) return 'external';
  return 'service';
}

// ---------- state ----------

function stateDiagram(lines: string[]): ImportResult {
  const warnings = new Set<string>();
  let direction: Diagram['direction'] = 'auto';
  const labels = new Map<string, string>();
  const order: string[] = [];
  const parent = new Map<string, string | undefined>();
  const groups: Array<{ raw: string; parent?: string }> = [];
  const stack: string[] = [];
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  const touch = (id: string) => {
    if (id === '[*]') return;
    if (!order.includes(id)) {
      order.push(id);
      parent.set(id, stack[stack.length - 1]);
    }
  };
  for (const raw of lines.slice(1)) {
    const l = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^direction\s+(LR|TB|RL|BT)/.exec(l))) { if (!stack.length) direction = m[1] as Diagram['direction']; continue; }
    if ((m = /^state\s+"([^"]+)"\s+as\s+([\w.-]+)/.exec(l))) { labels.set(m[2]!, m[1]!); touch(m[2]!); continue; }
    if ((m = /^state\s+([\w.-]+)\s*\{$/.exec(l))) { groups.push({ raw: m[1]!, parent: stack[stack.length - 1] }); stack.push(m[1]!); continue; }
    if ((m = /^state\s+([\w.-]+)\s*<<\w+>>/.exec(l))) { touch(m[1]!); warnings.add('choice/fork/join states become plain states'); continue; }
    if (l === '}') { stack.pop(); continue; }
    if (/^(note|classDef|class|style)\b/.test(l)) { warnings.add('notes and styling in state diagrams are dropped'); continue; }
    if ((m = /^(\[\*\]|[\w.-]+)\s*-->\s*(\[\*\]|[\w.-]+)\s*(?::\s*(.*))?$/.exec(l))) {
      if (stack.length && (m[1] === '[*]' || m[2] === '[*]')) warnings.add('start/end markers inside composite states are dropped');
      if (stack.length && (m[1] === '[*]' || m[2] === '[*]')) { touch(m[1]!); touch(m[2]!); continue; }
      touch(m[1]!);
      touch(m[2]!);
      edges.push({ from: m[1]!, to: m[2]!, label: m[3] ? clean(m[3]) : undefined });
      continue;
    }
    if ((m = /^([\w.-]+)\s*:\s*(.+)$/.exec(l))) { labels.set(m[1]!, clean(m[2]!)); touch(m[1]!); continue; }
    if ((m = /^([\w.-]+)$/.exec(l))) { touch(m[1]!); continue; }
    warnings.add(`skipped a line aiviz couldn't read: "${l.slice(0, 60)}"`);
  }
  const groupIds = new Set(groups.map((g) => g.raw));
  const used = new Set<string>();
  const ids = new Map<string, string>();
  for (const g of groups) ids.set(g.raw, safeId(g.raw, used));
  for (const s of order) if (!groupIds.has(s)) ids.set(s, safeId(s, used));
  const nodes: Node[] = order
    .filter((s) => !groupIds.has(s))
    .map((s) => {
      const label = labels.get(s) ?? (/[a-z][A-Z]/.test(s) ? s.replace(/([a-z])([A-Z])/g, '$1 $2') : humanize(s));
      return { id: ids.get(s)!, label, kind: /fail|error|reject|declin|cancel|abort/i.test(label) ? 'error' : /complete|succe|paid|done|deliver|captur|settled/i.test(label) ? 'success' : 'state', parent: parent.get(s) ? ids.get(parent.get(s)!) : undefined };
    });
  // Edges into a composite state go to its first child instead.
  const firstChild = (g: string) => nodes.find((n) => n.parent === ids.get(g))?.id;
  let startUsed = false;
  const endFor = new Set<string>();
  const counts = new Map<string, number>();
  const outEdges = edges.flatMap((e) => {
    let from = e.from === '[*]' ? '_start' : groupIds.has(e.from) ? firstChild(e.from) : ids.get(e.from);
    let to = e.to === '[*]' ? undefined : groupIds.has(e.to) ? firstChild(e.to) : ids.get(e.to);
    if (!from) return [];
    if (e.from === '[*]') startUsed = true;
    if (e.to === '[*]') {
      endFor.add(from);
      to = `_end_${from === '_start' ? 'start' : from}`;
    }
    if (!to) return [];
    const base = `${from}->${to}`;
    const k = (counts.get(base) ?? 0) + 1;
    counts.set(base, k);
    return [{ id: k === 1 ? base : `${base}#${k}`, from, to, label: e.label, style: 'sync' as EdgeStyle }];
  });
  if (startUsed) nodes.unshift({ id: '_start', label: '', kind: 'start' });
  for (const f of endFor) nodes.push({ id: `_end_${f === '_start' ? 'start' : f}`, label: '', kind: 'end' });
  const outGroups: Group[] = groups.map((g) => ({ id: ids.get(g.raw)!, label: labels.get(g.raw) ?? humanize(g.raw), parent: g.parent ? ids.get(g.parent) : undefined }));
  return { diagram: { type: 'state', direction, theme: 'clean', groups: outGroups, nodes, edges: outEdges }, warnings: [...warnings] };
}

// ---------- sequence ----------

const SEQ_ARROWS: Array<[string, MessageStyle]> = [
  ['-->>', 'reply'],
  ['->>', 'sync'],
  ['--x', 'reply'],
  ['-x', 'sync'],
  ['--)', 'async'],
  ['-)', 'async'],
  ['-->', 'reply'],
  ['->', 'sync'],
];

function sequenceDiagram(lines: string[]): ImportResult {
  const warnings = new Set<string>();
  const parts = new Map<string, Node>();
  const used = new Set<string>();
  const pid = new Map<string, string>();
  const declare = (raw: string, label?: string, kind = 'service') => {
    if (pid.has(raw)) {
      if (label) parts.get(pid.get(raw)!)!.label = label;
      return pid.get(raw)!;
    }
    const id = safeId(raw, used);
    pid.set(raw, id);
    parts.set(id, { id, label: label ?? (raw.length <= 3 ? raw : humanize(raw)), kind: inferParticipant(label ?? raw, kind) });
    return id;
  };
  const root: SeqItem[] = [];
  const stack: Array<{ op: FrameOp | 'rect'; branches: Array<{ when?: string; items: SeqItem[] }> }> = [];
  const cur = () => (stack.length ? stack[stack.length - 1]!.branches[stack[stack.length - 1]!.branches.length - 1]!.items : root);
  for (const raw of lines.slice(1)) {
    const l = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/.exec(l))) { declare(m[2]!, m[3] ? clean(m[3]) : undefined, m[1] === 'actor' ? 'person' : 'service'); continue; }
    if ((m = /^(alt|opt|loop|par|critical|break)\b\s*(.*)$/.exec(l))) { stack.push({ op: m[1] as FrameOp, branches: [{ when: m[2] ? clean(m[2]) : undefined, items: [] }] }); continue; }
    if ((m = /^(else|and|option)\b\s*(.*)$/.exec(l))) { stack[stack.length - 1]?.branches.push({ when: m[2] ? clean(m[2]) : undefined, items: [] }); continue; }
    if (/^rect\b/.test(l)) { stack.push({ op: 'rect', branches: [{ items: [] }] }); warnings.add('rect highlights are dropped'); continue; }
    if (l === 'end') {
      const f = stack.pop();
      if (!f) continue;
      if (f.op === 'rect') cur().push(...f.branches[0]!.items);
      else cur().push({ kind: 'frame', op: f.op, branches: f.branches });
      continue;
    }
    if ((m = /^note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(l))) {
      const over = m[2]!.split(',').map((s) => declare(s.trim()));
      const side = m[1]!.toLowerCase().startsWith('left') ? 'left' : m[1]!.toLowerCase().startsWith('right') ? 'right' : 'over';
      cur().push({ kind: 'note', over, side, text: clean(m[3]!).replace(/<br\s*\/?>/gi, ' ') });
      continue;
    }
    if (/^(activate|deactivate|autonumber|box|end box|title|create|destroy|links?|properties|details)\b/.test(l)) continue;
    let matched = false;
    for (const [tok, style] of SEQ_ARROWS) {
      const i = l.indexOf(tok);
      if (i <= 0) continue;
      const from = l.slice(0, i).trim();
      const after = l.slice(i + tok.length);
      const mm = /^\s*[+-]?\s*([^:]+?)\s*:\s*(.*)$/.exec(after) ?? /^\s*[+-]?\s*(\S+)\s*$/.exec(after);
      if (!mm || !from) continue;
      cur().push({ kind: 'msg', from: declare(from), to: declare(mm[1]!.trim()), label: mm[2] ? clean(mm[2]) : undefined, style });
      matched = true;
      break;
    }
    if (!matched) warnings.add(`skipped a line aiviz couldn't read: "${l.slice(0, 60)}"`);
  }
  return { diagram: { type: 'sequence', direction: 'auto', theme: 'clean', groups: [], nodes: [...parts.values()], edges: [], seq: root }, warnings: [...warnings] };
}

function inferParticipant(label: string, kind: string): string {
  if (kind === 'person') return 'person';
  if (/\b(db|database|postgres|mysql|redis|dynamo|mongo|cache)\b/i.test(label)) return 'database';
  if (/\b(queue|kafka|sqs|topic|bus)\b/i.test(label)) return 'queue';
  if (/\b(browser|client|frontend|web ?app|mobile|ui)\b/i.test(label)) return 'client';
  if (/\b(stripe|twilio|sendgrid|auth0|okta|github|slack|external|third.party|provider)\b/i.test(label)) return 'external';
  return 'service';
}

// ---------- ER ----------

const L_CARD: Record<string, Card> = { '|o': 'zero_or_one', '||': 'one', '}o': 'many', '}|': 'one_or_many' };
const R_CARD: Record<string, Card> = { 'o|': 'zero_or_one', '||': 'one', 'o{': 'many', '|{': 'one_or_many' };

function erDiagram(lines: string[]): ImportResult {
  const warnings = new Set<string>();
  const ents = new Map<string, Node>();
  const used = new Set<string>();
  const eid = new Map<string, string>();
  const ent = (raw: string) => {
    const name = raw.replace(/^"|"$/g, '');
    if (!eid.has(name)) {
      const id = safeId(name.toLowerCase(), used);
      eid.set(name, id);
      ents.set(id, { id, label: name, kind: 'entity', fields: [] });
    }
    return ents.get(eid.get(name)!)!;
  };
  const edges: Diagram['edges'] = [];
  let open: Node | null = null;
  for (const raw of lines.slice(1)) {
    const l = raw.trim();
    let m: RegExpExecArray | null;
    if (open) {
      if (l === '}') { open = null; continue; }
      if ((m = /^([\w()[\],.-]+)\s+([\w.-]+)((?:\s+(?:PK|FK|UK)\s*,?)*)\s*(?:"[^"]*")?$/i.exec(l))) {
        const flags = (m[3] ?? '').split(/[\s,]+/).filter(Boolean).map((f) => (f.toLowerCase() === 'uk' ? 'unique' : f.toLowerCase()));
        open.fields!.push({ name: m[2]!, type: m[1]!, flags });
      } else warnings.add(`skipped a field line: "${l.slice(0, 60)}"`);
      continue;
    }
    if ((m = /^("?[\w.-]+"?)\s*(?:\["[^"]*"\])?\s*\{$/.exec(l))) { open = ent(m[1]!); continue; }
    if ((m = /^("?[\w.-]+"?)\s+([|}][o|])(--|\.\.)([o|][|{])\s+("?[\w.-]+"?)\s*:\s*(.+)$/.exec(l))) {
      const a = ent(m[1]!), b = ent(m[5]!);
      const base = `${a.id}->${b.id}`;
      const k = edges.filter((e) => e.id.startsWith(base)).length + 1;
      edges.push({ id: k === 1 ? base : `${base}#${k}`, from: a.id, to: b.id, label: clean(m[6]!) || undefined, style: 'line', card: { from: L_CARD[m[2]!]!, to: R_CARD[m[4]!]!, identifying: m[3] === '--' } });
      continue;
    }
    if ((m = /^("?[\w.-]+"?)$/.exec(l))) { ent(m[1]!); continue; }
    if (/^(direction|title|classDef|class|style)\b/.test(l)) continue;
    warnings.add(`skipped a line aiviz couldn't read: "${l.slice(0, 60)}"`);
  }
  // Mermaid entity names are often UPPERCASE; show them as written.
  for (const n of ents.values()) if (!n.fields?.length) delete n.fields;
  return { diagram: { type: 'er', direction: 'auto', theme: 'clean', groups: [], nodes: [...ents.values()], edges }, warnings: [...warnings] };
}
