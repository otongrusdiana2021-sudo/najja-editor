// End-to-end (v1.8): the home screen. Starts there; new project → editor; X → home; ?p= reload; rename, duplicate,
// delete (one, several, the open one); an AI (MCP) tool from the home screen; the AI tools (background removal,
// upscaling) when the model files are available (NAJJA_AI_MODELS); layout on iPad portrait/landscape and a phone.
// Needs Playwright (with Chromium) and ffmpeg. Run: npm run test:e2e
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-home-1234567890';
const MODELS = process.env.NAJJA_AI_MODELS || '';
const hasModels = !!MODELS && ['birefnet-lite-512.onnx', 'real_esrgan_general_x4v3.onnx'].every((f) => fs.existsSync(path.join(MODELS, f)));
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) {
  console.log(`SKIP home e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`);
  process.exit(0);
}
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-home-e2e-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir, 'media', 'klip.mp4')]);
const photo = path.join(dir, 'tas.png');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xe8e2d8:s=300x380,drawbox=x=80:y=130:w=140:h=160:color=0x4a2a1a:t=fill', '-frames:v', '1', photo]);
const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port), NAJJA_AI_URL: '', ...(MODELS ? { NAJJA_AI_MODELS: MODELS } : {}) }, stdio: 'ignore' });
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
  const ctx = await browser.newContext({ viewport: { width: 834, height: 1194 }, hasTouch: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'home@najja.id'); await p.fill('#password', 'rahasia-home'); await p.fill('#password2', 'rahasia-home'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  const S = (fn, arg) => p.evaluate(async ([src, a]) => { const { store } = await import('/js/store.js'); return (0, eval)(src)(store, a); }, [fn.toString(), arg]);
  const homeShown = () => p.evaluate(() => !document.getElementById('home').hidden);
  const serverList = () => p.evaluate(async () => (await fetch('/api/projects')).json());
  const cards = () => p.$$eval('.hm-card:not(.skel)', (c) => c.map((x) => ({ id: x.dataset.id, name: x.querySelector('.hm-name')?.textContent, meta: x.querySelector('.hm-meta span')?.textContent })));

  step('mulai dari beranda');
  check(await homeShown(), 'aplikasi dibuka di beranda');
  check(!(await p.evaluate(() => location.search.includes('p='))), 'alamat tanpa ?p=');
  check((await p.textContent('.hm-empty'))?.includes('Belum ada proyek'), 'akun baru: pesan "belum ada proyek"');
  check(await p.isVisible('[data-tool=cutout]') && await p.isVisible('[data-tool=upscale]'), 'alat: Hapus latar belakang & Upscale gambar');
  check((await p.$$('.hm-tool')).length === 2, 'hanya dua alat');
  check((await serverList()).length === 0, 'belum ada proyek tersimpan (proyek kosong di belakang beranda tidak disimpan)');

  step('Proyek baru → editor');
  await p.click('[data-new]');
  await p.fill('.np-name', 'Tas polkadot');
  await p.click('.ratio-chip:has-text("9:16")');
  await p.click('.modal [data-go]');
  await p.waitForFunction(() => document.getElementById('home').hidden);
  await p.keyboard.press('Escape'); // the media sheet that opens for a new project
  const id1 = await S((store) => store.P.id);
  check(await p.evaluate((id) => new URLSearchParams(location.search).get('p') === id, id1), 'alamat berisi ?p=<proyek>');
  await p.waitForFunction(async () => (await (await fetch('/api/projects')).json()).length === 1, null, { timeout: 8000 }).catch(() => {});
  check((await serverList()).some((x) => x.id === id1 && x.name === 'Tas polkadot'), 'proyek tersimpan di server');
  await mcp('import_media', { path: 'klip.mp4' }).then((m) => mcp('add_media_clip', { media_id: m.media_id }));
  await wait(1500);

  step('X → beranda');
  await p.click('[data-tb=close]');
  await p.waitForSelector('#home:not([hidden]) .hm-card:not(.skel)');
  let list = await cards();
  check(list.length === 1 && list[0].name === 'Tas polkadot', `kartu proyek tampil (${list.map((c) => c.name).join(', ')})`);
  check(/\d+(MB|KB)\s*\|\s*00:0\d/.test(list[0].meta || ''), `ukuran | durasi: "${list[0].meta}"`);
  check(await p.$('.hm-card.current') != null, 'proyek yang terbuka ditandai');
  check(await p.$eval('.hm-card .hm-thumb img', (i) => i.naturalWidth >= 300).catch(() => false), 'thumbnail tajam (≥ 300 px)');

  step('reload dengan ?p= → langsung ke editor');
  await p.goto(`${BASE}/?p=${id1}`);
  await p.waitForSelector('body.ready');
  check(!(await homeShown()) && (await S((store) => store.P.id)) === id1, 'editor membuka proyek itu');
  await p.click('[data-tb=close]');
  await p.waitForSelector('#home:not([hidden]) .hm-card:not(.skel)');

  step('ganti nama, duplikat');
  await p.click(`.hm-card[data-id="${id1}"] [data-more]`);
  await p.click('.ctx-menu button:has-text("Ganti nama")');
  await p.fill('.pn-name', 'Tas polkadot coklat');
  await p.click('.modal [data-ok]');
  await wait(800);
  check((await serverList()).find((x) => x.id === id1)?.name === 'Tas polkadot coklat', 'nama baru tersimpan');
  check((await cards())[0]?.name === 'Tas polkadot coklat', 'nama baru di kartu');
  await p.click(`.hm-card[data-id="${id1}"] [data-more]`);
  await p.click('.ctx-menu button:has-text("Duplikat")');
  await p.waitForFunction(() => document.querySelectorAll('.hm-card:not(.skel)').length === 2);
  list = await cards();
  const dup = list.find((c) => c.id !== id1);
  check(dup?.name === 'Tas polkadot coklat (salinan)', `duplikat: ${dup?.name}`);

  step('buka duplikat, kembali, hapus beberapa sekaligus');
  await p.click(`.hm-card[data-id="${dup.id}"] [data-open]`);
  await p.waitForFunction(() => document.getElementById('home').hidden);
  check((await S((store) => store.P.id)) === dup.id && (await S((store) => store.P.clips.length)) >= 1, 'duplikat terbuka dengan klipnya');
  await p.click('[data-tb=close]');
  await p.waitForSelector('#home:not([hidden]) .hm-card:not(.skel)');
  await mcp('new_project', { name: 'Coba hapus' });
  await p.click('[data-tb=close]');
  await p.waitForFunction(() => document.querySelectorAll('.hm-card:not(.skel)').length === 3);
  await p.click('[data-select]');
  check(await p.isVisible('.hm-selbar'), 'mode pilih: bilah hapus muncul');
  const del = (await cards()).filter((c) => c.id !== id1).map((c) => c.id);
  for (const id of del) await p.click(`.hm-card[data-id="${id}"] [data-open]`);
  check((await p.textContent('.hm-selcount')).includes('2'), '2 dipilih');
  await p.click('[data-seldel]');
  await p.click('.modal [data-yes]');
  await p.waitForFunction(() => document.querySelectorAll('.hm-card:not(.skel)').length === 1);
  check((await serverList()).length === 1, 'dua proyek terhapus di server');
  check(!(await S((store, ids) => ids.includes(store.P.id), del)), 'proyek yang terbuka ikut terhapus: editor tidak memegangnya lagi');

  step('perintah AI (MCP) saat di beranda → editor dengan proyek terakhir');
  const got = await mcp('get_project');
  check(got.name === 'Tas polkadot coklat' && (await S((store) => store.P.id)) === id1, `AI bekerja di proyek terakhir, bukan proyek kosong (${got.name})`);
  check(!(await homeShown()), 'editor ditampilkan untuk AI');
  await p.click('[data-tb=close]');
  await p.waitForSelector('#home:not([hidden]) .hm-card:not(.skel)');

  step('alat AI');
  await p.click('[data-tool=cutout]');
  await p.waitForSelector('.ai-panel.in');
  check((await p.textContent('.ai-head h2')) === 'Hapus latar belakang', 'panel Hapus latar belakang terbuka');
  if (hasModels) {
    await p.waitForFunction(() => !document.querySelector('[data-pick]')?.disabled, null, { timeout: 30000 });
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-pick]')]);
    await chooser.setFiles(photo);
    await p.waitForSelector('.ai-compare', { timeout: 120000 });
    check(/300×380/.test(await p.textContent('.ai-info')), `hasil: ${(await p.textContent('.ai-info')).trim()}`);
    check(await p.$eval('.ai-compare img.ai-after', (i) => i.naturalWidth === 300), 'gambar hasil dimuat');
    await p.click('[data-add]');
    await p.waitForSelector('.modal [data-pick]');
    await p.click(`.modal [data-pick="${id1}"]`);
    await p.waitForFunction(() => document.getElementById('home').hidden && !document.querySelector('.ai-panel'), null, { timeout: 15000 });
    await p.waitForFunction(async () => { const { store } = await import('/js/store.js'); return store.P.media.some((m) => m.type === 'image' && /tanpa-latar/.test(m.name)); }, null, { timeout: 30000 });
    check(true, 'hasil masuk ke media proyek, editor terbuka di proyek itu');
    await p.click('[data-tb=close]');
    await p.waitForSelector('#home:not([hidden])');
    await p.click('[data-tool=upscale]');
    await p.waitForSelector('.ai-panel.in');
    await p.click('[data-scale="2"]');
    await p.waitForFunction(() => !document.querySelector('[data-pick]')?.disabled, null, { timeout: 30000 });
    const [ch2] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-pick]')]);
    await ch2.setFiles(photo);
    await p.waitForSelector('.ai-compare', { timeout: 120000 });
    check(/300×380 → 600×760/.test(await p.textContent('.ai-info')), `upscale 2×: ${(await p.textContent('.ai-info')).trim()}`);
    await p.click('[data-back]');
  } else {
    console.log('·  (model AI tidak ada: set NAJJA_AI_MODELS untuk menguji hapus latar & upscale di browser)');
    await p.click('[data-back]');
  }
  await p.waitForFunction(() => !document.querySelector('.ai-panel'));

  step('tata letak');
  for (const [name, vp] of [['iPad potret', { width: 834, height: 1194 }], ['iPad lanskap', { width: 1194, height: 834 }], ['ponsel', { width: 390, height: 844 }]]) {
    await p.setViewportSize(vp);
    await wait(300);
    const lay = await p.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const sc = document.querySelector('.hm-scroll');
      return { overflowX: sc.scrollWidth > sc.clientWidth + 1, newCard: r('.hm-new'), tools: [...document.querySelectorAll('.hm-tool')].map((t) => t.getBoundingClientRect()), grid: r('.hm-grid'), tabbar: !!document.querySelector('.hm-tabbar, nav.hm-tabs') };
    });
    check(!lay.overflowX, `${name}: tanpa geser horizontal`);
    check(lay.newCard.width > vp.width * 0.85, `${name}: kartu Proyek baru selebar layar`);
    check(lay.tools.every((t) => t.width > 0 && t.bottom <= lay.grid.top), `${name}: alat di atas daftar proyek`);
    check(!lay.tabbar, `${name}: tanpa tab bawah (Template/Lab AI/Kotak Masuk/Saya)`);
  }
  check(!errors.length, `tanpa error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
}
console.log(failed ? `${failed} cek gagal` : 'semua cek beranda lolos');
cleanup();
process.exit(failed ? 1 : 0);
