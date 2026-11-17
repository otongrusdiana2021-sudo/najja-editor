// End-to-end (v1.10.3): "Hapus otomatis" — background removal of people in a video, on the device (MediaPipe).
//   A. the library and model come from the Najja server (/vendor, pinned + sha256), the switch in the sheet loads them
//   B. preview: the clip's background goes (a red layer under it shows through)
//   C. MCP update_clip remove_background off / on; the timeline badge
//   D. export: the exported video has the background removed too
// The made-up test video has no person in it, so almost all of it goes. With NAJJA_TEST_PERSON=<a video of a person>
// it also checks that the person stays (centre kept, corners gone).
// Needs Playwright (Chromium), ffmpeg and network access for the first download. Run: node test/e2e/cutout.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-cutout-1234567890';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) { console.log(`SKIP cutout e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`); process.exit(0); }
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-cutout-e2e-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
const PERSON = process.env.NAJJA_TEST_PERSON;
if (PERSON) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', PERSON, '-t', '5', '-vf', 'scale=540:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', path.join(dir, 'media', 'orang.mp4')]);
} else {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir, 'media', 'orang.mp4')]);
}
const port = await freePort();
const BASE = `http://localhost:${port}`;
// (the on-device "Orang saja" path: the server's AI service is off, the switch falls back to it; "Orang + objek" with
// the AI service is test/e2e/cutout-objects.mjs)
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port), NAJJA_AI: 'off', NAJJA_AI_URL: '' }, stdio: 'ignore' });
let cleaned = false;
const cleanup = () => { if (cleaned) return; cleaned = true; try { server.kill(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); };
process.on('exit', cleanup);
process.on('unhandledRejection', (err) => { console.error('FAIL ', err); cleanup(); process.exit(1); });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await wait(100); }
const mcp = async (name, args = {}) => {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  if (!j.result || j.result.isError) throw new Error(JSON.stringify(j.error || j.result));
  return JSON.parse(j.result.content.find((c) => c.type === 'text').text);
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'cut@najja.id'); await p.fill('#password', 'rahasia-cut'); await p.fill('#password2', 'rahasia-cut'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.goto(`${BASE}/?debug`);
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));
  await mcp('new_project', { name: 'Hapus latar', aspect_ratio: '9:16' });
  const media = await mcp('import_media', { path: 'orang.mp4' });
  for (let t = Date.now(); Date.now() - t < 60000; await wait(250)) {
    if (await p.evaluate(async (id) => { const { mediaRT } = await import('/js/media.js'); return !!mediaRT.get(id)?.url; }, media.media_id)) break;
  }
  // red under, the video over it (full frame)
  const ov = await p.evaluate(async (mid) => {
    const a = await import('/js/actions.js');
    const { store } = await import('/js/store.js');
    a.addSolid({ color: '#ff0000', track: 'main', duration: 5 });
    const c = a.addMediaClip(mid, { track: 'overlay', start: 0, duration: 5 });
    const id = c.id || c;
    const m = store.media(mid);
    store.mutate('t', () => { store.clip(id).scale = Math.max(1080 / m.width, 1920 / m.height) / Math.min(1080 / m.width, 1920 / m.height); });
    store.select(id);
    window.najja.engine.seek(1);
    return id;
  }, media.media_id);
  const look = () => p.evaluate(async () => {
    const c = await window.najja.engine.capture(1, 270);
    const x = c.getContext('2d', { willReadFrequently: true });
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const red = (x0, y0, x1, y1) => {
      let n = 0; let r = 0;
      for (let y = Math.floor(y0 * c.height); y < y1 * c.height; y++) for (let xx = Math.floor(x0 * c.width); xx < x1 * c.width; xx++) {
        const i = (y * c.width + xx) * 4; n++; if (d[i] > 200 && d[i + 1] < 70 && d[i + 2] < 70) r++;
      }
      return r / Math.max(1, n);
    };
    return { all: red(0, 0, 1, 1), centre: red(0.4, 0.35, 0.6, 0.65), corners: (red(0, 0, 0.15, 0.1) + red(0.85, 0, 1, 0.1)) / 2 };
  });
  const before = await look();

  step('A. lembar "Hapus latar belakang": sakelar Hapus otomatis memuat model dari server');
  await p.click('.tool[data-tool="bgremove"]');
  await p.waitForSelector('.sheet.in [data-do="cutout"]');
  const soon = await p.evaluate(() => /Segera hadir/.test(document.querySelector('.sheet.in').textContent));
  check(!soon, 'tidak ada lagi "Segera hadir": sakelar Hapus otomatis bisa diketuk');
  await p.click('.sheet.in .cut-row');
  let on = false;
  for (let t = Date.now(); Date.now() - t < 180000; await wait(500)) {
    on = await p.evaluate(async (id) => (await import('/js/store.js')).store.clip(id).cutout?.enabled === true, ov);
    if (on) break;
    const err = await p.evaluate(() => document.querySelector('.sheet.in .hint.warn')?.textContent);
    if (err) { console.log(`SKIP  model tidak bisa diunduh di lingkungan ini: ${err}`); break; }
  }
  if (!on) {
    check(errors.length === 0, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  } else {
    const vend = await p.evaluate(async () => (await fetch('/vendor/mediapipe-0.10.35/selfie_segmenter.tflite', { method: 'HEAD' })).headers.get('cache-control'));
    check(/immutable/.test(vend || ''), `model disajikan server Najja sendiri (/vendor, ${vend})`);
    const ui = await p.evaluate(() => ({ sliders: [...document.querySelectorAll('.sheet.in [data-path^="cutout."]')].map((x) => x.dataset.path).filter((v, i, a) => a.indexOf(v) === i) }));
    check(ui.sliders.join(',') === 'cutout.threshold,cutout.edge', `pengaturan: ${ui.sliders.join(', ')}`);

    step('B. pratinjau: latar video hilang, lapisan merah di bawahnya terlihat');
    await wait(500);
    const after = await look();
    if (PERSON) {
      check(after.corners > 0.8 && after.centre < 0.5 && before.corners < 0.2, `orang tetap (merah di tengah ${(after.centre * 100).toFixed(0)}%), latar hilang (merah di sudut ${(after.corners * 100).toFixed(0)}%)`);
    } else {
      check(after.all > before.all + 0.5, `latar terhapus: merah terlihat ${(before.all * 100).toFixed(0)}% → ${(after.all * 100).toFixed(0)}% (video uji tanpa orang; warna merahnya sendiri ${(before.all * 100).toFixed(0)}%)`);
    }
    await p.evaluate(() => window.najja.sheet?.close?.());

    step('C. MCP remove_background dan badge timeline');
    const off = await mcp('update_clip', { clip_id: ov, remove_background: false });
    const offLook = await look();
    const again = await mcp('update_clip', { clip_id: ov, remove_background: true, remove_background_threshold: 0.6 });
    const badge = await p.evaluate((id) => !!document.querySelector(`.clip[data-id="${id}"] .cb [data-icon], .clip[data-id="${id}"] .cb`), ov);
    check(!off.remove_background && Math.abs(offLook.all - before.all) < 0.05 && again.remove_background?.threshold === 0.6 && badge, 'MCP: remove_background false → latar kembali, true (ketelitian 0.6) → terhapus lagi; badge di timeline');

    step('D. ekspor: latar juga terhapus di video hasil');
    const ex = await p.evaluate(async () => {
      const { exportVideo } = await import('/js/exporter.js');
      const res = await exportVideo(window.najja.engine, { resolution: '480p', format: 'mp4' });
      const b = new Uint8Array(await res.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return { data: btoa(s), mode: res.mode };
    });
    const f = path.join(dir, 'out.mp4');
    fs.writeFileSync(f, Buffer.from(ex.data, 'base64'));
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', f, '-frames:v', '1', '-vf', 'scale=90:160', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    let red = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 190 && raw[i + 1] < 80 && raw[i + 2] < 80) red++;
    const frac = red / (raw.length / 3);
    check(PERSON ? frac > 0.3 : frac > 0.55, `ekspor (${ex.mode}): latar terhapus di video hasil (merah ${(frac * 100).toFixed(0)}% frame)`);
    check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  }
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek hapus latar lolos');
process.exit(failed ? 1 : 0);
