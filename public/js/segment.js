// "Hapus otomatis" (v1.10.3): background removal of people in videos and photos, without a green screen.
// MediaPipe Selfie Segmentation runs on this device (GPU when there is one): the video never leaves it. The library
// and the model come from the Najja server (lib/vendor.js: a pinned version, fetched once, checked by sha256).
// Every drawn frame of a clip with clip.cutout.enabled gets a person mask; consecutive frames are blended a little so
// the edge does not flicker; a paused frame reuses its mask.
export const MP_VERSION = '0.10.35';
const BASE = `/vendor/mediapipe-${MP_VERSION}`;

let seg = null;
let loading = null;
let lastError = null;
const readyFns = new Set();
/** Called once the segmenter is ready (the editor redraws then). */
export const onSegmenterReady = (fn) => { readyFns.add(fn); return () => readyFns.delete(fn); };
export const segmenterReady = () => !!seg;
export const segmenterError = () => lastError;

/** Load the segmenter (once). Rejects with a readable message when it cannot run here. */
export function loadSegmenter() {
  if (seg) return Promise.resolve(seg);
  if (loading) return loading;
  loading = (async () => {
    let vision;
    try { vision = await import(`${BASE}/vision_bundle.mjs`); } catch {
      let msg = 'pustaka hapus latar tidak bisa dimuat dari server';
      try { const r = await fetch(`${BASE}/vision_bundle.mjs`, { credentials: 'same-origin' }); if (!r.ok) msg = (await r.json()).error || msg; } catch { /* offline */ }
      throw new Error(msg);
    }
    const fileset = await vision.FilesetResolver.forVisionTasks(`${BASE}/wasm`);
    const make = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${BASE}/selfie_segmenter.tflite`, delegate },
      runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    try { seg = await make('GPU'); } catch { seg = await make('CPU'); }
    lastError = null;
    for (const fn of readyFns) { try { fn(); } catch { /* ignore */ } }
    return seg;
  })().catch((err) => { loading = null; lastError = err.message || String(err); throw new Error(lastError); });
  return loading;
}

let cutError = null;
/** Why the last ensureCutout() said no. */
export const cutoutError = () => cutError || lastError;

/**
 * Get what the project's background removals need (before an export or a capture): the person segmenter, the
 * server's masks ("Orang + objek"). Resolves false when one cannot be had (cutoutError() says why).
 */
export async function ensureCutout(P) {
  cutError = null;
  for (const c of P?.clips || []) {
    if (!c.cutout?.enabled) continue;
    if (c.cutout.mode === 'all') {
      if (!c.cutout.masks) { cutError = 'hapus latar "Orang + objek" masih diproses di server — tunggu sampai selesai'; return false; }
      try { await loadMaskSet(c.cutout.masks); } catch (err) { cutError = err.message; return false; }
      if (c.cutout.masks.fps < 20) await loadSegmenter().catch(() => {}); // (crisper person between the server's frames)
    } else {
      try { await loadSegmenter(); } catch (err) { cutError = err.message; return false; }
    }
  }
  return true;
}

// ---- "Orang + objek" (v1.10.4) ----------------------------------------------------------------------------------
// The server (BiRefNet, lib/ai.js) finds the subject — the person AND what is with them: bags, a suitcase, a
// product — in the clip's frames, `fps` a second; the masks come as one file (8-bit, frame after frame). Between
// two of those frames the mask is blended; when they are sparse the person mask of this exact frame is added, so
// moving arms and heads stay sharp.
const sets = new Map(); // mask set id → { state, data, error, promise }
export const maskSetState = (m) => (m?.id ? sets.get(m.id)?.state || 'none' : 'none');
export function loadMaskSet(m) {
  if (!m?.id) return Promise.reject(new Error('belum ada masker'));
  let s = sets.get(m.id);
  if (s?.state === 'ready') return Promise.resolve(s);
  if (s?.promise) return s.promise;
  s = { state: 'loading' };
  sets.set(m.id, s);
  s.promise = (async () => {
    const r = await fetch(m.url || `/api/masks/${m.id}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`masker hapus latar tidak bisa dimuat (HTTP ${r.status})`);
    let buf = new Uint8Array(await r.arrayBuffer());
    const want = m.n * m.w * m.h;
    // (normally unpacked by the browser already: Content-Encoding gzip)
    if (buf.length !== want && buf[0] === 0x1f && buf[1] === 0x8b && typeof DecompressionStream !== 'undefined') {
      buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    if (buf.length < want) throw new Error('masker hapus latar tidak lengkap');
    Object.assign(s, { state: 'ready', data: buf, promise: null });
    for (const fn of readyFns) { try { fn(); } catch { /* ignore */ } }
    return s;
  })().catch((err) => { Object.assign(s, { state: 'error', error: err.message, promise: null }); throw err; });
  return s.promise;
}

