// lib/vendor.js: browser libraries fetched once from a pinned version, checked by sha256. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { untar, createVendor, VENDOR } from '../lib/vendor.js';

function tar(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h[156] = 48; // '0'
    h.write('ustar\0', 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('untar reads the regular files of an archive', () => {
  const files = untar(tar({ 'package/a.js': Buffer.from('export const a = 1;'), 'package/wasm/b.wasm': Buffer.alloc(1300, 7) }));
  assert.equal(files.get('package/a.js').toString(), 'export const a = 1;');
  assert.equal(files.get('package/wasm/b.wasm').length, 1300);
});

test('a pinned package: fetched once, checked, served; a wrong file is refused', async () => {
  const spec = VENDOR.onnxruntime;
  const contents = Object.fromEntries(Object.values(spec.files).map((p) => [p, Buffer.from(`// ${p}`)]));
  const tgz = zlib.gzipSync(tar(contents));
  const saved = spec.sha256;
  spec.sha256 = sha(tgz);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-vendor-'));
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, arrayBuffer: async () => tgz }; };
  try {
    const v = createVendor({ dir, fetchImpl });
    assert.equal(v.resolve('/vendor/onnxruntime-1.29.0/../../etc/passwd'), null);
    assert.equal(v.resolve('/vendor/onnxruntime-0.0.1/ort.webgpu.min.mjs'), null, 'another version: not served');
    assert.deepEqual(v.resolve(`/vendor/onnxruntime-${spec.version}/ort-wasm-simd-threaded.asyncify.wasm`), { name: 'onnxruntime', file: 'ort-wasm-simd-threaded.asyncify.wasm' });
    const [a, b] = await Promise.all([v.ensure('onnxruntime'), v.ensure('onnxruntime')]);
    assert.equal(a, b);
    assert.equal(calls, 1, 'one download, even when asked twice at once');
    assert.equal(fs.readFileSync(path.join(a, 'ort.webgpu.min.mjs'), 'utf8'), '// package/dist/ort.webgpu.min.mjs');
    await v.ensure('onnxruntime');
    assert.equal(calls, 1, 'kept: not fetched again');
    assert.equal(v.status('onnxruntime').ready, true);
    // a file that does not match its sha256 is refused, nothing is kept
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-vendor-'));
    const bad = createVendor({ dir: dir2, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('tampered') }) });
    await assert.rejects(bad.ensure('onnxruntime'), /tidak cocok/);
    assert.equal(fs.readdirSync(dir2).length, 0);
    assert.match(bad.status('onnxruntime').error, /tidak cocok/);
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    spec.sha256 = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the model: the AI service\'s copy is used when it is the same file; otherwise downloaded (streamed) and checked', async () => {
  const x = VENDOR.birefnet.extra['model.onnx'];
  const saved = { sha: x.sha256, size: x.size };
  const model = Buffer.from('model bytes of BiRefNet');
  x.sha256 = sha(model);
  x.size = model.length;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-vendor-data-'));
  try {
    // the AI service's models folder has it: no download
    fs.mkdirSync(path.join(data, 'models'));
    fs.writeFileSync(path.join(data, ...x.local), model);
    let calls = 0;
    const v = createVendor({ dir: path.join(data, 'vendor'), dataDir: data, fetchImpl: async () => { calls++; throw new Error('no network'); } });
    const base = await v.ensure('birefnet');
    assert.equal(calls, 0, 'taken from the models folder');
    assert.equal(fs.readFileSync(path.join(base, 'model.onnx'), 'utf8'), 'model bytes of BiRefNet');
    // a different file there (an older model) is not used: downloaded instead, as a stream
    const data2 = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-vendor-data-'));
    fs.mkdirSync(path.join(data2, 'models'));
    fs.writeFileSync(path.join(data2, ...x.local), Buffer.from('another model 1234567'));
    const stream = () => { const parts = [model.subarray(0, 5), model.subarray(5)]; return { getReader: () => ({ read: async () => (parts.length ? { value: parts.shift(), done: false } : { done: true }) }) }; };
    const v2 = createVendor({ dir: path.join(data2, 'vendor'), dataDir: data2, fetchImpl: async (url) => { assert.equal(url, x.url); return { ok: true, status: 200, body: stream() }; } });
    const base2 = await v2.ensure('birefnet');
    assert.equal(fs.readFileSync(path.join(base2, 'model.onnx'), 'utf8'), 'model bytes of BiRefNet');
    fs.rmSync(data2, { recursive: true, force: true });
  } finally {
    x.sha256 = saved.sha;
    x.size = saved.size;
    fs.rmSync(data, { recursive: true, force: true });
  }
});
