// End-to-end (v1.10): Style Konsep — the three styles through MCP and through the Style sheet.
//   A. list_styles: fit of the material, recommendation; MCP prompts
//   B. apply_style editorial without a plan: a NEW project, the original untouched, the look of the style
//   C. apply_style with the AI's plan (keywords, price, B-roll) is followed exactly; one undo takes it back
//   D. showcase and storypop; the new transitions and text animations render (get_frame) and export
//   E. the Style sheet: three cards, recommendation, form, Generate (one, and all three)
// The transcript is put into the project directly (Whisper is not in the test environment); get_transcript then
// returns it. Needs Playwright (with Chromium) and ffmpeg. Run: node test/e2e/styles.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-styles-1234567890';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) {
  console.log(`SKIP styles e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`);
  process.exit(0);
}
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-styles-e2e-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
// "talking" video 9:16 with sound (the words come from the transcript below), two product shots (one landscape), a photo
ff(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=22', '-f', 'lavfi', '-i', 'sine=f=300:sample_rate=48000:d=22', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path.join(dir, 'media', 'ngomong.mp4')]);
ff(['-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(dir, 'media', 'produk1.mp4')]);
ff(['-f', 'lavfi', '-i', 'color=c=0xff8800:s=360x640:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(dir, 'media', 'produk2.mp4')]);
ff(['-f', 'lavfi', '-i', 'color=c=0x2288ff:s=600x600', '-frames:v', '1', path.join(dir, 'media', 'foto.png')]);
const SAID = ['Halo semuanya, hari ini aku mau review travel bag mini.', 'Tas ini muat lima sampai enam outfit, ringan banget dan anti air.', 'Kamu butuh lebih dari satu size?', 'Harganya cuma 149 ribu, seharga tiket bioskop.', 'Buruan checkout sebelum stok habis ya.'];
const WORDS = [];
{ let t = 0.8; for (const s of SAID) { for (const w of s.split(' ')) { WORDS.push({ w, s: +t.toFixed(3), e: +(t + 0.3).toFixed(3) }); t += 0.36; } t += 1.2; } }

const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port) }, stdio: 'ignore' });
let cleaned = false;
const cleanup = () => { if (cleaned) return; cleaned = true; try { server.kill(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); };
process.on('exit', cleanup);
process.on('unhandledRejection', (err) => { console.error('FAIL ', err); cleanup(); process.exit(1); });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await wait(100); }
const rpc = async (method, params = {}) => {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
  return r.json();
};
const mcp = async (name, args = {}) => {
  const j = await rpc('tools/call', { name, arguments: args });
  if (!j.result || j.result.isError) throw new Error(JSON.stringify(j.error || j.result));
  const t = j.result.content.find((c) => c.type === 'text');
  const img = j.result.content.find((c) => c.type === 'image');
  return { ...JSON.parse(t.text), img: img?.data };
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'style@najja.id'); await p.fill('#password', 'rahasia-style'); await p.fill('#password2', 'rahasia-style'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.goto(`${BASE}/?debug`);
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));
  await mcp('new_project', { name: 'Review Tas', aspect_ratio: '9:16' });
  const ids = {};
  for (const f of ['ngomong.mp4', 'produk1.mp4', 'produk2.mp4', 'foto.png']) ids[f] = (await mcp('import_media', { path: f })).media_id;
  await mcp('add_media_clip', { media_id: ids['ngomong.mp4'], track: 'main' });
  for (let t = Date.now(); Date.now() - t < 60000; await wait(250)) {
    if (await p.evaluate(async (list) => { const { mediaRT } = await import('/js/media.js'); return list.every((id) => mediaRT.get(id)?.url || mediaRT.get(id)?.img); }, Object.values(ids))) break;
  }
  // the transcript, as Whisper would have written it (talking video: words; product videos: none)
  const source = await p.evaluate(async ({ talk, shots, words }) => {
    const { store } = await import('/js/store.js');
    store.P.speech = { [talk]: { lang: 'id', words }, ...Object.fromEntries(shots.map((id) => [id, { lang: 'id', words: [] }])) };
    await store.save({ force: true });
    return { id: store.P.id, clips: store.P.clips.length, name: store.P.name };
  }, { talk: ids['ngomong.mp4'], shots: [ids['produk1.mp4'], ids['produk2.mp4']], words: WORDS });

  step('A. list_styles dan prompt MCP');
  const ls = await mcp('list_styles');
  check(ls.styles.map((s) => s.id).join(',') === 'showcase,editorial,storypop', `3 style: ${ls.styles.map((s) => s.name).join(', ')}`);
  check(ls.styles.every((s) => s.fits_material === 'yes') && ls.recommended === 'storypop', `bahan cocok untuk semua, disarankan ${ls.recommended} (${ls.material.talking_seconds} dtk ngomong, ${ls.material.other_clips.length} klip lain)`);
  const tr = await mcp('get_transcript');
  check(tr.words.length === WORDS.length && tr.sentences.length === 5, `get_transcript: ${tr.words.length} kata, ${tr.sentences.length} kalimat`);
  const pl = await rpc('prompts/list');
  check(pl.result?.prompts?.map((x) => x.name).join(',') === 'najja-showcase,najja-editorial,najja-storypop,najja-semua-style', 'prompt MCP: /najja-showcase, /najja-editorial, /najja-storypop, /najja-semua-style');
  const pg = await rpc('prompts/get', { name: 'najja-editorial', arguments: { produk: 'Travel Bag', harga: '189rb' } });
  check(/get_transcript/.test(pg.result?.messages?.[0]?.content?.text) && /Travel Bag/.test(pg.result.messages[0].content.text), 'prompt berisi langkah kerja + info produk');

  step('B. apply_style editorial (tanpa rencana): proyek baru, proyek asli utuh');
  const product = { name: 'Travel Bag', variant: 'Mini, Medium, Jumbo', size: '28 cm, 35 cm, 45 cm', price: '189rb', price_discount: '149rb' };
  const ed = await mcp('apply_style', { style: 'editorial', product });
  check(ed.project_id !== source.id && ed.project_name === 'Review Tas · Editorial Review', `proyek baru "${ed.project_name}"`);
  check(ed.cut_seconds > 4 && ed.keywords >= 1 && ed.price && ed.subtitles >= 2 && ed.music, `edit: ${ed.duration} dtk (dipotong ${ed.cut_seconds} dtk), ${ed.keywords} kata kunci, harga, ${ed.subtitles} subtitle, musik`);
  const orig = await p.evaluate(async (id) => (await (await fetch(`/api/projects/${id}`, { credentials: 'same-origin' })).json()), source.id);
  check(orig.clips.length === source.clips && orig.name === source.name && !orig.style, `proyek asli tidak berubah (${orig.clips.length} klip, "${orig.name}")`);
  const look = await p.evaluate(async () => {
    const { store } = await import('/js/store.js');
    const T = store.P.clips.filter((c) => c.type === 'text');
    return {
      aspect: `${store.P.width}x${store.P.height}`,
      anton: T.filter((c) => c.text.font === 'Anton' && c.text.color === '#F8F8A8').map((c) => ({ w: c.text.content, s: c.start })),
      strike: T.some((c) => c.text.strike && c.text.content === 'Rp189.000'),
      sub: store.P.tracks.some((t) => t.subtitle && t.linked !== false),
      leak: store.P.clips.some((c) => c.transition?.type === 'leak'),
      matte: store.P.clips.filter((c) => c.trackId === 'main').every((c) => c.filter.name === 'warmMatte'),
    };
  });
  check(look.aspect === '1080x1920' && look.anton.length >= 2 && look.strike && look.sub && look.leak && look.matte,
    `tampilan Editorial: 9:16, kata kunci Anton krem (${look.anton.map((x) => x.w).join(' ')}), harga coret, subtitle tertaut, cahaya bocor, Matte Hangat`);
  const fk = await mcp('get_frame', { time: look.anton[0].s + 0.4, max_width: 270 });
  const stats = (b64) => p.evaluate(async (src) => {
    const im = new Image(); im.src = `data:image/jpeg;base64,${src}`; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let cream = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 130 && d[i + 2] < 205) cream++;
    return { w: c.width, h: c.height, cream: cream / (d.length / 4) };
  }, b64);
  const fs1 = await stats(fk.img);
  check(fs1.h > fs1.w && fs1.cream > 0.004, `get_frame di kata kunci: teks krem terlihat (${(fs1.cream * 100).toFixed(1)}% piksel)`);

  step('C. rencana dari AI diikuti persis; satu kali urung');
  const at = tr.words.find((w) => w.w === 'muat').s;
  const ai = await mcp('apply_style', { style: 'editorial', product: { ...product, brand: '' }, plan: {
    keywords: [{ start: at, words: ['MUAT', 'LIMA', 'OUTFIT'] }], price: { start: tr.words.find((w) => w.w === 'Harganya').s, normal: '200000', discount: '150000' },
    broll: [{ start: at + 2.5, duration: 1.5, media_id: ids['foto.png'] }], outro: false, music: 'none',
  } });
  const aiLook = await p.evaluate(async (foto) => {
    const { store } = await import('/js/store.js');
    const T = store.P.clips.filter((c) => c.type === 'text');
    return { name: store.P.name, kw: T.filter((c) => c.text.font === 'Anton' && c.text.color === '#F8F8A8').map((c) => c.text.content), price: T.some((c) => c.text.content === 'Rp150.000'), foto: store.P.clips.filter((c) => c.mediaId === foto).length, audio: store.P.clips.filter((c) => c.type === 'audio' && !/^SFX /.test(c.name)).length, sfx: store.P.clips.filter((c) => /^SFX /.test(c.name)).length };
  }, ids['foto.png']);
  check(aiLook.kw.join(' ') === 'MUAT LIMA OUTFIT' && aiLook.price && aiLook.foto === 1 && aiLook.audio === 0 && ai.outro === false && aiLook.sfx > 0,
    `rencana AI: kata kunci ${aiLook.kw.join(' ')}, harga Rp150.000, B-roll foto, tanpa musik & outro (SFX tetap: ${aiLook.sfx})`);
  check(aiLook.name === 'Review Tas · Editorial Review', `style dari proyek style tetap memakai nama asli ("${aiLook.name}")`);
  // (this edit was made from the first one's project: one undo brings that edit back, whole)
  const undone = await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.undo(); return { style: store.P.style?.id, kw: store.P.clips.filter((c) => c.type === 'text' && c.text.font === 'Anton' && c.text.color === '#F8F8A8').map((c) => c.text.content).join(' '), audio: store.P.clips.filter((c) => c.type === 'audio').length }; });
  check(undone.style === 'editorial' && undone.kw !== 'MUAT LIMA OUTFIT' && undone.audio > 0, `satu kali urung mengembalikan seluruh edit (kata kunci kembali: ${undone.kw})`);
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.redo(); });

  step('D. Showcase Clean dan Story Pop; transisi & animasi baru dirender');
  const sc = await mcp('apply_style', { style: 'showcase', product: { ...product, note: 'Fits 5-6 Outfits' } });
  check(sc.sections === 4 && sc.variants.join(',') === 'Mini,Medium,Jumbo' && sc.music, `Showcase: ${sc.sections} bagian (${sc.variants.join(', ')} + penutup), ${sc.duration} dtk, musik`);
  const punch = await p.evaluate(async () => { const { store } = await import('/js/store.js'); return store.P.clips.filter((c) => c.transition?.type === 'punch').map((c) => c.start); });
  const fp = await mcp('get_frame', { time: punch[0] + 0.05, max_width: 270 });
  check(punch.length === 3 && fp.img, `zoom punch di ${punch.map((x) => x.toFixed(1)).join(', ')} dtk dirender`);
  const sp = await mcp('apply_style', { style: 'storypop', product });
  check(sp.hook >= 4 && sp.price && sp.broll >= 1, `Story Pop: hook ${sp.hook} kata, ${sp.broll} B-roll, harga, sting ${sp.sting}`);
  const spT = await p.evaluate(async () => {
    const { store } = await import('/js/store.js');
    const T = store.P.clips.filter((c) => c.type === 'text');
    return { conv: T.find((c) => c.animIn.type === 'converge')?.start, harga: T.find((c) => c.text.content === 'HARGA!!')?.start, think: store.P.clips.some((c) => c.sticker?.emoji === '🤔') };
  });
  const f1 = await mcp('get_frame', { time: spT.conv + 0.1, max_width: 270 });
  const f2 = await mcp('get_frame', { time: spT.harga + 0.6, max_width: 270 });
  check(spT.think && f1.img && f2.img, 'hook "Merapat" + 🤔 dan "HARGA!!" dirender');
  // export the Story Pop edit (new transitions and animations in the export path too)
  const ex = await p.evaluate(async () => {
    const { exportVideo } = await import('/js/exporter.js');
    const res = await exportVideo(window.najja.engine, { resolution: '480p', format: 'mp4' });
    return { size: res.blob.size, mode: res.mode, w: res.width, h: res.height };
  });
  check(ex.size > 50000, `ekspor Story Pop: ${(ex.size / 1024).toFixed(0)} KB (${ex.mode})`);

  step('E. lembar Style: 3 kartu, disarankan, form, Generate');
  await p.evaluate((id) => window.najja.openProject(id), source.id);
  await p.waitForFunction((id) => window.najja && document.querySelector('.tool[data-tool="style"]'), source.id);
  await p.click('.tool[data-tool="style"]');
  await p.waitForSelector('.sheet.in .stp-card');
  const ui = await p.evaluate(() => ({
    cards: [...document.querySelectorAll('.sheet.in .stp-card b')].map((x) => x.textContent),
    rec: document.querySelector('.sheet.in .stp-card .stp-rec')?.closest('.stp-card').dataset.st,
    fits: [...document.querySelectorAll('.sheet.in .stp-fit')].map((x) => x.textContent.trim()),
    form: [...document.querySelectorAll('.sheet.in [data-pf]')].map((x) => `${x.dataset.pf}=${x.value}`),
  }));
  check(ui.cards.join(',') === 'Showcase Clean,Editorial Review,Story Pop' && ui.rec === 'storypop', `kartu: ${ui.cards.join(' / ')}; Disarankan: ${ui.rec}; ${ui.fits.join(' / ')}`);
  check(ui.form.includes('name=Travel Bag') && ui.form.includes('price_discount=149rb'), 'form terisi info produk terakhir');
  await p.click('.sheet.in .stp-card[data-st="showcase"]');
  await p.waitForSelector('.sheet.in [data-pf="size"]');
  await p.click('.sheet.in [data-do="go"]');
  for (let t = Date.now(); Date.now() - t < 30000; await wait(300)) { if (await p.evaluate(async () => (await import('/js/store.js')).store.P.style?.id === 'showcase')) break; }
  const gen = await p.evaluate(async () => { const { store } = await import('/js/store.js'); return { style: store.P.style?.id, name: store.P.name, main: store.P.clips.filter((c) => c.trackId === 'main').length }; });
  check(gen.style === 'showcase' && gen.name === 'Review Tas · Showcase Clean' && gen.main >= 4, `Generate dari lembar: "${gen.name}" (${gen.main} klip)`);
  // all three at once, from the original
  await p.evaluate((id) => window.najja.openProject(id), source.id);
  await wait(500);
  await p.evaluate(() => window.najja.openSheet('style'));
  await p.waitForSelector('.sheet.in [data-all]');
  await p.check('.sheet.in [data-all]');
  await p.click('.sheet.in [data-do="go"]');
  for (let t = Date.now(); Date.now() - t < 90000; await wait(500)) { if (!(await p.$('.sheet.in .ac-prog'))) break; }
  const list = await p.evaluate(async () => (await (await fetch('/api/projects', { credentials: 'same-origin' })).json()));
  const names = (Array.isArray(list) ? list : list.projects || []).map((x) => x.name);
  const made = ['Showcase Clean', 'Editorial Review', 'Story Pop'].map((s) => names.filter((n) => n === `Review Tas · ${s}`).length);
  const now = await p.evaluate(async () => (await import('/js/store.js')).store.P.style?.id);
  check(made.every((n) => n >= 2) && now === 'storypop', `"Buat ketiganya": 3 proyek baru dibuat, yang disarankan (${now}) dibuka`);

  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek style lolos');
process.exit(failed ? 1 : 0);
