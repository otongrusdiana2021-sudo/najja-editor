// End-to-end (v1.12): Teks kinetik — words / letters that move on their own with spring motion, in the editor.
//   A. MCP: add_text with text_motion; get_project shows it; a bad value is refused
//   B. the picture: the words come in one after another (few at the start, all of them later); karaoke lights the
//      word being said in its colour
//   C. the panel: Animasi → Kinetik, a tile sets it, the controls follow, "Tidak ada" turns it off
//   D. auto captions (linked): every line gets the animation, each keeps its own word times
//   E. export: the same motion in the video file
// Needs Playwright and ffmpeg. Run: node test/e2e/kinetic.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-kinetic-1234567890';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) { console.log(`SKIP kinetic e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`); process.exit(0); }
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-kinetic-e2e-'));
const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port), NAJJA_AI: 'off', NAJJA_AI_URL: '' }, stdio: 'ignore' });
let cleaned = false;
const cleanup = () => { if (cleaned) return; cleaned = true; try { server.kill(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); };
process.on('exit', cleanup);
process.on('unhandledRejection', (err) => { console.error('FAIL ', err); cleanup(); process.exit(1); });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await wait(100); }
const mcpRaw = async (name, args = {}) => {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
};
const mcp = async (name, args = {}) => {
  const res = await mcpRaw(name, args);
  if (!res || res.isError) throw new Error(JSON.stringify(res));
  return JSON.parse(res.content.find((c) => c.type === 'text').text);
};

