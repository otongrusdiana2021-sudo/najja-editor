// End-to-end (v1.8.1): the fast export (WebCodecs) with the decoder and encoder behaviours seen on an iPad.
// An export made on an iPad would not play on Android or a PC ("format not supported": Safari's AudioEncoder gives a
// whole ES_Descriptor where the MP4 needs the AudioSpecificConfig) and its video froze while text moved (Safari's
// VideoDecoder gives B-frame streams out of order and holds frames back). Chromium does neither, so this test wraps
// its encoder and decoder to behave that way, exports, and checks the file with ffprobe/ffmpeg:
//   - the audio track decodes (AAC-LC, 2 channels) and carries the tone;
//   - every exported frame is the right source picture, in order (no repeated or swapped pictures);
//   - a decoder that holds every frame until a flush still exports correctly (flush + re-feed);
//   - a decoder that loses frames makes the export fall back to real time instead of saving a stuttering video.
// Needs Playwright (with Chromium) and ffmpeg. Run: npm run test:e2e
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-e2e-export-1234567890';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
if (!chromium || !hasFfmpeg) {
  console.log(`SKIP export e2e: ${!chromium ? 'playwright' : 'ffmpeg'} is not installed`);
  process.exit(0);
}
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const step = (m) => console.log(`·  ${m}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const SECS = 6;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-export-e2e-'));
fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
// 6 s, 30 fps, B-frames (3) and a keyframe every second; a white bar moves 16 px per frame so every picture differs.
const SRC = path.join(dir, 'media', 'gerak.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=360x640:r=30:d=${SECS}`,
  '-f', 'lavfi', '-i', `aevalsrc=0.5*sin(2*PI*440*t)|0.5*sin(2*PI*440*t):s=48000:d=${SECS}`,
  '-vf', "drawbox=x='mod(t*480,336)':y=0:w=24:h=640:color=white:t=fill",
  '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '3', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', SRC]);
const W = 90;
const H = 160;
const gray = (f) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', `fps=30,scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const n = Math.floor(b.length / (W * H));
  return Array.from({ length: n }, (_, i) => b.subarray(i * W * H, (i + 1) * W * H));
};
const mad = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const srcFrames = gray(SRC);

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

