// OAuth for MCP clients (v1.12.1): what a Claude connector does with only the URL https://<editor>/mcp — discover,
// register, send the user to sign in and allow, get a token, use /mcp; plus refresh, disconnect and the refusals.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'oauth-server-token-0123456789';
const HOST = 'editor.example.com';
const BASE = `https://${HOST}`;
const H = { host: HOST, 'x-forwarded-proto': 'https', origin: BASE };
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, text: buf.toString(), json: () => JSON.parse(buf.toString()) }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSONH = { 'content-type': 'application/json' };
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };

let srv;
let dir;
let A; // admin's session cookie
let B; // another user's session cookie
const call = (cookie, method, p, body, headers = {}) => req(srv.port, { method, path: p, headers: { ...H, ...(cookie ? { cookie } : {}), ...headers }, body });
const login = async (email, password, extra = {}) => {
  const r = await req(srv.port, { method: 'POST', path: '/login', headers: { ...H, ...FORM }, body: form({ email, password, password2: password, token: TOKEN, ...extra }) });
  assert.equal(r.status, 303, `login ${email}`);
  return { cookie: r.headers['set-cookie'][0].split(';')[0], location: r.headers.location };
};
const mcp = (bearer, method, params = {}) => req(srv.port, { method: 'POST', path: '/mcp', headers: { host: HOST, 'x-forwarded-proto': 'https', ...JSONH, accept: 'application/json, text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
const authorizeUrl = (clientId, { challenge, state = 'st-123', redirect = CALLBACK } = {}) => `/oauth/authorize?${form({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'mcp', resource: `${BASE}/mcp` })}`;

/** The whole connect: allow on the "allow?" page, exchange the code. */
async function connect(cookie, clientId) {
  const { verifier, challenge } = pkce();
  const page = await call(cookie, 'GET', authorizeUrl(clientId, { challenge }));
  assert.equal(page.status, 200);
  const nonce = /name="nonce" value="([^"]+)"/.exec(page.text)[1];
  const allow = await call(cookie, 'POST', '/oauth/authorize', form({ nonce, decision: 'allow' }), FORM);
  const code = new URL(allow.headers.location).searchParams.get('code');
  const tok = await call(null, 'POST', '/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier }), FORM);
  assert.equal(tok.status, 200, tok.text);
  return tok.json();
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-oauth-'));
  const port = 39950 + Math.floor(Math.random() * 40);
  const env = { ...process.env, NAJJA_NO_OPEN: '1', PORT: String(port), HOST: '127.0.0.1', NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, NAJJA_AI: 'off', NAJJA_AI_URL: '' };
  delete env.NAJJA_PUBLIC_URL;
  const child = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('Najja Editor')) resolve(); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  srv = { child, port };
  A = (await login('bos@najja.id', 'rahasia123')).cookie;
  assert.equal((await call(A, 'POST', '/api/users', JSON.stringify({ email: 'tim@najja.id', password: 'timpass123', role: 'editor' }), JSONH)).status, 200);
  B = (await login('tim@najja.id', 'timpass123')).cookie;
});
after(() => { srv?.child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test('discovery: /mcp says where to sign in; the metadata lists the endpoints', async () => {
  const r = await mcp(null, 'initialize');
  assert.equal(r.status, 401);
  assert.match(r.headers['www-authenticate'], new RegExp(`resource_metadata="${BASE}/\\.well-known/oauth-protected-resource"`));
  const prm = (await call(null, 'GET', '/.well-known/oauth-protected-resource')).json();
  assert.deepEqual([prm.resource, prm.authorization_servers], [`${BASE}/mcp`, [BASE]]);
  assert.equal((await call(null, 'GET', '/.well-known/oauth-protected-resource/mcp')).json().resource, `${BASE}/mcp`);
  const as = await call(null, 'GET', '/.well-known/oauth-authorization-server');
  assert.equal(as.headers['access-control-allow-origin'], '*');
  const m = as.json();
  assert.deepEqual([m.issuer, m.authorization_endpoint, m.token_endpoint, m.registration_endpoint], [BASE, `${BASE}/oauth/authorize`, `${BASE}/oauth/token`, `${BASE}/oauth/register`]);
  assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
  assert.equal((await call(null, 'GET', '/.well-known/openid-configuration')).json().issuer, BASE);
});

test('registration: https and this-computer addresses only; the metadata comes back', async () => {
  const ok = await call(null, 'POST', '/oauth/register', JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK] }), JSONH);
  assert.equal(ok.status, 201);
  const c = ok.json();
  assert.match(c.client_id, /^nc_/);
  assert.equal(c.token_endpoint_auth_method, 'none');
  for (const bad of ['javascript:alert(1)', 'http://evil.example/cb', 'data:text/html,x', 'https://x.example/cb#frag', 'nonsense']) {
    const r = await call(null, 'POST', '/oauth/register', JSON.stringify({ redirect_uris: [bad] }), JSONH);
    assert.equal(r.status, 400, bad);
    assert.equal(r.json().error, 'invalid_redirect_uri');
  }
  assert.equal((await call(null, 'POST', '/oauth/register', JSON.stringify({ redirect_uris: ['http://localhost:4567/callback'] }), JSONH)).status, 201, 'a CLI on this computer');
  assert.equal((await call(null, 'POST', '/register', JSON.stringify({ redirect_uris: [CALLBACK] }), JSONH)).status, 201, '/register at the root too');
});

