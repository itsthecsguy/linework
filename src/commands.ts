// Every command, written against an output sink so the same code runs in the
// CLI process and in the background process that keeps Chromium warm.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CheckResult } from './lint/check.js';
import type { DrawioBrowser } from './render/browser.js';
import type { DiagramType } from './spec/model.js';
import type { SpecError } from './spec/parse.js';

export const USAGE = `linework: AI-written, hand-editable diagrams (YAML spec -> .drawio.svg)

Usage:
  linework build <spec.yaml|-> -o <out.drawio.svg> [--png preview.png] [--relayout]
      Lay out and write the diagram, then lint it. "-" reads the spec from stdin.
      If the file exists and someone edited it by hand, the spec is merged in:
      existing positions stay, new nodes are placed next to their neighbours.
      --relayout throws the existing layout away (hand edits included).
  linework set <file.drawio.svg> <id.field=value | theme=..|title=..|direction=..>...
  linework add <file.drawio.svg> <"id: { label: .., in: .. }" | "a -> b: label" | "group id: { label: .. }">...
  linework rm  <file.drawio.svg> <id | "a -> b">...
      Change a diagram in place, one command per change, no spec file. Everything
      already in the diagram keeps its position, hand edits included.
        linework set d.drawio.svg api.label="Checkout API v2" api.highlight=true
        linework add d.drawio.svg "fraud: { label: Fraud check, in: vpc }" "api -> fraud: score"
        linework rm  d.drawio.svg cache "api -> stripe"
  linework show <file.drawio.svg> [--geometry]
      Print the spec of an existing diagram (including hand edits) as YAML.
      --geometry appends node positions as comments.
  linework render <file.drawio.svg> -o <out.png|out.svg> [--scale 2]
      Render a preview image.
  linework check <file.drawio.svg>
      Lint layout: overlaps, edges through nodes, labels that don't fit.
  linework tidy <file.drawio.svg>
      Reroute edges that check flags as broken (e.g. after moving nodes by hand).
      Nothing else in the file changes.
  linework edit <file.drawio.svg> [--no-open] [--port N]
      Open the diagram in draw.io (bundled, offline) in your browser. Saving in
      the editor writes the file. Stops when you exit the editor or close the tab.
  linework import <file.mmd|doc.md|-> [--block N] [-o out.drawio.svg] [--png p.png]
      Convert a Mermaid diagram (flowchart, state, sequence, ER) to an linework spec.
      Prints the spec, or builds it straight away with -o.
  linework icons <aws|gcp|k8s|azure> [filter]
      List icon names, for "icon: aws.lambda" on architecture nodes.
  linework publish <file.drawio.svg...> [--to DIR] [--pull] [--force]
      Copy diagrams into your Google Drive folder (Google Drive for desktop) so
      draw.io's Google Docs add-on can insert them and refresh them later.
      --pull copies back a diagram someone edited from Docs or Drive.
  linework skill [install <dir>]
      Print where the bundled agent skill is, or copy it to <dir>/linework
      (e.g. .claude/skills, ~/.agents/skills).
  linework mcp [--root DIR]
      Run as an MCP server over stdio, for chat apps and agents without a shell.
      Relative paths resolve against --root (default: the current folder).
  linework git-setup
      Make git diff show .drawio.svg changes as spec changes (this repo only).
  linework kinds [architecture|flow|state]
      List node kinds for each diagram type.
  linework schema
      Print the spec's JSON Schema.

  linework daemon [status|stop]
      Builds after the first reuse a background process that keeps the browser
      running, and take about a fifth of the time. It exits after 5 idle minutes.
      Turn it off with LINEWORK_NO_DAEMON=1 or --no-daemon.

  linework install-browser
      Download the headless Chromium build that matches this version. Needed only
      when no Chrome or Edge is installed, or to run inside an agent's sandbox.
`;



/** Where a command writes, and where it reads a spec piped on stdin from. */
export interface IO {
  out(text: string): void;
  err(text: string): void;
  stdin(): string;
  /** Exit code the command asks for when it finishes without throwing. */
  code: number;
  /** ELK is already warm (the background process), so skip the warm-up layout. */
  warm?: boolean;
}

