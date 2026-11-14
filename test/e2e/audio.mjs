// End-to-end (v1.7.3): preview sound scheduled on the audio clock (public/js/audio.js).
// Records what the mixer plays (an AudioWorklet on the master bus) and checks: no click or gap where two decoded
// blocks meet, volume (also changed while playing, without restarting the sound), track mute, the sped-up fallback
// to the element's own sound, the A/B switch to the old element sound, and that video elements are not routed
// through Web Audio any more. Needs Playwright (with Chromium) and ffmpeg. Run: npm run test:e2e
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-audio-1234567890';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) {
  console.log(`SKIP audio e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`);
  process.exit(0);
}
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-audio-e2e-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
// 20 s video with a steady 440 Hz tone (amplitude 0.5): any click or gap shows up as a jump between samples.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=20',
  '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', path.join(dir, 'media', 'nada.mp4')]);
const port = await freePort();
const BASE = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.js', '--no-open'], { cwd: ROOT, env: { ...process.env, NAJJA_TOKEN: TOKEN, NAJJA_DATA_DIR: dir, PORT: String(port) }, stdio: 'ignore' });
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

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'audio@najja.id'); await p.fill('#password', 'rahasia-audio'); await p.fill('#password2', 'rahasia-audio'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.goto(`${BASE}/?debug`); // window.najja (engine) for the checks
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));

  step('proyek: satu klip 8 dtk dari sumber 4–12 dtk (melewati batas blok decode di 8 dtk)');
  await mcp('new_project', { name: 'E2E audio', aspect_ratio: '9:16' });
  const media = await mcp('import_media', { path: 'nada.mp4' });
  await mcp('add_media_clip', { media_id: media.media_id, track: 'main', start: 0, source_in: 4, duration: 8 });
  // the scheduler decodes files on this device: wait for the copy here
  for (let t = Date.now(); Date.now() - t < 60000; await wait(250)) {
    if (await p.evaluate(async (id) => { const { mediaRT } = await import('/js/media.js'); return !!mediaRT.get(id)?.url?.startsWith('blob:'); }, media.media_id)) break;
  }

  // Play `secs` from `from` and record the mixer. Returns level, biggest jump between samples, gaps, engine state.
  const record = (secs, from = 1, during = null) => p.evaluate(async ([secs, from, during]) => {
    const E = window.najja.engine;
    const { store } = await import('/js/store.js');
    E.pause();
    E.seek(from);
    await E.settle(8000);
    await new Promise((r) => setTimeout(r, 700)); // decoded ahead while paused
    const ctx = E.ensureAudio();
    if (ctx.state !== 'running') await ctx.resume();
    if (!window.__recLoaded) {
      const code = 'class R extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];this.port.postMessage(c?c.slice(0):new Float32Array(128));return true}}registerProcessor("najja-rec",R)';
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      window.__recLoaded = true;
    }
    const node = new AudioWorkletNode(ctx, 'najja-rec');
    const sink = ctx.createGain();
    sink.gain.value = 0;
    E.master.connect(node);
    node.connect(sink).connect(ctx.destination);
    const chunks = [];
    node.port.onmessage = (e) => chunks.push(e.data);
    const before = { ...window.najjaMetrics.snapshot ? (await window.najjaMetrics.snapshot()).counters : {} };
    E.play();
    let state = null;
    await new Promise((r) => setTimeout(r, 900));
    {
      const els = [...E.els.values()];
      state = { audioClock: E.audioClock, routed: els.filter((x) => x.src).length, unmuted: els.filter((x) => !x.el.muted).length, elements: els.length };
    }
    if (during === 'volume') store.mutate('Volume', (P) => { P.clips.find((c) => c.type === 'video').volume = 0.25; });
    await new Promise((r) => setTimeout(r, secs * 1000 - 900));
    E.pause();
    await new Promise((r) => setTimeout(r, 100));
    try { E.master.disconnect(node); } catch { /* ignore */ }
    node.disconnect();
    const after = (await window.najjaMetrics.snapshot()).counters;
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const x = new Float32Array(n);
    let o = 0;
    for (const c of chunks) { x.set(c, o); o += c.length; }
    const sr = ctx.sampleRate;
    let s0 = x.findIndex((v) => Math.abs(v) > 0.02);
    let s1 = -1;
    for (let i = n - 1; i >= 0; i--) if (Math.abs(x[i]) > 0.02) { s1 = i; break; }
    if (s0 < 0) return { silent: true, state };
    s0 += Math.round(0.3 * sr);
    s1 -= Math.round(0.08 * sr);
    let jump = 0;
    let sq = 0;
    let sqA = 0;
    let sqB = 0;
    let gaps = 0;
    // early: 0.3–0.7 s after the first sound (before a change made 0.9 s after play); late: the second half
    const early = s0 + Math.round(0.4 * sr);
    const half = Math.floor((s0 + s1) / 2);
    for (let i = s0 + 1; i < s1; i++) {
      jump = Math.max(jump, Math.abs(x[i] - x[i - 1]));
      sq += x[i] * x[i];
      if (i < early) sqA += x[i] * x[i]; else if (i >= half) sqB += x[i] * x[i];
    }
    const win = Math.round(0.005 * sr);
    for (let i = s0; i + win < s1; i += win) {
      let m = 0;
      for (let k = i; k < i + win; k++) m = Math.max(m, Math.abs(x[k]));
      if (m < 0.05) gaps++;
    }
    const len = Math.max(1, s1 - s0);
    const diff = (k) => (after[k] || 0) - (before[k] || 0);
    return {
      seconds: Math.round((len / sr) * 10) / 10,
      restarts: diff('audio_element_restart'),
      toFull: diff('audio_source_to_full'),
      toFailed: diff('audio_source_to_failed'),
      problems: (await window.najjaMetrics.snapshot()).events.filter((e) => e.kind === 'audio_problem').slice(-3).map((e) => `${e.what}: ${e.msg}`),
      rms: Math.sqrt(sq / len),
      rmsFirst: Math.sqrt(sqA / Math.max(1, early - s0)),
      rmsLast: Math.sqrt(sqB / Math.max(1, s1 - half)),
      jump,
      gaps,
      state,
      reschedules: (after.audio_reschedule || 0) - (before.audio_reschedule || 0),
    };
  }, [secs, from, during]);
  const f3 = (v) => (v == null ? '—' : v.toFixed(3));

  step('suara terjadwal: 6 dtk melewati batas blok');
  const a = await record(6);
  check(a.state?.audioClock === true, 'mode suara terjadwal (jam audio) aktif');
  check(a.state?.routed === 0 && a.state?.unmuted === 0, `elemen video tidak disalurkan lewat Web Audio dan dibisukan (${a.state?.routed} disalurkan, ${a.state?.unmuted} bersuara)`);
  check(!a.silent && Math.abs(a.rms - 0.354) < 0.04, `level nada benar: RMS ${f3(a.rms)} (harapan 0,354)`);
  check(a.jump < 0.08, `tanpa klik di sambungan blok: lompatan sampel maks ${f3(a.jump)} (nada murni ≤ 0,029)`);
  check(a.gaps === 0, `tanpa celah hening (${a.gaps} celah 5 ms)`);

  step('volume diubah saat diputar');
  const v = await record(6, 1, 'volume');
  check(Math.abs(v.rmsFirst - 0.354) < 0.05 && Math.abs(v.rmsLast - 0.089) < 0.03, `volume ikut berubah: RMS ${f3(v.rmsFirst)} → ${f3(v.rmsLast)} (harapan 0,354 → 0,089)`);
  check(v.reschedules === 0 && v.gaps === 0, `tanpa memulai ulang suara (${v.reschedules}× jadwal ulang, ${v.gaps} celah)`);
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.mutate('Volume', (P) => { P.clips.find((c) => c.type === 'video').volume = 1; }); });

  step('track utama dibisukan');
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.mutate('Bisu', (P) => { P.tracks.find((t) => t.id === 'main').muted = true; }); });
  const m = await record(3);
  check(m.silent === true, 'track bisu: tidak ada suara');
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.mutate('Bisu', (P) => { P.tracks.find((t) => t.id === 'main').muted = false; }); });

  step('klip dipercepat 2× (nada tetap: suara dari elemen, seperti sebelumnya)');
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.mutate('Kecepatan', (P) => { const c = P.clips.find((x) => x.type === 'video'); c.speed = 2; c.duration = 6; }); });
  const s = await record(3, 0.5);
  check(s.state?.routed === 1 && s.state?.unmuted === 1, 'klip dipercepat memakai suara elemennya');
  check(!s.silent && s.rms > 0.2, `suara terdengar: RMS ${f3(s.rms)}`);
  await p.evaluate(async () => { const { store } = await import('/js/store.js'); store.mutate('Kecepatan', (P) => { const c = P.clips.find((x) => x.type === 'video'); c.speed = 1; c.duration = 8; }); });

  // ---- Safari behaviour, simulated: what made the sound stop after the first 8 s block on an iPad (v1.7.3) ----
  // A wrapped AudioDecoder misbehaves on decodes that start mid-file (block 2 onwards); the sound must go on.
  await p.waitForFunction(async (id) => { const { mediaRT } = await import('/js/media.js'); return !!mediaRT.get(id)?.peaks?.length; }, media.media_id, { timeout: 60000 }).catch(() => {});
  const safari = (mode) => p.evaluate((mode) => {
    const N = window.__NativeAD || (window.__NativeAD = window.AudioDecoder);
    window.__NativeDAD = window.__NativeDAD || OfflineAudioContext.prototype.decodeAudioData;
    window.AudioDecoder = N;
    OfflineAudioContext.prototype.decodeAudioData = window.__NativeDAD;
    if (mode !== 'native') {
      window.AudioDecoder = class extends N {
        constructor(init) {
          let mid = null; // this decode starts in the middle of the file
          let n0 = null;
          super({
            error: init.error,
            output: (ad) => {
              if (!mid) { init.output(ad); return; }
              const n = ad.numberOfFrames;
              const ch = ad.numberOfChannels;
              const data = new Float32Array(n * ch);
              if (mode === 'stamps' || mode === 'all') for (let c = 0; c < ch; c++) ad.copyTo(data.subarray(c * n, (c + 1) * n), { planeIndex: c, format: 'f32-planar' });
              // 'stamps': timestamps from 0 at configure(); 'silence': digital silence with the right timestamps
              const ts = mode === 'stamps' ? (n0 == null ? (n0 = 0) : (n0 += 1)) * (n / ad.sampleRate) * 1e6 : ad.timestamp;
              init.output(new AudioData({ format: 'f32-planar', sampleRate: ad.sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp: ts, data }));
              ad.close();
            },
          });
          this.__init = init;
          this.__mode = mode;
          this.__isMid = () => mid;
          this.__setMid = (v) => { mid = v; };
        }
        decode(chunk) {
          if (this.__isMid() == null) this.__setMid(chunk.timestamp > 1e6);
          if (this.__isMid() && this.__mode === 'hang') return; // never answers
          if (this.__isMid() && this.__mode === 'error') { if (!this.__failed) { this.__failed = true; setTimeout(() => this.__init.error(new DOMException('Decoding error', 'EncodingError')), 0); } return; }
          super.decode(chunk);
        }
        flush() {
          if (this.__isMid() && this.__mode === 'hang') return new Promise(() => {});
          if (this.__isMid() && this.__mode === 'error') return Promise.reject(new DOMException('Decoding error', 'EncodingError'));
          return super.flush();
        }
      };
      if (mode === 'all') {
        // nothing decodes at all
        window.AudioDecoder = class extends N { decode() { if (!this.__f) { this.__f = true; } } flush() { return Promise.reject(new DOMException('Decoding error', 'EncodingError')); } };
        OfflineAudioContext.prototype.decodeAudioData = function () { return Promise.reject(new DOMException('Unable to decode audio data', 'EncodingError')); };
      }
    }
    window.najja.engine.audio.reset(); // decode again
  }, mode);
  const SAF = [
    ['stamps', 'decoder memberi label waktu dari 0 (bukan waktu file)'],
    ['silence', 'decoder mengembalikan hening untuk blok di tengah file'],
    ['hang', 'decoder menggantung (tidak pernah selesai)'],
    ['error', 'decoder error untuk blok di tengah file'],
  ];
  for (const [mode, what] of SAF) {
    step(`Safari (simulasi): ${what}`);
    await safari(mode);
    const r = await record(6, 0.5);
    check(!r.silent && r.seconds >= 5.0, `suara tetap ada sampai akhir: ${r.seconds} dtk dari 6 (melewati batas blok di dtk 3,5)`);
    check(r.gaps <= 2 && r.jump < 0.3, `tanpa celah berarti (${r.gaps} celah 5 ms, lompatan ${f3(r.jump)})`);
    check(Math.abs(r.rms - 0.354) < 0.06, `level benar, tanpa suara dobel: RMS ${f3(r.rms)}`);
    if (mode !== 'stamps') check(r.toFull >= 1 && (r.problems || []).length > 0, `file beralih ke decode utuh; alasan tercatat: ${(r.problems || []).slice(-1)[0] || '—'}`);
  }
  step('Safari (simulasi): semua decoder gagal → suara elemen');
  await safari('all');
  const all = await record(6, 0.5);
  check(!all.silent && all.seconds >= 4.5 && all.rms > 0.25 && all.rms < 0.45, `suara elemen mengambil alih: ${all.seconds} dtk, RMS ${f3(all.rms)} (tanpa suara dobel)`);
  check(all.toFailed >= 1, `file ditandai tidak bisa di-decode (${(all.problems || []).slice(-1)[0] || '—'})`);
  await safari('native');

  step('AudioContext berhenti saat diputar (iOS: telepon/interupsi)');
  const susp = await p.evaluate(async () => {
    const E = window.najja.engine;
    E.pause(); E.seek(1); await E.settle(8000);
    await new Promise((r) => setTimeout(r, 500));
    E.play();
    await new Promise((r) => setTimeout(r, 800));
    await E.audioCtx.suspend();
    await new Promise((r) => setTimeout(r, 1200));
    const els = [...E.els.values()].filter((x) => x.clip.type === 'video');
    const out = { audioClock: E.audioClock, playing: E.playing, moving: E.time, unrouted: els.filter((x) => !x.src && !x.el.muted && !x.el.paused).length,
      dbg: { buffering: E.buffering, ctx: E.audioCtx.state, ctxDown: E.ctxDown, els: els.map((x) => ({ src: !!x.src, muted: x.el.muted, paused: x.el.paused, rs: x.el.readyState, sched: !!x.sched, noSrc: !!x.noSrc })), counters: Object.fromEntries(Object.entries((await window.najjaMetrics.snapshot()).counters).filter(([k]) => /audio|play_rej|buffer/.test(k))) } };
    await new Promise((r) => setTimeout(r, 400));
    out.moved = E.time - out.moving;
    E.pause();
    await E.audioCtx.resume();
    return out;
  });
  if (process.env.AUDIO_DEBUG) console.log(JSON.stringify(susp));
  check(susp.audioClock === false && susp.playing && susp.moved > 0.2, `pemutaran jalan terus dengan jam biasa (maju ${susp.moved.toFixed(2)} dtk dalam 0,4 dtk)`);
  check(susp.unrouted === 1, 'video bersuara langsung lewat elemennya (tanpa Web Audio yang berhenti)');

  step('browser yang tidak mengonversi format sampel (seperti sebagian Safari): dikonversi sendiri');
  await p.evaluate(() => {
    const orig = AudioData.prototype.copyTo;
    AudioData.prototype.copyTo = function (dest, opt) { if (opt && opt.format) throw new Error('format conversion not supported'); return orig.call(this, dest, opt); };
    window.najja.engine.audio.reset(); // decode again
  });
  const f = await record(4);
  check(f.state?.audioClock === true && f.state?.unmuted === 0 && Math.abs(f.rms - 0.354) < 0.04 && f.jump < 0.08, `tetap suara terjadwal: RMS ${f3(f.rms)}, lompatan ${f3(f.jump)}`);

  step('A/B: suara elemen (cara lama)');
  await p.evaluate(() => { window.najja.engine.audioMode = 'element'; });
  const o = await record(4);
  check(o.state?.audioClock === false && !o.silent && Math.abs(o.rms - 0.354) < 0.05, `mode lama masih bekerja: RMS ${f3(o.rms)}`);
  await p.evaluate(() => { window.najja.engine.audioMode = 'auto'; });

  check(!errors.length, `tanpa error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
}
console.log(failed ? `${failed} cek gagal` : 'semua cek audio lolos');
cleanup();
process.exit(failed ? 1 : 0);
