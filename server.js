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
import dns from 'node:dns/promises';
import net from 'node:net';
import { createMcpHandler, formatToolResult } from './mcp/protocol.js';
import { TOOLS } from './mcp/tools.js';
import { createStorage } from './lib/storage.js';
import { createAuth } from './lib/auth.js';
import { createOAuth, ACCESS_PREFIX, protectedResourceMetadata, authorizationServerMetadata, redirectLabel } from './lib/oauth.js';
import { createTenancy, LOCAL_OWNER } from './lib/tenancy.js';
import { createProxyManager, capabilities as mediaTools } from './lib/media-proxy.js';
import { createJobs } from './lib/jobs.js';
import { createAi } from './lib/ai.js';
import { createVendor } from './lib/vendor.js';

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
  '.wasm': 'application/wasm', '.tflite': 'application/octet-stream',
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
// Media jobs (preview copies, thumbnails/waveform, full-quality copies): a durable queue in data/jobs/ with bounded
// concurrency (NAJJA_JOB_FAST / NAJJA_JOB_SLOW), retry, cancel; it resumes after a restart.
const jobs = createJobs({ dir: path.join(DATA_DIR, 'jobs'), log: (...a) => log(...a) });
// H.264 playback copies for media some browsers cannot decode (e.g. iPhone HEVC .MOV on many PCs).
const proxies = createProxyManager({
  mediaDir: storage.mediaDir, mediaFile: (id) => storage.mediaFile(id), log: (...a) => log(...a), jobs,
  ownerOf: async (id) => (await storage.getMeta(id).catch(() => null))?.ownerId || null, // job owner = media owner
});

// AI tools of the home screen (background removal, upscaling): a separate Python service, jobs in the shared queue.
const ai = createAi({ dataDir: DATA_DIR, jobs, log: (...a) => log(...a) });
// browser libraries fetched once from a pinned version (v1.11: onnxruntime-web + BiRefNet, background removal on the GPU)
const vendor = createVendor({ dir: path.join(DATA_DIR, 'vendor'), dataDir: DATA_DIR, modelDirs: [process.env.NAJJA_AI_MODELS], log: (...a) => log(...a) });
process.on('exit', () => ai.stop());
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { ai.stop(); process.exit(0); });

// Data ownership: every project/media/upload/export belongs to a user id (see lib/tenancy.js).
// The primary owner (first admin, or "local" without accounts) owns data from before v1.7 and the server token.
let primaryOwnerId = LOCAL_OWNER;
const tenancy = createTenancy({ dataDir: DATA_DIR, exportDir: EXPORT_DIR, primaryOwner: () => primaryOwnerId, log: (...a) => log(...a) });

const TOOL_TIMEOUTS = { import_media: 180_000, get_frame: 45_000, export_video: 20_000, new_project: 20_000, get_transcript: 50 * 60_000, apply_style: 50 * 60_000 };

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
    this.clients = new Map(); // `${owner}:${clientId}` -> { id, owner, res, ... }
    this.pending = new Map();
    this.mcpClients = new Map(); // owner -> recent MCP clients
    this.openedAt = 0;
    this.waiters = new Set();
  }
  key(owner, id) { return `${owner}:${id}`; }
  addClient(id, res, info, owner) {
    const k = this.key(owner, id);
    const old = this.clients.get(k);
    if (old) try { old.res.end(); } catch { /* ignore */ }
    this.clients.set(k, { id, key: k, owner, res, since: Date.now(), activeAt: Date.now(), info });
    this.send(k, 'hello', { clientId: id, server: { name: PKG.name, version: PKG.version }, mcpClients: this.mcpFor(owner) });
    for (const w of this.waiters) w();
    log(`editor connected (${this.clients.size} open)`);
  }
  removeClient(id, res, owner) {
    const k = this.key(owner, id);
    const c = this.clients.get(k);
    if (!c || (res && c.res !== res)) return;
    this.clients.delete(k);
    for (const [reqId, p] of this.pending) {
      if (p.clientKey === k) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
        p.reject(new Error('The editor tab was closed while the command was running.'));
      }
    }
    log(`editor disconnected (${this.clients.size} open)`);
  }
  touch(id, owner) {
    const c = this.clients.get(this.key(owner, id));
    if (c) c.activeAt = Date.now();
  }
  /** The most recently active editor of this owner (tool calls never reach another account's editor). */
  pick(owner) {
    let best = null;
    for (const c of this.clients.values()) if (c.owner === owner && (!best || c.activeAt > best.activeAt)) best = c;
    return best;
  }
  count(owner) { let n = 0; for (const c of this.clients.values()) if (c.owner === owner) n++; return n; }
  send(key, event, data) {
    const c = this.clients.get(key);
    if (!c) return false;
    try {
      c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }
  broadcast(event, data, owner) {
    for (const c of this.clients.values()) if (c.owner === owner) this.send(c.key, event, data);
  }
  mcpFor(owner) { return this.mcpClients.get(owner) || []; }
  noteMcpClient(info, protocolVersion, transport, owner) {
    const entry = { name: info?.name || 'MCP client', version: info?.version || '', protocolVersion, transport, at: Date.now() };
    this.mcpClients.set(owner, [entry, ...this.mcpFor(owner).filter((c) => !(c.name === entry.name && c.transport === transport))].slice(0, 8));
    this.broadcast('mcp-client', entry, owner);
  }
  waitForClient(ms, owner) {
    if (this.pick(owner)) return Promise.resolve(this.pick(owner));
    if (!TOKEN && Date.now() - this.openedAt > 60_000) {
      this.openedAt = Date.now();
      if (openBrowser(this.publicUrl)) log(`opening the editor in your browser: ${this.publicUrl}`);
    }
    return new Promise((resolve) => {
      let timer = null;
      const done = (force) => {
        const c = this.pick(owner);
        if (!c && !force) return; // another account's editor connected: keep waiting
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(c);
      };
      timer = setTimeout(() => done(true), ms);
      this.waiters.add(done);
    });
  }
  async request(tool, args, timeoutMs, owner) {
    const client = this.pick(owner) || (await this.waitForClient(Number(process.env.NAJJA_EDITOR_WAIT_MS || 20_000), owner));
    if (!client) {
      throw new Error(`Najja Editor is not open in a browser for this account. Open ${this.publicUrl}, log in, and try again.`);
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The editor did not answer within ${Math.round(timeoutMs / 1000)}s (${tool}). Make sure the editor tab is open and not frozen.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, clientKey: client.key, owner });
      if (!this.send(client.key, 'command', { id, tool, args })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Could not reach the editor tab.'));
      }
    });
  }
  /** A result is accepted only from an editor of the account the command was sent to. */
  resolveResult(id, payload, owner) {
    const p = this.pending.get(id);
    if (!p || p.owner !== owner) return false;
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
let oauth = null; // (v1.12.1) OAuth for MCP clients that connect with only the URL (Claude connectors)
/**
 * Who is calling, verified by the server: { id, email, role, via }. id owns the data the request may touch.
 *   local   no accounts (NAJJA_TOKEN unset): one local owner
 *   token   the server token (NAJJA_TOKEN): the primary owner (first admin), e.g. MCP clients set up before v1.7
 *   pat     a user's personal AI token: that user
 *   session a logged-in browser: that user
 */
async function authenticate(req) {
  if (!TOKEN) return { id: LOCAL_OWNER, role: 'admin', via: 'local' };
  const h = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(h)) {
    const t = h.replace(/^bearer\s+/i, '').trim();
    if (safeEqual(t, TOKEN)) return { id: primaryOwnerId, role: 'admin', via: 'token' };
    if (oauth && t.startsWith(ACCESS_PREFIX)) {
      // (a Claude connector: the user who allowed it — gone when that user is removed)
      const g = await oauth.userByAccessToken(t);
      const ou = g && (await accounts.byId(g.userId));
      return ou?.id ? { id: ou.id, email: ou.email, role: ou.role, via: 'oauth', client: g.clientId } : null;
    }
    const u = await accounts.userByToken(t);
    if (u?.id) return { id: u.id, email: u.email, role: u.role, via: 'pat' };
    return null;
  }
  const user = await accounts.verifySession(parseCookies(req).najja_auth);
  return user?.id ? { id: user.id, email: user.email, role: user.role, via: 'session' } : null;
}
/** Make the stored data match the accounts: ids for users from before v1.7, and an owner for every record. */
async function refreshOwner() {
  primaryOwnerId = TOKEN && accounts ? ((await accounts.primaryOwner())?.id || LOCAL_OWNER) : LOCAL_OWNER;
  return primaryOwnerId;
}
let initPromise = null;
function initData() {
  if (!initPromise) {
    initPromise = (async () => {
      if (TOKEN && accounts && (await accounts.needsIds())) {
        await tenancy.backup([path.join(DATA_DIR, 'users.json')], 'v1.7-user-ids');
        await accounts.ensureIds();
      }
      await refreshOwner();
      await tenancy.migrate();
    })().catch((err) => {
      initPromise = null; // fail closed for this request, try again on the next one
      log(`inisialisasi data gagal: ${err.message}`);
      throw err;
    });
  }
  return initPromise;
}
const httpErr = (status, message) => Object.assign(new Error(message), { status });

