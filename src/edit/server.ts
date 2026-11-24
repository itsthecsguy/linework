// `linework edit`: open a diagram in the bundled draw.io editor, in the user's own
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
import { activeConfig, useConfig, useConfigFor } from '../config.js';

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

function isDarkCanvas(xml: string): boolean {
  const m = /\bbackground="(#?[0-9a-fA-F]{6})"/i.exec(xml);
  if (!m) return false;
  const h = m[1]!.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.35;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hostPage(name: string, xml: string, mtime: number, token: string, format: 'svg' | 'xml') {
  // JSON inside a <script>: escape "<" so a label containing "</script>" can't end the tag.
  const data = JSON.stringify({ name, xml, mtime, format }).replace(/</g, '\\u003c');
  const dark = isDarkCanvas(xml);
  const params = `${EMBED_PARAMS}&dark=${dark ? '1' : 'auto'}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(name)} - linework edit</title>
<style>
:root{--bg:#f8fafc;--card:#ffffff;--border:#e2e8f0;--text:#0f172a;--muted:#475569;--btn:#f1f5f9;--btn-hover:#e2e8f0;--pri:#2563eb;--pri-hover:#1d4ed8;--warn-bg:#fef3c7;--warn-border:#f59e0b;--warn-text:#78350f;--err-bg:#fee2e2;--err-border:#ef4444;--err-text:#7f1d1d}
@media(prefers-color-scheme:dark){:root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#f1f5f9;--muted:#94a3b8;--btn:#334155;--btn-hover:#475569;--pri:#3b82f6;--pri-hover:#2563eb;--warn-bg:#451a03;--warn-border:#d97706;--warn-text:#fde68a;--err-bg:#450a0a;--err-border:#dc2626;--err-text:#fecaca}}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column}
iframe{border:0;width:100%;flex:1;min-height:0}
#banner{display:none;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px;border-bottom:1px solid var(--warn-border);background:var(--warn-bg);color:var(--warn-text);font-size:13px}
#banner.show{display:flex}
#banner.error{border-bottom-color:var(--err-border);background:var(--err-bg);color:var(--err-text)}
#banner .txt{display:flex;flex-direction:column;gap:2px}
#banner .title{font-weight:600}
#banner .actions{display:flex;gap:8px;flex-shrink:0}
#banner button{cursor:pointer;border:1px solid var(--border);background:var(--card);color:var(--text);padding:4px 10px;border-radius:6px;font:12px/1.4 inherit;font-weight:500}
#banner button:hover{background:var(--btn-hover)}
#banner button.primary{background:var(--pri);border-color:var(--pri);color:#fff}
#banner button.primary:hover{background:var(--pri-hover)}
#msg{display:none;flex:1;align-items:center;justify-content:center;padding:24px}
#msg.show{display:flex}
#msg .card{max-width:440px;width:100%;padding:28px 32px;background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.08);text-align:center}
#msg .card p{margin:0;color:var(--text);font-size:15px}
</style></head>
<body>
<div id="banner" role="alert"><div class="txt"><span class="title" id="b-title"></span><span id="b-detail"></span></div><div class="actions" id="b-actions"></div></div>
<iframe id="f" src="/app/index.html?${params}"></iframe>
<div id="msg"><div class="card"><p id="msg-text"></p></div></div>
<script>
const D = ${data};
const base = '/${token}';
const f = document.getElementById('f');
const banner = document.getElementById('banner');
const bTitle = document.getElementById('b-title');
const bDetail = document.getElementById('b-detail');
const bActions = document.getElementById('b-actions');
const send = (m) => f.contentWindow && f.contentWindow.postMessage(JSON.stringify(m), location.origin);
let pending = null; // the save waiting for its export
let dirty = false;
let lastXml = D.xml;
let lastPayload = null;
let lastExit = false;
let es = null;

function showBanner(kind, title, detail, actions) {
  banner.className = 'show' + (kind === 'error' ? ' error' : '');
  bTitle.textContent = title || '';
  bDetail.textContent = detail || '';
  bDetail.style.display = detail ? 'inline' : 'none';
  bActions.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    if (a.primary) btn.className = 'primary';
    btn.addEventListener('click', a.onClick);
    bActions.appendChild(btn);
  }
}
function hideBanner() {
  banner.className = '';
  bActions.innerHTML = '';
}
function decodeDataUri(uri) {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return uri;
  if (!m[1]) return decodeURIComponent(m[2]);
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function downloadBackup() {
  let text = lastXml || D.xml;
  let mime = 'application/xml;charset=utf-8';
  let filename = D.name;
  if (lastPayload && lastPayload.data) {
    text = decodeDataUri(lastPayload.data);
    mime = 'image/svg+xml;charset=utf-8';
  } else if (lastPayload && lastPayload.xml) {
    text = lastPayload.xml;
  } else if (D.format === 'svg' && !filename.endsWith('.xml')) {
    filename = filename.replace(/\\.svg$/i, '.xml');
  }
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function post(p, body) {
  try {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { ok: r.ok, status: r.status, networkError: false, body: await r.json().catch(() => ({})) };
  } catch (err) {
    return { ok: false, status: 0, networkError: true, body: { error: String((err && err.message) || err || 'connection lost') } };
  }
}
async function reloadLatest() {
  try {
    const r = await fetch(base + '/latest', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const body = await r.json();
    D.xml = body.xml;
    D.mtime = body.mtime;
    lastXml = body.xml;
    dirty = false;
    hideBanner();
    send({ action: 'load', xml: D.xml, title: D.name, autosave: 1, modified: 'unsavedChanges' });
    send({ action: 'status', message: 'Reloaded latest ' + D.name, modified: false });
  } catch (err) {
    showBanner('error', 'Could not reload ' + D.name, String((err && err.message) || err), [
      { label: 'Download backup', primary: true, onClick: downloadBackup },
      { label: 'Dismiss', onClick: hideBanner },
    ]);
  }
}
function finish(text) {
  dirty = false;
  if (es) { try { es.close(); } catch {} es = null; }
  hideBanner();
  f.remove();
  const m = document.getElementById('msg');
  document.getElementById('msg-text').textContent = text;
  m.className = 'show';
  post('/exit');
}
async function write(payload, exit, force) {
  lastPayload = payload;
  lastExit = !!exit;
  const res = await post('/save', { ...payload, mtime: D.mtime, ...(force ? { force: true } : {}) });
  send({ action: 'spinner', show: false });
  if (res.ok) {
    D.mtime = res.body.mtime;
    dirty = false;
    hideBanner();
    send({ action: 'status', message: 'Saved to ' + D.name, modified: false });
    if (exit) finish('Saved ' + D.name + '. You can close this tab.');
  } else if (res.networkError) {
    send({ action: 'status', message: 'Disconnected from linework edit server', modified: true });
    showBanner('error', 'Disconnected from linework edit server', 'Your changes were not written to ' + D.name + '. Download a backup or restart linework edit.', [
      { label: 'Download backup', primary: true, onClick: downloadBackup },
      { label: 'Retry save', onClick: () => write(lastPayload, lastExit, false) },
      { label: 'Dismiss', onClick: hideBanner },
    ]);
  } else if (res.status === 409 && res.body.conflict) {
    send({ action: 'status', message: 'Saved copy to ' + res.body.conflict, modified: false });
    showBanner('warn', 'Saved copy to ' + res.body.conflict, res.body.error || (D.name + ' changed on disk while open.'), [
      { label: 'Reload latest', primary: true, onClick: reloadLatest },
      { label: 'Overwrite original', onClick: () => write(payload, exit, true) },
      { label: 'Dismiss', onClick: hideBanner },
    ]);
  } else {
    showBanner('error', 'Save failed for ' + D.name, res.body.error || 'save failed', [
      { label: 'Download backup', primary: true, onClick: downloadBackup },
      { label: 'Dismiss', onClick: hideBanner },
    ]);
  }
}
window.addEventListener('message', (e) => {
  if (e.source !== f.contentWindow || typeof e.data !== 'string') return;
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.event === 'init') send({ action: 'load', xml: D.xml, title: D.name, autosave: 1, modified: 'unsavedChanges' });
  else if (m.event === 'autosave') {
    dirty = true;
    if (m.xml) lastXml = m.xml;
  } else if (m.event === 'save') {
    if (m.xml) lastXml = m.xml;
    if (D.format === 'xml') write({ xml: m.xml }, m.exit, false);
    else { pending = { exit: m.exit }; send({ action: 'export', format: 'xmlsvg', xml: m.xml, spinKey: 'saving' }); }
  } else if (m.event === 'export' && pending) {
    const p = pending; pending = null;
    write({ data: m.data }, p.exit, false);
  } else if (m.event === 'exit') finish('Closed ' + D.name + '. You can close this tab.');
});
window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = '';
});
window.addEventListener('pagehide', () => navigator.sendBeacon(base + '/closed'));
if (typeof EventSource !== 'undefined') {
  es = new EventSource(base + '/events');
  es.addEventListener('changed', (ev) => {
    let info; try { info = JSON.parse(ev.data); } catch { return; }
    if (info && info.mtime !== D.mtime) {
      showBanner('warn', D.name + ' changed on disk', 'Another tool updated this file while it was open.', [
        { label: 'Reload latest', primary: true, onClick: reloadLatest },
        { label: 'Keep editing', onClick: hideBanner },
      ]);
    }
  });
}
</script></body></html>`;
}

export async function startEditor(file: string, opts: { port?: number } = {}): Promise<EditSession> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`${file} doesn't exist. Create it with linework build first.`);
  const cfg = useConfigFor(abs);
  const customFaces = activeConfig().fonts.map((f, i) => ({
    ...f,
    route: `/aiviz-fonts/custom-${i}${path.extname(f.file).toLowerCase()}`,
  }));
  const format: 'svg' | 'xml' = abs.endsWith('.svg') ? 'svg' : 'xml';
  extractMxfile(fs.readFileSync(abs, 'utf8')); // fail early on files draw.io can't open
  const assets = assetsDir();
  if (!fs.existsSync(path.join(assets, 'index.html'))) throw new Error('linework: the bundled draw.io editor is missing (assets/drawio/index.html). Reinstall linework.');
  const token = crypto.randomBytes(16).toString('hex');
  const result: EditResult = { saves: 0, conflicts: [] };
  let resolveDone!: (r: EditResult) => void;
  const done = new Promise<EditResult>((r) => (resolveDone = r));
  let closeTimer: NodeJS.Timeout | undefined;
  let finished = false;
  let lastKnownMtime = fs.statSync(abs).mtimeMs;
  let lastConflict: { diskMtime: number; target: string } | undefined;
  const sseClients = new Set<http.ServerResponse>();
  let diskWatcher: fs.FSWatcher | undefined;
  let pollTimer: NodeJS.Timeout | undefined;

  const checkDiskChange = () => {
    if (finished || !sseClients.size) return;
    let m: number;
    try {
      m = fs.statSync(abs).mtimeMs;
    } catch {
      return;
    }
    if (m !== lastKnownMtime) {
      lastKnownMtime = m;
      const payload = `event: changed\ndata: ${JSON.stringify({ mtime: m })}\n\n`;
      for (const client of sseClients) {
        try {
          client.write(payload);
        } catch {
          sseClients.delete(client);
        }
      }
    }
  };

  const ensureWatchingDisk = () => {
    if (finished) return;
    if (!diskWatcher) {
      try {
        diskWatcher = fs.watch(path.dirname(abs), (_event, name) => {
          if (name && path.basename(abs) !== name.toString()) return;
          checkDiskChange();
        });
        diskWatcher.on('error', () => {
          try { diskWatcher?.close(); } catch {}
          diskWatcher = undefined;
        });
      } catch {
        // Fallback polling below still detects disk updates.
      }
    }
    if (!pollTimer) {
      pollTimer = setInterval(checkDiskChange, 2000);
      pollTimer.unref();
    }
  };

  const server = http.createServer((req, res) => {
    // One bad request (a malformed URL, the file moved away) must not take the
    // process down: under the MCP server that would end every other tool too.
    try {
      handle(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(e instanceof URIError ? 400 : 500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(e instanceof URIError ? 'bad request' : `linework edit: ${(e as Error).message}`);
    }
  });
  const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && (url.pathname === `/${token}/` || url.pathname === `/${token}`)) {
      clearTimeout(closeTimer); // a reload, not a close
      const text = fs.readFileSync(abs, 'utf8');
      const mtime = fs.statSync(abs).mtimeMs;
      lastKnownMtime = mtime;
      res.writeHead(200, { 'content-type': TYPES['.html']!, 'cache-control': 'no-store' });
      return void res.end(hostPage(path.basename(abs), extractMxfile(text), mtime, token, format));
    }
    if (req.method === 'GET' && url.pathname === `/${token}/latest`) {
      const text = fs.readFileSync(abs, 'utf8');
      const mtime = fs.statSync(abs).mtimeMs;
      lastKnownMtime = mtime;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify({ xml: extractMxfile(text), mtime }));
    }
    if (req.method === 'GET' && url.pathname === `/${token}/events`) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(': ok\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      ensureWatchingDisk();
      checkDiskChange();
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith(`/${token}/`)) {
      const action = url.pathname.slice(token.length + 2);
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          if (action === 'save') {
            const msg = JSON.parse(body) as { data?: string; xml?: string; mtime: number; force?: boolean };
            let content = msg.data ? decodeDataUri(msg.data) : msg.xml;
            // draw.io writes a fresh SVG without our fonts; put them back so the file
            // still renders in the diagram's typeface everywhere.
            if (content && msg.data) {
              useConfig(cfg);
              content = await embedFonts(content);
            }
            if (!content) return json(400, { error: 'empty save' });
            const diskMtime = fs.statSync(abs).mtimeMs;
            if (!msg.force && diskMtime !== msg.mtime) {
              // Someone (often an agent running linework build) changed the file while it was open.
              // Reuse the same conflict copy on repeat saves against the same disk version.
              let target: string;
              if (lastConflict && lastConflict.diskMtime === diskMtime) {
                target = lastConflict.target;
              } else {
                target = conflictPath(abs);
                lastConflict = { diskMtime, target };
                result.conflicts.push(target);
                result.saves++;
              }
              fs.writeFileSync(target, content);
              return json(409, {
                conflict: path.basename(target),
                mtime: diskMtime,
                error: `${path.basename(abs)} changed on disk after you opened it, so your version went to ${path.basename(target)} instead. Reload latest or overwrite the original.`,
              });
            }
            fs.writeFileSync(abs, content);
            const nextMtime = fs.statSync(abs).mtimeMs;
            lastKnownMtime = nextMtime;
            lastConflict = undefined;
            result.saves++;
            return json(200, { mtime: nextMtime });
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
      if (f) {
        res.writeHead(200, { 'content-type': 'font/woff2' });
        return void fs.createReadStream(path.join(fontsDir(), f.file)).pipe(res);
      }
      const cf = customFaces.find((x) => x.route === url.pathname);
      if (cf && fs.existsSync(cf.file)) {
        const ext = path.extname(cf.file).toLowerCase();
        const type = ext === '.woff2' ? 'font/woff2' : ext === '.ttf' ? 'font/ttf' : ext === '.otf' ? 'font/otf' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        return void fs.createReadStream(cf.file).pipe(res);
      }
      res.writeHead(404);
      return void res.end();
    }
    if (req.method === 'GET' && url.pathname === '/app/index.html') {
      // The editor shows labels in the diagram's own fonts.
      const extraCss = customFaces
        .map((f) => {
          const ext = path.extname(f.file).toLowerCase();
          const fmt = ext === '.ttf' ? 'truetype' : ext === '.otf' ? 'opentype' : 'woff2';
          return `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;src:url(${f.route}) format("${fmt}");}`;
        })
        .join('\n');
      const css = [fontFaceCss((f) => `/aiviz-fonts/${f}`), extraCss].filter(Boolean).join('\n');
      const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').replace('</head>', `<style>${css}</style></head>`);
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
  };

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(closeTimer);
    if (pollTimer) clearInterval(pollTimer);
    try {
      diskWatcher?.close();
    } catch {
      // already closed
    }
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // already closed
      }
    }
    sseClients.clear();
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
  const make = (suffix: string) => (m ? `${m[1]}.edited-${stamp}${suffix}${m[2]}` : `${abs}.edited-${stamp}${suffix}`);
  let candidate = make('');
  for (let i = 2; fs.existsSync(candidate); i++) candidate = make(`-${i}`);
  return candidate;
}

/**
 * Opens a URL in the user's default browser. Resolves false when there is no
 * way to (no xdg-open: a container, an SSH session, an agent's sandbox), so the
 * caller can tell the user to open the link themselves.
 */
export function openInBrowser(url: string): Promise<boolean> {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.WSL_DISTRO_NAME) {
    return Promise.resolve(false);
  }
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    try {
      const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
      // A missing opener arrives as an 'error' event, not a throw.
      child.once('error', () => done(false));
      child.once('exit', (code) => done(code === 0));
      child.once('spawn', () => {
        timer = setTimeout(() => done(true), 150);
        timer.unref();
      });
      child.unref();
    } catch {
      done(false);
    }
  });
}
