// "Hapus latar otomatis" (v1.11): playing the masks of a clip whose background is removed.
// The masks come from one analysis of the clip (bgremove.js: BiRefNet on this device's GPU, or on the server): one
// 8-bit mask per analysed frame, every object in front kept (people, products, animals…), the background gone. They
// are kept on the server (/api/masks/<id>), so the preview, the export and other devices use the same ones. Between
// two analysed frames the mask is blended, so the edge moves smoothly.

let cutError = null;
const readyFns = new Set();
/** Called when masks finish loading (the editor redraws then). */
export const onMaskReady = (fn) => { readyFns.add(fn); return () => readyFns.delete(fn); };
/** Why the last ensureCutout() said no. */
export const cutoutError = () => cutError;

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
/** Masks made on this device go straight in (no download of what was just made). */
export function putMaskSet(m, data) { sets.set(m.id, { state: 'ready', data }); for (const fn of readyFns) { try { fn(); } catch { /* ignore */ } } }

/**
 * Get the masks every clip with "Hapus latar otomatis" needs (before an export or a capture). Resolves false when
 * one is not there (still being analysed, or not loadable): cutoutError() says why.
 */
export async function ensureCutout(P) {
  cutError = null;
  for (const c of P?.clips || []) {
    if (!c.cutout?.enabled) continue;
    if (!c.cutout.masks) {
      cutError = c.cutout.job ? 'hapus latar belakang masih dianalisis — tunggu sampai selesai (lihat lembar Hapus Latar Belakang)'
        : `klip "${c.name || 'video'}" belum dianalisis — buka Hapus Latar Belakang dan ketuk "Analisis sekarang"`;
      return false;
    }
    try { await loadMaskSet(c.cutout.masks); } catch (err) { cutError = err.message; return false; }
  }
  return true;
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a))); return t * t * (3 - 2 * t); };
const cache = new Map(); // clipId → { key, mid, canvas }

/**
 * The mask of a clip's frame at source time `srcTime` (seconds of the media) as a small canvas (opaque where the
 * subject is), or null when its masks are not loaded yet (loading starts then).
 * cutout: { threshold 0..1 (how sure the model must be), edge 0..1 (soft edge width) }.
 */
export function cutoutMask(clip, srcTime) {
  const cut = clip.cutout;
  const m = cut?.masks;
  if (!m) return null;
  const s = sets.get(m.id);
  if (!s || s.state !== 'ready') { if (!s || (s.state === 'error' && !s.promise)) loadMaskSet(m).catch(() => {}); return null; }
  const th = cut.threshold ?? 0.5;
  const edge = cut.edge ?? 0.2;
  const f = Math.max(0, (srcTime - m.start) * m.fps);
  const i0 = Math.min(m.n - 1, Math.floor(f));
  const i1 = Math.min(m.n - 1, i0 + 1);
  const w = i1 === i0 ? 0 : Math.min(1, f - i0);
  const key = `${i0}:${w.toFixed(2)}:${th}:${edge}`;
  const c0 = cache.get(clip.id);
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
  // (a lookup table: 256 values → alpha, then per pixel just a blend and a lookup)
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(smooth(lo, hi, v / 255) * 255);
  const d = img.data;
  if (w === 0) for (let p = 0; p < size; p++) d[p * 4 + 3] = lut[a[p]];
  else for (let p = 0; p < size; p++) d[p * 4 + 3] = lut[(a[p] * (1 - w) + b[p] * w + 0.5) | 0];
  ctx.putImageData(img, 0, 0);
  cache.set(clip.id, { key, mid: m.id, canvas });
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  return canvas;
}
