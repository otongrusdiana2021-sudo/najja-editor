// End-to-end (v1.12.3): the AI · MCP panel, ready to paste.
//   A. Hubungkan: the connector address, the Claude Code command without a token, JSON for other apps; no
//      <TOKEN_AI_KAMU> placeholders; "Buat token & isi otomatis" fills a real token in
//   B. Prompt: a ready-made prompt goes into the box with the project's name; "Buka di Claude" opens claude.ai with it
//   C. Tempel JSON: pasted tool calls (an AI's answer with a ```json block) run in the editor; a bad one stops with a
//      message; the guide for other AIs is copied
//   D. typing is not lost when the panel redraws
// Needs Playwright. Run: node test/e2e/aipanel.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-aipanel-1234567890';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
if (!chromium) { console.log('SKIP aipanel e2e: playwright is not installed'); process.exit(0); }
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-aipanel-e2e-'));
const port = await freePort();
const BASE = `http://localhost:${port}`;
const env = { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port), NAJJA_AI: 'off', NAJJA_AI_URL: '' };
delete env.NAJJA_PUBLIC_URL;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env, stdio: 'ignore' });
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
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'ai@najja.id'); await p.fill('#password', 'rahasia-ai1'); await p.fill('#password2', 'rahasia-ai1'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.goto(`${BASE}/?debug`);
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));
  await mcp('new_project', { name: 'Olive Bag', aspect_ratio: '9:16' });
  await mcp('add_solid', { color: '#223344', duration: 4 });
  const sheet = '.sheet.in';
  await p.click('.mcp-pill');
  await p.waitForSelector(`${sheet} [data-aitab="connect"]`);

  step('A. Hubungkan');
  const conn = await p.evaluate((s) => document.querySelector(s).textContent, sheet);
  const copies = await p.evaluate((s) => [...document.querySelectorAll(`${s} [data-copy]`)].map((b) => b.dataset.copy), sheet);
  check(!/TOKEN_AI_KAMU|path\/ke/.test(conn) && copies.includes(`${BASE}/mcp`), 'alamat konektor siap tempel, tanpa placeholder');
  check(copies.includes(`claude mcp add --transport http najja-editor --scope user ${BASE}/mcp`), 'perintah Claude Code tanpa token (login OAuth)');
  check(copies.some((c) => { try { return JSON.parse(c).mcpServers['najja-editor'].url === `${BASE}/mcp`; } catch { return false; } }), 'JSON untuk Cursor/VS Code siap tempel');
  await p.click(`${sheet} details.ai-card summary`);
  await p.click(`${sheet} [data-ai-filltoken]`);
  await p.waitForFunction((s) => [...document.querySelectorAll(`${s} [data-copy]`)].some((b) => /Bearer najja_pat_/.test(b.dataset.copy)), sheet);
  const tok = await p.evaluate((s) => [...document.querySelectorAll(`${s} [data-copy]`)].map((b) => b.dataset.copy).filter((c) => /najja_pat_/.test(c)), sheet);
  const real = /najja_pat_[\w-]+/.exec(tok[0])[0];
  const works = (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${real}` } })).status;
  check(tok.length === 2 && works === 200, `"Buat token & isi otomatis": perintah + JSON berisi token asli yang langsung berlaku (HTTP ${works})`);

  step('B. Prompt');
  await p.click(`${sheet} [data-aitab="prompt"]`);
  await p.waitForSelector(`${sheet} [data-ai-tpl]`);
  const tpl = await p.evaluate((s) => [...document.querySelectorAll(`${s} [data-ai-tpl]`)].find((b) => /Story Pop/.test(b.dataset.aiTpl)).dataset.aiTpl, sheet);
  await p.click(`${sheet} [data-ai-tpl="${tpl.replace(/"/g, '\\"')}"]`);
  const box = await p.evaluate((s) => { const t = document.querySelector(`${s} .ai-prompt`); return { v: t.value, sel: t.value.slice(t.selectionStart, t.selectionEnd), focus: document.activeElement === t }; }, sheet);
  check(/"Olive Bag"/.test(box.v) && box.sel.startsWith('[') && box.focus, `template masuk ke kotak dengan nama proyek, bagian [..] pertama terpilih ("${box.sel}")`);
  await p.fill(`${sheet} .ai-prompt`, 'Edit proyek "Olive Bag" pakai Story Pop, produk Olive Bag, harga 149 ribu.');
  const [popup] = await Promise.all([ctx.waitForEvent('page'), p.click(`${sheet} [data-ai-open]`)]);
  const u = new URL(popup.url());
  const clip = await p.evaluate(() => navigator.clipboard.readText());
  check(u.hostname === 'claude.ai' && u.searchParams.get('q') === 'Edit proyek "Olive Bag" pakai Story Pop, produk Olive Bag, harga 149 ribu.' && /149 ribu/.test(clip), '"Buka di Claude": chat baru dengan perintah terisi, juga disalin');
  await popup.close();

  step('C. Tempel JSON');
  await p.click(`${sheet} [data-aitab="json"]`);
  await p.waitForSelector(`${sheet} .ai-json`);
  const answer = 'Siap, ini perintahnya:\n```json\n[\n {"tool":"add_text","arguments":{"text":"DISKON 50%","start":0,"duration":3,"text_motion":"wordPop"}},\n {"tool":"add_sticker","arguments":{"emoji":"🔥","start":0.5,"duration":2}}\n]\n```';
  await p.fill(`${sheet} .ai-json`, answer);
  await p.click(`${sheet} [data-ai-run]`);
  await p.waitForFunction((s) => document.querySelectorAll(`${s} .mcp-log li.ok`).length === 2, sheet, { timeout: 15000 });
  const made = await p.evaluate(async () => { const { store } = await import('/js/store.js'); return { t: store.P.clips.find((c) => c.text?.content === 'DISKON 50%'), s: store.P.clips.some((c) => c.sticker?.emoji === '🔥') }; });
  check(made.t?.text.motion?.type === 'wordPop' && made.s, 'jawaban AI berisi ```json dijalankan: teks kinetik + stiker masuk ke proyek');
  await p.fill(`${sheet} .ai-json`, '[{"tool":"add_text","arguments":{"text":"OK"}},{"tool":"update_clip","arguments":{"clip_id":"c_tidak_ada"}},{"tool":"add_text","arguments":{"text":"tidak dijalankan"}}]');
  await p.click(`${sheet} [data-ai-run]`);
  await p.waitForFunction((s) => document.querySelector(`${s} .mcp-log li.error`), sheet, { timeout: 15000 });
  const res = await p.evaluate((s) => [...document.querySelectorAll(`${s} .mcp-log li`)].map((l) => l.className), sheet);
  const third = await p.evaluate(async () => (await import('/js/store.js')).store.P.clips.some((c) => c.text?.content === 'tidak dijalankan'));
  check(res.join(',') === 'ok,error,skip' && !third, `berhenti di perintah yang gagal, sisanya dilewati (${res.join(', ')})`);
  await p.fill(`${sheet} .ai-json`, '{"tool":"add_txt","arguments":{}}');
  await p.click(`${sheet} [data-ai-run]`);
  await p.waitForFunction(() => /tidak ada/.test(document.querySelector('.toast')?.textContent || ''), null, { timeout: 5000 });
  check(true, 'nama tool salah: pesan jelas, tidak ada yang dijalankan');
  await p.click(`${sheet} [data-ai-guide]`);
  await p.waitForFunction(() => /Panduan disalin/.test([...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' ')), null, { timeout: 8000 });
  const guide = await p.evaluate(() => navigator.clipboard.readText());
  check(/HANYA dengan JSON/.test(guide) && /add_text: .*Argumen: text\*/.test(guide) && /proyek "Olive Bag"/.test(guide), 'panduan untuk AI lain disalin, lengkap dengan argumen tiap tool');

  step('D. mengetik tidak hilang saat panel diperbarui');
  await p.fill(`${sheet} .ai-json`, '');
  await p.click(`${sheet} .ai-json`);
  await p.keyboard.type('[{"tool":"get_proj');
  await mcp('get_project'); // (an AI command: the panel's log changes)
  await wait(400);
  await p.keyboard.type('ect"}]');
  const typed = await p.evaluate((s) => document.querySelector(`${s} .ai-json`).value, sheet);
  check(typed === '[{"tool":"get_project"}]', `teks yang diketik utuh (${typed})`);
  await p.click(`${sheet} [data-aitab="log"]`);
  const log = await p.evaluate((s) => document.querySelector(s).textContent, sheet);
  check(/add_text \(JSON\)/.test(log) && /get_project/.test(log), 'tab Aktivitas: perintah AI dan perintah JSON tercatat');
  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek panel AI lolos');
process.exit(failed ? 1 : 0);
