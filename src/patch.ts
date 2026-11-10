// One-line changes to an existing diagram: set a field, add or remove a box or
// an edge. Each reads the file's current spec (hand edits included), changes it
// and builds, so the layout merges the same way a show / edit / build round does.
import YAML, { isMap, isScalar, isSeq, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { build, show, type BuildOptions, type BuildResult } from './api.js';

export type PatchOp = { op: 'set'; args: string[] } | { op: 'add'; args: string[] } | { op: 'rm'; args: string[] };

export class PatchError extends Error {}

const TOP = new Set(['title', 'theme', 'accent', 'direction']);
const TEXT = new Set(['label', 'tech', 'title']);
// "from ARROW to" or "from ARROW to: label". ER cardinalities count as arrows too.
const EDGE = /^(\S+)\s+(\S*(?:->|=>|--|\.\.)\S*|<->)\s+([^\s:]+)(?::\s*(.*))?$/;

function mapAt(doc: Document, key: string, create = false): YAMLMap | undefined {
  const m = doc.get(key);
  if (isMap(m)) return m;
  if (!create) return undefined;
  const made = doc.createNode({}) as YAMLMap;
  doc.set(key, made);
  return made;
}

function seqAt(doc: Document, key: string, create = false): YAMLSeq | undefined {
  const s = doc.get(key);
  if (isSeq(s)) return s;
  if (!create) return undefined;
  const made = doc.createNode([]) as YAMLSeq;
  doc.set(key, made);
  return made;
}

const edgeEnds = (item: unknown): { from: string; to: string } | undefined => {
  if (isScalar(item) && typeof item.value === 'string') {
    const m = EDGE.exec(item.value.trim());
    return m ? { from: m[1]!, to: m[3]! } : undefined;
  }
  // Unquoted, "a -> b: label" is a one-pair YAML map whose key is the edge.
  if (isMap(item) && item.items.length === 1 && isScalar(item.items[0]!.key) && typeof item.items[0]!.key.value === 'string') {
    const m = EDGE.exec(item.items[0]!.key.value.trim());
    if (m) return { from: m[1]!, to: m[3]! };
  }
  if (isMap(item) && item.has('from') && item.has('to')) return { from: String(item.get('from')), to: String(item.get('to')) };
  return undefined;
};

/** Apply the ops to a spec's YAML text and return the new text. */
export function patchSpec(yaml: string, ops: PatchOp[]): string {
  const doc = YAML.parseDocument(yaml);
  const sequence = doc.get('type') === 'sequence';
  const nodesKey = sequence ? 'participants' : 'nodes';
  const edgesKey = sequence ? 'messages' : 'edges';
  const has = (key: string, id: string) => !!mapAt(doc, key)?.has(id);
  const known = () => [...(mapAt(doc, nodesKey)?.items ?? []), ...(mapAt(doc, 'groups')?.items ?? [])].map((p) => String(isScalar(p.key) ? p.key.value : p.key)).join(', ');

  for (const { op, args } of ops) {
    if (!args.length) throw new PatchError(`${op} needs at least one argument`);
    for (const arg of args) {
      if (op === 'set') {
        const eq = arg.indexOf('=');
        if (eq < 1) throw new PatchError(`can't read "${arg}". Write it as id.field=value, for example api.label="Checkout API", or theme=dark.`);
        const path = arg.slice(0, eq), raw = arg.slice(eq + 1);
        const dot = path.lastIndexOf('.');
        const field = dot < 0 ? path : path.slice(dot + 1);
        const value = TEXT.has(field) ? raw : (YAML.parse(raw) as unknown);
        if (dot < 0) {
          if (!TOP.has(path)) throw new PatchError(`"${path}" isn't a diagram setting. Settings: title, theme, accent, direction. For a box, write id.field=value.`);
          if (raw === '') doc.delete(path);
          else doc.set(path, value);
          continue;
        }
        const id = path.slice(0, dot);
        const key = has(nodesKey, id) ? nodesKey : has('groups', id) ? 'groups' : undefined;
        if (!key) throw new PatchError(`no box or group named "${id}". There are: ${known()}`);
        const owner = mapAt(doc, key)!;
        const found: unknown = owner.get(id, true);
        let entry: YAMLMap;
        if (isMap(found)) entry = found;
        else {
          // "id: Label" and "id:" are short for a map.
          const label = isScalar(found) && found.value != null ? { label: found.value } : {};
          entry = doc.createNode(label, { flow: true }) as YAMLMap;
          owner.set(id, entry);
        }
        if (raw === '') entry.delete(field);
        else entry.set(field, value);
      } else if (op === 'add') {
        const text = arg.trim();
        if (EDGE.test(text)) {
          seqAt(doc, edgesKey, true)!.add(doc.createNode(text));
          continue;
        }
        const group = /^group\s+/.test(text);
        const parsed = YAML.parse(group ? text.replace(/^group\s+/, '') : text) as unknown;
        const entries = typeof parsed === 'string' ? [[parsed, {}]] : parsed && typeof parsed === 'object' ? Object.entries(parsed) : [];
        if (!entries.length) throw new PatchError(`can't read "${arg}". A box: "fraud: { label: Fraud check, in: vpc }". An edge: "api -> fraud: score". A group: "group vpc: { label: Production VPC }".`);
        const key = group ? 'groups' : nodesKey;
        for (const [id, v] of entries as Array<[string, unknown]>) {
          if (has(nodesKey, id) || has('groups', id)) throw new PatchError(`"${id}" already exists. Use set to change it.`);
          const val = typeof v === 'string' ? { label: v } : (v ?? {});
          mapAt(doc, key, true)!.set(id, doc.createNode(val, { flow: true }));
        }
      } else {
        const text = arg.trim();
        const m = EDGE.exec(text);
        if (m) {
          const list = seqAt(doc, edgesKey);
          const i = list?.items.findIndex((it) => {
            const e = edgeEnds(it);
            return e && e.from === m[1] && e.to === m[3];
          });
          if (!list || i === undefined || i < 0) throw new PatchError(`no edge from "${m[1]}" to "${m[3]}"`);
          list.delete(i);
          continue;
        }
        if (has(nodesKey, text)) {
          mapAt(doc, nodesKey)!.delete(text);
          const list = seqAt(doc, edgesKey);
          if (list)
            for (let i = list.items.length - 1; i >= 0; i--) {
              const e = edgeEnds(list.items[i]);
              if (e && (e.from === text || e.to === text)) list.delete(i);
            }
        } else if (has('groups', text)) {
          // Its members move up to the group it was in, or out to the top level.
          const groups = mapAt(doc, 'groups')!;
          const self = groups.get(text);
          const up = isMap(self) ? self.get('in') : undefined;
          groups.delete(text);
          for (const k of [nodesKey, 'groups'])
            for (const p of mapAt(doc, k)?.items ?? [])
              if (isMap(p.value) && p.value.get('in') === text) {
                if (up) p.value.set('in', up);
                else p.value.delete('in');
              }
          if (!groups.items.length) doc.delete('groups');
        } else throw new PatchError(`no box, group or edge matches "${arg}". There are: ${known()}`);
      }
    }
  }
  return doc.toString({ lineWidth: 0 });
}

/** Change a diagram file in place. The existing layout is kept. */
export async function patchFile(file: string, ops: PatchOp[], opts: Omit<BuildOptions, 'out'> = {}): Promise<BuildResult> {
  const yaml = patchSpec(show(file).yaml, ops);
  return build(yaml, { ...opts, out: file });
}
