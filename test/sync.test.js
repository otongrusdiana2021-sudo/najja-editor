// Multi-device sync (v1.7 P6): project revisions, 409 instead of silent overwrite, cheap revision polling.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStorage } from '../lib/storage.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'sync-token-0123456789abcdef';
const H = { host: 'editor.example.com', 'x-forwarded-proto': 'https', origin: 'https://editor.example.com' };

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
let srv;
let port;
let A;
let B;
before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-sync-'));
  port = 37500 + Math.floor(Math.random() * 900);
  srv = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', NAJJA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve) => srv.stdout.on('data', (d) => { if (String(d).includes('Najja Editor')) resolve(); }));
  const form = { ...H, 'content-type': 'application/x-www-form-urlencoded' };
  const login = (email, password) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/login', headers: form }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); });
    r.on('error', reject);
    r.end(new URLSearchParams({ email, password }).toString());
  });
  await req(port, { method: 'POST', path: '/login', headers: form, body: new URLSearchParams({ email: 'a@najja.id', password: 'sandi-aaaa', password2: 'sandi-aaaa', token: TOKEN }).toString() });
  A = await login('a@najja.id', 'sandi-aaaa');
  await req(port, { method: 'POST', path: '/api/users', headers: { ...H, 'content-type': 'application/json', cookie: A }, body: JSON.stringify({ email: 'b@najja.id', password: 'sandi-bbbb', role: 'editor' }) });
  B = await login('b@najja.id', 'sandi-bbbb');
});
after(() => srv?.kill());

const put = (cookie, id, rec, q = '') => req(port, { method: 'PUT', path: `/api/projects/${id}${q}`, headers: { ...H, 'content-type': 'application/json', cookie }, body: JSON.stringify(rec) });
const rev = (cookie, id) => req(port, { path: `/api/projects/${id}/rev`, headers: { ...H, cookie } });

test('every save gets the next revision; a save based on an old revision gets 409 with the server revision', async () => {
  const P = { id: 'p_sync0001', name: 'v1', clips: [], media: [], updatedAt: 1 };
  assert.equal((await put(A, P.id, P, '?baseRev=0')).json().rev, 1, 'new project');
  assert.equal((await put(A, P.id, { ...P, name: 'v2' }, '?baseRev=1')).json().rev, 2, 'device 1 saves');
  const late = await put(A, P.id, { ...P, name: 'v2-other-device' }, '?baseRev=1'); // device 2 still on rev 1
  assert.equal(late.status, 409);
  assert.deepEqual([late.json().conflict, late.json().rev], [true, 2]);
  assert.equal((await req(port, { path: `/api/projects/${P.id}`, headers: { ...H, cookie: A } })).json().name, 'v2', 'nothing was overwritten');
  const forced = await put(A, P.id, { ...P, name: 'chosen' }, '?baseRev=1&force=1');
  assert.equal(forced.json().rev, 3, 'force: the user chose to overwrite');
  assert.deepEqual(Object.keys((await rev(A, P.id)).json()).sort(), ['rev', 'updatedAt']);
  assert.equal((await rev(A, P.id)).json().rev, 3);
  // older clients (no baseRev) keep working
  assert.equal((await put(A, P.id, { ...P, name: 'old client' })).json().rev, 4);
});

test('revision polling and conflicts are per account', async () => {
  assert.equal((await rev(B, 'p_sync0001')).status, 404);
  assert.equal((await put(B, 'p_sync0001', { id: 'p_sync0001', clips: [], media: [] }, '?baseRev=4')).status, 404);
  assert.equal((await rev(A, 'p_nothere1')).status, 404);
});

test('two saves on the same base revision at the same moment: exactly one wins', async () => {
  const id = 'p_sync0002';
  await put(A, id, { id, clips: [], media: [] }, '?baseRev=0');
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => put(A, id, { id, name: `d${i}`, clips: [], media: [] }, '?baseRev=1')));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  assert.equal((await rev(A, id)).json().rev, 2);
});

test('storage: legacy projects (no rev) start at 0; revision cache follows deletes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-sync-st-'));
  const st = createStorage(dir, { exportDir: path.join(dir, 'exports'), extFor: () => '.bin' });
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', 'p_legacy01.json'), JSON.stringify({ id: 'p_legacy01', clips: [] }));
  assert.equal((await st.projectRev('p_legacy01')).rev, 0);
  assert.equal((await st.putProject('p_legacy01', { id: 'p_legacy01', clips: [] }, { baseRev: 0 })).rev, 1);
  await st.deleteProject('p_legacy01');
  await assert.rejects(st.projectRev('p_legacy01'), /not found/);
});
