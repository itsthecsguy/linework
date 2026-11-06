// Needs Chromium. Set LINEWORK_SKIP_E2E=1 to skip.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DrawioBrowser } from '../src/render/browser.js';
import { build, checkFile, render, show, tidy } from '../src/api.js';

let browser: DrawioBrowser | undefined;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-'));
beforeAll(async () => {
  if (process.env.LINEWORK_SKIP_E2E !== '1') browser = await DrawioBrowser.launch();
}, 60000);
afterAll(async () => { await browser?.close(); });

describe.runIf(process.env.LINEWORK_SKIP_E2E !== '1')('end to end', () => {
  for (const f of fs.readdirSync('examples')) {
    it(`builds ${f} with no lint errors`, async () => {
      const out = path.join(tmp, f.replace('.yaml', '.drawio.svg'));
      const res = await build(fs.readFileSync(`examples/${f}`, 'utf8'), { out, png: out + '.png', browser: browser! });
      const svg = fs.readFileSync(out, 'utf8');
      expect(svg).toMatch(/^<\?xml/);
      expect(svg).toContain('content="&lt;mxfile');
      expect(fs.statSync(out + '.png').size).toBeGreaterThan(10000);
      expect(res.check.findings.filter((x) => x.level === 'error')).toEqual([]);
      // show output rebuilds to an identical file
      const again = path.join(tmp, 'again-' + path.basename(out));
      await build(show(out).yaml, { out: again, browser: browser! });
      expect(fs.readFileSync(again, 'utf8')).toBe(svg);
    }, 60000);
  }

  it('checks and renders a hand-edited file', async () => {
    const res = await checkFile('test/fixtures/hand-edited.drawio.svg', browser!);
    expect(res.findings.some((f) => f.rule === 'edge-through-node')).toBe(true);
    const png = path.join(tmp, 'edited.png');
    await render('test/fixtures/hand-edited.drawio.svg', png, browser!);
    expect(fs.statSync(png).size).toBeGreaterThan(10000);
  }, 60000);
});

describe.runIf(process.env.LINEWORK_SKIP_E2E !== '1')('editing loop', () => {
  const spec = fs.readFileSync('examples/checkout.yaml', 'utf8');

  it('merges after a hand move, and a repeat build changes nothing', async () => {
    const out = path.join(tmp, 'loop.drawio.svg');
    await build(spec, { out, browser: browser! });
    // a person drags "worker" 200px right in draw.io
    const svg = fs.readFileSync(out, 'utf8').replace(/(&lt;object id=&quot;worker&quot;[\s\S]*?&lt;mxGeometry x=&quot;)(\d+)/, (_, a, x) => a + (+x + 200));
    fs.writeFileSync(out, svg);
    const moved = show(out);
    expect(moved.edits).toContainEqual({ id: 'worker', what: 'moved' });

    const next = spec.replace('  email:', '  audit: { label: Audit log, kind: database, in: vpc }\n  email:').replace('  - worker -> email: receipt', '  - worker -> email: receipt\n  - worker -> audit: append');
    const res = await build(next, { out, browser: browser! });
    expect(res.mode).toBe('merge');
    expect(res.merge!.placed).toEqual(['audit']);
    expect(res.check.findings.filter((f) => f.level === 'error')).toEqual([]);
    const after = fs.readFileSync(out, 'utf8');

    const again = await build(next, { out, browser: browser! });
    expect(again.merge!.placed).toEqual([]);
    expect(again.merge!.rerouted).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe(after);
  }, 60000);

  it('--relayout starts over', async () => {
    const out = path.join(tmp, 'loop.drawio.svg');
    const res = await build(spec, { out, browser: browser!, relayout: true });
    expect(res.mode).toBe('fresh');
    expect(res.discardedLayout).toBe(true);
  }, 60000);

  it('tidy reroutes broken edges only', async () => {
    const out = path.join(tmp, 'tidy.drawio.svg');
    fs.copyFileSync('test/fixtures/hand-edited.drawio.svg', out);
    const res = await tidy(out, browser!);
    expect(res.fixed).toBeGreaterThan(0);
    expect(res.check.findings.filter((f) => f.level === 'error')).toEqual([]);
  }, 60000);
});

describe.runIf(process.env.LINEWORK_SKIP_E2E !== '1')('phase 3 end to end', () => {
  for (const f of fs.readdirSync('test/fixtures/mermaid')) {
    it(`imports and builds ${f} cleanly`, async () => {
      const { importMermaid } = await import('../src/import/mermaid.js');
      const { toYaml } = await import('../src/drawio/show.js');
      const yaml = toYaml(importMermaid(fs.readFileSync(`test/fixtures/mermaid/${f}`, 'utf8')).diagram);
      const res = await build(yaml, { out: path.join(tmp, `${f}.drawio.svg`), browser: browser! });
      expect(res.check.findings.filter((x) => x.level === 'error')).toEqual([]);
    }, 60000);
  }

  it('drops unknown icons with a warning instead of failing', async () => {
    const res = await build('type: architecture\nnodes: { a: { icon: aws.not_a_service } }', { out: path.join(tmp, 'icon.drawio.svg'), browser: browser! });
    expect(res.warnings.map((w) => w.message).join()).toMatch(/no icon named "aws.not_a_service"/);
  }, 60000);

  it('a hand-moved sequence lifeline keeps its column', async () => {
    const out = path.join(tmp, 'seq.drawio.svg');
    const spec = fs.readFileSync('examples/pay-sequence.yaml', 'utf8');
    await build(spec, { out, browser: browser! });
    const moved = fs.readFileSync(out, 'utf8').replace(/(&lt;object id=&quot;db&quot;[\s\S]*?&lt;mxGeometry x=&quot;)(\d+)/, (_, a, x) => a + (+x + 300));
    fs.writeFileSync(out, moved);
    const before = /&lt;object id=&quot;db&quot;[\s\S]*?&lt;mxGeometry x=&quot;(\d+)/.exec(moved)![1];
    await build(spec.replace('  - web --> user: result page', '  - web --> user: result page\n  - user -> web: Close'), { out, browser: browser! });
    const after = /&lt;object id=&quot;db&quot;[\s\S]*?&lt;mxGeometry x=&quot;(\d+)/.exec(fs.readFileSync(out, 'utf8'))![1];
    expect(after).toBe(before);
  }, 60000);
});
