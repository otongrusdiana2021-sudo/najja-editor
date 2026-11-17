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

/** Load the segmenter when a project needs it (before an export or a capture). Resolves false when it cannot. */
export async function ensureCutout(P) {
  if (!P?.clips?.some((c) => c.cutout?.enabled)) return true;
  try { await loadSegmenter(); return true; } catch { return false; }
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
