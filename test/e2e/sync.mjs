// End-to-end (v1.7 P6): one account, two devices (browser contexts) on the same project.
// A change on device A shows up on device B; undo does not cause a false conflict; a real conflict asks instead of
// overwriting; unsaved changes of a closed tab come back from the device draft. Needs Playwright (with Chromium).
// Run: npm run test:e2e
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-sync-1234567890';
const USER = { email: 'sync@najja.id', password: 'sinkron-najja-1' };
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
if (!chromium) {
  console.log('SKIP sync e2e: playwright is not installed');
  process.exit(0);
}
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-sync-e2e-'));
const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port), NAJJA_SYNC_POLL_MS: '1000' }, stdio: 'ignore' });
let cleaned = false;
const cleanup = () => { if (cleaned) return; cleaned = true; try { server.kill(); } catch { /* ignore */ } fs.rmSync(dir, { recursive: true, force: true }); };
process.on('exit', cleanup);
process.on('unhandledRejection', (err) => { console.error('FAIL ', err); cleanup(); process.exit(1); });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await wait(100); }
await fetch(`${BASE}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...USER, password2: USER.password, token: TOKEN }).toString() });

const browser = await chromium.launch();
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${BASE}/login`);
  await page.fill('#email', USER.email);
  await page.fill('#password', USER.password);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  // The app starts on the home screen (v1.8): open a project by its link (?p=), or make a new one there.
  const open = async (p = page, id = null) => {
    await p.goto(`${BASE}/?debug${id ? `&p=${id}` : ''}`);
    await p.waitForSelector('body.ready');
    if (await p.evaluate(() => !document.getElementById('home').hidden)) {
      await p.click('[data-new]');
      await p.click('.modal [data-go]');
      await p.waitForFunction(() => document.getElementById('home').hidden);
      await p.keyboard.press('Escape'); // the media sheet a new project opens with
    }
  };
  return { ctx, page, errors, open };
}
const S = (page, fn, arg) => page.evaluate(async ([src, a]) => { const { store } = await import('/js/store.js'); return (0, eval)(src)(store, a); }, [fn.toString(), arg]);
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return Date.now() - t; await wait(50); } return null; };
const serverProject = async (cookiePage, id) => cookiePage.evaluate(async (pid) => (await fetch(`/api/projects/${pid}`)).json(), id);

