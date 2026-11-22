// Team rules, checked against a diagram's content instead of its geometry: the
// theme, the names, the colors and the styling a repo's linework.yaml asks for.
// Every message says how to fix what it found.
import type { Config } from '../config.js';
import type { DrawioModel } from '../drawio/read.js';
import type { ShowResult } from '../drawio/show.js';
import { styleFor } from '../drawio/write.js';
import type { Finding } from './check.js';

const ACRONYM = /^[A-Z0-9]{2,}s?$/;
const words = (s: string) => s.split(/\s+/).filter(Boolean);
// A word that carries its own capitals (an acronym, "PostgreSQL", "iOS") says nothing about the label's case.
const plain = (w: string) => /^[A-Za-z][a-z]+$/.test(w);

function caseProblem(label: string, want: 'sentence' | 'title'): string | undefined {
  const ws = words(label);
  // Words after the first that could be either case.
  const rest = ws.slice(1).filter((w) => plain(w) && !ACRONYM.test(w));
  if (want === 'sentence' && rest.length >= 1 && rest.every((w) => /^[A-Z]/.test(w)))
    return `"${label}" is in title case; this repo uses sentence case: "${[ws[0], ...ws.slice(1).map((w) => (plain(w) ? w.toLowerCase() : w))].join(' ')}"`;
  if (want === 'title' && rest.some((w) => /^[a-z]/.test(w) && w.length > 3))
    return `"${label}" is in sentence case; this repo uses title case: "${ws.map((w, i) => (plain(w) && (i === 0 || w.length > 3) ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ')}"`;
  return undefined;
}

const styleMap = (s: string) => Object.fromEntries(s.split(';').filter(Boolean).map((p) => [p.split('=')[0]!, p.slice(p.indexOf('=') + 1)]));

export function conventions(m: DrawioModel, shown: ShowResult, cfg: Config): Finding[] {
  if (!cfg.path) return [];
  const d = shown.diagram;
  const out: Finding[] = [];
  const warn = (rule: string, message: string) => out.push({ level: 'warning', rule, message });

  if (cfg.lockTheme && d.theme !== cfg.theme)
    out.push({ level: 'error', rule: 'off-theme', message: `drawn in theme "${d.theme}", but this repo uses "${cfg.theme}". Run "linework restyle" on the file.` });

  const statusNames = Object.keys(cfg.statuses);
  const items = [
    ...d.nodes.map((n) => ({ what: `"${n.label || n.id}"`, look: n })),
    ...d.groups.map((g) => ({ what: `group "${g.label}"`, look: g })),
    ...d.edges.map((e) => ({ what: `edge ${e.from} -> ${e.to}`, look: e })),
  ];
  if (statusNames.length)
    for (const { what, look } of items)
      if (look.color && !look.status) {
        const match = statusNames.filter((s) => cfg.statuses[s]!.color === look.color);
        warn('raw-color', `${what} is ${look.color} with no meaning attached. ${match.length ? `Write status: ${match.join(' or status: ')} instead of color.` : `This repo's statuses are: ${statusNames.join(', ')}. Use one, or drop the color.`}`);
      }

  for (const n of d.nodes) {
    const c = cfg.components[n.id];
    if (!c) continue;
    const diffs = (['label', 'kind', 'tech', 'icon'] as const).filter((k) => c[k] !== undefined && c[k] !== n[k]).map((k) => `${k} "${n[k] ?? ''}" should be "${c[k]}"`);
    if (diffs.length) warn('component-drift', `"${n.id}" is a shared component and differs from linework.yaml: ${diffs.join(', ')}. Remove those fields from the spec to take the shared ones.`);
  }

  const { case: want, maxLength, banned } = cfg.naming;
  for (const it of [...d.nodes.filter((n) => n.kind !== 'start' && n.kind !== 'end'), ...d.groups]) {
    if (want !== 'any') {
      const p = caseProblem(it.label, want);
      if (p) warn('naming-case', p);
    }
    if (maxLength && it.label.length > maxLength) warn('naming-length', `"${it.label}" is ${it.label.length} characters; this repo's limit is ${maxLength}. Shorten it and move detail to the tech line or the doc.`);
    for (const b of banned)
      if (new RegExp(`(?<!\\w)${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'i').test(it.label))
        warn('naming-banned', `"${it.label}" uses "${b}", which this repo's linework.yaml bans. Name the thing itself.`);
  }

  // Colors or fonts changed in draw.io: the box no longer matches the team's theme.
  for (const [cellId, specId] of shown.idMap) {
    const c = m.byId.get(cellId), n = d.nodes.find((x) => x.id === specId);
    if (!c || !n || !c.attrs.aiviz_kind) continue;
    const want = styleMap(styleFor(d, n));
    const off = ['fillColor', 'strokeColor', 'fontColor', 'fontFamily'].filter((k) => want[k] !== undefined && c.style[k] !== undefined && c.style[k]!.toLowerCase() !== want[k]!.toLowerCase());
    if (off.length) warn('hand-styled', `"${n.label || n.id}" was restyled by hand (${off.join(', ')}) and no longer matches theme "${d.theme}". Run "linework restyle" on the file to reset it, or set rules: { hand-styled: off }.`);
  }
  return out;
}
