// End-to-end (v1.11): "Hapus latar otomatis" on the device's GPU — one switch, the background goes, every object in
// front stays; the clip is analysed once and the masks are kept on the server.
//   A. the sheet: one switch (no modes), the analysis runs with progress (onnxruntime-web, WebGPU)
//   B. preview: the object stays, the background goes
//   C. the masks are on the server: after a reload the clip is still cut out
//   D. MCP remove_background false / true (the masks are used again: no new analysis); trimming outside them asks
//      for "Analisis ulang"
//   E. export: the same cut in the video file
// The real model (BiRefNet, ±190 MB) is replaced by a tiny stand-in (test/fixtures/bg-test-model.onnx: "colourful =
// object") so the GPU work takes seconds here; onnxruntime-web is the real one, fetched by the server (/vendor).
// Needs Playwright (Chromium with WebGPU: --enable-unsafe-webgpu), ffmpeg and network access for the first download.
// The server path (no WebGPU) is test/e2e/cutout-server.mjs. Run: node test/e2e/cutout.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-cutout-1234567890';
const TINY = path.join(ROOT, 'test', 'fixtures', 'bg-test-model.onnx');
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
// a plain grey wall and an orange box (the "product") moving slowly
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xcfcac2:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=0xe0602a:s=170x230:r=30:d=3',
  '-filter_complex', "[0][1]overlay=x='80+20*t':y=230:shortest=1",
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dir, 'media', 'video.mp4')]);
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
  return JSON.parse(j.result.content.find((c) => c.type === 'text').text);
};

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  let modelRequests = 0;
  await ctx.route('**/vendor/birefnet-512/model.onnx', (route) => { modelRequests++; route.fulfill({ status: 200, body: fs.readFileSync(TINY), contentType: 'application/octet-stream' }); });
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
  const gpu = await p.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())));
  if (!gpu) { console.log('SKIP  WebGPU tidak tersedia di Chromium ini'); process.exit(0); }
  await mcp('new_project', { name: 'Hapus latar', aspect_ratio: '9:16' });
  const media = await mcp('import_media', { path: 'video.mp4' });
  for (let t = Date.now(); Date.now() - t < 60000; await wait(250)) {
    if (await p.evaluate(async (id) => { const { mediaRT } = await import('/js/media.js'); return !!mediaRT.get(id)?.url; }, media.media_id)) break;
  }
  // blue under, the video over it (full frame), 2 s of it
  const ov = await p.evaluate(async (mid) => {
    const a = await import('/js/actions.js');
    const { store } = await import('/js/store.js');
    a.addSolid({ color: '#0000ff', track: 'main', duration: 2 });
    const c = a.addMediaClip(mid, { track: 'overlay', start: 0, duration: 2 });
    const id = c.id || c;
    const m = store.media(mid);
    store.mutate('t', () => { store.clip(id).scale = Math.max(1080 / m.width, 1920 / m.height) / Math.min(1080 / m.width, 1920 / m.height); });
    store.select(id);
    window.najja.engine.seek(1);
    return id;
  }, media.media_id);
  const look = () => p.evaluate(async () => {
    const c = await window.najja.engine.capture(1, 180);
    const x = c.getContext('2d', { willReadFrequently: true });
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const frac = (x0, y0, x1, y1, f) => { let n = 0; let k = 0; for (let y = Math.floor(y0 * c.height); y < y1 * c.height; y++) for (let xx = Math.floor(x0 * c.width); xx < x1 * c.width; xx++) { const i = (y * c.width + xx) * 4; n++; if (f(d[i], d[i + 1], d[i + 2])) k++; } return k / Math.max(1, n); };
    const blue = (r, g, b) => b > 180 && r < 60 && g < 60;
    const orange = (r, g, b) => r > 180 && g > 60 && g < 140 && b < 90;
    // (at 1 s the box spans x 100–270 of 360, y 230–460 of 640)
    return { bgBlue: frac(0, 0, 1, 0.25, blue), boxOrange: frac(0.36, 0.42, 0.66, 0.66, orange) };
  });
  const before = await look();

  step('A. lembar "Hapus latar belakang": satu sakelar, analisis di GPU perangkat');
  await p.click('.tool[data-tool="bgremove"]');
  await p.waitForSelector('.sheet.in [data-do="cutout"]');
  const sheet = await p.evaluate(() => document.querySelector('.sheet.in').textContent);
  check(!/Segera hadir|Orang saja|Orang \+ objek|Kualitas/.test(sheet) && /Hapus latar otomatis/.test(sheet) && /Kunci kroma/.test(sheet), 'lembar ala CapCut: satu sakelar "Hapus latar otomatis" + Kunci kroma (tanpa pilihan mode)');
  const t0 = Date.now();
  await p.click('.sheet.in .cut-row');
  const startTwice = () => p.evaluate(async (id) => {
    const bg = await import('/js/bgremove.js');
    const a = await import('/js/actions.js');
    const { store } = await import('/js/store.js');
    const again = await bg.startBgRemove(id);
    const d = a.duplicateClip(id);
    const did = d.id || d;
    store.mutate('t', () => { store.clip(did).cutout = null; });
    const dup = await bg.startBgRemove(did);
    const shared = bg.bgStatus(store.clip(did))?.state;
    return { again, dup, shared, did };
  }, ov);
  let twice = null;
  const seen = new Set();
  let masks = null;
  for (; Date.now() - t0 < 4 * 60_000; await wait(300)) {
    const st = await p.evaluate(async (id) => { const c = (await import('/js/store.js')).store.clip(id); return { masks: c.cutout?.masks || null, txt: document.querySelector('.sheet.in .cut-prog span')?.textContent || '' }; }, ov);
    if (st.txt) seen.add(st.txt.replace(/\d+/g, '#'));
    if (st.masks) { masks = st.masks; break; }
    // tapped twice / a duplicate switched on meanwhile (while frames are analysed): still one analysis
    if (!twice && /frame/.test(st.txt)) twice = await startTwice();
  }
  const secs = (Date.now() - t0) / 1000;
  check(!!masks && masks.n >= 60 && masks.fps === 30 && masks.model === 'birefnet-lite-512', `masker: ${masks?.n} frame (${masks?.fps} fps, ${masks?.w}×${masks?.h}, ${masks?.model}) dalam ${secs.toFixed(1)} dtk`);
  check([...seen].some((x) => /Menganalisis video · frame #\/#/.test(x)), `progres per frame terlihat (${[...seen].filter((x) => /frame/.test(x)).slice(-1)[0] || [...seen].join(' / ')})`);
  check(modelRequests === 1, `model diambil sekali (${modelRequests}×) lewat /vendor`);
  const dupMasks = twice ? await p.evaluate(async (id) => (await import('/js/store.js')).store.clip(id)?.cutout?.masks?.id, twice.did) : null;
  check(twice?.again?.running && twice.dup?.running && twice.shared === 'running' && !!masks && dupMasks === masks.id,
    'diketuk dua kali / duplikat dinyalakan saat analisis berjalan: tetap satu analisis, duplikatnya ikut mendapat hasilnya');
  if (twice) await p.evaluate(async (id) => { const a = await import('/js/actions.js'); a.deleteClips([id]); }, twice.did);
  // (the sheet again, for the selected clip)
  await p.evaluate((id) => import('/js/store.js').then(({ store }) => store.select(id)), ov);
  if (!(await p.$('.sheet.in [data-do="cutout"]'))) { await p.click('.tool[data-tool="bgremove"]'); await p.waitForSelector('.sheet.in [data-do="cutout"]'); }
  const ortCache = await p.evaluate(async () => (await fetch('/vendor/onnxruntime-1.29.0/ort.webgpu.min.mjs', { method: 'HEAD' })).headers.get('cache-control'));
  check(/immutable/.test(ortCache || ''), `onnxruntime-web disajikan server Najja sendiri (${ortCache})`);

  if (masks) {
    step('B. pratinjau: objeknya tetap, latarnya hilang');
    const ready = await p.evaluate(() => document.querySelector('.sheet.in .hint.ok')?.textContent);
    check(/Latar dihapus/.test(ready || ''), `lembar: "${ready}"`);
    const L = await look();
    check(before.bgBlue < 0.05 && before.boxOrange > 0.8 && L.bgBlue > 0.85 && L.boxOrange > 0.8, `latar hilang (biru di atas ${(before.bgBlue * 100).toFixed(0)}% → ${(L.bgBlue * 100).toFixed(0)}%), kotak oranye tetap (${(L.boxOrange * 100).toFixed(0)}%)`);

    step('C. masker tersimpan di server: dimuat ulang, klip tetap terpotong');
    const owner = await (await fetch(`${BASE}/api/masks/${masks.id}`)).status;
    check(owner === 401 || owner === 404 || owner === 302, `berkas masker hanya untuk pemiliknya (tanpa login: HTTP ${owner})`);
    await p.reload();
    await p.waitForSelector('body.ready');
    await p.waitForFunction(() => window.najja?.engine);
    for (let t = Date.now(); Date.now() - t < 30000; await wait(300)) { if (await p.evaluate(async (id) => !!(await import('/js/store.js')).store.clip(id), ov)) break; }
    await p.evaluate((id) => import('/js/store.js').then(({ store }) => store.select(id)), ov);
    const L2 = await look();
    check(L2.bgBlue > 0.85 && L2.boxOrange > 0.8, `setelah dimuat ulang (masker dari server): latar tetap hilang (${(L2.bgBlue * 100).toFixed(0)}%), objek tetap (${(L2.boxOrange * 100).toFixed(0)}%)`);

    step('D. MCP dan analisis ulang');
    const off = await mcp('update_clip', { clip_id: ov, remove_background: false });
    const offLook = await look();
    const again = await mcp('update_clip', { clip_id: ov, remove_background: true, remove_background_threshold: 0.6 });
    const reused = await p.evaluate(async (id) => (await import('/js/store.js')).store.clip(id).cutout?.masks?.id, ov);
    check(!off.remove_background && offLook.bgBlue < 0.05 && again.remove_background?.ready && again.remove_background.threshold === 0.6 && reused === masks.id,
      'MCP: false → latar kembali; true → langsung siap memakai masker yang sama (tanpa analisis baru), ketelitian 0.6');
    // a clip from v1.10.3 ("Orang saja": switched on, no analysis): get_project says so, true starts it
    const old = await p.evaluate(async (id) => {
      const a = await import('/js/actions.js');
      const { store } = await import('/js/store.js');
      const d = a.duplicateClip(id);
      const did = d.id || d;
      store.mutate('t', () => { store.clip(did).cutout = { enabled: true, mode: 'person', threshold: 0.5, edge: 0.2 }; });
      return did;
    }, ov);
    const P = await mcp('get_project');
    const oldSum = P.clips.find((x) => x.id === old)?.remove_background;
    const oldOn = await mcp('update_clip', { clip_id: old, remove_background: true });
    check(oldSum?.needs_analysis && !oldSum.analysing && oldOn.remove_background?.ready, `klip dari versi lama: get_project → needs_analysis, lalu true → siap (${JSON.stringify(oldSum)})`);
    await p.evaluate(async (id) => { const a = await import('/js/actions.js'); a.deleteClips([id]); }, old);
    await p.evaluate(async (id) => { const { store } = await import('/js/store.js'); store.mutate('t', () => { store.clip(id).in = 0.9; }); store.select(id); }, ov);
    await p.click('.tool[data-tool="bgremove"]');
    await p.waitForSelector('.sheet.in [data-do="cutout"]');
    const stale = await p.evaluate(() => !!document.querySelector('.sheet.in [data-do="cutRedo"]'));
    check(stale, 'klip digeser ke bagian video yang belum dianalisis → tombol "Analisis ulang"');
    await p.evaluate(async (id) => { const { store } = await import('/js/store.js'); store.mutate('t', () => { store.clip(id).in = 0; }); }, ov);
    await p.evaluate(() => window.najja.sheet?.close?.());

    step('E. ekspor: potongan yang sama di video hasil');
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
    let blueTop = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 90; x++) { const i = (y * 90 + x) * 3; if (raw[i + 2] > 170 && raw[i] < 70 && raw[i + 1] < 70) blueTop++; }
    let orange = 0;
    for (let y = 70; y < 105; y++) for (let x = 35; x < 60; x++) { const i = (y * 90 + x) * 3; if (raw[i] > 170 && raw[i + 1] > 50 && raw[i + 1] < 150 && raw[i + 2] < 100) orange++; }
    check(blueTop / 3600 > 0.8 && orange / 875 > 0.8, `ekspor (${ex.mode}): latar hilang di video hasil (biru di atas ${((blueTop / 3600) * 100).toFixed(0)}%), kotak oranye tetap (${((orange / 875) * 100).toFixed(0)}%)`);
  }
  if (masks) {
    step('F. GPU perangkat gagal memuat model → pesan jelas, salinan model yang rusak tidak disimpan');
    await p.route('**/vendor/birefnet-512/model.onnx', (route) => route.fulfill({ status: 200, body: Buffer.alloc(4096, 7), contentType: 'application/octet-stream' }));
    await p.evaluate(async () => { await caches.delete('najja-models-v1'); });
    await p.reload();
    await p.waitForSelector('body.ready');
    await p.waitForFunction(() => window.najja?.engine);
    const nc = await p.evaluate(async (mid) => {
      for (let t = Date.now(); Date.now() - t < 20000; await new Promise((r) => setTimeout(r, 200))) { if ((await import('/js/store.js')).store.P?.clips?.length) break; }
      const a = await import('/js/actions.js');
      const { store } = await import('/js/store.js');
      const c = a.addMediaClip(mid, { track: 'overlay', start: 4, duration: 2 });
      const id = c.id || c;
      store.mutate('t', () => { store.clip(id).in = 0.9; });
      store.select(id);
      return id;
    }, media.media_id);
    await p.click('.tool[data-tool="bgremove"]');
    await p.waitForSelector('.sheet.in [data-do="cutout"]');
    await p.click('.sheet.in .cut-row');
    await p.waitForSelector('.sheet.in .hint.warn, .toast', { timeout: 60000 });
    const fail = await p.evaluate(async (id) => ({
      sheet: document.querySelector('.sheet.in .hint.warn')?.textContent || '',
      retry: !!document.querySelector('.sheet.in [data-do="cutRedo"]'),
      cached: !!(await (await caches.open('najja-models-v1')).match('/vendor/birefnet-512/model.onnx')),
      masks: !!(await import('/js/store.js')).store.clip(id)?.cutout?.masks,
    }), nc);
    check(/tidak bisa dijalankan di GPU perangkat ini/.test(fail.sheet) && fail.retry && !fail.cached && !fail.masks, `pesan di lembar: "${fail.sheet.slice(0, 90)}…" + Coba lagi; model rusak tidak disimpan di perangkat`);
    await p.click('.sheet.in [data-do="cutRedo"]');
    await p.waitForSelector('.toast', { timeout: 20000 });
    const why = await p.evaluate(async (id) => ({ toast: [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' | '), on: !!(await import('/js/store.js')).store.clip(id)?.cutout?.enabled }), nc);
    check(/GPU perangkat ini gagal/.test(why.toast) && /layanan AI di server/.test(why.toast) && !why.on, `Coba lagi tanpa GPU dan tanpa layanan AI server: "${why.toast.slice(0, 120)}…", sakelar mati`);
  }
  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek hapus latar lolos');
process.exit(failed ? 1 : 0);
