// "Hapus otomatis · Orang + objek" (v1.10.4): the server finds the subject (the person and what is with them) in the
// clip's frames with BiRefNet; this module starts that job, follows it (also with the sheet closed, and again after
// the project is opened or an undo), and puts the masks on the clips when they are there.
import { store } from './store.js';
import { mediaRT } from './media.js';
import { loadMaskSet, loadSegmenter } from './segment.js';

export const CUTOUT_QUALITY = [[8, 'Cepat'], [15, 'Halus'], [30, 'Penuh']];
const progress = new Map(); // job id → { state, p, eta, frame, frames, error }
const watching = new Set();
const listeners = new Set();
/** UI hook: called with the job id whenever a job's progress changes. */
export const onCutoutProgress = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (id) => { for (const fn of listeners) { try { fn(id); } catch { /* ignore */ } } };
export const jobProgress = (id) => progress.get(id) || null;

/** The part of the source a clip shows (seconds of the media), with half a second of room on each side. */
export function clipRange(c, m = store.media(c.mediaId)) {
  if (c.type === 'image') return { start: 0, end: 0.1 };
  const sp = Math.abs(c.speed || 1);
  const dur = m?.duration || c.in + c.duration * sp;
  return { start: Math.max(0, (c.in || 0) - 0.5), end: Math.min(dur, (c.in || 0) + c.duration * sp + 0.5) };
}
/** Whether the clip now shows a part of its media the masks do not cover (trimmed or extended after processing). */
export function cutoutStale(c) {
  const m = c.cutout?.masks;
  if (!m) return false;
  if (m.mediaId && m.mediaId !== c.mediaId) return true;
  if (c.type === 'image') return false;
  const sp = Math.abs(c.speed || 1);
  return (c.in || 0) < m.start - 0.05 || (c.in || 0) + c.duration * sp > m.end + 0.05;
}

/** Whether the server can do it now: { ok, reason }. */
export async function objectCutoutAvailable() {
  try {
    const st = await (await fetch('/api/ai', { cache: 'no-store', credentials: 'same-origin' })).json();
    if (!st.available) return { ok: false, reason: st.reason || 'Layanan AI di server belum siap.' };
    return { ok: true, model: st.tools?.cutout?.model };
  } catch { return { ok: false, reason: 'Server tidak bisa dihubungi.' }; }
}

/**
 * Remove the background of a clip with the server ("Orang + objek"). Masks of the same media that cover the clip
 * (another clip, a duplicate) are used again without a new job. fps: 8 | 15 | 30.
 */
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

