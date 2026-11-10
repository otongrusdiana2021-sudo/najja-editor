#!/usr/bin/env node
// Najja Editor server — serves the web app, bridges MCP tool calls to the open editor tab,
// and exposes an MCP endpoint (Streamable HTTP) at /mcp. Zero dependencies.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, formatToolResult } from './mcp/protocol.js';
import { TOOLS } from './mcp/tools.js';
import { createStorage } from './lib/storage.js';
import { createAuth } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.NAJJA_DATA_DIR || path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'media-cache');
const EXPORT_DIR = process.env.NAJJA_EXPORT_DIR || path.join(DATA_DIR, 'exports');
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

export const DEFAULT_PORT = Number(process.env.PORT || process.env.NAJJA_PORT || 3333);
export const DEFAULT_HOST = process.env.HOST || process.env.NAJJA_HOST || '127.0.0.1';

// Security / deployment settings
const TOKEN = process.env.NAJJA_TOKEN || '';
const INSECURE_PUBLIC = process.env.NAJJA_INSECURE_PUBLIC === '1';
const ALLOW_ORIGINS = (process.env.NAJJA_ALLOW_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const EXTRA_HOSTS = (process.env.NAJJA_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const MEDIA_ROOT = process.env.NAJJA_MEDIA_DIR ? path.resolve(process.env.NAJJA_MEDIA_DIR) : (TOKEN ? path.join(DATA_DIR, 'media') : '');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// All logging goes to stderr so the stdio MCP transport (which reuses this module) keeps stdout clean.
const log = (...args) => console.error('[najja]', ...args);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
};
const EXT_FROM_MIME = Object.fromEntries(Object.entries(MIME).map(([ext, mime]) => [mime.split(';')[0], ext]));
EXT_FROM_MIME['audio/mp3'] = '.mp3';
EXT_FROM_MIME['audio/x-wav'] = '.wav';
EXT_FROM_MIME['image/jpg'] = '.jpg';

/** Safe media file extension from a file name or MIME type. */
function extFor(filename, mime) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (MIME[ext] && /^(video|image|audio)\//.test(MIME[ext])) return ext;
  return EXT_FROM_MIME[String(mime || '').split(';')[0].trim().toLowerCase()] || '.bin';
}
const storage = createStorage(DATA_DIR, { exportDir: EXPORT_DIR, extFor });
storage.cleanupUploads().catch(() => {});
setInterval(() => storage.cleanupUploads().catch(() => {}), 6 * 3600 * 1000).unref();

const TOOL_TIMEOUTS = { import_media: 180_000, get_frame: 45_000, export_video: 20_000, new_project: 20_000 };

function openBrowser(url) {
  if (process.env.NAJJA_NO_OPEN === '1') return false;
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Bridge: forwards tool calls to the editor tab over Server-Sent Events, results come back via POST.
class Bridge {
  constructor(publicUrl) {
    this.publicUrl = publicUrl;
    this.clients = new Map();
    this.pending = new Map();
    this.mcpClients = [];
    this.openedAt = 0;
    this.waiters = new Set();
  }
  addClient(id, res, info) {
    const old = this.clients.get(id);
    if (old) try { old.res.end(); } catch { /* ignore */ }
    this.clients.set(id, { id, res, since: Date.now(), activeAt: Date.now(), info });
    this.send(id, 'hello', { clientId: id, server: { name: PKG.name, version: PKG.version }, mcpClients: this.mcpClients });
    for (const w of this.waiters) w();
    log(`editor connected (${this.clients.size} open)`);
  }
  removeClient(id, res) {
    const c = this.clients.get(id);
    if (!c || (res && c.res !== res)) return;
    this.clients.delete(id);
    for (const [reqId, p] of this.pending) {
      if (p.clientId === id) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
        p.reject(new Error('The editor tab was closed while the command was running.'));
      }
    }
    log(`editor disconnected (${this.clients.size} open)`);
  }
  touch(id) {
    const c = this.clients.get(id);
    if (c) c.activeAt = Date.now();
  }
  pick() {
    let best = null;
    for (const c of this.clients.values()) if (!best || c.activeAt > best.activeAt) best = c;
    return best;
  }
  send(id, event, data) {
    const c = this.clients.get(id);
    if (!c) return false;
    try {
      c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }
  broadcast(event, data) {
    for (const id of this.clients.keys()) this.send(id, event, data);
  }
  noteMcpClient(info, protocolVersion, transport) {
    const entry = { name: info?.name || 'MCP client', version: info?.version || '', protocolVersion, transport, at: Date.now() };
    this.mcpClients = [entry, ...this.mcpClients.filter((c) => !(c.name === entry.name && c.transport === transport))].slice(0, 8);
    this.broadcast('mcp-client', entry);
  }
  waitForClient(ms) {
    if (this.clients.size) return Promise.resolve(this.pick());
    if (!TOKEN && Date.now() - this.openedAt > 60_000) {
      this.openedAt = Date.now();
      if (openBrowser(this.publicUrl)) log(`opening the editor in your browser: ${this.publicUrl}`);
    }
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(this.pick()); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
  async request(tool, args, timeoutMs = 30_000) {
    let client = this.pick() || (await this.waitForClient(Number(process.env.NAJJA_EDITOR_WAIT_MS || 20_000)));
    if (!client) {
      throw new Error(`Najja Editor is not open in a browser. Open ${this.publicUrl} and try again.`);
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The editor did not answer within ${Math.round(timeoutMs / 1000)}s (${tool}). Make sure the editor tab is open and not frozen.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, clientId: client.id });
      if (!this.send(client.id, 'command', { id, tool, args })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Could not reach the editor tab.'));
      }
    });
  }
  resolveResult(id, payload) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (payload.error) p.reject(new Error(payload.error));
    else p.resolve(payload.result ?? {});
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
const hostnameOf = (h) => { try { return new URL(`http://${h}`).hostname.toLowerCase(); } catch { return ''; } };
const requestHost = (req) => String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();

/** Browser Origin check. Non-browser clients send no Origin. "null" (sandboxed iframes, file://) is refused. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOW_ORIGINS.includes('*')) return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (LOOPBACK.has(u.hostname) && LOOPBACK.has(hostnameOf(requestHost(req)))) return true;
  if (TOKEN && u.host.toLowerCase() === requestHost(req)) return true; // same-origin behind a reverse proxy
  return ALLOW_ORIGINS.includes(u.origin) || ALLOW_ORIGINS.includes(u.host);
}

/** Without a token the server is local-only: refuse other Host names (DNS rebinding) and proxied traffic. */
function hostAllowed(req) {
  if (TOKEN || INSECURE_PUBLIC) return true;
  if (req.headers['x-forwarded-for'] || req.headers.forwarded) return false;
  const h = hostnameOf(req.headers.host || '');
  return LOOPBACK.has(h) || EXTRA_HOSTS.includes(h);
}

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => !!a && !!b && crypto.timingSafeEqual(sha(a), sha(b));
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
  }
  return out;
}
let accounts = null; // created in createNajjaServer when NAJJA_TOKEN is set
/** Who is calling: the token (MCP/API clients), a logged-in email account, or local mode. */
async function authenticate(req) {
  if (!TOKEN) return { role: 'admin', via: 'local' };
  const h = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(h) && safeEqual(h.replace(/^bearer\s+/i, '').trim(), TOKEN)) return { role: 'admin', via: 'token' };
  const user = await accounts.verifySession(parseCookies(req).najja_auth);
  return user ? { email: user.email, role: user.role, via: 'session' } : null;
}
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isHttps = (req) => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const loginFailures = new Map();

