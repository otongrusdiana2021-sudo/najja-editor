// Security rules for local mode and token (VPS) mode. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token-0123456789abcdef';

// Raw HTTP so we can set Host / Origin freely (fetch forbids those headers).
function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function startServer(env) {
  const port = 39500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_NO_OPEN: '1', NAJJA_EDITOR_WAIT_MS: '100', PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('Najja Editor')) resolve({ child, port }); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}
const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 't' } } });
const json = { 'content-type': 'application/json' };

let local;
let secured;
let dataDir;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-test-'));
  local = await startServer({ NAJJA_TOKEN: '' });
  secured = await startServer({ NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dataDir });
});
after(() => { local?.child.kill(); secured?.child.kill(); });

test('local mode: only localhost Host names, no proxied traffic, no Origin null', async () => {
  const p = local.port;
  assert.equal((await req(p, { headers: { host: `localhost:${p}` } })).status, 200);
  assert.equal((await req(p, { headers: { host: `evil.example:${p}` } })).status, 403, 'DNS rebinding Host refused');
  assert.equal((await req(p, { headers: { host: `localhost:${p}`, 'x-forwarded-for': '1.2.3.4' } })).status, 403, 'proxied traffic refused without token');
  const nul = await req(p, { method: 'POST', path: '/mcp', headers: { ...json, host: `localhost:${p}`, origin: 'null' }, body: rpcBody });
  assert.equal(nul.status, 403, 'Origin: null refused');
  const evil = await req(p, { method: 'POST', path: '/mcp', headers: { ...json, host: `localhost:${p}`, origin: 'https://evil.example' }, body: rpcBody });
  assert.equal(evil.status, 403);
  const ok = await req(p, { method: 'POST', path: '/mcp', headers: { ...json, host: `localhost:${p}` }, body: rpcBody });
  assert.equal(ok.status, 200);
});

