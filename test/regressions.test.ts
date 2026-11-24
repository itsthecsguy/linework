// One test for each defect a code review found, so none of them comes back.
// The first half needs no browser; the second half draws.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { build, importExcalidraw, listIcons, render, show } from '../src/api.js';
import { Exit, renderScale, report, wholeNumber, type IO } from '../src/commands.js';
import { labelLines, readDrawio } from '../src/drawio/read.js';
import { toYaml } from '../src/drawio/show.js';
import { startEditor, openInBrowser } from '../src/edit/server.js';
import { toExcalidraw, type ExcalidrawFile } from '../src/excalidraw/export.js';
import { readScene } from '../src/excalidraw/file.js';
import { shareable } from '../src/excalidraw/share.js';
import { importMermaid } from '../src/import/mermaid.js';
import { PatchError, patchSpec } from '../src/patch.js';
import { publish } from '../src/publish.js';
import { DrawioBrowser } from '../src/render/browser.js';
import { SpecError, parseSpecText } from '../src/spec/parse.js';
import { watchFile } from '../src/watch.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linework-reg-'));
const at = (name: string) => path.join(tmp, name);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const issues = (spec: string) => {
  try {
    parseSpecText(spec);
  } catch (e) {
    if (e instanceof SpecError) return e.issues.map((i) => `${i.path}: ${i.message}`);
    throw e;
  }
  return [];
};

