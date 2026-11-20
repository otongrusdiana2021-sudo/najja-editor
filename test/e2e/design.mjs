// End-to-end (v1.13): Najja Desain. Home → "Mulai Desain" → a size → the design page; a text added and edited where
// it is, its font, colour and effect; a shape, an icon (Lucide from /vendor), a photo imported (kept on the server);
// moved, snapped, resized; undo/redo; a second page with a template whose photo frame is filled; export (PNG of
// one page, ZIP of all), a reload keeps everything, back home the design has its card; layout on iPad and a phone.
// Needs Playwright (with Chromium) and ffmpeg. Run: npm run test:e2e
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-design-1234567890';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) {
  console.log(`SKIP design e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`);
  process.exit(0);
}
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-design-e2e-'));
const photo = path.join(dir, 'tas.png');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2f6fdf:s=600x800,drawbox=x=150:y=200:w=300:h=400:color=0x4a2a1a:t=fill', '-frames:v', '1', photo]);
const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port), NAJJA_AI_URL: '' }, stdio: 'ignore' });
let cleaned = false;
const cleanup = () => { if (cleaned) return; cleaned = true; try { server.kill(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); };
process.on('exit', cleanup);
process.on('unhandledRejection', (err) => { console.error('FAIL ', err); cleanup(); process.exit(1); });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await wait(100); }

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1194, height: 834 }, hasTouch: true, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'desain@najja.id'); await p.fill('#password', 'rahasia-desain'); await p.fill('#password2', 'rahasia-desain'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  const D = (fn, arg) => p.evaluate(([src, a]) => (0, eval)(src)(window.najjaDesign, a), [fn.toString(), arg]);
  const booted = () => p.waitForFunction(() => window.najjaDesign?.design && document.querySelector('.ds-boot').hidden, null, { timeout: 20000 });
  const settle = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  /** Screen point of a page point (page px). */
  const scr = (x, y) => p.evaluate(([px, py]) => { const r = document.querySelector('.ds-page').getBoundingClientRect(); const z = window.najjaDesign.stage.zoom; return { x: r.left + px * z, y: r.top + py * z }; }, [x, y]);
  const boxOf = (id) => D((a, i) => { const b = a.stage.boxes.get(i); return b && { ...b }; }, id);

  // ---- home: two ways to start
  step('beranda: Edit Video + Mulai Desain');
  const starts = await p.evaluate(() => ({ cards: document.querySelectorAll('.hm-starts .hm-new').length, sizes: document.querySelectorAll('[data-dsize]').length }));
  check(starts.cards === 2, 'dua kartu besar: Edit Video dan Mulai Desain');
  check(starts.sizes === 6, `ukuran desain cepat (${starts.sizes})`);
  await p.click('.hm-starts [data-design]');
  await p.waitForSelector('.dz-sizes');
  check(await p.locator('.dz-size').count() === 6, 'dialog Mulai Desain: 6 ukuran + ukuran khusus');
  await p.click('[data-z="produk"]');
  await p.waitForURL(/\/design\?id=p_/, { timeout: 15000 });
  await booted();
  const d0 = await D((a) => ({ w: a.design.width, h: a.design.height, kind: a.design.kind, pages: a.design.pages.length, tab: a.ui.tab, id: a.design.id }));
  check(d0.w === 1080 && d0.h === 1080 && d0.kind === 'design' && d0.pages === 1, `desain baru 1080×1080 (${JSON.stringify(d0)})`);
  check(d0.tab === 'tpl', 'panel Template terbuka untuk halaman kosong');
  check(await p.evaluate(() => document.querySelector('.ds-logo')?.naturalWidth > 0), 'logo Najja Desain tampil');
  const nTpl = await p.locator('[data-tpl]').count();
  check(nTpl >= 27, `${nTpl} template di panel`);
  const saved0 = await (await p.request.get(`${BASE}/api/projects/${d0.id}`)).json();
  check(saved0.kind === 'design' && saved0.pages?.length === 1, 'desain langsung tersimpan di server');

  // ---- text: add, edit where it is, font, colour, effect
  step('teks: tambah, ketik, font, warna, efek, lengkung');
  await p.click('[data-tab="text"]');
  await p.click('[data-add="text:body"][data-edit]');
  await p.waitForSelector('textarea.ds-edit');
  await p.fill('textarea.ds-edit', 'Tas Kulit Premium');
  await p.keyboard.press('Escape');
  await settle();
  const t1 = await D((a) => { const e = a.page.els.at(-1); return { type: e.type, content: e.text.content, sel: a.sel.includes(e.id), id: e.id, editing: a.stage.editing }; });
  check(t1.type === 'text' && t1.content === 'Tas Kulit Premium' && !t1.editing, `teks diketik langsung di halaman (${t1.content})`);
  check(t1.sel && await p.locator('.ds-ctx [data-act="font"]').count() === 1, 'toolbar teks muncul (font, ukuran, warna, efek)');
  await p.click('.ds-ctx [data-act="font"]');
  await p.click('.ds-pop [data-font="Anton"]');
  await p.click('.ds-ctx [data-act="color"]');
  await p.click('.ds-pop [data-c="#E53935"]');
  await p.click('.ds-ctx [data-act="size+"]');
  const t2 = await D((a, id) => { const e = a.page.els.find((x) => x.id === id); return { font: e.text.font, color: e.text.color, size: e.text.size }; }, t1.id);
  check(t2.font === 'Anton' && t2.color === '#E53935' && t2.size > 44, `font Anton, merah, lebih besar (${JSON.stringify(t2)})`);
  await p.click('.ds-ctx [data-act="effects"]');
  const fxTiles = await p.locator('.ds-pop [data-fx]').count();
  await p.click('.ds-pop [data-fx="splice"]');
  await p.click('.ds-pop [data-curve="40"]');
  const t3 = await D((a, id) => { const e = a.page.els.find((x) => x.id === id); return { fx: e.text.effect?.type, curve: e.text.curve }; }, t1.id);
  check(fxTiles >= 9 && t3.fx === 'splice' && t3.curve === 40, `efek teks (${fxTiles} pilihan): sambung + lengkung`);
  await p.keyboard.press('Escape');

  // ---- elements: a shape, an icon, a marketplace label
  step('elemen: bentuk, ikon Lucide, label marketplace');
  await p.click('[data-tab="el"]');
  await p.click('[data-add="shape:star"]');
  await p.click('[data-add="badge:0"]');
  await p.waitForFunction(() => document.querySelectorAll('[data-icons] [data-add^="icon:"]').length > 20, null, { timeout: 30000 }).catch(() => {});
  const icons = await p.locator('[data-icons] [data-add^="icon:"]').count();
  check(icons > 20, `ikon Lucide dari /vendor (${icons} di panel)`);
  await p.fill('[data-iconq]', 'tas');
  await p.waitForFunction(() => document.querySelector('[data-iconres] [data-add^="icon:"]'), null, { timeout: 10000 }).catch(() => {});
  const found = await p.locator('[data-iconres] [data-add^="icon:"]').count();
  check(found > 0, `cari ikon dalam bahasa Indonesia: "tas" → ${found} ikon`);
  if (found) await p.click('[data-iconres] [data-add^="icon:"] >> nth=0');
  await p.fill('[data-iconq]', '');
  await p.click('[data-expand="shapes"]');
  await p.click('[data-expand="frames"]');
  const nShapes = await p.locator('[data-add^="shape:"]').count();
  const nFrames = await p.locator('[data-add^="frame:"]').count();
  check(nShapes >= 34 && nFrames >= 24, `bentuk ${nShapes}, bingkai foto ${nFrames}`);
  const kinds = await D((a) => a.page.els.map((e) => (e.type === 'sticker' ? (e.sticker.icon ? 'icon' : e.sticker.badge ? 'badge' : 'sticker') : e.type)));
  check(kinds.includes('shape') && kinds.includes('badge') && (kinds.includes('icon') || !found), `elemen di halaman: ${kinds.join(', ')}`);

  // ---- a photo: imported, kept on the server
  step('foto: impor dari perangkat, disimpan di server');
  await p.click('[data-tab="up"]');
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-upload]')]);
  await chooser.setFiles(photo);
  await p.waitForFunction(() => window.najjaDesign.page.els.some((e) => e.type === 'image'), null, { timeout: 10000 });
  await p.waitForFunction(() => window.najjaDesign.uploadsN === 0 && window.najjaDesign.design.media.every((m) => !m.local), null, { timeout: 20000 });
  const img = await D((a) => { const e = a.page.els.find((x) => x.type === 'image'); return { id: e.id, mediaId: e.mediaId, x: e.x, y: e.y, scale: e.scale }; });
  const file = await p.request.get(`${BASE}/api/media/${img.mediaId}/file`);
  check(file.ok() && (await file.body()).length > 100, 'foto ada di pustaka media server');
  check(await p.locator('.ds-ctx [data-act="cutout"]').count() === 1 && await p.locator('.ds-ctx [data-act="filter"]').count() === 1, 'toolbar foto: Ganti, Hapus latar, Filter, Sesuaikan, Bingkai, Bayangan');
  await p.click('.ds-ctx [data-act="mask"]');
  await p.click('.ds-pop [data-mask="circle"]');
  await p.keyboard.press('Escape');
  check(await D((a, id) => a.page.els.find((e) => e.id === id).mask?.kind, img.id) === 'circle', 'bingkai lingkaran untuk foto');

  // ---- move (with snapping), resize, rotate by the handles (mouse)
  step('geser (garis bantu), ubah ukuran, undo/redo');
  await settle();
  const b0 = await boxOf(img.id);
  const from = await scr(b0.cx, b0.cy);
  // to 6 page px right of the centre line: it snaps onto it
  const to = await scr(540 + 6, b0.cy + 120);
  const pageRect = () => p.evaluate(() => { const s = document.querySelector('.ds-stage'); const r = document.querySelector('.ds-page').getBoundingClientRect(); return { over: Math.max(s.scrollHeight - s.clientHeight, s.scrollWidth - s.clientWidth), page: [r.left, r.top, r.width, r.height] }; });
  const still0 = await pageRect();
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await p.mouse.move(to.x, to.y, { steps: 4 });
  const guides = await p.locator('.ds-guide').count();
  const still1 = await pageRect();
  await p.mouse.up();
  check(still1.over <= 0 && still1.page.every((v, i) => Math.abs(v - still0.page[i]) < 0.5), `halaman diam saat menggeser dengan garis bantu (area gulir +${still1.over} px)`);
  await settle();
  const b1 = await boxOf(img.id);
  check(Math.abs(b1.cx - 540) < 0.6 && b1.cy > b0.cy + 100, `geser + menempel ke tengah halaman (cx ${b1.cx.toFixed(1)}, garis bantu ${guides})`);
  check(guides > 0, 'garis bantu merah muda tampil saat menempel');
  const corner = await p.locator('.ds-box [data-h="se"]').boundingBox();
  await p.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await p.mouse.down();
  await p.mouse.move(corner.x + 60, corner.y + 60, { steps: 5 });
  await p.mouse.up();
  const sc1 = await D((a, id) => a.page.els.find((e) => e.id === id).scale, img.id);
  check(sc1 > img.scale * 1.1, `ubah ukuran dari sudut (${img.scale} → ${sc1})`);
  await p.keyboard.press('Control+z');
  const sc2 = await D((a, id) => a.page.els.find((e) => e.id === id).scale, img.id);
  await p.keyboard.press('Control+Shift+z');
  const sc3 = await D((a, id) => a.page.els.find((e) => e.id === id).scale, img.id);
  check(Math.abs(sc2 - img.scale) < 1e-6 && Math.abs(sc3 - sc1) < 1e-6, 'urungkan / ulangi');
  await p.keyboard.press('Control+d');
  const nEls = await D((a) => a.page.els.length);
  await p.keyboard.press('Delete');
  check(await D((a) => a.page.els.length) === nEls - 1, 'duplikat (Ctrl+D) dan hapus (Del)');

  // ---- a second page with a template; its photo frame filled
  step('halaman 2: template + isi bingkai foto');
  await p.click('[data-pgadd]');
  check(await D((a) => a.design.pages.length === 2 && a.pageIndex === 1), 'halaman kedua ditambahkan');
  await p.click('[data-tab="tpl"]');
  await p.click('[data-tpl="diskon"]');
  await settle();
  const slot = await D((a) => { const e = a.page.els.find((x) => x.slot); return e && { id: e.id, w: e.shape.w, h: e.shape.h, r: e.shape.radius }; });
  check(!!slot, 'template Diskon punya bingkai foto');
  const sb = await boxOf(slot.id);
  const sp = await scr(sb.cx, sb.cy);
  await p.mouse.click(sp.x, sp.y);
  check(await p.locator('.ds-ctx [data-act="slotpick"]').count() === 1, 'bingkai dipilih: tombol "Pilih foto"');
  const [ch2] = await Promise.all([p.waitForEvent('filechooser'), p.click('.ds-ctx [data-act="slotpick"]')]);
  await ch2.setFiles(photo);
  await p.waitForFunction((id) => window.najjaDesign.page.els.find((e) => e.id === id)?.type === 'image', slot.id, { timeout: 10000 });
  await settle();
  const filled = await D((a, id) => { const e = a.page.els.find((x) => x.id === id); return { type: e.type, mask: e.mask, crop: e.crop, box: { ...a.stage.boxes.get(id) } }; }, slot.id);
  check(filled.type === 'image' && filled.mask?.kind === 'rect' && filled.mask.radius > 0, 'foto mengisi bingkai (sudut bulat dari template)');
  check(Math.abs(filled.box.w - sb.w) < 2 && Math.abs(filled.box.h - sb.h) < 2, `foto pas seukuran bingkai (${Math.round(filled.box.w)}×${Math.round(filled.box.h)} vs ${Math.round(sb.w)}×${Math.round(sb.h)})`);
  check(filled.crop.t > 0 || filled.crop.l > 0, 'foto dipotong ke bentuk bingkai (tidak gepeng)');

  // ---- v1.13.1: each colour picker changes only its own element; a photo dragged onto a frame goes into it
  step('halaman 3: warna tidak tercampur + geser foto ke bingkai');
  const pick = (c) => p.locator(`.ds-pop [data-c="${c}"]`).first().click();
  await p.click('[data-pgadd]');
  await D((a) => a.ui.openTab('tpl'));
  await p.click('[data-tpl="restock"]');
  await settle();
  await D((a) => a.select([]));
  await p.click('.ds-ctx [data-act="pagebg"]');
  await pick('#FFD400');
  await p.keyboard.press('Escape');
  const sw = await D((a) => a.page.els.find((e) => e.sticker?.swatch).id);
  await D((a, id) => a.select([id]), sw);
  await p.click('.ds-ctx [data-act="swcolor"]');
  await pick('#E53935');
  await p.keyboard.press('Escape');
  const c1 = await D((a, id) => ({ bg: a.page.bg.color, sw: a.page.els.find((e) => e.id === id).sticker.swatch.color }), sw);
  check(c1.bg === '#FFD400' && c1.sw === '#E53935', `warna varian berubah, latar tetap (${JSON.stringify(c1)})`);
  await p.click('.ds-ctx [data-act="swlcolor"]');
  await pick('#5B3FD1');
  await p.keyboard.press('Escape');
  const tid = await D((a) => a.page.els.find((e) => e.type === 'text').id);
  await D((a, id) => a.select([id]), tid);
  await p.click('.ds-ctx [data-act="color"]');
  await pick('#129AA9');
  await p.keyboard.press('Escape');
  const c2 = await D((a, [s0, t0]) => { const e = (id) => a.page.els.find((x) => x.id === id); return { bg: a.page.bg.color, sw: e(s0).sticker.swatch.color, label: e(s0).sticker.swatch.labelColor, text: e(t0).text.color }; }, [sw, tid]);
  check(c2.text === '#129AA9' && c2.label === '#5B3FD1' && c2.sw === '#E53935' && c2.bg === '#FFD400', `warna teks & nama varian berubah, yang lain tetap (${JSON.stringify(c2)})`);
  const slot3 = await D((a) => a.page.els.find((e) => e.slot).id);
  const n0 = await D((a) => a.page.els.length);
  await p.click('[data-tab="up"]');
  await p.locator('[data-media]').first().click();
  await settle();
  const im3 = await D((a) => a.sel[0]);
  const ib = await boxOf(im3);
  const f0 = await scr(ib.cx, ib.cy);
  const f1 = await scr(560, 720);
  await p.mouse.move(f0.x, f0.y);
  await p.mouse.down();
  await p.mouse.move(f1.x, f1.y, { steps: 6 });
  const dropShown = await p.locator('.ds-box.drop').count();
  await p.mouse.up();
  await settle();
  const st3 = () => D((a, [sl, im]) => { const e = a.page.els.find((x) => x.id === sl); return { n: a.page.els.length, slot: e?.type, framed: !!e?.fromSlot, img: !!a.page.els.find((x) => x.id === im), sel: a.sel.slice() }; }, [slot3, im3]);
  const a3 = await st3();
  check(dropShown === 1, 'bingkai disorot saat foto digeser di atasnya');
  check(a3.n === n0 && a3.slot === 'image' && a3.framed && !a3.img && a3.sel[0] === slot3, `foto masuk ke bingkai saat dilepas (${JSON.stringify(a3)})`);
  await p.keyboard.press('Control+z');
  const u3 = await st3();
  await p.keyboard.press('Control+Shift+z');
  const r3 = await st3();
  check(u3.slot === 'shape' && u3.img && r3.slot === 'image' && !r3.img, 'urungkan / ulangi masuk bingkai');
  await p.click('.ds-pg.on');
  await p.locator('.ds-pop .ds-mi', { hasText: 'Hapus halaman' }).click();
  check(await D((a) => a.design.pages.length === 2 && a.pageIndex === 1), 'halaman 3 dihapus lewat menu halaman');

  // ---- export
  step('ekspor: PNG halaman ini, ZIP semua halaman');
  await p.click('[data-cmd="export"]');
  await p.click('.ds-modal [data-k="pages"] [data-v="cur"]');
  const [dl1] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click('.ds-modal [data-dl]')]);
  const png = fs.readFileSync(await dl1.path());
  const pw = png.readUInt32BE(16);
  const ph = png.readUInt32BE(20);
  check(png.subarray(1, 4).toString() === 'PNG' && pw === 1080 && ph === 1080, `PNG 1080×1080 (${dl1.suggestedFilename()})`);
  const px = await p.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bm = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bm.width, bm.height);
    const g = c.getContext('2d');
    g.drawImage(bm, 0, 0);
    const at = (x, y) => [...g.getImageData(x, y, 1, 1).data];
    return { bg: at(20, 540), price: at(745 + 200, 950) };
  }, png.toString('base64'));
  check(Math.abs(px.bg[0] - 0xff) < 4 && Math.abs(px.bg[1] - 0xf1) < 4 && Math.abs(px.bg[2] - 0xe6) < 4, `warna latar template di file (${px.bg.slice(0, 3)})`);
  await p.click('[data-cmd="export"]');
  await p.click('.ds-modal [data-k="fmt"] [data-v="jpg"]');
  await p.click('.ds-modal [data-k="pages"] [data-v="all"]');
  const [dl2] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click('.ds-modal [data-dl]')]);
  const zipPath = await dl2.path();
  const zbuf = fs.readFileSync(zipPath);
  let names = [];
  try {
    names = JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys,zipfile,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps(z.namelist()))', zipPath]).toString());
  } catch (err) { names = zbuf.subarray(0, 2).toString() === 'PK' ? ['?'] : []; console.log('   (python3 tidak ada / zip error)', err.message.split('\n')[0]); }
  check(dl2.suggestedFilename().endsWith('.zip') && names.length === 2 && names.every((n) => n.endsWith('.jpg')), `ZIP berisi 2 JPG (${names.join(', ')})`);

  // ---- v1.13.1: another page size while editing
  step('ubah ukuran kanvas');
  const sz = () => D((a) => { const t = a.design.pages[0].els.find((e) => e.type === 'text'); const r = document.querySelector('.ds-page').getBoundingClientRect(); return { w: a.design.width, h: a.design.height, t: t.scale, x: t.x, ratio: r.width / r.height }; });
  const z0 = await sz();
  await p.click('[data-cmd="resize"]');
  await p.click('.ds-modal [data-z="banner"]');
  await p.click('.ds-modal [data-go]');
  await settle();
  const z1 = await sz();
  check(z1.w === 1920 && z1.h === 640 && Math.abs(z1.ratio - 3) < 0.02, `ukuran jadi Banner 1920×640 (halaman ${z1.ratio.toFixed(2)}:1)`);
  check(Math.abs(z1.t - (z0.t * 640) / 1080) < 1e-3 && z1.x === z0.x, 'elemen ikut menyesuaikan (ukuran ikut sisi pendek, posisi tetap)');
  await p.keyboard.press('Control+z');
  await settle();
  const z2 = await sz();
  check(z2.w === 1080 && z2.h === 1080 && Math.abs(z2.t - z0.t) < 1e-6 && Math.abs(z2.ratio - 1) < 0.02, 'urungkan ubah ukuran');

  // ---- reload keeps everything; back home
  step('muat ulang + kembali ke beranda');
  await p.waitForFunction(() => !window.najjaDesign.unsaved && !window.najjaDesign.saving, null, { timeout: 10000 });
  const before = await D((a) => JSON.stringify(a.design.pages));
  await p.reload();
  await booted();
  const after = await D((a) => JSON.stringify(a.design.pages));
  check(after === before, 'muat ulang: desain sama persis');
  await p.waitForFunction(() => window.najjaDesign.assets.sources.size >= 2, null, { timeout: 10000 }).catch(() => {});
  check(await D((a) => a.assets.sources.size) >= 2, 'foto dimuat lagi dari server');
  await p.click('[data-cmd="home"]');
  await p.waitForSelector('body.ready');
  await p.waitForSelector('.hm-card.design');
  const card = await p.evaluate(() => { const c = document.querySelector('.hm-card.design'); return { badge: c.querySelector('.hm-badge')?.textContent, meta: c.querySelector('.hm-meta span').textContent, thumb: !!c.querySelector('img') }; });
  check(card.badge === 'Desain' && /2 hal/.test(card.meta) && card.thumb, `kartu desain di beranda (${card.meta})`);
  await p.click('[data-kind="design"]');
  check(await p.locator('.hm-card').count() === 1, 'filter Desain');
  await p.click('.hm-card.design [data-open]');
  await p.waitForURL(/\/design\?id=/);
  await booted();
  check(await D((a) => a.design.pages.length) === 2, 'kartu desain membuka Najja Desain');
  // a design opened through the video editor's address goes to Najja Desain
  await p.goto(`${BASE}/?p=${d0.id}`);
  await p.waitForURL(/\/design\?id=/, { timeout: 10000 });
  check(true, '/?p=<desain> diarahkan ke Najja Desain');

  // ---- layout: iPad portrait and a phone
  for (const [name, vp] of [['iPad potret', { width: 834, height: 1194 }], ['ponsel', { width: 390, height: 844 }]]) {
    await p.setViewportSize(vp);
    await booted();
    await wait(400);
    const lay = await p.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      return { page: r('.ds-page'), rail: r('.ds-rail'), stage: r('.ds-stage'), overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    check(!lay.overflow && lay.page.width > vp.width * 0.6 && lay.page.left >= lay.stage.left - 1 && lay.page.right <= lay.stage.right + 1, `${name}: halaman pas di layar (${Math.round(lay.page.width)} px)`);
    check(vp.width < 820 ? lay.rail.top > vp.height / 2 : lay.rail.left === 0, `${name}: menu ${vp.width < 820 ? 'di bawah' : 'di kiri'}`);
  }
  await p.screenshot({ path: path.join(dir, 'phone.png') });
  check(!errors.length, `tanpa error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} FAILED` : '\nall design e2e checks passed');
process.exit(failed ? 1 : 0);
