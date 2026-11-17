// "Hapus latar otomatis" (v1.11), like a phone editor's auto background removal: one switch; the background goes,
// every object in front stays (people, products, bags, animals…). The clip is analysed once:
//   device  BiRefNet on this device's GPU (WebGPU, bgdevice.js) — fast; the masks are then kept on the server
//   server  the same model on the Najja server (lib/ai.js "cutoutvideo") — when this browser has no WebGPU
// This module chooses the engine, runs it (with progress, cancel, and again after the project is opened or an undo),
// and puts the masks on the clips. Masks that cover a clip (a duplicate, another clip of the same video) are reused.
import { store, setBgState } from './store.js';
import { mediaRT } from './media.js';
import { loadMaskSet, putMaskSet } from './segment.js';
import { deviceSupport, analyzeOnDevice, gzipMasks, MODEL_NAME } from './bgdevice.js';

const DEVICE_FRAMES = 450; // (frames analysed at most: short clips get every frame, long ones fewer — blended between)
const SERVER_FRAMES = 240;
const tasks = new Map(); // clipId → { engine: 'device', state, stage, p, frame, frames, eta, error, ctl }
const jobs = new Map(); // server job id → { state, stage, p, frame, frames, eta, error, retrying }
const watching = new Set();
const listeners = new Set();
/** UI hook: fn(clipId | null) whenever an analysis moves on. */
export const onBgProgress = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (clipId = null) => { for (const fn of listeners) { try { fn(clipId); } catch { /* ignore */ } } };

/** Where the analysis of a clip is: { engine, state: 'running'|'error'|'cancelled', stage, p, frame, frames, eta, error } or null. */
export function bgStatus(c) {
  if (!c) return null;
  const t = tasks.get(c.id) || (c.cutout?.enabled && !c.cutout.masks ? sharedTask(c) : null);
  if (t) return t;
  const id = c.cutout?.job?.id;
  return id ? { engine: 'server', ...(jobs.get(id) || { state: 'running', stage: 'queued', p: 0 }) } : null;
}
/** An analysis on this device of the same video that will cover this clip too (a duplicate switched on meanwhile). */
function sharedTask(c) {
  if (c.type !== 'video') return null;
  const plan = analysisPlan(c, 'device');
  for (const t of tasks.values()) {
    if (t.state === 'running' && t.mediaId === c.mediaId && t.plan && t.plan.start <= plan.start + 0.05 && t.plan.end >= plan.end - 0.05) return t;
  }
  return null;
}
setBgState((c) => bgStatus(c)?.state || null);

/** The part of the media a clip shows (seconds), half a second of room on each side, and how many frames a second. */
export function analysisPlan(c, engine = 'device') {
  const m = store.media(c.mediaId);
  if (c.type === 'image') return { start: 0, end: 0.1, fps: 10 };
  const sp = Math.abs(c.speed || 1);
  const dur = m?.duration || (c.in || 0) + c.duration * sp;
  const start = Math.max(0, (c.in || 0) - 0.5);
  const end = Math.min(dur, (c.in || 0) + c.duration * sp + 0.5);
  const budget = engine === 'device' ? DEVICE_FRAMES : SERVER_FRAMES;
  const fps = Math.max(engine === 'device' ? 10 : 8, Math.min(m?.fps || 30, engine === 'device' ? 30 : 15, Math.floor(budget / Math.max(0.1, end - start))));
  return { start, end, fps };
}
/** Whether the clip now shows a part of its media the masks do not cover (trimmed or extended after the analysis). */
export function bgStale(c) {
  const m = c.cutout?.masks;
  if (!m) return false;
  if (m.mediaId && m.mediaId !== c.mediaId) return true;
  if (c.type === 'image') return false;
  const sp = Math.abs(c.speed || 1);
  return (c.in || 0) < m.start - 0.05 || (c.in || 0) + c.duration * sp > m.end + 0.05;
}

