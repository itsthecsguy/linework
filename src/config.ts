// linework.yaml: one file a team checks in so every diagram in a repo, whoever
// or whatever draws it, uses the same theme, names and rules. Found by walking
// up from the diagram. `extends` pulls in an org-wide config from a file or an
// npm package, and this repo's settings win where both set something.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import YAML from 'yaml';
import { z } from 'zod';
import { COLORS, DIAGRAM_TYPES, DIRECTIONS, THEMES, setCustomKinds, type BuiltinTheme, type ColorName, type DiagramType, type Direction, type KindDef, type Shape } from './spec/model.js';
import { contrast, deriveTheme, inkOn, setCustomThemes, type Theme, type ThemeTokens } from './drawio/theme.js';

export const CONFIG_NAMES = ['linework.yaml', 'linework.yml', '.linework.yaml'];
export type Severity = 'off' | 'warn' | 'error';

const hex = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'write colors as hex, like "#1A2B3C"');
const color = z.enum(COLORS);

const ThemeInput = z.strictObject({
  extends: z.enum(THEMES).default('clean'),
  canvas: hex.optional(),
  text: hex.optional(),
  muted: hex.optional(),
  box: hex.optional(),
  border: hex.optional(),
  edge: hex.optional(),
  edgeText: hex.optional(),
  groupFill: hex.optional(),
  groupNested: hex.optional(),
  groupBorder: hex.optional(),
  groupText: hex.optional(),
  accent: z.union([hex, color]).optional(),
  radius: z.number().min(0).max(24).optional(),
  lineWidth: z.number().min(0.5).max(4).optional(),
  font: z
    .strictObject({
      family: z.string().min(1),
      /** Font files, relative to the config. WOFF2, TTF or OTF. */
      regular: z.string(),
      bold: z.string(),
      fallback: z.string().optional(),
      strong: z.number().optional(),
      size: z.strictObject({ label: z.number(), sub: z.number(), edge: z.number(), group: z.number(), field: z.number() }).partial().optional(),
    })
    .optional(),
});

const KindInput = z.strictObject({
  shape: z.enum(['box', 'cylinder', 'pill', 'diamond', 'parallelogram']).default('box'),
  color: z.union([color, z.literal('neutral')]).default('neutral'),
  dashed: z.boolean().optional(),
  icon: z.string().optional(),
  description: z.string().default(''),
});

const ComponentInput = z.strictObject({ label: z.string().optional(), kind: z.string().optional(), tech: z.string().optional(), icon: z.string().optional() });
const StatusInput = z.union([color, z.strictObject({ color, label: z.string().optional() })]);

const ConfigInput = z.strictObject({
  extends: z.string().optional(),
  /** Theme for specs that don't name one. */
  theme: z.string().optional(),
  /** A spec may not pick a different theme. */
  lockTheme: z.boolean().optional(),
  direction: z.enum(DIRECTIONS).optional(),
  /** Folder new diagrams go in, relative to the config. */
  out: z.string().optional(),
  /** Folder of starter specs, relative to the config. */
  templates: z.string().optional(),
  rules: z.record(z.string(), z.enum(['off', 'warn', 'error'])).optional(),
  limits: z.strictObject({ nodes: z.number().int().positive(), width: z.number().positive() }).partial().optional(),
  themes: z.record(z.string(), ThemeInput).optional(),
  kinds: z.partialRecord(z.enum(DIAGRAM_TYPES), z.record(z.string(), KindInput)).optional(),
  components: z.record(z.string(), ComponentInput).optional(),
  statuses: z.record(z.string(), StatusInput).optional(),
  /** Draw a legend for the statuses a diagram uses. */
  legend: z.boolean().optional(),
  naming: z
    .strictObject({ case: z.enum(['sentence', 'title', 'any']), maxLength: z.number().int().positive(), banned: z.array(z.string()) })
    .partial()
    .optional(),
  /** What a build does with colors and fonts someone changed in draw.io. */
  handStyles: z.enum(['keep', 'reset']).optional(),
});
type ConfigInput = z.infer<typeof ConfigInput>;

export interface CustomFont {
  family: string;
  weight: number;
  file: string;
}

export interface Config {
  /** The file it came from; undefined when the repo has none. */
  path?: string;
  theme?: string;
  lockTheme: boolean;
  direction?: Direction;
  out?: string;
  templates?: string;
  rules: Record<string, Severity>;
  limits: { nodes: number; width: number };
  themes: Theme[];
  fonts: CustomFont[];
  kinds: Partial<Record<DiagramType, Record<string, KindDef>>>;
  components: Record<string, { label?: string; kind?: string; tech?: string; icon?: string }>;
  statuses: Record<string, { color: ColorName; label: string }>;
  legend: boolean;
  naming: { case: 'sentence' | 'title' | 'any'; maxLength?: number; banned: string[] };
  handStyles: 'keep' | 'reset';
}

