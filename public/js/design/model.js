// Najja Desain (v1.13): the design document — pages of elements — and the pure operations on it (no DOM: tested in
// Node). An element is a clip of the video editor without time (text, image, shape, sticker: icon, emoji, badge,
// colour circle), so the video renderer (render.js) draws a design exactly as it draws a frame, on screen and in the
// export alike, and a design can later go into a video as it is.
//
// Units: a page is width × height pixels. An element's centre is x, y as fractions of the page from its centre (as in
// the video editor); its size is its base size (render.js baseSize: a text's box, a photo fitted inside the page, a
// shape's w × h) times scale.
import { makeClip } from '../store.js';
import { DEFAULT_TEXT } from '../presets.js';
import { uid, clone } from '../util.js';

export const DESIGN_V = 1;

/** Sizes to start from, marketplace first. */
export const SIZES = [
  { id: 'produk', name: 'Foto Produk', sub: 'Marketplace 1:1', w: 1080, h: 1080 },
  { id: 'feed', name: 'Feed Instagram', sub: '4:5', w: 1080, h: 1350 },
  { id: 'story', name: 'Story / Reels', sub: '9:16', w: 1080, h: 1920 },
  { id: 'banner', name: 'Banner Promo', sub: '3:1', w: 1920, h: 640 },
  { id: 'lebar', name: 'Banner Lebar', sub: '16:9', w: 1920, h: 1080 },
  { id: 'kartu', name: 'Kartu Terima Kasih', sub: '10 × 15 cm', w: 1181, h: 1772 },
];
export const sizeById = (id) => SIZES.find((s) => s.id === id) || null;
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
export const aspectOf = (w, h) => { const g = gcd(Math.round(w), Math.round(h)) || 1; return `${Math.round(w / g)}:${Math.round(h / g)}`; };

/** A new design of w × h with one empty page. */
export function newDesign({ name = 'Desain tanpa judul', w = 1080, h = 1080, sizeId = null } = {}) {
  const now = Date.now();
  w = Math.round(Math.min(8000, Math.max(64, w)));
  h = Math.round(Math.min(8000, Math.max(64, h)));
  return { id: uid('p'), kind: 'design', designV: DESIGN_V, name, sizeId, width: w, height: h, aspect: aspectOf(w, h), duration: 0, pages: [newPage()], media: [], clips: [], createdAt: now, updatedAt: now };
}
export function newPage(bg = { color: '#ffffff' }) {
  return { id: uid('pg'), bg: clone(bg), els: [] };
}
/** A design read from the server, made whole (older or partial records). */
export function normalizeDesign(d) {
  const o = { ...d };
  o.kind = 'design';
  o.designV = o.designV || DESIGN_V;
  o.width = Math.round(o.width || 1080);
  o.height = Math.round(o.height || 1080);
  o.aspect = aspectOf(o.width, o.height);
  o.pages = Array.isArray(o.pages) && o.pages.length ? o.pages.map((p) => ({ id: p.id || uid('pg'), bg: p.bg || { color: '#ffffff' }, els: Array.isArray(p.els) ? p.els : [] })) : [newPage()];
  o.media = Array.isArray(o.media) ? o.media : [];
  o.clips = [];
  o.duration = 0;
  return o;
}

// ---------------------------------------------------------------------------------------------
// Elements
const base = (type, props) => {
  const c = makeClip(type, { start: 0, duration: 1, trackId: 'design', ...props });
  delete c.transition;
  delete c.keyframes;
  return c;
};
/** The scale a page uses for "a normal size" of things made for a 1080 px page. */
export const unit = (page) => Math.min(page.width, page.height) / 1080;