export const processIO: IO = {
  out: (t) => void process.stdout.write(t),
  err: (t) => void process.stderr.write(t),
  stdin: () => fs.readFileSync(0, 'utf8'),
  get code() {
    return Number(process.exitCode ?? 0);
  },
  set code(c: number) {
    process.exitCode = c;
  },
};

/** A usage error: print the message and exit with this code. */
export class Exit extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

/** Print an error the way the CLI does and return the exit code for it. */
export function report(e: unknown, io: IO = processIO): number {
  if (e instanceof Exit) {
    io.err(e.message + '\n');
    return e.code;
  }
  if ((e as Error)?.constructor?.name === 'PatchError') {
    io.err(`error: ${(e as Error).message}\n`);
    return 2;
  }
  if ((e as Error)?.name === 'SpecError') {
    io.err('spec error:\n');
    for (const i of (e as SpecError).issues) io.err(`  ${i.path ? i.path + ': ' : ''}${i.message}\n`);
    return 1;
  }
  io.err(`error: ${(e as Error)?.message ?? e}\n`);
  return 1;
}

/** Commands that draw, and so need Chromium. */
export function needsBrowser(cmd: string, values: Values): boolean {
  return ['build', 'set', 'add', 'rm', 'render', 'check', 'tidy', 'icons'].includes(cmd) || (cmd === 'import' && !!values.out);
}

/** A small spec with a group, labels and a cycle: enough to exercise ELK's main paths. */
const WARM_SPEC = 'type: architecture\ngroups: { g: G }\nnodes:\n  a: { in: g }\n  b: { in: g }\n  c: {}\nedges:\n  - a -> b: x\n  - b -> c: y\n  - c -> a\n';

export async function warmUp() {
  const [{ parseSpecText }, { layout }] = await Promise.all([import('./spec/parse.js'), import('./layout/layout.js')]);
  await layout(parseSpecText(WARM_SPEC).diagram);
}

export type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

export const OPTIONS = {
  out: { type: 'string', short: 'o' },
  png: { type: 'string' },
  force: { type: 'boolean', default: false },
  relayout: { type: 'boolean', default: false },
  geometry: { type: 'boolean', default: false },
  quiet: { type: 'boolean', short: 'q', default: false },
  block: { type: 'string' },
  scale: { type: 'string' },
  'no-open': { type: 'boolean', default: false },
  port: { type: 'string' },
  'no-daemon': { type: 'boolean', default: false },
  root: { type: 'string' },
  to: { type: 'string' },
  pull: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h' },
} as const;

