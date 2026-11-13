// Tenant isolation (v1.7 P0): every account sees and changes only its own data; data from before v1.7 is
// migrated to the first admin with a backup. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAuth } from '../lib/auth.js';
import { createTenancy } from '../lib/tenancy.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'tenancy-token-0123456789abcdef';
const HOST = 'editor.example.com';
const H = { host: HOST, 'x-forwarded-proto': 'https', origin: `https://${HOST}` };
const J = { ...H, 'content-type': 'application/json' };

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
function startServer(env) {
  const port = 38500 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_NO_OPEN: '1', NAJJA_EDITOR_WAIT_MS: '150', PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d; if (String(d).includes('Najja Editor')) resolve({ child, port, out: () => out }); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}

// A data folder as Najja Editor v1.6 left it: an admin without an id, a project, a media item and an export.
async function seedLegacy(dir) {
  const auth = createAuth(dir);
  await auth.setup('bos@najja.id', 'rahasia123', true);
  const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')).map(({ id, ...u }) => u);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', 'p_legacy1.json'), JSON.stringify({ id: 'p_legacy1', name: 'Proyek lama', media: [{ id: 'm_legacy1' }], updatedAt: 1 }));
  fs.mkdirSync(path.join(dir, 'library', 'm_legacy1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'library', 'm_legacy1', 'meta.json'), JSON.stringify({ id: 'm_legacy1', file: 'source.png', mime: 'image/png', size: 4 }));
  fs.writeFileSync(path.join(dir, 'library', 'm_legacy1', 'source.png'), 'PNG!');
  fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'exports', 'lama.mp4'), 'MP4!');
}

let srv;
let dataDir;
let A; // admin (owner of the legacy data)
let B; // second account (editor)
let aId;
let bId;
const loginAs = async (email, password) => {
  const r = await req(srv.port, { method: 'POST', path: '/login', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }).toString() });
  assert.equal(r.status, 303, `login ${email}`);
  return r.headers['set-cookie'][0].split(';')[0];
};
const as = (cookie, method, p, body, extra = {}) => req(srv.port, { method, path: p, headers: { ...J, cookie, ...extra }, body: body == null ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-tenancy-'));
  await seedLegacy(dataDir);
  srv = await startServer({ NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dataDir });
  A = await loginAs('bos@najja.id', 'rahasia123');
  assert.equal((await as(A, 'POST', '/api/users', { email: 'tim@najja.id', password: 'timpass123', role: 'editor' })).status, 200);
  B = await loginAs('tim@najja.id', 'timpass123');
  aId = (await as(A, 'GET', '/api/me')).json().id;
  bId = (await as(B, 'GET', '/api/me')).json().id;
});
after(() => { srv?.child.kill(); });

test('migration: legacy users get ids; legacy data goes to the first admin, backed up first', async () => {
  assert.match(aId, /^u_[0-9a-f]{16}$/);
  assert.match(bId, /^u_[0-9a-f]{16}$/);
  assert.notEqual(aId, bId);
  const proj = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', 'p_legacy1.json'), 'utf8'));
  assert.equal(proj.ownerId, aId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'library', 'm_legacy1', 'meta.json'), 'utf8')).ownerId, aId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'exports-index.json'), 'utf8'))['lama.mp4'], aId);
  const backups = fs.readdirSync(path.join(dataDir, 'backups'));
  const mig = backups.find((d) => d.startsWith('v1.7-owner-migration-'));
  assert.ok(mig, 'owner migration backup exists');
  assert.ok(backups.some((d) => d.startsWith('v1.7-user-ids-')), 'users.json backed up before ids were added');
  const copy = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', mig, 'projects', 'p_legacy1.json'), 'utf8'));
  assert.equal(copy.ownerId, undefined, 'backup holds the untouched v1.6 file');
  const log = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', mig, 'migration.json'), 'utf8'));
  assert.deepEqual([log.projects, log.media, log.exports, log.remaining], [1, 1, 1, 0]);
  // the admin still sees everything from before
  assert.deepEqual((await as(A, 'GET', '/api/projects')).json().map((p) => p.id), ['p_legacy1']);
  assert.equal((await as(A, 'GET', '/api/media/m_legacy1/file')).body, 'PNG!');
  assert.equal((await as(A, 'GET', '/exports/lama.mp4')).body, 'MP4!');
});

