// End-to-end (v1.12.4, v1.12.5): Style Konsep results are complete — subtitles, kinetic text, a sound effect on every
// text and transition — and no text covers the person in the video (the whole person, the face above all).
//   A. apply_style storypop: the faces and the person are found on this device (onnxruntime-web, WebAssembly) and
//      kept in the project; every text and sticker stays off them (measured in their real fonts); the rendered frames
//      show the person uncovered; SFX on their own tracks, made from the editor's own sounds
//   B. a second style uses the kept faces (the model is not run again); plan.sfx "none" leaves the sounds out
//   C. a device that cannot load the models: the edit is still made, the person of a talking video is guessed
//   D. (only with NAJJA_TEST_FACE_VIDEO=/path/to/video.mp4, never committed) the real model on real footage; the model
//      models are downloaded by the server, or taken from NAJJA_TEST_FACE_MODEL=/path/to/version-RFB-320.onnx and
//      NAJJA_TEST_PERSON_MODEL=/path/to/mediapipe_selfie_segmentation.onnx (sha256-checked)
// The real models (UltraFace RFB-320, MediaPipe Selfie Segmentation) are replaced by tiny stand-ins
// (test/fixtures/face-test-model.onnx: "a red patch in the upper left is a face"; person-test-model.onnx: "red is a
// person"); the test video draws a red person on the left of a grey wall while the person talks.
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
const PERSON_STAND_IN = path.join(ROOT, 'test', 'fixtures', 'person-test-model.onnx');
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
// the "talking" video 9:16: a grey wall, a red person on the left (face 0.15-0.45 × 0.15-0.32, body 0-0.55 × 0.32-1 of
// the picture) for the first 12 s, then the empty wall; a tone as the voice
ff(['-f', 'lavfi', '-i', 'color=c=0x808080:s=360x640:r=30:d=22', '-f', 'lavfi', '-i', 'color=c=0xe63c3c:s=108x109:r=30:d=22', '-f', 'lavfi', '-i', 'color=c=0xc83232:s=198x435:r=30:d=22', '-f', 'lavfi', '-i', 'sine=f=300:sample_rate=48000:d=22',
  '-filter_complex', "[0][1]overlay=x=54:y=96:enable='lt(t,12)'[a];[a][2]overlay=x=0:y=205:enable='lt(t,12)'[v]", '-map', '[v]', '-map', '3:a',
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
async function setup(p, name, words = WORDS) {
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
  }, { talk, shot, words });
}