test('the full connect: sign in, allow, token, /mcp works for that user', async () => {
  const { client_id: id } = (await call(null, 'POST', '/oauth/register', JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK] }), JSONH)).json();
  const { verifier, challenge } = pkce();
  // not signed in: to the login, which comes back here
  const first = await call(null, 'GET', authorizeUrl(id, { challenge }));
  assert.equal(first.status, 302);
  const loc = new URL(first.headers.location, BASE);
  assert.equal(loc.pathname, '/login');
  const next = loc.searchParams.get('next');
  assert.ok(next.startsWith('/oauth/authorize?') && next.includes(`client_id=${id}`));
  assert.match((await call(null, 'GET', `/login?next=${encodeURIComponent(next)}`)).text, /name="next"/);
  const back = await login('bos@najja.id', 'rahasia123', { next });
  assert.equal(back.location, next, 'after signing in: back to the "allow?" page');
  // the "allow?" page: the app, the account, where it goes back to; not in a frame
  const page = await call(back.cookie, 'GET', next);
  assert.equal(page.status, 200);
  assert.match(page.text, /Claude ingin terhubung ke Najja Editor/);
  assert.match(page.text, /bos@najja\.id/);
  assert.match(page.text, /Kembali ke: <b>Claude<\/b>/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  const nonce = /name="nonce" value="([^"]+)"/.exec(page.text)[1];
  // another account cannot answer this page
  assert.equal((await call(B, 'POST', '/oauth/authorize', form({ nonce, decision: 'allow' }), FORM)).status, 400);
  // (that answer did not use it up? it did not belong to B: the page must be asked again)
  const page2 = await call(back.cookie, 'GET', next);
  const nonce2 = /name="nonce" value="([^"]+)"/.exec(page2.text)[1];
  const allow = await call(back.cookie, 'POST', '/oauth/authorize', form({ nonce: nonce2, decision: 'allow' }), FORM);
  assert.equal(allow.status, 303);
  const cb = new URL(allow.headers.location);
  assert.equal(`${cb.origin}${cb.pathname}`, CALLBACK);
  assert.equal(cb.searchParams.get('state'), 'st-123');
  assert.equal(cb.searchParams.get('iss'), BASE);
  const code = cb.searchParams.get('code');
  assert.equal((await call(back.cookie, 'POST', '/oauth/authorize', form({ nonce: nonce2, decision: 'allow' }), FORM)).status, 400, 'answered once only');
  // the code: right verifier only, once only
  const wrong = await call(null, 'POST', '/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: id, code_verifier: pkce().verifier }), FORM);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json().error, 'invalid_grant');
  const again = await call(null, 'POST', '/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: id, code_verifier: verifier }), FORM);
  assert.equal(again.status, 400, 'a code that was tried is gone');
  const tok = await connect(A, id);
  assert.match(tok.access_token, /^najja_oat_/);
  assert.match(tok.refresh_token, /^najja_ort_/);
  assert.equal(tok.token_type, 'Bearer');
  assert.ok(tok.expires_in > 3600);
  // /mcp with it
  const init = await mcp(tok.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
  assert.equal(init.status, 200, init.text);
  const tools = await mcp(tok.access_token, 'tools/list');
  assert.ok(tools.json().result.tools.length > 20);
  // it is the user who allowed it (not the admin token, not anyone else)
  const me = await req(srv.port, { path: '/api/me', headers: { host: HOST, 'x-forwarded-proto': 'https', authorization: `Bearer ${tok.access_token}` } });
  assert.deepEqual([me.json().email, me.json().via], ['bos@najja.id', 'oauth']);
  // it cannot manage tokens or connected apps
  assert.equal((await req(srv.port, { method: 'POST', path: '/api/me/token', headers: { ...H, authorization: `Bearer ${tok.access_token}` } })).status, 403);
  // listed for the user; not for another user
  const apps = (await call(A, 'GET', '/api/me/oauth')).json();
  assert.ok(apps.apps.some((a) => a.clientId === id && a.name === 'Claude' && a.to === 'Claude'));
  assert.equal(apps.url, `${BASE}/mcp`);
  assert.ok(!(await call(B, 'GET', '/api/me/oauth')).json().apps.some((a) => a.clientId === id));
  // nothing secret on disk
  const stored = fs.readFileSync(path.join(dir, 'oauth.json'), 'utf8');
  assert.ok(!stored.includes(tok.access_token) && !stored.includes(tok.refresh_token), 'only hashes are kept');
  assert.equal(fs.statSync(path.join(dir, 'oauth.json')).mode & 0o777, 0o600);
});

test('refusals: a wrong return address is never redirected to; no PKCE, no code; deny goes back with an error', async () => {
  const { client_id: id } = (await call(null, 'POST', '/oauth/register', JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK] }), JSONH)).json();
  const { challenge } = pkce();
  const evil = await call(A, 'GET', authorizeUrl(id, { challenge, redirect: 'https://evil.example/steal' }));
  assert.equal(evil.status, 400);
  assert.ok(!evil.headers.location, 'shown here, not sent there');
  assert.equal((await call(A, 'GET', authorizeUrl('nc_unknown_client_x', { challenge }))).status, 400);
  const noPkce = await call(A, 'GET', `/oauth/authorize?${form({ response_type: 'code', client_id: id, redirect_uri: CALLBACK, state: 's1' })}`);
  assert.equal(noPkce.status, 302);
  const e = new URL(noPkce.headers.location);
  assert.deepEqual([e.searchParams.get('error'), e.searchParams.get('state')], ['invalid_request', 's1']);
  const page = await call(A, 'GET', authorizeUrl(id, { challenge }));
  const nonce = /name="nonce" value="([^"]+)"/.exec(page.text)[1];
  const deny = await call(A, 'POST', '/oauth/authorize', form({ nonce, decision: 'deny' }), FORM);
  const d = new URL(deny.headers.location);
  assert.deepEqual([d.searchParams.get('error'), d.searchParams.get('code')], ['access_denied', null]);
  // a form from another site
  assert.equal((await call(A, 'POST', '/oauth/authorize', form({ nonce, decision: 'allow' }), { ...FORM, origin: 'https://evil.example' })).status, 403);
  // the login only returns to an "allow?" page of this server
  const r = await req(srv.port, { method: 'POST', path: '/login', headers: { ...H, ...FORM }, body: form({ email: 'bos@najja.id', password: 'rahasia123', next: 'https://evil.example/' }) });
  assert.equal(r.headers.location, '/');
  const r2 = await req(srv.port, { method: 'POST', path: '/login', headers: { ...H, ...FORM }, body: form({ email: 'bos@najja.id', password: 'rahasia123', next: '//evil.example/oauth/authorize?x' }) });
  assert.equal(r2.headers.location, '/');
});