test('projects: another account gets 404 for list/get/put/delete; ownerId from the client is ignored', async () => {
  assert.deepEqual((await as(B, 'GET', '/api/projects')).json(), [], 'B sees none of A\'s projects');
  assert.equal((await as(B, 'GET', '/api/projects/p_legacy1')).status, 404);
  assert.equal((await as(B, 'PUT', '/api/projects/p_legacy1', { id: 'p_legacy1', name: 'dibajak', media: [] })).status, 404);
  assert.equal((await as(B, 'DELETE', '/api/projects/p_legacy1')).status, 404);
  assert.equal((await as(A, 'GET', '/api/projects/p_legacy1')).json().name, 'Proyek lama', 'A\'s project untouched');
  // B creates a project and claims it belongs to A: the server writes B
  assert.equal((await as(B, 'PUT', '/api/projects/p_bproj01', { id: 'p_bproj01', name: 'Milik B', ownerId: aId, media: [] })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'projects', 'p_bproj01.json'), 'utf8')).ownerId, bId);
  assert.equal((await as(A, 'GET', '/api/projects/p_bproj01')).status, 404);
  assert.deepEqual((await as(B, 'GET', '/api/projects')).json().map((p) => p.id), ['p_bproj01']);
  assert.equal((await as(B, 'GET', '/api/projects')).json()[0].ownerId, undefined, 'owner ids are not listed');
});

test('media: every media route answers 404 for another account; uploads cannot target someone else\'s media', async () => {
  for (const part of ['meta', 'file', 'edit', 'sprite', 'poster', 'peaks', 'proxy', 'proxy-status']) {
    assert.equal((await as(B, 'GET', `/api/media/m_legacy1/${part}`)).status, 404, `GET ${part}`);
  }
  assert.equal((await as(B, 'PUT', '/api/media/m_legacy1/meta', { id: 'm_legacy1', name: 'x' })).status, 404);
  assert.equal((await as(B, 'PUT', '/api/media/m_legacy1/peaks', Buffer.from('xx'))).status, 404);
  assert.equal((await as(B, 'POST', '/api/media/m_legacy1/proxy', {})).status, 404);
  assert.equal((await as(B, 'POST', '/api/media/m_legacy1/adopt', { source: '/media-cache/x.mp4' })).status, 404);
  assert.equal((await as(B, 'DELETE', '/api/media/m_legacy1')).status, 404);
  // upload into A's media id
  assert.equal((await as(B, 'PUT', '/api/upload/up_b000001/0', Buffer.from('EVIL'))).status, 200);
  assert.equal((await as(B, 'POST', '/api/upload/up_b000001/finish', { parts: 1, size: 4, target: 'media', mediaId: 'm_legacy1', filename: 'a.png', mime: 'image/png' })).status, 404);
  assert.equal(fs.readFileSync(path.join(dataDir, 'library', 'm_legacy1', 'source.png'), 'utf8'), 'PNG!', 'A\'s file untouched');
  // A cannot write into or finish B's upload session
  assert.equal((await as(A, 'PUT', '/api/upload/up_b000001/1', Buffer.from('XX'))).status, 404);
  assert.equal((await as(A, 'POST', '/api/upload/up_b000001/finish', { parts: 1, size: 4, target: 'media', mediaId: 'm_anew0001', filename: 'a.png', mime: 'image/png' })).status, 404);
  // B's own media works and is B's
  assert.equal((await as(B, 'PUT', '/api/media/m_bmed001/meta', { id: 'm_bmed001', name: 'b.png' })).status, 200);
  const fin = await as(B, 'POST', '/api/upload/up_b000001/finish', { parts: 1, size: 4, target: 'media', mediaId: 'm_bmed001', filename: 'b.png', mime: 'image/png' });
  assert.equal(fin.status, 200);
  assert.equal(fin.json().path, undefined, 'no server paths for non-admins');
  assert.equal((await as(B, 'GET', '/api/media/m_bmed001/file')).body, 'EVIL');
  assert.equal((await as(A, 'GET', '/api/media/m_bmed001/meta')).status, 404);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'library', 'm_bmed001', 'meta.json'), 'utf8')).ownerId, bId);
  assert.equal((await as(B, 'GET', '/api/media/m_bmed001/meta')).json().ownerId, undefined, 'owner id not sent back');
});