/** In the open project: texts/stickers on a face or a person (measured in their fonts), the SFX, the face boxes. */
const inspect = (p) => p.evaluate(async () => {
  const { store } = await import('/js/store.js');
  const { faceRectsAt, occupancy } = await import('/js/stylefx.js');
  const { baseSize } = await import('/js/render.js');
  const { mediaRT } = await import('/js/media.js');
  await document.fonts.ready;
  const P = store.P;
  const ctx = document.createElement('canvas').getContext('2d');
  const ov = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const ar = (a) => (a.x2 - a.x1) * (a.y2 - a.y1);
  const onFace = [];
  const onBody = [];
  const subs = new Set(P.tracks.filter((t) => t.subtitle).map((t) => t.id));
  const texts = P.clips.filter((c) => c.type === 'text' || c.type === 'sticker');
  for (const c of texts) {
    const s = baseSize(c, { project: P }, ctx);
    const w = s.w * (c.scale ?? 1);
    const h = s.h * (c.scale ?? 1);
    const cx = P.width / 2 + c.x * P.width;
    const cy = P.height / 2 + c.y * P.height;
    const r = { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
    const cv = occupancy(P, c.start, c.start + c.duration).cover(r);
    if (subs.has(c.trackId) ? cv.upper >= 0.05 : cv.body >= 0.05) onBody.push(`${c.text?.content ?? c.sticker?.emoji} (${(cv.body * 100).toFixed(0)}%)`);
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
  return { id: P.id, n: texts.length, onFace, onBody, sfx, sfxTracks: sfxTracks.length, words, faces: words.map((x) => {
    // (the person's cells at that moment, well inside the person: a mask cell is about 60 px, its edges are steps)
    const o = occupancy(P, x.t, x.t + 0.01);
    const inner = [];
    const R = 4;
    const b = (ii, jj) => ii >= 0 && jj >= 0 && ii < o.nx && jj < o.ny && o.body[jj * o.nx + ii] > 0.99;
    for (let j = 0; j < o.ny; j++) for (let i = 0; i < o.nx; i++) {
      let all = true;
      for (let dj = -R; dj <= R && all; dj++) for (let di = -R; di <= R && all; di++) all = b(Math.min(o.nx - 1, Math.max(0, i + di)), Math.min(o.ny - 1, Math.max(0, j + dj)));
      if (all) inner.push([(i + 0.5) * (P.width / o.nx), (j + 0.5) * (P.height / o.ny)]);
    }
    return { t: x.t, w: x.w, r: faceRectsAt(P, x.t), inner };
  }) };
});

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  let modelRequests = 0;
  await ctx.route('**/vendor/ultraface-320/model.onnx', (route) => { modelRequests++; route.fulfill({ status: 200, body: fs.readFileSync(STAND_IN), contentType: 'application/octet-stream' }); });
  await ctx.route('**/vendor/selfie-256/model.onnx', (route) => { modelRequests++; route.fulfill({ status: 200, body: fs.readFileSync(PERSON_STAND_IN), contentType: 'application/octet-stream' }); });
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

  step('A. apply_style storypop: orang dicari, teks menghindar, SFX lengkap');
  const t0 = Date.now();
  const sp = await mcp('apply_style', { style: 'storypop', product: PRODUCT });
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} dtk) faces ${JSON.stringify(sp.faces)}, sfx ${sp.sfx}`);
  const orig = await p.evaluate(async (id) => (await (await fetch(`/api/projects/${id}`, { credentials: 'same-origin' })).json()), src.id);
  const f = orig.media.find((m) => m.id === src.talk)?.faces;
  const early = f?.samples.filter(([t]) => t < 11.5) || [];
  const late = f?.samples.filter(([t]) => t > 12.5) || [];
  const near = (b) => b && Math.abs(b[0] - 0.15) < 0.02 && Math.abs(b[1] - 0.15) < 0.02 && Math.abs(b[2] - 0.45) < 0.02 && Math.abs(b[3] - 0.32) < 0.02;
  check(f?.v === 1 && f.samples.length >= 40 && early.every(([, b]) => b.length === 1 && near(b[0])) && late.every(([, b]) => !b.length),
    `wajah ditemukan di perangkat dan disimpan di proyek asli: ${f?.samples.length} titik, kotak ${JSON.stringify(early[0]?.[1][0])} selama 12 dtk pertama, tidak ada sesudahnya`);
  const ppl = orig.media.find((m) => m.id === src.talk)?.people;
  const cellsOf = (b64) => { const str = atob(b64); return Array.from({ length: ppl.cols * ppl.rows }, (_, i) => (str.charCodeAt(i >> 3) >> (i & 7)) & 1); };
  const at = (cells, u, v) => cells[Math.floor(v * ppl.rows) * ppl.cols + Math.floor(u * ppl.cols)];
  const e0 = ppl && cellsOf(ppl.samples.find(([t]) => t > 2)[1]);
  const l0 = ppl && cellsOf(ppl.samples.find(([t]) => t > 13)[1]);
  check(ppl?.v === 1 && ppl.cols === 18 && ppl.rows === 32 && ppl.samples.length === f.samples.length && at(e0, 0.25, 0.7) && at(e0, 0.3, 0.2) && !at(e0, 0.8, 0.7) && !l0.some(Boolean),
    `badan orang juga ditemukan dan disimpan (${ppl?.cols}×${ppl?.rows} sel per frame): kiri terisi, kanan kosong; setelah 12 dtk kosong`);
  check(sp.faces?.checked > 0 && sp.faces.moved > 0 && sp.faces.left === 0, `teks yang menutupi orang digeser (${sp.faces?.moved} kelompok, ${sp.faces?.scaled} diperkecil, ${sp.faces?.partly} masih sedikit kena)`);
  const a = await inspect(p);
  check(a.onFace.length === 0 && a.onBody.length === 0 && a.n > 10, `tidak ada teks/stiker yang menutupi orangnya, wajah maupun badan (${a.n} dicek, ukuran asli font)${a.onFace.length || a.onBody.length ? `: ${[...a.onFace, ...a.onBody].join(', ')}` : ''}`);
  const ids = new Set(a.sfx.map((s) => s.id));
  check(sp.sfx === a.sfx.length && a.sfx.length >= 15 && ['pop', 'cash', 'typing', 'click'].every((x) => ids.has(x)) && a.sfx.every((s) => s.ready),
    `${a.sfx.length} SFX di ${a.sfxTracks} track (${[...ids].join(', ')}), dari suara bawaan editor, siap diputar`);
  check(sp.subtitles > 0 && sp.keywords > 0, `hasil lengkap: ${sp.subtitles} subtitle dari transkrip, ${sp.keywords} kata kunci kinetik, harga, SFX`);
  // what is seen: the person (red) is not painted over at the moments of the big words
  let covered = 0;
  let looked = 0;
  for (const x of a.faces.filter((y) => y.inner.length > 50 && y.t < 11.5).slice(0, 5)) {
    const fr = await mcp('get_frame', { time: x.t, max_width: 540, format: 'png' });
    const k = fr.width / 1080;
    const red = await p.evaluate(async ({ src, pts }) => {
      const im = new Image(); im.src = `data:image/png;base64,${src}`; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (const [x, y] of pts) {
        const i = (Math.min(c.height - 1, Math.round(y)) * c.width + Math.min(c.width - 1, Math.round(x))) * 4;
        if (d[i] > d[i + 1] + 50 && d[i] > d[i + 2] + 50) n++;
      }
      return n / pts.length;
    }, { src: fr.img, pts: x.inner.map(([px, py]) => [px * k, py * k]) });
    looked++;
    if (red < 0.995) { covered++; console.log(`   orang tertutup di ${x.t.toFixed(2)} dtk ("${x.w}"): ${(red * 100).toFixed(1)}% tetap merah`); if (process.env.NAJJA_TEST_FACE_FRAMES) fs.writeFileSync(path.join(process.env.NAJJA_TEST_FACE_FRAMES, `stand-in-${x.t.toFixed(2)}.png`), Buffer.from(fr.img, 'base64')); }
  }
  check(looked >= 2 && covered === 0, `frame hasil render: orangnya (wajah + badan) tetap terlihat utuh saat ${looked} kata besar muncul`);

  step('B. style kedua memakai data orang yang tersimpan; plan.sfx none');
  const ed = await mcp('apply_style', { style: 'editorial', product: PRODUCT });
  const b = await inspect(p);
  check(modelRequests === 2 && b.onFace.length === 0 && b.onBody.length === 0 && ed.sfx > 0 && ed.faces.moved > 0, `Editorial: model tidak dijalankan lagi (${modelRequests} model diambil sekali), ${ed.faces.moved} kelompok teks digeser, tidak menutupi orang, ${ed.sfx} SFX`);
  const quiet = await mcp('apply_style', { style: 'showcase', product: PRODUCT, plan: { sfx: 'none' } });
  const q = await inspect(p);
  check(quiet.sfx === 0 && q.sfxTracks === 0 && q.onFace.length === 0 && q.onBody.length === 0, `plan.sfx "none": tanpa SFX (${quiet.sfx}, ${q.sfxTracks} track); Showcase juga tidak menutupi orang${q.onFace.length || q.onBody.length ? ` (${[...q.onFace, ...q.onBody].join(', ')})` : ''}`);
  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);

  step('E. momen dari ucapan: bulatan warna, timer, chip "bisa buat"');
  const SAID2 = ['Halo semuanya, ini tas travel yang lagi viral.', 'Warnanya ada tiga, hitam, cream, sama dusty pink.', 'Bisa buat baju basah, minuman, sama laptop.', 'Harganya cuma 149 ribu aja.', 'Promonya tinggal 2 hari lagi ya, buruan checkout.'];
  const W2 = [];
  { let t = 0.8; for (const x of SAID2) { for (const w of x.split(' ')) { W2.push({ w, s: +t.toFixed(3), e: +(t + 0.3).toFixed(3) }); t += 0.36; } t += 1.2; } }
  await setup(p, 'Momen', W2);
  const mm = await mcp('apply_style', { style: 'storypop', product: { name: 'Travel Bag', price: '189rb', price_discount: '149rb' } });
  check(mm.moments?.color === 1 && mm.moments?.uses === 1 && mm.moments?.timer === 1, `momen ditemukan dari transkrip: ${JSON.stringify(mm.moments)}`);
  const look = await p.evaluate(async () => {
    const { store } = await import('/js/store.js');
    const { mediaRT } = await import('/js/media.js');
    const P = store.P;
    const sw = P.clips.filter((c) => c.sticker?.swatch).map((c) => ({ id: c.id, color: c.sticker.swatch.color, label: c.sticker.swatch.label, start: c.start, end: c.start + c.duration, x: c.x, y: c.y, scale: c.scale }));
    const clock = P.clips.find((c) => c.sticker?.emoji === '⏰');
    const tick = P.clips.find((c) => c.name === 'SFX tick');
    const tickMedia = tick && P.media.find((m) => m.id === tick.mediaId);
    return { sw, clock: clock && { start: clock.start, loop: clock.animLoop?.type }, tick: tick && { start: tick.start, stock: tickMedia?.stock, ready: mediaRT.get(tick.mediaId)?.status === 'ready' }, chips: P.clips.filter((c) => c.sticker?.badge?.icon).map((c) => `${c.sticker.badge.icon} ${c.sticker.badge.text}`) };
  });
  check(look.sw.map((x) => x.label).join(',') === 'Hitam,Cream,Dusty Pink' && look.sw[0].start < look.sw[1].start && look.sw[1].start < look.sw[2].start, `3 bulatan warna muncul satu per satu: ${look.sw.map((x) => `${x.label}@${x.start.toFixed(2)}`).join(', ')}`);
  check(look.clock?.loop === 'shake' && look.tick?.stock === 'tick' && look.tick.ready && Math.abs(look.tick.start - look.clock.start) < 0.01, `⏰ bergetar + SFX timer berdetak di ${look.tick?.start?.toFixed(2)} dtk (suara dibuat di editor, siap diputar)`);
  check(look.chips.join('|') === '👕 baju basah|🥤 minuman|💻 laptop', `chip "bisa buat": ${look.chips.join(', ')}`);
  // what is seen: each circle in its colour (a spot in its lower right, away from the shine)
  const tSee = Math.max(...look.sw.map((x) => x.start)) + 0.6;
  const fr2 = await mcp('get_frame', { time: tSee, max_width: 540, format: 'png' });
  const seen = await p.evaluate(async ({ src, sw, k }) => {
    const im = new Image(); im.src = `data:image/png;base64,${src}`; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    return sw.map((x) => {
      // (render.js: a 170 px circle above a 42 px name; its centre 30 px above the sticker's centre at scale 1)
      const cx = (540 + x.x * 1080) * k;
      const cy = (960 + x.y * 1920 - 30.45 * x.scale) * k;
      const r = 75 * x.scale * k;
      const d = g.getImageData(Math.round(cx + r * 0.35) - 2, Math.round(cy + r * 0.35) - 2, 5, 5).data;
      const avg = [0, 1, 2].map((ch) => Math.round([0, 4, 8, 12, 16, 20, 24].reduce((a, i) => a + d[i * 4 / 4 * 4 + ch] || a, 0) / 7));
      const want = [1, 3, 5].map((i) => parseInt(x.color.slice(i, i + 2), 16));
      return { label: x.label, avg, want, diff: Math.max(...avg.map((v, i) => Math.abs(v - want[i]))) };
    });
  }, { src: fr2.img, sw: look.sw, k: fr2.width / 1080 });
  check(seen.every((x) => x.diff < 40), `frame hasil render: tiap bulatan berwarna sesuai (${seen.map((x) => `${x.label} ${x.avg.join('/')} ≈ ${x.want.join('/')}`).join('; ')})`);
  if (process.env.NAJJA_TEST_FACE_FRAMES) {
    // (frames for a person to look at: the circles, the chips, the timer)
    const times = await p.evaluate(async () => {
      const { store } = await import('/js/store.js');
      const P = store.P;
      const last = (f) => { const cs = P.clips.filter(f); return cs.length ? Math.max(...cs.map((c) => c.start)) + 0.5 : null; };
      return [last((c) => c.sticker?.swatch), (last((c) => c.sticker?.badge?.icon) ?? 0) - 0.2, (last((c) => c.sticker?.emoji === '⏰') ?? 0) + 0.4].filter((x) => x != null && x > 0.5);
    });
    fs.mkdirSync(process.env.NAJJA_TEST_FACE_FRAMES, { recursive: true });
    for (const t of times) {
      const fr = await mcp('get_frame', { time: t, max_width: 540 });
      fs.writeFileSync(path.join(process.env.NAJJA_TEST_FACE_FRAMES, `momen-${t.toFixed(2)}.jpg`), Buffer.from(fr.img, 'base64'));
    }
  }
  const added = await mcp('add_sticker', { color_circle: 'sage', start: 1, duration: 2 });
  check(added.sticker?.color_circle === '#B2BFA4' && added.sticker.label === 'Sage', `MCP add_sticker color_circle "sage" → ${JSON.stringify(added.sticker)}`);

  step('C. perangkat yang tidak bisa memuat model');
  const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  for (const name of ['ultraface-320', 'selfie-256']) await ctx2.route(`**/vendor/${name}/model.onnx`, (route) => route.fulfill({ status: 503, body: JSON.stringify({ error: `Server belum bisa mengunduh ${name}: offline` }), contentType: 'application/json' }));
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
  check(/ditebak/.test(g.faces?.detection || '') && g.faces.moved > 0 && g.sfx > 0, `edit tetap jadi: "${g.faces?.detection}", ${g.faces?.moved} kelompok teks dijauhkan dari tebakan posisi orang, ${g.sfx} SFX`);
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
    if (process.env.NAJJA_TEST_PERSON_MODEL) {
      const { VENDOR } = await import('../../lib/vendor.js');
      const buf = fs.readFileSync(process.env.NAJJA_TEST_PERSON_MODEL);
      const sum = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex');
      if (sum !== VENDOR.selfie.extra['model.onnx'].sha256) throw new Error('NAJJA_TEST_PERSON_MODEL is not the pinned MediaPipe Selfie Segmentation');
      await ctx3.route('**/vendor/selfie-256/model.onnx', (route) => route.fulfill({ status: 200, body: buf, contentType: 'application/octet-stream' }));
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
      const { findPeople } = await import('/js/faces.js');
      const r = await findPeople(store.P);
      const m = store.P.media.find((x) => x.type === 'video');
      return { r, n: m.faces?.samples.length, withFace: m.faces?.samples.filter(([, b]) => b.length).length, first: m.faces?.samples.find(([, b]) => b.length)?.[1], people: m.people?.samples.length, grid: `${m.people?.cols}x${m.people?.rows}` };
    });
    check(real.r.looked === 1 && !real.r.partial && real.people === real.n && real.withFace >= real.n * 0.7, `UltraFace + MediaPipe asli (${JSON.stringify(real.r)}, masker ${real.grid}): wajah di ${real.withFace}/${real.n} titik (${((Date.now() - t1) / 1000).toFixed(1)} dtk), contoh ${JSON.stringify(real.first)}`);
    // the whole style on it (the words of the test transcript stand in for Whisper)
    await p3.evaluate(async ({ words }) => {
      const { store } = await import('/js/store.js');
      const m = store.P.media.find((x) => x.type === 'video');
      store.P.speech = { [m.id]: { lang: 'id', words } };
      await store.save({ force: true });
    }, { words: WORDS });
    const st = await mcp('apply_style', { style: 'storypop', product: PRODUCT });
    const r = await inspect(p3);
    check(r.onFace.length === 0 && r.onBody.length === 0 && st.sfx > 0, `Story Pop di video asli: ${JSON.stringify(st.faces)}, tidak ada teks yang menutupi orangnya${r.onFace.length || r.onBody.length ? ` (${[...r.onFace, ...r.onBody].join(', ')})` : ''}, ${st.sfx} SFX`);
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
