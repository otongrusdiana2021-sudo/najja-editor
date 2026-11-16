// Project cover (v1.9), like a phone editor's "Sampul": from a frame of the video, rendered in full quality at the
// project's size ("HD": the export's decoder reads the full-quality copies, not the light preview copies), or from a
// photo in the gallery, cropped to the project's shape and made HD with the AI upscaler when it is small.
// The cover is kept as an image in the project's media (hidden from the library), a small copy is the project
// card's picture, it can be saved to the device, and it can be the first frame of exported videos (so galleries and
// social apps show it as the video's picture).
import { store } from './store.js';
import * as actions from './actions.js';
import { cacheProjectMedia, importFile, mediaRT } from './media.js';
import { renderStill } from './fastexport.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The size covers are made at: the project's own (1080×1920 for 9:16), at least 1080 on the short side. */
function coverSize(P) {
  const k = Math.max(1, 1080 / Math.min(P.width, P.height));
  return { w: Math.round(P.width * k), h: Math.round(P.height * k) };
}

/** The frame at time t, as large as the project, from the full-quality copies (falls back to the preview's). */
export async function frameCover(t, onProgress = () => {}) {
  const { engine } = actions.app;
  const P = store.P;
  const { w, h } = coverSize(P);
  engine.pause();
  onProgress(0.05, 'Menyiapkan video kualitas penuh…');
  await cacheProjectMedia(P, (p) => onProgress(0.05 + p * 0.6, 'Menyiapkan video kualitas penuh…'));
  onProgress(0.7, 'Merender frame HD…');
  let c = await renderStill({ engine, P, t, width: w, height: h });
  let hd = !!c;
  if (!c) { c = await engine.capture(t, w); hd = false; }
  onProgress(1, 'Selesai');
  return { canvas: c, hd };
}

/** Decode a picked photo with its orientation. */
async function decodePhoto(file) {
  try {
    const b = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { img: b, w: b.width, h: b.height };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { img, w: img.naturalWidth, h: img.naturalHeight };
    } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
  }
}

/** Upscale a picture with the server's AI tool (2× or 4×); null when it is not available. */
async function aiUpscale(blob, scale, onProgress) {
  let st = null;
  try { st = await (await fetch('/api/ai', { cache: 'no-store', credentials: 'same-origin' })).json(); } catch { return null; }
  if (!st?.available) return null;
  const r = await fetch(`/api/ai/upscale?${new URLSearchParams({ name: 'sampul', scale: String(scale) })}`, { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'image/jpeg' }, credentials: 'same-origin' });
  if (!r.ok) return null;
  let x = await r.json();
  const t0 = Date.now();
  while (!['done', 'failed', 'cancelled'].includes(x.state)) {
    if (Date.now() - t0 > 5 * 60000) return null;
    onProgress(0.3 + (x.progress || 0) * 0.6, x.stage === 'download' ? 'Mengunduh model AI ke server (sekali saja)…' : 'Meningkatkan ke HD dengan AI…');
    await sleep(700);
    const rr = await fetch(`/api/ai/${x.id}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!rr.ok) return null;
    x = await rr.json();
  }
  if (x.state !== 'done') return null;
  return (await fetch(x.resultUrl, { credentials: 'same-origin' })).blob();
}

/** A photo from the gallery, cropped to the project's shape (centred), HD: upscaled by the AI tool when small. */
export async function photoCover(file, onProgress = () => {}) {
  const P = store.P;
  const { w, h } = coverSize(P);
  onProgress(0.05, 'Membaca foto…');
  let { img, w: iw, h: ih } = await decodePhoto(file);
  // the part of the photo the cover shows (cover fit) is smaller than the cover: make it HD first
  const k = Math.max(w / iw, h / ih);
  let upscaled = false;
  if (k > 1.25) {
    onProgress(0.2, 'Meningkatkan ke HD dengan AI…');
    const src = document.createElement('canvas');
    // the upscaler takes up to 1024 px (4×) / 2048 px (2×): send the visible part only
    const cropW = Math.round(w / k);
    const cropH = Math.round(h / k);
    const scale = k > 2.2 ? 4 : 2;
    const lim = scale === 4 ? 1024 : 2048;
    const f = Math.min(1, lim / Math.max(cropW, cropH));
    src.width = Math.max(1, Math.round(cropW * f));
    src.height = Math.max(1, Math.round(cropH * f));
    src.getContext('2d').drawImage(img, (iw - cropW) / 2, (ih - cropH) / 2, cropW, cropH, 0, 0, src.width, src.height);
    const blob = await new Promise((r) => src.toBlob(r, 'image/jpeg', 0.95));
    const up = blob ? await aiUpscale(blob, scale, onProgress).catch(() => null) : null;
    if (up) {
      const d = await decodePhoto(up);
      img = d.img; iw = d.w; ih = d.h;
      upscaled = true;
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  const kk = Math.max(w / iw, h / ih);
  ctx.drawImage(img, (w - iw * kk) / 2, (h - ih * kk) / 2, iw * kk, ih * kk);
  img.close?.();
  onProgress(1, 'Selesai');
  return { canvas: c, hd: upscaled || k <= 1.25, upscaled };
}

const toBlob = (c, q = 0.92) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));

/** Make `canvas` the project's cover: an image in the project's media + a small copy for the project card. */
export async function setCoverImage(canvas, { from, t = null, firstFrame } = {}) {
  const blob = await toBlob(canvas);
  if (!blob) throw new Error('Sampul tidak bisa dibuat');
  const entry = await importFile(new File([blob], 'Sampul.jpg', { type: 'image/jpeg' }), { name: 'Sampul', silent: true });
  entry.cover = true; // (not listed in the library)
  const small = document.createElement('canvas');
  small.width = 360;
  small.height = Math.round((360 * canvas.height) / canvas.width);
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  const old = store.P.cover?.mediaId;
  store.mutate('Sampul', (P) => {
    P.cover = { mediaId: entry.id, from, t, w: canvas.width, h: canvas.height, thumb: small.toDataURL('image/jpeg', 0.8), firstFrame: firstFrame ?? P.cover?.firstFrame ?? true };
    // the previous cover image goes (it is no one else's)
    if (old && old !== entry.id && !P.clips.some((c) => c.mediaId === old)) P.media = P.media.filter((m) => m.id !== old);
  });
  return entry;
}

export function clearCover() {
  const old = store.P.cover?.mediaId;
  store.mutate('Hapus sampul', (P) => {
    P.cover = null;
    if (old && !P.clips.some((c) => c.mediaId === old)) P.media = P.media.filter((m) => m.id !== old);
  });
}

export function setCoverFirstFrame(on) {
  store.mutate('Sampul di awal video', (P) => { if (P.cover) P.cover.firstFrame = !!on; });
}

/** The cover image (HD) as a Blob, or null (older covers have only the small picture). */
export async function coverBlob() {
  const id = store.P.cover?.mediaId;
  const url = id && mediaRT.get(id)?.url;
  if (url) { try { return await (await fetch(url)).blob(); } catch { /* fall back */ } }
  const thumb = store.P.cover?.thumb;
  return thumb ? (await fetch(thumb)).blob() : null;
}

/** The cover image for an export's first frame (an <img>/bitmap), or null. */
export async function coverForExport(P) {
  if (!P.cover?.firstFrame || !P.cover.mediaId) return null;
  const rt = mediaRT.get(P.cover.mediaId);
  if (rt?.img) return rt.img;
  const url = rt?.url;
  if (!url) return null;
  try { return await createImageBitmap(await (await fetch(url)).blob()); } catch { return null; }
}
