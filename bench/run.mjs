// Benchmark runner for fixtures B0–B5 (blueprint 9.2). Starts its own server (temporary data folder), drives the
// real editor in Chromium with Playwright, builds projects through MCP, and reads public/js/metrics.js.
// usage:
//   node bench/fixtures.mjs                      # once: makes bench/.fixtures
//   node bench/run.mjs [--only=B0,B1] [--profile=desktop|ipad|phone] [--label=nama] [--fixtures=dir]
// Writes bench/results/<date>-<label>-<profile>.json and .md. Numbers from a headless lab machine are a baseline
// for before/after comparison, not a device verdict: run on real PC/iPad/HP for device classes (blueprint 9.3).
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { toMarkdown } from './report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const ONLY = arg('only', 'B0,B1,B2,B3,B4,B5').split(',').map((s) => s.trim().toUpperCase());
const PROFILE = arg('profile', 'desktop');
const LABEL = arg('label', 'run');
const FIX = path.resolve(arg('fixtures', path.join(ROOT, 'bench', '.fixtures')));
const B3_EXPORT_S = Number(arg('b3-export-seconds', 120));
const TOKEN = `tok-bench-${Date.now().toString(36)}-0123456789`;
const ADMIN = { email: 'bench@najja.id', password: 'bench-najja-123' };

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const fixtures = JSON.parse(fs.readFileSync(path.join(FIX, 'fixtures.json'), 'utf8')).files;
const rel = (f) => path.relative(FIX, f);
const log = (m) => console.log(`·  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const pct = (arr, f) => { const s = [...arr].sort((a, b) => a - b); return s.length ? r1(s[Math.min(s.length - 1, Math.floor(s.length * f))]) : null; };

// ---- server
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-bench-'));
const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], {
  cwd: ROOT, stdio: 'ignore',
  env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dataDir, NAJJA_MEDIA_DIR: FIX, PORT: String(port), NAJJA_NO_OPEN: '1' },
});
const cleanup = () => { try { server.kill(); } catch { /* gone */ } fs.rmSync(dataDir, { recursive: true, force: true }); };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ } await sleep(100); }
const form = (o) => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
await fetch(`${BASE}/login`, form({ ...ADMIN, password2: ADMIN.password, token: TOKEN }));

async function mcp(name, args = {}) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  if (!j.result || j.result.isError) throw new Error(`${name}: ${JSON.stringify(j.error || j.result?.content?.[0]?.text)}`);
  const text = j.result.content.find((c) => c.type === 'text')?.text;
  try { return JSON.parse(text); } catch { return text; }
}

// ---- browser
const PROFILES = {
  desktop: { ctx: { viewport: { width: 1280, height: 800 } }, cpu: 1 },
  ipad: { ctx: { ...devices['iPad Pro 11'], userAgent: undefined }, cpu: 2 },
  phone: { ctx: { ...devices['Pixel 7'] }, cpu: 4 },
};
const prof = PROFILES[PROFILE] || PROFILES.desktop;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });

async function openEditor({ user = ADMIN, profile = prof } = {}) {
  const ctx = await browser.newContext({ ...profile.ctx, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await page.goto(`${BASE}/login`);
  await page.fill('#email', user.email);
  await page.fill('#password', user.password);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  await page.goto(`${BASE}/?debug`);
  await page.waitForSelector('body.ready', { timeout: 60000 });
  if (profile.cpu > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  return { ctx, page, errors, readyMs: Date.now() - t0 };
}
const snapshot = (page) => page.evaluate(() => window.najjaMetrics.snapshot());
const resetMetrics = (page) => page.evaluate(() => window.najjaMetrics.reset());

/** Upload files from disk the way a user does (library file input), each placed on the timeline at 0 s. */
async function uploadFiles(page, files) {
  for (const f of files) await uploadFile(page, f);
}
async function uploadFile(page, file) {
  const before = await page.evaluate(async () => (await import('/js/store.js')).store.P.media.length);
  await page.evaluate(() => {
    const L = window.najja.library;
    L.fileInput.id = 'bench-file';
    L.fileInput.onchange = () => { L.importFiles([...L.fileInput.files], { addAt: 0 }); L.fileInput.value = ''; };
    if (!L.fileInput.isConnected) { L.fileInput.style.display = 'none'; document.body.appendChild(L.fileInput); }
  });
  await page.setInputFiles('#bench-file', file);
  await page.waitForFunction(async (n) => (await import('/js/store.js')).store.P.media.length > n, before, { timeout: 60000 });
}
/** Wait until every video has its light preview copy and is stored on this device (steady editing state). */
async function waitMediaReady(page, { timeout = 600000, local = true } = {}) {
  const t0 = Date.now();
  for (;;) {
    const st = await page.evaluate(async (local) => {
      const { mediaRT } = await import('/js/media.js');
      const P = window.najja.engine && (await import('/js/store.js')).store.P;
      const out = { total: 0, ready: 0 };
      for (const m of P.media) {
        if (m.type === 'image') continue;
        out.total++;
        const rt = mediaRT.get(m.id);
        const uploaded = rt?.uploaded && !rt.upload;
        // small H.264 files need no light copy (edit state "none"): they play as they are
        const edit = m.type !== 'video' || ['ready', 'none'].includes(rt?.server?.edit?.state);
        // playing from a copy on this device (the imported original, or the server copy saved to OPFS/memory)
        const onDevice = !local || m.type !== 'video' || String(rt?.url || '').startsWith('blob:');
        if (uploaded && edit && onDevice) out.ready++;
      }
      return out;
    }, local);
    if (st.total && st.ready === st.total) return Date.now() - t0;
    if (Date.now() - t0 > timeout) throw new Error(`media not ready after ${timeout / 1000}s (${st.ready}/${st.total})`);
    await sleep(500);
  }
}

/** Renderer memory as the OS sees it (Linux): includes decoded frames and ArrayBuffers, unlike the JS heap. */
function rendererRssMB() {
  let kb = 0;
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=renderer')) continue;
      kb += Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] || 0);
    } catch { /* exited */ }
  }
  return Math.round(kb / 1024);
}
function memWatch(page) {
  const s = { rssPeak: rendererRssMB(), rssStart: rendererRssMB(), heapPeak: 0 };
  const iv = setInterval(async () => {
    s.rssPeak = Math.max(s.rssPeak, rendererRssMB());
    try { s.heapPeak = Math.max(s.heapPeak, await page.evaluate(() => performance.memory?.usedJSHeapSize || 0)); } catch { /* navigating */ }
  }, 500);
  return () => { clearInterval(iv); return { renderer_rss_start_mb: s.rssStart, renderer_rss_peak_mb: s.rssPeak, js_heap_peak_mb: Math.round(s.heapPeak / 1048576) }; };
}

/** Play `secs` from `from` and return the playback metrics of that stretch. */
async function measurePlayback(page, secs, from = 0) {
  await page.evaluate(async (t) => { const E = window.najja.engine; E.pause(); E.seek(t); await E.settle(8000); }, from);
  await resetMetrics(page);
  await page.evaluate((s) => new Promise((done) => { const E = window.najja.engine; E.play(); setTimeout(() => { E.pause(); done(); }, s * 1000); }), secs);
  const snap = await snapshot(page);
  const S = snap.series;
  return {
    seconds: secs,
    fps_rendered: S.fps_rendered?.avg ?? null,
    frames_missed_pct: S.preview_frames_missed_pct?.avg ?? null,
    video_dropped_pct: S.video_dropped_frames_pct?.avg ?? null,
    frame_draw_p50_ms: S.frame_draw_ms?.p50 ?? null,
    frame_draw_p95_ms: S.frame_draw_ms?.p95 ?? null,
    buffer_waits: S.buffer_wait_ms?.n || 0,
    long_tasks: snap.counters.long_tasks_over_50ms || 0,
    preview_canvas: await page.evaluate(() => `${window.najja.engine.canvas.width}x${window.najja.engine.canvas.height}`),
  };
}
/** Random seeks while paused: time until the right frame is on screen (warm cache). */
async function measureSeeks(page, n = 20, seed = 7) {
  const dur = await page.evaluate(() => window.najja.engine.duration);
  let x = seed;
  const rand = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  await page.evaluate(() => window.najja.engine.pause());
  await resetMetrics(page);
  for (let i = 0; i < n; i++) {
    const t = Math.round(rand() * Math.max(0, dur - 0.5) * 100) / 100;
    await page.evaluate(async (t) => {
      const E = window.najja.engine;
      E.seek(t);
      const s = performance.now();
      while (E.seekAt && performance.now() - s < 11000) await new Promise((r) => setTimeout(r, 10));
    }, t);
  }
  const s = (await snapshot(page)).series.seek_to_frame_ms;
  return { n: s?.n || 0, p50_ms: s?.p50 ?? null, p95_ms: s?.p95 ?? null, max_ms: s?.max ?? null };
}
/** Export through MCP (renders in the editor, saves to the server) and check the file with ffprobe. */
async function measureExport(page, { resolution = '1080p' } = {}) {
  await resetMetrics(page);
  const stop = memWatch(page);
  const t0 = Date.now();
  await mcp('export_video', { resolution, format: 'mp4' });
  let st;
  for (;;) {
    st = await mcp('get_export_status');
    if (['done', 'error', 'cancelled'].includes(st.state)) break;
    await sleep(500);
  }
  const mem = stop();
  const snap = await snapshot(page);
  const ev = [...snap.events].reverse().find((e) => e.kind === 'export') || {};
  const file = st.result?.path || (st.result?.file && path.join(dataDir, 'exports', st.result.file));
  return { state: st.state, wall_ms: Date.now() - t0, ...pick(ev, ['mode', 'fallback', 'spool', 'audio_decoded_s', 'audio_full_decode', 'fetch_media_ms', 'prepare_ms', 'decode_ms', 'composite_ms', 'encode_ms', 'mux_ms', 'total_ms', 'realtime_factor', 'encoder_queue_max', 'output_size', 'failure_stage']), ...mem, probe: probe(file) };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));
/** Loudness of the exported audio: a quick check that the sound is there, at the same level as before. */
function loud(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr || '')?.[1];
  const max = /max_volume:\s*(-?[\d.]+) dB/.exec(r.stderr || '')?.[1];
  return { audio_mean_db: mean != null ? Number(mean) : null, audio_max_db: max != null ? Number(max) : null };
}
function probe(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration', '-of', 'json', file]).toString());
    const v = j.streams.find((s) => s.codec_type === 'video');
    const a = j.streams.find((s) => s.codec_type === 'audio');
    return { video: v ? `${v.codec_name} ${v.width}x${v.height} ${v.avg_frame_rate}` : null, audio: a?.codec_name || null, duration: r1(Number(j.format.duration)), ...(a ? loud(file) : {}) };
  } catch (err) { return { error: err.message }; }
}

// ---- fixtures
const results = { label: LABEL, profile: PROFILE, at: new Date().toISOString(), machine: { cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 1e9) }, runs: {} };
const run = async (id, fn) => {
  if (!ONLY.includes(id)) return;
  log(`${id} …`);
  const t0 = Date.now();
  try { results.runs[id] = { ok: true, ...(await fn()), seconds: Math.round((Date.now() - t0) / 1000) }; } catch (err) { results.runs[id] = { ok: false, error: err.message }; console.error(err); }
  log(`${id} selesai (${Math.round((Date.now() - t0) / 1000)} dtk)`);
};
const mainEditor = await openEditor();
results.device = await mainEditor.page.evaluate(() => window.najjaMetrics.snapshot().then((s) => s.device));
const { page } = mainEditor;

await run('B0', async () => {
  await mcp('new_project', { name: 'B0 single clip', aspect_ratio: '16:9' });
  await resetMetrics(page);
  const t0 = Date.now();
  await uploadFiles(page, [fixtures.b0, fixtures.music]);
  const readyMs = await waitMediaReady(page);
  const s = (await snapshot(page)).series;
  const imp = { import_visible_p95_ms: s.import_visible_ms?.p95 ?? null, upload_ms: s.upload_ms?.max ?? null, upload_mbps: s.upload_mbps?.p50 ?? null, asset_ready_ms: s.asset_ready_ms?.max ?? null, until_steady_ms: Date.now() - t0, wait_after_upload_ms: readyMs };
  return { import: imp, playback: await measurePlayback(page, 15), seek: await measureSeeks(page, 20), export: await measureExport(page) };
});

let b1Project = null;
await run('B1', async () => {
  await mcp('new_project', { name: 'B1 social short', aspect_ratio: '9:16' });
  const clips = [];
  for (const f of fixtures.b1) clips.push(await mcp('import_media', { path: rel(f), add_to_timeline: true }));
  await mcp('import_media', { path: rel(fixtures.music), add_to_timeline: true, start: 0 });
  await mcp('add_text', { text: 'DISKON 50%', template: 'bigTitle', start: 0, duration: 5 });
  await mcp('add_text', { text: 'Belanja sekarang', preset: 'boxBlack', start: 30, duration: 10 });
  const P = await mcp('get_project');
  for (const c of P.clips.filter((c) => c.type === 'video')) await mcp('apply_filter', { clip_id: c.id, filter: 'vivid' });
  await waitMediaReady(page);
  b1Project = await page.evaluate(async () => (await import('/js/store.js')).store.P.id);
  return { project: { clips: P.clips.length, duration: P.duration }, playback: await measurePlayback(page, 15), seek: await measureSeeks(page, 20), export: await measureExport(page) };
});

await run('B2', async () => {
  await mcp('new_project', { name: 'B2 layered', aspect_ratio: '16:9' });
  for (const f of fixtures.b2) await mcp('import_media', { path: rel(f), add_to_timeline: true });
  const ov = [];
  for (const [i, f] of fixtures.b2o.entries()) {
    const m = await mcp('import_media', { path: rel(f) });
    ov.push(await mcp('add_media_clip', { media_id: m.media_id, track: i ? 'new' : 'overlay', start: 2 + i * 6, scale: 0.35, x: i ? 0.25 : -0.25, y: -0.2, animation_in: 'pop' }));
  }
  await mcp('add_text', { text: 'Layered', template: 'neonNight', start: 1, duration: 8, animation_in: 'typewriter', animation_loop: 'pulse' });
  await mcp('add_effect', { effect: 'vignette', start: 0, duration: 30 });
  const P = await mcp('get_project');
  const main = P.clips.filter((c) => c.track === 'main');
  await mcp('apply_transition', { clip_id: main[1].id, transition: 'fade', duration: 0.8 });
  await mcp('apply_transition', { clip_id: main[2].id, transition: 'slideLeft', duration: 0.8 });
  await mcp('update_clip', { clip_id: main[0].id, fade_in: 1, fade_out: 1 });
  await waitMediaReady(page);
  return { project: { clips: P.clips.length + 2, duration: P.duration }, playback: await measurePlayback(page, 15), seek: await measureSeeks(page, 20), export: await measureExport(page) };
});

await run('B3', async () => {
  await mcp('new_project', { name: 'B3 long form', aspect_ratio: '16:9' });
  const m = await mcp('import_media', { path: rel(fixtures.b3), add_to_timeline: true });
  for (const f of fixtures.b3a) await mcp('import_media', { path: rel(f), add_to_timeline: true, start: 0 });
  // many cuts: split every 10 s
  for (let t = 10; t < (m.duration || 600) - 1; t += 10) {
    const P = await mcp('get_project');
    const c = P.clips.find((c) => c.track === 'main' && c.start < t && c.end > t);
    if (c) await mcp('split_clip', { clip_id: c.id, time: t });
  }
  const P = await mcp('get_project');
  await waitMediaReady(page, { timeout: 900000 });
  // Export memory (blueprint: heap/OPFS telemetry on B3 export): the first B3_EXPORT_S seconds at 1080p.
  await resetMetrics(page);
  const stop = memWatch(page);
  const ex = await page.evaluate(async (secs) => {
    const { exportVideo } = await import('/js/exporter.js');
    const r = await exportVideo(window.najja.engine, { resolution: '1080p', format: 'mp4', range: [0, secs] });
    const { remote } = await import('/js/remote.js');
    const up = await remote.upload(r.blob, { target: 'export', filename: 'b3-range.mp4', mime: r.mime });
    return { size: r.size, seconds: r.seconds, mode: r.mode, file: up.file };
  }, B3_EXPORT_S);
  const mem = stop();
  ex.probe = probe(path.join(dataDir, 'exports', ex.file));
  delete ex.file;
  const ev = [...(await snapshot(page)).events].reverse().find((e) => e.kind === 'export') || {};
  return {
    project: { clips: P.clips.length, duration: P.duration },
    playback: await measurePlayback(page, 10, 300),
    seek: await measureSeeks(page, 30),
    export: { range_s: B3_EXPORT_S, ...ex, ...pick(ev, ['spool', 'audio_decoded_s', 'audio_full_decode', 'prepare_ms', 'fetch_media_ms', 'decode_ms', 'composite_ms', 'encode_ms', 'mux_ms', 'realtime_factor', 'encoder_queue_max']), ...mem },
  };
});

await run('B4', async () => {
  if (!b1Project) throw new Error('B4 needs B1 (run with --only=B1,B4)');
  // make B1 the most recently edited project: a new device opens that one first
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const rec = await (await fetch(`${BASE}/api/projects/${b1Project}`, { headers: { cookie } })).json();
  rec.updatedAt = Date.now();
  await fetch(`${BASE}/api/projects/${b1Project}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(rec) });
  // a second device (phone profile) opens the same project: cold, then warm (reload)
  const other = await openEditor({ profile: PROFILES[PROFILE === 'phone' ? 'desktop' : 'phone'] });
  const out = {};
  for (const phase of ['cold', 'warm']) {
    if (phase === 'warm') {
      await waitMediaReady(other.page);
      const t0 = Date.now();
      await other.page.reload();
      await other.page.waitForSelector('body.ready');
      out.warm_ready_ms = Date.now() - t0;
    } else out.cold_ready_ms = other.readyMs;
    const t1 = Date.now();
    await other.page.evaluate(async () => { const E = window.najja.engine; E.seek(1); await E.settle(30000); });
    out[`${phase}_first_frame_ms`] = Date.now() - t1;
    const s = await measureSeeks(other.page, 10);
    out[`${phase}_seek_p95_ms`] = s.p95_ms;
    if (phase === 'cold') { const t2 = Date.now(); await waitMediaReady(other.page); out.cold_media_on_device_ms = Date.now() - t2; }
  }
  out.project_matches = (await other.page.evaluate(async () => (await import('/js/store.js')).store.P.id)) === b1Project;
  await other.ctx.close();
  return out;
});

