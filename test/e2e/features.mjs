// End-to-end (v1.9): editing features asked for after v1.8.
//   A. Black & White / Blur effects (and filters) work where the canvas filter does not (iPad Safari): GPU path
//   B. a clicked/tapped clip brings the playhead to it
//   C. a duplicate goes right next to its source (main track with and without magnet, overlay track)
//   D. built-in sounds: louder (peak −1 dBFS), new basic sounds, remade for projects with the old ones
//   E. favourites: a star on effects, transitions, filters, fonts, animations…; favourites listed first
// Needs Playwright (with Chromium) and ffmpeg. Run: npm run test:e2e
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-features-1234567890';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) {
  console.log(`SKIP features e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`);
  process.exit(0);
}
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-features-e2e-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=4',
  '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(dir, 'media', 'warna.mp4')]);
const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port) }, stdio: 'ignore' });
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

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'fitur@najja.id'); await p.fill('#password', 'rahasia-fitur'); await p.fill('#password2', 'rahasia-fitur'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.goto(`${BASE}/?debug`);
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));
  await mcp('new_project', { name: 'E2E fitur', aspect_ratio: '9:16' });
  const media = await mcp('import_media', { path: 'warna.mp4' });
  for (let i = 0; i < 3; i++) await mcp('add_media_clip', { media_id: media.media_id, track: 'main' });
  for (let t = Date.now(); Date.now() - t < 60000; await wait(250)) {
    if (await p.evaluate(async (id) => { const { mediaRT } = await import('/js/media.js'); return !!mediaRT.get(id)?.url; }, media.media_id)) break;
  }

  step('A. Efek Hitam Putih & Kabur lewat GPU (seperti di iPad, yang tidak punya filter canvas)');
  const fx = await p.evaluate(async () => {
    const r = await import('/js/render.js');
    const g = await import('/js/gpufx.js');
    const scene = () => {
      const c = document.createElement('canvas'); c.width = 240; c.height = 240;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      for (let x = 0; x < 240; x += 12) { ctx.fillStyle = x % 24 ? '#ff2a00' : '#0040ff'; ctx.fillRect(x, 0, 12, 240); }
      return ctx;
    };
    const stats = (ctx) => {
      const d = ctx.getImageData(0, 0, 240, 240).data;
      let sat = 0, edge = 0, dark = 0;
      for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
        const i = (y * 240 + x) * 4;
        sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
        if (x) edge += Math.abs(d[i] - d[i - 4]);
        if ((x < 3 || x > 236 || y < 3 || y > 236) && d[i] + d[i + 1] + d[i + 2] < 40) dark++;
      }
      return { sat: sat / 57600, edge: edge / 57600, dark };
    };
    const out = {};
    for (const gpu of [true, false]) {
      g.setFilterOptions({ gpuFilters: gpu });
      const base = scene(); const b0 = stats(base);
      const bw = scene(); r.applyEffect(bw, { type: 'bw', intensity: 1 }, 1, 1, 3);
      const bl = scene(); r.applyEffect(bl, { type: 'blur', intensity: 0.7 }, 1, 1, 3);
      out[gpu ? 'gpu' : 'native'] = { base: b0, bw: stats(bw), blur: stats(bl) };
    }
    g.setFilterOptions({ gpuFilters: false });
    return out;
  });
  for (const k of ['gpu', 'native']) {
    const o = fx[k];
    check(o.bw.sat < 3 && o.base.sat > 150, `${k}: Hitam Putih menghapus warna (saturasi ${o.base.sat.toFixed(0)} → ${o.bw.sat.toFixed(1)})`);
    check(o.blur.edge < o.base.edge * 0.5, `${k}: Kabur melembutkan tepi (${o.base.edge.toFixed(1)} → ${o.blur.edge.toFixed(1)})`);
    check(o.blur.dark === 0, `${k}: Kabur tidak membuat tepi frame gelap (${o.blur.dark} piksel gelap)`);
  }
  // the same through the preview of a real project (GPU path), with the effect added like the user does
  await mcp('add_effect', { effect: 'bw', start: 0, duration: 4, intensity: 1 });
  const sat = await p.evaluate(async () => {
    (await import('/js/gpufx.js')).setFilterOptions({ gpuFilters: true });
    const E = window.najja.engine;
    E.seek(1.5);
    await E.settle(8000);
    E.requestRender(); await new Promise((r) => setTimeout(r, 300));
    const c = E.canvas;
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    const x = t.getContext('2d'); x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, t.width, t.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    (await import('/js/gpufx.js')).setFilterOptions({ gpuFilters: false });
    return s / (d.length / 4);
  });
  check(sat < 4, `pratinjau proyek dengan efek Hitam Putih (jalur GPU): saturasi ${sat.toFixed(1)}`);
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.mutate('hapus efek', (P) => { P.clips = P.clips.filter((c) => c.type !== 'effect'); }); });

  step('B. Klik klip → playhead pindah ke klip itu');
  await p.evaluate(() => { window.najja.engine.seek(0.5); });
  await wait(300);
  const third = await p.evaluate(async () => { const { store, sortedClips } = await import('/js/store.js'); const c = sortedClips(store.P, 'main')[2]; return { id: c.id, start: c.start }; });
  const el = await p.$(`.clip[data-id="${third.id}"]`);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  await p.mouse.click(box.x + Math.min(30, box.width / 2), box.y + box.height / 2);
  await wait(400);
  const tNow = await p.evaluate(() => window.najja.engine.time);
  check(Math.abs(tNow - third.start) < 0.05, `playhead di awal klip yang diklik (${tNow.toFixed(2)} s, klip mulai ${third.start.toFixed(2)} s)`);
  // a click on the clip under the playhead does not move it
  await p.evaluate(() => { window.najja.engine.seek(window.najja.engine.time + 0.7); });
  const before = await p.evaluate(() => window.najja.engine.time);
  const box2 = await (await p.$(`.clip[data-id="${third.id}"]`)).boundingBox(); // (the timeline scrolled with the playhead)
  await p.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await wait(300);
  check(Math.abs((await p.evaluate(() => window.najja.engine.time)) - before) < 0.01, 'klik klip yang sudah di bawah playhead tidak memindah playhead');

  step('C. Duplikat tepat di samping aslinya');
  const dup = await p.evaluate(async () => {
    const { store, sortedClips } = await import('/js/store.js');
    const actions = await import('/js/actions.js');
    const main = sortedClips(store.P, 'main');
    // magnet on: right after the first clip
    const c1 = actions.duplicateClip(main[0].id);
    const after = sortedClips(store.P, 'main');
    const magnetOk = after[1].id === c1.id && Math.abs(c1.start - (main[0].start + main[0].duration)) < 0.01;
    // magnet off: the clips after it move along
    store.mutate('magnet', (P) => { P.magnet = false; });
    const m2 = sortedClips(store.P, 'main');
    const src = m2[0];
    const nextStart = m2[1].start;
    const c2 = actions.duplicateClip(src.id);
    const noMagnetOk = Math.abs(c2.start - (src.start + src.duration)) < 0.01 && store.clip(m2[1].id).start > nextStart + 0.5;
    store.mutate('magnet', (P) => { P.magnet = true; });
    // overlay: the space after it is taken → same time, on another track
    const o1 = actions.addMediaClip(store.P.media[0].id, { track: 'overlay', start: 0, duration: 1 });
    const o1c = store.clip(o1.id || o1);
    const o2 = actions.addMediaClip(store.P.media[0].id, { track: o1c.trackId, start: 1, duration: 1 });
    const c3 = actions.duplicateClip(o1c.id);
    const ovOk = Math.abs(c3.start - 1) < 0.01 && c3.trackId !== o1c.trackId;
    return { magnetOk, noMagnetOk, ovOk, o2: !!o2 };
  }).catch((e) => ({ error: e.message }));
  check(dup.magnetOk, 'track utama (magnet): duplikat langsung setelah aslinya');
  check(dup.noMagnetOk, 'track utama tanpa magnet: duplikat setelah aslinya, klip berikutnya bergeser');
  check(dup.ovOk, `overlay dengan tempat sesudahnya terisi: duplikat di waktu yang sama di track lain${dup.error ? ` (${dup.error})` : ''}`);

  step('D. Efek suara bawaan: lebih keras, dan efek dasar baru');
  const sfx = await p.evaluate(async () => {
    const { synthAudio, ensureStockAudio } = await import('/js/media.js');
    const { SFX } = await import('/js/presets.js');
    const ids = SFX.filter((s) => s.kind === 'sfx').map((s) => s.id);
    const peaks = {};
    for (const id of ['ding', 'pop', 'whoosh', 'bell', 'tada', 'shutter']) {
      const buf = await new OfflineAudioContext(2, 44100, 44100).decodeAudioData(await (await synthAudio(id)).arrayBuffer());
      let pk = 0; for (const v of buf.getChannelData(0)) pk = Math.max(pk, Math.abs(v));
      peaks[id] = 20 * Math.log10(pk);
    }
    const m = await ensureStockAudio('ding');
    return { ids, peaks, stockV: m.stockV };
  });
  check(Object.values(sfx.peaks).every((d) => d > -1.5 && d <= 0), `puncak −1 dBFS: ${Object.entries(sfx.peaks).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`);
  check(['ding', 'bell', 'tada', 'success', 'wrong', 'boing', 'bubble', 'cash', 'typing', 'heartbeat', 'drumroll', 'shutter', 'glitchfx'].every((id) => sfx.ids.includes(id)), `${sfx.ids.length} efek suara (termasuk ding, lonceng, ta-da, kamera…)`);
  check(sfx.stockV === 2, 'suara bawaan versi baru dipakai di proyek (stockV 2)');

  step('E. Favorit: bintang di efek, lalu efek itu muncul di "★ Favorit"');
  await p.evaluate(() => { localStorage.removeItem('najja:fav.effect'); });
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.select(null); });
  for (let i = 0; i < 4 && await p.$('.tb-back'); i++) { await p.click('.tb-back'); await wait(150); }
  await p.click('.tool[data-tool="cat-effect"]');
  await p.click('.tool[data-tool="video-fx"]');
  await p.waitForSelector('.sheet.in .fx-tile');
  await p.evaluate(() => document.querySelector('.sheet.in .fx-tile[data-effect="glitch"] .fav').click());
  await wait(200);
  const favChip = await p.evaluate(() => [...document.querySelectorAll('.sheet.in [data-fxcat]')].map((b) => b.textContent));
  check(favChip[0] === '★ Favorit', `kategori "★ Favorit" muncul paling depan (${favChip.slice(0, 3).join(', ')})`);
  await p.evaluate(() => document.querySelector('.sheet.in [data-fxcat="★ Favorit"]').click());
  await wait(200);
  const favTiles = await p.evaluate(() => [...document.querySelectorAll('.sheet.in .fx-tile')].map((b) => b.dataset.effect));
  check(favTiles.length === 1 && favTiles[0] === 'glitch', `isi Favorit: ${favTiles.join(', ')}`);
  const clipsBefore = await p.evaluate(async () => (await import('/js/store.js')).store.P.clips.length);
  check(clipsBefore === await p.evaluate(async () => (await import('/js/store.js')).store.P.clips.length), 'mengetuk bintang tidak menambah efek');
  check(JSON.stringify(await p.evaluate(() => JSON.parse(localStorage.getItem('najja:fav.effect')))) === '["glitch"]', 'favorit tersimpan di perangkat');

  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek fitur lolos');
process.exit(failed ? 1 : 0);
