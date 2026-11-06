#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build, checkFile, listIcons, render, show, tidy } from './api.js';
import { SpecError, jsonSchema } from './spec/parse.js';
import { KINDS, DIAGRAM_TYPES, type DiagramType } from './spec/model.js';
import type { CheckResult } from './lint/check.js';
import { buildLines, checkLines } from './report.js';

const USAGE = `linework: AI-written, hand-editable diagrams (YAML spec -> .drawio.svg)

Usage:
  linework build <spec.yaml|-> -o <out.drawio.svg> [--png preview.png] [--relayout]
      Lay out and write the diagram, then lint it. "-" reads the spec from stdin.
      If the file exists and someone edited it by hand, the spec is merged in:
      existing positions stay, new nodes are placed next to their neighbours.
      --relayout throws the existing layout away (hand edits included).
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
`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
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
      root: { type: 'string' },
      to: { type: 'string' },
      pull: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || values.help) return void process.stdout.write(USAGE);

  switch (cmd) {
    case 'build': {
      const src = positionals[0];
      if (!src || !values.out) fail('usage: linework build <spec.yaml|-> -o <out.drawio.svg>');
      const text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
      const res = await build(text, { out: values.out, png: values.png, force: values.force, relayout: values.relayout });
      for (const line of buildLines(res, values.png)) console.log(line);
      return;
    }
    case 'show': {
      const file = positionals[0] ?? fail('usage: linework show <file.drawio.svg>');
      const res = show(file, { geometry: values.geometry });
      process.stdout.write(res.yaml);
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
      const { DrawioBrowser } = await import('./render/browser.js');
      const b = await DrawioBrowser.launch({ scale: values.scale ? Number(values.scale) : 2 });
      try {
        await render(file, values.out, b);
      } finally {
        await b.close();
      }
      console.log(`wrote ${values.out}`);
      return;
    }
    case 'check': {
      const file = positionals[0] ?? fail('usage: linework check <file.drawio.svg>');
      const res = await checkFile(file);
      printCheck(res);
      if (res.findings.some((f) => f.level === 'error')) process.exitCode = 1;
      return;
    }
    case 'tidy': {
      const file = positionals[0] ?? fail('usage: linework tidy <file.drawio.svg>');
      const res = await tidy(file);
      console.log(res.fixed ? `rerouted ${res.fixed} edges in ${file}` : 'nothing to fix');
      printCheck(res.check);
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
      let text = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
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
      if (!values.out) return void process.stdout.write(yaml);
      const built = await build(yaml, { out: values.out, png: values.png, relayout: values.relayout, force: values.force });
      console.log(`wrote ${built.out} (${built.check.stats.nodes} nodes, ${built.check.stats.edges} edges, ${built.direction})`);
      printCheck(built.check);
      return;
    }
    case 'icons': {
      const provider = positionals[0] as 'aws' | 'gcp' | 'k8s' | 'azure' | undefined;
      if (!provider || !['aws', 'gcp', 'k8s', 'azure'].includes(provider)) fail('usage: linework icons <aws|gcp|k8s|azure> [filter]');
      const names = await listIcons(provider, positionals[1]);
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
      if (items.some((i) => i.action === 'conflict')) process.exitCode = 1;
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
      const types = (positionals.length ? positionals : DIAGRAM_TYPES) as DiagramType[];
      for (const t of types) {
        if (!KINDS[t]) fail(`unknown type ${t}`);
        console.log(`${t}:`);
        for (const [k, d] of Object.entries(KINDS[t])) console.log(`  ${k.padEnd(10)} ${d.description}`);
      }
      return;
    }
    case 'schema':
      console.log(JSON.stringify(jsonSchema(), null, 2));
      return;
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

function printCheck(res: CheckResult) {
  for (const line of checkLines(res)) console.log(line);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof SpecError) {
    console.error('spec error:');
    for (const i of e.issues) console.error(`  ${i.path ? i.path + ': ' : ''}${i.message}`);
    process.exit(1);
  }
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
