// End-to-end (v1.11): "Hapus latar otomatis" on a device without WebGPU — the same switch, the analysis done by
// BiRefNet on the server (slower), the masks used by the preview and the export. (The GPU path: test/e2e/cutout.mjs.)
//   A. the switch starts a server job, progress shows, the masks land on the clip
//   B. preview: the object stays, its background goes; a masks file is only for its owner
//   C. a duplicate of the clip uses the same masks (no second analysis); trimming outside them asks to analyse again
//   D. export: the same cut in the video file
// Needs the AI service with its models: NAJJA_AI_MODELS=<folder with birefnet-lite-512.onnx> (and python3 with
// onnxruntime, numpy, pillow), Playwright and ffmpeg. Without NAJJA_AI_MODELS it is skipped.
// With NAJJA_TEST_PERSON=<a video of a person with things around> it uses that instead of the made-up object video.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-cutsrv-1234567890';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg || !process.env.NAJJA_AI_MODELS) {
  console.log(`SKIP cutout-server e2e: ${!chromium ? 'playwright' : !hasFfmpeg ? 'ffmpeg' : 'NAJJA_AI_MODELS (model BiRefNet)'} tidak ada`);
  process.exit(0);
}
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-cutsrv-e2e-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
const PERSON = process.env.NAJJA_TEST_PERSON;
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
if (PERSON) ff(['-ss', '4', '-i', PERSON, '-t', '3', '-vf', 'scale=360:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', path.join(dir, 'media', 'video.mp4')]);
// a plain wall with a detailed "object" (a fractal: a flat colour box is no object to BiRefNet) moving slowly
else ff(['-f', 'lavfi', '-i', 'color=c=0xcfcac2:s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'mandelbrot=s=170x230:r=30', '-filter_complex', "[0][1]overlay=x='90+20*t':y=230:shortest=1",
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir, 'media', 'video.mp4')]);

