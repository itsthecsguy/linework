// `linework mcp`: the same operations as the CLI, over MCP stdio, for chat apps
// and harnesses without a shell. Tools return text the model can act on, plus a
// PNG preview so models that see images can check their work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { build, checkFile, importExcalidraw, listIcons, render, show, tidy } from '../api.js';
import { readDrawio } from '../drawio/read.js';
import { DrawioBrowser } from '../render/browser.js';
import { SpecError } from '../spec/parse.js';
import { buildLines, checkLines } from '../report.js';
import { PROVIDERS, type Provider } from '../drawio/icons.js';

const INSTRUCTIONS = `linework draws software diagrams (architecture, flow, state, sequence, ER) as .drawio.svg files. They render in Markdown, HTML and GitHub like any SVG, and people can open them in draw.io and edit them by hand.

You write a small YAML spec; linework does layout and styling. Never write coordinates, SVG or draw.io XML.
- Call linework_guide once before your first diagram. It has the spec format and the style rules.
- build_diagram writes the file and returns lint results and a PNG preview. Fix every check error, look at the preview, rebuild until it reads well.
- To change an existing diagram, call show_diagram first, edit the YAML it returns (keep its "# linework-base:" line), then build_diagram to the same path. Hand edits made in draw.io survive.
- Never pass relayout: true unless the user asks; it throws away their hand-made layout.
- Embed the .drawio.svg in docs, not the PNG.`;

const PKG = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'skills', 'linework', 'SKILL.md'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('linework: bundled skill not found. Reinstall linework.');
})();

const TOOL_NAMES = `In this MCP server the CLI commands in the guide are tools: build -> build_diagram, show -> show_diagram, check -> check_diagram, render -> render_diagram, tidy -> tidy_diagram, import -> import_mermaid (or import_excalidraw for an .excalidraw file), icons -> list_icons, edit -> edit_diagram, publish -> publish_diagram. Pass the spec text to build_diagram directly instead of writing a file. There are no set, add or rm tools: for a small change, call show_diagram, edit its output and pass that to build_diagram, which keeps the layout the same way.\n\n`;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

export interface McpOptions {
  /** Relative paths resolve against this folder. */
  root: string;
}