test('exports, status and server paths are per account', async () => {
  assert.equal((await as(B, 'GET', '/exports/lama.mp4')).status, 404);
  assert.equal((await as(B, 'PUT', '/api/upload/up_bexp001/0', Buffer.from('BVID'))).status, 200);
  const exp = (await as(B, 'POST', '/api/upload/up_bexp001/finish', { parts: 1, size: 4, target: 'export', filename: 'video-b.mp4', mime: 'video/mp4' })).json();
  assert.equal(exp.path, undefined);
  assert.equal((await as(B, 'GET', exp.url)).body, 'BVID');
  assert.equal((await as(A, 'GET', exp.url)).status, 404);
  const sB = (await as(B, 'GET', '/api/status')).json();
  assert.equal(sB.exportsDir, undefined, 'no server folders for editors');
  assert.equal(sB.mcp.stdio, undefined);
  assert.equal(sB.account.id, bId);
  const sA = (await as(A, 'GET', '/api/status')).json();
  assert.ok(sA.exportsDir, 'admins still see the export folder');
  // an export reported by A's editor is not shown to B
  assert.equal((await as(A, 'POST', '/bridge/result', { id: 'none', exportStatus: { state: 'done', file: 'rahasia-a.mp4' } })).status, 200);
  assert.equal((await as(A, 'GET', '/api/status')).json().lastExport.file, 'rahasia-a.mp4');
  assert.equal((await as(B, 'GET', '/api/status')).json().lastExport, null);
});