// URL imports by non-admin accounts may only reach the public internet (not this VPS's own services or LAN).
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = String(ip).toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
async function fetchPublic(url, maxRedirects = 5) {
  for (let i = 0; i <= maxRedirects; i++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('url must start with http:// or https://');
    const addrs = await dns.lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(`Cannot resolve ${u.hostname}`);
    if (addrs.some((a) => privateAddress(a.address))) throw new Error('Only public internet URLs can be imported.');
    const resp = await fetch(url, { redirect: 'manual' });
    const next = resp.status >= 300 && resp.status < 400 && resp.headers.get('location');
    if (!next) return resp;
    url = new URL(next, url).href;
  }
  throw new Error('Too many redirects');
}
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isHttps = (req) => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const loginFailures = new Map();

/** Where the login may send the user afterwards: only back to an OAuth "allow?" page of this server. */
// (the path is fixed, so the rest cannot lead elsewhere; no spaces, line breaks, backslashes or quotes)
const safeNext = (v) => (typeof v === 'string' && /^\/oauth\/authorize\?[^\s\\<>"'`]*$/.test(v) && v.length < 4000 ? v : '');
/** This server's address as clients see it (https://editor.example.com). */
const baseUrlOf = (req) => (process.env.NAJJA_PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${requestHost(req)}`).replace(/\/$/, '');

function loginPage(mode, { error = '', email = '', next = '' } = {}) {
  const setup = mode === 'setup';
  const field = (id, label, type, extra = '') => `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" ${extra}>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${setup ? 'Buat akun' : 'Masuk'} · Najja Editor</title>
<meta name="theme-color" content="#0b0b0d"><link rel="icon" href="/favicon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&family=Raleway:wght@400&display=swap">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Poppins,system-ui,sans-serif;background:radial-gradient(1200px 600px at 50% -10%,#1d1838 0,#0b0b0d 60%);color:#f2f2f5;padding:16px}
form{width:min(380px,100%);background:#141417;border:1px solid #2b2b31;border-radius:18px;padding:28px 24px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.b{display:flex;align-items:center;gap:12px;margin-bottom:6px}.b .w{font:400 19px Raleway,Poppins,sans-serif;letter-spacing:.3em;color:#ededf0}.b .s{font-size:12px;font-weight:500;color:#8a8a95;padding-left:12px;border-left:1px solid #34343c;line-height:16px}
h1{margin:4px 0 0;font-size:20px;font-weight:600}p{margin:0 0 6px;color:#9a9aa6;font-size:13px;line-height:1.5}label{font-size:12px;color:#b6b6c0;margin-top:4px}
input{height:44px;border-radius:10px;border:1px solid #2b2b31;background:#1b1b1f;color:#fff;padding:0 12px;font:inherit;font-size:14px;transition:border-color .15s}
input:focus{outline:none;border-color:#7c6cff}button{height:44px;margin-top:10px;border:0;border-radius:10px;background:linear-gradient(135deg,#7c6cff,#22d3c5);color:#fff;font:600 14px Poppins,sans-serif;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(1.08)}.e{color:#ff6b81;font-size:12.5px;background:rgba(255,77,109,.1);border-radius:8px;padding:8px 10px}small{color:#75757f;font-size:11.5px;line-height:1.5}code{background:#232328;border-radius:5px;padding:1px 5px;font-size:11px}</style></head><body>
<form method="post" action="/login"><div class="b"><svg viewBox="0 0 100 100" width="34" height="34" fill="none" stroke="#47C9D7" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="50" cy="50" r="45"/><path d="M18.2 18.2C22.5 14.2 28.5 12.6 33.5 13.8C37.4 14.8 39 18.5 39 24L39 61C39 70.5 35 77.5 28.5 80.4C25.4 81.8 21.8 82.2 18.2 81.8"/><path d="M81.8 81.8C77.5 85.8 71.5 87.4 66.5 86.2C62.6 85.2 61 81.5 61 76L61 39C61 29.5 65 22.5 71.5 19.6C74.6 18.2 78.2 17.8 81.8 18.2"/><path d="M18.2 18.2L81.8 81.8"/></svg><span class="w">NAJJA</span><span class="s">Editor</span></div>
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
${next ? `<input type="hidden" name="next" value="${escHtml(next)}"><small>Setelah masuk, kamu diminta mengizinkan aplikasi AI yang ingin terhubung.</small>` : ''}
${error ? `<div class="e">${escHtml(error)}</div>` : ''}<button type="submit">${setup ? 'Buat akun & masuk' : 'Masuk'}</button></form></body></html>`;
}

/** (v1.12.1) "Allow this app?" — an MCP client (e.g. a Claude connector) asks to edit the signed-in user's projects. */
function consentPage({ name, to, email, nonce, error = '' }) {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Izinkan akses · Najja Editor</title>
<meta name="theme-color" content="#0b0b0d"><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Poppins,system-ui,sans-serif;background:radial-gradient(1200px 600px at 50% -10%,#1d1838 0,#0b0b0d 60%);color:#f2f2f5;padding:16px}
form{width:min(420px,100%);background:#141417;border:1px solid #2b2b31;border-radius:18px;padding:28px 24px;display:flex;flex-direction:column;gap:12px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{margin:0;font-size:20px;font-weight:600;line-height:1.35}p{margin:0;color:#a3a3ad;font-size:13.5px;line-height:1.55}b{color:#f2f2f5}ul{margin:0;padding-left:18px;color:#c9c9d1;font-size:13px;line-height:1.7}
.who{background:#1b1b1f;border:1px solid #2b2b31;border-radius:10px;padding:10px 12px;font-size:13px;color:#c9c9d1}.row{display:flex;gap:10px;margin-top:6px}
button{flex:1;height:44px;border:0;border-radius:10px;font:600 14px Poppins,sans-serif;cursor:pointer}.ok{background:linear-gradient(135deg,#47c9d7,#22d3c5);color:#061315}.no{background:#232328;color:#f2f2f5;border:1px solid #34343c}
button:focus-visible{outline:2px solid #47c9d7;outline-offset:2px}.e{color:#ff6b81;font-size:12.5px;background:rgba(255,77,109,.1);border-radius:8px;padding:8px 10px}small{color:#75757f;font-size:11.5px;line-height:1.5}</style></head><body>
<form method="post" action="/oauth/authorize"><input type="hidden" name="nonce" value="${escHtml(nonce)}">
<h1>${escHtml(name)} ingin terhubung ke Najja Editor</h1>
<div class="who">Akun: <b>${escHtml(email)}</b><br>Kembali ke: <b>${escHtml(to)}</b></div>
<p>Kalau diizinkan, AI ini bisa:</p>
<ul><li>melihat dan mengedit proyek di akun ini</li><li>memakai media dan mengekspor video di akun ini</li></ul>
<p>Perintahnya dijalankan oleh tab editor yang kamu buka. Bisa diputus kapan saja di menu akun → <b>Token AI (MCP)</b>.</p>
${error ? `<div class="e">${escHtml(error)}</div>` : ''}
<div class="row"><button class="no" name="decision" value="deny" type="submit">Tolak</button><button class="ok" name="decision" value="allow" type="submit">Izinkan</button></div>
<small>Hanya izinkan aplikasi yang baru saja kamu hubungkan sendiri.</small></form></body></html>`;
}
function oauthErrorPage(message) {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tidak bisa terhubung · Najja Editor</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Poppins,system-ui,sans-serif;background:#0b0b0d;color:#f2f2f5;padding:16px}div{max-width:420px;background:#141417;border:1px solid #2b2b31;border-radius:18px;padding:24px}h1{font-size:19px;margin:0 0 8px}p{color:#a3a3ad;font-size:13.5px;line-height:1.55;margin:0}</style></head>
<body><div><h1>Tidak bisa terhubung</h1><p>${escHtml(message)}</p></div></body></html>`;
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

/** Proxy state as sent to the browser (probe details only when asked for). */
function publicProxy(st, withProbe = false) {
  if (!st) return null;
  const out = { state: st.state, progress: st.progress ?? (st.state === 'ready' ? 1 : 0), error: st.error || null, v: st.updatedAt || 0 };
  if (withProbe && st.probe) {
    out.probe = { duration: st.probe.duration, width: st.probe.width, height: st.probe.height, hasVideo: !!st.probe.video, hasAudio: !!st.probe.audio };
    // frame rate (v1.8.5): the export dialog says when a 60 fps export of a 30 fps video only repeats its pictures
    if (st.probe.video?.fps > 0) out.probe.video = { fps: st.probe.video.fps };
  }
  // Light 720p preview copy, and thumbnails/waveform made on the server.
  const e = st.edit;
  // reasons: why the light copy exists (codec/size/bitrate/fps/hdr) — the editor plays it instead of a heavy original
  out.edit = e ? { state: e.state, progress: e.progress ?? (e.state === 'ready' ? 1 : 0), v: e.updatedAt || 0, error: e.error || null, reasons: e.reasons || [], ...(e.upgrading ? { upgrading: true } : {}) } : null;
  const a = st.assets;
  out.assets = a ? { sprite: a.sprite || null, poster: !!a.poster, peaks: !!a.peaks, v: a.updatedAt || 0 } : null;
  return out;
}

/** Thumbnails and waveform the server made, for media whose meta has none from the browser that uploaded it. */
function withServerAssets(id, meta, st) {
  const a = st?.assets;
  if (!a) return meta;
  const out = { ...meta };
  const q = `?v=${a.updatedAt || 0}`;
  if (!out.sprite && a.sprite) Object.assign(out, { sprite: `/api/media/${id}/sprite${q}`, spriteN: a.sprite.n, spriteW: a.sprite.w, spriteH: a.sprite.h });
  if (!out.poster && a.poster) out.poster = `/api/media/${id}/poster${q}`;
  if (a.peaks) out.hasPeaks = true;
  return out;
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
  if (TOKEN && !oauth) oauth = createOAuth(DATA_DIR);
  const localFiles = new Map(); // token -> { abs, owner } (for import_media with a local path)
  const cacheOwners = new Map(); // media-cache file -> owner (URL downloads for import_media)
  const lastExport = new Map(); // owner -> latest export status reported by that owner's editor
  initData().catch((err) => log('data migration failed:', err.message));

  async function prepareImport(args, who) {
    const out = { ...args };
    if (args.url && /^https?:\/\//i.test(args.url)) {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      const resp = who.role === 'admin' ? await fetch(args.url, { redirect: 'follow' }) : await fetchPublic(args.url);
      if (!resp.ok || !resp.body) throw new Error(`Download failed: HTTP ${resp.status} for ${args.url}`);
      const mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      let ext = path.extname(new URL(resp.url || args.url).pathname).toLowerCase();
      if (!MIME[ext]) ext = EXT_FROM_MIME[mime] || '';
      if (!ext) throw new Error(`Unsupported media type "${mime || 'unknown'}" from ${args.url}`);
      const base = safeName(args.name || path.basename(new URL(args.url).pathname, path.extname(new URL(args.url).pathname)) || 'media');
      const file = `${Date.now().toString(36)}-${base.replace(/\.[^.]+$/, '')}${ext}`;
      await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(path.join(CACHE_DIR, file)));
      cacheOwners.set(file, who.id);
      out.server_url = `/media-cache/${encodeURIComponent(file)}`;
      out.name = args.name || `${base.replace(/\.[^.]+$/, '')}${ext}`;
      out.mime = MIME[ext]?.split(';')[0];
    } else if (args.path) {
      // Files on the server's disk belong to whoever runs the server: admins only.
      if (who.role !== 'admin') throw new Error('Importing a file from the server disk is only allowed for admins. Use a URL instead.');
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
      localFiles.set(token, { abs, owner: who.id });
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

  /** Backend metrics for admins (blueprint 9.1 "Backend"): job queues, disk, memory, load, HTTP status counts. */
  async function serverMetrics() {
    let disk = null;
    try { const s = await fsp.statfs(DATA_DIR); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { /* old Node */ }
    return {
      jobs: proxies.metrics(),
      disk,
      mem: { free: os.freemem(), total: os.totalmem(), rss: process.memoryUsage().rss },
      load: os.loadavg().map((v) => Math.round(v * 100) / 100),
      cores: os.cpus().length,
      http: { ...httpCounts },
      uptimeS: Math.round(process.uptime()),
    };
  }

  /** Run a tool in an editor of the caller's account (never in another account's editor). */
  async function callTool(name, args = {}, who = { id: primaryOwnerId, role: 'admin' }) {
    if (!TOOLS.find((t) => t.name === name)) throw new Error(`Unknown tool: ${name}`);
    const prepared = name === 'import_media' ? await prepareImport(args, who) : args;
    bridge.broadcast('mcp-activity', { tool: name, at: Date.now() }, who.id);
    return bridge.request(name, prepared, TOOL_TIMEOUTS[name] || 30_000, who.id);
  }

  /** MCP handler bound to the caller of one HTTP request. */
  const mcpHandlerFor = (who) => createMcpHandler({
    name: 'najja-editor',
    version: PKG.version,
    callTool: (name, args) => callTool(name, args, who),
    onInitialize: (info, v) => {
      log(`MCP client connected over HTTP: ${info?.name || 'unknown'} ${info?.version || ''}`);
      bridge.noteMcpClient(info, v, 'http', who.id);
    },
  });

  async function handleMcp(req, res) {
    const origin = req.headers.origin;
    const cors = origin && originAllowed(req)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Mcp-Session-Id', Vary: 'Origin' }
      : {};
    if (!originAllowed(req)) return sendJson(res, 403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Forbidden origin' } });
    await initData();
    const who = req.method === 'OPTIONS' ? null : await authenticate(req);
    if (req.method !== 'OPTIONS' && !who) {
      // (a Claude connector reads resource_metadata, then signs the user in with OAuth)
      return sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: connect with OAuth, or send "Authorization: Bearer <token>"' } },
        { ...cors, 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id', 'WWW-Authenticate': `Bearer realm="najja-editor", resource_metadata="${baseUrlOf(req)}/oauth/protected-resource"` });
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
    const mcpHandle = mcpHandlerFor(who);
    const responses = (await Promise.all(messages.map((m) => mcpHandle(m)))).filter(Boolean);
    const sessionHeader = messages.some((m) => m?.method === 'initialize') ? { 'Mcp-Session-Id': crypto.randomUUID() } : {};
    if (!responses.length) {
      res.writeHead(202, { ...cors, ...sessionHeader });
      return res.end();
    }
    return sendJson(res, 200, Array.isArray(body) ? responses : responses[0], { ...cors, ...sessionHeader });
  }

  /**
   * (v1.12.1) OAuth for MCP clients: discovery, registration, the "allow?" page and tokens (lib/oauth.js).
   * Returns false for a path that is not OAuth's.
   */
  async function oauthRoute(req, res, url, p) {
    const base = baseUrlOf(req);
    const open = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    const html = (status, body) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" }); return res.end(body); };
    const fail = (err) => sendJson(res, err.status || 400, { error: err.oauth || 'invalid_request', error_description: err.message }, open);
    if (req.method === 'OPTIONS') { res.writeHead(204, open); return res.end(); }
    // discovery (RFC 9728, RFC 8414; the OpenID path too, for clients that look there)
    // (also outside /.well-known/: a panel's nginx, e.g. aaPanel, may keep every /.well-known/ path for itself — the 401
    // of /mcp points here, and clients that find no server metadata use /register, /authorize and /token, below)
    if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp' || p === '/oauth/protected-resource') return sendJson(res, 200, protectedResourceMetadata(base), open);
    if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration' || p === '/oauth/authorization-server') return sendJson(res, 200, authorizationServerMetadata(base), open);
    if (p.startsWith('/.well-known/')) return false;
    // (clients that find no metadata try /register, /authorize and /token at the server's root)
    const what = p.replace(/^\/oauth\//, '/');
    if (what === '/register' && req.method === 'POST') {
      const ip = clientIp(req);
      const r = registrations.get(ip);
      if (r && r.n >= 30 && Date.now() < r.until) return sendJson(res, 429, { error: 'too_many_requests', error_description: 'Terlalu banyak pendaftaran. Coba lagi nanti.' }, open);
      registrations.set(ip, { n: (r && Date.now() < r.until ? r.n : 0) + 1, until: Date.now() + 3600_000 });
      try { return sendJson(res, 201, await oauth.register(await readJson(req)), open); } catch (err) { return fail(err); }
    }
    if (what === '/token' && req.method === 'POST') {
      const raw = (await readBody(req, 64 * 1024)).toString('utf8');
      let form;
      if (/json/i.test(String(req.headers['content-type'] || ''))) { try { form = new URLSearchParams(Object.entries(JSON.parse(raw || '{}')).map(([k, v]) => [k, String(v)])); } catch { return fail(Object.assign(new Error('JSON tidak valid'), { status: 400 })); } } else form = new URLSearchParams(raw);
      try { return sendJson(res, 200, await oauth.token(form), { ...open, Pragma: 'no-cache' }); } catch (err) { return fail(err); }
    }
    if (what === '/revoke' && req.method === 'POST') {
      const form = new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'));
      await oauth.revokeToken(form.get('token'));
      res.writeHead(200, open);
      return res.end();
    }
    if (what === '/authorize' && req.method === 'GET') {
      let ask;
      try { ask = await oauth.checkAuthorize(url.searchParams); } catch (err) {
        if (err.redirect === false || !err.req) return html(400, oauthErrorPage(err.message));
        const back = new URL(err.req.redirectUri);
        back.searchParams.set('error', err.oauth);
        back.searchParams.set('error_description', err.message);
        if (err.req.state) back.searchParams.set('state', err.req.state);
        res.writeHead(302, { Location: back.href });
        return res.end();
      }
      const who = await authenticate(req);
      if (!who || who.via !== 'session') {
        res.writeHead(302, { Location: `/login?next=${encodeURIComponent(`/oauth/authorize${url.search}`)}` });
        return res.end();
      }
      const nonce = oauth.holdRequest(who.id, ask);
      return html(200, consentPage({ name: ask.client.name, to: redirectLabel(ask.redirectUri), email: who.email, nonce }));
    }
    if (what === '/authorize' && req.method === 'POST') {
      if (!originAllowed(req)) return html(403, oauthErrorPage('Origin tidak diizinkan.'));
      const who = await authenticate(req);
      if (!who || who.via !== 'session') { res.writeHead(303, { Location: '/login' }); return res.end(); }
      const form = new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'));
      const ask = oauth.takeRequest(form.get('nonce'), who.id);
      if (!ask) return html(400, oauthErrorPage('Permintaan ini sudah kedaluwarsa atau sudah dijawab. Hubungkan ulang dari aplikasinya.'));
      const back = new URL(ask.redirectUri);
      if (form.get('decision') === 'allow') {
        back.searchParams.set('code', oauth.issueCode(ask));
        log(`AI terhubung lewat OAuth: ${ask.client.name} → ${who.email}`);
      } else back.searchParams.set('error', 'access_denied');
      if (ask.state) back.searchParams.set('state', ask.state);
      back.searchParams.set('iss', base);
      res.writeHead(303, { Location: back.href });
      return res.end();
    }
    return false;
  }
  const registrations = new Map(); // ip → registrations in the last hour

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = decodeURIComponent(url.pathname);

    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Najja Editor berjalan tanpa NAJJA_TOKEN, jadi hanya bisa dibuka dari localhost. Untuk VPS/akses publik, jalankan dengan NAJJA_TOKEN (lihat docs/DEPLOY.md).');
    }
    await initData();
    if (p === '/healthz') {
      return sendJson(res, 200, { ok: true, name: PKG.name, version: PKG.version, login: TOKEN ? 'email' : 'local', storage: 'server', convert: (await mediaTools()).ffmpeg });
    }
    if (p === '/favicon.svg' || p === '/manifest.webmanifest' || p === '/sw.js' || /^\/icons\/[\w.-]+\.png$/.test(p)) {
      return sendFile(req, res, path.join(PUBLIC_DIR, p), p === '/sw.js' ? { 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache' } : {});
    }
    if (p === '/login') {
      if (!TOKEN) { res.writeHead(302, { Location: '/' }); return res.end(); }
      const setupMode = !(await accounts.hasUsers());
      let next = safeNext(url.searchParams.get('next'));
      const page = (status, error, email) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(loginPage(setupMode ? 'setup' : 'login', { error, email, next }));
      };
      if (req.method !== 'POST') return page(200);
      if (!originAllowed(req)) return page(403, 'Origin tidak diizinkan.');
      const ip = clientIp(req);
      const f = loginFailures.get(ip);
      if (f && f.n >= 10 && Date.now() < f.until) return page(429, 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.');
      const form = new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'));
      const email = form.get('email') || '';
      next = safeNext(form.get('next')) || next;
      try {
        let user;
        if (setupMode) {
          if (form.get('password') !== form.get('password2')) throw httpErr(400, 'Konfirmasi password tidak sama.');
          await accounts.setup(email, form.get('password'), safeEqual(form.get('token'), TOKEN));
          user = await accounts.login(email, form.get('password'));
          log(`akun admin dibuat: ${user.email}`);
          await refreshOwner();
          await tenancy.migrate(); // data made before the first account (server token / local mode) is theirs
        } else {
          user = await accounts.login(email, form.get('password'));
        }
        loginFailures.delete(ip);
        res.writeHead(303, {
          Location: next || '/',
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

    if (TOKEN && oauth && (p.startsWith('/oauth/') || p.startsWith('/.well-known/') || p === '/authorize' || p === '/token' || p === '/register')) {
      const handled = await oauthRoute(req, res, url, p);
      if (handled !== false) return handled;
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
    // Personal AI (MCP) token: lets this user's AI agent edit only this user's projects.
    if (p === '/api/me/token') {
      if (!TOKEN) return sendJson(res, 400, { error: 'Token pribadi hanya tersedia di mode server (NAJJA_TOKEN).' });
      if (who.via !== 'session') return sendJson(res, 403, { error: 'Masuk dengan email untuk mengatur token AI.' });
      if (req.method === 'GET') return sendJson(res, 200, await accounts.tokenInfo(who.id));
      if (req.method === 'POST') return sendJson(res, 200, { token: await accounts.createToken(who.id) });
      if (req.method === 'DELETE') return sendJson(res, 200, await accounts.revokeToken(who.id));
    }
    // (v1.12.1) apps connected with OAuth (Claude connectors): list, disconnect
    if (p === '/api/me/oauth' || p.startsWith('/api/me/oauth/')) {
      if (!TOKEN || !oauth) return sendJson(res, 400, { error: 'Hanya di mode server (NAJJA_TOKEN).' });
      if (who.via !== 'session') return sendJson(res, 403, { error: 'Masuk dengan email untuk mengatur aplikasi terhubung.' });
      if (p === '/api/me/oauth' && req.method === 'GET') return sendJson(res, 200, { apps: await oauth.grants(who.id), url: `${baseUrlOf(req)}/mcp` });
      const one = /^\/api\/me\/oauth\/(nc_[\w-]{10,40})$/.exec(p);
      if (one && req.method === 'DELETE') return sendJson(res, 200, { ok: true, removed: await oauth.revokeUser(who.id, one[1]) });
    }
    if (p === '/api/me/password' && req.method === 'POST') {
      if (who.via !== 'session') return sendJson(res, 400, { error: 'Masuk dengan email untuk mengganti password.' });
      const body = await readJson(req);
      const user = await accounts.changePassword(who.email, body.current, body.next);
      if (oauth) await oauth.revokeUser(user.id); // (a new password disconnects the connected apps too)
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
      if (del && req.method === 'DELETE') {
        // Explicit admin action: the removed user's projects, media and exports go to this admin (backed up, logged).
        const r = await accounts.removeUser(del[1], who.email);
        if (oauth && r.removed?.id) await oauth.revokeUser(r.removed.id);
        const moved = r.removed?.id ? await tenancy.transfer(r.removed.id, who.id) : null;
        await refreshOwner(); // the removed user may have been the first admin
        return sendJson(res, 200, { ok: true, moved });
      }
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
      bridge.addClient(clientId, res, { ua: req.headers['user-agent'] || '' }, who.id);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15_000);
      req.on('close', () => { clearInterval(ping); bridge.removeClient(clientId, res, who.id); });
      return;
    }
    if (p === '/bridge/result' && req.method === 'POST') {
      const body = await readJson(req);
      bridge.resolveResult(body.id, body, who.id);
      if (body.exportStatus) lastExport.set(who.id, body.exportStatus);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/bridge/focus' && req.method === 'POST') {
      const body = await readJson(req);
      bridge.touch(body.client, who.id);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/status' && req.method === 'GET') {
      // Per account; server paths only for admins (they run the server).
      const admin = who.role === 'admin';
      return sendJson(res, 200, {
        name: PKG.name,
        version: PKG.version,
        url: publicUrl,
        auth: !!TOKEN,
        storage: 'server',
        account: { id: who.id, via: who.via, role: who.role },
        features: { exportSpool: process.env.NAJJA_EXPORT_SPOOL !== '0', syncPollMs: Math.max(500, Number(process.env.NAJJA_SYNC_POLL_MS) || 1000) },
        mcp: { http: `${publicUrl}/mcp`, ...(admin ? { stdio: { command: 'node', args: [path.join(__dirname, 'mcp-stdio.js')] } } : {}) },
        editors: bridge.count(who.id),
        convert: (await mediaTools()).ffmpeg,
        mcpClients: bridge.mcpFor(who.id),
        ...(admin ? { exportsDir: EXPORT_DIR, metrics: await serverMetrics() } : {}),
        lastExport: lastExport.get(who.id) || null,
        tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description })),
      });
    }
    if (p === '/api/tool' && req.method === 'POST') {
      // Used by mcp-stdio.js to forward tool calls to this running server.
      const body = await readJson(req);
      if (body.clientInfo) bridge.noteMcpClient(body.clientInfo, body.protocolVersion, 'stdio', who.id);
      if (!body.name) return sendJson(res, 200, { ok: true });
      try {
        const result = await callTool(body.name, body.arguments || {}, who);
        return sendJson(res, 200, formatToolResult(result));
      } catch (err) {
        return sendJson(res, 200, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    // ---- server storage: projects, media library, chunked uploads. Everything is checked against the
    // caller's id; someone else's data answers "not found" (its existence is not revealed).
    let m;
    const ownProject = async (id) => {
      const proj = await storage.getProject(id);
      if (!tenancy.owns(proj, who)) throw httpErr(404, 'Project not found');
      return proj;
    };
    const ownMedia = async (id, { allowMissing = false } = {}) => {
      let meta = null;
      try { meta = await storage.getMeta(id); } catch (err) { if (err.status !== 404) throw err; }
      if (!meta) { if (allowMissing) return null; throw httpErr(404, 'Media not found'); }
      if (!tenancy.owns(meta, who)) throw httpErr(404, 'Media not found');
      return meta;
    };
    const publicPath = (done) => (who.role === 'admin' ? done : { ...done, path: undefined });
    // Media jobs of this account (queue status, cancel, retry).
    const ownJob = (j) => tenancy.owns({ ownerId: j.owner }, who);
    if (p === '/api/jobs' && req.method === 'GET') {
      return sendJson(res, 200, { jobs: jobs.list({ owner: ownJob }).slice(0, 200), limits: jobs.limits });
    }
    if ((m = /^\/api\/jobs\/(j_[0-9a-f]+)\/(cancel|retry)$/.exec(p)) && req.method === 'POST') {
      const job = jobs.get(m[1]);
      if (!job || !ownJob(job)) return sendJson(res, 404, { error: 'Job not found' });
      const out = m[2] === 'cancel' ? await jobs.cancel(job.id) : await jobs.retry(job.id);
      return sendJson(res, 200, jobs.publicJob(out));
    }
    // ---- AI tools (home screen): background removal, upscaling. Each request belongs to its account.
    const ownAi = (meta) => tenancy.owns(meta, who);
    if (p === '/api/ai' && req.method === 'GET') return sendJson(res, 200, await ai.status());
    if ((m = /^\/api\/ai\/(cutout|upscale|transcribe)$/.exec(p)) && req.method === 'POST') {
      // (transcribe: 16 kHz mono WAV, 1.9 MB a minute — up to ±30 minutes)
      const image = await readBody(req, m[1] === 'transcribe' ? 64 * 1024 * 1024 : 40 * 1024 * 1024);
      const rec = await ai.create({ owner: who.id, tool: m[1], image, mime: req.headers['content-type'], scale: url.searchParams.get('scale'), name: url.searchParams.get('name') || '', language: url.searchParams.get('lang') || 'auto' });
      return sendJson(res, 200, rec);
    }
    // background removal of a video part, on the server (v1.11: for devices without WebGPU): it reads the media file itself
    if (p === '/api/ai/cutoutvideo' && req.method === 'POST') {
      const body = await readJson(req);
      const mediaId = String(body.mediaId || '');
      await ownMedia(mediaId);
      const st = await ai.status();
      if (!st.available) return sendJson(res, 503, { error: st.reason || 'Layanan AI di server belum siap.' });
      // (the editor uses a video at once while it is still being uploaded: the server waits for the whole file)
      if (!(await storage.getMeta(mediaId).catch(() => null))?.file) return sendJson(res, 409, { error: 'Video masih diunggah ke server', code: 'uploading' });
      const rec = await ai.createVideo({ owner: who.id, file: await storage.mediaFile(mediaId), mediaId, start: body.start, end: body.end, fps: body.fps, name: body.name || '' });
      return sendJson(res, 200, rec);
    }
    // (v1.11) masks made on the device (BiRefNet on its GPU): kept on the server for the export and other devices
    if (p === '/api/masks' && req.method === 'POST') {
      const q = url.searchParams;
      const mediaId = String(q.get('mediaId') || '');
      await ownMedia(mediaId);
      if (!(await storage.getMeta(mediaId).catch(() => null))?.file) return sendJson(res, 409, { error: 'Video masih diunggah ke server', code: 'uploading' });
      const body = await readBody(req, 256 * 1024 * 1024);
      const rec = await ai.saveMask({ owner: who.id, mediaId, start: q.get('start'), end: q.get('end'), fps: q.get('fps'), n: q.get('n'), w: q.get('w'), h: q.get('h'), model: q.get('model'), body, gzip: req.headers['x-najja-gzip'] === '1' });
      return sendJson(res, 200, rec);
    }
    if ((m = /^\/api\/masks\/(ai_[0-9a-f]{16})$/.exec(p)) && req.method === 'GET') {
      const mk = await ai.mask(m[1], ownAi);
      if (!mk) return sendJson(res, 404, { error: 'Not found' });
      // (stored gzipped: the browser unpacks it)
      return sendFile(req, res, mk.path, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    if ((m = /^\/api\/ai\/(ai_[0-9a-f]{16})$/.exec(p))) {
      if (req.method === 'GET') { const r = await ai.get(m[1], ownAi); return r ? sendJson(res, 200, r) : sendJson(res, 404, { error: 'Not found' }); }
      if (req.method === 'DELETE') return (await ai.remove(m[1], ownAi)) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Not found' });
    }
    if ((m = /^\/api\/ai\/(ai_[0-9a-f]{16})\/(input|result)$/.exec(p)) && req.method === 'GET') {
      const f = await ai.file(m[1], m[2], ownAi);
      if (!f) return sendJson(res, 404, { error: 'Not found' });
      return sendFile(req, res, f, { 'Cache-Control': 'private, max-age=86400' });
    }
    if (p === '/api/projects' && req.method === 'GET') {
      const list = (await storage.listProjects()).filter((x) => tenancy.owns(x, who)).map(({ ownerId, ...x }) => x);
      return sendJson(res, 200, list);
    }
    // Revision only (polled by open editors to see changes from other devices): no project body.
    if ((m = /^\/api\/projects\/([\w-]+)\/rev$/.exec(p)) && req.method === 'GET') {
      const r = await storage.projectRev(m[1]);
      if (!tenancy.owns(r, who)) throw httpErr(404, 'Project not found');
      return sendJson(res, 200, { rev: r.rev, updatedAt: r.updatedAt });
    }
    if ((m = /^\/api\/projects\/([\w-]+)$/.exec(p))) {
      if (req.method === 'GET') return sendJson(res, 200, await ownProject(m[1]));
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req, 32 * 1024 * 1024)).toString('utf8') || 'null');
        const existing = await storage.projectRev(m[1]).catch((err) => { if (err.status === 404) return null; throw err; });
        if (existing && !tenancy.owns(existing, who)) throw httpErr(404, 'Project not found');
        if (body && typeof body === 'object') body.ownerId = who.id; // set by the server, never trusted from the client
        // ?baseRev=N: the revision this save is based on (409 when another device saved since); &force=1 overwrites
        const baseRev = url.searchParams.has('baseRev') ? Number(url.searchParams.get('baseRev')) : null;
        return sendJson(res, 200, await storage.putProject(m[1], body, { baseRev, force: url.searchParams.get('force') === '1' }));
      }
      if (req.method === 'DELETE') { await ownProject(m[1]); return sendJson(res, 200, await storage.deleteProject(m[1])); }
    }
    if ((m = /^\/api\/media\/([\w-]+)\/(meta|peaks|file|adopt|proxy|proxy-status|edit|sprite|poster)$/.exec(p))) {
      const [, id, part] = m;
      const writing = (part === 'meta' || part === 'peaks') && req.method === 'PUT';
      if (part !== 'adopt' && !writing) await ownMedia(id);
      if (part === 'meta' && req.method === 'GET') {
        const meta = await storage.getMeta(id);
        const st = meta.file ? await proxies.status(id) : null;
        const { ownerId, ...pub } = withServerAssets(id, meta, st);
        return sendJson(res, 200, { ...pub, proxy: publicProxy(st, true) });
      }
      const immutable = { 'Cache-Control': 'private, max-age=31536000, immutable' };
      if (part === 'edit' && (req.method === 'GET' || req.method === 'HEAD')) return sendFile(req, res, proxies.editPath(id), { 'Content-Type': 'video/mp4', ...immutable });
      if (part === 'sprite' && req.method === 'GET') return sendFile(req, res, proxies.assetPath(id, 'sprite.jpg'), { 'Content-Type': 'image/jpeg', ...immutable });
      if (part === 'poster' && req.method === 'GET') return sendFile(req, res, proxies.assetPath(id, 'poster.jpg'), { 'Content-Type': 'image/jpeg', ...immutable });
      if (part === 'proxy-status' && req.method === 'GET') return sendJson(res, 200, publicProxy(await proxies.status(id), true));
      if (part === 'proxy' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        return sendJson(res, 200, publicProxy(await proxies.ensure(id, { force: !!body.force }), true));
      }
      if (part === 'proxy' && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendFile(req, res, proxies.proxyPath(id), { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=31536000, immutable' });
      }
      if (writing) await ownMedia(id, { allowMissing: true });
      if (part === 'meta' && req.method === 'PUT') return sendJson(res, 200, await storage.putMeta(id, JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8')), who.id));
      if (part === 'peaks' && req.method === 'GET') return sendFile(req, res, storage.peaksPath(id), { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
      if (part === 'peaks' && req.method === 'PUT') return sendJson(res, 200, await storage.putPeaks(id, await readBody(req, 8 * 1024 * 1024)));
      if (part === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
        return sendFile(req, res, await storage.mediaFile(id), { 'Cache-Control': 'private, max-age=31536000, immutable' });
      }
      if (part === 'adopt' && req.method === 'POST') {
        await ownMedia(id, { allowMissing: true });
        const body = await readJson(req);
        const src = String(body.source || '');
        let file = null;
        let move = false;
        const local = /^\/media-cache\/local\/([\w-]+)\//.exec(src);
        if (local) { const f = localFiles.get(local[1]); file = f?.owner === who.id ? f.abs : null; } else if (src.startsWith('/media-cache/')) {
          const name = path.basename(decodeURIComponent(src));
          if (cacheOwners.get(name) === who.id) { file = path.join(CACHE_DIR, name); move = true; }
        }
        if (!file || !fs.existsSync(file)) return sendJson(res, 404, { error: 'Source file not found on server' });
        const adopted = await storage.adoptFile(id, file, { filename: body.filename, mime: body.mime, move, ownerId: who.id });
        if (move) cacheOwners.delete(path.basename(file));
        proxies.ensure(id).catch(() => {});
        return sendJson(res, 200, adopted);
      }
    }
    if ((m = /^\/api\/media\/([\w-]+)$/.exec(p)) && req.method === 'DELETE') {
      await ownMedia(m[1]);
      for (const kind of ['edit', 'assets', 'proxy']) { const j = jobs.active(`${kind}:${m[1]}`); if (j) await jobs.cancel(j.id); }
      return sendJson(res, 200, await storage.deleteMedia(m[1], url.searchParams.get('project') || '', (proj) => tenancy.owns(proj, who)));
    }
    if ((m = /^\/api\/upload\/([\w-]+)\/(\d+)$/.exec(p)) && req.method === 'PUT') {
      return sendJson(res, 200, await storage.putChunk(m[1], Number(m[2]), req, who.id));
    }
    if ((m = /^\/api\/upload\/([\w-]+)\/finish$/.exec(p)) && req.method === 'POST') {
      const body = await readJson(req);
      if (body.target === 'media') await ownMedia(body.mediaId, { allowMissing: true });
      const done = await storage.finishUpload(m[1], body, who.id);
      if (body.target === 'export') { done.url = `/exports/${encodeURIComponent(done.file)}`; await tenancy.recordExport(done.file, who.id); }
      if (body.target === 'media') proxies.ensure(body.mediaId).catch(() => {});
      return sendJson(res, 200, publicPath(done));
    }

    if (p === '/api/import-url' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const prepared = await prepareImport({ url: body.url, name: body.name }, who);
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
      await tenancy.recordExport(file, who.id);
      return sendJson(res, 200, publicPath({ path: dest, url: `/exports/${encodeURIComponent(file)}`, size: stat.size }));
    }

    if (p.startsWith('/media-cache/local/')) {
      const f = localFiles.get(p.split('/')[3]);
      if (!f || f.owner !== who.id) return sendJson(res, 404, { error: 'Unknown file token' });
      return sendFile(req, res, f.abs);
    }
    if (p.startsWith('/vendor/')) {
      const v = vendor.resolve(p);
      if (!v) return sendJson(res, 404, { error: 'Not found' });
      let base;
      try { base = await vendor.ensure(v.name); } catch (err) {
        return sendJson(res, 503, { error: `Server belum bisa mengunduh ${v.name}: ${err.message}` });
      }
      const gz = path.join(base, `${v.file}.gz`);
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && fs.existsSync(gz)) {
        return sendFile(req, res, gz, { 'Content-Type': MIME[path.extname(v.file).toLowerCase()] || 'application/octet-stream', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Cache-Control': 'public, max-age=31536000, immutable' });
      }
      return sendFile(req, res, path.join(base, v.file), { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    if (p.startsWith('/media-cache/')) {
      const file = path.basename(p);
      if ((cacheOwners.get(file) || primaryOwnerId) !== who.id) return sendJson(res, 404, { error: 'Not found' }); // unknown (older) files: primary owner
      return sendFile(req, res, path.join(CACHE_DIR, file));
    }
    if (p.startsWith('/exports/')) {
      const file = path.basename(p);
      if ((await tenancy.exportOwner(file)) !== who.id) return sendJson(res, 404, { error: 'Not found' });
      return sendFile(req, res, path.join(EXPORT_DIR, file), { 'Content-Disposition': `attachment; filename="${file}"` });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    // Static files
    // (v1.13) Najja Desain: its own light page (the video editor's code is not loaded there)
    let rel = p === '/' ? '/index.html' : p === '/design' || p === '/design/' ? '/design.html' : p;
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end();
    }
    if (!fs.existsSync(filePath)) rel = '/index.html';
    return sendFile(req, res, rel === '/index.html' ? path.join(PUBLIC_DIR, 'index.html') : filePath);
  }

  const httpCounts = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const server = http.createServer((req, res) => {
    res.on('finish', () => { const k = `${Math.floor(res.statusCode / 100)}xx`; if (k in httpCounts) httpCounts[k]++; });
    route(req, res).catch((err) => {
      log('request error:', err.message);
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message, ...(err.data || {}) });
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
    async listen() {
      await initData();
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
