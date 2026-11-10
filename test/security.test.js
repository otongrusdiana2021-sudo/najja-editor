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
  const bad = await req(p, { method: 'POST', path: '/login', headers: form, body: 'token=wrong' });
  assert.equal(bad.status, 401);
  const good = await req(p, { method: 'POST', path: '/login', headers: form, body: `token=${encodeURIComponent(TOKEN)}` });
  assert.equal(good.status, 303);
  const cookie = good.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.ok(!cookie.includes(TOKEN), 'cookie does not contain the raw token');
  const session = cookie.split(';')[0];
  assert.equal((await req(p, { headers: { ...H, cookie: session, accept: 'text/html' } })).status, 200);
  const status = JSON.parse((await req(p, { path: '/api/status', headers: { ...H, cookie: session } })).body);
  assert.equal(status.auth, true);
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
