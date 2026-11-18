// End-to-end (v1.12.4): Style Konsep results are complete — subtitles, kinetic text, a sound effect on every text and
// transition — and no text covers a face.
//   A. apply_style storypop: the faces are found on this device (onnxruntime-web, WebAssembly) and kept in the
//      project; every text and sticker stays off them (measured in their real fonts); the rendered frames show the
//      face uncovered; SFX on their own tracks, made from the editor's own sounds
//   B. a second style uses the kept faces (the model is not run again); plan.sfx "none" leaves the sounds out
//   C. a device that cannot load the face model: the edit is still made, the face of a talking video is guessed
//   D. (only with NAJJA_TEST_FACE_VIDEO=/path/to/video.mp4, never committed) the real model on real footage; the model
//      is downloaded by the server, or taken from NAJJA_TEST_FACE_MODEL=/path/to/version-RFB-320.onnx (sha256-checked)
// The real face model (UltraFace RFB-320) is replaced by a tiny stand-in (test/fixtures/face-test-model.onnx: "a red
// patch in the upper middle is a face"); the test video draws that patch while the person talks.
// Needs Playwright (with Chromium) and ffmpeg; onnxruntime-web is fetched by the server (/vendor) the first time.
// Run: node test/e2e/stylefx.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-stylefx-1234567890';
const STAND_IN = path.join(ROOT, 'test', 'fixtures', 'face-test-model.onnx');
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) { console.log(`SKIP stylefx e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`); process.exit(0); }
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-stylefx-e2e-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
// the "talking" video 9:16: a grey wall, the red "face" in the upper middle for the first 12 s, a tone as the voice
ff(['-f', 'lavfi', '-i', 'color=c=0x808080:s=360x640:r=30:d=22', '-f', 'lavfi', '-i', 'color=c=0xe63c3c:s=144x160:r=30:d=22', '-f', 'lavfi', '-i', 'sine=f=300:sample_rate=48000:d=22',
  '-filter_complex', "[0][1]overlay=x=108:y=96:enable='lt(t,12)'[v]", '-map', '[v]', '-map', '2:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(dir, 'media', 'ngomong.mp4')]);
ff(['-f', 'lavfi', '-i', 'color=c=0x2266cc:s=360x640:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(dir, 'media', 'produk.mp4')]);
const SAID = ['Halo semuanya, hari ini aku mau review travel bag mini.', 'Tas ini muat lima sampai enam outfit, ringan banget dan anti air.', 'Kamu butuh lebih dari satu size?', 'Harganya cuma 149 ribu, seharga tiket bioskop.', 'Buruan checkout sebelum stok habis ya.'];
const WORDS = [];
{ let t = 0.8; for (const s of SAID) { for (const w of s.split(' ')) { WORDS.push({ w, s: +t.toFixed(3), e: +(t + 0.3).toFixed(3) }); t += 0.36; } t += 1.2; } }
const PRODUCT = { name: 'Travel Bag', variant: 'Mini, Medium, Jumbo', price: '189rb', price_discount: '149rb' };

const port = await freePort();
const BASE = `http://localhost:${port}`;
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
  const t = j.result.content.find((c) => c.type === 'text');
  const img = j.result.content.find((c) => c.type === 'image');
  return { ...JSON.parse(t.text), img: img?.data };
};

/** A new project with the talking video and the product shot, the transcript put in (Whisper is not here). */
async function setup(p, name) {
  await mcp('new_project', { name, aspect_ratio: '9:16' });
  const talk = (await mcp('import_media', { path: 'ngomong.mp4' })).media_id;
  const shot = (await mcp('import_media', { path: 'produk.mp4' })).media_id;
  await mcp('add_media_clip', { media_id: talk, track: 'main' });
  for (let t = Date.now(); Date.now() - t < 60000; await wait(250)) {
    if (await p.evaluate(async (list) => { const { mediaRT } = await import('/js/media.js'); return list.every((id) => mediaRT.get(id)?.url); }, [talk, shot])) break;
  }
  return p.evaluate(async ({ talk, shot, words }) => {
    const { store } = await import('/js/store.js');
    store.P.speech = { [talk]: { lang: 'id', words }, [shot]: { lang: 'id', words: [] } };
    await store.save({ force: true });
    return { id: store.P.id, talk, shot };
  }, { talk, shot, words: WORDS });
}

/** In the open project: texts/stickers on a face (measured in their fonts), the SFX, the face boxes per time. */
const inspect = (p) => p.evaluate(async () => {
  const { store } = await import('/js/store.js');
  const { faceRectsAt } = await import('/js/stylefx.js');
  const { baseSize } = await import('/js/render.js');
  const { mediaRT } = await import('/js/media.js');
  await document.fonts.ready;
  const P = store.P;
  const ctx = document.createElement('canvas').getContext('2d');
  const ov = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const ar = (a) => (a.x2 - a.x1) * (a.y2 - a.y1);
  const onFace = [];
  const texts = P.clips.filter((c) => c.type === 'text' || c.type === 'sticker');
  for (const c of texts) {
    const s = baseSize(c, { project: P }, ctx);
    const w = s.w * (c.scale ?? 1);
    const h = s.h * (c.scale ?? 1);
    const cx = P.width / 2 + c.x * P.width;
    const cy = P.height / 2 + c.y * P.height;
    const r = { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
    for (let t = c.start; t < c.start + c.duration; t += 0.2) {
      if (faceRectsAt(P, t).some((f) => ov(r, f) > Math.min(ar(f), ar(r)) * 0.04)) { onFace.push(`${c.text?.content ?? c.sticker?.emoji}@${t.toFixed(1)}`); break; }
    }
  }
  const sfxTracks = P.tracks.filter((t) => /^SFX/.test(t.name)).map((t) => t.id);
  const sfx = P.clips.filter((c) => sfxTracks.includes(c.trackId)).map((c) => {
    const m = P.media.find((x) => x.id === c.mediaId);
    return { id: m?.stock, start: c.start, ready: mediaRT.get(c.mediaId)?.status === 'ready' };
  });
  const words = texts.filter((c) => !P.tracks.find((t) => t.id === c.trackId)?.subtitle && c.type === 'text').map((c) => ({ t: c.start + Math.min(0.6, c.duration / 2), w: c.text.content }));
  return { id: P.id, n: texts.length, onFace, sfx, sfxTracks: sfxTracks.length, words, faces: words.map((x) => ({ t: x.t, w: x.w, r: faceRectsAt(P, x.t) })) };
});

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  let modelRequests = 0;
  await ctx.route('**/vendor/ultraface-320/model.onnx', (route) => { modelRequests++; route.fulfill({ status: 200, body: fs.readFileSync(STAND_IN), contentType: 'application/octet-stream' }); });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'wajah@najja.id'); await p.fill('#password', 'rahasia-wajah'); await p.fill('#password2', 'rahasia-wajah'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.goto(`${BASE}/?debug`);
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));
  const src = await setup(p, 'Review Tas');

  step('A. apply_style storypop: wajah dicari, teks menghindar, SFX lengkap');
  const t0 = Date.now();
  const sp = await mcp('apply_style', { style: 'storypop', product: PRODUCT });
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} dtk) faces ${JSON.stringify(sp.faces)}, sfx ${sp.sfx}`);
  const orig = await p.evaluate(async (id) => (await (await fetch(`/api/projects/${id}`, { credentials: 'same-origin' })).json()), src.id);
  const f = orig.media.find((m) => m.id === src.talk)?.faces;
  const early = f?.samples.filter(([t]) => t < 11.5) || [];
  const late = f?.samples.filter(([t]) => t > 12.5) || [];
  const near = (b) => b && Math.abs(b[0] - 0.3) < 0.02 && Math.abs(b[1] - 0.15) < 0.02 && Math.abs(b[2] - 0.7) < 0.02 && Math.abs(b[3] - 0.4) < 0.02;
  check(f?.v === 1 && f.samples.length >= 40 && early.every(([, b]) => b.length === 1 && near(b[0])) && late.every(([, b]) => !b.length),
    `wajah ditemukan di perangkat dan disimpan di proyek asli: ${f?.samples.length} titik, kotak ${JSON.stringify(early[0]?.[1][0])} selama 12 dtk pertama, tidak ada sesudahnya`);
  check(sp.faces?.checked > 0 && sp.faces.moved > 0 && sp.faces.left === 0, `teks yang kena wajah digeser (${sp.faces?.moved} kelompok, ${sp.faces?.scaled} diperkecil)`);
  const a = await inspect(p);
  check(a.onFace.length === 0 && a.n > 10, `tidak ada teks/stiker di wajah (${a.n} dicek, ukuran asli font)${a.onFace.length ? `: ${a.onFace.join(', ')}` : ''}`);
  const ids = new Set(a.sfx.map((s) => s.id));
  check(sp.sfx === a.sfx.length && a.sfx.length >= 15 && ['pop', 'cash', 'typing', 'click'].every((x) => ids.has(x)) && a.sfx.every((s) => s.ready),
    `${a.sfx.length} SFX di ${a.sfxTracks} track (${[...ids].join(', ')}), dari suara bawaan editor, siap diputar`);
  check(sp.subtitles > 0 && sp.keywords > 0, `hasil lengkap: ${sp.subtitles} subtitle dari transkrip, ${sp.keywords} kata kunci kinetik, harga, SFX`);
  // what is seen: the face (red) is not painted over at the moments of the big words
  let covered = 0;
  let looked = 0;
  for (const x of a.faces.filter((y) => y.r.length && y.t < 11.5).slice(0, 4)) {
    const fr = await mcp('get_frame', { time: x.t, max_width: 270, format: 'png' });
    const k = fr.width / 1080;
    const r = x.r[0];
    const red = await p.evaluate(async ({ src, box }) => {
      const im = new Image(); im.src = `data:image/png;base64,${src}`; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      // (the middle of the face box: the box has room around the face)
      const w = box.x2 - box.x1; const h = box.y2 - box.y1;
      const d = g.getImageData(Math.round(box.x1 + w * 0.3), Math.round(box.y1 + h * 0.35), Math.max(1, Math.round(w * 0.4)), Math.max(1, Math.round(h * 0.3))).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > d[i + 1] + 50 && d[i] > d[i + 2] + 50) n++;
      return n / (d.length / 4);
    }, { src: fr.img, box: { x1: r.x1 * k, y1: r.y1 * k, x2: r.x2 * k, y2: r.y2 * k } });
    looked++;
    if (red < 0.85) { covered++; console.log(`   wajah tertutup di ${x.t.toFixed(2)} dtk ("${x.w}"): ${(red * 100).toFixed(0)}% merah`); }
  }
  check(looked >= 2 && covered === 0, `frame hasil render: wajah tetap terlihat saat ${looked} kata besar muncul`);

  step('B. style kedua memakai data wajah yang tersimpan; plan.sfx none');
  const ed = await mcp('apply_style', { style: 'editorial', product: PRODUCT });
  const b = await inspect(p);
  check(modelRequests === 1 && b.onFace.length === 0 && ed.sfx > 0 && ed.faces.moved > 0, `Editorial: model wajah tidak dijalankan lagi (${modelRequests}× diambil), ${ed.faces.moved} kelompok teks digeser, ${ed.sfx} SFX`);
  const quiet = await mcp('apply_style', { style: 'showcase', product: PRODUCT, plan: { sfx: 'none' } });
  const q = await inspect(p);
  check(quiet.sfx === 0 && q.sfxTracks === 0 && q.onFace.length === 0, 'plan.sfx "none": tanpa SFX; teks tetap tidak menutupi wajah');
  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);

  step('C. perangkat yang tidak bisa memuat model wajah');
  const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await ctx2.route('**/vendor/ultraface-320/model.onnx', (route) => route.fulfill({ status: 503, body: JSON.stringify({ error: 'Server belum bisa mengunduh ultraface: offline' }), contentType: 'application/json' }));
  const p2 = await ctx2.newPage();
  await p2.goto(`${BASE}/`);
  await p2.fill('#email', 'wajah@najja.id'); await p2.fill('#password', 'rahasia-wajah');
  await p2.click('button[type=submit]');
  await p2.waitForSelector('body.ready');
  await p2.goto(`${BASE}/?debug`);
  await p2.waitForSelector('body.ready');
  await p.close();
  await p2.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'), null, { timeout: 15000 });
  await setup(p2, 'Tanpa Model');
  const g = await mcp('apply_style', { style: 'storypop', product: PRODUCT });
  check(/ditebak/.test(g.faces?.detection || '') && g.faces.moved > 0 && g.sfx > 0, `edit tetap jadi: "${g.faces?.detection}", ${g.faces?.moved} kelompok teks dijauhkan dari tebakan wajah, ${g.sfx} SFX`);
  await ctx2.close();

  if (process.env.NAJJA_TEST_FACE_VIDEO) {
    step('D. model asli pada video asli (lokal saja)');
    // (copied into this test's own data folder, which is deleted at the end)
    const file = `asli${path.extname(process.env.NAJJA_TEST_FACE_VIDEO) || '.mp4'}`;
    fs.copyFileSync(path.resolve(process.env.NAJJA_TEST_FACE_VIDEO), path.join(dir, 'media', file));
    const ctx3 = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    if (process.env.NAJJA_TEST_FACE_MODEL) {
      // (a copy of the real model, when this machine's server cannot download it: checked like the server checks it)
      const { VENDOR } = await import('../../lib/vendor.js');
      const buf = fs.readFileSync(process.env.NAJJA_TEST_FACE_MODEL);
      const sum = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex');
      if (sum !== VENDOR.ultraface.extra['model.onnx'].sha256) throw new Error('NAJJA_TEST_FACE_MODEL is not the pinned UltraFace RFB-320');
      await ctx3.route('**/vendor/ultraface-320/model.onnx', (route) => route.fulfill({ status: 200, body: buf, contentType: 'application/octet-stream' }));
    }
    const p3 = await ctx3.newPage();
    await p3.goto(`${BASE}/`);
    await p3.fill('#email', 'wajah@najja.id'); await p3.fill('#password', 'rahasia-wajah');
    await p3.click('button[type=submit]');
    await p3.waitForSelector('body.ready');
    await p3.goto(`${BASE}/?debug`);
    await p3.waitForSelector('body.ready');
    await p3.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'), null, { timeout: 15000 });
    await mcp('new_project', { name: 'Video Asli', aspect_ratio: '9:16' });
    const id = (await mcp('import_media', { path: file })).media_id;
    await mcp('add_media_clip', { media_id: id, track: 'main' });
    for (let t = Date.now(); Date.now() - t < 120000; await wait(500)) {
      if (await p3.evaluate(async (m) => (await import('/js/media.js')).mediaRT.get(m)?.url, id)) break;
    }
    const t1 = Date.now();
    const real = await p3.evaluate(async () => {
      const { store } = await import('/js/store.js');
      const { findFaces } = await import('/js/faces.js');
      const r = await findFaces(store.P);
      const m = store.P.media.find((x) => x.type === 'video');
      return { r, n: m.faces?.samples.length, withFace: m.faces?.samples.filter(([, b]) => b.length).length, first: m.faces?.samples.find(([, b]) => b.length)?.[1] };
    });
    check(real.r.looked === 1 && real.withFace >= real.n * 0.7, `UltraFace asli (${JSON.stringify(real.r)}): wajah di ${real.withFace}/${real.n} titik (${((Date.now() - t1) / 1000).toFixed(1)} dtk), contoh ${JSON.stringify(real.first)}`);
    // the whole style on it (the words of the test transcript stand in for Whisper)
    await p3.evaluate(async ({ words }) => {
      const { store } = await import('/js/store.js');
      const m = store.P.media.find((x) => x.type === 'video');
      store.P.speech = { [m.id]: { lang: 'id', words } };
      await store.save({ force: true });
    }, { words: WORDS });
    const st = await mcp('apply_style', { style: 'storypop', product: PRODUCT });
    const r = await inspect(p3);
    check(r.onFace.length === 0 && st.sfx > 0, `Story Pop di video asli: ${st.faces.moved} kelompok teks digeser, tidak ada teks di wajah${r.onFace.length ? ` (${r.onFace.join(', ')})` : ''}, ${st.sfx} SFX`);
    if (process.env.NAJJA_TEST_FACE_FRAMES) {
      // (frames for a person to look at)
      fs.mkdirSync(process.env.NAJJA_TEST_FACE_FRAMES, { recursive: true });
      for (const x of r.words.slice(0, 8)) {
        const fr = await mcp('get_frame', { time: x.t, max_width: 540 });
        fs.writeFileSync(path.join(process.env.NAJJA_TEST_FACE_FRAMES, `t${x.t.toFixed(2)}.jpg`), Buffer.from(fr.img, 'base64'));
      }
    }
    await ctx3.close();
  }
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek Style (wajah + SFX) lolos');
process.exit(failed ? 1 : 0);
