// AI tools of the home screen (v1.8): background removal and image upscaling for thumbnails.
//
// The models run in a separate Python service (ai/server.py): under Docker its own container ("ai", see
// Dockerfile.ai and docker-compose.yml), reached at NAJJA_AI_URL; on a PC without that variable the Node server
// starts it itself when python3 with onnxruntime is there. Either way this module only talks HTTP to it, so a model
// that runs out of memory takes down the AI service, never the editor.
//
// Every request is a job in the shared queue (class "ai": one at a time), with progress and cancel. Files live in
// <data>/ai/<id>/ (input, result, meta.json with the owner); they are removed after AI_KEEP_DAYS.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AI_KEEP_DAYS = 3;
const TOOLS = new Set(['cutout', 'upscale', 'transcribe']);
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
// transcribe (v1.9): the editor sends the mixed speech as 16-bit WAV (16 kHz mono)
const AUDIO_EXT = { 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav' };
const LANG = /^(auto|[a-z]{2,3}(-[a-z]{2,4})?)$/i;
const FFMPEG = process.env.NAJJA_FFMPEG || 'ffmpeg';
// background removal of a video (v1.11: when the device has no WebGPU): frames per second it is analysed at — the
// editor picks 8..15 so a clip stays within its frame budget (bgremove.js analysisPlan)
export const CUTOUT_FPS = { min: 4, max: 30, default: 15 };
const MAX_CUTOUT_FRAMES = 3600;

export function createAi({ dataDir, jobs, log = () => {}, env = process.env }) {
  const dir = path.join(dataDir, 'ai');
  // the masks of videos stay (projects use them): <data>/masks/<id>.bin.gz + <id>.json (owner, media, times)
  const masksDir = path.join(dataDir, 'masks');
  let base = env.NAJJA_AI_URL ? env.NAJJA_AI_URL.replace(/\/$/, '') : null;
  const token = env.NAJJA_AI_TOKEN || null;
  let child = null;
  let starting = null;
  let lastStatus = null;
  let lastAt = 0;

  /** Start the Python service on this machine (only without NAJJA_AI_URL). Resolves its URL, or null. */
  function startLocal() {
    if (base || env.NAJJA_AI === 'off') return Promise.resolve(base);
    if (starting) return starting;
    starting = new Promise((resolve) => {
      const py = env.NAJJA_AI_PYTHON || 'python3';
      // (on a PC models are fetched when a tool is first used, not every time the editor starts)
      const args = [path.join(ROOT, 'ai', 'server.py'), '--host', '127.0.0.1', '--port', '0', '--data', dataDir, '--no-download', '--exit-with-parent'];
      if (env.NAJJA_AI_MODELS) args.push('--models', env.NAJJA_AI_MODELS);
      let done = false;
      const finish = (url) => { if (!done) { done = true; resolve(url); } };
      try {
        child = spawn(py, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, NAJJA_AI_TOKEN: token || '' } });
      } catch { finish(null); return; }
      child.on('error', () => finish(null));
      child.on('exit', (code) => {
        log(`AI service stopped (${code})`);
        child = null;
        base = null;
        starting = null; // try again on the next request
        finish(null);
      });
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        const m = /NAJJA-AI LISTENING (\d+)/.exec(buf);
        if (m) { base = `http://127.0.0.1:${m[1]}`; log(`AI service on ${base}`); finish(base); }
      });
      child.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) log(s.slice(0, 300)); });
      setTimeout(() => finish(null), 15000).unref?.();
    });
    return starting;
  }

  async function call(route, { method = 'GET', body = null, signal = null, timeout = 4000 } = {}) {
    const url = base || (await startLocal());
    if (!url) throw Object.assign(new Error('Layanan AI tidak berjalan di server ini.'), { status: 503, code: 'ai_unavailable' });
    const ctl = new AbortController();
    const timer = timeout ? setTimeout(() => ctl.abort(new Error('AI service timeout')), timeout) : null;
    signal?.addEventListener('abort', () => ctl.abort(signal.reason), { once: true });
    try {
      return await fetch(`${url}${route}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { 'x-najja-ai-token': token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** What the AI service can do now: the home screen enables its tools from this. Cached for 2 s. */
  async function status() {
    if (lastStatus && Date.now() - lastAt < 2000) return lastStatus;
    let out;
    try {
      const h = await (await call('/health')).json();
      const m = h.models || {};
      const cut = h.cutoutModel || 'cutout';
      const tool = (name) => ({ state: m[name]?.state || 'missing', progress: m[name]?.progress || 0, error: m[name]?.error || null, model: m[name]?.title || name });
      const tr = h.whisperModel || 'whisper-base';
      out = {
        available: !!h.ok,
        reason: h.ok ? null : h.deps?.error || 'dependensi AI belum lengkap',
        tools: { cutout: tool(cut), upscale: tool('upscale'), transcribe: { ...tool(tr), available: !!h.transcribe, reason: h.transcribe ? null : 'Transkripsi belum terpasang di layanan AI (jalankan ulang installer Najja).' } },
        memory: h.memory,
        busy: !!h.busy,
      };
    } catch (err) {
      out = { available: false, reason: err.code === 'ai_unavailable' ? err.message : 'Layanan AI belum siap (sedang dimulai atau dipasang).', tools: {} };
    }
    lastStatus = out;
    lastAt = Date.now();
    return out;
  }

  const stages = new Map(); // request id -> what its job is doing now (in memory: 'download' while fetching a model)

  /** Wait until the model a tool needs is on the server (fetched once, the first time). Reports its progress. */
  async function waitModel(tool, id, ctx) {
    let asked = 0;
    for (;;) {
      if (ctx.signal.aborted) throw ctx.signal.reason || new Error('dibatalkan');
      const h = await (await call('/health', { signal: ctx.signal })).json();
      if (!h.ok) throw Object.assign(new Error(h.deps?.error || 'dependensi AI belum lengkap'), { permanent: true });
      if (tool === 'transcribe' && !h.transcribe) throw Object.assign(new Error('Transkripsi belum terpasang di layanan AI (jalankan ulang installer Najja).'), { permanent: true });
      const name = tool === 'cutout' || tool === 'cutoutvideo' ? h.cutoutModel || 'cutout' : tool === 'transcribe' ? h.whisperModel || 'whisper-base' : 'upscale';
      const st = h.models?.[name] || {};
      if (st.state === 'ready') { stages.delete(id); return; }
      stages.set(id, 'download');
      ctx.progress(Math.min(0.2, (st.progress || 0) * 0.2));
      if ((st.state === 'missing' || st.state === 'error') && Date.now() - asked > 30_000) {
        asked = Date.now();
        await call('/models/ensure', { method: 'POST', body: { names: [name] }, signal: ctx.signal }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const metaPath = (id) => path.join(dir, id, 'meta.json');
  async function readMeta(id) {
    if (!/^ai_[0-9a-f]{16}$/.test(id)) return null;
    try { return JSON.parse(await fsp.readFile(metaPath(id), 'utf8')); } catch { return null; }
  }
  async function writeMeta(meta) {
    const tmp = `${metaPath(meta.id)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(meta));
    await fsp.rename(tmp, metaPath(meta.id));
  }

  /** A new request: the image (PNG/JPEG/WebP bytes) of `owner`. Resolves the public record. */
  async function create({ owner, tool, image, mime, scale = 2, name = '', language = 'auto' }) {
    if (!TOOLS.has(tool)) throw Object.assign(new Error('Alat tidak dikenal'), { status: 400 });
    const type = String(mime || '').split(';')[0].trim().toLowerCase();
    const ext = tool === 'transcribe' ? AUDIO_EXT[type] : IMAGE_EXT[type];
    if (!ext) throw Object.assign(new Error(tool === 'transcribe' ? 'Audio harus WAV' : 'Format gambar harus PNG, JPEG, atau WebP'), { status: 400 });
    if (!image?.length) throw Object.assign(new Error(tool === 'transcribe' ? 'Audio kosong' : 'Gambar kosong'), { status: 400 });
    if (tool === 'transcribe' && !LANG.test(String(language || 'auto'))) throw Object.assign(new Error('Bahasa tidak dikenal'), { status: 400 });
    const id = `ai_${crypto.randomBytes(8).toString('hex')}`;
    await fsp.mkdir(path.join(dir, id), { recursive: true });
    await fsp.writeFile(path.join(dir, id, `input${ext}`), image);
    const meta = { id, ownerId: owner, tool, scale: Number(scale) >= 4 ? 4 : 2, name: String(name || '').slice(0, 80), input: `input${ext}`, createdAt: Date.now(), result: null,
      ...(tool === 'transcribe' ? { language: String(language || 'auto').toLowerCase() } : {}) };
    await writeMeta(meta);
    const job = await jobs.enqueue({ kind: 'ai', key: `ai:${id}`, data: { id, tool }, owner });
    const cur = (await readMeta(id)) || meta; // (the job may already have written its result)
    cur.jobId = job.id;
    await writeMeta(cur);
    return publicRecord(cur);
  }

  /**
   * A background removal of a video: the subject (people and every object in front) of every frame of `file` from
   * `start` to `end` (seconds), `fps` frames a second. Resolves the public record; its result is a mask set.
   */
  async function createVideo({ owner, file, mediaId, start = 0, end, fps = 15, name = '' }) {
    fps = Math.round(Number(fps)) || CUTOUT_FPS.default;
    fps = Math.min(CUTOUT_FPS.max, Math.max(CUTOUT_FPS.min, fps));
    start = Math.max(0, Number(start) || 0);
    end = Number(end);
    if (!(end > start)) throw Object.assign(new Error('Rentang video tidak valid'), { status: 400 });
    const frames = Math.ceil((end - start) * fps);
    if (frames > MAX_CUTOUT_FRAMES) throw Object.assign(new Error(`Terlalu panjang: ${frames} frame (maks ${MAX_CUTOUT_FRAMES}). Potong klipnya dulu.`), { status: 400 });
    if (!file || !fs.existsSync(file)) throw Object.assign(new Error('File media tidak ditemukan di server'), { status: 404 });
    const id = `ai_${crypto.randomBytes(8).toString('hex')}`;
    await fsp.mkdir(path.join(dir, id), { recursive: true });
    const meta = { id, ownerId: owner, tool: 'cutoutvideo', name: String(name || '').slice(0, 80), input: 'frames', source: file, video: { mediaId, start, end, fps, frames }, createdAt: Date.now(), result: null };
    await writeMeta(meta);
    const job = await jobs.enqueue({ kind: 'ai', key: `ai:${id}`, data: { id, tool: 'cutoutvideo', frames }, owner });
    const cur = (await readMeta(id)) || meta;
    cur.jobId = job.id;
    await writeMeta(cur);
    return publicRecord(cur);
  }

  /** The frames of the video part as JPEGs (long side 640) in <job>/frames: ffmpeg, before the model runs. */
  function extractFrames(meta, signal) {
    const out = path.join(dir, meta.id, 'frames');
    const v = meta.video;
    return new Promise((resolve, reject) => {
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', v.start.toFixed(3), '-i', meta.source, '-t', (v.end - v.start).toFixed(3),
        '-vf', `fps=${v.fps},scale='if(gt(iw,ih),640,-2)':'if(gt(iw,ih),-2,640)'`, '-an', '-q:v', '3', path.join(out, '%05d.jpg')];
      const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      const stop = () => { try { p.kill('SIGKILL'); } catch { /* gone */ } };
      signal?.addEventListener('abort', stop, { once: true });
      // (never stuck here: a read that takes far longer than decoding should is stopped, and the job tries again)
      let timedOut = false;
      const limit = setTimeout(() => { timedOut = true; stop(); }, Math.max(120_000, (v.end - v.start) * 20_000));
      p.on('exit', () => clearTimeout(limit));
      p.on('error', (e) => reject(Object.assign(new Error(`ffmpeg tidak bisa dijalankan: ${e.message}`), { permanent: true })));
      p.on('exit', (code) => {
        signal?.removeEventListener('abort', stop);
        const n = fs.readdirSync(out).filter((f) => f.endsWith('.jpg')).length;
        if (code === 0 && n) resolve(n);
        else if (timedOut) reject(new Error('membaca frame video terlalu lama'));
        else reject(Object.assign(new Error(`frame video tidak bisa dibaca${err ? `: ${err.trim().slice(0, 200)}` : ''}`), { permanent: true }));
      });
    });
  }

  const maskRecord = (m) => ({ id: m.id, url: `/api/masks/${m.id}`, mediaId: m.mediaId, start: m.start, end: m.end, fps: m.fps, n: m.n, w: m.w, h: m.h, model: m.model });
  async function readMask(id) {
    if (!/^ai_[0-9a-f]{16}$/.test(id)) return null;
    try { return JSON.parse(await fsp.readFile(path.join(masksDir, `${id}.json`), 'utf8')); } catch { return null; }
  }

  function publicRecord(meta) {
    const job = meta.jobId ? jobs.get(meta.jobId) : null;
    const state = meta.result ? 'done' : job ? ({ queued: 'queued', running: 'running', succeeded: 'done', failed: 'failed', cancelled: 'cancelled' }[job.state] || job.state) : 'failed';
    return {
      id: meta.id,
      tool: meta.tool,
      scale: meta.scale,
      name: meta.name,
      state,
      progress: meta.result ? 1 : job?.progress || 0,
      stage: meta.result ? null : stages.get(meta.id) || null,
      // (queued again after a failed attempt: why, so the editor can say it is trying again)
      retrying: !meta.result && job?.state === 'queued' && job.attempts > 0 ? job.error || 'mencoba lagi' : null,
      error: state === 'failed' || state === 'cancelled' ? job?.error || meta.error || 'gagal' : null,
      inputUrl: `/api/ai/${meta.id}/input`,
      resultUrl: meta.result ? `/api/ai/${meta.id}/result` : null,
      ...(meta.tool === 'cutoutvideo' ? { video: meta.video, masks: meta.result?.masks || null } : {}),
      result: !meta.result ? null : meta.tool === 'cutoutvideo' ? { masks: meta.result.masks, model: meta.result.model, ms: meta.result.ms } : meta.tool === 'transcribe'
        ? { type: 'application/json', ms: meta.result.ms, model: meta.result.model, language: meta.result.language, duration: meta.result.duration, segments: meta.result.segments }
        : { width: meta.result.width, height: meta.result.height, type: meta.result.file.endsWith('.png') ? 'image/png' : 'image/jpeg', ms: meta.result.ms, model: meta.result.model, subject: meta.result.subject || null },
      createdAt: meta.createdAt,
    };
  }

  /** The job: send the files to the AI service and follow its progress lines. */
  jobs.register('ai', {
    cls: 'ai',
    maxAttempts: 2,
    // (a long recording through Whisper on one core takes a while)
    // (a video's background: about 5 s a frame with BiRefNet on one core — the limit leaves plenty of room)
    timeoutMs: (job) => (job?.data?.tool === 'cutoutvideo' ? Math.min(12 * 3600_000, 10 * 60_000 + (job.data.frames || 100) * 20_000) : (job?.data?.tool === 'transcribe' ? 45 : 10) * 60_000),
    async run(job, ctx) {
      const meta = await readMeta(job.data.id);
      if (!meta) throw Object.assign(new Error('permintaan sudah dihapus'), { permanent: true });
      if (meta.tool === 'cutoutvideo') {
        stages.set(meta.id, 'frames');
        try {
          meta.video.frames = await extractFrames(meta, ctx.signal);
        } catch (err) { stages.delete(meta.id); throw err; } // (a retry shows as one, not as frames forever)
        await writeMeta(meta);
      }
      await waitModel(meta.tool, meta.id, ctx);
      const res = await call('/run', {
        method: 'POST',
        // (relative to the ai folder: the AI container may see the data volume at another path)
        body: { task: meta.tool, input: `${meta.id}/${meta.input}`, output: `${meta.id}/result`, scale: meta.scale, language: meta.language },
        signal: ctx.signal,
        timeout: 0,
      });
      if (!res.ok) { stages.delete(meta.id); throw new Error(`AI service: HTTP ${res.status}`); }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let done = null;
      let error = null;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.progress != null) ctx.progress(msg.progress);
          if (typeof msg.stage === 'string' && msg.stage.startsWith('frame')) stages.set(meta.id, msg.stage);
          if (msg.done) done = msg.done;
          if (msg.error) error = msg.error;
        }
      }
      if (error || !done) stages.delete(meta.id);
      if (error || !done) throw Object.assign(new Error(error || 'layanan AI berhenti tanpa hasil'), { permanent: /memori|dibatalkan|format|cannot identify/i.test(error || '') });
      if (meta.tool === 'cutoutvideo') {
        // the masks are kept with the projects (not removed with the request after AI_KEEP_DAYS)
        await fsp.mkdir(masksDir, { recursive: true });
        await fsp.copyFile(path.join(dir, meta.id, path.basename(done.file)), path.join(masksDir, `${meta.id}.bin.gz`));
        const v = meta.video;
        const mrec = { id: meta.id, ownerId: meta.ownerId, mediaId: v.mediaId, start: v.start, end: v.end, fps: v.fps, n: done.frames, w: done.width, h: done.height, model: done.model, createdAt: Date.now() };
        await fsp.writeFile(path.join(masksDir, `${meta.id}.json`), JSON.stringify(mrec));
        await fsp.rm(path.join(dir, meta.id, 'frames'), { recursive: true, force: true }).catch(() => {});
        const fresh = (await readMeta(meta.id)) || meta;
        fresh.result = { file: done.file, model: done.model, ms: done.ms, masks: maskRecord(mrec) };
        await writeMeta(fresh);
        stages.delete(meta.id);
        return { ok: true };
      }
      const fresh = (await readMeta(meta.id)) || meta;
      fresh.result = { file: done.file, width: done.width, height: done.height, ms: done.ms, model: done.model, subject: done.subject || null,
        ...(meta.tool === 'transcribe' ? { language: done.language, duration: done.duration, segments: done.segments } : {}) };
      await writeMeta(fresh);
      return { ok: true };
    },
  });

  /** Old requests and their files go away after AI_KEEP_DAYS. */
  async function cleanup() {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return; }
    const cutoff = Date.now() - AI_KEEP_DAYS * 86400_000;
    for (const n of names) {
      const meta = await readMeta(n);
      if (!meta && !/^ai_[0-9a-f]{16}$/.test(n)) continue;
      if (meta && meta.createdAt > cutoff) continue;
      if (meta?.jobId && jobs.active(`ai:${n}`)) continue;
      await fsp.rm(path.join(dir, n), { recursive: true, force: true }).catch(() => {});
    }
  }
  setInterval(() => cleanup().catch(() => {}), 6 * 3600_000).unref?.();
  cleanup().catch(() => {});

  /**
   * (v1.11) A mask set made on the editor's device (BiRefNet on its GPU): kept like the server's, for its owner.
   * body: the masks (n × w × h bytes), gzip when `gzip`. Resolves the mask record.
   */
  async function saveMask({ owner, mediaId, start, end, fps, n, w, h, model, body, gzip }) {
    [start, end, fps, n, w, h] = [start, end, fps, n, w, h].map(Number);
    if (!(end > start && fps > 0 && n >= 1 && n <= MAX_CUTOUT_FRAMES && w >= 1 && w <= 1024 && h >= 1 && h <= 1024)) throw Object.assign(new Error('Ukuran masker tidak valid'), { status: 400 });
    let raw;
    try { raw = gzip ? zlib.gunzipSync(body, { maxOutputLength: n * w * h + 1 }) : body; } catch { throw Object.assign(new Error('Masker rusak'), { status: 400 }); }
    if (raw.length !== n * w * h) throw Object.assign(new Error(`Masker tidak lengkap (${raw.length} dari ${n * w * h} byte)`), { status: 400 });
    const id = `ai_${crypto.randomBytes(8).toString('hex')}`;
    await fsp.mkdir(masksDir, { recursive: true });
    await fsp.writeFile(path.join(masksDir, `${id}.bin.gz`), gzip ? body : zlib.gzipSync(raw, { level: 6 }));
    const mrec = { id, ownerId: owner, mediaId, start, end, fps, n, w, h, model: String(model || 'device').slice(0, 40), engine: 'device', createdAt: Date.now() };
    await fsp.writeFile(path.join(masksDir, `${id}.json`), JSON.stringify(mrec));
    return maskRecord(mrec);
  }

  return {
    status,
    create,
    createVideo,
    saveMask,
    /** A mask set (file path and record) of a video, when the caller owns it. */
    async mask(id, owns) {
      const m = await readMask(id);
      if (!m || !owns(m)) return null;
      const p = path.join(masksDir, `${id}.bin.gz`);
      return fs.existsSync(p) ? { path: p, record: maskRecord(m) } : null;
    },
    async get(id, owns) {
      const meta = await readMeta(id);
      if (!meta || !owns(meta)) return null;
      return publicRecord(meta);
    },
    /** Absolute path of the input or result file of a request the caller owns, or null. */
    async file(id, which, owns) {
      const meta = await readMeta(id);
      if (!meta || !owns(meta)) return null;
      const f = which === 'input' ? meta.input : meta.result?.file;
      if (!f) return null;
      const p = path.join(dir, id, path.basename(f));
      return fs.existsSync(p) ? p : null;
    },
    async remove(id, owns) {
      const meta = await readMeta(id);
      if (!meta || !owns(meta)) return false;
      const j = jobs.active(`ai:${id}`);
      if (j) await jobs.cancel(j.id).catch(() => {});
      await fsp.rm(path.join(dir, id), { recursive: true, force: true });
      return true;
    },
    stop() { try { child?.kill(); } catch { /* gone */ } },
    cleanup,
  };
}
