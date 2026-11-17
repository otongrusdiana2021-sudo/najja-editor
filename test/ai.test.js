// AI tools of the home screen (v1.8): requests per account, background removal and upscaling through the Python
// service. The model runs need the model files: set NAJJA_AI_MODELS to a folder holding them (see ai/models.json),
// otherwise those checks are skipped. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'ai-token-0123456789abcdef';
const HOST = 'editor.example.com';
const H = { host: HOST, 'x-forwarded-proto': 'https', origin: `https://${HOST}` };
const MODELS = process.env.NAJJA_AI_MODELS || '';
const hasModels = !!MODELS && ['birefnet-lite-512.onnx', 'real_esrgan_general_x4v3.onnx'].every((f) => fs.existsSync(path.join(MODELS, f)));
const hasPython = (() => { try { execFileSync('python3', ['-c', 'import onnxruntime, numpy, PIL'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, buf, json: () => JSON.parse(buf.toString()) }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

let srv;
let dir;
let A;
let B;
let png;
let jpg;
const as = (cookie, method, p, body, type) => req(srv.port, { method, path: p, headers: { ...H, cookie, ...(type ? { 'content-type': type } : {}) }, body });
const login = async (email, password) => {
  const r = await req(srv.port, { method: 'POST', path: '/login', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password, password2: password, token: TOKEN }).toString() });
  assert.ok([302, 303].includes(r.status), `login ${email}: ${r.status}`);
  return r.headers['set-cookie'][0].split(';')[0];
};
const until = async (fn, ms = 180000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 400)); } };
const imageSize = (buf) => JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,io,json; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps([im.width, im.height, im.mode]))'], { input: buf }).toString());

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-ai-'));
  const port = 39500 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server.js', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, NAJJA_NO_OPEN: '1', PORT: String(port), HOST: '127.0.0.1', NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, NAJJA_AI_URL: '', ...(MODELS ? { NAJJA_AI_MODELS: MODELS } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('Najja Editor')) resolve(); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  srv = { child, port };
  A = await login('bos@najja.id', 'rahasia123'); // first account (setup)
  assert.equal((await as(A, 'POST', '/api/users', JSON.stringify({ email: 'tim@najja.id', password: 'timpass123', role: 'editor' }), 'application/json')).status, 200);
  B = await login('tim@najja.id', 'timpass123');
  if (hasFfmpeg) {
    // a product-like picture: a dark bag shape on a light wall (cutout), and a small photo (upscale)
    png = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xe8e2d8:s=320x400,drawbox=x=90:y=140:w=150:h=170:color=0x4a2a1a:t=fill,drawbox=x=120:y=100:w=90:h=50:color=0x2a1a10:t=8', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
    jpg = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=180x240', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
  }
});
after(() => { srv?.child.kill(); });

test('AI requests: image formats only, each account sees only its own', { skip: !hasFfmpeg && 'ffmpeg missing' }, async () => {
  assert.equal((await as(A, 'POST', '/api/ai/cutout', Buffer.from('hello'), 'text/plain')).status, 400, 'not an image: refused');
  assert.ok([404, 405].includes((await as(A, 'POST', '/api/ai/blur', png, 'image/png')).status), 'unknown tool');
  const r = await as(A, 'POST', '/api/ai/cutout?name=Tas', png, 'image/png');
  assert.equal(r.status, 200);
  const rec = r.json();
  assert.match(rec.id, /^ai_[0-9a-f]{16}$/);
  assert.equal(rec.tool, 'cutout');
  assert.equal((await as(B, 'GET', `/api/ai/${rec.id}`)).status, 404, 'another account: not found');
  assert.equal((await as(B, 'GET', `/api/ai/${rec.id}/input`)).status, 404);
  assert.equal((await as(B, 'DELETE', `/api/ai/${rec.id}`)).status, 404);
  const own = await as(A, 'GET', `/api/ai/${rec.id}/input`);
  assert.equal(own.status, 200);
  assert.equal(own.buf.length, png.length);
  assert.equal((await as(A, 'DELETE', `/api/ai/${rec.id}`)).status, 200);
  assert.equal((await as(A, 'GET', `/api/ai/${rec.id}`)).status, 404, 'deleted');
  assert.equal((await req(srv.port, { path: '/api/ai', headers: H })).status, 401, 'signed out: refused');
});