await run('B5', async () => {
  // 4 accounts. The long recording is uploaded first and its conversion is already running when three other accounts
  // upload short clips (the case where a FIFO queue makes them wait minutes). The admin keeps using the API.
  const files = [fixtures.b3, fixtures.b0, fixtures.b2[0], fixtures.b1[3]];
  const users = files.map((_, i) => ({ email: `user${i + 1}@najja.id`, password: `bench-user-${i + 1}-pw` }));
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  for (const u of users) await fetch(`${BASE}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ ...u, role: 'editor' }) });
  const eds = await Promise.all(users.map((u) => openEditor({ user: u, profile: PROFILES.desktop })));
  const lat = [];
  let polling = true;
  const poller = (async () => { while (polling) { const t = performance.now(); await fetch(`${BASE}/api/projects`, { headers: { cookie } }); lat.push(performance.now() - t); await sleep(250); } })();
  const t0 = Date.now();
  const one = async (e, i) => {
    await resetMetrics(e.page);
    const ts = Date.now();
    await uploadFiles(e.page, [files[i]]);
    const ready = await waitMediaReady(e.page, { timeout: 900000, local: false });
    const s = (await snapshot(e.page)).series;
    return { file: path.basename(files[i]), size_mb: Math.round(fs.statSync(files[i]).size / 1048576), started_s: Math.round((ts - t0) / 100) / 10, upload_ms: s.upload_ms?.max ?? null, asset_ready_ms: s.asset_ready_ms?.max ?? null, until_ready_ms: ready };
  };
  const long = one(eds[0], 0);
  // wait until the long conversion runs
  for (let i = 0; i < 600; i++) {
    const st = await (await fetch(`${BASE}/api/status`, { headers: { cookie } })).json();
    if ((st.metrics?.jobs?.edit?.running || 0) >= 1) break;
    await sleep(250);
  }
  const short = await Promise.all(eds.slice(1).map((e, i) => one(e, i + 1)));
  const per = [await long, ...short];
  polling = false;
  await poller;
  const st = await (await fetch(`${BASE}/api/status`, { headers: { cookie } })).json();
  for (const e of eds) await e.ctx.close();
  return { total_ms: Date.now() - t0, users: per, api_latency: { n: lat.length, p50_ms: pct(lat, 0.5), p95_ms: pct(lat, 0.95), max_ms: r1(Math.max(...lat)) }, server_jobs: st.metrics?.jobs, server_load: st.metrics?.load };
});

results.page_errors = mainEditor.errors;
await browser.close();

// ---- report
const outDir = path.join(ROOT, 'bench', 'results');
fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, `${new Date().toISOString().slice(0, 10)}-${LABEL}-${PROFILE}`);
fs.writeFileSync(`${base}.json`, JSON.stringify(results, null, 2));
fs.writeFileSync(`${base}.md`, toMarkdown(results));
console.log(`laporan: ${path.relative(ROOT, base)}.{json,md}`);
cleanup();
process.exit(0);