try {
  step('perangkat A membuat proyek, perangkat B membuka proyek yang sama');
  const A = await device('A');
  await A.open();
  const id = await S(A.page, (store) => store.P.id);
  await until(() => S(A.page, (store) => store.saveState === 'saved' && !store.dirty));
  const B = await device('B');
  await B.open(B.page, id);
  check((await S(B.page, (store) => store.P.id)) === id, 'B membuka proyek yang sama');

  step('perubahan di A muncul di B');
  const t0 = Date.now();
  await S(A.page, (store) => store.mutate('Ganti nama', (P) => { P.name = 'Dari perangkat A'; }));
  const lag = await until(() => S(B.page, (store) => store.P.name === 'Dari perangkat A'), 10000);
  check(lag != null, `B melihat perubahan A dalam ${lag != null ? ((Date.now() - t0) / 1000).toFixed(1) : '—'} dtk (simpan 0,7 dtk + polling 1 dtk)`);
  check(lag != null && Date.now() - t0 <= 3000, 'selisih ≤ 3 dtk di jaringan lab (target blueprint ≤ 2 dtk + jeda simpan)');
  await S(A.page, (store) => store.mutate('Teks', (P) => { P.clips.push({ id: 'c_fromA', type: 'text', trackId: 'main', start: 0, duration: 2, text: { content: 'A' } }); }));
  check((await until(() => S(B.page, (store) => !!store.P.clips.find((c) => c.id === 'c_fromA')), 10000)) != null, 'klip baru dari A muncul di B');

  step('undo setelah tersimpan tidak dianggap konflik');
  await until(() => S(A.page, (store) => store.saveState === 'saved' && !store.dirty));
  await S(A.page, (store) => store.undo());
  await until(() => S(A.page, (store) => store.saveState !== 'saving' && !store.dirty), 5000);
  check((await S(A.page, (store) => store.saveState)) === 'saved', 'A: undo tersimpan tanpa konflik');
  check((await until(() => S(B.page, (store) => !store.P.clips.find((c) => c.id === 'c_fromA')), 10000)) != null, 'B ikut: klip hilang setelah undo di A');

  step('konflik nyata: B mengubah saat offline, A juga menyimpan');
  await until(() => S(B.page, (store) => !store.dirty && store.saveState === 'saved'));
  await B.page.route('**/api/projects/**', (r) => (r.request().method() === 'PUT' ? r.abort() : r.continue()));
  await S(B.page, (store) => store.mutate('Ganti nama', (P) => { P.name = 'Versi B (offline)'; }));
  await wait(1200); // B's save fails (offline), B keeps the change (dirty + draft)
  await S(A.page, (store) => store.mutate('Ganti nama', (P) => { P.name = 'Versi A (online)'; }));
  await until(() => S(A.page, (store) => !store.dirty && store.saveState === 'saved'));
  check((await serverProject(A.page, id)).name === 'Versi A (online)', 'server punya versi A');
  await B.page.unroute('**/api/projects/**');
  const dlg = await until(() => B.page.evaluate(() => !!document.querySelector('.modal [data-copy]')), 12000);
  check(dlg != null, 'B: dialog konflik muncul (tidak menimpa diam-diam)');
  check((await serverProject(A.page, id)).name === 'Versi A (online)', 'versi A tetap utuh selama B belum memilih');
  if (process.env.SYNC_SHOT) {
    await B.page.screenshot({ path: process.env.SYNC_SHOT });
    await B.page.setViewportSize({ width: 390, height: 844 });
    await B.page.screenshot({ path: process.env.SYNC_SHOT.replace('.png', '-phone.png') });
    await B.page.setViewportSize({ width: 1180, height: 820 });
  }
  const over = await B.page.evaluate(() => { const m = document.querySelector('.modal [data-copy]').closest('.modal'); return [...m.querySelectorAll('.modal-foot .btn')].some((b) => { const r = b.getBoundingClientRect(); const q = m.getBoundingClientRect(); return r.left < q.left - 1 || r.right > q.right + 1; }); });
  check(!over, 'tombol dialog konflik tidak keluar dari kotak dialog');
  await B.page.click('.modal [data-copy]');
  await until(() => S(B.page, (store, pid) => store.P.id !== pid && store.saveState === 'saved' && !store.dirty, id), 8000);
  const copyId = await S(B.page, (store) => store.P.id);
  const copy = await serverProject(B.page, copyId);
  check(copyId !== id && copy.name === 'Versi B (offline) (salinan)', 'versi B tersimpan sebagai proyek salinan');
  check((await serverProject(A.page, id)).name === 'Versi A (online)', 'versi A tidak berubah');

  step('draf lokal: tab ditutup sebelum perubahan sampai ke server');
  await until(() => S(A.page, (store) => !store.dirty && store.saveState === 'saved'));
  const revBefore = (await serverProject(A.page, id)).rev;
  await A.page.route('**/api/projects/**', (r) => (r.request().method() === 'PUT' ? r.abort() : r.continue()));
  await S(A.page, (store) => store.mutate('Ganti nama', (P) => { P.name = 'Belum tersimpan'; }));
  await wait(900); // the draft is written to IndexedDB (debounced 0.4 s); the save fails
  await A.page.close({ runBeforeUnload: false });
  const A2 = await A.ctx.newPage();
  await A.open(A2, id);
  check((await S(A2, (store) => store.P.name)) === 'Belum tersimpan', 'perubahan dipulihkan dari draf perangkat');
  await until(() => S(A2, (store) => !store.dirty && store.saveState === 'saved'), 8000);
  const after = await serverProject(A2, id);
  check(after.name === 'Belum tersimpan' && after.rev === revBefore + 1, 'draf lalu tersimpan ke server (revisi berikutnya)');

  const errs = [...A.errors, ...B.errors];
  check(!errs.length, `tanpa error halaman${errs.length ? `: ${errs.join(' | ')}` : ''}`);
} finally {
  await browser.close();
}
console.log(failed ? `${failed} cek gagal` : 'semua cek sinkron lolos');
cleanup();
process.exit(failed ? 1 : 0);
