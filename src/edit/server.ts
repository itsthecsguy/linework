// `aiviz edit`: open a diagram in the bundled draw.io editor, in the user's own
// browser, and write saves back to the same file. Uses draw.io's JSON embed
// protocol, the one the VS Code extension uses, so saved files are what
// draw.io itself writes. Everything is served from 127.0.0.1; nothing goes online.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { extractMxfile } from '../drawio/read.js';
import { assetsDir } from '../render/browser.js';
import { FACES, embedFonts, fontFaceCss, fontsDir } from '../render/fonts.js';

export interface EditResult {
  /** Times the file was written. */
  saves: number;
  /** Where a save went instead, because the file changed on disk while it was open. */
  conflicts: string[];
}

export interface EditSession {
  url: string;
  /** Resolves when the user exits the editor or closes the tab. */
  done: Promise<EditResult>;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'text/xml',
};

const EMBED_PARAMS = 'embed=1&proto=json&spin=1&libraries=1&noSaveBtn=0&noExitBtn=0&offline=1&pwa=0&stealth=1&lang=en&dev=0';

function hostPage(name: string, xml: string, mtime: number, token: string, format: 'svg' | 'xml') {
  // JSON inside a <script>: escape "<" so a label containing "</script>" can't end the tag.
  const data = JSON.stringify({ name, xml, mtime, format }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name.replace(/[<&]/g, '')} - aiviz edit</title>
<style>html,body{margin:0;height:100%;overflow:hidden;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
iframe{border:0;width:100%;height:100%} #msg{display:none;padding:48px;color:#334155}</style></head>
<body><iframe id="f" src="/app/index.html?${EMBED_PARAMS}"></iframe><div id="msg"></div>
<script>
const D = ${data};
const base = '/${token}';
const f = document.getElementById('f');
const send = (m) => f.contentWindow.postMessage(JSON.stringify(m), '*');
let pending = null; // the save waiting for its export
async function post(p, body) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
}
function finish(text) {
  f.remove();
  const m = document.getElementById('msg');
  m.style.display = 'block';
  m.textContent = text;
  post('/exit');
}
async function write(payload, exit) {
  const res = await post('/save', { ...payload, mtime: D.mtime });
  if (res.ok) {
    D.mtime = res.body.mtime;
    send({ action: 'status', message: 'Saved to ' + D.name, modified: false });
    if (exit) finish('Saved ' + D.name + '. You can close this tab.');
  } else {
    send({ action: 'dialog', title: 'Not saved to ' + D.name, message: res.body.error || 'save failed', button: 'OK' });
  }
}
window.addEventListener('message', (e) => {
  if (e.source !== f.contentWindow || typeof e.data !== 'string') return;
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.event === 'init') send({ action: 'load', xml: D.xml, title: D.name, autosave: 0, modified: 'unsavedChanges' });
  else if (m.event === 'save') {
    if (D.format === 'xml') write({ xml: m.xml }, m.exit);
    else { pending = { exit: m.exit }; send({ action: 'export', format: 'xmlsvg', xml: m.xml, spinKey: 'saving' }); }
  } else if (m.event === 'export' && pending) {
    const p = pending; pending = null;
    write({ data: m.data }, p.exit);
  } else if (m.event === 'exit') finish('Closed ' + D.name + '. You can close this tab.');
});
window.addEventListener('pagehide', () => navigator.sendBeacon(base + '/closed'));
</script></body></html>`;
}

export async function startEditor(file: string, opts: { port?: number } = {}): Promise<EditSession> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`${file} doesn't exist. Create it with aiviz build first.`);
  const format: 'svg' | 'xml' = abs.endsWith('.svg') ? 'svg' : 'xml';
  extractMxfile(fs.readFileSync(abs, 'utf8')); // fail early on files draw.io can't open
  const assets = assetsDir();
  if (!fs.existsSync(path.join(assets, 'index.html'))) throw new Error('aiviz: the bundled draw.io editor is missing (assets/drawio/index.html). Reinstall aiviz.');
  const token = crypto.randomBytes(16).toString('hex');
  const result: EditResult = { saves: 0, conflicts: [] };
  let resolveDone!: (r: EditResult) => void;
  const done = new Promise<EditResult>((r) => (resolveDone = r));
  let closeTimer: NodeJS.Timeout | undefined;
  let finished = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === `/${token}/` || url.pathname === `/${token}`) {
      clearTimeout(closeTimer); // a reload, not a close
      const text = fs.readFileSync(abs, 'utf8');
      res.writeHead(200, { 'content-type': TYPES['.html']!, 'cache-control': 'no-store' });
      return void res.end(hostPage(path.basename(abs), extractMxfile(text), fs.statSync(abs).mtimeMs, token, format));
    }
    if (req.method === 'POST' && url.pathname.startsWith(`/${token}/`)) {
      const action = url.pathname.slice(token.length + 2);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          if (action === 'save') {
            const msg = JSON.parse(body) as { data?: string; xml?: string; mtime: number };
            let content = msg.data ? decodeDataUri(msg.data) : msg.xml;
            // draw.io writes a fresh SVG without our fonts; put them back so the file
            // still renders in the diagram's typeface everywhere.
            if (content && msg.data) content = await embedFonts(content);
            if (!content) return json(400, { error: 'empty save' });
            let target = abs;
            if (fs.statSync(abs).mtimeMs !== msg.mtime) {
              // Someone (often an agent running aiviz build) changed the file while it was open.
              target = conflictPath(abs);
              result.conflicts.push(target);
            }
            fs.writeFileSync(target, content);
            result.saves++;
            if (target !== abs)
              return json(409, { error: `${path.basename(abs)} changed on disk after you opened it, so your version went to ${path.basename(target)} instead. Reload this page to edit the new version.` });
            return json(200, { mtime: fs.statSync(abs).mtimeMs });
          }
          if (action === 'exit') {
            json(200, {});
            return void finish();
          }
          if (action === 'closed') {
            json(200, {});
            closeTimer = setTimeout(finish, 3000);
            return;
          }
          json(404, { error: 'unknown action' });
        } catch (e) {
          json(500, { error: (e as Error).message });
        }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/aiviz-fonts/')) {
      const f = FACES.find((x) => `/aiviz-fonts/${x.file}` === url.pathname);
      if (!f) {
        res.writeHead(404);
        return void res.end();
      }
      res.writeHead(200, { 'content-type': 'font/woff2' });
      return void fs.createReadStream(path.join(fontsDir(), f.file)).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/app/index.html') {
      // The editor shows labels in the diagram's own fonts.
      const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replace('</head>', `<style>${fontFaceCss((f) => `/aiviz-fonts/${f}`)}</style></head>`);
      res.writeHead(200, { 'content-type': TYPES['.html']! });
      return void res.end(html);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/app/')) {
      const rel = path.normalize(decodeURIComponent(url.pathname.slice(5)));
      const p = path.join(assets, rel);
      if (!p.startsWith(assets + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
        res.writeHead(404);
        return void res.end();
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
      return void fs.createReadStream(p).pipe(res);
    }
    res.writeHead(404);
    res.end();
  });

  function finish() {
    if (finished) return;
    finished = true;
    server.close();
    server.closeAllConnections();
    resolveDone(result);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/${token}/`, done, close: async () => finish() };
}

function decodeDataUri(uri: string): string {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return uri;
  return m[1] ? Buffer.from(m[2]!, 'base64').toString('utf8') : decodeURIComponent(m[2]!);
}

function conflictPath(abs: string): string {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const m = /^(.*?)((?:\.drawio)?\.(?:svg|drawio|xml))$/.exec(abs);
  return m ? `${m[1]}.edited-${stamp}${m[2]}` : `${abs}.edited-${stamp}`;
}

/** Opens a URL in the user's default browser. Best effort. */
export function openInBrowser(url: string): boolean {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