function loginPage(mode, { error = '', email = '' } = {}) {
  const setup = mode === 'setup';
  const field = (id, label, type, extra = '') => `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" ${extra}>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${setup ? 'Buat akun' : 'Masuk'} · Najja Editor</title>
<meta name="theme-color" content="#0b0b0d"><link rel="icon" href="/favicon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Poppins,system-ui,sans-serif;background:radial-gradient(1200px 600px at 50% -10%,#1d1838 0,#0b0b0d 60%);color:#f2f2f5;padding:16px}
form{width:min(380px,100%);background:#141417;border:1px solid #2b2b31;border-radius:18px;padding:28px 24px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.b{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600;margin-bottom:4px}.b span{background:linear-gradient(135deg,#7c6cff,#22d3c5);-webkit-background-clip:text;background-clip:text;color:transparent}
h1{margin:4px 0 0;font-size:20px;font-weight:600}p{margin:0 0 6px;color:#9a9aa6;font-size:13px;line-height:1.5}label{font-size:12px;color:#b6b6c0;margin-top:4px}
input{height:44px;border-radius:10px;border:1px solid #2b2b31;background:#1b1b1f;color:#fff;padding:0 12px;font:inherit;font-size:14px;transition:border-color .15s}
input:focus{outline:none;border-color:#7c6cff}button{height:44px;margin-top:10px;border:0;border-radius:10px;background:linear-gradient(135deg,#7c6cff,#22d3c5);color:#fff;font:600 14px Poppins,sans-serif;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(1.08)}.e{color:#ff6b81;font-size:12.5px;background:rgba(255,77,109,.1);border-radius:8px;padding:8px 10px}small{color:#75757f;font-size:11.5px;line-height:1.5}code{background:#232328;border-radius:5px;padding:1px 5px;font-size:11px}</style></head><body>
<form method="post" action="/login"><div class="b"><svg viewBox="0 0 32 32" width="30" height="30"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7b6cff"/><stop offset="1" stop-color="#22d3c5"/></linearGradient></defs><rect x="1" y="1" width="30" height="30" rx="9" fill="url(#g)"/><path d="M10 22V10l7.2 8.4V10M21.5 10v12" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>Najja <span>Editor</span></div>
${setup
    ? `<h1>Buat akun admin</h1><p>Sekali saja di awal. Setelah ini kamu masuk dengan email dan password.</p>
${field('email', 'Email', 'email', `autocomplete="email" required autofocus value="${escHtml(email)}"`)}
${field('password', 'Password (min. 8 karakter)', 'password', 'autocomplete="new-password" minlength="8" required')}
${field('password2', 'Ulangi password', 'password', 'autocomplete="new-password" minlength="8" required')}
${field('token', 'Token server', 'password', 'autocomplete="off" required')}
<small>Token server ada di VPS: <code>grep NAJJA_TOKEN /opt/najja-editor/.env</code>. Ini memastikan hanya pemilik VPS yang bisa membuat akun admin.</small>`
    : `<h1>Masuk</h1><p>Masuk ke editor dengan akun kamu.</p>
${field('email', 'Email', 'email', `autocomplete="username" required ${email ? '' : 'autofocus'} value="${escHtml(email)}"`)}
${field('password', 'Password', 'password', `autocomplete="current-password" required ${email ? 'autofocus' : ''}`)}`}
${error ? `<div class="e">${escHtml(error)}</div>` : ''}<button type="submit">${setup ? 'Buat akun & masuk' : 'Masuk'}</button></form></body></html>`;
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400, rpc: true });
  }
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function sendFile(req, res, filePath, extraHeaders = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const lastModified = stat.mtime.toUTCString();
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Last-Modified': lastModified, ...extraHeaders };
  const ims = req.headers['if-modified-since'];
  if (ims && !req.headers.range && Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000)) {
    res.writeHead(304, { 'Last-Modified': lastModified, 'Cache-Control': headers['Cache-Control'] });
    return res.end();
  }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, stat.size - parseInt(m[2], 10)); end = stat.size - 1; }
    if (start >= stat.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

function safeName(name, fallback = 'file') {
  const cleaned = String(name || '').normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned || fallback;
}

function expandHome(p) {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// ---------------------------------------------------------------------------------------------
export function createNajjaServer({ port = DEFAULT_PORT, host = DEFAULT_HOST } = {}) {
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host === '127.0.0.1' ? 'localhost' : host;
  const publicUrl = (process.env.NAJJA_PUBLIC_URL || `http://${displayHost}:${port}`).replace(/\/$/, '');
  const bridge = new Bridge(publicUrl);
  if (TOKEN && !accounts) accounts = createAuth(DATA_DIR);
  const localFiles = new Map(); // token -> absolute path (for import_media with a local path)
  let lastExport = null;

  async function prepareImport(args) {
    const out = { ...args };
    if (args.url && /^https?:\/\//i.test(args.url)) {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      const resp = await fetch(args.url, { redirect: 'follow' });
      if (!resp.ok || !resp.body) throw new Error(`Download failed: HTTP ${resp.status} for ${args.url}`);
      const mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      let ext = path.extname(new URL(resp.url || args.url).pathname).toLowerCase();
      if (!MIME[ext]) ext = EXT_FROM_MIME[mime] || '';
      if (!ext) throw new Error(`Unsupported media type "${mime || 'unknown'}" from ${args.url}`);
      const base = safeName(args.name || path.basename(new URL(args.url).pathname, path.extname(new URL(args.url).pathname)) || 'media');
      const file = `${Date.now().toString(36)}-${base.replace(/\.[^.]+$/, '')}${ext}`;
      await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(path.join(CACHE_DIR, file)));
      out.server_url = `/media-cache/${encodeURIComponent(file)}`;
      out.name = args.name || `${base.replace(/\.[^.]+$/, '')}${ext}`;
      out.mime = MIME[ext]?.split(';')[0];
    } else if (args.path) {
      let abs = path.resolve(MEDIA_ROOT || process.cwd(), expandHome(String(args.path)));
      if (MEDIA_ROOT) {
        await fsp.mkdir(MEDIA_ROOT, { recursive: true });
        const root = await fsp.realpath(MEDIA_ROOT);
        abs = await fsp.realpath(abs).catch(() => abs);
        if (!abs.startsWith(root + path.sep)) throw new Error(`On this server, local files must be inside ${MEDIA_ROOT} (upload them there first, or use a URL).`);
      }
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) throw new Error(`File not found: ${abs}`);
      const ext = path.extname(abs).toLowerCase();
      if (!MIME[ext] || !/^(video|image|audio)\//.test(MIME[ext])) throw new Error(`Unsupported file type: ${ext || 'unknown'}`);
      const token = crypto.randomBytes(9).toString('base64url');
      localFiles.set(token, abs);
      out.server_url = `/media-cache/local/${token}/${encodeURIComponent(path.basename(abs))}`;
      out.name = args.name || path.basename(abs);
      out.mime = MIME[ext].split(';')[0];
    } else if (args.url) {
      throw new Error('url must start with http:// or https://');
    } else {
      throw new Error('Provide either url or path.');
    }
    delete out.url;
    delete out.path;
    return out;
  }

  async function callTool(name, args = {}) {
    if (!TOOLS.find((t) => t.name === name)) throw new Error(`Unknown tool: ${name}`);
    const prepared = name === 'import_media' ? await prepareImport(args) : args;
    bridge.broadcast('mcp-activity', { tool: name, at: Date.now() });
    return bridge.request(name, prepared, TOOL_TIMEOUTS[name] || 30_000);
  }

  const mcpHandle = createMcpHandler({
    name: 'najja-editor',
    version: PKG.version,
    callTool,
    onInitialize: (info, v) => {
      log(`MCP client connected over HTTP: ${info?.name || 'unknown'} ${info?.version || ''}`);
      bridge.noteMcpClient(info, v, 'http');
    },
  });

  async function handleMcp(req, res) {
    const origin = req.headers.origin;
    const cors = origin && originAllowed(req)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Mcp-Session-Id', Vary: 'Origin' }
      : {};
    if (!originAllowed(req)) return sendJson(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Forbidden origin' } });
    if (req.method !== 'OPTIONS' && !(await authenticate(req))) {
      return sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: send "Authorization: Bearer <NAJJA_TOKEN>"' } }, { ...cors, 'WWW-Authenticate': 'Bearer realm="najja-editor"' });
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }
    if (req.method === 'GET') {
      // No server-initiated stream: this server only answers requests.
      res.writeHead(405, { ...cors, Allow: 'POST, DELETE, OPTIONS' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      res.writeHead(200, cors);
      return res.end();
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...cors, Allow: 'POST, DELETE, OPTIONS' });
      return res.end();
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, cors);
    }
    const messages = Array.isArray(body) ? body : [body];
    const responses = (await Promise.all(messages.map((m) => mcpHandle(m)))).filter(Boolean);
    const sessionHeader = messages.some((m) => m?.method === 'initialize') ? { 'Mcp-Session-Id': crypto.randomUUID() } : {};
    if (!responses.length) {
      res.writeHead(202, { ...cors, ...sessionHeader });
      return res.end();
    }
    return sendJson(res, 200, Array.isArray(body) ? responses : responses[0], { ...cors, ...sessionHeader });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = decodeURIComponent(url.pathname);

    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Najja Editor berjalan tanpa NAJJA_TOKEN, jadi hanya bisa dibuka dari localhost. Untuk VPS/akses publik, jalankan dengan NAJJA_TOKEN (lihat docs/DEPLOY.md).');
    }
    if (p === '/healthz') {
      return sendJson(res, 200, { ok: true, name: PKG.name, version: PKG.version, login: TOKEN ? 'email' : 'local', storage: 'server' });
    }
    if (p === '/favicon.svg' || p === '/manifest.webmanifest' || p === '/sw.js' || /^\/icons\/[\w.-]+\.png$/.test(p)) {
      return sendFile(req, res, path.join(PUBLIC_DIR, p), p === '/sw.js' ? { 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' } : {});
    }
    if (p === '/login') {
      if (!TOKEN) { res.writeHead(302, { Location: '/' }); return res.end(); }
      const setupMode = !(await accounts.hasUsers());
      const page = (status, error, email) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(loginPage(setupMode ? 'setup' : 'login', { error, email }));
      };
      if (req.method !== 'POST') return page(200);
      if (!originAllowed(req)) return page(403, 'Origin tidak diizinkan.');
      const ip = clientIp(req);
      const f = loginFailures.get(ip);
      if (f && f.n >= 10 && Date.now() < f.until) return page(429, 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.');
      const form = new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'));
      const email = form.get('email') || '';
      try {
        let user;
        if (setupMode) {
          if (form.get('password') !== form.get('password2')) throw httpErr(400, 'Konfirmasi password tidak sama.');
          await accounts.setup(email, form.get('password'), safeEqual(form.get('token'), TOKEN));
          user = await accounts.login(email, form.get('password'));
          log(`akun admin dibuat: ${user.email}`);
        } else {
          user = await accounts.login(email, form.get('password'));
        }
        loginFailures.delete(ip);
        res.writeHead(303, {
          Location: '/',
          'Set-Cookie': `najja_auth=${await accounts.createSession(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${accounts.maxAge}${isHttps(req) ? '; Secure' : ''}`,
        });
        return res.end();
      } catch (err) {
        if (err.status === 401) {
          loginFailures.set(ip, { n: (f && Date.now() < f.until ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
          log(`login gagal dari ${ip}`);
        }
        return page(err.status || 400, err.message, email);
      }
    }
    if (p === '/logout') {
      res.writeHead(303, { Location: '/login', 'Set-Cookie': 'najja_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
      return res.end();
    }

    if (p === '/mcp' || p === '/mcp/') return handleMcp(req, res);

    const who = await authenticate(req);
    if (!who) {
      if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    if (p.startsWith('/api/') || p.startsWith('/bridge/')) {
      if (!originAllowed(req)) return sendJson(res, 403, { error: 'Forbidden origin' });
    }

    // ---- account (email login)
    if (p === '/api/me' && req.method === 'GET') return sendJson(res, 200, { ...who, accounts: !!TOKEN });
    if (p === '/api/me/password' && req.method === 'POST') {
      if (who.via !== 'session') return sendJson(res, 400, { error: 'Masuk dengan email untuk mengganti password.' });
      const body = await readJson(req);
      const user = await accounts.changePassword(who.email, body.current, body.next);
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': `najja_auth=${await accounts.createSession(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${accounts.maxAge}${isHttps(req) ? '; Secure' : ''}`,
      });
    }
    if (p === '/api/users' || p.startsWith('/api/users/')) {
      if (!TOKEN) return sendJson(res, 400, { error: 'Akun hanya tersedia di mode server (NAJJA_TOKEN).' });
      if (who.role !== 'admin') return sendJson(res, 403, { error: 'Hanya admin.' });
      if (p === '/api/users' && req.method === 'GET') return sendJson(res, 200, await accounts.listUsers());
      if (p === '/api/users' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, await accounts.addUser(body.email, body.password, body.role));
      }
      const del = /^\/api\/users\/(.+)$/.exec(p);
      if (del && req.method === 'DELETE') return sendJson(res, 200, await accounts.removeUser(del[1], who.email));
    }

    if (p === '/bridge/events' && req.method === 'GET') {
      const clientId = (url.searchParams.get('client') || crypto.randomUUID()).slice(0, 64);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1500\n\n');
      bridge.addClient(clientId, res, { ua: req.headers['user-agent'] || '' });
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15_000);
      req.on('close', () => { clearInterval(ping); bridge.removeClient(clientId, res); });
      return;
    }
    if (p === '/bridge/result' && req.method === 'POST') {
      const body = await readJson(req);
      bridge.resolveResult(body.id, body);
      if (body.exportStatus) lastExport = body.exportStatus;
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/bridge/focus' && req.method === 'POST') {
      const body = await readJson(req);
      bridge.touch(body.client);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        name: PKG.name,
        version: PKG.version,
        url: publicUrl,
        auth: !!TOKEN,
        storage: 'server',
        mcp: { http: `${publicUrl}/mcp`, stdio: { command: 'node', args: [path.join(__dirname, 'mcp-stdio.js')] } },
        editors: bridge.clients.size,
        mcpClients: bridge.mcpClients,
        exportsDir: EXPORT_DIR,
        lastExport,
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description })),
      });
    }
    if (p === '/api/tool' && req.method === 'POST') {
      // Used by mcp-stdio.js to forward tool calls to this running server.
      const body = await readJson(req);
      if (body.clientInfo) bridge.noteMcpClient(body.clientInfo, body.protocolVersion, 'stdio');
      if (!body.name) return sendJson(res, 200, { ok: true });
      try {
        const result = await callTool(body.name, body.arguments || {});
        return sendJson(res, 200, formatToolResult(result));
      } catch (err) {
        return sendJson(res, 200, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    // ---- server storage: projects, media library, chunked uploads
    let m;
    if (p === '/api/projects' && req.method === 'GET') return sendJson(res, 200, await storage.listProjects());
    if ((m = /^\/api\/projects\/([\w-]+)$/.exec(p))) {
      if (req.method === 'GET') return sendJson(res, 200, await storage.getProject(m[1]));
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req, 32 * 1024 * 1024)).toString('utf8') || 'null');
        return sendJson(res, 200, await storage.putProject(m[1], body));
      }
      if (req.method === 'DELETE') return sendJson(res, 200, await storage.deleteProject(m[1]));
    }
    if ((m = /^\/api\/media\/([\w-]+)\/(meta|peaks|file|adopt)$/.exec(p))) {
      const [, id, part] = m;
      if (part === 'meta' && req.method === 'GET') return sendJson(res, 200, await storage.getMeta(id));
      if (part === 'meta' && req.method === 'PUT') return sendJson(res, 200, await storage.putMeta(id, JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8'))));
      if (part === 'peaks' && req.method === 'GET') return sendFile(req, res, storage.peaksPath(id), { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
      if (part === 'peaks' && req.method === 'PUT') return sendJson(res, 200, await storage.putPeaks(id, await readBody(req, 8 * 1024 * 1024)));
      if (part === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendFile(req, res, await storage.mediaFile(id), { 'Cache-Control': 'private, max-age=31536000, immutable' });
      }
      if (part === 'adopt' && req.method === 'POST') {
        const body = await readJson(req);
        const src = String(body.source || '');
        let file = null;
        let move = false;
        const local = /^\/media-cache\/local\/([\w-]+)\//.exec(src);
        if (local) file = localFiles.get(local[1]);
        else if (src.startsWith('/media-cache/')) { file = path.join(CACHE_DIR, path.basename(decodeURIComponent(src))); move = true; }
        if (!file || !fs.existsSync(file)) return sendJson(res, 404, { error: 'Source file not found on server' });
        return sendJson(res, 200, await storage.adoptFile(id, file, { filename: body.filename, mime: body.mime, move }));
      }
    }
    if ((m = /^\/api\/media\/([\w-]+)$/.exec(p)) && req.method === 'DELETE') {
      return sendJson(res, 200, await storage.deleteMedia(m[1], url.searchParams.get('project') || ''));
    }
    if ((m = /^\/api\/upload\/([\w-]+)\/(\d+)$/.exec(p)) && req.method === 'PUT') {
      return sendJson(res, 200, await storage.putChunk(m[1], Number(m[2]), req));
    }
    if ((m = /^\/api\/upload\/([\w-]+)\/finish$/.exec(p)) && req.method === 'POST') {
      const body = await readJson(req);
      const done = await storage.finishUpload(m[1], body);
      if (body.target === 'export') done.url = `/exports/${encodeURIComponent(done.file)}`;
      return sendJson(res, 200, done);
    }

    if (p === '/api/import-url' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const prepared = await prepareImport({ url: body.url, name: body.name });
        return sendJson(res, 200, prepared);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (p === '/api/exports' && req.method === 'POST') {
      await fsp.mkdir(EXPORT_DIR, { recursive: true });
      const requested = safeName(url.searchParams.get('filename') || `najja-${Date.now()}.mp4`);
      const ext = path.extname(requested) || '.mp4';
      let file = requested.endsWith(ext) ? requested : `${requested}${ext}`;
      if (fs.existsSync(path.join(EXPORT_DIR, file))) file = `${path.basename(file, ext)}-${Date.now().toString(36)}${ext}`;
      const dest = path.join(EXPORT_DIR, file);
      await pipeline(req, fs.createWriteStream(dest));
      const stat = await fsp.stat(dest);
      return sendJson(res, 200, { path: dest, url: `/exports/${encodeURIComponent(file)}`, size: stat.size });
    }

    if (p.startsWith('/media-cache/local/')) {
      const token = p.split('/')[3];
      const abs = localFiles.get(token);
      if (!abs) return sendJson(res, 404, { error: 'Unknown file token' });
      return sendFile(req, res, abs);
    }
    if (p.startsWith('/media-cache/')) {
      const file = path.basename(p);
      return sendFile(req, res, path.join(CACHE_DIR, file));
    }
    if (p.startsWith('/exports/')) {
      const file = path.basename(p);
      return sendFile(req, res, path.join(EXPORT_DIR, file), { 'Content-Disposition': `attachment; filename="${file}"` });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    // Static files
    let rel = p === '/' ? '/index.html' : p;
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end();
    }
    if (!fs.existsSync(filePath)) rel = '/index.html';
    return sendFile(req, res, rel === '/index.html' ? path.join(PUBLIC_DIR, 'index.html') : filePath);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log('request error:', err.message);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
      else try { res.end(); } catch { /* ignore */ }
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  return {
    server,
    bridge,
    callTool,
    publicUrl,
    listen() {
      if (!TOKEN && !INSECURE_PUBLIC && !LOOPBACK.has(String(host).toLowerCase())) {
        return Promise.reject(Object.assign(new Error(`HOST=${host} membuka server ke jaringan. Set NAJJA_TOKEN (atau NAJJA_INSECURE_PUBLIC=1 jika kamu sengaja).`), { code: 'NEEDS_TOKEN' }));
      }
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(publicUrl);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

// Run directly: `node server.js` / `npm start`
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv[2] === 'reset-login') {
  // Forgot the password? `docker compose exec najja node server.js reset-login` → next visit shows first-time setup.
  createAuth(DATA_DIR).reset().then(() => {
    console.log('Semua akun dihapus. Buka editor lagi untuk membuat akun admin baru (perlu token server). Proyek & media tidak terhapus.');
    process.exit(0);
  });
} else if (isMain) {
  const app = createNajjaServer();
  app.listen().then((url) => {
    const line = '─'.repeat(52);
    console.log(`\n  ${line}\n   ✦ Najja Editor v${PKG.version}\n  ${line}\n   Editor      : ${url}\n   MCP (HTTP)  : ${url}/mcp\n   MCP (stdio) : node ${path.join(__dirname, 'mcp-stdio.js')}\n   Ekspor      : ${EXPORT_DIR}\n   Login       : ${TOKEN ? 'email + password (token untuk MCP)' : 'tidak ada (mode lokal)'}${MEDIA_ROOT ? `\n   Folder media: ${MEDIA_ROOT}` : ''}\n  ${line}\n`);
    if (!TOKEN && !process.argv.includes('--no-open')) openBrowser(url);
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${DEFAULT_PORT} sudah dipakai. Jalankan dengan PORT=xxxx npm start, atau buka http://localhost:${DEFAULT_PORT} jika Najja sudah berjalan.`);
    } else console.error(err.message || err);
    process.exit(1);
  });
}
