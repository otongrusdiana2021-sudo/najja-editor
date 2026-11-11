// Playback proxies: HEVC (and other files browsers may not decode) get an H.264 copy. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStorage } from '../lib/storage.js';
import { createProxyManager, capabilities, probe, proxyReasons } from '../lib/media-proxy.js';

const caps = await capabilities();
const hasHevc = caps.ffmpeg && /\blibx265\b/.test(execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }));
const skip = !caps.ffmpeg || !caps.x264 || !hasHevc ? 'ffmpeg with libx264 + libx265 is not installed' : false;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-proxy-'));
const st = createStorage(dir, { exportDir: path.join(dir, 'exports'), extFor: (n) => path.extname(n || '') || '.bin' });
const proxies = createProxyManager({ mediaDir: st.mediaDir, mediaFile: (id) => st.mediaFile(id) });

function makeMedia(id, name, args) {
  const mdir = st.mediaDir(id);
  fs.mkdirSync(mdir, { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(mdir, `source${path.extname(name)}`)]);
  fs.writeFileSync(path.join(mdir, 'meta.json'), JSON.stringify({ file: `source${path.extname(name)}`, mime: 'video/quicktime' }));
}
async function waitDone(id) {
  for (let i = 0; i < 300; i++) {
    const s = await proxies.status(id);
    if (!['pending', 'running'].includes(s.state)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('proxy timed out');
}

test('reasons: only codecs browsers may not play need a proxy', () => {
  const base = { container: 'mov,mp4,m4a,3gp,3g2,mj2', audio: { codec: 'aac' } };
  assert.deepEqual(proxyReasons({ ...base, video: { codec: 'h264', pix: 'yuv420p', transfer: 'bt709' } }), []);
  assert.deepEqual(proxyReasons({ ...base, video: { codec: 'hevc', pix: 'yuv420p', transfer: 'bt709' } }), ['video hevc']);
  assert.ok(proxyReasons({ ...base, video: { codec: 'h264', pix: 'yuv420p10le', transfer: 'arib-std-b67' } }).includes('HDR'));
  assert.ok(proxyReasons({ container: 'avi', video: { codec: 'mpeg4', pix: 'yuv420p' }, audio: null }).length > 0);
});

test('HEVC .mov gets one H.264 proxy, even when asked twice at once', { skip }, async () => {
  makeMedia('m_hevc0001', 'clip.mov', ['-f', 'lavfi', '-i', 'testsrc2=size=240x426:rate=30:duration=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
    '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const [a, b] = await Promise.all([proxies.ensure('m_hevc0001'), proxies.ensure('m_hevc0001', { force: true })]);
  assert.equal(a.state, 'pending');
  assert.ok(['pending', 'running'].includes(b.state));
  const done = await waitDone('m_hevc0001');
  assert.equal(done.state, 'ready', done.error);
  const info = await probe(proxies.proxyPath('m_hevc0001'));
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.video.pix, 'yuv420p');
  assert.equal(info.audio.codec, 'aac');
  assert.equal(info.width, 240);
  assert.ok(Math.abs(info.duration - 1.5) < 0.1, `duration ${info.duration}`);
  assert.ok(!fs.existsSync(`${proxies.proxyPath('m_hevc0001')}.tmp`));
});

test('H.264 file needs no proxy; force still makes one on request', { skip }, async () => {
  makeMedia('m_h2640001', 'clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  assert.equal((await proxies.status('m_h2640001')).state, 'none');
  assert.equal((await proxies.ensure('m_h2640001', { force: true })).state, 'pending');
  assert.equal((await waitDone('m_h2640001')).state, 'ready');
});

test('missing media reports unknown instead of throwing', async () => {
  assert.equal((await proxies.ensure('m_nothere01')).state, 'unknown');
});
