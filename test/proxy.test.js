// Playback proxies: HEVC (and other files browsers may not decode) get an H.264 copy. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStorage } from '../lib/storage.js';
import { createProxyManager, capabilities, probe, proxyReasons, editReasons } from '../lib/media-proxy.js';

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
/** Until the preview copy and the thumbnails are done. */
async function waitEdit(id) {
  for (let i = 0; i < 600; i++) {
    const s = await proxies.status(id);
    if (!['pending', 'running'].includes(s.edit?.state) && s.assets) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('preview copy timed out');
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

test('preview copy only for heavy videos', () => {
  const v = (codec, w, h, bitrate) => ({ container: 'mov,mp4', video: { codec, pix: 'yuv420p', transfer: 'bt709' }, audio: { codec: 'aac' }, width: w, height: h, bitrate });
  assert.deepEqual(editReasons(v('h264', 720, 1280, 3e6)), []);
  assert.deepEqual(editReasons(v('h264', 1080, 1920, 3e6)), ['size']);
  assert.deepEqual(editReasons(v('h264', 720, 1280, 15e6)), ['bitrate']);
  assert.ok(editReasons(v('hevc', 720, 1280, 3e6)).includes('codec'));
  assert.deepEqual(editReasons({ container: 'mp3', video: null, audio: { codec: 'mp3' }, width: 0, height: 0, bitrate: 128e3 }), []);
});

test('1080p video gets a light 720p preview copy (keyframe every 0.5 s), filmstrip, poster and waveform', { skip }, async () => {
  makeMedia('m_big00001', 'big.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const first = await proxies.ensure('m_big00001');
  assert.equal(first.state, 'none', 'H.264 needs no full-quality copy');
  assert.ok(['pending', 'running'].includes(first.edit.state));
  const s = await waitEdit('m_big00001');
  assert.equal(s.edit.state, 'ready', s.edit.error);
  const info = await probe(proxies.editPath('m_big00001'));
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.height, 1280);
  assert.equal(info.width, 720);
  assert.equal(info.audio.codec, 'aac');
  const keys = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', proxies.editPath('m_big00001')], { encoding: 'utf8' })
    .trim().split('\n').map(Number);
  assert.ok(keys.length >= 6, `keyframes at ${keys.join(', ')}`);
  assert.deepEqual(s.assets.sprite, { n: 4, w: 41, h: 72 });
  assert.ok(s.assets.poster && s.assets.peaks);
  assert.ok(fs.statSync(proxies.assetPath('m_big00001', 'sprite.jpg')).size > 500);
  assert.ok(fs.statSync(proxies.assetPath('m_big00001', 'peaks.bin')).size >= 290); // 100 peaks per second
});

test('HEVC .mov: preview copy first, then the full-quality copy', { skip }, async () => {
  makeMedia('m_hevc0002', 'clip.mov', ['-f', 'lavfi', '-i', 'testsrc2=size=240x426:rate=30:duration=1.5', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-pix_fmt', 'yuv420p']);
  const st = await proxies.ensure('m_hevc0002');
  assert.equal(st.state, 'pending');
  assert.ok(['pending', 'running'].includes(st.edit.state));
  const done = await waitDone('m_hevc0002');
  assert.equal(done.state, 'ready');
  assert.equal(done.edit.state, 'ready', 'the preview copy was made before the full-quality one');
  assert.ok(fs.existsSync(proxies.editPath('m_hevc0002')));
});

test('missing media reports unknown instead of throwing', async () => {
  assert.equal((await proxies.ensure('m_nothere01')).state, 'unknown');
});

test('light preview copy also for 60 fps and HDR camera footage; at most 30 fps', async () => {
  const { previewFps } = await import('../lib/media-proxy.js');
  const base = { container: 'mov,mp4,m4a,3gp,3g2,mj2', audio: { codec: 'aac' }, bitrate: 4e6 };
  assert.deepEqual(editReasons({ ...base, video: { codec: 'h264', pix: 'yuv420p', transfer: '', fps: 30 }, width: 1280, height: 720 }), []);
  assert.deepEqual(editReasons({ ...base, video: { codec: 'h264', pix: 'yuv420p', transfer: '', fps: 60 }, width: 1280, height: 720 }), ['fps']);
  assert.ok(editReasons({ ...base, video: { codec: 'hevc', pix: 'yuv420p10le', transfer: 'arib-std-b67', fps: 30 }, width: 1080, height: 1920 }).includes('hdr'));
  assert.deepEqual([60, 59.94, 50, 120, 30, 25, 24].map(previewFps), [30, 29.97, 25, 30, 30, 25, 24]);
});

test('a light copy made with older rules (60 fps) is remade at ≤ 30 fps; the old one stays ready meanwhile', async () => {
  const id = 'm_old60fps1';
  const dir = st.mediaDir(id);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir, 'source.mp4')]);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, file: 'source.mp4', mime: 'video/mp4' }));
  // the state an earlier version left: probe without fps, a 60 fps light copy, edit.json without rules
  const info = await probe(path.join(dir, 'source.mp4'));
  delete info.video.fps;
  fs.writeFileSync(path.join(dir, 'proxy.json'), JSON.stringify({ state: 'none', reasons: [], probe: info, updatedAt: 1 }));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(dir, 'source.mp4'), '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(dir, 'edit.mp4')]);
  fs.writeFileSync(path.join(dir, 'edit.json'), JSON.stringify({ state: 'ready', reasons: ['size'], size: 1, updatedAt: 1 }));
  fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify({ sprite: { n: 4, w: 128, h: 72 }, poster: true, updatedAt: 1 }));
  const first = await proxies.status(id);
  assert.equal(first.edit.state, 'ready', 'the old copy stays ready while the new one is made');
  assert.equal(first.edit.upgrading, true, 'the editor is told to check back for the new copy');
  let ed;
  for (let i = 0; i < 300; i++) {
    ed = JSON.parse(fs.readFileSync(path.join(dir, 'edit.json'), 'utf8'));
    assert.equal(ed.state, 'ready', 'never pending/running during the upgrade');
    if (ed.rules >= 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(ed.rules, 2);
  assert.ok(ed.updatedAt > 1, 'new version number: devices fetch the new copy');
  assert.ok(ed.reasons.includes('fps'));
  const fps = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', path.join(dir, 'edit.mp4')], { encoding: 'utf8' }).trim();
  assert.equal(fps, '30/1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'proxy.json'), 'utf8')).probe.video.fps, 60, 'the probe now knows the frame rate');
  let after;
  for (let i = 0; i < 50; i++) { after = await proxies.status(id); if (!after.edit.upgrading) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(!after.edit.upgrading && after.edit.updatedAt === ed.updatedAt, 'done: no longer upgrading, new version');
  // a copy that the new rules would not change is only marked (same version)
  const id2 = 'm_old30fps1';
  const dir2 = st.mediaDir(id2);
  fs.mkdirSync(dir2, { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir2, 'source.mp4')]);
  fs.writeFileSync(path.join(dir2, 'meta.json'), JSON.stringify({ id: id2, file: 'source.mp4', mime: 'video/mp4' }));
  fs.writeFileSync(path.join(dir2, 'proxy.json'), JSON.stringify({ state: 'none', reasons: [], probe: await probe(path.join(dir2, 'source.mp4')), updatedAt: 1 }));
  fs.copyFileSync(path.join(dir2, 'source.mp4'), path.join(dir2, 'edit.mp4'));
  fs.writeFileSync(path.join(dir2, 'edit.json'), JSON.stringify({ state: 'ready', reasons: ['size'], size: 1, updatedAt: 5 }));
  fs.writeFileSync(path.join(dir2, 'assets.json'), JSON.stringify({ sprite: { n: 4, w: 128, h: 72 }, poster: true, updatedAt: 1 }));
  await proxies.status(id2);
  let ed2;
  for (let i = 0; i < 50; i++) { ed2 = JSON.parse(fs.readFileSync(path.join(dir2, 'edit.json'), 'utf8')); if (ed2.rules) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.deepEqual([ed2.rules, ed2.updatedAt], [2, 5]);
  // a light 60 fps original that got no light copy under the old rules gets one now (the original plays meanwhile)
  const id3 = 'm_none60fps';
  const dir3 = st.mediaDir(id3);
  fs.mkdirSync(dir3, { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=60:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir3, 'source.mp4')]);
  fs.writeFileSync(path.join(dir3, 'meta.json'), JSON.stringify({ id: id3, file: 'source.mp4', mime: 'video/mp4' }));
  const info3 = await probe(path.join(dir3, 'source.mp4'));
  delete info3.video.fps;
  fs.writeFileSync(path.join(dir3, 'proxy.json'), JSON.stringify({ state: 'none', reasons: [], probe: info3, updatedAt: 1 }));
  fs.writeFileSync(path.join(dir3, 'edit.json'), JSON.stringify({ state: 'none', reasons: [], updatedAt: 1 }));
  fs.writeFileSync(path.join(dir3, 'assets.json'), JSON.stringify({ sprite: { n: 4, w: 128, h: 72 }, poster: true, updatedAt: 1 }));
  const s3 = await proxies.status(id3);
  assert.deepEqual([s3.edit.state, s3.edit.upgrading], ['none', true]);
  let ed3;
  for (let i = 0; i < 200; i++) {
    ed3 = JSON.parse(fs.readFileSync(path.join(dir3, 'edit.json'), 'utf8'));
    assert.ok(['none', 'ready'].includes(ed3.state), 'never pending: the original keeps playing');
    if (ed3.rules >= 2) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual([ed3.state, ed3.rules, ed3.reasons], ['ready', 2, ['fps']]);
  const fps3 = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', path.join(dir3, 'edit.mp4')], { encoding: 'utf8' }).trim();
  assert.equal(fps3, '30/1');
});
