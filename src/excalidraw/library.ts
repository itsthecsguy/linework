// An Excalidraw library (.excalidrawlib) of linework's own shapes: each cloud
// icon as a ready node, or each node kind in a chosen style. Dragged into a
// drawing that came from linework, an item is read back by `import` as a node
// of that kind with that icon, not as an anonymous box.
//
// Items are cut out of real diagrams, so they look exactly like the nodes around
// them. Library files can't hold images, so icons are drawn as shapes.
import { PROVIDERS, resolveIcon, type Provider } from '../drawio/icons.js';
import { readDrawio } from '../drawio/read.js';
import { toMxfile } from '../drawio/write.js';
import { layout } from '../layout/layout.js';
import type { DrawioBrowser } from '../render/browser.js';
import { KINDS, THEMES, type ThemeName } from '../spec/model.js';
import { humanize, parseSpecText } from '../spec/parse.js';
import { toExcalidraw, type ExcalidrawElement, type Origin } from './export.js';

export interface LibraryItem {
  id: string;
  status: 'published';
  created: number;
  name: string;
  elements: ExcalidrawElement[];
}

export interface Library {
  type: 'excalidrawlib';
  version: 2;
  source: string;
  libraryItems: LibraryItem[];
}

export const LIBRARY_SETS = ['shapes', ...Object.keys(PROVIDERS)] as const;

interface Want {
  name: string;
  type: 'architecture' | 'flow' | 'state';
  kind: string;
  label: string;
  icon?: string;
}

const q = (s: string) => JSON.stringify(s);

async function itemsFor(wants: Want[], theme: ThemeName, b: DrawioBrowser, prefix: string): Promise<LibraryItem[]> {
  const out: LibraryItem[] = [];
  const types = [...new Set(wants.map((w) => w.type))];
  for (const type of types) {
    const all = wants.filter((w) => w.type === type);
    // A few dozen at a time keeps each layout quick.
    for (let from = 0; from < all.length; from += 40) {
      const batch = all.slice(from, from + 40);
      const spec = `type: ${type}\ntheme: ${theme}\nnodes:\n` + batch.map((w, i) => `  n${i}: { label: ${q(w.label)}, kind: ${w.kind}${w.icon ? `, icon: ${w.icon}` : ''} }`).join('\n') + '\n';
      const { diagram } = parseSpecText(spec);
      const measure = (r: Array<[string, number, number, string?]>) => b.measure(r);
      const scene = await toExcalidraw(readDrawio(toMxfile(diagram, await layout(diagram, measure))), b, { icons: 'vector' });
      batch.forEach((w, i) => {
        const mine = scene.elements.filter((e) => {
          const cell = (e.customData as { lw: Origin }).lw.cell;
          return cell === `n${i}` || cell === `n${i}__icon`;
        });
        // An icon draw.io has no stencil for leaves a plain box: not worth a place in the library.
        if (!mine.length || (w.icon && !mine.some((e) => (e.customData as { lw: Origin }).lw.cell === `n${i}__icon`))) return;
        const n = out.length;
        const id = (old: string) => `${prefix}${n}-${mine.findIndex((e) => e.id === old)}`;
        const has = new Set(mine.map((e) => e.id));
        const x0 = Math.min(...mine.map((e) => e.x)), y0 = Math.min(...mine.map((e) => e.y));
        const elements = mine.map((e): ExcalidrawElement => {
          const part = (e.customData as { lw: Origin }).lw.part;
          const iconPart = (e.customData as { lw: Origin }).lw.cell.endsWith('__icon');
          return {
            ...e,
            id: id(e.id),
            x: Math.round((e.x - x0) * 100) / 100,
            y: Math.round((e.y - y0) * 100) / 100,
            // One group for the node, and inside it one for the icon's shapes.
            groupIds: [...(iconPart ? [`${prefix}${n}-icon`] : []), `${prefix}${n}-g`],
            boundElements: e.boundElements.filter((x) => has.has(x.id)).map((x) => ({ ...x, id: id(x.id) })),
            ...(typeof e.containerId === 'string' ? { containerId: has.has(e.containerId) ? id(e.containerId) : null } : {}),
            customData: { lw: { cell: `lib:${w.name}`, part: iconPart ? `icon-${part}` : part, lib: { kind: w.kind, ...(w.icon ? { icon: w.icon } : {}) } } satisfies Origin },
          };
        });
        out.push({ id: `${prefix}${n}`, status: 'published', created: 1, name: w.name, elements });
      });
    }
  }
  return out;
}

/**
 * `set` is 'shapes' (every node kind) or a cloud provider, whose icons to
 * include are listed in `names`.
 */
export async function buildLibrary(set: string, b: DrawioBrowser, opts: { theme?: ThemeName; filters?: string[]; names?: string[] } = {}): Promise<Library> {
  const theme = opts.theme ?? 'clean';
  if (!THEMES.includes(theme)) throw new Error(`unknown style "${theme}". Styles: ${THEMES.join(', ')}`);
  let wants: Want[];
  if (set === 'shapes') {
    const seen = new Set<string>();
    wants = (['architecture', 'flow', 'state'] as const).flatMap((type) =>
      Object.keys(KINDS[type])
        .filter((kind) => !seen.has(kind) && !!seen.add(kind))
        .map((kind): Want => ({ name: kind, type, kind, label: kind === 'start' || kind === 'end' ? '' : humanize(kind) })),
    );
    if (opts.filters?.length) wants = wants.filter((w) => opts.filters!.some((f) => w.name.includes(f)));
  } else if (set in PROVIDERS) {
    wants = (opts.names ?? []).map((name): Want => ({ name: `${set}.${name}`, type: 'architecture', kind: 'service', label: humanize(name), icon: `${set}.${name}` }));
  } else throw new Error(`unknown library "${set}". Choose one of: ${LIBRARY_SETS.join(', ')}`);
  // A name draw.io has no stencil for would come out as an empty box.
  const real: Want[] = [];
  for (const w of wants) {
    const r = w.icon ? resolveIcon(w.icon) : undefined;
    if (!w.icon || (r && !('error' in r) && (await b.hasStencil(r.stencil)))) real.push(w);
  }
  wants = real;
  if (!wants.length) throw new Error(`nothing in "${set}" matches "${(opts.filters ?? []).join(' ')}"`);
  return { type: 'excalidrawlib', version: 2, source: 'https://github.com/itsthecsguy/linework', libraryItems: await itemsFor(wants, theme, b, `lw${set}`) };
}

export type { Provider };