test('token mode: MCP needs Bearer, editor needs login', async () => {
  const p = secured.port;
  const H = { host: 'editor.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': '9.9.9.9' };
  const noAuth = await req(p, { method: 'POST', path: '/mcp', headers: { ...H, ...json }, body: rpcBody });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers['www-authenticate'], /Bearer/);
  const withAuth = await req(p, { method: 'POST', path: '/mcp', headers: { ...H, ...json, authorization: `Bearer ${TOKEN}` }, body: rpcBody });
  assert.equal(withAuth.status, 200);
  const page = await req(p, { headers: { ...H, accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login');
  assert.equal((await req(p, { path: '/api/status', headers: H })).status, 401);
  assert.equal((await req(p, { path: '/js/app.js', headers: H })).status, 401);
  const form = { ...H, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://editor.example.com' };
  const enc = (o) => new URLSearchParams(o).toString();
  // first visit: setup page (no account yet)
  assert.match((await req(p, { path: '/login', headers: H })).body, /Buat akun admin/);
  const badSetup = await req(p, { method: 'POST', path: '/login', headers: form, body: enc({ email: 'bos@najja.id', password: 'rahasia123', password2: 'rahasia123', token: 'salah' }) });
  assert.equal(badSetup.status, 401, 'setup needs the server token');
  const good = await req(p, { method: 'POST', path: '/login', headers: form, body: enc({ email: 'Bos@Najja.id', password: 'rahasia123', password2: 'rahasia123', token: TOKEN }) });
  assert.equal(good.status, 303);
  const again = await req(p, { method: 'POST', path: '/login', headers: form, body: enc({ email: 'lain@x.id', password: 'rahasia123', password2: 'rahasia123', token: TOKEN }) });
  assert.notEqual(again.status, 303, 'second setup is refused (login form is shown instead)');
  assert.match((await req(p, { path: '/login', headers: H })).body, /<h1>Masuk/);
  const bad = await req(p, { method: 'POST', path: '/login', headers: form, body: enc({ email: 'bos@najja.id', password: 'salah-salah' }) });
  assert.equal(bad.status, 401);
  const login = await req(p, { method: 'POST', path: '/login', headers: form, body: enc({ email: 'bos@najja.id', password: 'rahasia123' }) });
  assert.equal(login.status, 303);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /najja_auth=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.ok(!cookie.includes(TOKEN), 'cookie does not contain the raw token');
  const session = cookie.split(';')[0];
  assert.equal((await req(p, { headers: { ...H, cookie: session, accept: 'text/html' } })).status, 200);
  const status = JSON.parse((await req(p, { path: '/api/status', headers: { ...H, cookie: session } })).body);
  assert.equal(status.auth, true);
  const me = JSON.parse((await req(p, { path: '/api/me', headers: { ...H, cookie: session } })).body);
  assert.deepEqual([me.email, me.role, me.via], ['bos@najja.id', 'admin', 'session']);
  const forged = session.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await req(p, { path: '/api/me', headers: { ...H, cookie: forged } })).status, 401, 'tampered session refused');
  // same-origin browser POST through the proxy is allowed, cross-site is not
  const same = await req(p, { method: 'POST', path: '/bridge/focus', headers: { ...H, ...json, cookie: session, origin: 'https://editor.example.com' }, body: '{}' });
  assert.equal(same.status, 200);
  const cross = await req(p, { method: 'POST', path: '/bridge/focus', headers: { ...H, ...json, cookie: session, origin: 'https://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);
});

test('token mode: local file imports are limited to the media folder', async () => {
  const p = secured.port;
  const H = { host: 'editor.example.com', ...json, authorization: `Bearer ${TOKEN}` };
  const outside = JSON.parse((await req(p, { method: 'POST', path: '/api/tool', headers: H, body: JSON.stringify({ name: 'import_media', arguments: { path: '/etc/hostname.png' } }) })).body);
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /must be inside/);
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'media', 'ok.png'), 'x');
  const inside = JSON.parse((await req(p, { method: 'POST', path: '/api/tool', headers: H, body: JSON.stringify({ name: 'import_media', arguments: { path: 'ok.png' } }) })).body);
  assert.match(inside.content[0].text, /not open in a browser/, 'passes the folder check, then waits for an editor');
});

test('refuses to listen on a public interface without a token', async () => {
  const child = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: '', HOST: '0.0.0.0', PORT: '39999', NAJJA_NO_OPEN: '1' } });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(err, /NAJJA_TOKEN/);
});

test('token mode: users and password change', async () => {
  const p = secured.port;
  const H = { host: 'editor.example.com', 'x-forwarded-proto': 'https', origin: 'https://editor.example.com' };
  const J = { ...H, 'content-type': 'application/json' };
  const form = { ...H, 'content-type': 'application/x-www-form-urlencoded' };
  const loginAs = async (email, password) => {
    const r = await req(p, { method: 'POST', path: '/login', headers: form, body: new URLSearchParams({ email, password }).toString() });
    return r.status === 303 ? r.headers['set-cookie'][0].split(';')[0] : null;
  };
  const admin = await loginAs('bos@najja.id', 'rahasia123');
  assert.ok(admin);
  const add = await req(p, { method: 'POST', path: '/api/users', headers: { ...J, cookie: admin }, body: JSON.stringify({ email: 'tim@najja.id', password: 'timpass123', role: 'editor' }) });
  assert.equal(add.status, 200);
  const users = JSON.parse((await req(p, { path: '/api/users', headers: { ...J, cookie: admin } })).body);
  assert.deepEqual(users.map((u) => u.email).sort(), ['bos@najja.id', 'tim@najja.id']);
  const editor = await loginAs('tim@najja.id', 'timpass123');
  assert.equal((await req(p, { path: '/api/users', headers: { ...J, cookie: editor } })).status, 403, 'editors cannot manage users');
  // password change logs out the old session
  const other = await loginAs('tim@najja.id', 'timpass123');
  const ch = await req(p, { method: 'POST', path: '/api/me/password', headers: { ...J, cookie: editor }, body: JSON.stringify({ current: 'timpass123', next: 'baru-12345' }) });
  assert.equal(ch.status, 200);
  assert.equal((await req(p, { path: '/api/me', headers: { ...J, cookie: other } })).status, 401, 'old sessions end after a password change');
  assert.ok(await loginAs('tim@najja.id', 'baru-12345'));
  assert.equal(await loginAs('tim@najja.id', 'timpass123'), null);
  assert.equal((await req(p, { method: 'DELETE', path: '/api/users/bos@najja.id', headers: { ...J, cookie: admin } })).status, 400, 'cannot delete yourself');
  assert.equal((await req(p, { method: 'DELETE', path: '/api/users/tim@najja.id', headers: { ...J, cookie: admin } })).status, 200);
});