// Wrappers installed in the page. mode: '' (Chromium as is), 'safari' (out-of-order + held frames, ES_Descriptor
// audio description), 'hold' (frames only on flush), 'drop' (every 10th frame never comes out).
const installShims = (mode) => {
  window.__RealVD ||= window.VideoDecoder;
  window.__RealAE ||= window.AudioEncoder;
  if (!mode) { window.VideoDecoder = window.__RealVD; window.AudioEncoder = window.__RealAE; return; }
  const RealVD = window.__RealVD;
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  class ShimDecoder {
    constructor({ output, error }) {
      this.held = [];
      this.n = 0;
      this.output = output;
      this.real = new RealVD({ output: (f) => this.got(f), error });
    }
    got(f) {
      this.held.push(f);
      if (mode !== 'safari') return; // 'hold': only on flush
      while (this.held.length > 4) this.output(this.held.splice(Math.floor(rnd() * this.held.length), 1)[0]);
    }
    release() {
      while (this.held.length) this.output(this.held.splice(Math.floor(rnd() * this.held.length), 1)[0]);
    }
    get state() { return this.real.state; }
    get decodeQueueSize() { return this.real.decodeQueueSize; }
    // (the 'drop' decoder below gives frames as they come, minus every 10th)
    addEventListener(...a) { this.real.addEventListener(...a); }
    configure(c) { this.real.configure(c); }
    decode(c) { this.real.decode(c); }
    async flush() { await this.real.flush(); this.release(); }
    reset() { for (const f of this.held) f.close(); this.held = []; this.real.reset(); }
    close() { for (const f of this.held) f.close(); this.held = []; this.real.close(); }
    static isConfigSupported(c) { return RealVD.isConfigSupported(c); }
  }
  window.VideoDecoder = mode === 'drop' ? class extends ShimDecoder {
    got(f) { if (++this.n % 10 === 5) { f.close(); return; } this.output(f); }
  } : ShimDecoder;
  const RealAE = window.__RealAE;
  // Safari: decoderConfig.description is the whole ES_Descriptor ("magic cookie"), not the AudioSpecificConfig
  const esDescriptor = (asc) => {
    const d = (tag, body) => [tag, 0x80, 0x80, 0x80, body.length, ...body];
    const dcd = d(0x04, [0x40, 0x14, 0x00, 0x18, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, ...d(0x05, [...asc])]);
    return Uint8Array.from(d(0x03, [0x00, 0x00, 0x00, ...dcd, ...d(0x06, [0x02])]));
  };
  window.AudioEncoder = class {
    constructor({ output, error }) {
      this.real = new RealAE({
        error,
        output: (chunk, meta) => {
          const desc = meta?.decoderConfig?.description;
          if (desc && mode === 'safari' && /^mp4a/.test(this.codec)) {
            const asc = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
            meta = { ...meta, decoderConfig: { ...meta.decoderConfig, description: esDescriptor(asc) } };
          }
          output(chunk, meta);
        },
      });
    }
    get state() { return this.real.state; }
    get encodeQueueSize() { return this.real.encodeQueueSize; }
    configure(c) { this.codec = c.codec; this.real.configure(c); }
    encode(d) { this.real.encode(d); }
    flush() { return this.real.flush(); }
    close() { this.real.close(); }
    static isConfigSupported(c) { return RealAE.isConfigSupported(c); }
  };
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/`);
  await p.fill('#email', 'ekspor@najja.id'); await p.fill('#password', 'rahasia-ekspor'); await p.fill('#password2', 'rahasia-ekspor'); await p.fill('#token', TOKEN);
  await p.click('button[type=submit]');
  await p.waitForSelector('body.ready');
  await p.goto(`${BASE}/?debug`);
  await p.waitForSelector('body.ready');
  await p.waitForFunction(() => document.querySelector('.mcp-pill')?.classList.contains('on'));

  step(`proyek 9:16: satu klip ${SECS} dtk (H.264 dengan B-frame, keyframe tiap 1 dtk) + suara 440 Hz`);
  await mcp('new_project', { name: 'E2E ekspor', aspect_ratio: '9:16' });
  const media = await mcp('import_media', { path: 'gerak.mp4' });
  await mcp('add_media_clip', { media_id: media.media_id, track: 'main', start: 0, duration: SECS });
  for (let t = Date.now(); Date.now() - t < 60000; await wait(250)) {
    if (await p.evaluate(async (id) => { const { mediaRT } = await import('/js/media.js'); return !!mediaRT.get(id)?.url; }, media.media_id)) break;
  }

  const runExport = async (mode) => {
    await p.evaluate(installShims, mode);
    const r = await p.evaluate(async () => {
      const { exportVideo } = await import('/js/exporter.js');
      const t0 = performance.now();
      const res = await exportVideo(window.najja.engine, { resolution: '720p', format: 'mp4' });
      const ms = performance.now() - t0;
      const ev = [...(await window.najjaMetrics.snapshot()).events].reverse().find((e) => e.kind === 'export') || {};
      const b = new Uint8Array(await res.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return { mode: res.mode, ms, ev, data: btoa(s) };
    });
    await p.evaluate(installShims, '');
    const f = path.join(dir, `out-${mode || 'chromium'}.mp4`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    return { ...r, file: f };
  };

  const verify = (label, r) => {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', r.file]).toString());
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    const v = probe.streams.find((s) => s.codec_type === 'video');
    check(v?.codec_name === 'h264' && v.width === 720 && v.height === 1280, `${label}: video H.264 720×1280 (${v?.codec_name} ${v?.width}×${v?.height})`);
    // Chromium has no AAC encoder (Opus then); the AAC header Safari's description gives is checked in export-read.test.js
    check(((a?.codec_name === 'aac' && a.profile === 'LC') || a?.codec_name === 'opus') && a.channels === 2 && Number(a.sample_rate) >= 44100,
      `${label}: audio stereo terbaca (${a?.codec_name} ${a?.profile || ''} ${a?.sample_rate} Hz ${a?.channels} ch)`);
    // decoding the whole file (both tracks) gives no error
    const errs = execFileSync('ffmpeg', ['-v', 'error', '-i', r.file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    check(!errs.trim(), `${label}: ffmpeg men-decode seluruh file tanpa error${errs.trim() ? `: ${errs.trim().slice(0, 200)}` : ''}`);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', r.file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
    const smp = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
    let sq = 0;
    for (const x of smp) sq += x * x;
    const rms = Math.sqrt(sq / Math.max(1, smp.length)) / 32768;
    check(rms > 0.25 && smp.length > 8000 * (SECS - 0.5), `${label}: suara ada sepanjang video (RMS ${rms.toFixed(2)}, ${(smp.length / 8000).toFixed(1)} dtk)`);
    // every exported picture is the source picture of its time: best match among the neighbours must be itself
    const out = gray(r.file);
    let same = 0;
    let dup = 0;
    for (let i = 0; i < Math.min(out.length, srcFrames.length); i++) {
      let best = i;
      let bestD = Infinity;
      for (let j = Math.max(0, i - 3); j <= Math.min(srcFrames.length - 1, i + 3); j++) { const d = mad(out[i], srcFrames[j]); if (d < bestD) { bestD = d; best = j; } }
      if (best === i) same++;
      if (i > 0 && mad(out[i], out[i - 1]) < 0.4) dup++;
    }
    const n = Math.min(out.length, srcFrames.length);
    check(out.length >= SECS * 30 - 1, `${label}: ${out.length} frame`);
    check(same / n >= 0.99, `${label}: ${same}/${n} frame tepat gambar sumbernya (urutan benar)`);
    check(dup / n <= 0.01, `${label}: frame berulang ${dup}/${n} (${((dup / n) * 100).toFixed(1)}%)`);
  };

  step('A. Chromium apa adanya');
  const A = await runExport('');
  check(A.mode === 'fast' && !A.ev.fallback, `ekspor cepat, tanpa fallback (${A.mode}${A.ev.fallback ? `: ${A.ev.fallback}` : ''}) · ${(A.ms / 1000).toFixed(1)} dtk`);
  verify('A', A);
  console.log(`   decoder: ${A.ev.video_frames} frame · terlambat ${A.ev.video_stale} · hilang ${A.ev.video_lost} · flush ${A.ev.decoder_flushes} · ${A.ev.audio_config}`);

  step('B. Perilaku Safari: frame keluar tidak urut + ditahan, deskripsi audio = ES_Descriptor');
  const B = await runExport('safari');
  check(B.mode === 'fast' && !B.ev.fallback, `ekspor cepat, tanpa fallback (${B.mode}${B.ev.fallback ? `: ${B.ev.fallback}` : ''}) · ${(B.ms / 1000).toFixed(1)} dtk`);
  verify('B', B);
  check(!B.ev.video_stale && !B.ev.video_lost, `B: tidak ada frame terlambat/hilang (${B.ev.video_stale}/${B.ev.video_lost})`);

  step('C. Decoder yang menahan semua frame sampai flush');
  const C = await runExport('hold');
  check(C.mode === 'fast' && !C.ev.fallback, `ekspor cepat, tanpa fallback (${C.mode}${C.ev.fallback ? `: ${C.ev.fallback}` : ''}) · ${(C.ms / 1000).toFixed(1)} dtk`);
  check(C.ev.decoder_resyncs >= 1 && C.ev.decoder_flushes >= SECS - 1, `C: flush di keyframe (flush ${C.ev.decoder_flushes}, ulang ${C.ev.decoder_resyncs})`);
  verify('C', C);

  step('D. Decoder yang menghilangkan 1 dari 10 frame → jangan simpan video patah-patah');
  const D = await runExport('drop');
  check(D.mode === 'realtime' && /dropped frames|holds frames/.test(D.ev.fallback || ''), `fallback ke real-time: ${D.ev.fallback}`);
  check(D.ev.video_lost > 0 || /holds frames/.test(D.ev.fallback || ''), `D: frame hilang terhitung (${D.ev.video_lost})`);

  check(!errors.length, `tidak ada error halaman${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  cleanup();
}
console.log(failed ? `\n${failed} cek GAGAL` : '\nsemua cek ekspor lolos');
process.exit(failed ? 1 : 0);