test('MCP: a personal token reaches only its own account\'s editor; the server token is the first admin', async () => {
  // A's editor is open (SSE bridge)
  const sse = http.get({ host: '127.0.0.1', port: srv.port, path: '/bridge/events?client=tabA', headers: { ...H, cookie: A } });
  const events = [];
  await new Promise((r) => sse.on('response', (res) => { res.on('data', (d) => events.push(String(d))); r(); }));
  try {
    assert.equal((await as(A, 'GET', '/api/status')).json().editors, 1);
    assert.equal((await as(B, 'GET', '/api/status')).json().editors, 0, 'B does not see A\'s editor');
    // B's personal token
    assert.equal((await as(B, 'GET', '/api/me/token')).json().exists, false);
    const tok = (await as(B, 'POST', '/api/me/token')).json().token;
    assert.match(tok, /^najja_pat_/);
    const info = (await as(B, 'GET', '/api/me/token')).json();
    assert.equal(info.exists, true);
    assert.equal(info.hint, tok.slice(-4));
    assert.ok(!fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8').includes(tok), 'only a hash is stored');
    const mcp = (bearer, body) => req(srv.port, { method: 'POST', path: '/mcp', headers: { host: HOST, 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_project', arguments: {} } };
    const viaB = (await mcp(tok, call)).json();
    assert.equal(viaB.result.isError, true);
    assert.match(viaB.result.content[0].text, /not open in a browser for this account/);
    assert.ok(!events.join('').includes('get_project'), 'A\'s editor never got B\'s call');
    // the server token is the first admin: the call goes to A's editor
    const pending = mcp(TOKEN, { ...call, id: 3 });
    let cmd = null;
    for (let i = 0; i < 40 && !cmd; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const m = /event: command\ndata: (.+)\n/.exec(events.join(''));
      if (m) cmd = JSON.parse(m[1]);
    }
    assert.equal(cmd?.tool, 'get_project', 'server token reaches the primary owner\'s editor');
    // B cannot answer (or forge an answer to) A's pending call; A's editor can
    await as(B, 'POST', '/bridge/result', { id: cmd.id, result: { text: 'palsu dari B' } });
    await as(A, 'POST', '/bridge/result', { id: cmd.id, result: { text: 'asli dari A' } });
    const res = (await pending).json();
    assert.match(res.result.content[0].text, /asli dari A/);
    // wrong / revoked tokens
    assert.equal((await mcp('najja_pat_salah', call)).status, 401);
    assert.equal((await as(B, 'DELETE', '/api/me/token')).status, 200);
    assert.equal((await mcp(tok, call)).status, 401, 'revoked token stops working');
    assert.equal((await req(srv.port, { method: 'POST', path: '/api/me/token', headers: { ...J, authorization: `Bearer ${TOKEN}` } })).status, 403, 'tokens are managed from a login session only');
  } finally { sse.destroy(); }
});

test('imports: server-disk paths are admin only; non-admin URL imports cannot reach private addresses', async () => {
  const tool = (cookie, args) => as(cookie, 'POST', '/api/tool', { name: 'import_media', arguments: args });
  const disk = (await tool(B, { path: 'ok.png' })).json();
  assert.equal(disk.isError, true);
  assert.match(disk.content[0].text, /only allowed for admins/);
  for (const url of ['http://127.0.0.1:1/x.mp4', 'http://localhost/x.mp4', 'http://10.0.0.5/a.png', 'http://[::1]/a.mp4', 'http://169.254.169.254/latest.png']) {
    const r = (await tool(B, { url })).json();
    assert.equal(r.isError, true, url);
    assert.match(r.content[0].text, /public internet|Cannot resolve/, url);
  }
});

test('deleting an account moves its data to the acting admin (backed up)', async () => {
  const r = (await as(A, 'DELETE', '/api/users/tim@najja.id')).json();
  assert.deepEqual([r.moved.projects, r.moved.media, r.moved.exports], [1, 1, 1]);
  assert.ok(fs.existsSync(r.moved.backup));
  assert.deepEqual((await as(A, 'GET', '/api/projects')).json().map((p) => p.id).sort(), ['p_bproj01', 'p_legacy1']);
  assert.equal((await as(A, 'GET', '/api/media/m_bmed001/file')).body, 'EVIL');
});

test('tenancy unit: dry run changes nothing; migration is idempotent; local-mode data waits for an account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-ten-unit-'));
  fs.mkdirSync(path.join(dir, 'projects'));
  fs.writeFileSync(path.join(dir, 'projects', 'p_one0001.json'), JSON.stringify({ id: 'p_one0001', ownerId: 'local' }));
  let owner = 'local';
  const t = createTenancy({ dataDir: dir, exportDir: path.join(dir, 'exports'), primaryOwner: () => owner });
  assert.equal(t.owns({ id: 'p_one0001' }, { id: 'local' }), true, 'local mode: everything is the local user\'s');
  assert.equal((await t.migrate()).applied, false, 'no account yet: nothing written');
  owner = 'u_aaaaaaaaaaaaaaaa';
  const dry = await t.migrate({ dryRun: true });
  assert.deepEqual([dry.projects, dry.applied], [1, false]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'projects', 'p_one0001.json'), 'utf8')).ownerId, 'local');
  assert.equal((await t.migrate()).applied, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'projects', 'p_one0001.json'), 'utf8')).ownerId, owner);
  const again = await t.migrate();
  assert.deepEqual([again.projects, again.applied], [0, false], 'second run is a no-op');
  assert.equal(t.owns({ ownerId: 'u_other' }, { id: owner }), false);
  assert.equal(t.owns({}, null), false);
});
