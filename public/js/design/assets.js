// Najja Desain (v1.13): photos and icons.
//   photos — imported from the device (pick, paste, drop), kept in the Najja server's media library (the same as the
//   video editor's), shown on screen from a lighter copy (≤ 2048 px: smooth on a tablet) and exported from the
//   original; "Hapus latar" through the server's AI service.
//   icons — the Lucide set (ISC), fetched once from the server's /vendor and drawn as vectors.
import { remote } from '../remote.js';
import { db } from '../db.js';
import { uid } from '../util.js';
import { photosOf } from './exportcheck.js';

const PREVIEW_MAX = 2048;
const MAX_IMPORT = 6000;
export const LUCIDE = '/vendor/lucide-1.76.0';

/** A decoded picture from a Blob: { el (ImageBitmap/HTMLImageElement), w, h }. */
async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try { const b = await createImageBitmap(blob); return { el: b, w: b.width, h: b.height }; } catch { /* below */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { el: img, w: img.naturalWidth, h: img.naturalHeight };
  } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}
/** A copy no bigger than max px (the on-screen picture). */
function shrink(pic, max) {
  const k = Math.min(1, max / Math.max(pic.w, pic.h));
  if (k >= 1) return pic;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(pic.w * k));
  c.height = Math.max(1, Math.round(pic.h * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(pic.el, 0, 0, c.width, c.height);
  return { el: c, w: c.width, h: c.height };
}

export class Assets {
  constructor(app) {
    this.app = app;
    this.sources = new Map(); // mediaId → on-screen picture
    this.full = new Map(); // mediaId → original (export)
    this.blobs = new Map(); // mediaId → Blob of a photo not on the server yet / just imported
    this.pending = new Map();
    this.icons = null;
  }
  /** Load every photo of the design (in the background: each appears when ready). */
  loadAll() {
    return Promise.all(this.app.design.media.filter((m) => m.type === 'image').map((m) => this.load(m.id).catch(() => null)));
  }
  async blobOf(id) {
    if (this.blobs.has(id)) return this.blobs.get(id);
    if (!remote.enabled) {
      // (no server: the photo was kept in this browser)
      const rec = await db.getMedia(id);
      if (rec?.blob) return rec.blob;
      throw new Error('foto tidak ada di browser ini');
    }
    const r = await fetch(remote.mediaUrl(id), { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`foto tidak bisa dimuat (HTTP ${r.status})`);
    return r.blob();
  }
  load(id) {
    if (this.sources.has(id)) return Promise.resolve(this.sources.get(id));
    if (this.pending.has(id)) return this.pending.get(id);
    const p = (async () => {
      const pic = await decode(await this.blobOf(id));
      this.full.set(id, pic);
      const small = shrink(pic, PREVIEW_MAX);
      this.sources.set(id, small);
      this.app.stage?.invalidate(true);
      return small;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }
  /** The original picture (export). */
  async original(id) {
    if (this.full.has(id)) return this.full.get(id);
    await this.load(id);
    if (this.full.has(id)) return this.full.get(id);
    // (v1.13.2) only the on-screen copy is here: the original is fetched again, never the small copy or nothing
    const pic = await decode(await this.blobOf(id));
    this.full.set(id, pic);
    return pic;
  }
  /**
   * Sources at full quality for an export of these pages. (v1.13.2) A photo that does not load is no longer left
   * out silently (the file came out without the product photo): it is listed in `failed` ({ id, pages, error }) and
   * the export stops (design/app.js).
   */
  async exportSources(pages) {
    const out = new Map();
    const failed = [];
    for (const ph of photosOf(pages)) {
      try {
        const pic = await this.original(ph.id);
        if (!pic) throw new Error('foto tidak ada');
        out.set(ph.id, pic);
      } catch (err) { failed.push({ ...ph, error: err?.message || String(err) }); }
    }
    return Object.assign(out, { failed });
  }

  /**
   * Import photo files: decoded here (on screen at once), saved to the server in the background.
   * Resolves the media entries ({ id, type, name, width, height, size }).
   */
  async importFiles(files) {
    const out = [];
    for (const f of files) {
      if (!/^image\//.test(f.type) && !/\.(png|jpe?g|webp|gif|avif|heic)$/i.test(f.name || '')) continue;
      let pic;
      try { pic = await decode(f); } catch { this.app.toast(`"${f.name}" tidak bisa dibuka sebagai gambar`, 'err'); continue; }
      let blob = f;
      // (a huge photo: made smaller first — a 48 MP shot is not needed for a 1080 px design)
      if (Math.max(pic.w, pic.h) > MAX_IMPORT) {
        const s = shrink(pic, MAX_IMPORT);
        blob = await new Promise((r) => s.el.toBlob(r, 'image/jpeg', 0.92));
        pic = s;
      }
      const m = { id: uid('m'), type: 'image', name: (f.name || 'foto').replace(/\.[^.]+$/, '').slice(0, 60) || 'foto', width: pic.w, height: pic.h, size: blob.size, createdAt: Date.now() };
      this.full.set(m.id, pic);
      this.sources.set(m.id, shrink(pic, PREVIEW_MAX));
      this.blobs.set(m.id, blob);
      out.push(m);
      this.upload(m, blob, f.name || `${m.name}.jpg`);
    }
    return out;
  }
  /** Keep the photo in the server's media library (the design only stores its id). */
  async upload(m, blob, filename) {
    if (!remote.enabled) {
      // no server (the page opened without one): kept in this browser, like the video editor's media
      await db.putMedia({ id: m.id, blob, meta: { ...m } }).catch?.(() => {});
      return;
    }
    this.app.uploading(+1);
    try {
      await remote.upload(blob, { target: 'media', mediaId: m.id, filename, mime: blob.type || 'image/jpeg' });
      await remote.putMeta(m.id, { entry: { id: m.id, name: m.name, type: 'image', duration: 0, width: m.width, height: m.height, size: blob.size, hasAudio: false, createdAt: m.createdAt } });
      delete m.local;
    } catch (err) {
      m.local = true;
      this.app.toast(`Foto "${m.name}" belum tersimpan di server: ${err.message}`, 'err');
    } finally { this.app.uploading(-1); }
  }

  /** Remove a photo's background with the server's AI (the same as the home screen's tool). Resolves a new media. */
  async removeBackground(mediaId, onProgress = () => {}) {
    const st = await fetch('/api/ai', { cache: 'no-store', credentials: 'same-origin' }).then((r) => r.json()).catch(() => null);
    if (!st?.available) throw new Error(st?.reason || 'layanan AI di server belum berjalan');
    const src = this.app.design.media.find((m) => m.id === mediaId);
    let blob = await this.blobOf(mediaId);
    // (≤ 4096 px, like the home screen's tool)
    const pic = await this.original(mediaId);
    if (Math.max(pic.w, pic.h) > 4096) { const s = shrink(pic, 4096); blob = await new Promise((r) => s.el.toBlob(r, 'image/png')); }
    const q = new URLSearchParams({ name: `${src?.name || 'foto'}` });
    const r = await fetch(`/api/ai/cutout?${q}`, { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'image/png' }, credentials: 'same-origin' });
    let x = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(x.error || `HTTP ${r.status}`);
    while (!['done', 'failed', 'cancelled'].includes(x.state)) {
      onProgress(x.progress || 0);
      await new Promise((ok) => setTimeout(ok, 600));
      const rr = await fetch(`/api/ai/${x.id}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!rr.ok) throw new Error('permintaan tidak ditemukan');
      x = await rr.json();
    }
    if (x.state !== 'done') throw new Error(x.error || 'gagal');
    const out = await (await fetch(x.resultUrl, { credentials: 'same-origin' })).blob();
    const [m] = await this.importFiles([new File([out], `${src?.name || 'foto'}-tanpa-latar.png`, { type: out.type || 'image/png' })]);
    return m;
  }

  // ---- icons
  /** The Lucide icons: [{ name, nodes, tags }] (fetched once, ±180 KB gzipped). */
  async loadIcons() {
    if (this.icons) return this.icons;
    if (!this.iconsLoading) {
      this.iconsLoading = (async () => {
        const [nodes, tags] = await Promise.all([
          fetch(`${LUCIDE}/icon-nodes.json`, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error(`ikon belum tersedia (HTTP ${r.status})`); return r.json(); }),
          fetch(`${LUCIDE}/tags.json`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
        ]);
        this.icons = Object.entries(nodes).map(([name, n]) => ({ name, nodes: n, tags: tags[name] || [] }));
        return this.icons;
      })().catch((err) => { this.iconsLoading = null; throw err; });
    }
    return this.iconsLoading;
  }
}

/** Search words in Indonesian → the icon set's English tags. */
const ID_WORDS = {
  tas: 'bag', keranjang: 'cart', belanja: 'shopping', kirim: 'truck', pengiriman: 'truck', truk: 'truck', bintang: 'star', hati: 'heart', suka: 'heart', centang: 'check',
  jam: 'clock', waktu: 'clock', timer: 'timer', hadiah: 'gift', kado: 'gift', diskon: 'percent', persen: 'percent', harga: 'tag', label: 'tag', uang: 'banknote', dompet: 'wallet',
  telepon: 'phone', hp: 'smartphone', lokasi: 'map-pin', rumah: 'home', foto: 'camera', kamera: 'camera', air: 'droplet', tetes: 'droplets', petir: 'zap', kilat: 'zap', api: 'flame',
  aman: 'shield', perisai: 'shield', kunci: 'lock', paket: 'package', kotak: 'box', bulu: 'feather', ringan: 'feather', panah: 'arrow', plus: 'plus', tambah: 'plus', pesan: 'message',
  chat: 'message', mata: 'eye', senyum: 'smile', matahari: 'sun', bulan: 'moon', bunga: 'flower', daun: 'leaf', baju: 'shirt', pesawat: 'plane', koper: 'luggage', mahkota: 'crown', piala: 'trophy',
};
export function searchIcons(icons, q, limit = 120) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return icons.slice(0, limit);
  const words = [s, ID_WORDS[s]].filter(Boolean);
  const scored = [];
  for (const ic of icons) {
    let score = 0;
    for (const w of words) {
      if (ic.name === w) score = Math.max(score, 3);
      else if (ic.name.includes(w)) score = Math.max(score, 2);
      else if (ic.tags.some((t) => t.includes(w))) score = Math.max(score, 1);
    }
    if (score) scored.push([score, ic]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length).slice(0, limit).map(([, ic]) => ic);
}
