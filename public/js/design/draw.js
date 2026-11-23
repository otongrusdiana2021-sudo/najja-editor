// Najja Desain (v1.13): a page drawn with the video renderer (render.js drawVisualClip) — the same pixels on screen,
// in the page thumbnails and in the export.
import { drawVisualClip, baseSize } from '../render.js';

/**
 * Draw a page into ctx (whose size is page × scale). opts:
 *   sources: mediaId → { el, w, h } (a photo, or its lighter copy on screen)
 *   boxes: Map filled with each element's box (page px) for hit tests
 *   skip: Set of element ids not drawn (being edited); only: draw just these (a layer while dragging)
 *   transparent: no page colour (PNG with transparency)
 */
export function drawPage(ctx, design, page, { scale = 1, sources = new Map(), boxes = null, skip = null, only = null, from = 0, to = Infinity, transparent = false, background = true } = {}) {
  const W = design.width;
  const H = design.height;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (background && !transparent) drawBackground(ctx, page.bg || {}, W, H, sources);
  const env = envFor(design, scale, sources);
  const els = page.els;
  for (let i = Math.max(0, from); i < Math.min(els.length, to); i++) {
    const el = els[i];
    // (every element's box counts — also one not drawn now: it can be hit, selected, snapped to)
    if (boxes && !el.hidden) boxes.set(el.id, boxOf(ctx, el, env));
    if (el.hidden || skip?.has(el.id) || (only && !only.has(el.id))) continue;
    try { drawVisualClip(ctx, el, 0, env); } catch (err) { console.warn('design: element not drawn', el.id, err); }
  }
  ctx.restore();
}
export function envFor(design, scale = 1, sources = new Map()) {
  return {
    project: { width: design.width, height: design.height },
    s: scale,
    boxes: null,
    mediaMeta: (id) => design.media.find((m) => m.id === id) || null,
    source: (clip) => sources.get(clip.mediaId) || null,
  };
}
/** An element's box on the page (centre, size, rotation in page px), as render.js places it. */
export function boxOf(ctx, el, env) {
  const W = env.project.width;
  const H = env.project.height;
  const size = baseSize(el, env, ctx);
  const sc = Math.abs(el.scale ?? 1);
  return { cx: W / 2 + (el.x || 0) * W, cy: H / 2 + (el.y || 0) * H, w: size.w * sc, h: size.h * sc, rot: ((el.rotation || 0) * Math.PI) / 180 };
}

/** The page's background: a colour, a gradient (color2, angle) or a photo covering it. */
export function drawBackground(ctx, bg, W, H, sources = new Map()) {
  if (bg.mediaId && sources.get(bg.mediaId)) {
    const s = sources.get(bg.mediaId);
    const k = Math.max(W / s.w, H / s.h);
    const w = s.w * k;
    const h = s.h * k;
    ctx.fillStyle = bg.color || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(s.el, (W - w) / 2, (H - h) / 2, w, h);
    return;
  }
  if (bg.color2) {
    const a = ((bg.angle ?? 135) * Math.PI) / 180;
    const dx = (Math.cos(a) * W) / 2;
    const dy = (Math.sin(a) * H) / 2;
    const g = ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy);
    g.addColorStop(0, bg.color || '#ffffff');
    g.addColorStop(1, bg.color2);
    ctx.fillStyle = g;
  } else ctx.fillStyle = bg.color || '#ffffff';
  ctx.fillRect(0, 0, W, H);
}

/** A page as a new canvas of (page × scale) pixels. */
export function pageCanvas(design, page, scale, opts = {}) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(design.width * scale));
  c.height = Math.max(1, Math.round(design.height * scale));
  drawPage(c.getContext('2d'), design, page, { scale, ...opts });
  return c;
}
/**
 * (v1.13.2) Whether this device draws a canvas of w × h (Safari on iPad refuses big ones: no context, or an empty
 * image). Draws one pixel in the far corner and reads it back; the canvas is freed at once.
 */
export function canvasFits(w, h) {
  const c = document.createElement('canvas');
  try {
    c.width = w;
    c.height = h;
    if (c.width !== w || c.height !== h) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#000';
    ctx.fillRect(w - 1, h - 1, 1, 1);
    return ctx.getImageData(w - 1, h - 1, 1, 1).data[3] === 255;
  } catch {
    return false;
  } finally {
    c.width = 0;
    c.height = 0;
  }
}
export const toBlob =(canvas, type = 'image/png', quality = 0.92) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('gambar tidak bisa dibuat'))), type, quality));
