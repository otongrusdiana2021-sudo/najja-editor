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
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AI_KEEP_DAYS = 3;
const TOOLS = new Set(['cutout', 'upscale']);
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

export function createAi({ dataDir, jobs, log = () => {}, env = process.env }) {
  const dir = path.join(dataDir, 'ai');
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
      out = { available: !!h.ok, reason: h.ok ? null : h.deps?.error || 'dependensi AI belum lengkap', tools: { cutout: tool(cut), upscale: tool('upscale') }, memory: h.memory, busy: !!h.busy };
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
      const name = tool === 'cutout' ? h.cutoutModel || 'cutout' : 'upscale';
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
  async function create({ owner, tool, image, mime, scale = 2, name = '' }) {
    if (!TOOLS.has(tool)) throw Object.assign(new Error('Alat tidak dikenal'), { status: 400 });
    const ext = IMAGE_EXT[String(mime || '').split(';')[0].trim().toLowerCase()];
    if (!ext) throw Object.assign(new Error('Format gambar harus PNG, JPEG, atau WebP'), { status: 400 });
    if (!image?.length) throw Object.assign(new Error('Gambar kosong'), { status: 400 });
    const id = `ai_${crypto.randomBytes(8).toString('hex')}`;
    await fsp.mkdir(path.join(dir, id), { recursive: true });
    await fsp.writeFile(path.join(dir, id, `input${ext}`), image);
    const meta = { id, ownerId: owner, tool, scale: Number(scale) >= 4 ? 4 : 2, name: String(name || '').slice(0, 80), input: `input${ext}`, createdAt: Date.now(), result: null };
    await writeMeta(meta);
    const job = await jobs.enqueue({ kind: 'ai', key: `ai:${id}`, data: { id, tool }, owner });
    const cur = (await readMeta(id)) || meta; // (the job may already have written its result)
    cur.jobId = job.id;
    await writeMeta(cur);
    return publicRecord(cur);
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
      error: state === 'failed' || state === 'cancelled' ? job?.error || meta.error || 'gagal' : null,
      inputUrl: `/api/ai/${meta.id}/input`,
      resultUrl: meta.result ? `/api/ai/${meta.id}/result` : null,
      result: meta.result ? { width: meta.result.width, height: meta.result.height, type: meta.result.file.endsWith('.png') ? 'image/png' : 'image/jpeg', ms: meta.result.ms, model: meta.result.model, subject: meta.result.subject || null } : null,
      createdAt: meta.createdAt,
    };
  }

  /** The job: send the files to the AI service and follow its progress lines. */
  jobs.register('ai', {
    cls: 'ai',
    maxAttempts: 2,
    timeoutMs: () => 10 * 60_000,
    async run(job, ctx) {
      const meta = await readMeta(job.data.id);
      if (!meta) throw Object.assign(new Error('permintaan sudah dihapus'), { permanent: true });
      await waitModel(meta.tool, meta.id, ctx);
      const res = await call('/run', {
        method: 'POST',
        // (relative to the ai folder: the AI container may see the data volume at another path)
        body: { task: meta.tool, input: `${meta.id}/${meta.input}`, output: `${meta.id}/result`, scale: meta.scale },
        signal: ctx.signal,
        timeout: 0,
      });
      if (!res.ok) throw new Error(`AI service: HTTP ${res.status}`);
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
          if (msg.done) done = msg.done;
          if (msg.error) error = msg.error;
        }
      }
      if (error || !done) throw Object.assign(new Error(error || 'layanan AI berhenti tanpa hasil'), { permanent: /memori|dibatalkan|format|cannot identify/i.test(error || '') });
      const fresh = (await readMeta(meta.id)) || meta;
      fresh.result = { file: done.file, width: done.width, height: done.height, ms: done.ms, model: done.model, subject: done.subject || null };
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

  return {
    status,
    create,
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