export const TEXT_KINDS = {
  heading: { content: 'Tambahkan judul', size: 120, weight: 800, font: 'Poppins' },
  sub: { content: 'Tambahkan subjudul', size: 72, weight: 600, font: 'Poppins' },
  body: { content: 'Tambahkan sedikit teks isi', size: 44, weight: 400, font: 'Poppins' },
};
/** A text. style: DEFAULT_TEXT fields (content, font, size, color, …); width: a box its words wrap in (page px). */
export function textEl(page, style = {}, props = {}) {
  const u = unit(page);
  const text = { ...clone(DEFAULT_TEXT), color: '#111111', ...clone(style) };
  text.size = Math.round((style.size || 96) * u);
  if (style.width) text.width = Math.round(style.width * u);
  return base('text', { text, name: String(text.content).split('\n')[0].slice(0, 40), ...props });
}
/** A shape: kind (rect, circle, triangle, star, burst, heart, tag, bubble, arrow, line, pill, diamond). */
export function shapeEl(page, kind = 'rect', props = {}, shape = {}) {
  const u = unit(page);
  const dims = SHAPE_DIMS[kind] || [400, 400];
  return base('shape', { shape: { kind, w: Math.round(dims[0] * u), h: Math.round(dims[1] * u), fill: '#47C9D7', radius: kind === 'rect' ? 0 : 0, ...shape }, name: SHAPE_NAMES[kind] || 'Bentuk', ...props });
}
export const SHAPE_NAMES = {
  rect: 'Persegi', rounded: 'Persegi bulat', circle: 'Lingkaran', triangle: 'Segitiga', star: 'Bintang', burst: 'Lencana', heart: 'Hati', tag: 'Label harga',
  bubble: 'Balon kata', arrow: 'Panah', line: 'Garis', pill: 'Kapsul', diamond: 'Belah ketupat',
  // v1.13.1
  pentagon: 'Segi lima', hexagon: 'Segi enam', octagon: 'Segi delapan', star4: 'Bintang 4', star6: 'Bintang 6', rtriangle: 'Segitiga siku',
  parallelogram: 'Jajar genjang', trapezoid: 'Trapesium', cross: 'Plus', ribbon: 'Pita', chevron: 'Chevron', darrow: 'Panah dua arah', arch: 'Lengkung',
  semicircle: 'Setengah lingkaran', drop: 'Tetes', shield: 'Perisai', blob: 'Blob', scallop: 'Bunga', cloud: 'Awan', bubble2: 'Balon bulat', ticket: 'Kupon',
};
/** A shape's size on a 1080 px page when added. */
export const SHAPE_DIMS = {
  line: [600, 10], arrow: [500, 120], darrow: [560, 140], pill: [520, 160], tag: [520, 200], bubble: [520, 360], bubble2: [520, 380], burst: [420, 420],
  parallelogram: [480, 300], trapezoid: [480, 300], ribbon: [600, 180], chevron: [400, 260], arch: [360, 480], semicircle: [480, 240], drop: [320, 420],
  shield: [360, 420], cloud: [560, 360], ticket: [600, 300],
};
/** A photo slot of a template: a shape a photo replaces (keeping its place and frame). */
export function slotEl(page, kind = 'rect', w = 600, h = 600, props = {}, label = 'Foto produk') {
  const u = unit(page);
  const { radius = 0, fill = '#E9EDF1', ...rest } = props;
  return base('shape', { shape: { kind, w: Math.round(w * u), h: Math.round(h * u), fill, radius: Math.round(radius * u) }, slot: { label }, name: 'Bingkai foto', ...rest });
}
/** An icon (Lucide nodes). */
export function iconEl(page, name, nodes, props = {}, look = {}) {
  return base('sticker', { sticker: { emoji: '', badge: null, icon: { name, nodes: clone(nodes), color: '#111111', stroke: 2, ...look } }, scale: Math.round(unit(page) * 100) / 100, name: `Ikon ${name}`, ...props });
}
export function emojiEl(page, emoji, props = {}) {
  return base('sticker', { sticker: { emoji, badge: null }, scale: Math.round(unit(page) * 0.9 * 100) / 100, name: emoji, ...props });
}
/** A label badge (pill with an emoji and words): marketplace chips. */
export function badgeEl(page, badge, props = {}) {
  return base('sticker', { sticker: { emoji: '', badge: { text: badge.text, bg: badge.bg || '#ff3b30', fg: badge.fg || '#ffffff', icon: badge.icon || '' } }, scale: Math.round(unit(page) * 100) / 100, name: badge.text, ...props });
}
/** A colour circle with its name (v1.12.6 sticker). */
export function swatchEl(page, hex, label = '', props = {}, look = {}) {
  return base('sticker', { sticker: { emoji: '', badge: null, swatch: { color: hex, label, font: 'Poppins', weight: 700, italic: false, labelColor: '#111111', ...look } }, scale: Math.round(unit(page) * 0.8 * 100) / 100, name: `Warna ${label || hex}`, ...props });
}
/** A photo: fitted to `fit` of the page's shorter side (its base size is the photo fitted inside the page). */
export function imageEl(page, media, props = {}, fit = 0.62) {
  const k = Math.min(page.width / media.width, page.height / media.height);
  const bw = media.width * k;
  const bh = media.height * k;
  const scale = (Math.min(page.width, page.height) * fit) / Math.max(bw, bh);
  return base('image', { mediaId: media.id, scale: Math.round(scale * 1000) / 1000, name: media.name || 'Foto', ...props });
}
/** A photo put into a slot: same place and frame, covering the slot (the photo's size and crop chosen to fill it). */
export function fillSlot(page, slot, media) {
  const sw = (slot.shape?.w || 400) * (slot.scale ?? 1);
  const sh = (slot.shape?.h || 400) * (slot.scale ?? 1);
  // crop the photo to the slot's proportions (centred), then size it to the slot
  const ar = sw / sh;
  const mar = media.width / media.height;
  const crop = { l: 0, t: 0, r: 0, b: 0 };
  if (mar > ar) { const keep = ar / mar; crop.l = crop.r = Math.round(((1 - keep) / 2) * 1000) / 1000; } else { const keep = mar / ar; crop.t = crop.b = Math.round(((1 - keep) / 2) * 1000) / 1000; }
  const cw = media.width * (1 - crop.l - crop.r);
  const ch = media.height * (1 - crop.t - crop.b);
  const k = Math.min(page.width / cw, page.height / ch);
  const scale = sw / (cw * k);
  const kind = slot.shape?.kind || 'rect';
  const radius = slot.shape?.radius ? (2 * slot.shape.radius) / Math.min(slot.shape.w, slot.shape.h) : 0;
  return base('image', {
    id: slot.id, mediaId: media.id, x: slot.x, y: slot.y, rotation: slot.rotation || 0, scale: Math.round(scale * 10000) / 10000, crop, name: media.name || 'Foto',
    mask: kind === 'rect' && !radius ? null : { kind: kind === 'rect' ? 'rect' : kind, radius }, fromSlot: { kind, w: slot.shape.w, h: slot.shape.h, radius: slot.shape.radius || 0, label: slot.slot?.label || 'Foto produk', scale: slot.scale ?? 1, imgScale: Math.round(scale * 10000) / 10000 },
    opacity: slot.opacity ?? 1,
  });
}