test('masks made on the device (v1.11): kept for their owner, size checked, only for a finished upload', async () => {
  const mid = 'm_maskdev1';
  assert.equal((await as(A, 'PUT', `/api/media/${mid}/meta`, JSON.stringify({ id: mid, name: 'v.mp4' }), 'application/json')).status, 200);
  const n = 10;
  const w = 8;
  const h = 16;
  const raw = Buffer.alloc(n * w * h);
  for (let i = 0; i < raw.length; i++) raw[i] = i % 256;
  const url = (o = {}) => `/api/masks?${new URLSearchParams({ mediaId: mid, start: 0, end: 1, fps: 10, n, w, h, model: 'birefnet-lite-512', ...o })}`;
  const post = (cookie, u, body, gz = true) => req(srv.port, { method: 'POST', path: u, headers: { ...H, cookie, 'content-type': 'application/octet-stream', ...(gz ? { 'x-najja-gzip': '1' } : {}) }, body });
  const gz = zlib.gzipSync(raw);
  const early = await post(A, url(), gz);
  assert.equal(early.status, 409, 'the video is not on the server yet');
  assert.equal(early.json().code, 'uploading');
  assert.equal((await as(A, 'PUT', '/api/upload/up_maskdev1/0', Buffer.from('VIDEO'))).status, 200);
  assert.equal((await as(A, 'POST', '/api/upload/up_maskdev1/finish', JSON.stringify({ parts: 1, size: 5, target: 'media', mediaId: mid, filename: 'v.mp4', mime: 'video/mp4' }), 'application/json')).status, 200);
  assert.equal((await post(B, url(), gz)).status, 404, 'another account\'s video: refused');
  assert.equal((await post(A, url({ n: n + 1 }), gz)).status, 400, 'fewer bytes than frames: refused');
  assert.equal((await post(A, url(), Buffer.from('not gzip'))).status, 400, 'broken data: refused');
  assert.equal((await post(A, url({ w: 4096 }), gz)).status, 400, 'too big: refused');
  const ok = await post(A, url(), gz);
  assert.equal(ok.status, 200);
  const rec = ok.json();
  assert.match(rec.id, /^ai_[0-9a-f]{16}$/);
  assert.deepEqual([rec.mediaId, rec.n, rec.w, rec.h, rec.fps, rec.model], [mid, n, w, h, 10, 'birefnet-lite-512']);
  assert.equal(rec.ownerId, undefined, 'no owner id sent back');
  const got = await as(A, 'GET', `/api/masks/${rec.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-encoding'], 'gzip');
  assert.ok(zlib.gunzipSync(got.buf).equals(raw), 'the same masks come back');
  assert.equal((await as(B, 'GET', `/api/masks/${rec.id}`)).status, 404, 'another account: not found');
  // (not gzipped by the browser: stored gzipped all the same)
  const plain = await post(A, url(), raw, false);
  assert.equal(plain.status, 200);
  assert.ok(zlib.gunzipSync((await as(A, 'GET', `/api/masks/${plain.json().id}`)).buf).equals(raw));
});

test('background removal: a transparent PNG of the subject', { skip: (!hasModels || !hasPython || !hasFfmpeg) && 'model files / python / ffmpeg missing (set NAJJA_AI_MODELS)' }, async () => {
  const st = await until(async () => { const s = (await as(A, 'GET', '/api/ai')).json(); return s.available && s; }, 30000);
  assert.equal(st.tools.cutout.state, 'ready');
  const rec = (await as(A, 'POST', '/api/ai/cutout', png, 'image/png')).json();
  const done = await until(async () => { const x = (await as(A, 'GET', `/api/ai/${rec.id}`)).json(); return ['done', 'failed'].includes(x.state) && x; });
  assert.equal(done.state, 'done', done.error || '');
  assert.equal(done.result.type, 'image/png');
  const out = await as(A, 'GET', done.resultUrl);
  const [w, h, mode] = imageSize(out.buf);
  assert.deepEqual([w, h, mode], [320, 400, 'RGBA']);
  // the wall around the bag is transparent, the bag is not
  const px = JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,io,json; from PIL import Image; a=Image.open(io.BytesIO(sys.stdin.buffer.read())).getchannel("A"); print(json.dumps([a.getpixel((10,10)), a.getpixel((165,230))]))'], { input: out.buf }).toString());
  assert.ok(px[0] < 40 && px[1] > 200, `alpha wall ${px[0]}, bag ${px[1]}`);
  assert.ok(done.result.subject, 'subject box');
});

test('upscale: 2× and 4× sharper copy, within 4096 px', { skip: (!hasModels || !hasPython || !hasFfmpeg) && 'model files / python / ffmpeg missing (set NAJJA_AI_MODELS)' }, async () => {
  for (const scale of [2, 4]) {
    const rec = (await as(A, 'POST', `/api/ai/upscale?scale=${scale}`, jpg, 'image/jpeg')).json();
    const done = await until(async () => { const x = (await as(A, 'GET', `/api/ai/${rec.id}`)).json(); return ['done', 'failed'].includes(x.state) && x; });
    assert.equal(done.state, 'done', done.error || '');
    const out = await as(A, 'GET', done.resultUrl);
    assert.deepEqual(imageSize(out.buf), [180 * scale, 240 * scale, 'RGB']);
    assert.equal(done.result.type, 'image/jpeg');
  }
});