describe('spec errors', () => {
  const flow = (edges: string) => `type: flow\nnodes: { a: A, b: B }\nedges:\n${edges}`;

  it('checks the object form of an edge as strictly as the rest', () => {
    expect(issues(flow('  - { from: a, to: b, style: dashed }\n'))).toEqual(['edges[0].style: style must be one of: sync, async, bidir, line']);
    expect(issues(flow('  - { from: a, to: b, lable: hi }\n'))).toEqual(['edges[0]: unknown key(s) "lable". Allowed here: from, to, label, style, rel, color, status, highlight. Did you mean "label"?']);
    expect(issues(flow('  - { from: a }\n'))).toEqual(['edges[0].to: to is required']);
    expect(parseSpecText(flow('  - { from: a, to: b, label: ok, style: async }\n')).diagram.edges[0]).toMatchObject({ from: 'a', to: 'b', label: 'ok', style: 'async' });
  });

  it('names the key that is wrong inside a node', () => {
    expect(issues('type: flow\nnodes:\n  a: { tech: [Go, gRPC], highlight: "yes" }\n')).toEqual(['nodes.a.tech: expected one line of text, not a list or a map', 'nodes.a.highlight: highlight is true or false, without quotes']);
    expect(issues('type: flow\nnodes:\n  a: [1]\n')).toEqual(['nodes.a: expected a label string or an object']);
    expect(issues('type: timeline\nnodes:\n  a: { strat: 2026-01-01 }\n')[0]).toContain('start, end, at (timeline)');
  });

  it("doesn't take a property every object has for a kind", () => {
    for (const kind of ['constructor', 'toString', '__proto__']) expect(issues(`type: flow\nnodes:\n  a: { kind: ${kind} }\n`)[0], kind).toMatch(/^nodes\.a\.kind: unknown kind/);
    expect(issues('type: sequence\nparticipants:\n  a: { kind: constructor }\nmessages: []\n')[0]).toMatch(/unknown kind/);
  });

  it('refuses two edges that would share one cell in the file', () => {
    const spec = 'type: flow\nnodes: { api: A, worker: B, worker_2: C }\nedges:\n  - api -> worker: enqueue\n  - api -> worker: cancel\n  - api -> worker_2: fan out\n';
    expect(issues(spec)).toEqual([expect.stringMatching(/^edges\[2\]: the edges "api -> worker" and "api -> worker_2" can't be told apart.*Rename one of the nodes, e\.g\. "worker_2" to "worker2"\.$/)]);
    // Parallel edges on their own are fine.
    expect(issues('type: flow\nnodes: { api: A, worker: B }\nedges:\n  - api -> worker: enqueue\n  - api -> worker: cancel\n')).toEqual([]);
  });

  it('refuses two rows of one name in a table', () => {
    expect(issues('type: er\nnodes:\n  users:\n    fields:\n      - id: uuid pk\n      - id: text\n')).toEqual(['nodes.users.fields: two rows are named "id". Names in one table have to differ.']);
  });

  it('reads a label typed over two lines as one line', () => {
    const { diagram } = parseSpecText('type: flow\nnodes:\n  a: { label: "Line one\\nLine two" }\n');
    expect(diagram.nodes[0]!.label).toBe('Line one Line two');
  });
});

describe('sequence messages in the long form', () => {
  const seq = (messages: string) => `type: sequence\nparticipants: { a: {}, b: {} }\nmessages:\n${messages}`;

  it('takes a color, and prints it back the same way', () => {
    const spec = seq('  - a -> b: plain\n  - { from: a, to: b, label: "mark, paid", style: reply, color: red }\n  - { from: b, to: a, style: reply, highlight: true }\n');
    const { diagram } = parseSpecText(spec);
    expect(diagram.seq).toMatchObject([{ label: 'plain' }, { from: 'a', to: 'b', label: 'mark, paid', style: 'reply', color: 'red' }, { from: 'b', to: 'a', style: 'reply', highlight: true }]);
    const out = toYaml(diagram);
    expect(out).toContain('- { from: a, to: b, label: "mark, paid", style: reply, color: red }');
    expect(out).toContain('- { from: b, to: a, style: reply, highlight: true }');
    expect(toYaml(parseSpecText(out).diagram)).toBe(out);
  });

  it('says what is wrong with one', () => {
    expect(issues(seq('  - { from: a, to: c, colour: red }\n'))).toEqual(['messages[0]: unknown key(s) "colour". Allowed here: from, to, label, style, color, status, highlight. Did you mean "color"?']);
    expect(issues(seq('  - { from: a, to: b, style: dotted }\n'))).toEqual(['messages[0].style: style must be one of: sync, reply, async']);
    expect(issues(seq('  - { from: a, to: zz }\n'))[0]).toMatch(/participant "zz" doesn't exist/);
  });
});

describe('reading a diagram back', () => {
  it('strips tags from a label, not text that has < and > in it', () => {
    expect(labelLines('if x < 10 && y > 2')).toEqual(['if x < 10 && y > 2']);
    expect(labelLines('<b>API</b><br><span style="color:red">Go &amp; gRPC</span>')).toEqual(['API', 'Go & gRPC']);
    expect(labelLines('returns List&lt;T&gt;')).toEqual(['returns List<T>']);
  });

  it('prints a sequence with no messages as a spec that builds', () => {
    const { diagram } = parseSpecText('type: sequence\nparticipants: { a: {}, b: {} }\nmessages: []\n');
    expect(toYaml(diagram)).toContain('messages: []');
    expect(() => parseSpecText(toYaml(diagram))).not.toThrow();
  });
});

describe('set, add and rm', () => {
  const spec = 'type: architecture\nnodes:\n  api: { label: API }\n  db: DB\nedges:\n  - api -> db\n';
  const seq = 'type: sequence\nparticipants: { app: {}, bff: {}, cache: {} }\nmessages:\n  - app -> bff: get\n  - loop: every call\n    do:\n      - bff -> cache: read\n      - alt:\n          - when: hit\n            do:\n              - cache --> bff: value\n          - when: miss\n            do:\n              - bff --> app: none\n';

  it('takes a hex color, which YAML would read as a comment', () => {
    expect(patchSpec(spec, [{ op: 'set', args: ['accent=#2563eb'] }])).toContain('accent: "#2563eb"');
    expect(parseSpecText(patchSpec(spec, [{ op: 'set', args: ['accent=#2563eb'] }])).diagram.accent).toBe('#2563EB');
  });

  it('reports a value it cannot read as bad usage', () => {
    expect(() => patchSpec(spec, [{ op: 'set', args: ['api.color="oops'] }])).toThrow(PatchError);
    expect(() => patchSpec(spec, [{ op: 'add', args: ['x: { label: "oops }'] }])).toThrow(PatchError);
  });

  it('removes a participant with its messages, wherever they are nested', () => {
    const out = patchSpec(seq, [{ op: 'rm', args: ['cache'] }]);
    expect(out).not.toContain('cache');
    expect(parseSpecText(out).diagram.nodes.map((n) => n.id)).toEqual(['app', 'bff']);
    expect(out).toContain('bff --> app: none');
  });

  it('removes one message inside a frame', () => {
    const out = patchSpec(seq, [{ op: 'rm', args: ['bff -> cache'] }]);
    expect(out).not.toContain('bff -> cache: read');
    expect(out).toContain('cache --> bff: value');
    expect(() => patchSpec(seq, [{ op: 'rm', args: ['app -> cache'] }])).toThrow(/no edge from "app" to "cache"/);
  });
});

describe('command line', () => {
  it('rejects numbers that are not numbers', () => {
    expect(wholeNumber('--port', '8080', 0, 65535)).toBe(8080);
    for (const bad of ['abc', '', '1.5', '70000', '-1']) expect(() => wholeNumber('--port', bad, 0, 65535), bad).toThrow(Exit);
    expect(renderScale('3')).toBe(3);
    expect(renderScale('0.5')).toBe(0.5);
    for (const bad of ['abc', '2x', '0', '99', '']) expect(() => renderScale(bad), bad).toThrow(/--scale takes a number from 0\.1 to 8/);
  });

  it('names a missing file, not the system call', () => {
    let err = '';
    const io: IO = { out() {}, err: (t) => void (err += t), stdin: () => '', code: 0 };
    try {
      fs.readFileSync(at('nope.yaml'));
    } catch (e) {
      expect(report(e, io)).toBe(1);
    }
    expect(err).toBe(`error: ${at('nope.yaml')} doesn't exist\n`);
  });
});

describe('Mermaid', () => {
  const yaml = (src: string) => toYaml(importMermaid(src).diagram);

  it('sends an edge to a subgraph to its first node, with a warning', () => {
    const res = importMermaid('flowchart LR\n  subgraph GCP\n    svc[Service]\n    db[(DB)]\n  end\n  user --> GCP\n');
    expect(res.diagram.nodes.map((n) => n.id)).toEqual(['svc', 'db', 'user']);
    expect(res.diagram.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['user->svc']);
    expect(res.warnings.join()).toContain('an edge to the subgraph "GCP"');
  });

  it('reads link text written without spaces', () => {
    const out = yaml('flowchart LR\n  H --Yes--> I\n  N -.retry.-> O\n  A --- B --> C\n  P --o Q -- x --> R\n');
    expect(out).toContain('"H -> I: Yes"');
    expect(out).toContain('N -.-> O: retry');
    expect(out).toContain('A -- B');
    expect(out).toContain('Q -> R: x');
    expect(importMermaid('flowchart LR\n  H --Yes--> I\n').diagram.nodes.map((n) => n.id)).toEqual(['H', 'I']);
  });

  it('finds a sequence arrow before the message text, never in it', () => {
    const d = importMermaid('sequenceDiagram\n  A->B: retry with -x flag\n  B-->>A: ok: fine -> yes\n').diagram;
    expect(d.nodes.map((n) => n.id)).toEqual(['A', 'B']);
    expect(d.seq).toMatchObject([{ from: 'A', to: 'B', label: 'retry with -x flag', style: 'sync' }, { from: 'B', to: 'A', label: 'ok: fine -> yes', style: 'reply' }]);
  });

  it('keeps the option branches of a critical block', () => {
    const res = importMermaid('sequenceDiagram\n  critical Establish\n    A->DB: connect\n  option timeout\n    A-->DB: log\n  end\n');
    expect(res.warnings).toEqual([]);
    const out = toYaml(res.diagram);
    expect(out).toContain('- critical:\n      - when: Establish');
    expect(out).toContain('- when: timeout\n        do:\n          - A --> DB: log');
    // What it prints is a spec that reads back the same.
    expect(toYaml(parseSpecText(out).diagram)).toBe(out);
    // A critical block with one part keeps the short form.
    expect(toYaml(parseSpecText('type: sequence\nparticipants: { a: {}, b: {} }\nmessages:\n  - critical: lock\n    do:\n      - a -> b: take\n').diagram)).toContain('- critical: lock\n    do:');
  });

  it('reads x--x and o--o links, and a quoted label over two lines', () => {
    const d = importMermaid('flowchart LR\n  P x--x Q\n  R o--o S\n  T["multi\nline"] --> U\n  ox --> V\n').diagram;
    expect(d.nodes.map((n) => n.id)).toEqual(['P', 'Q', 'R', 'S', 'T', 'U', 'ox', 'V']);
    expect(d.nodes.find((n) => n.id === 'T')!.label).toBe('multi line');
    expect(d.edges.map((e) => `${e.from} ${e.style} ${e.to}`)).toEqual(['P bidir Q', 'R bidir S', 'T sync U', 'ox sync V']);
  });

  it('explains why a gantt chart had no tasks', () => {
    expect(() => importMermaid('gantt\n  dateFormat DD-MM-YYYY\n  section A\n  Task :a1, 01-02-2026, 3d\n')).toThrow(/no tasks linework could read[\s\S]*dateFormat DD-MM-YYYY isn't read/);
  });
});

describe('Excalidraw files', () => {
  it('refuses JSON that is not a drawing, by name', () => {
    for (const [text, why] of [['{}', 'expected {"type": "excalidraw"'], ['null', 'expected'], ['[]', 'expected'], ['{"type":"excalidraw"}', 'expected'], ['{"type":"excalidrawlib","libraryItems":[]}', 'an Excalidraw library, not a drawing']] as const) {
      fs.writeFileSync(at('bad.excalidraw'), text);
      expect(() => readScene(at('bad.excalidraw')), text).toThrow(why);
    }
  });

  it("doesn't count deleted elements as images left out of a link", () => {
    const el = (over: object) => ({ id: 'x', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, ...over });
    const scene = { type: 'excalidraw', elements: [el({}), el({ type: 'image' }), el({ isDeleted: true }), el({ type: 'image', isDeleted: true })], files: {} } as unknown as ExcalidrawFile;
    expect(shareable(scene).images).toBe(1);
  });
});

describe('the editor server', () => {
  it('answers a bad request without going down', async () => {
    fs.copyFileSync('test/fixtures/hand-edited.drawio.svg', at('e.drawio.svg'));
    const session = await startEditor(at('e.drawio.svg'));
    const origin = new URL(session.url).origin;
    const get = (p: string) => new Promise<number>((resolve, reject) => http.get(origin + p, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject));
    try {
      expect(await get('/app/%E0%A4%A')).toBe(400);
      expect(await get('/app/../../package.json')).toBe(404);
      // The file moved away while the editor was open.
      fs.renameSync(at('e.drawio.svg'), at('moved.drawio.svg'));
      expect(await get(new URL(session.url).pathname)).toBe(500);
      fs.renameSync(at('moved.drawio.svg'), at('e.drawio.svg'));
      expect(await get(new URL(session.url).pathname)).toBe(200);
    } finally {
      await session.close();
    }
  });

  it('says when it could not open a browser', async () => {
    const PATH = process.env.PATH;
    process.env.PATH = tmp;
    try {
      if (process.platform === 'linux') expect(await openInBrowser('http://127.0.0.1:9/')).toBe(false);
    } finally {
      process.env.PATH = PATH;
    }
  });

  it('returns false immediately on headless Linux with no display env', async () => {
    if (process.platform !== 'linux') return;
    const prev = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME };
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.WSL_DISTRO_NAME;
    try {
      expect(await openInBrowser('http://127.0.0.1:9/')).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('watchFile', () => {
  it('rebuilds when an extra file changes and retries mid-write empty saves', async () => {
    const dir = at('watch-extra');
    fs.mkdirSync(dir, { recursive: true });
    const spec = path.join(dir, 'a.yaml');
    const cfg = path.join(dir, 'linework.yaml');
    fs.writeFileSync(spec, 'type: flow\nnodes: { a: A }\n');
    fs.writeFileSync(cfg, 'theme: clean\n');
    let calls = 0;
    const w = watchFile(spec, async () => { calls++; }, { settle: 40, extra: [cfg] });
    try {
      await new Promise((r) => setTimeout(r, 60));
      fs.writeFileSync(cfg, 'theme: dark\n');
      await expect.poll(() => calls, { timeout: 3000 }).toBe(1);
      // Simulate truncate-then-write where the file is momentarily 0 bytes.
      fs.writeFileSync(spec, '');
      setTimeout(() => fs.writeFileSync(spec, 'type: flow\nnodes: { a: B }\n'), 80);
      await expect.poll(() => calls, { timeout: 3000 }).toBe(2);
    } finally {
      w.stop();
      await w.done;
    }
  });
});

describe('publish', () => {
  it('copies nothing when one of the files is missing', () => {
    fs.mkdirSync(at('proj'));
    fs.mkdirSync(at('drive'));
    fs.copyFileSync('test/fixtures/hand-edited.drawio.svg', at('proj/a.drawio.svg'));
    expect(() => publish(['a.drawio.svg', 'missing.drawio.svg'], { to: at('drive'), cwd: at('proj') })).toThrow(/missing\.drawio\.svg doesn't exist/);
    expect(fs.readdirSync(at('drive'))).toEqual([]);
  });
});

// ---------- with a browser ----------

const e2e = process.env.LINEWORK_SKIP_E2E !== '1';
let browser: DrawioBrowser;
beforeAll(async () => {
  if (e2e) browser = await DrawioBrowser.launch();
}, 60000);
afterAll(async () => {
  await browser?.close();
});
const spec = (file: string) => show(file).yaml.replace(/^# linework-base.*\n/, '');

describe.runIf(e2e)('labels with markup characters', () => {
  it('draws and reads back <, > and & in class, edge and sequence labels', async () => {
    const cls = 'type: class\nnodes:\n  repo:\n    label: "Repository<T>"\n    members:\n      - "+find(id): List<T>"\n  b: { label: "A & B" }\nedges:\n  - "repo --> b: returns List<T> & more"\n  - "b --> repo: if x < 10 && y > 2"\n';
    const res = await build(cls, { out: at('cls.drawio.svg'), browser });
    expect(res.check.findings.filter((f) => f.level === 'error')).toEqual([]);
    const shown = spec(at('cls.drawio.svg'));
    for (const text of ['label: "Repository<T>"', '"+find(id): List<T>"', 'label: "A & B"', 'returns List<T> & more', 'if x < 10 && y > 2']) expect(shown).toContain(text);
    // What draw.io draws is the text, not a tag that swallowed it.
    const drawn = (await browser.inspect(readDrawio(fs.readFileSync(at('cls.drawio.svg'), 'utf8')).xml)).map((c) => c.label);
    expect(drawn).toContain('Repository<T>');
    expect(drawn).toContain('returns List<T> & more');

    const seq = 'type: sequence\nparticipants: { a: {}, b: {} }\nmessages:\n  - "a -> b: GET /users/<id>"\n  - "note over a, b: a <b>bold</b> & note"\n  - opt: "n < 3"\n    do:\n      - "b --> a: ok"\n';
    await build(seq, { out: at('seq.drawio.svg'), browser });
    const back = spec(at('seq.drawio.svg'));
    for (const text of ['GET /users/<id>', 'a <b>bold</b> & note', 'opt: n < 3']) expect(back).toContain(text);
    // And the trip is stable.
    await build(show(at('seq.drawio.svg')).yaml, { out: at('seq2.drawio.svg'), browser });
    expect(spec(at('seq2.drawio.svg'))).toBe(back);
  }, 60000);

  it('prints labels in lint messages as text', async () => {
    const res = await build('type: flow\nnodes:\n  a: { label: "A <b> & \\"q\\"" }\n  b: B\nedges:\n  - a -> b\n', { out: at('lint.drawio.svg'), browser });
    const cells = await browser.inspect(readDrawio(fs.readFileSync(res.out, 'utf8')).xml);
    expect(cells.map((c) => c.label)).toContain('A <b> & "q"');
  }, 30000);
});

describe.runIf(e2e)('round trips', () => {
  it('reads the tech of a c4 node, not the bracket line the style draws', async () => {
    const c4 = 'type: architecture\ntheme: c4\nnodes:\n  user: { kind: person }\n  api: { tech: Go }\nedges:\n  - user -> api: uses\n';
    await build(c4, { out: at('c4.drawio.svg'), browser });
    const once = spec(at('c4.drawio.svg'));
    expect(once).toContain('user: { kind: person }');
    expect(once).toContain('api: { tech: Go }');
    await build(show(at('c4.drawio.svg')).yaml, { out: at('c4.drawio.svg'), relayout: true, browser });
    expect(spec(at('c4.drawio.svg'))).toBe(once);
  }, 60000);

  it('drops a title the spec no longer has, when merging', async () => {
    const titled = 'type: flow\ntitle: Old title\nnodes: { a: A, b: B }\nedges:\n  - a -> b\n';
    await build(titled, { out: at('t.drawio.svg'), browser });
    const res = await build(titled.replace('title: Old title\n', ''), { out: at('t.drawio.svg'), keepLayout: true, browser });
    expect(res.mode).toBe('merge');
    expect(spec(at('t.drawio.svg'))).not.toContain('title');
  }, 60000);

  it('names the direction a merged diagram runs in', async () => {
    await build('type: flow\nnodes: { a: A, b: B }\nedges:\n  - a -> b\n', { out: at('dir.drawio.svg'), browser });
    const res = await build('type: flow\nnodes: { a: A, b: B, c: C }\nedges:\n  - a -> b\n  - b -> c\n', { out: at('dir.drawio.svg'), browser });
    expect(res.mode).toBe('merge');
    expect(res.direction).toBe('TB');
  }, 60000);

  it('lists icons every time it is asked, in one browser', async () => {
    const first = await listIcons('aws', 'lambda', browser);
    expect(first).toContain('lambda');
    expect(await listIcons('aws', 'lambda', browser)).toEqual(first);
  }, 60000);

  it('renders into a folder that does not exist yet', async () => {
    await build('type: flow\nnodes: { a: A, b: B }\nedges:\n  - a -> b\n', { out: at('r.drawio.svg'), browser });
    await render(at('r.drawio.svg'), at('new/dir/r.png'), browser);
    await render(at('r.drawio.svg'), at('new/dir2/r.excalidraw'), browser);
    expect(fs.existsSync(at('new/dir/r.png')) && fs.existsSync(at('new/dir2/r.excalidraw'))).toBe(true);
  }, 60000);
});

describe.runIf(e2e)('importing the same Excalidraw file again', () => {
  type Scene = ExcalidrawFile & { elements: any[] };
  /** Build an example, export it, apply `edit` to the scene, then import it `times` times. */
  async function trip(name: string, example: string, edit: (el: (id: string) => any, scene: Scene) => void, times = 3) {
    const out = at(`${name}.drawio.svg`), file = at(`${name}.excalidraw`);
    await build(fs.readFileSync(`examples/${example}.yaml`, 'utf8'), { out, browser });
    const scene = (await toExcalidraw(readDrawio(fs.readFileSync(out, 'utf8')), browser)) as Scene;
    edit((id) => {
      const e = scene.elements.find((x) => x.id === id);
      if (!e) throw new Error(`no element ${id}`);
      return e;
    }, scene);
    fs.writeFileSync(file, JSON.stringify(scene));
    const runs: string[][] = [];
    for (let i = 0; i < times; i++) runs.push((await importExcalidraw(file, out, { browser })).changes);
    return { out, runs };
  }
  const box = async (file: string, id: string) => (await browser.inspect(readDrawio(fs.readFileSync(file, 'utf8')).xml)).find((c) => c.id === id)!.box;

  it('keeps an arrow that was dragged to another box', async () => {
    const { out, runs } = await trip('reconnect', 'checkout', (el) => (el('lw-e_worker__email').endBinding.elementId = 'lw-stripe'));
    expect(runs[0]).toEqual(['the arrow from "Fulfillment worker" to "SendGrid" now runs from "Fulfillment worker" to "Stripe"']);
    expect(runs.slice(1)).toEqual([[], []]);
    expect(spec(out)).toContain('worker -> stripe: receipt');
  }, 90000);

  it('keeps an arrow that was turned around', async () => {
    const { out, runs } = await trip('reverse', 'checkout', (el) => Object.assign(el('lw-e_web__gw'), { startArrowhead: 'arrow', endArrowhead: null }));
    expect(runs[0]).toEqual(['the arrow from "Web app" to "API gateway" now points the other way']);
    expect(runs.slice(1)).toEqual([[], []]);
    expect(spec(out)).toContain('gw ==> web: HTTPS');
  }, 90000);

  it('keeps a column that was renamed', async () => {
    const { out, runs } = await trip('rename', 'shop-er', (el) => Object.assign(el('lw-products__sku-name'), { text: 'code', originalText: 'code' }));
    expect(runs[0]).toEqual(['renamed column "sku" to "code" in "Products"']);
    expect(runs.slice(1)).toEqual([[], []]);
    expect(spec(out)).toMatch(/- code: /);
  }, 90000);

  it('leaves the rest of a group where it was when one box in it is deleted', async () => {
    let before: Awaited<ReturnType<typeof box>> | undefined;
    const { out, runs } = await trip('delete', 'checkout', (_el, scene) => {
      for (const e of scene.elements) if (['cache', 'cache__icon'].includes(e.customData?.lw?.cell)) e.isDeleted = true;
    });
    expect(runs[0]).toEqual(['removed "Session cache"']);
    expect(runs.slice(1)).toEqual([[], []]);
    // The same example, untouched: db sits where it always did.
    await build(fs.readFileSync('examples/checkout.yaml', 'utf8'), { out: at('delete-ref.drawio.svg'), browser });
    before = await box(at('delete-ref.drawio.svg'), 'db');
    const after = await box(out, 'db');
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeLessThan(2);
  }, 90000);

  it('moves an arrow onto the box that replaced the one it pointed at', async () => {
    const { out, runs } = await trip('replace', 'checkout', (el, scene) => {
      const stripe = el('lw-stripe');
      for (const e of scene.elements) if (e.customData?.lw?.cell === 'stripe') e.isDeleted = true;
      const base = { angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, isDeleted: false, link: null, locked: false };
      scene.elements.push({ ...base, id: 'adyen', type: 'rectangle', x: stripe.x, y: stripe.y, width: stripe.width, height: stripe.height, boundElements: [{ id: 'adyen-t', type: 'text' }] });
      scene.elements.push({ ...base, id: 'adyen-t', type: 'text', x: stripe.x + 10, y: stripe.y + 10, width: 80, height: 25, boundElements: [], text: 'Adyen', originalText: 'Adyen', containerId: 'adyen', fontSize: 20, fontFamily: 5 });
      el('lw-e_api__stripe').endBinding.elementId = 'adyen';
    }, 2);
    expect(runs[0]!.join('\n')).toContain('now runs from "Checkout API" to "Adyen"');
    expect(runs[1]).toEqual([]);
    expect(spec(out)).toContain('api ==> adyen: charge');
    expect(spec(out)).not.toContain('stripe');
  }, 90000);

  it('reads a new arrow as running toward its head, and a dotted one as async', async () => {
    const { out, runs } = await trip('heads', 'checkout', (el, scene) => {
      const base = { angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, isDeleted: false, link: null, locked: false, type: 'arrow', boundElements: [] };
      const arrow = (id: string, from: any, to: any, over: object) => scene.elements.push({ ...base, id, x: from.x, y: from.y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y), points: [[0, 0], [to.x - from.x, to.y - from.y]], startBinding: { elementId: from.id, focus: 0, gap: 1 }, endBinding: { elementId: to.id, focus: 0, gap: 1 }, strokeStyle: 'solid', startArrowhead: null, endArrowhead: 'arrow', ...over });
      arrow('n1', el('lw-user'), el('lw-cache'), { startArrowhead: 'arrow', endArrowhead: null });
      arrow('n2', el('lw-user'), el('lw-db'), { strokeStyle: 'dotted' });
    });
    expect(runs[0]).toEqual(expect.arrayContaining(['added an arrow from "Session cache" to "Shopper"', 'added an arrow from "Shopper" to "Orders"']));
    expect(runs.slice(1)).toEqual([[], []]);
    expect(spec(out)).toContain('cache -> user');
    expect(spec(out)).toContain('user -.-> db');
  }, 90000);

  it('stops reporting a table as resized after a column was added', async () => {
    const { runs } = await trip('addcol', 'shop-er', (el, scene) => {
      const orders = el('lw-orders');
      scene.elements.push({ id: 'new-col', type: 'text', x: orders.x + 12, y: orders.y + orders.height + 8, width: 120, height: 20, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, isDeleted: false, link: null, locked: false, boundElements: [], text: 'notes text null', originalText: 'notes text null', containerId: null, fontSize: 16, fontFamily: 5 });
    });
    expect(runs[0]!.join('\n')).toContain('added column "notes" to "Orders"');
    expect(runs.slice(1)).toEqual([[], []]);
  }, 90000);

  it('keeps the color given to a message', async () => {
    const { out, runs } = await trip('msgcolor', 'pay-sequence', (_el, scene) => {
      const arrow = scene.elements.find((e) => e.type === 'arrow' && scene.elements.some((t) => t.containerId === e.id && /mark paid/i.test(t.text ?? '')))
        ?? scene.elements.find((e) => e.type === 'arrow' && e.customData?.lw);
      arrow.strokeColor = '#e03131';
    });
    expect(runs[0]!.join('\n')).toMatch(/the message ".*" is now red/);
    expect(runs.slice(1)).toEqual([[], []]);
    expect(spec(out)).toMatch(/color: red/);
  }, 90000);

  it('grows a group once around a box dropped at its edge', async () => {
    const { out, runs } = await trip('intogroup', 'checkout', (el, scene) => {
      const data = el('lw-data'), stripe = el('lw-stripe');
      const dx = data.x + 10 - stripe.x, dy = data.y + data.height - 70 - stripe.y;
      for (const e of scene.elements) if (e.customData?.lw?.cell === 'stripe') Object.assign(e, { x: e.x + dx, y: e.y + dy });
    });
    expect(runs[0]![0]).toBe('moved "Stripe" into data');
    expect(runs.slice(1)).toEqual([[], []]);
    expect(spec(out)).toContain('stripe: { kind: external, tech: Payments API, in: data }');
  }, 90000);

  it('refuses a file with every box deleted, and says why', async () => {
    await expect(trip('empty', 'checkout', (_el, scene) => {
      for (const e of scene.elements) if (e.customData?.lw?.part !== 'title' && !/^(vpc|data)$/.test(e.customData?.lw?.cell ?? '')) e.isDeleted = true;
    }, 1)).rejects.toThrow(/every box is gone|not written by linework/);
  }, 90000);
});
