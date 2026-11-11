// End-to-end: MCP get_frame returns the frame at the requested time on the FIRST call, even for a
// long-GOP video streamed from the server over a slow connection (seeks then take several seconds).
// Needs Playwright (with Chromium) and ffmpeg; skipped when either is missing. Run: npm run test:e2e
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MBPS = Number(process.env.GF_MBPS || 8);
const TIMES = [5.5, 50.5, 13.5, 58.5, 2.5, 33.5, 45.5, 27.5];
const TOKEN = 'tok-e2e-get-frame-123456';

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) {
  console.log(`SKIP get-frame e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`);
  process.exit(0);
}

const step = (m) => console.log(`·  ${m}`);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-getframe-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
step('membuat video uji');
// 60 s, the hue changes every second (8 colours, repeating), one keyframe every 20 s, ~5 Mbps of noise.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=540x960:r=30:d=60',
  '-vf', 'hue=H=2*PI*floor(t)/8:s=1,noise=alls=16:allf=t+u', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
  '-x264-params', 'keyint=600:min-keyint=600:scenecut=0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dir, 'media', 'warna.mp4')]);

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
const avgColor = (p, src, isImage) => p.evaluate(async ({ src, isImage }) => {
  let el;
  if (isImage) { el = new Image(); el.src = src; await el.decode(); } else el = src;
  const c = document.createElement('canvas'); c.width = 60; c.height = 100;
  c.getContext('2d').drawImage(el, 0, 0, 60, 100);
  const d = c.getContext('2d').getImageData(20, 40, 20, 20).data;
  const s = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
  return s.map((v) => v / (d.length / 4));
}, { src, isImage });

step('membuka browser');
const b = await chromium.launch();
let failed = 0;
process.on('unhandledRejection', (err) => { console.error('FAIL ', err); cleanup(); process.exit(1); });
try {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'e2e@najja.id'); await p.fill('#password', 'rahasia-e2e'); await p.fill('#password2', 'rahasia-e2e'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));
  step('membuat proyek');
  await mcp('new_project', { name: 'E2E get_frame', aspect_ratio: '9:16' });
  const media = await mcp('import_media', { path: 'warna.mp4' });
  await mcp('add_media_clip', { media_id: media.data.media_id });
  await p.waitForTimeout(3000); // autosave

  step('mengukur palet warna');
  // Reference colours as this browser decodes them (independent of the editor).
  const palette = await p.evaluate(async (id) => {
    const v = document.createElement('video'); v.muted = true; v.src = `/api/media/${id}/file`;
    await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    const c = document.createElement('canvas'); c.width = 60; c.height = 100; const x = c.getContext('2d');
    const out = [];
    for (let k = 0; k < 8; k++) {
      v.currentTime = k + 0.5;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      x.drawImage(v, 0, 0, 60, 100);
      const d = x.getImageData(20, 40, 20, 20).data; const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
      out.push(s.map((q) => q / (d.length / 4)));
    }
    return out;
  }, media.data.media_id);

  step(`membuka ulang proyek di ${MBPS} Mbps`);
  // Reopen the project so the video streams from the server, on a slow connection.
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: (MBPS * 1e6) / 8, uploadThroughput: 50e6 / 8 });
  await p.reload();
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));

  for (const t of TIMES) {
    const t0 = Date.now();
    const r = await mcp('get_frame', { time: t, max_width: 270 });
    const rgb = await avgColor(p, `data:image/jpeg;base64,${r.img}`, true);
    const dist = palette.map((c) => Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2]));
    const got = dist.indexOf(Math.min(...dist));
    const want = Math.floor(t) % 8;
    const ok = got === want && !r.data.stale_video;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  get_frame(${t}): second ${got} of 8 (want ${want}), ${Date.now() - t0} ms${r.data.stale_video ? ', marked stale' : ''}`);
  }
} finally {
  await b.close();
}
console.log(failed ? `${failed} of ${TIMES.length} frames were wrong` : `all ${TIMES.length} frames exact on the first call (${MBPS} Mbps)`);
cleanup(); // the server child would otherwise keep the process alive
process.exit(failed ? 1 : 0);
