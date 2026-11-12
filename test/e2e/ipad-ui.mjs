// End-to-end: the tablet layout at iPad size with touch input — centre playhead (swipe = scrub, pinch = zoom),
// bottom toolbar levels, bottom sheets, long-press to move a clip, filter layers that really colour the frame.
// Needs Playwright (with Chromium) and ffmpeg; skipped when either is missing. Run: npm run test:e2e
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-ipad-ui-123456';
const W = 1180;
const H = 820;

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) {
  console.log(`SKIP ipad-ui e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`);
  process.exit(0);
}

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-ipad-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
step('membuat video uji');
for (const [name, color] of [['merah.mp4', 'red'], ['biru.mp4', 'blue']]) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=360x640:r=30:d=6`, '-f', 'lavfi', '-i', 'sine=f=440:d=6',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(dir, 'media', name)]);
}

step('menyalakan server');
const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port) }, stdio: 'ignore' });
let cleaned = false;
const cleanup = () => { if (cleaned) return; cleaned = true; try { server.kill(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); };
process.on('exit', cleanup);
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }

const mcp = async (name, args = {}) => {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  if (!j.result || j.result.isError) throw new Error(JSON.stringify(j.error || j.result));
  return { data: JSON.parse(j.result.content.find((c) => c.type === 'text').text), img: j.result.content.find((c) => c.type === 'image')?.data };
};
const project = async () => (await mcp('get_project')).data;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let page;
/** Back button until the main toolbar shows. */
const toRoot = async () => { for (let i = 0; i < 4 && await page.$('.tb-back'); i++) { await page.tap('.tb-back'); await page.waitForTimeout(150); } };

const b = await chromium.launch();
process.on('unhandledRejection', (err) => { console.error('FAIL ', err); cleanup(); process.exit(1); });
try {
  const ctx = await b.newContext({ viewport: { width: W, height: H }, hasTouch: true });
  const p = await ctx.newPage();
  page = p;
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'ipad@najja.id'); await p.fill('#password', 'rahasia-ipad'); await p.fill('#password2', 'rahasia-ipad'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));
  step('membuat proyek 9:16 dengan 2 klip + teks');
  await mcp('new_project', { name: 'E2E iPad', aspect_ratio: '9:16' });
  for (const f of ['merah.mp4', 'biru.mp4']) {
    const m = await mcp('import_media', { path: f });
    await mcp('add_media_clip', { media_id: m.data.media_id });
  }
  await mcp('add_text', { text: 'Halo', start: 1, duration: 2 });
  await mcp('playback', { action: 'seek', time: 0 });
  await p.waitForTimeout(1500);
  await toRoot(); // the AI's last clip is selected: back out to the main toolbar

  // --- Layout ------------------------------------------------------------------------------
  const labels = await p.$$eval('.toolbar .tool .tool-lb', (els) => els.map((e) => e.textContent.trim()));
  check(labels.join(',') === 'Edit,Audio,Teks,Efek,Overlay,Keterangan,Filter,Sesuaikan', `toolbar utama: ${labels.join(' · ')}`);
  const geo = await p.evaluate(() => {
    const ph = document.querySelector('.tl-playhead').getBoundingClientRect();
    const sc = document.querySelector('.tl-scroll').getBoundingClientRect();
    return { ph: ph.left + ph.width / 2, mid: sc.left + sc.width / 2, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  check(Math.abs(geo.ph - geo.mid) < 2, `playhead di tengah timeline (${geo.ph.toFixed(0)} vs ${geo.mid.toFixed(0)})`);
  check(!geo.overflow, 'halaman tidak bisa digeser ke samping');

  const pps = () => p.evaluate(() => {
    const el = document.querySelector('.lane.kind-main .clip');
    return el.getBoundingClientRect().width / 6;
  });

  // --- Swipe = scrub -----------------------------------------------------------------------
  let k = await pps();
  await p.evaluate((x) => { document.querySelector('.tl-scroll').scrollLeft = x; }, 3.5 * k);
  await p.waitForTimeout(500);
  let st = await project();
  check(Math.abs(st.playhead - 3.5) < 0.06, `geser timeline ke 3,5 dtk → playhead ${st.playhead}`);
  check((await p.textContent('.tl-cur')).trim() === '00:03', 'waktu di kiri atas timeline ikut berubah');

  // --- Playback keeps the playhead time under the centre line ---------------------------------
  await mcp('playback', { action: 'play' });
  await p.waitForTimeout(900);
  await mcp('playback', { action: 'pause' });
  await p.waitForTimeout(300);
  st = await project();
  const sl = await p.evaluate(() => document.querySelector('.tl-scroll').scrollLeft);
  check(st.playhead > 3.9 && Math.abs(sl / k - st.playhead) < 0.05, `saat diputar timeline ikut bergulir (playhead ${st.playhead}, posisi gulir ${(sl / k).toFixed(2)} dtk)`);

  // --- Pinch = zoom (two real touch points) --------------------------------------------------
  const cdp = await ctx.newCDPSession(p);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const before = await pps();
  const tBefore = (await project()).playhead;
  const box = await p.$eval('.tl-scroll', (e) => { const r = e.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + 110 }; });
  await touch('touchStart', [[box.cx - 60, box.cy], [box.cx + 60, box.cy]]);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', [[box.cx - 60 - i * 15, box.cy], [box.cx + 60 + i * 15, box.cy]]); await wait(16); }
  await touch('touchEnd', []);
  await p.waitForTimeout(300);
  k = await pps();
  const tAfter = (await project()).playhead;
  check(k > before * 1.4, `cubit dua jari memperbesar timeline (${before.toFixed(1)} → ${k.toFixed(1)} px/dtk)`);
  check(Math.abs(tAfter - tBefore) < 0.08, `cubit tidak memindah playhead (${tBefore} → ${tAfter})`);

  // --- Tap a clip → clip tools; Bagi splits at the playhead ------------------------------------
  await mcp('playback', { action: 'seek', time: 2 });
  await p.waitForTimeout(300);
  await p.tap('.tool[data-tool="edit"]');
  await p.waitForTimeout(250);
  const clipLabels = await p.$$eval('.toolbar .tool .tool-lb', (els) => els.map((e) => e.textContent.trim()));
  check(['Bagi', 'Volume', 'Animasi', 'Kecepatan', 'Ganti', 'Overlay', 'Beku', 'Transformasi'].every((x) => clipLabels.includes(x)), `Edit memilih klip di playhead → toolbar klip (${clipLabels.length} alat)`);
  check(!clipLabels.includes('Ekstrak audio') && !clipLabels.includes('Tautkan'), 'alat yang dicoret (Ekstrak audio, Tautkan, Kualitas video…) tidak ada');
  const n0 = (await project()).clips.filter((c) => c.track === 'main').length;
  await p.tap('.tool[data-tool="split"]');
  await p.waitForTimeout(250);
  const n1 = (await project()).clips.filter((c) => c.track === 'main').length;
  check(n1 === n0 + 1, `Bagi memotong klip di playhead (${n0} → ${n1} klip utama)`);

  // --- Volume sheet edits the clip ------------------------------------------------------------
  await p.tap('.tool[data-tool="volume"]');
  await p.waitForSelector('.sheet.in .sec-volume');
  await p.$eval('.sheet input[type=number][data-path="volume"]', (el) => { el.value = '50'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.waitForTimeout(200);
  const selId = await p.evaluate(() => document.querySelector('.clip.selected')?.dataset.id);
  st = await project();
  check(st.clips.find((c) => c.id === selId)?.volume === 0.5, 'sheet Volume mengubah volume klip terpilih jadi 50%');
  await p.tap('.sh-ok');
  await p.waitForTimeout(250);

  // --- Long-press a text clip and drag it 1 s later ---------------------------------------------
  await p.tap('.tb-back');
  await p.waitForTimeout(200);
  const textEl = await p.$eval('.lane.kind-text .clip-text', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + Math.min(30, r.width / 2), y: r.top + r.height / 2, id: e.dataset.id }; });
  const start0 = (await project()).clips.find((c) => c.id === textEl.id).start;
  await touch('touchStart', [[textEl.x, textEl.y]]);
  await wait(520);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [[textEl.x + (k * i) / 10, textEl.y]]); await wait(16); }
  await touch('touchEnd', []);
  await p.waitForTimeout(350);
  const start1 = (await project()).clips.find((c) => c.id === textEl.id).start;
  check(Math.abs(start1 - start0 - 1) < 0.12, `tekan lama lalu geser memindah teks ±1 dtk (${start0} → ${start1})`);

  // --- Transition button between main clips ----------------------------------------------------
  await toRoot();
  await p.evaluate(() => document.querySelector('.tr-mark').scrollIntoView({ inline: 'center' }));
  await p.waitForTimeout(300);
  await p.tap('.tr-mark');
  await p.waitForSelector('.sheet.in .tr-tile');
  await p.tap('.tr-tile[data-transition="fade"]');
  await p.waitForTimeout(400);
  st = await project();
  check(st.clips.some((c) => c.transition?.type === 'fade'), 'tombol di antara klip → Transisi → Larut terpasang');
  await p.tap('.sh-ok');
  await p.waitForTimeout(250);
  await toRoot();

  // --- Filter layer really colours the frame -----------------------------------------------------
  await mcp('playback', { action: 'seek', time: 0.5 });
  await p.waitForTimeout(300);
  const sat = async () => {
    const f = await mcp('get_frame', { time: 0.5, max_width: 120 });
    return p.evaluate(async (src) => {
      const im = new Image(); im.src = `data:image/jpeg;base64,${src}`; await im.decode();
      const c = document.createElement('canvas'); c.width = 40; c.height = 40; const x = c.getContext('2d'); x.drawImage(im, 0, 0, 40, 40);
      const d = x.getImageData(0, 0, 40, 40).data; let r = 0, g = 0, bb = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bb += d[i + 2]; }
      const n = d.length / 4; return [r / n, g / n, bb / n].map(Math.round);
    }, f.img);
  };
  const rgb0 = await sat();
  await p.tap('.tool[data-tool="filter-layer"]');
  await p.waitForSelector('.sheet.in .flt-tile');
  await p.tap('.flt-tile[data-filter="bw"]');
  await p.waitForTimeout(400);
  st = await project();
  const layer = st.clips.find((c) => c.effect?.type === 'adjust');
  check(layer?.filter?.name === 'bw', `Filter (menu utama) membuat lapisan filter "${layer?.name}" dengan Hitam Putih`);
  const rgb1 = await sat();
  check(rgb0[0] - rgb0[2] > 120 && Math.abs(rgb1[0] - rgb1[2]) < 25, `lapisan filter mewarnai frame: merah [${rgb0}] → abu-abu [${rgb1}]`);
  await p.tap('.sh-ok');
  await p.waitForTimeout(250);
  await toRoot();
  await p.tap('.tool[data-tool="adjust-layer"]');
  await p.waitForSelector('.sheet.in .sec-adjust');
  await p.tap('.sh-ok');
  await p.waitForTimeout(300);
  st = await project();
  check(st.clips.filter((c) => c.effect?.type === 'adjust').length === 1, 'lapisan Sesuaikan yang tidak diubah dihapus lagi saat panel ditutup');
  await toRoot();

  // --- Main → overlay and back ------------------------------------------------------------------
  await mcp('playback', { action: 'seek', time: 0.5 });
  await p.waitForTimeout(250);
  await p.tap('.tool[data-tool="edit"]');
  await p.waitForTimeout(200);
  const movedId = await p.evaluate(() => document.querySelector('.clip.selected')?.dataset.id);
  await p.tap('.tool[data-tool="to-overlay"]');
  await p.waitForTimeout(300);
  st = await project();
  check(st.clips.find((c) => c.id === movedId)?.track_kind === 'overlay', 'Overlay memindah klip utama ke lapisan overlay');
  check(st.clips.filter((c) => c.track === 'main').sort((a, c2) => a.start - c2.start)[0].start === 0, 'track utama merapat setelah klip dipindah');

  // --- Ganti: swap the media of a main clip, keeping its place --------------------------------------
  await toRoot();
  await mcp('playback', { action: 'seek', time: 0.5 });
  await p.waitForTimeout(250);
  await p.tap('.tool[data-tool="edit"]');
  await p.waitForTimeout(200);
  const repId = await p.evaluate(() => document.querySelector('.clip.selected')?.dataset.id);
  const media = (await mcp('list_media')).data;
  const repBefore = (await project()).clips.find((c) => c.id === repId);
  const other = media.find((m) => m.id !== repBefore.media_id && m.type === 'video');
  await p.tap('.tool[data-tool="replace"]');
  await p.waitForSelector(`.sheet.in [data-media="${other.id}"]`);
  await p.tap(`.sheet [data-media="${other.id}"] .mc-thumb`);
  await p.waitForTimeout(300);
  const repAfter = (await project()).clips.find((c) => c.id === repId);
  check(repAfter.media_id === other.id && repAfter.start === repBefore.start && !(await p.$('.sheet.in')), 'Ganti menukar media klip (posisi tetap) lalu menutup panel');

  // --- Audio → Ekstrak: the sound of a video onto an audio lane -------------------------------------
  await toRoot();
  await p.tap('.tool[data-tool="cat-audio"]');
  await p.tap('.tool[data-tool="extract"]');
  await p.waitForSelector(`.sheet.in [data-media="${other.id}"]`);
  await p.tap(`.sheet [data-media="${other.id}"] .mc-thumb`);
  await p.waitForTimeout(300);
  check((await project()).clips.some((c) => c.type === 'audio' && c.media_id === other.id), 'Audio → Ekstrak menaruh audio video di lane audio');

  // --- Sampul (cover) ------------------------------------------------------------------------------
  await toRoot();
  await p.evaluate(() => document.querySelector('.tl-scroll').scrollLeft = 0);
  await p.waitForTimeout(250);
  await p.tap('.gut-cover');
  await p.tap('.sheet.in [data-do="set"]');
  await p.tap('.sh-ok');
  await p.waitForTimeout(300);
  check(!!(await p.$('.gut-cover img[src^="data:image/jpeg"]')), 'Sampul: frame di playhead jadi gambar sampul');

  // --- Add text from the Teks menu: sheet + typing ------------------------------------------------
  await toRoot();
  await p.tap('.tool[data-tool="cat-text"]');
  await p.tap('.tool[data-tool="add-text"]');
  await p.waitForSelector('.sheet.in .text-input');
  await p.fill('.sheet .text-input', 'DISKON 50%');
  await p.waitForTimeout(250);
  st = await project();
  check(st.clips.some((c) => c.text === 'DISKON 50%'), 'Teks → Tambah teks → mengetik di sheet mengubah teksnya');
  await p.tap('.sub-tabs [data-texttab="font"]');
  await p.tap('.font-item[data-font="Anton"]');
  await p.waitForTimeout(250);
  st = await project();
  check(st.clips.find((c) => c.text === 'DISKON 50%')?.font === 'Anton', 'tab Font mengganti font teks');
  await p.tap('.sh-ok');

  // --- Portrait iPad ------------------------------------------------------------------------------
  await p.setViewportSize({ width: 820, height: 1180 });
  await p.waitForTimeout(500);
  const pg = await p.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    toolbar: document.querySelector('.toolbar').getBoundingClientRect().bottom <= innerHeight + 1,
    stage: document.querySelector('.stage').getBoundingClientRect().height,
  }));
  check(!pg.overflow && pg.toolbar && pg.stage > 400, `iPad potret: tanpa geser samping, toolbar terlihat, pratinjau ${Math.round(pg.stage)} px`);

  check(errors.length === 0, `tanpa error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await b.close();
}
console.log(failed ? `${failed} cek gagal` : 'semua cek UI iPad lolos');
cleanup();
process.exit(failed ? 1 : 0);