export async function run(cmd: string, values: Values, positionals: string[], launching: Promise<DrawioBrowser> | undefined, io: IO = processIO) {
  const console = { log: (m = '') => io.out(m + '\n'), error: (m = '') => io.err(m + '\n') };
  const fail: (msg: string) => never = (msg) => {
    throw new Exit(msg, 2);
  };
  const printCheck = async (res: CheckResult) => {
    const { checkLines } = await import('./report.js');
    for (const line of checkLines(res)) console.log(line);
  };
  const browser = async () => {
    // ELK compiles its code on first use. Laying out a tiny graph while Chromium
    // is still starting takes that cost off the real layout.
    if (launching && !io.warm && ['build', 'import', 'set', 'add', 'rm'].includes(cmd)) await warmUp();
    return launching!;
  };
  const { buildLines } = await import('./report.js');
  switch (cmd) {
    case 'build': {
      const src = positionals[0];
      if (!src || !values.out) fail('usage: linework build <spec.yaml|-> -o <out.drawio.svg>');
      const text = src === '-' ? io.stdin() : fs.readFileSync(src, 'utf8');
      const { build } = await import('./api.js');
      // Spec errors first: they shouldn't wait on, or hide behind, a browser problem.
      (await import('./spec/parse.js')).parseSpecText(text);
      const res = await build(text, { out: values.out, png: values.png, force: values.force, relayout: values.relayout, browser: await browser() });
      for (const line of buildLines(res, values.png)) console.log(line);
      return;
    }
    case 'set':
    case 'add':
    case 'rm': {
      const [file, ...args] = positionals;
      if (!file || !args.length) fail(`usage: linework ${cmd} <file.drawio.svg> ${cmd === 'set' ? 'id.field=value...' : cmd === 'add' ? '"id: { label: .. }" | "a -> b: label"...' : 'id | "a -> b"...'}`);
      const { patchFile, patchSpec } = await import('./patch.js');
      const { show } = await import('./api.js');
      // Bad arguments first: they shouldn't wait on, or hide behind, a browser problem.
      (await import('./spec/parse.js')).parseSpecText(patchSpec(show(file).yaml, [{ op: cmd, args }]));
      const res = await patchFile(file, [{ op: cmd, args }], { png: values.png, browser: await browser() });
      for (const line of buildLines(res, values.png)) console.log(line);
      return;
    }
    case 'show': {
      const file = positionals[0] ?? fail('usage: linework show <file.drawio.svg>');
      const { show } = await import('./api.js');
      const res = show(file, { geometry: values.geometry });
      io.out(res.yaml);
      if (values.quiet) return;
      for (const n of res.notes) console.error(`note: ${n}`);
      if (res.edits.length) {
        const moved = res.edits.filter((e) => e.what !== 'added').length;
        const added = res.edits.filter((e) => e.what === 'added').length;
        console.error(`note: edited by hand since the last build (${moved} moved/resized, ${added} added). build keeps those positions and merges your changes in.`);
      }
      return;
    }
    case 'render': {
      const file = positionals[0];
      if (!file || !values.out) fail('usage: linework render <file.drawio.svg> -o <out.png>');
      const { render } = await import('./api.js');
      await render(file, values.out, await browser());
      console.log(`wrote ${values.out}`);
      return;
    }
    case 'check': {
      const file = positionals[0] ?? fail('usage: linework check <file.drawio.svg>');
      const { checkFile } = await import('./api.js');
      const res = await checkFile(file, await browser());
      await printCheck(res);
      if (res.findings.some((f) => f.level === 'error')) io.code = 1;
      return;
    }
    case 'tidy': {
      const file = positionals[0] ?? fail('usage: linework tidy <file.drawio.svg>');
      const { tidy } = await import('./api.js');
      const res = await tidy(file, await browser());
      const did = [res.fixed ? `rerouted ${res.fixed} edge${res.fixed === 1 ? '' : 's'}` : '', res.labels ? `moved ${res.labels} label${res.labels === 1 ? '' : 's'}` : ''].filter(Boolean);
      console.log(did.length ? `${did.join(', ')} in ${file}` : 'nothing to fix');
      await printCheck(res.check);
      return;
    }
    case 'edit': {
      const file = positionals[0] ?? fail('usage: linework edit <file.drawio.svg>');
      const { startEditor, openInBrowser } = await import('./edit/server.js');
      const session = await startEditor(file, { port: values.port ? Number(values.port) : undefined });
      const opened = !values['no-open'] && openInBrowser(session.url);
      console.log(`${opened ? 'opened' : 'open'} ${session.url}`);
      console.log(`editing ${file}. Save in the editor (Ctrl/Cmd+S) to write the file. Exit the editor, close the tab or press Ctrl+C to stop.`);
      process.once('SIGINT', () => void session.close());
      const res = await session.done;
      console.log(res.saves ? `saved ${file} ${res.saves - res.conflicts.length} time(s)` : 'closed without saving');
      for (const c of res.conflicts) console.log(`note: ${file} changed on disk while it was open, so one save went to ${c}`);
      return;
    }
    case 'import': {
      const src = positionals[0] ?? fail('usage: linework import <file.mmd|doc.md|-> [-o out.drawio.svg]');
      const { importMermaid, mermaidBlocks } = await import('./import/mermaid.js');
      const { toYaml } = await import('./drawio/show.js');
      let text = src === '-' ? io.stdin() : fs.readFileSync(src, 'utf8');
      if (/\.(md|markdown|mdx)$/i.test(src)) {
        const blocks = mermaidBlocks(text);
        if (!blocks.length) fail(`${src} has no \`\`\`mermaid blocks`);
        const n = values.block ? Number(values.block) : blocks.length === 1 ? 1 : 0;
        if (!n || !blocks[n - 1]) {
          const first = blocks.map((b, i) => `  ${i + 1}: ${b.split('\n')[0]}`).join('\n');
          fail(`${src} has ${blocks.length} mermaid blocks; pick one with --block N:\n${first}`);
        }
        text = blocks[n - 1]!;
      }
      const res = importMermaid(text);
      for (const w of res.warnings) console.error(`import: ${w}`);
      const yaml = toYaml(res.diagram, 'imported from Mermaid');
      if (!values.out) return void io.out(yaml);
      const { build } = await import('./api.js');
      const built = await build(yaml, { out: values.out, png: values.png, relayout: values.relayout, force: values.force, browser: await browser() });
      console.log(`wrote ${built.out} (${built.check.stats.nodes} nodes, ${built.check.stats.edges} edges, ${built.direction})`);
      await printCheck(built.check);
      return;
    }
    case 'icons': {
      const provider = positionals[0] as 'aws' | 'gcp' | 'k8s' | 'azure' | undefined;
      if (!provider || !['aws', 'gcp', 'k8s', 'azure'].includes(provider)) fail('usage: linework icons <aws|gcp|k8s|azure> [filter]');
      const { listIcons } = await import('./api.js');
      const names = await listIcons(provider, positionals[1], await browser());
      console.log(names.map((n) => `${provider}.${n}`).join('\n') || 'no matches');
      return;
    }
    case 'publish': {
      if (!positionals.length) fail('usage: linework publish <file.drawio.svg...> [--to DIR]');
      const { publish } = await import('./publish.js');
      const items = publish(positionals, { to: values.to, pull: values.pull, force: values.force });
      for (const i of items) {
        if (i.action === 'published') console.log(`published ${path.relative(process.cwd(), i.file)} -> ${i.dest}`);
        else if (i.action === 'unchanged') console.log(`unchanged ${i.dest}`);
        else if (i.action === 'pulled') console.log(`pulled ${i.dest} -> ${path.relative(process.cwd(), i.file)}`);
        else console.log(`skipped ${path.relative(process.cwd(), i.file)}: the Drive copy was edited after the last publish. Run with --pull to take that version, or --force to overwrite it.`);
      }
      if (items.some((i) => i.action === 'published') && !values.pull) {
        console.log('\nNot in the doc yet? In Google Docs: Extensions > draw.io > Insert diagrams, then pick the file.');
        console.log('Already in the doc? After Drive syncs: Extensions > draw.io > Update diagrams.');
      }
      if (items.some((i) => i.action === 'conflict')) io.code = 1;
      return;
    }
    case 'skill': {
      const { fileURLToPath } = await import('node:url');
      const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'linework');
      if (positionals[0] !== 'install') return void console.log(src);
      const dir = positionals[1] ?? fail('usage: linework skill install <skills-dir>   e.g. .claude/skills');
      const dest = path.join(dir.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'), 'linework');
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      console.log(`installed the linework skill to ${dest}`);
      return;
    }
    case 'mcp': {
      const { runStdio } = await import('./mcp/server.js');
      await runStdio({ root: path.resolve(values.root ?? process.env.LINEWORK_ROOT ?? process.cwd()) });
      return;
    }
    case 'git-setup': {
      const { gitSetup } = await import('./git.js');
      for (const line of gitSetup()) console.log(line);
      return;
    }
    case 'kinds': {
      const { KINDS, DIAGRAM_TYPES } = await import('./spec/model.js');
      const types = (positionals.length ? positionals : DIAGRAM_TYPES) as DiagramType[];
      for (const t of types) {
        if (!KINDS[t]) fail(`unknown type ${t}`);
        console.log(`${t}:`);
        for (const [k, d] of Object.entries(KINDS[t])) console.log(`  ${k.padEnd(10)} ${d.description}`);
      }
      return;
    }
    case 'schema': {
      const { jsonSchema } = await import('./spec/parse.js');
      console.log(JSON.stringify(jsonSchema(), null, 2));
      return;
    }
    case 'install-browser': {
      const { browserInstallCommand } = await import('./render/browser.js');
      const { spawnSync } = await import('node:child_process');
      const [bin, ...args] = browserInstallCommand();
      console.log('downloading headless Chromium for linework...');
      const r = spawnSync(bin!, args, { stdio: 'inherit' });
      io.code = r.status ?? 1;
      return;
    }
    default:
      fail(`unknown command "${cmd}". Run "linework help" for the list.`);
  }
}

