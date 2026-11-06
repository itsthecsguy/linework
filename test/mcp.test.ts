// Drives `linework mcp` through the official MCP client over stdio. Needs Chromium.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const run = process.env.LINEWORK_SKIP_E2E !== '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-mcp-'));
let client: Client;

type Block = { type: string; text?: string; data?: string; mimeType?: string };
async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content: Block[]; isError?: boolean };
  return { ...res, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), images: res.content.filter((c) => c.type === 'image') };
}

beforeAll(async () => {
  if (!run) return;
  client = new Client({ name: 'linework-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', path.resolve('src/cli.ts'), 'mcp', '--root', tmp],
      stderr: 'inherit',
    }),
  );
}, 60000);
afterAll(async () => {
  await client?.close();
});

describe.runIf(run)('mcp server', () => {
  it('lists the tools and gives instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['build_diagram', 'check_diagram', 'edit_diagram', 'import_mermaid', 'linework_guide', 'list_icons', 'publish_diagram', 'render_diagram', 'show_diagram', 'tidy_diagram'],
    );
    expect(client.getInstructions()).toContain('show_diagram');
    const guide = await call('linework_guide', { topic: 'spec' });
    expect(guide.text).toContain('build -> build_diagram');
    expect(guide.text).toContain('## Sequence');
  });

  it('builds, shows, edits and rebuilds a diagram with a preview', async () => {
    const spec = fs.readFileSync('examples/checkout.yaml', 'utf8');
    const built = await call('build_diagram', { spec, path: 'docs/checkout.drawio.svg' });
    expect(built.isError).toBeFalsy();
    expect(built.text).toMatch(/wrote .*docs\/checkout\.drawio\.svg/);
    expect(built.text).toContain('check: 0 errors');
    expect(built.images).toHaveLength(1);
    expect(Buffer.from(built.images[0]!.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(fs.existsSync(path.join(tmp, 'docs/checkout.drawio.svg'))).toBe(true);

    const shown = await call('show_diagram', { path: 'docs/checkout.drawio.svg' });
    expect(shown.text).toContain('# linework-base:');
    const edited = shown.text.replace('edges:\n', 'edges:\n  - api -> audit: append\n').replace('nodes:\n', 'nodes:\n  audit: { label: Audit log, kind: storage }\n');
    const rebuilt = await call('build_diagram', { spec: edited, path: 'docs/checkout.drawio.svg', preview: false });
    expect(rebuilt.text).toContain('check: 0 errors');
    expect(rebuilt.images).toHaveLength(0);
    expect((await call('show_diagram', { path: 'docs/checkout.drawio.svg' })).text).toContain('Audit log');
  }, 120000);

  it('returns spec errors the model can act on', async () => {
    const res = await call('build_diagram', { spec: 'type: architecture\nnodes:\n  a: { kind: databse }\n', path: 'bad.drawio.svg' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('spec error');
    expect(res.text).toContain('database');
  });

  it('checks, renders, imports Mermaid and lists icons', async () => {
    expect((await call('check_diagram', { path: 'docs/checkout.drawio.svg' })).text).toMatch(/^check: 0 errors/);
    const r = await call('render_diagram', { path: 'docs/checkout.drawio.svg', out: 'checkout.png' });
    expect(r.images).toHaveLength(1);
    expect(fs.statSync(path.join(tmp, 'checkout.png')).size).toBeGreaterThan(10000);
    const imp = await call('import_mermaid', { source: 'flowchart LR\n  A[Web] --> B[(Orders DB)]', path: 'flow.drawio.svg' });
    expect(imp.text).toContain('kind: database');
    expect(imp.images).toHaveLength(1);
    expect((await call('list_icons', { provider: 'aws', filter: 'lambda' })).text).toContain('aws.lambda');
  }, 120000);

  it('publishes to a synced folder', async () => {
    const res = await call('publish_diagram', { paths: ['docs/checkout.drawio.svg'], to: 'drive' });
    expect(res.text).toContain('published');
    expect(res.text).toContain('Insert diagrams');
    expect(fs.existsSync(path.join(tmp, 'drive/docs/checkout.drawio.svg'))).toBe(true);
  });

  it('opens the local editor without launching a browser', async () => {
    const res = await call('edit_diagram', { path: 'docs/checkout.drawio.svg', open: false });
    const url = /http:\/\/127\.0\.0\.1:\d+\/\w+\//.exec(res.text)?.[0];
    expect(url).toBeTruthy();
    const page = await fetch(url!).then((r) => r.text());
    expect(page).toContain('embed=1&proto=json');
    expect((await fetch(url!.replace(/\/\w+\/$/, '/app/js/app.min.js'))).status).toBe(200);
  });
});
