// P2-6 A/B in headless Chromium (Playwright): the preview's own decoder ('auto') vs <video> elements ('element') on a
// project of 30 jump cuts (bench/p26/README.md). Reads the picture actually drawn (measure.js).
// usage: NAJJA_BENCH_EMAIL=… NAJJA_BENCH_PASSWORD=… node bench/p26/run.mjs --project=<id> [--profile=desktop|ipad]
//        [--runs=2] [--arms=auto,element] [--source=device|server] [--base=http://localhost:3399] [--seeks] [--audio] [--state]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.PLAYWRIGHT_DIR ? `${process.env.PLAYWRIGHT_DIR.replace(/\/$/, '')}/` : import.meta.url);
const { chromium, devices } = require('playwright');
const env = { EMAIL: process.env.NAJJA_BENCH_EMAIL, PASSWORD: process.env.NAJJA_BENCH_PASSWORD };
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const PROJECT = arg('project', '');
const PROFILE = arg('profile', 'desktop');
const RUNS = Number(arg('runs', 2));
const SOURCE = arg('source', 'device'); // device | server
const ARMS = arg('arms', 'auto,element').split(',');
const BASE = arg('base', 'http://localhost:3399');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctxOpts = PROFILE === 'ipad' ? { ...devices['iPad Pro 11 landscape'], userAgent: undefined } : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
const ctx = await browser.newContext(ctxOpts);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 300)); });
await page.goto(`${BASE}/login`);
await page.fill('#email', env.EMAIL);
await page.fill('#password', env.PASSWORD);
await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
await page.goto(`${BASE}/?debug&p=${PROJECT}`);
await page.waitForSelector('body.ready', { timeout: 60000 });
if (PROFILE === 'ipad') await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 2 });
await page.waitForFunction(async () => { const { mediaRT } = await import('/js/media.js'); const { store } = await import('/js/store.js'); return store.P?.media?.length && mediaRT.get(store.P.media[0].id)?.status === 'ready'; }, null, { timeout: 60000 });
if (process.argv.includes('--audio')) {
  // sound while the copy streams from the server: scheduled from Range reads (no media element), pictures decoded
  await page.waitForTimeout(1500);
  console.log(await page.evaluate(async () => {
    const E = window.najja.engine; const { store } = await import('/js/store.js'); const { mediaRT } = await import('/js/media.js'); const { metrics } = await import('/js/metrics.js');
    const id = store.P.media[0].id; const rt = mediaRT.get(id);
    store.mutate('unmute', (P) => { for (const c of P.clips) c.muted = false; });
    E.setFrameMode('auto'); metrics.reset();
    E.seek(0); await E.settle(5000); E.play(); await new Promise((r) => setTimeout(r, 6000)); E.pause();
    const s = E.audio.sources.get(id); const snap = await metrics.snapshot({}); const c = snap.counters;
    return JSON.stringify({ url: rt.url, hasAudio: store.media(id).hasAudio, audio: snap.gauges.audio_mode, engine: snap.gauges.preview_engine, source: s?.state, fromServer: !!s?.bytes && !s.bytes.blob, decodedS: E.audio.info().decodedS, underrun: c.audio_underrun || 0, startWait: snap.series.audio_start_wait_ms?.p50, readRetry: c.audio_read_retry || 0, decs: E.decs.size, els: E.els.size, cutsReady: c.cut_picture_ready || 0, cutsLate: c.cut_picture_late || 0, buffers: (c.buffer_at_clip_start || 0) + (c.buffer_mid_clip || 0), problem: E.audio.lastProblem, speed: snap.series.playback_speed_pct?.p50 });
  }));
  await browser.close(); process.exit(0);
}
if (process.argv.includes('--state')) { await page.waitForTimeout(4000); console.log(await page.evaluate(async () => { const { mediaRT, previewSource } = await import('/js/media.js'); const { store } = await import('/js/store.js'); const id = store.P.media[0].id; const rt = mediaRT.get(id); return JSON.stringify({ url: rt.url, src: rt.src, local: rt.local, server: rt.server?.state, originalOk: rt.originalOk, plays: previewSource(id), cache: rt.cache, playError: rt.playError }); })); await browser.close(); process.exit(0); }
await page.addScriptTag({ path: fileURLToPath(new URL('./measure.js', import.meta.url)) });
if (SOURCE === 'server') {
  // what an iPad meets on a first visit: the copy is still on the server (streamed), not on the device yet
  await page.evaluate(async () => {
    const { mediaRT } = await import('/js/media.js'); const { store } = await import('/js/store.js'); const { remote } = await import('/js/remote.js');
    const id = store.P.media[0].id; const rt = mediaRT.get(id);
    Object.assign(rt, { url: remote.mediaUrl(id), src: remote.mediaUrl(id), cacheKey: null, remoteUrl: null, local: null });
    store.emit('media', id);
  });
}
const out = [];
for (let i = 0; i < RUNS; i++) {
  for (const arm of ARMS) {
    await page.evaluate((m) => window.najja.engine.setFrameMode(m), arm);
    await page.waitForTimeout(500);
    const r = await page.evaluate(({ label }) => window.__measure(14.6, label), { label: `${arm} #${i + 1}` });
    out.push(r);
    const brief = { label: r.label, wrong: r.wrong_frames, wrongBig: r.wrong_by_more_than_3, cutsWrong: r.cuts_wrong_first_picture, freezes: r.freezes_over_100ms, freezeMs: r.freeze_total_ms, freezeMax: r.freeze_max_ms, buffers: r.buffers, ready: r.cut_picture_ready, late: r.cut_picture_late, fps: r.fps_rendered?.p50, vfps: r.video_presented_fps?.p50, speed: r.playback_speed_pct?.p50, reached: r.timeline_reached_s, first: r.decoder_first_frame_ms?.p95, decs: r.decoders, els: r.elements };
    console.log(JSON.stringify(brief));
    if (process.argv.includes('--seeks')) console.log(JSON.stringify(await page.evaluate(({ label }) => window.__seeks(20, label), { label: `${arm} seeks #${i + 1}` })));
  }
}
fs.writeFileSync(`p26-${PROFILE}-${SOURCE}.json`, JSON.stringify({ profile: PROFILE, source: SOURCE, runs: out, errors }, null, 2));
console.log('errors:', errors.slice(0, 8));
await browser.close();
