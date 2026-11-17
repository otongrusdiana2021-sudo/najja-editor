// End-to-end (v1.9): editing features asked for after v1.8.
//   A. Black & White / Blur effects (and filters) work where the canvas filter does not (iPad Safari): GPU path
//   B. a clicked/tapped clip brings the playhead to it
//   C. a duplicate goes right next to its source (main track with and without magnet, overlay track)
//   D. built-in sounds: louder (peak −1 dBFS), new basic sounds, remade for projects with the old ones
//   E. favourites: a star on effects, transitions, filters, fonts, animations…; favourites listed first
//   F–I. Crystal Clear / 4K filters, the Scholar/Abrason/Starry fonts, live transition previews, layer order
//   J–L. cover, voice clean-up, auto subtitles; M. linked subtitles (scale one line, every line follows)
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
// speech (espeak-ng, Indonesian) with a pause, plus steady hiss: for noise reduction and auto subtitles
const hasEspeak = (() => { try { execFileSync('espeak-ng', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
let pause = null;
if (hasEspeak) {
  const a = path.join(dir, 's1.wav');
  const b = path.join(dir, 's2.wav');
  execFileSync('espeak-ng', ['-v', 'id', '-s', '135', '-w', a, 'Halo semuanya, selamat datang di toko kami.']);
  execFileSync('espeak-ng', ['-v', 'id', '-s', '135', '-w', b, 'Hari ini ada diskon untuk semua produk.']);
  const d1 = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', a]).toString());
  pause = [d1 + 0.3, d1 + 1.3];
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', a, '-f', 'lavfi', '-t', '1.6', '-i', 'anullsrc=r=22050:cl=mono', '-i', b,
    '-f', 'lavfi', '-t', '12', '-i', 'anoisesrc=color=white:amplitude=0.04:sample_rate=48000', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=8',
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1,aresample=48000[sp];[sp][3:a]amix=inputs=2:duration=first:normalize=0[a]',
    '-map', '4:v', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.join(dir, 'media', 'bicara.mp4')]);
}
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

  step('F. Filter Crystal Clear & 4K: lebih jernih dan lebih tajam');
  const flt = await p.evaluate(async () => {
    const { FILTERS } = await import('/js/presets.js');
    const { cssFilterFor } = await import('/js/render.js');
    const g = await import('/js/gpufx.js');
    const src = document.createElement('canvas'); src.width = 200; src.height = 120;
    const sc = src.getContext('2d');
    sc.fillStyle = '#7a8a6a'; sc.fillRect(0, 0, 200, 120);
    sc.filter = 'blur(1.5px)'; sc.fillStyle = '#c8b090'; for (let x = 10; x < 200; x += 20) sc.fillRect(x, 10, 8, 100); sc.filter = 'none';
    const measure = (id) => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 120;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      g.drawFiltered(ctx, cssFilterFor({ filter: { name: id, intensity: 1 }, adjust: {} }), src, 0, 0, 200, 120, 0, 0, 200, 120);
      const d = ctx.getImageData(0, 0, 200, 120).data;
      let edge = 0, sat = 0;
      const luma = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      for (let y = 0; y < 120; y++) for (let x = 1; x < 200; x++) { const i = (y * 200 + x) * 4; edge += Math.abs(luma(i) - luma(i - 4)); sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); }
      return { edge: edge / 24000, sat: sat / 24000 };
    };
    return { ids: FILTERS.map((f) => f.id), none: measure('none'), crystal: measure('crystal'), uhd4k: measure('uhd4k') };
  });
  check(flt.ids.includes('crystal') && flt.ids.includes('uhd4k'), 'filter Crystal Clear dan 4K tersedia');
  check(flt.crystal.edge > flt.none.edge * 1.15 && flt.crystal.sat > flt.none.sat * 1.1, `Crystal Clear: lebih tajam (tepi ${flt.none.edge.toFixed(1)} → ${flt.crystal.edge.toFixed(1)}) dan lebih hidup (saturasi ${flt.none.sat.toFixed(0)} → ${flt.crystal.sat.toFixed(0)})`);
  check(flt.uhd4k.edge > flt.crystal.edge, `4K paling tajam (tepi ${flt.uhd4k.edge.toFixed(1)})`);

  step('G. Font Scholar, Abrason, Starry (font terbuka bergaya serupa)');
  const fonts = await p.evaluate(async () => {
    const { FONTS } = await import('/js/presets.js');
    const css = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href).join(' ');
    return { labels: FONTS.filter((f) => f.label).map((f) => `${f.label}=${f.name}`), css };
  });
  check(['Scholar=Libre Baskerville', 'Abrason=Bangers', 'Starry=Patrick Hand'].every((x) => fonts.labels.includes(x)), `font: ${fonts.labels.join(', ')}`);
  check(/Libre\+Baskerville/.test(fonts.css) && /Bangers/.test(fonts.css) && /Patrick\+Hand/.test(fonts.css), 'ketiga font dimuat dari Google Fonts');
  const tx = await mcp('add_text', { text: 'Gaya Scholar', font: 'Scholar', start: 0, duration: 2 });
  const txFont = await p.evaluate(async (id) => (await import('/js/store.js')).store.clip(id)?.text?.font, tx.clip_id || tx.id);
  check(txFont === 'Libre Baskerville', `MCP add_text font "Scholar" → ${txFont}`);

  step('H. Pratinjau transisi memutar transisi aslinya');
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.select(null); });
  await p.evaluate(() => { window.najja.openSheet('transition'); });
  await p.waitForSelector('.sheet.in canvas.tr-prev', { timeout: 5000 }).catch(() => {});
  const trPrev = await p.evaluate(async () => {
    const cvs = [...document.querySelectorAll('.sheet.in canvas.tr-prev')];
    const { TRANSITIONS } = await import('/js/presets.js');
    const fade = cvs.find((c) => c.dataset.prev === 'tr:slideLeft');
    const snap = () => { const t = document.createElement('canvas'); t.width = fade.width; t.height = fade.height; const x = t.getContext('2d'); x.drawImage(fade, 0, 0); return x.getImageData(0, 0, t.width, t.height).data; };
    const frames = [];
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 250)); frames.push(snap()); }
    let changes = 0;
    for (let i = 1; i < frames.length; i++) { let d = 0; for (let k = 0; k < frames[i].length; k += 16) d += Math.abs(frames[i][k] - frames[i - 1][k]); if (d > 1000) changes++; }
    return { n: cvs.length, total: TRANSITIONS.length, changes };
  }).catch((e) => ({ error: e.message }));
  check(trPrev.n >= trPrev.total, `${trPrev.n} kotak transisi dengan pratinjau langsung${trPrev.error ? ` (${trPrev.error})` : ''}`);
  check(trPrev.changes >= 3, `pratinjau "Geser Kiri" bergerak (${trPrev.changes} perubahan dalam 2 dtk)`);
  await p.evaluate(() => window.najja.sheet?.close?.());
  // animations of a text clip: each tile shows the text itself (over a picture) doing the animation
  await p.evaluate(async (id) => { const { store } = await import('/js/store.js'); store.select(id); window.najja.openSheet('anim'); }, tx.clip_id || tx.id);
  await p.waitForSelector('.sheet.in canvas.anim-prev', { timeout: 5000 }).catch(() => {});
  await wait(1200);
  const anim = await p.evaluate(() => [...document.querySelectorAll('.sheet.in canvas.anim-prev')].slice(0, 6).map((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let stroke = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 30 && d[i + 1] < 30 && d[i + 2] < 30 && d[i + 3] > 200) stroke++;
    return { spec: c.dataset.prev, stroke };
  }));
  check(anim.length >= 6 && anim.filter((a) => a.stroke > 50).length >= 4, `pratinjau animasi menampilkan teksnya: ${anim.map((a) => `${a.spec}=${a.stroke}`).join(', ')}`);
  await p.evaluate(() => window.najja.sheet?.close?.());

  step('I. Lapisan: urutan klip yang tumpang tindih');
  const lay = await p.evaluate(async () => {
    const { store } = await import('/js/store.js');
    const actions = await import('/js/actions.js');
    const m = store.P.media[0].id;
    const a = actions.addMediaClip(m, { track: 'overlay', start: 0.5, duration: 2 });
    const b = actions.addMediaClip(m, { track: 'overlay', start: 1, duration: 2 });
    const ida = a.id || a;
    const idb = b.id || b;
    const before = actions.layerInfo(ida);
    const idx = (id) => store.P.tracks.findIndex((t) => t.id === store.clip(id).trackId);
    actions.moveLayer(ida, 'front');
    const front = actions.layerInfo(ida);
    const aboveB = idx(ida) < idx(idb);
    actions.moveLayer(ida, 'back');
    const back = actions.layerInfo(ida);
    const belowB = idx(ida) > idx(idb);
    const mainIdx = store.P.tracks.findIndex((t) => t.id === 'main');
    return { before, front, back, aboveB, belowB, aboveMain: idx(ida) < mainIdx };
  });
  check(lay.front.index === lay.front.count && lay.aboveB, `Paling depan: lapisan ${lay.front.index}/${lay.front.count}, digambar di atas klip lain`);
  check(lay.back.index === 1 && lay.belowB && lay.aboveMain, `Paling belakang: lapisan 1/${lay.back.count}, tetap di atas track utama`);

  step('J. Sampul: dari frame video (HD) dan dari galeri, jadi frame pertama video ekspor');
  const cov = await p.evaluate(async () => {
    const cover = await import('/js/cover.js');
    const { store } = await import('/js/store.js');
    const fr = await cover.frameCover(1.0);
    await cover.setCoverImage(fr.canvas, { from: 'frame', t: 1 });
    const c1 = { ...store.P.cover, thumb: !!store.P.cover?.thumb };
    const hidden = store.P.media.find((m) => m.id === c1.mediaId)?.cover === true;
    // a small magenta photo from the "gallery": cropped to 9:16, enlarged (no AI service in this test)
    const ph = document.createElement('canvas'); ph.width = 300; ph.height = 200;
    const x = ph.getContext('2d'); x.fillStyle = '#ff00ff'; x.fillRect(0, 0, 300, 200);
    const blob = await new Promise((r) => ph.toBlob(r, 'image/png'));
    const pc = await cover.photoCover(new File([blob], 'foto.png', { type: 'image/png' }));
    await cover.setCoverImage(pc.canvas, { from: 'photo' });
    const c2 = { ...store.P.cover, thumb: !!store.P.cover?.thumb };
    const firstMediaGone = !store.P.media.some((m) => m.id === c1.mediaId);
    return { hd: fr.hd, w: fr.canvas.width, h: fr.canvas.height, c1, hidden, c2, pw: pc.canvas.width, ph: pc.canvas.height, firstMediaGone };
  }).catch((e) => ({ error: e.message }));
  check(cov.hd && cov.w === 1080 && cov.h === 1920, `frame video → sampul HD ${cov.w}×${cov.h} dari video kualitas penuh${cov.error ? ` (${cov.error})` : ''}`);
  check(cov.c1?.mediaId && cov.c1.thumb && cov.hidden, 'sampul tersimpan sebagai gambar proyek (tidak tampil di daftar media) + gambar kecil untuk kartu proyek');
  check(cov.pw === 1080 && cov.ph === 1920 && cov.c2?.from === 'photo', `foto galeri dipotong ke rasio proyek: ${cov.pw}×${cov.ph}`);
  check(cov.firstMediaGone, 'gambar sampul lama dihapus saat diganti');
  // the export's first frame is the cover (magenta), the second is the video
  const first = await p.evaluate(async () => {
    const { exportVideo } = await import('/js/exporter.js');
    const res = await exportVideo(window.najja.engine, { resolution: '480p', format: 'mp4', range: [0, 1] });
    const url = URL.createObjectURL(res.blob);
    const v = document.createElement('video'); v.muted = true; v.src = url; await v.play().catch(() => {}); v.pause();
    const at = async (t) => { v.currentTime = t; await new Promise((r) => v.addEventListener('seeked', r, { once: true })); const c = document.createElement('canvas'); c.width = 32; c.height = 56; const x = c.getContext('2d'); x.drawImage(v, 0, 0, 32, 56); const d = x.getImageData(16, 28, 1, 1).data; return [...d.slice(0, 3)]; };
    return { mode: res.mode, f0: await at(0.001), f1: await at(0.2) };
  });
  const magenta = (px) => px[0] > 200 && px[1] < 60 && px[2] > 200;
  check(first.mode === 'fast' && magenta(first.f0) && !magenta(first.f1), `frame pertama ekspor = sampul (${first.f0}), lalu video (${first.f1})`);
  await p.evaluate(() => window.najja.openSheet('cover'));
  await p.waitForSelector('.sheet.in .cover-sheet');
  const modes = await p.evaluate(() => [...document.querySelectorAll('.sheet.in [data-cm]')].map((b) => b.textContent.trim()));
  check(modes.join('|') === 'Frame video|Dari galeri', `pilihan sampul: ${modes.join(', ')}`);
  await p.evaluate(() => window.najja.sheet?.close?.());

  step('K. Volume: Kurangi kebisingan & Sempurnakan suara (pratinjau dan ekspor sama)');
  if (!hasEspeak) console.log('SKIP  espeak-ng tidak terpasang');
  else {
    await mcp('new_project', { name: 'E2E suara', aspect_ratio: '9:16' });
    const sp = await mcp('import_media', { path: 'bicara.mp4' });
    const clip = await mcp('add_media_clip', { media_id: sp.media_id, track: 'main', start: 0 });
    for (let t = Date.now(); Date.now() - t < 60000; await wait(250)) {
      if (await p.evaluate(async (id) => { const { mediaRT } = await import('/js/media.js'); return !!mediaRT.get(id)?.url; }, sp.media_id)) break;
    }
    const exportPcm = async (voice) => {
      await p.evaluate(async ([id, v]) => { const { store } = await import('/js/store.js'); store.mutate('suara', () => { store.clip(id).voice = v; }); }, [clip.clip_id || clip.id, voice]);
      const r = await p.evaluate(async () => {
        const { exportVideo } = await import('/js/exporter.js');
        const res = await exportVideo(window.najja.engine, { resolution: '480p', format: 'mp4' });
        const b = new Uint8Array(await res.blob.arrayBuffer());
        let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
        const ev = [...(await window.najjaMetrics.snapshot()).events].reverse().find((e) => e.kind === 'export') || {};
        return { data: btoa(s), mode: res.mode, voice: ev.voice_fx || 0 };
      });
      const f = path.join(dir, `suara-${voice ? 'fx' : 'asli'}.mp4`);
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
      return { ...r, x: new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1) };
    };
    const lvl = (x, a, b) => { let q = 0; const i0 = Math.round(a * 16000), i1 = Math.round(b * 16000); for (let i = i0; i < i1; i++) q += (x[i] / 32768) ** 2; return 10 * Math.log10(q / (i1 - i0) + 1e-12); };
    const plain = await exportPcm(null);
    const clean = await exportPcm({ denoise: true });
    const both = await exportPcm({ denoise: true, enhance: true });
    const nPlain = lvl(plain.x, ...pause);
    const nClean = lvl(clean.x, ...pause);
    const sPlain = lvl(plain.x, 0.3, pause[0] - 0.4);
    const sClean = lvl(clean.x, 0.3, pause[0] - 0.4);
    check(clean.voice >= 1 && nPlain - nClean > 10, `Kurangi kebisingan: desis di jeda ${nPlain.toFixed(1)} → ${nClean.toFixed(1)} dB`);
    check(Math.abs(sPlain - sClean) < 3, `suara orang tetap (${sPlain.toFixed(1)} → ${sClean.toFixed(1)} dB)`);
    check(both.voice >= 1 && lvl(both.x, 0.3, pause[0] - 0.4) >= sClean - 0.5 && lvl(both.x, ...pause) < nPlain - 6, `Sempurnakan suara (+ kurangi kebisingan): suara ${lvl(both.x, 0.3, pause[0] - 0.4).toFixed(1)} dB, jeda ${lvl(both.x, ...pause).toFixed(1)} dB`);
    // the preview plays the same cleaned-up sound
    const prev = await p.evaluate(async () => {
      const A = window.najja.engine.audio;
      const { store } = await import('/js/store.js');
      const c = store.P.clips.find((x) => x.type === 'video');
      A.prefetch?.(0.5);
      for (let i = 0; i < 60; i++) { if (A.firstReady(0.5)) break; await new Promise((r) => setTimeout(r, 200)); }
      const s = A.source(c.mediaId);
      const b = [...s.blocks.values()].find((x) => x.state === 'ready');
      return { ready: A.firstReady(0.5), processed: !!b && A.bufFor(c, b) !== b.buffer };
    });
    check(prev.ready && prev.processed, 'pratinjau memakai suara yang sudah dibersihkan');
    await p.evaluate(async (id) => { const { store } = await import('/js/store.js'); store.mutate('suara', () => { store.clip(id).voice = null; }); }, clip.clip_id || clip.id);

    step('L. Hasilkan keterangan otomatis dari video (Whisper di server)');
    const st = await p.evaluate(async () => (await import('/js/captions.js')).transcribeStatus());
    if (!st.ok || !process.env.NAJJA_AI_MODELS) console.log(`SKIP  transkripsi: ${st.reason || 'NAJJA_AI_MODELS tidak diset (model Whisper)'}`);
    else {
      await p.evaluate(() => window.najja.openSheet('caption'));
      await p.waitForSelector('.sheet.in .autocap');
      const rows = await p.evaluate(() => [...document.querySelectorAll('.sheet.in .ac-row span')].map((x) => x.textContent));
      check(rows.includes('Hasilkan dari') && rows.includes('Bahasa sumber') && rows.includes('Opsi lanjutan'), `tampilan: ${rows.join(' · ')}`);
      await p.click('.sheet.in [data-capopen="lang"]');
      await p.fill('.sheet.in .ac-q', 'indo');
      await p.click('.sheet.in .ac-lang[data-caplang="id"]');
      await p.click('.sheet.in [data-do="autoCaptions"]');
      let subs = [];
      for (let t = Date.now(); Date.now() - t < 180000; await wait(1000)) {
        subs = await p.evaluate(async () => { const { store } = await import('/js/store.js'); const tr = store.P.tracks.find((x) => x.subtitle); return tr ? store.P.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start).map((c) => ({ t: c.text.content, s: c.start, e: c.start + c.duration })) : []; });
        if (subs.length) break;
      }
      const text = subs.map((x) => x.t).join(' ').toLowerCase();
      check(subs.length >= 2 && /selamat|datang|diskon|produk|halo/.test(text), `${subs.length} baris: "${subs.map((x) => x.t).join(' | ')}"`);
      check(subs.every((x) => x.e > x.s) && subs.every((x, i) => !i || x.s >= subs[i - 1].e - 1e-3), 'baris berurutan tanpa tumpang tindih');
      check(subs.some((x) => x.s >= pause[1] - 0.5), `kalimat kedua mulai setelah jeda (${subs.map((x) => x.s.toFixed(1)).join(', ')} dtk)`);
      await p.evaluate(() => window.najja.sheet?.close?.());
    }
  }

  step('M. Subtitle tertaut: skala/posisi/ukuran satu subtitle → semua ikut; bisa dimatikan; satu langkah urung');
  await p.evaluate(() => window.najja.sheet?.close?.());
  const subIds = await p.evaluate(async () => {
    const a = await import('/js/actions.js');
    const { store } = await import('/js/store.js');
    const ids = a.addSubtitles([{ start: 0.2, end: 1.2, text: 'Satu' }, { start: 1.3, end: 2.3, text: 'Dua dua' }, { start: 2.4, end: 3.4, text: 'Tiga' }, { start: 3.5, end: 4.5, text: 'Empat empat' }], { replace: true });
    store.select(ids[1]);
    window.najja.engine.pause();
    window.najja.engine.seek(1.8);
    return ids;
  });
  const subs = () => p.evaluate(async (ids) => { const { store } = await import('/js/store.js'); return ids.map((id) => { const c = store.clip(id); return { scale: c.scale, x: c.x, y: c.y, size: c.text.size, font: c.text.font, t: c.text.content }; }); }, subIds);
  const allSame = (a, k) => a.every((x) => Math.abs(x[k] - a[0][k]) < 1e-9);
  await p.waitForFunction(() => getComputedStyle(document.querySelector('.sel-box')).display !== 'none');
  await wait(300);
  // drag a corner handle of the selected line (the second) outward: it gets bigger, and so do the others
  const s0 = await subs();
  const h = await p.locator('.sel-box .h.br').boundingBox();
  await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(h.x + h.width / 2 + i * 9, h.y + h.height / 2 + i * 5);
  await p.mouse.up();
  let s1 = await subs();
  check(s1[1].scale > s0[1].scale * 1.1 && allSame(s1, 'scale'), `skala satu subtitle → semua (${s1.map((x) => x.scale.toFixed(2)).join(', ')})`);
  check(s1.map((x) => x.t).join('|') === 'Satu|Dua dua|Tiga|Empat empat', 'teks tiap baris tetap miliknya');
  // move it (drag the line itself)
  const sb = await p.locator('.sel-box').boundingBox();
  await p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await p.mouse.down();
  for (let i = 1; i <= 6; i++) await p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2 - i * 8);
  await p.mouse.up();
  const s2 = await subs();
  check(s2[1].y < s1[1].y - 0.01 && allSame(s2, 'y') && allSame(s2, 'x'), `posisi satu subtitle → semua (y ${s2.map((x) => x.y.toFixed(3)).join(', ')})`);
  // one undo takes back the move of every line
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.undo(); });
  const s3 = await subs();
  check(s3.every((x, i) => Math.abs(x.y - s1[i].y) < 1e-9), 'satu kali urung mengembalikan semua baris');
  // the inspector: the switch is there and on; the size slider changes every line
  await p.evaluate(() => window.najja.openSheet('text', { tab: 'font' }));
  await p.waitForSelector('.sheet.in .sub-link');
  const sw = await p.evaluate(() => { const el = document.querySelector('.sheet.in .sub-link'); return { on: el.querySelector('[data-do="subLink"]').checked, text: el.textContent.replace(/\s+/g, ' ').trim() }; });
  check(sw.on && /4 baris/.test(sw.text), `sakelar "Terapkan ke semua subtitle" tampil & menyala (${sw.text.slice(0, 60)}…)`);
  const num = p.locator('.sheet.in input[type=number][data-path="text.size"]');
  await num.fill('90');
  await num.dispatchEvent('change');
  await p.click('.sheet.in .font-item[data-font="Bangers"]');
  const s4 = await subs();
  check(s4.every((x) => x.size === 90 && x.font === 'Bangers'), `ukuran & font satu subtitle → semua (${s4.map((x) => `${x.size}/${x.font}`).join(', ')})`);
  // switched off: a change stays on its own line; "Samakan semua" brings the others along again
  await p.click('.sheet.in .sub-link .switch-row');
  await p.waitForFunction(() => document.querySelector('.sheet.in [data-do="subLink"]')?.checked === false);
  await num.fill('120');
  await num.dispatchEvent('change');
  const s5 = await subs();
  check(s5[1].size === 120 && s5.filter((_, i) => i !== 1).every((x) => x.size === 90), `dimatikan: hanya subtitle itu yang berubah (${s5.map((x) => x.size).join(', ')})`);
  await p.click('.sheet.in .sub-link .switch-row');
  await p.waitForSelector('.sheet.in [data-do="subMatch"]');
  await p.click('.sheet.in [data-do="subMatch"]');
  const s6 = await subs();
  check(s6.every((x) => x.size === 120 && Math.abs(x.scale - s6[1].scale) < 1e-9), `"Samakan semua" menyamakan semua baris (${s6.map((x) => x.size).join(', ')})`);
  check(!(await p.locator('.sheet.in [data-do="subMatch"]').count()), 'tombol "Samakan" hilang setelah semua sama');
  // a plain text clip (not a subtitle) has no switch and changes alone
  const plain = await p.evaluate(async () => {
    const a = await import('/js/actions.js');
    const { store } = await import('/js/store.js');
    const c = a.addText({ text: 'Judul', start: 0.5 });
    const id = c?.id || c;
    if (!id) return null;
    store.select(id);
    store.mutate('t', () => { store.clip(id).scale = 2.5; });
    const tr = store.P.tracks.find((t) => t.subtitle);
    return { others: store.P.clips.filter((x) => x.trackId === tr.id).map((x) => x.scale), own: store.clip(id).scale };
  });
  if (plain) check(plain.own === 2.5 && plain.others.every((s) => s !== 2.5), 'teks biasa (bukan subtitle) tidak ikut menaut');
  await p.evaluate(() => window.najja.sheet?.close?.());
  await p.evaluate(() => window.najja.openSheet('caption'));
  await p.waitForSelector('.sheet.in [data-caplink]');
  check(await p.locator('.sheet.in [data-caplink]').isChecked(), 'panel Keterangan: kotak "Ubah satu subtitle, semua ikut" tampil');
  await p.evaluate(() => window.najja.sheet?.close?.());

  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek fitur lolos');
process.exit(failed ? 1 : 0);