export const NO_CONFIG: Config = {
  lockTheme: false,
  rules: {},
  limits: { nodes: 20, width: 1400 },
  themes: [],
  fonts: [],
  kinds: {},
  components: {},
  statuses: {},
  legend: false,
  naming: { case: 'any', banned: [] },
  handStyles: 'keep',
};

export class ConfigError extends Error {
  constructor(file: string, issues: string[]) {
    super(`${file}:\n${issues.map((i) => `  ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** The config file that governs a path: the nearest one at or above it. */
export function findConfig(from: string): string | undefined {
  let dir = path.resolve(from);
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  for (;;) {
    for (const n of CONFIG_NAMES) {
      const f = path.join(dir, n);
      if (fs.existsSync(f)) return f;
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function readRaw(file: string, seen: string[] = []): ConfigInput & { __dir: string; __fontDirs: Record<string, string> } {
  if (seen.includes(file)) throw new ConfigError(file, [`extends loops back on itself: ${[...seen, file].join(' -> ')}`]);
  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (e) {
    throw new ConfigError(file, [`can't read it: ${(e as Error).message}`]);
  }
  const res = ConfigInput.safeParse(doc);
  if (!res.success) throw new ConfigError(file, res.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`));
  const own = res.data;
  const dir = path.dirname(file);
  // Font paths are relative to the file that names them, even when inherited.
  const fontDirs = Object.fromEntries(Object.keys(own.themes ?? {}).map((n) => [n, dir]));
  if (!own.extends) return { ...own, __dir: dir, __fontDirs: fontDirs };
  let parentFile: string;
  if (own.extends.startsWith('.') || path.isAbsolute(own.extends)) parentFile = path.resolve(dir, own.extends);
  else {
    const req = createRequire(path.join(dir, 'noop.js'));
    try {
      parentFile = req.resolve(`${own.extends}/linework.yaml`);
    } catch {
      try {
        parentFile = req.resolve(own.extends);
      } catch {
        throw new ConfigError(file, [`extends: can't find "${own.extends}". Install the package, or give a path starting with ./`]);
      }
    }
  }
  if (!fs.existsSync(parentFile)) throw new ConfigError(file, [`extends: ${parentFile} doesn't exist`]);
  const base = readRaw(parentFile, [...seen, file]);
  const maps = <K extends 'rules' | 'themes' | 'components' | 'statuses'>(k: K) => ({ ...base[k], ...own[k] }) as ConfigInput[K];
  const kinds: ConfigInput['kinds'] = {};
  for (const t of DIAGRAM_TYPES) if (base.kinds?.[t] || own.kinds?.[t]) kinds[t] = { ...base.kinds?.[t], ...own.kinds?.[t] };
  return {
    ...base,
    ...own,
    rules: maps('rules'),
    themes: maps('themes'),
    components: maps('components'),
    statuses: maps('statuses'),
    kinds,
    limits: { ...base.limits, ...own.limits },
    naming: { ...base.naming, ...own.naming },
    // Folders are relative to the file that set them.
    out: own.out ? path.resolve(dir, own.out) : base.out,
    templates: own.templates ? path.resolve(dir, own.templates) : base.templates,
    __dir: dir,
    __fontDirs: { ...base.__fontDirs, ...fontDirs },
  };
}

const humanize = (id: string) => id.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Read and check a config file. Throws ConfigError with every problem found. */
export function loadConfig(file: string): Config {
  const raw = readRaw(file);
  const issues: string[] = [];
  const themes: Theme[] = [];
  const fonts: CustomFont[] = [];
  for (const [name, def] of Object.entries(raw.themes ?? {})) {
    if ((THEMES as readonly string[]).includes(name)) {
      issues.push(`themes.${name}: "${name}" is a built-in theme. Give yours another name and set extends: ${name}.`);
      continue;
    }
    const { extends: base, font, ...tokens } = def;
    const k: ThemeTokens = { ...tokens };
    if (font) {
      const strong = font.strong ?? 600;
      k.font = { family: font.family, fallback: font.fallback, strong, size: font.size };
      for (const [weight, rel] of [[400, font.regular], [strong, font.bold]] as const) {
        const f = path.resolve(raw.__fontDirs[name] ?? raw.__dir, rel);
        if (!fs.existsSync(f)) issues.push(`themes.${name}.font: ${f} doesn't exist`);
        else fonts.push({ family: font.family, weight, file: f });
      }
    }
    const t = deriveTheme(name, base as BuiltinTheme, k);
    issues.push(...contrastIssues(name, t));
    themes.push(t);
  }
  const names = new Set<string>([...THEMES, ...themes.map((t) => t.name)]);
  if (raw.theme && !names.has(raw.theme)) issues.push(`theme: "${raw.theme}" isn't a theme. Use one of: ${[...names].join(', ')}.`);
  if (raw.lockTheme && !raw.theme) issues.push('lockTheme needs theme: set the one theme every diagram uses');

  const kinds: Config['kinds'] = {};
  for (const t of DIAGRAM_TYPES) {
    for (const [k, def] of Object.entries(raw.kinds?.[t] ?? {})) {
      if (!/^[A-Za-z_][\w-]*$/.test(k)) issues.push(`kinds.${t}.${k}: kind names use letters, digits, _ and -`);
      const flowOnly = def.shape === 'diamond' || def.shape === 'parallelogram';
      if (flowOnly && t !== 'flow') issues.push(`kinds.${t}.${k}: shape ${def.shape} is for flow diagrams`);
      if (t === 'er' || t === 'sequence') issues.push(`kinds.${t}: custom kinds are for architecture, flow and state diagrams`);
      (kinds[t] ??= {})[k] = { shape: def.shape as Shape, color: def.color, dashed: def.dashed, icon: def.icon, description: def.description || 'defined in linework.yaml' };
    }
  }
  const statuses: Config['statuses'] = {};
  for (const [name, s] of Object.entries(raw.statuses ?? {})) statuses[name] = typeof s === 'string' ? { color: s, label: humanize(name) } : { color: s.color, label: s.label ?? humanize(name) };

  if (issues.length) throw new ConfigError(file, issues);
  return {
    path: file,
    theme: raw.theme,
    lockTheme: !!raw.lockTheme,
    direction: raw.direction,
    out: raw.out && path.resolve(raw.__dir, raw.out),
    templates: raw.templates && path.resolve(raw.__dir, raw.templates),
    rules: raw.rules ?? {},
    limits: { ...NO_CONFIG.limits, ...raw.limits },
    themes,
    fonts,
    kinds,
    components: raw.components ?? {},
    statuses,
    legend: !!raw.legend,
    naming: { case: raw.naming?.case ?? 'any', maxLength: raw.naming?.maxLength, banned: raw.naming?.banned ?? [] },
    handStyles: raw.handStyles ?? 'keep',
  };
}

/** Text a team's theme would make hard to read: under 4.5:1 against what it sits on. */
function contrastIssues(name: string, t: Theme): string[] {
  const out: string[] = [];
  const box = t.paint('neutral', false);
  const hi = t.paint('neutral', true);
  const opaque = (c: string, under: string) => (c.startsWith('#') ? c : under);
  const pairs: Array<[string, string, string]> = [
    ['text on a box', box.text, opaque(box.fill, t.canvas)],
    ['the second line on a box', box.sub, opaque(box.fill, t.canvas)],
    ['edge labels on the canvas', t.edgeText, t.canvas],
    ['group titles on a group', t.group.text, opaque(t.group.fill, t.canvas)],
    ['text on a highlighted box', hi.text, opaque(hi.fill, t.canvas)],
  ];
  for (const [what, fg, bg] of pairs) {
    if (!fg.startsWith('#') || !bg.startsWith('#')) continue;
    const r = contrast(fg, bg);
    if (r < 4.5) out.push(`themes.${name}: ${what} is ${fg} on ${bg}, a contrast of ${r.toFixed(1)}:1. It needs 4.5:1 to stay readable; ${inkOn(bg)} would pass.`);
  }
  return out;
}

let active: Config = NO_CONFIG;

/** The config the current build, lint or show runs under. */
export const activeConfig = (): Config => active;

/** Put a config in force: its kinds and themes become known to the parser and writer. */
export function useConfig(cfg: Config = NO_CONFIG): Config {
  active = cfg;
  setCustomKinds(cfg.kinds);
  setCustomThemes(cfg.themes);
  return cfg;
}

/** Find, load and put in force the config that governs a file or folder. */
export function useConfigFor(target: string): Config {
  const file = process.env.LINEWORK_NO_CONFIG ? undefined : findConfig(target);
  return useConfig(file ? loadConfig(file) : NO_CONFIG);
}

/** A rule's level after the team's overrides. */
export function severity(rule: string, fallback: Severity): Severity {
  return active.rules[rule] ?? fallback;
}