test('healthz is public and reports the version and login mode', async () => {
  const r = await req(secured.port, { path: '/healthz', headers: { host: 'editor.example.com' } });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.login, 'email');
  assert.match(j.version, /^\d+\.\d+\.\d+$/);
});

// ---- (P0-4) security headers ----
const HTML_HEADERS = (h, what) => {
  assert.equal(h['x-content-type-options'], 'nosniff', `${what}: nosniff`);
  assert.equal(h['content-security-policy'], "frame-ancestors 'self'", `${what}: other sites may not frame it`);
  assert.equal(h['x-frame-options'], 'SAMEORIGIN', `${what}: X-Frame-Options for older browsers`);
  assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin', `${what}: referrer`);
  const csp = h['content-security-policy-report-only'] || '';
  for (const d of ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "object-src 'none'", "worker-src 'self' blob:", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
    assert.ok(csp.includes(d), `${what}: report-only CSP has ${d}`);
  }
  assert.ok(!/form-action/.test(csp), `${what}: no form-action (it would stop the OAuth redirect back to the AI client)`);
};

test('security headers: the editor, Najja Desain and a project link are HTML pages with them', async () => {
  const H = { host: `localhost:${local.port}` };
  for (const p of ['/', '/design', '/?p=p_abc', '/some/spa/path']) {
    const r = await req(local.port, { path: p, headers: H });
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], /text\/html/, p);
    HTML_HEADERS(r.headers, p);
  }
});

test('security headers: a page answered 304 (cached before this version) gets them too', async () => {
  const r = await req(local.port, { path: '/', headers: { host: `localhost:${local.port}`, 'if-modified-since': new Date(Date.now() + 86400e3).toUTCString() } });
  assert.equal(r.status, 304);
  HTML_HEADERS(r.headers, '304');
});

test('security headers: the login page has them', async () => {
  const r = await req(secured.port, { path: '/login', headers: { host: 'editor.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': '9.9.9.9' } });
  assert.equal(r.status, 200);
  HTML_HEADERS(r.headers, '/login');
});

test('security headers: scripts, JSON and errors get nosniff but no page policy', async () => {
  const H = { host: `localhost:${local.port}` };
  for (const p of ['/js/app.js', '/sw.js', '/api/status', '/api/projects/does-not-exist']) {
    const r = await req(local.port, { path: p, headers: H });
    assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(r.headers['content-security-policy-report-only'], undefined, p);
  }
  const mcp = await req(local.port, { method: 'POST', path: '/mcp', headers: { ...json, ...H }, body: rpcBody });
  assert.equal(mcp.headers['x-content-type-options'], 'nosniff', '/mcp');
});

// ---- (P0-6a) /api/tool (mcp-stdio.js forwards there) refuses wrong argument types too ----
test('/api/tool: a wrong argument type is refused before any editor is asked', async () => {
  const H = { ...json, host: `localhost:${local.port}` };
  const r = await req(local.port, { method: 'POST', path: '/api/tool', headers: H, body: JSON.stringify({ name: 'update_clip', arguments: { clip_id: 'c1', opacity: 'setengah' } }) });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.isError, true);
  assert.match(j.content[0].text, /Invalid arguments for update_clip: opacity: expected a number, got string "setengah"/);
});