let deviceFailed = null; // (the GPU could not run the model once: the server does it for the rest of the session)
/** Which engine can do it here: { engine: 'device'|'server'|null, reason }. */
export async function bgEngine() {
  const d = deviceFailed ? { ok: false, reason: deviceFailed } : await deviceSupport();
  if (d.ok) return { engine: 'device' };
  try {
    const st = await (await fetch('/api/ai', { cache: 'no-store', credentials: 'same-origin' })).json();
    if (st.available) return { engine: 'server', reason: d.reason };
    return { engine: null, reason: `${d.reason}, dan layanan AI di server belum siap (${st.reason || 'tidak aktif'})` };
  } catch { return { engine: null, reason: `${d.reason}, dan server tidak bisa dihubungi` }; }
}

/** Wait until the server has the whole file of a media (an imported video is used at once, uploaded after). */
async function uploaded(mediaId, onWait = () => {}) {
  for (let t0 = Date.now(); Date.now() - t0 < 30 * 60_000;) {
    const up = mediaRT.get(mediaId)?.upload;
    if (!up) return;
    if (up.state === 'error') throw new Error(`video belum terunggah ke server (${up.error}). Coba unggah ulang dulu.`);
    onWait(up.progress || 0);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('video terlalu lama diunggah ke server');
}
/** POST that waits while the server is still putting the upload together (409 "uploading"). */
async function postWhileUploading(url, init) {
  for (let k = 0; ; k++) {
    const res = await fetch(url, { credentials: 'same-origin', ...init });
    const rec = await res.json().catch(() => ({}));
    if (res.status === 409 && rec.code === 'uploading' && k < 60) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (!res.ok) throw new Error(rec.error || `HTTP ${res.status}`);
    return rec;
  }
}

/** Masks that already cover a clip (another clip or a duplicate of the same video), or null. */
function reusable(c, plan) {
  return store.P.clips.map((x) => x.cutout?.masks).find((m) => m && m.mediaId === c.mediaId && m.start <= plan.start + 0.05 && m.end >= plan.end - 0.05 && m.fps >= plan.fps * 0.6) || null;
}
/** Put masks on every clip of that media that is waiting for them (no undo step: it is the result of the switch). */
function applyMasks(masks, { jobId = null, clipId = null } = {}) {
  let n = 0;
  for (const x of store.P.clips) {
    if (!x.cutout?.enabled) continue;
    const waiting = (jobId && x.cutout.job?.id === jobId) || x.id === clipId || (!x.cutout.masks && x.mediaId === masks.mediaId && !x.cutout.job);
    if (!waiting || bgStale({ ...x, cutout: { masks } })) continue;
    x.cutout.masks = masks;
    x.cutout.job = null;
    n++;
  }
  if (n) store.touch('Hapus latar siap');
  return n;
}

/** Turn "Hapus latar otomatis" on for a clip and analyse it (unless masks covering it are there). */
export async function startBgRemove(clipId) {
  const c = store.clip(clipId);
  if (!c || (c.type !== 'video' && c.type !== 'image')) throw new Error('Hapus latar belakang untuk klip video atau foto');
  // (already being analysed — this clip, or the same video for another clip that covers it: no second analysis)
  if (tasks.get(clipId)?.state === 'running' || (c.cutout?.enabled && !c.cutout.masks && c.cutout.job)) return { running: true };
  const shared = !c.cutout?.masks && sharedTask(c);
  if (shared) {
    store.mutate('Hapus latar otomatis', () => { const x = store.clip(clipId); x.cutout = { threshold: 0.5, edge: 0.2, ...(x.cutout || {}), enabled: true, job: null }; delete x.cutout.mode; delete x.cutout.fps; });
    emit(clipId);
    return { running: true };
  }
  const eng = await bgEngine();
  const plan = analysisPlan(c, eng.engine || 'device');
  const old = c.cutout?.job?.id;
  const reuse = !bgStale(c) && c.cutout?.masks ? c.cutout.masks : reusable(c, plan);
  store.mutate('Hapus latar otomatis', () => {
    const x = store.clip(clipId);
    x.cutout = { threshold: 0.5, edge: 0.2, ...(x.cutout || {}), enabled: true, job: null, ...(reuse ? { masks: reuse } : {}) };
    delete x.cutout.mode; // (v1.10 modes are gone)
    delete x.cutout.fps;
  });
  if (old) fetch(`/api/ai/${old}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  if (reuse) { loadMaskSet(reuse).catch(() => {}); emit(clipId); return { reused: true }; }
  if (!eng.engine) {
    store.mutate('Hapus latar mati', () => { store.clip(clipId).cutout.enabled = false; });
    throw new Error(`Hapus latar otomatis belum bisa di sini: ${eng.reason}`);
  }
  if (eng.engine === 'device') return runDevice(clipId, plan);
  return runServer(clipId, plan);
}

/** Analyse the clip again (after trimming it outside its masks, or after a failure). */
export function redoBgRemove(clipId) {
  store.mutate('Hapus latar ulang', () => { const x = store.clip(clipId); if (x?.cutout) { x.cutout.masks = null; x.cutout.job = null; } });
  return startBgRemove(clipId);
}

async function runDevice(clipId, plan) {
  const c = store.clip(clipId);
  const ctl = new AbortController();
  const task = { engine: 'device', state: 'running', stage: 'model', p: 0, ctl, mediaId: c.mediaId, plan };
  tasks.set(clipId, task);
  emit(clipId);
  let last = 0;
  const tick = () => { const now = performance.now(); if (now - last > 150) { last = now; emit(clipId); } };
  try {
    const res = await analyzeOnDevice({ mediaId: c.mediaId, ...plan, signal: ctl.signal, onProgress: (u) => { Object.assign(task, u); tick(); } });
    Object.assign(task, { stage: 'save', p: 1 });
    emit(clipId);
    await uploaded(c.mediaId, (p) => { Object.assign(task, { stage: 'upload', p }); tick(); });
    if (ctl.signal.aborted) throw new Error('Dibatalkan');
    const { body, gzip } = await gzipMasks(res.data);
    const q = new URLSearchParams({ mediaId: c.mediaId, start: plan.start, end: plan.end, fps: plan.fps, n: res.n, w: res.w, h: res.h, model: MODEL_NAME });
    const rec = await postWhileUploading(`/api/masks?${q}`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', 'x-najja-gzip': gzip ? '1' : '0' } });
    putMaskSet(rec, res.data);
    tasks.delete(clipId);
    applyMasks(rec, { clipId });
    emit(clipId);
    return { masks: rec };
  } catch (err) {
    const cancelled = ctl.signal.aborted;
    // (the GPU could not load or run the model — too little memory, an old driver: the server does it instead)
    // (a video this browser cannot read, a GPU error midway: only this clip goes to the server)
    if (!cancelled && ['model', 'init', 'frames'].includes(task.stage) && !/model AI tidak bisa diunduh|pustaka AI/.test(err.message)) {
      if (task.stage !== 'frames') deviceFailed = 'GPU perangkat ini gagal menjalankan model AI';
      console.warn('[najja] hapus latar di perangkat gagal, dicoba di server:', err);
      const eng = await bgEngine();
      if (eng.engine === 'server') { tasks.delete(clipId); return runServer(clipId, analysisPlan(c, 'server')); }
    }
    Object.assign(task, { state: cancelled ? 'cancelled' : 'error', error: cancelled ? null : err.message });
    if (cancelled) tasks.delete(clipId);
    emit(clipId);
    if (!cancelled) throw err;
    return { cancelled: true };
  }
}

async function runServer(clipId, plan) {
  const c = store.clip(clipId);
  const m = store.media(c.mediaId);
  const ctl = { stage: 'upload', p: 0 };
  tasks.set(clipId, { engine: 'server', state: 'running', ...ctl });
  emit(clipId);
  try {
    await uploaded(c.mediaId, (p) => { tasks.set(clipId, { engine: 'server', state: 'running', stage: 'upload', p }); emit(clipId); });
  } finally { tasks.delete(clipId); }
  const rec = await postWhileUploading('/api/ai/cutoutvideo', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaId: c.mediaId, start: plan.start, end: plan.end, fps: plan.fps, name: m?.name || c.name || 'video' }),
  });
  store.mutate('Hapus latar otomatis', () => { const x = store.clip(clipId); x.cutout.job = { id: rec.id, engine: 'server', ...plan }; });
  jobs.set(rec.id, { state: rec.state, stage: 'queued', p: 0, frames: Math.round((plan.end - plan.start) * plan.fps) });
  watch(rec.id);
  emit(clipId);
  return { job: rec.id };
}

/** Stop a clip's analysis; "Hapus latar otomatis" goes off for it. */
export async function cancelBgRemove(clipId) {
  const t = tasks.get(clipId);
  if (t?.ctl) t.ctl.abort();
  const c = store.clip(clipId);
  const id = c?.cutout?.job?.id;
  if (id) {
    await fetch(`/api/ai/${id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    jobs.set(id, { state: 'cancelled', p: 0 });
  }
  if (c?.cutout) store.mutate('Batal hapus latar', () => { const x = store.clip(clipId); x.cutout.job = null; if (!x.cutout.masks) x.cutout.enabled = false; });
  emit(clipId);
}

function watch(id) {
  if (watching.has(id)) return;
  watching.add(id);
  const t0 = Date.now();
  const tick = async () => {
    let rec = null;
    let done = false;
    // (each poll has its own time limit: a request that never answers must not stop the watching)
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 20_000) : null;
    try {
      const r = await fetch(`/api/ai/${id}`, { cache: 'no-store', credentials: 'same-origin', signal: ctl?.signal });
      if (r.status === 404) rec = { state: 'failed', error: 'permintaan tidak ditemukan di server' };
      else if (r.ok) rec = await r.json();
    } catch { /* offline or too slow: try again */ } finally { clearTimeout(timer); }
    try {
      if (rec) {
        const fm = /^frame (\d+)\/(\d+) · (\d+)/.exec(rec.stage || '');
        jobs.set(id, {
          state: rec.state === 'queued' || rec.state === 'running' ? 'running' : rec.state === 'done' ? 'done' : rec.state === 'cancelled' ? 'cancelled' : 'error',
          error: rec.error || null, retrying: rec.retrying || null, p: rec.progress || 0,
          stage: rec.stage === 'download' ? 'download' : rec.stage === 'frames' ? 'prepare' : fm ? 'frames' : rec.state === 'queued' ? 'queued' : 'running',
          frame: fm ? Number(fm[1]) : null, frames: fm ? Number(fm[2]) : rec.video?.frames || null, eta: fm ? Number(fm[3]) : null,
        });
        if (rec.state === 'done' && rec.masks) { done = true; applyMasks(rec.masks, { jobId: id }); loadMaskSet(rec.masks).catch(() => {}); }
        if (['failed', 'cancelled'].includes(rec.state)) done = true;
        emit(null);
      }
    } catch (err) {
      console.warn('[najja] hapus latar:', err);
    } finally {
      if (done) watching.delete(id);
      else setTimeout(tick, Date.now() - t0 < 10_000 ? 1000 : 2500);
    }
  };
  tick();
}

/** Follow the server jobs the open project waits for (after it is opened, after an undo, after a reload). */
export function resumeBgJobs() {
  for (const c of store.P.clips) if (c.cutout?.enabled && c.cutout.job?.id && !watching.has(c.cutout.job.id)) watch(c.cutout.job.id);
}
store.on('project', (label) => { if (label === 'load' || label === 'history') resumeBgJobs(); });