export function createServer(opts: McpOptions): { server: McpServer; dispose: () => Promise<void> } {
  let browser: Promise<DrawioBrowser> | undefined;
  const getBrowser = () => (browser ??= DrawioBrowser.launch({ scale: 2 }));
  // One page does all the work, so calls run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  const editors = new Map<string, { url: string; close: () => Promise<void> }>();

  const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(opts.root, p));
  const text = (t: string): Content => ({ type: 'text', text: t });
  const wrap = (fn: () => Promise<Result>) => async (): Promise<Result> => {
    try {
      return await serial(fn);
    } catch (e) {
      if (e instanceof SpecError) return { isError: true, content: [text(['spec error:', ...e.issues.map((i) => `  ${i.path ? i.path + ': ' : ''}${i.message}`)].join('\n'))] };
      return { isError: true, content: [text(`error: ${(e as Error).message}`)] };
    }
  };
  const preview = async (file: string): Promise<Content> => {
    const b = await getBrowser();
    const png = await b.renderPng(readDrawio(fs.readFileSync(file, 'utf8')).xml);
    return { type: 'image', data: png.toString('base64'), mimeType: 'image/png' };
  };

  const server = new McpServer({ name: 'linework', version: version() }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });
  const pathArg = z.string().describe(`Diagram file, e.g. docs/diagrams/checkout.drawio.svg. Relative paths resolve against ${opts.root}.`);

  server.registerTool(
    'linework_guide',
    {
      title: 'How to write linework diagrams',
      description: 'Returns the linework guide: diagram types, the YAML spec format with examples, and the style rules. Read it before your first diagram.',
      inputSchema: z.object({
        topic: z
          .enum(['overview', 'spec', 'style', 'google-docs', 'troubleshooting'])
          .default('overview')
          .describe('overview: workflow and cheat sheet. spec: the full spec reference. style: what makes a good diagram. google-docs: getting diagrams into Google Docs. troubleshooting: what to do when a command fails.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ topic }) => {
      const file = { overview: 'SKILL.md', spec: 'references/spec.md', style: 'references/style-guide.md', 'google-docs': 'references/google-docs.md', troubleshooting: 'references/troubleshooting.md' }[topic];
      const body = fs.readFileSync(path.join(PKG, 'skills', 'linework', file), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
      return { content: [text(TOOL_NAMES + body)] };
    },
  );

  server.registerTool(
    'build_diagram',
    {
      title: 'Build a diagram',
      description:
        'Lay out a YAML spec and write it as a .drawio.svg. If the file exists and someone edited it by hand, the spec is merged in and their layout is kept. Returns what changed, lint results and a PNG preview.',
      inputSchema: z.object({
        spec: z.string().describe('The YAML spec. See linework_guide.'),
        path: pathArg,
        relayout: z.boolean().default(false).describe('Throw away the existing layout, hand edits included. Only when the user asks.'),
        preview: z.boolean().default(true).describe('Return a PNG preview.'),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    (args) =>
      wrap(async () => {
        const out = resolvePath(args.path);
        const res = await build(args.spec, { out, relayout: args.relayout, browser: await getBrowser() });
        const content: Content[] = [text(buildLines(res).join('\n'))];
        if (args.preview) content.push(await preview(out));
        return { content };
      })(),
  );

  server.registerTool(
    'show_diagram',
    {
      title: 'Show a diagram as a spec',
      description: 'Returns the YAML spec of an existing .drawio.svg, including edits people made by hand in draw.io. Edit this output and pass it to build_diagram to change the diagram.',
      inputSchema: z.object({ path: pathArg }),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      wrap(async () => {
        const res = show(resolvePath(args.path));
        const notes = res.notes.map((n) => `note: ${n}`);
        if (res.edits.length) notes.push(`note: edited by hand since the last build. build_diagram keeps those positions and merges your changes in.`);
        return { content: [text(res.yaml + (notes.length ? '\n' + notes.join('\n') : ''))] };
      })(),
  );

  server.registerTool(
    'check_diagram',
    {
      title: 'Lint a diagram',
      description: 'Lints the layout of a .drawio.svg: overlapping shapes, edges through nodes, labels that collide or overflow.',
      inputSchema: z.object({ path: pathArg }),
      annotations: { readOnlyHint: true },
    },
    (args) => wrap(async () => ({ content: [text(checkLines(await checkFile(resolvePath(args.path), await getBrowser())).join('\n'))] }))(),
  );

  server.registerTool(
    'render_diagram',
    {
      title: 'Render a diagram to PNG',
      description: 'Returns a PNG of a .drawio.svg so you can look at it. Optionally also writes the PNG to a file, e.g. for Google Docs or slides, or an .excalidraw copy for someone who works in Excalidraw.',
      inputSchema: z.object({ path: pathArg, out: z.string().optional().describe('Also write the PNG here. A path ending in .excalidraw writes an Excalidraw copy of the diagram instead; import_excalidraw brings edits to it back.') }),
      annotations: { readOnlyHint: false },
    },
    (args) =>
      wrap(async () => {
        const img = await preview(resolvePath(args.path));
        if (args.out) {
          const out = resolvePath(args.out);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          if (out.endsWith('.excalidraw')) await render(resolvePath(args.path), out, await getBrowser());
          else fs.writeFileSync(out, Buffer.from((img as { data: string }).data, 'base64'));
        }
        return { content: [img, ...(args.out ? [text(`wrote ${resolvePath(args.out)}`)] : [])] };
      })(),
  );

  server.registerTool(
    'tidy_diagram',
    {
      title: 'Reroute broken edges',
      description: 'Reroutes edges that pass through shapes, e.g. after someone moved shapes by hand. Nothing else in the file changes.',
      inputSchema: z.object({ path: pathArg }),
      annotations: { idempotentHint: true },
    },
    (args) =>
      wrap(async () => {
        const file = resolvePath(args.path);
        const res = await tidy(file, await getBrowser());
        return { content: [text([res.fixed ? `rerouted ${res.fixed} edges in ${file}` : 'nothing to fix', ...checkLines(res.check)].join('\n'))] };
      })(),
  );

  server.registerTool(
    'import_mermaid',
    {
      title: 'Convert Mermaid to a linework spec',
      description: 'Converts a Mermaid diagram (flowchart, stateDiagram, sequenceDiagram, erDiagram) to a linework spec. Returns the spec; review the guessed node kinds, then build it. With path, builds it straight away.',
      inputSchema: z.object({ source: z.string().describe('Mermaid source, without the ``` fence.'), path: pathArg.optional() }),
    },
    (args) =>
      wrap(async () => {
        const { importMermaid } = await import('../import/mermaid.js');
        const { toYaml } = await import('../drawio/show.js');
        const res = importMermaid(args.source);
        const yaml = toYaml(res.diagram, 'imported from Mermaid');
        const lines = [yaml, ...res.warnings.map((w) => `import: ${w}`)];
        const content: Content[] = [];
        if (args.path) {
          const out = resolvePath(args.path);
          const built = await build(yaml, { out, browser: await getBrowser() });
          lines.push('', ...buildLines(built));
          content.push(text(lines.join('\n')), await preview(out));
        } else content.push(text(lines.join('\n')));
        return { content };
      })(),
  );

  server.registerTool(
    'import_excalidraw',
    {
      title: 'Bring Excalidraw edits back into a diagram',
      description: 'Merges edits made in Excalidraw into a .drawio.svg. `source` is an .excalidraw file that render_diagram wrote and someone then edited; `path` is the diagram it was exported from. Reads new text, boxes and arrows added or deleted, arrows moved to other boxes, and positions. Returns what changed and a preview. Colors and hand-drawn arrow paths are not read.',
      inputSchema: z.object({ source: z.string().describe('The edited .excalidraw file.'), path: pathArg }),
      annotations: { readOnlyHint: false },
    },
    (args) =>
      wrap(async () => {
        const out = resolvePath(args.path);
        const res = await importExcalidraw(resolvePath(args.source), out, { browser: await getBrowser() });
        const lines = [res.changes.length ? `${res.changes.length} change${res.changes.length === 1 ? '' : 's'} from Excalidraw:` : 'The diagram already matches the Excalidraw file.', ...res.changes.map((c) => `  ${c}`), ...res.notes.map((n) => `note: ${n}`)];
        return { content: [text(lines.join('\n')), await preview(out)] };
      })(),
  );

  server.registerTool(
    'list_icons',
    {
      title: 'Search cloud icons',
      description: 'Lists icon names for architecture nodes (icon: aws.lambda). Pass a filter word to search, e.g. provider aws, filter "queue".',
      inputSchema: z.object({ provider: z.enum(Object.keys(PROVIDERS) as [Provider, ...Provider[]]), filter: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      wrap(async () => {
        const names = await listIcons(args.provider, args.filter, await getBrowser());
        return { content: [text(names.map((n) => `${args.provider}.${n}`).join('\n') || 'no matches')] };
      })(),
  );

  server.registerTool(
    'edit_diagram',
    {
      title: 'Open a diagram in draw.io',
      description:
        "Opens the diagram in the bundled draw.io editor in the user's browser, served locally. When they save, the file updates. When they say they're done, call show_diagram to pick up their changes.",
      inputSchema: z.object({ path: pathArg, open: z.boolean().default(true).describe('Open the browser. False just returns the URL.') }),
    },
    (args) =>
      wrap(async () => {
        const { startEditor, openInBrowser } = await import('../edit/server.js');
        const file = resolvePath(args.path);
        const existing = editors.get(file);
        if (existing) {
          if (args.open) openInBrowser(existing.url);
          return { content: [text(`already open at ${existing.url}`)] };
        }
        const session = await startEditor(file);
        editors.set(file, session);
        void session.done.then(() => editors.delete(file));
        const opened = args.open && openInBrowser(session.url);
        return { content: [text(`${opened ? 'Opened' : 'Open'} ${session.url} to edit ${file}. Saving in the editor (Ctrl/Cmd+S) writes the file.`)] };
      })(),
  );

  server.registerTool(
    'publish_diagram',
    {
      title: 'Publish diagrams to Google Drive',
      description:
        "Copies diagrams into the user's Google Drive folder (Google Drive for desktop) at a fixed path, so draw.io's Google Docs add-on can insert them and refresh them. pull: true copies back a version someone edited from Docs. See linework_guide topic google-docs.",
      inputSchema: z.object({
        paths: z.array(z.string()).min(1).describe('Diagram files to publish.'),
        to: z.string().optional().describe('Publish into this synced folder instead of the detected Google Drive folder.'),
        pull: z.boolean().default(false).describe('Copy the Drive versions back over the local files.'),
      }),
    },
    (args) =>
      wrap(async () => {
        const { publish } = await import('../publish.js');
        const items = publish(args.paths.map(resolvePath), { to: args.to && resolvePath(args.to), pull: args.pull, cwd: opts.root });
        const lines = items.map((i) =>
          i.action === 'conflict'
            ? `skipped ${i.file}: the Drive copy was edited after the last publish. Ask the user whether to pull it (pull: true) or overwrite it.`
            : `${i.action} ${i.action === 'pulled' ? `${i.dest} -> ${i.file}` : `${i.file} -> ${i.dest}`}`,
        );
        if (items.some((i) => i.action === 'published'))
          lines.push('', 'Tell the user: in Google Docs, Extensions > draw.io > Insert diagrams to add it, or Extensions > draw.io > Update diagrams if it is already in the doc.');
        return { content: [text(lines.join('\n'))] };
      })(),
  );

  const dispose = async () => {
    for (const e of editors.values()) await e.close();
    if (browser) await (await browser.catch(() => undefined))?.close();
  };
  return { server, dispose };
}

function version(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

export async function runStdio(opts: McpOptions): Promise<void> {
  let disposers: Array<() => Promise<void>> = [];
  serveStdio(() => {
    const { server, dispose } = createServer(opts);
    disposers.push(dispose);
    return server;
  });
  const shutdown = async () => {
    const d = disposers;
    disposers = [];
    await Promise.allSettled(d.map((f) => f()));
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