const browser = await chromium.launch();
try {
  const p = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'kin@najja.id'); await p.fill('#password', 'rahasia-kin'); await p.fill('#password2', 'rahasia-kin'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.goto(`${BASE}/?debug`);
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));
  await mcp('new_project', { name: 'Teks kinetik', aspect_ratio: '9:16' });
  await mcp('add_solid', { color: '#123456', duration: 4 });

  step('A. MCP');
  const t1 = await mcp('add_text', { text: 'SATU DUA TIGA EMPAT', start: 0, duration: 3, size: 110, color: '#ffffff', text_motion: 'wordPop', text_motion_spring: 'snappy', text_motion_stagger: 0.3 });
  check(t1.text_motion?.type === 'wordPop' && t1.text_motion.spring === 'snappy' && t1.text_motion.stagger === 0.3, `add_text: text_motion ${JSON.stringify(t1.text_motion)}`);
  const bad = await mcpRaw('update_clip', { clip_id: t1.id, text_motion: 'meledak' });
  check(bad?.isError && /Unknown text_motion/.test(JSON.stringify(bad)), 'nilai yang tidak dikenal ditolak dengan daftar yang benar');

  step('B. gambar: kata masuk satu-satu');
  // white pixels of the text (the solid is dark blue)
  const white = (t) => p.evaluate(async (t) => {
    const c = await window.najja.engine.capture(t, 270);
    const x = c.getContext('2d', { willReadFrequently: true });
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 220 && d[i + 2] > 220) n++;
    return n;
  }, t);
  const w0 = await white(0.05);
  const w1 = await white(0.45);
  const w2 = await white(2.5);
  check(w0 < w2 * 0.35 && w1 > w0 && w1 < w2 * 0.85 && w2 > 300, `jumlah piksel teks: 0,05 dtk ${w0} → 0,45 dtk ${w1} → 2,5 dtk ${w2}`);
  await mcp('update_clip', { clip_id: t1.id, text_motion: 'karaoke', text_motion_color: '#00ff00' });
  const green = await p.evaluate(async () => {
    const c = await window.najja.engine.capture(1.0, 270);
    const x = c.getContext('2d', { willReadFrequently: true });
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 200 && d[i] < 80 && d[i + 2] < 80) n++;
    return n;
  });
  check(green > 40, `karaoke: kata yang sedang aktif menyala hijau (${green} piksel)`);
  const P1 = await mcp('get_project');
  check(P1.clips.find((c) => c.id === t1.id)?.text_motion?.color === '#00ff00', 'get_project menampilkan text_motion');

  step('C. panel Animasi → Kinetik');
  await p.evaluate((id) => import('/js/store.js').then(({ store }) => store.select(id)), t1.id);
  await p.click('.tool[data-tool="text-anim"]');
  await p.waitForSelector('.sheet.in [data-animtab="kin"]');
  await p.click('.sheet.in [data-animtab="kin"]');
  await p.waitForSelector('.sheet.in [data-kin="charDrop"]');
  const tiles = await p.evaluate(() => [...document.querySelectorAll('.sheet.in [data-kin]')].length);
  check(tiles >= 17, `${tiles} pilihan animasi kinetik dengan pratinjau`);
  await p.click('.sheet.in [data-kin="charDrop"]');
  await p.waitForSelector('.sheet.in [data-kspring]');
  await p.click('.sheet.in [data-kout="reverse"]');
  const st = await p.evaluate(async (id) => { const { store } = await import('/js/store.js'); const m = store.clip(id).text.motion; return { m, ctl: !!document.querySelector('.sheet.in [data-path="text.motion.stagger"]'), dot: document.querySelector('.sheet.in [data-animtab="kin"]').textContent }; }, t1.id);
  check(st.m?.type === 'charDrop' && st.m.out === 'reverse' && st.m.spring === 'bouncy' && st.ctl && /•/.test(st.dot), `ketuk "Huruf jatuh" + Keluar "Kebalikan": ${JSON.stringify(st.m)}`);
  // (only tiles on screen are drawn)
  await p.evaluate(() => document.querySelector('.sheet.in canvas[data-prev="kin:charDrop"]').scrollIntoView({ block: 'center' }));
  await wait(900);
  const hasPrev = await p.evaluate(() => { const c = document.querySelector('.sheet.in canvas[data-prev="kin:charDrop"]'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230) n++; return n; });
  check(hasPrev > 20, `pratinjau kecil memutar animasinya (${hasPrev} piksel teks)`);
  await p.click('.sheet.in [data-kin="none"]');
  const off = await p.evaluate(async (id) => (await import('/js/store.js')).store.clip(id).text.motion ?? null, t1.id);
  check(off === null, '"Tidak ada" mematikannya');
  await p.evaluate(() => window.najja.sheet?.close?.());

  step('D. subtitle tertaut');
  const subs = await mcp('add_subtitles', {
    items: [
      { start: 0.2, end: 1.6, text: 'Tas ini muat laptop', words: [[0.2, 0.4], [0.45, 0.6], [0.7, 1.0], [1.05, 1.5]] },
      { start: 1.7, end: 3.0, text: 'dan anti air', words: [[1.7, 1.9], [2.0, 2.3], [2.4, 2.9]] },
    ],
    text_motion: 'karaoke',
  });
  const lines = await p.evaluate(async (ids) => { const { store } = await import('/js/store.js'); return ids.map((id) => ({ m: store.clip(id).text.motion?.type, w: store.clip(id).text.words })); }, subs.clip_ids);
  check(subs.lines_timed_to_speech === 2 && lines.every((l) => l.m === 'karaoke') && lines[0].w[1][0] === 0.25 && lines[1].w[0][0] === 0, `add_subtitles kinetik: tiap baris punya waktu katanya sendiri (${JSON.stringify(lines.map((l) => l.w[0]))})`);
  // one line changed in the panel: the other follows (linked), its word times stay its own
  await p.evaluate((id) => import('/js/store.js').then(({ store }) => store.select(id)), subs.clip_ids[0]);
  await p.click('.tool[data-tool="text-anim"]');
  await p.waitForSelector('.sheet.in [data-animtab="kin"]');
  await p.click('.sheet.in [data-animtab="kin"]');
  await p.waitForSelector('.sheet.in [data-kin="wordPop"]');
  await p.click('.sheet.in [data-kin="wordPop"]');
  const linked = await p.evaluate(async (ids) => { const { store } = await import('/js/store.js'); return ids.map((id) => ({ m: store.clip(id).text.motion?.type, w0: store.clip(id).text.words?.[0]?.[0] })); }, subs.clip_ids);
  check(linked.every((l) => l.m === 'wordPop') && linked[0].w0 === 0 && linked[1].w0 === 0, `subtitle tertaut ikut berubah, waktu kata tetap milik barisnya (${JSON.stringify(linked)})`);
  await p.evaluate(() => window.najja.sheet?.close?.());
  // only the big text from now on
  await p.evaluate(async (ids) => { const a = await import('/js/actions.js'); a.deleteClips(ids); }, subs.clip_ids);
  await mcp('update_clip', { clip_id: t1.id, text_motion: 'wordPop', text_motion_stagger: 0.3 });

  step('E. ekspor');
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
  const whiteAt = (t) => {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=270:480', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    let n = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 220 && raw[i + 1] > 220 && raw[i + 2] > 220) n++;
    return n;
  };
  const e0 = whiteAt(0.07);
  const e2 = whiteAt(2.5);
  check(e0 < e2 * 0.35 && e2 > 300, `ekspor (${ex.mode}): kata masuk satu-satu juga di video hasil (${e0} → ${e2} piksel)`);
  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek teks kinetik lolos');
process.exit(failed ? 1 : 0);