export async function startObjectCutout(clipId, { fps, onWait = () => {} } = {}) {
  const c = store.clip(clipId);
  if (!c || (c.type !== 'video' && c.type !== 'image')) throw new Error('Hapus latar untuk klip video atau foto');
  const m = store.media(c.mediaId);
  fps = [8, 15, 30].includes(Number(fps)) ? Number(fps) : c.cutout?.fps || 15;
  const r = clipRange(c, m);
  const old = c.cutout?.job?.id; // (a job this clip no longer waits for is stopped)
  const stopOld = () => { if (old) fetch(`/api/ai/${old}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {}); };
  const reuse = store.P.clips.map((x) => x.cutout?.masks).find((mm) => mm && mm.mediaId === c.mediaId && mm.start <= r.start + 0.05 && mm.end >= r.end - 0.05 && mm.fps >= fps);
  loadSegmenter().catch(() => {}); // (the preview shows the person alone until the server is done)
  if (reuse) {
    store.mutate('Hapus latar otomatis', () => { const x = store.clip(clipId); x.cutout = { threshold: 0.5, edge: 0.2, ...(x.cutout || {}), enabled: true, mode: 'all', fps, masks: reuse, job: null }; });
    loadMaskSet(reuse).catch(() => {});
    stopOld();
    return { reused: true, masks: reuse };
  }
  await uploaded(c.mediaId, onWait);
  let res;
  let rec;
  for (let k = 0; ; k++) {
    res = await fetch('/api/ai/cutoutvideo', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: c.mediaId, start: r.start, end: r.end, fps, name: m?.name || c.name || 'video' }),
    });
    rec = await res.json().catch(() => ({}));
    // (the last bytes of the upload are still being put together on the server: a moment more)
    if (res.status === 409 && rec.code === 'uploading' && k < 60) { onWait(1); await new Promise((rr) => setTimeout(rr, 2000)); continue; }
    break;
  }
  if (!res.ok) throw new Error(rec.error || `HTTP ${res.status}`);
  store.mutate('Hapus latar otomatis', () => {
    const x = store.clip(clipId);
    // (the masks it had stay until the new ones are there)
    x.cutout = { threshold: 0.5, edge: 0.2, ...(x.cutout || {}), enabled: true, mode: 'all', fps, job: { id: rec.id, start: r.start, end: r.end, fps } };
  });
  if (old !== rec.id) stopOld();
  progress.set(rec.id, { state: rec.state, p: 0, frames: Math.ceil((r.end - r.start) * fps) });
  watch(rec.id);
  return { job: rec.id };
}

/** Stop a clip's job (it goes back to "Orang saja" when it has no masks yet). */
export async function cancelObjectCutout(clipId) {
  const c = store.clip(clipId);
  const id = c?.cutout?.job?.id;
  if (!id) return;
  await fetch(`/api/ai/${id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  progress.set(id, { state: 'cancelled', p: 0 });
  store.mutate('Batal hapus latar', () => { const x = store.clip(clipId); x.cutout = { ...x.cutout, job: null, mode: x.cutout.masks ? 'all' : 'person' }; });
  emit(id);
}

/** Put a finished job's masks on every clip waiting for it (no undo step: it is the result of the one before). */
function apply(id, masks) {
  let n = 0;
  for (const x of store.P.clips) {
    if (x.cutout?.job?.id !== id) continue;
    x.cutout.masks = masks;
    x.cutout.job = null;
    n++;
  }
  if (n) store.touch('Hapus latar siap');
  loadMaskSet(masks).catch(() => {});
}

function watch(id) {
  if (watching.has(id)) return;
  watching.add(id);
  const t0 = Date.now();
  const tick = async () => {
    let rec = null;
    try {
      const r = await fetch(`/api/ai/${id}`, { cache: 'no-store', credentials: 'same-origin' });
      if (r.status === 404) rec = { state: 'failed', error: 'permintaan tidak ditemukan di server' };
      else rec = await r.json();
    } catch { /* offline: try again */ }
    if (rec) {
      const fm = /^frame (\d+)\/(\d+) · (\d+)/.exec(rec.stage || '');
      progress.set(id, {
        state: rec.state, p: rec.progress || 0, error: rec.error || null, retrying: rec.retrying || null,
        stage: rec.stage === 'download' ? 'download' : rec.stage === 'frames' ? 'frames' : fm ? 'frame' : rec.state,
        frame: fm ? Number(fm[1]) : null, frames: fm ? Number(fm[2]) : rec.video?.frames || null, eta: fm ? Number(fm[3]) : null,
      });
      emit(id);
      if (rec.state === 'done' && rec.masks) { watching.delete(id); apply(id, rec.masks); emit(id); return; }
      if (['failed', 'cancelled'].includes(rec.state)) { watching.delete(id); return; }
    }
    setTimeout(tick, Date.now() - t0 < 10_000 ? 1000 : 2500);
  };
  tick();
}

/** Follow the jobs the open project is waiting for (after it is opened, after an undo, after a reload). */
export function resumeCutoutJobs() {
  for (const c of store.P.clips) if (c.cutout?.enabled && c.cutout.job?.id && !watching.has(c.cutout.job.id)) watch(c.cutout.job.id);
}
store.on('project', (label) => { if (label === 'load' || label === 'history') resumeCutoutJobs(); });