/**
 * The frame of a photo slot or of a frame with a photo in it (for putting another photo in): a slot element with
 * the frame's place and its present size (a framed photo made bigger: the frame too).
 */
export function slotOf(el) {
  if (el.slot) return el;
  const f = el.fromSlot;
  if (!f) return null;
  const grown = f.imgScale ? (el.scale ?? 1) / f.imgScale : 1;
  return { id: el.id, type: 'shape', x: el.x, y: el.y, rotation: el.rotation || 0, opacity: el.opacity ?? 1, scale: Math.round((f.scale ?? 1) * grown * 10000) / 10000, shape: { kind: f.kind, w: f.w, h: f.h, radius: f.radius || 0 }, slot: { label: f.label } };
}

// ---------------------------------------------------------------------------------------------
// Geometry
/** The box of an element from the renderer (cx, cy, w, h, rot in page px) → its axis-aligned bounds. */
export function aabb(b) {
  const c = Math.abs(Math.cos(b.rot || 0));
  const s = Math.abs(Math.sin(b.rot || 0));
  const w = b.w * c + b.h * s;
  const h = b.w * s + b.h * c;
  return { x1: b.cx - w / 2, y1: b.cy - h / 2, x2: b.cx + w / 2, y2: b.cy + h / 2 };
}
export const union = (rs) => rs.reduce((u, r) => ({ x1: Math.min(u.x1, r.x1), y1: Math.min(u.y1, r.y1), x2: Math.max(u.x2, r.x2), y2: Math.max(u.y2, r.y2) }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
/** Is page point (px, py) inside the (rotated) box b? */
export function hit(b, px, py, pad = 0) {
  const dx = px - b.cx;
  const dy = py - b.cy;
  const c = Math.cos(-(b.rot || 0));
  const s = Math.sin(-(b.rot || 0));
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad;
}

/**
 * Snap a moving box to the page (edges, centre) and to the other elements (edges, centres), like Canva's guides.
 * box: the moving bounds; others: bounds of the elements that stay; page: { width, height }; th: how close (page px).
 * Returns { dx, dy, guides: [{ axis: 'x' | 'y', at, from, to }] }.
 */
export function snap(box, others, page, th) {
  const xs = [0, page.width / 2, page.width];
  const ys = [0, page.height / 2, page.height];
  for (const o of others) { xs.push(o.x1, (o.x1 + o.x2) / 2, o.x2); ys.push(o.y1, (o.y1 + o.y2) / 2, o.y2); }
  const mine = (a, b) => [a, (a + b) / 2, b];
  const best = (vals, targets) => {
    let r = null;
    for (const v of vals) for (const t of targets) { const d = t - v; if (Math.abs(d) <= th && (!r || Math.abs(d) < Math.abs(r.d) - 1e-6)) r = { d, at: t }; }
    return r;
  };
  const bx = best(mine(box.x1, box.x2), xs);
  const by = best(mine(box.y1, box.y2), ys);
  const dx = bx ? bx.d : 0;
  const dy = by ? by.d : 0;
  const guides = [];
  const moved = { x1: box.x1 + dx, y1: box.y1 + dy, x2: box.x2 + dx, y2: box.y2 + dy };
  // a guide line through every place that lines up after the snap (the whole page height/width, like Canva)
  if (bx) for (const v of mine(moved.x1, moved.x2)) if (xs.some((t) => Math.abs(t - v) < 0.5)) guides.push({ axis: 'x', at: v });
  if (by) for (const v of mine(moved.y1, moved.y2)) if (ys.some((t) => Math.abs(t - v) < 0.5)) guides.push({ axis: 'y', at: v });
  return { dx, dy, guides: dedupe(guides) };
}
const dedupe = (gs) => gs.filter((g, i) => gs.findIndex((h) => h.axis === g.axis && Math.abs(h.at - g.at) < 0.5) === i);
/** Rotation snaps to 0/45/90/… within a few degrees. */
export function snapAngle(deg, th = 4) {
  const n = Math.round(deg / 45) * 45;
  return Math.abs(deg - n) <= th ? n : deg;
}

// ---------------------------------------------------------------------------------------------
// Page and element operations (on a design object; the editor wraps them in undo steps)
export function moveEl(page, id, to) {
  const i = page.els.findIndex((e) => e.id === id);
  if (i < 0) return;
  const [e] = page.els.splice(i, 1);
  const j = to === 'top' ? page.els.length : to === 'bottom' ? 0 : to === 'up' ? Math.min(page.els.length, i + 1) : Math.max(0, i - 1);
  page.els.splice(j, 0, e);
}
/** Copies of elements, a little lower right, with new ids. */
export function duplicateEls(design, els, offset = 30) {
  return els.map((e) => {
    const c = clone(e);
    c.id = uid('c');
    c.x = Math.round(((e.x || 0) + offset / design.width) * 10000) / 10000;
    c.y = Math.round(((e.y || 0) + offset / design.height) * 10000) / 10000;
    return c;
  });
}
export function duplicatePage(design, i) {
  const p = clone(design.pages[i]);
  p.id = uid('pg');
  for (const e of p.els) e.id = uid('c');
  design.pages.splice(i + 1, 0, p);
  return p;
}
/**
 * Align elements (their bounds `boxes` by id) on the page or to each other: left, center, right, top, middle, bottom.
 * One element: to the page. Several: to their common bounds. Returns { id: { dx, dy } } in page px.
 */
export function alignMoves(boxes, page, how) {
  const ids = Object.keys(boxes);
  const ref = ids.length > 1 ? union(Object.values(boxes)) : { x1: 0, y1: 0, x2: page.width, y2: page.height };
  const out = {};
  for (const id of ids) {
    const b = boxes[id];
    let dx = 0;
    let dy = 0;
    if (how === 'left') dx = ref.x1 - b.x1;
    if (how === 'center') dx = (ref.x1 + ref.x2) / 2 - (b.x1 + b.x2) / 2;
    if (how === 'right') dx = ref.x2 - b.x2;
    if (how === 'top') dy = ref.y1 - b.y1;
    if (how === 'middle') dy = (ref.y1 + ref.y2) / 2 - (b.y1 + b.y2) / 2;
    if (how === 'bottom') dy = ref.y2 - b.y2;
    out[id] = { dx, dy };
  }
  return out;
}
/** Spread three or more elements evenly (horizontally 'h' or vertically 'v'). */
export function distributeMoves(boxes, how) {
  const list = Object.entries(boxes).sort(([, a], [, b]) => (how === 'h' ? a.x1 - b.x1 : a.y1 - b.y1));
  const out = {};
  if (list.length < 3) return out;
  const size = (b) => (how === 'h' ? b.x2 - b.x1 : b.y2 - b.y1);
  const first = list[0][1];
  const last = list.at(-1)[1];
  const span = how === 'h' ? last.x2 - first.x1 : last.y2 - first.y1;
  const gap = (span - list.reduce((a, [, b]) => a + size(b), 0)) / (list.length - 1);
  let at = how === 'h' ? first.x1 : first.y1;
  for (const [id, b] of list) {
    const d = at - (how === 'h' ? b.x1 : b.y1);
    out[id] = how === 'h' ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    at += size(b) + gap;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
/** Undo / redo: whole-document snapshots (a design is small JSON), at most `max`. */
export class History {
  constructor(max = 80) { this.max = max; this.past = []; this.future = []; }
  /** Remember the state before a change (a JSON string). */
  push(before) {
    if (this.past.at(-1) === before) return;
    this.past.push(before);
    if (this.past.length > this.max) this.past.shift();
    this.future = [];
  }
  undo(now) { if (!this.past.length) return null; this.future.push(now); return this.past.pop(); }
  redo(now) { if (!this.future.length) return null; this.past.push(now); return this.future.pop(); }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}
/** What of a design goes into an undo step (pages, media, size; not the name or the server's revision). */
export const snapshotOf = (d) => JSON.stringify({ pages: d.pages, media: d.media, width: d.width, height: d.height, sizeId: d.sizeId ?? null });

/**
 * (v1.13.1) A new page size for the whole design, like a design app's resize: places stay where they are on the page
 * (they are parts of it), sizes follow the page's shorter side, so a layout keeps its look on a page of another shape.
 */
export function resizeDesign(d, w, h, sizeId = null) {
  w = Math.round(Math.min(8000, Math.max(64, w)));
  h = Math.round(Math.min(8000, Math.max(64, h)));
  const k = Math.min(w, h) / Math.min(d.width, d.height);
  // a photo's base size is the photo fitted inside the page: that changes with the page, so its scale makes up for it
  const fit = (m, cr, W, H) => Math.min(W / Math.max(1, m.width * (1 - cr.l - cr.r)), H / Math.max(1, m.height * (1 - cr.t - cr.b)));
  for (const p of d.pages) {
    for (const e of p.els) {
      let f = k;
      const m = e.type === 'image' ? d.media.find((x) => x.id === e.mediaId) : null;
      if (m?.width && m?.height) {
        const cr = e.crop || { l: 0, t: 0, r: 0, b: 0 };
        f = (k * fit(m, cr, d.width, d.height)) / fit(m, cr, w, h);
      }
      e.scale = Math.round((e.scale ?? 1) * f * 10000) / 10000;
    }
  }
  d.width = w;
  d.height = h;
  d.aspect = aspectOf(w, h);
  d.sizeId = sizeId;
  return d;
}