test('refresh rotates; disconnecting, revoking and a new password end the access', async () => {
  const { client_id: id } = (await call(null, 'POST', '/oauth/register', JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK] }), JSONH)).json();
  const t1 = await connect(B, id);
  const r = await call(null, 'POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: id }), FORM);
  assert.equal(r.status, 200);
  const t2 = r.json();
  assert.notEqual(t2.access_token, t1.access_token);
  assert.equal((await call(null, 'POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: id }), FORM)).status, 400, 'an old refresh token is spent');
  assert.equal((await mcp(t2.access_token, 'tools/list')).status, 200);
  // disconnect from the account menu
  assert.equal((await call(B, 'DELETE', `/api/me/oauth/${id}`)).json().ok, true);
  assert.equal((await mcp(t2.access_token, 'tools/list')).status, 401);
  assert.equal((await call(null, 'POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: id }), FORM)).status, 400);
  // RFC 7009 revoke
  const t3 = await connect(B, id);
  assert.equal((await call(null, 'POST', '/oauth/revoke', form({ token: t3.access_token }), FORM)).status, 200);
  assert.equal((await mcp(t3.access_token, 'tools/list')).status, 401);
  // a new password disconnects every app
  const t4 = await connect(B, id);
  const pw = await call(B, 'POST', '/api/me/password', JSON.stringify({ current: 'timpass123', next: 'timpass456' }), JSONH);
  assert.equal(pw.status, 200);
  assert.equal((await mcp(t4.access_token, 'tools/list')).status, 401);
  // the server token and personal tokens still work as before
  assert.equal((await mcp(TOKEN, 'tools/list')).status, 200);
});
