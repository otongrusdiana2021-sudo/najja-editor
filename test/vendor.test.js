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
  const spec = VENDOR.mediapipe;
  const contents = Object.fromEntries(Object.values(spec.files).map((p) => [p, Buffer.from(`// ${p}`)]));
  const tgz = zlib.gzipSync(tar(contents));
  const model = Buffer.from('model');
  const saved = { sha: spec.sha256, msha: spec.extra['selfie_segmenter.tflite'].sha256 };
  spec.sha256 = sha(tgz);
  spec.extra['selfie_segmenter.tflite'].sha256 = sha(model);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-vendor-'));
  let calls = 0;
  const fetchImpl = async (url) => { calls++; const body = url === spec.tarball ? tgz : model; return { ok: true, status: 200, arrayBuffer: async () => body }; };
  try {
    const v = createVendor({ dir, fetchImpl });
    assert.equal(v.resolve('/vendor/mediapipe-0.10.35/../../etc/passwd'), null);
    assert.equal(v.resolve('/vendor/mediapipe-0.0.1/vision_bundle.mjs'), null, 'another version: not served');
    assert.deepEqual(v.resolve(`/vendor/mediapipe-${spec.version}/wasm/vision_wasm_internal.wasm`), { name: 'mediapipe', file: 'wasm/vision_wasm_internal.wasm' });
    const [a, b] = await Promise.all([v.ensure('mediapipe'), v.ensure('mediapipe')]);
    assert.equal(a, b);
    assert.equal(calls, 2, 'one download of the package and one of the model, even when asked twice at once');
    assert.equal(fs.readFileSync(path.join(a, 'vision_bundle.mjs'), 'utf8'), '// package/vision_bundle.mjs');
    assert.equal(fs.readFileSync(path.join(a, 'selfie_segmenter.tflite'), 'utf8'), 'model');
    await v.ensure('mediapipe');
    assert.equal(calls, 2, 'kept: not fetched again');
    assert.equal(v.status('mediapipe').ready, true);
    // a file that does not match its sha256 is refused, nothing is kept
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-vendor-'));
    const bad = createVendor({ dir: dir2, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('tampered') }) });
    await assert.rejects(bad.ensure('mediapipe'), /tidak cocok/);
    assert.equal(fs.readdirSync(dir2).length, 0);
    assert.match(bad.status('mediapipe').error, /tidak cocok/);
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    spec.sha256 = saved.sha;
    spec.extra['selfie_segmenter.tflite'].sha256 = saved.msha;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