const objCache = new Map(); // clipId → { key, canvas }
/** The subject mask of a clip's frame at source time `srcTime` from the server's masks, or null (not loaded yet). */
export function objectMask(clip, image, srcTime) {
  const cut = clip.cutout;
  const m = cut.masks;
  const s = m && sets.get(m.id);
  if (!s || s.state !== 'ready') { if (m && (!s || (s.state === 'error' && !s.promise))) loadMaskSet(m).catch(() => {}); return null; }
  const th = cut.threshold ?? 0.5;
  const edge = cut.edge ?? 0.2;
  const withPerson = m.fps < 20 && !!seg;
  const f = Math.max(0, (srcTime - m.start) * m.fps);
  const i0 = Math.min(m.n - 1, Math.floor(f));
  const i1 = Math.min(m.n - 1, i0 + 1);
  const w = i1 === i0 ? 0 : Math.min(1, f - i0);
  const key = withPerson ? `${srcTime}:${th}:${edge}` : `${i0}:${w.toFixed(2)}:${th}:${edge}`;
  const c0 = objCache.get(clip.id);
  if (c0 && c0.key === key && c0.mid === m.id) return c0.canvas;
  const size = m.w * m.h;
  const a = s.data.subarray(i0 * size, i0 * size + size);
  const b = s.data.subarray(i1 * size, i1 * size + size);
  const canvas = c0?.canvas && c0.canvas.width === m.w && c0.canvas.height === m.h ? c0.canvas : document.createElement('canvas');
  canvas.width = m.w;
  canvas.height = m.h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(m.w, m.h);
  const lo = th - edge / 2;
  const hi = th + edge / 2;
  for (let p = 0; p < size; p++) img.data[p * 4 + 3] = Math.round(smooth(lo, hi, (a[p] * (1 - w) + b[p] * w) / 255) * 255);
  ctx.putImageData(img, 0, 0);
  if (withPerson) {
    const pm = personMask(clip.id, image, srcTime, { threshold: 0.5, edge: 0.2 });
    if (pm) { ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(pm, 0, 0, m.w, m.h); }
  }
  objCache.set(clip.id, { key, mid: m.id, canvas });
  if (objCache.size > 24) objCache.delete(objCache.keys().next().value);
  return canvas;
}

/** The mask of a clip with "Hapus otomatis" for its frame: the server's subject masks, or the person mask. */
export function cutoutMask(clip, image, srcTime) {
  if (clip.cutout?.mode === 'all') {
    const m = objectMask(clip, image, srcTime);
    if (m) return m;
    // (while the server is still at it: the person alone, on this device)
  }
  return personMask(clip.id, image, srcTime, clip.cutout);
}

const masks = new Map(); // clipId → { key, th, edge, w, h, prev: Float32Array, canvas }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a))); return t * t * (3 - 2 * t); };

/**
 * The person mask of a clip's frame as a small canvas (white where the person is, transparent elsewhere), or null
 * when the segmenter is not loaded (it starts loading then). image: the frame as drawn (a canvas); key: the source
 * time of the frame. cutout: { threshold 0..1 (how sure the model must be), edge 0..1 (soft edge width) }.
 */
export function personMask(clipId, image, key, cutout = {}) {
  if (!seg) { if (!loading && !lastError) loadSegmenter().catch(() => {}); return null; }
  const th = cutout.threshold ?? 0.5;
  const edge = cutout.edge ?? 0.2;
  const m = masks.get(clipId);
  if (m && m.key === key && m.th === th && m.edge === edge) return m.canvas;
  let res;
  try { res = seg.segment(image); } catch { return m?.canvas || null; }
  try {
    const cm = res.confidenceMasks?.[0];
    if (!cm) return null;
    const w = cm.width;
    const h = cm.height;
    let conf = cm.getAsFloat32Array();
    // the next frame of the same clip: a little of the previous mask, so the edge does not flicker
    if (m?.prev && m.w === w && m.h === h && key > m.key && key - m.key < 0.12) {
      const mix = new Float32Array(conf.length);
      for (let i = 0; i < conf.length; i++) mix[i] = conf[i] * 0.7 + m.prev[i] * 0.3;
      conf = mix;
    } else conf = conf.slice();
    const canvas = m?.canvas && m.w === w && m.h === h ? m.canvas : document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const lo = th - edge / 2;
    const hi = th + edge / 2;
    for (let i = 0; i < conf.length; i++) {
      const a = smooth(lo, hi, conf[i]);
      img.data[i * 4 + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, 0);
    masks.set(clipId, { key, th, edge, w, h, prev: conf, canvas });
    if (masks.size > 24) masks.delete(masks.keys().next().value);
    return canvas;
  } finally {
    res.close?.();
  }
}