const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port), NAJJA_AI_URL: '' }, stdio: process.env.NAJJA_E2E_LOG ? ['ignore', fs.openSync(process.env.NAJJA_E2E_LOG, 'a'), fs.openSync(process.env.NAJJA_E2E_LOG, 'a')] : 'ignore' });
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
  await p.fill('#email', 'obj@najja.id'); await p.fill('#password', 'rahasia-obj'); await p.fill('#password2', 'rahasia-obj'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.goto(`${BASE}/?debug`);
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));
  await mcp('new_project', { name: 'Hapus latar (server)', aspect_ratio: '9:16' });
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

  step('A. perangkat tanpa WebGPU: sakelar "Hapus latar otomatis" → dianalisis di server');
  const gpu = await p.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null))));
  check(!gpu, 'Chromium ini tanpa WebGPU (jalur server)');
  await p.click('.tool[data-tool="bgremove"]');
  await p.waitForSelector('.sheet.in [data-do="cutout"]');
  await p.click('.sheet.in .cut-row');
  await p.waitForSelector('.sheet.in .cut-prog', { timeout: 30000 });
  const ui = await p.evaluate(() => ({ modes: document.querySelectorAll('.sheet.in [data-cutmode], .sheet.in [data-cutfps]').length, prog: document.querySelector('.sheet.in .cut-prog span')?.textContent, hint: document.querySelector('.sheet.in').textContent }));
  check(ui.modes === 0 && !!ui.prog && /server/i.test(ui.hint), `satu sakelar tanpa pilihan mode, progres: "${ui.prog}", keterangan menyebut server`);
  let seen = new Set();
  let masks = null;
  const t0 = Date.now();
  for (; Date.now() - t0 < 8 * 60_000; await wait(1000)) {
    const st = await p.evaluate(async (id) => { const c = (await import('/js/store.js')).store.clip(id); return { masks: c.cutout?.masks || null, txt: document.querySelector('.sheet.in .cut-prog span')?.textContent || '' }; }, ov);
    if (st.txt) seen.add(st.txt.replace(/\d+/g, '#'));
    if (st.masks) { masks = st.masks; break; }
  }
  if (!masks) {
    const diag = await p.evaluate(async (id) => { const c = (await import('/js/store.js')).store.clip(id); const j = c.cutout?.job?.id; return j ? (await fetch(`/api/ai/${j}`)).json() : c.cutout; }, ov);
    console.log('diag job:', JSON.stringify(diag).slice(0, 600));
    console.log('diag jobs:', JSON.stringify(await (await fetch(`${BASE}/api/jobs`, { headers: { authorization: `Bearer ${TOKEN}` } }).catch(() => ({ json: () => null }))).json?.() || null).slice(0, 600));
  }
  check(!!masks && masks.n >= 20 && masks.fps === 15, `masker dari server: ${masks?.n} frame, ${masks?.fps} fps, ${masks?.w}×${masks?.h}, model ${masks?.model} (${Math.round((Date.now() - t0) / 1000)} dtk)`);
  check([...seen].some((x) => /Menganalisis video · frame #\/#/.test(x)), `progres per frame terlihat (${[...seen].filter((x) => /frame/.test(x)).slice(-1)[0] || [...seen].join(' / ')})`);
  if (masks) {
    const ready = await p.evaluate(() => document.querySelector('.sheet.in .hint.ok')?.textContent);
    check(/Latar dihapus/.test(ready || ''), `lembar: "${ready}"`);

    step('B. pratinjau: objeknya tetap, latarnya hilang');
    await p.evaluate(() => window.najja.sheet?.close?.());
    const look = (t = 1) => p.evaluate(async (t) => {
      const c = await window.najja.engine.capture(t, 180);
      const x = c.getContext('2d', { willReadFrequently: true });
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const frac = (x0, y0, x1, y1, f) => { let n = 0; let k = 0; for (let y = Math.floor(y0 * c.height); y < y1 * c.height; y++) for (let xx = Math.floor(x0 * c.width); xx < x1 * c.width; xx++) { const i = (y * c.width + xx) * 4; n++; if (f(d[i], d[i + 1], d[i + 2])) k++; } return k / Math.max(1, n); };
      const blue = (r, g, b) => b > 180 && r < 60 && g < 60;
      return { bgBlue: frac(0, 0, 1, 0.25, blue), objKept: 1 - frac(0.42, 0.42, 0.62, 0.62, blue), centreBlue: frac(0.4, 0.35, 0.6, 0.65, blue) };
    }, t);
    const L = await look();
    if (PERSON) check(L.bgBlue > 0.6 && L.centreBlue < 0.4, `latar hilang (biru di atas ${(L.bgBlue * 100).toFixed(0)}%), orang & barang di tengah tetap (biru ${(L.centreBlue * 100).toFixed(0)}%)`);
    else check(L.bgBlue > 0.8 && L.objKept > 0.8, `latar hilang (biru di atas ${(L.bgBlue * 100).toFixed(0)}%), objeknya tetap (${(L.objKept * 100).toFixed(0)}% tidak tembus)`);
    const other = await fetch(`${BASE}/api/masks/${masks.id}`);
    check(other.status === 401 || other.status === 302 || other.status === 404, `berkas masker hanya untuk pemiliknya (tanpa login: HTTP ${other.status})`);

    step('C. duplikat memakai masker yang sama; dipotong di luar rentang → minta analisis ulang');
    const dup = await p.evaluate(async (id) => {
      const a = await import('/js/actions.js');
      const { store } = await import('/js/store.js');
      const d = a.duplicateClip(id);
      const did = d.id || d;
      const bg = await import('/js/bgremove.js');
      const r = await bg.startBgRemove(did);
      const same = store.clip(did).cutout.masks?.id === store.clip(id).cutout.masks?.id;
      store.mutate('t', () => { store.clip(did).in = 2.6; });
      const stale = bg.bgStale(store.clip(did));
      a.deleteClips([did]);
      return { reused: !!r.reused, same, stale };
    }, ov);
    check(dup.reused && dup.same && dup.stale, 'duplikat memakai masker yang sama tanpa analisis baru; bagian video di luar masker terdeteksi (Analisis ulang)');

    step('D. ekspor: potongan yang sama di video hasil');
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
    check(blueTop / 3600 > 0.6, `ekspor (${ex.mode}): latar hilang di video hasil (biru di atas ${((blueTop / 3600) * 100).toFixed(0)}%)`);
  }
  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek hapus latar (server) lolos');
process.exit(failed ? 1 : 0);
