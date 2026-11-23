// Najja Desain (v1.13): the design editor page. A design is a project of kind 'design' (pages of elements) kept on
// the Najja server like a video project; this module loads it, keeps every change undoable, saves it shortly after
// each change, and carries out the commands of the canvas (stage.js) and of the panels and toolbar (ui.js).
import { storage } from '../storage.js';
import { remote } from '../remote.js';
import { onFontsLoaded, preloadFonts, baseSize } from '../render.js';
import { clone } from '../util.js';
import {
  newDesign, normalizeDesign, newPage, sizeById, History, snapshotOf, imageEl, fillSlot, slotEl, slotOf, textEl, TEXT_KINDS, resizeDesign, aspectOf,
  duplicateEls, duplicatePage, moveEl, alignMoves, distributeMoves, aabb,
} from './model.js';
import { Assets } from './assets.js';
import { Stage } from './stage.js';
import { UI } from './ui.js';
import { pageCanvas, toBlob, envFor, canvasFits } from './draw.js';
import { exportScale, fontsOf, photoLabel } from './exportcheck.js';
import { zip } from './zip.js';

const SAVE_DELAY = 700;
const typing = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
const r4 = (v) => Math.round(v * 10000) / 10000;
const safeName = (s) => String(s || '').normalize('NFKD').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'desain';

class DesignApp {
  constructor() {
    this.design = null;
    this.pageIndex = 0;
    this.sel = [];
    this.history = new History(80);
    this.baseRev = null;
    this.saving = false;
    this.pendingSave = false;
    this.unsaved = false;
    this.uploadsN = 0;
    this.clipboard = null;
    this.last = { label: null, t: 0 };
  }
  get page() { return this.design.pages[this.pageIndex]; }
  selected() { const ids = new Set(this.sel); return this.page.els.filter((e) => ids.has(e.id)); }
  one() { const s = this.selected(); return s.length === 1 ? s[0] : null; }
  findEl(id) {
    for (const p of this.design.pages) { const el = p.els.find((e) => e.id === id); if (el) return { page: p, el }; }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  async boot() {
    await storage.init();
    const q = new URLSearchParams(location.search);
    let rec;
    if (q.get('new')) {
      // a new design (from the home screen): saved at once, so a reload keeps it
      const size = sizeById(q.get('new'));
      const w = Number(q.get('w')) || size?.w || 1080;
      const h = Number(q.get('h')) || size?.h || 1080;
      rec = newDesign({ name: (q.get('name') || '').slice(0, 80) || size?.name || `Desain ${w} × ${h}`, w, h, sizeId: size?.id || null });
      try {
        const res = await storage.putProject(rec, { baseRev: storage.server ? 0 : null });
        if (res?.rev != null) rec.rev = res.rev;
      } catch (err) { return this.fail(`Desain baru tidak bisa dibuat: ${err.message}`); }
      history.replaceState(null, '', `/design?id=${encodeURIComponent(rec.id)}`);
    } else {
      const id = q.get('id');
      if (!id) { location.replace('/'); return; }
      try { rec = await storage.getProject(id); } catch { rec = null; }
      if (!rec) return this.fail('Desain ini tidak ditemukan (mungkin sudah dihapus).');
      if (rec.kind !== 'design') { location.replace(`/?p=${encodeURIComponent(id)}`); return; }
    }
    this.design = normalizeDesign(rec);
    this.baseRev = rec.rev ?? 0;
    this.assets = new Assets(this);
    this.ui = new UI(this);
    this.stage = new Stage(this);
    onFontsLoaded(() => { this.stage.invalidate(true); this.ui.fontsChanged(); });
    this.ui.init();
    this.ui.saveState(storage.server ? 'saved' : 'local');
    this.listen();
    // fonts of the texts first (no jump when they arrive), photos in the background (each shows when ready)
    await preloadFonts({ clips: this.design.pages.flatMap((p) => p.els) }).catch(() => {});
    this.assets.loadAll().then(() => this.ui.drawPageThumbs());
    for (const p of this.design.pages) if (p.bg?.mediaId) this.assets.load(p.bg.mediaId).catch(() => {});
    this.stage.layout();
    document.querySelector('.ds-boot').hidden = true;
    window.najjaDesign = this; // (tests, and a look from the console)
  }
  fail(msg) {
    const b = document.querySelector('.ds-boot');
    b.hidden = false;
    b.innerHTML = '<div style="text-align:center;max-width:340px;padding:20px"><p style="margin:0 0 14px"></p><a class="ds-btn acc" href="/">Kembali ke Beranda</a></div>';
    b.querySelector('p').textContent = msg;
  }

  // ---------------------------------------------------------------------------------------------
  // changes, undo, saving
  /** A change of the design (one undo step; the same label within a second is one step: sliders, nudges). */
  change(label, fn, { coalesce = true } = {}) {
    const now = performance.now();
    if (!(coalesce && this.last.label === label && now - this.last.t < 1000)) this.history.push(snapshotOf(this.design));
    this.last = { label, t: now };
    fn();
    this.dirty();
  }
  /** Start of a drag (stage.js): the state before it. */
  begin() { this.last = { label: null, t: 0 }; return snapshotOf(this.design); }
  end(before) {
    if (before && before !== snapshotOf(this.design)) { this.history.push(before); this.dirty(); } else this.stage.invalidate(true);
    this.last = { label: null, t: 0 };
  }
  dirty() {
    this.stage.invalidate(true);
    this.ui.changed();
    this.scheduleSave();
  }
  restore(json) {
    if (!json) return;
    if (this.stage.editing) this.stage.endEdit();
    const o = JSON.parse(json);
    this.design.pages = o.pages;
    this.design.media = o.media;
    if (o.width && o.height && (o.width !== this.design.width || o.height !== this.design.height)) {
      Object.assign(this.design, { width: o.width, height: o.height, aspect: aspectOf(o.width, o.height), sizeId: o.sizeId ?? null });
      this.sizeChanged();
    }
    this.pageIndex = Math.min(this.pageIndex, this.design.pages.length - 1);
    const ids = new Set(this.page.els.map((e) => e.id));
    this.sel = this.sel.filter((id) => ids.has(id));
    this.last = { label: null, t: 0 };
    this.ui.closePop();
    this.ui.renderPages();
    this.dirty();
  }
  undo() { if (this.stage.editing) this.stage.endEdit(); this.restore(this.history.undo(snapshotOf(this.design))); }
  redo() { if (this.stage.editing) this.stage.endEdit(); this.restore(this.history.redo(snapshotOf(this.design))); }
  scheduleSave() {
    this.unsaved = true;
    this.ui.saveState(this.uploadsN ? 'uploading' : 'dirty');
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.save(), SAVE_DELAY);
  }
  /** The home screen's picture of the design: its first page, small. */
  thumb() {
    try {
      const d = this.design;
      const k = 360 / Math.max(d.width, d.height);
      const c = pageCanvas(d, d.pages[0], k, { sources: this.assets.sources });
      return c.toDataURL('image/jpeg', 0.78);
    } catch { return undefined; }
  }
  async save({ force = false } = {}) {
    clearTimeout(this.saveT);
    if (this.saving) { this.pendingSave = true; return this.savingP; }
    this.saving = true;
    this.unsaved = false;
    this.ui.saveState('saving');
    this.savingP = (async () => {
      try {
        const d = this.design;
        d.updatedAt = Date.now();
        const rec = { ...d, thumb: this.thumb() };
        delete rec.rev;
        const res = await storage.putProject(rec, { baseRev: storage.server ? this.baseRev : null, force });
        if (res?.rev != null) this.baseRev = res.rev;
        this.ui.saveState(this.unsaved ? 'dirty' : this.uploadsN ? 'uploading' : storage.server ? 'saved' : 'local');
        this.retryUploads();
      } catch (err) {
        this.unsaved = true;
        if (err.status === 409) this.conflict();
        else {
          this.ui.saveState('error', 'Gagal menyimpan · dicoba lagi');
          clearTimeout(this.retryT);
          this.retryT = setTimeout(() => this.save(), 5000);
        }
      } finally {
        this.saving = false;
        if (this.pendingSave) { this.pendingSave = false; this.save(); }
      }
    })();
    return this.savingP;
  }
  /** Another device saved this design since it was opened here: the user chooses. */
  conflict() {
    if (document.querySelector('.ds-modal-bg[data-conflict]')) return;
    this.ui.saveState('error', 'Diubah di perangkat lain');
    const bg = document.createElement('div');
    bg.className = 'ds-modal-bg';
    bg.dataset.conflict = '1';
    bg.innerHTML = `<div class="ds-modal"><h2>Desain diubah di perangkat lain</h2><p class="ds-hint" style="font-size:13px">Sejak dibuka di sini, desain ini disimpan dari perangkat lain. Pilih versi yang dipakai.</p>
      <div class="ds-actions"><button class="ds-btn" data-reload>Muat versi terbaru</button><button class="ds-btn acc" data-force>Pakai versi di sini</button></div></div>`;
    document.body.appendChild(bg);
    bg.addEventListener('click', (e) => {
      if (e.target.closest('[data-reload]')) location.reload();
      if (e.target.closest('[data-force]')) { bg.remove(); this.save({ force: true }); }
    });
  }
  rename(name) {
    this.design.name = String(name || '').trim().slice(0, 80) || 'Desain tanpa judul';
    document.title = `${this.design.name} · Najja Desain`;
    this.scheduleSave();
  }
  uploading(n) {
    this.uploadsN = Math.max(0, this.uploadsN + n);
    if (this.uploadsN) this.ui.saveState('uploading');
    else this.scheduleSave(); // (the photos' "on the server" mark is part of the design)
  }
  /** Photos that did not reach the server (offline for a moment): try again. */
  retryUploads() {
    if (!remote.enabled) return;
    this.retrying = this.retrying || new Set();
    for (const m of this.design.media) {
      if (!m.local || this.retrying.has(m.id) || !this.assets.blobs.has(m.id)) continue;
      this.retrying.add(m.id);
      const blob = this.assets.blobs.get(m.id);
      this.assets.upload(m, blob, `${m.name}.${/png/.test(blob.type) ? 'png' : /webp/.test(blob.type) ? 'webp' : 'jpg'}`).finally(() => this.retrying.delete(m.id));
    }
  }
  async goHome() {
    if (this.stage.editing) this.stage.endEdit();
    if (this.uploadsN) {
      this.toast('Menunggu foto selesai diunggah…');
      const t0 = Date.now();
      while (this.uploadsN && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 300));
    }
    if (this.unsaved || this.saving) { await this.save().catch(() => {}); if (this.saving) await this.savingP?.catch(() => {}); }
    location.href = '/';
  }
  toast(msg, type) { this.ui.toast(msg, type); }

  // ---------------------------------------------------------------------------------------------
  // selection and elements
  select(ids) {
    const have = new Set(this.page.els.map((e) => e.id));
    this.sel = [...new Set(ids)].filter((id) => have.has(id));
    if (this.stage.editing && !this.sel.includes(this.stage.editing)) this.stage.endEdit();
    this.stage.drawOverlay();
    this.ui.closePop();
    this.ui.refreshContext();
    if (this.ui.tab === 'layers' || this.ui.tab === 'up') this.ui.renderPanel();
  }
  /** Add elements to the page (not exactly over the same kind of element already there) and select them. */
  addEls(els, { edit = false } = {}) {
    if (!els?.length) return;
    const near = (a, b) => a.type === b.type && Math.abs((a.x || 0) - (b.x || 0)) < 0.004 && Math.abs((a.y || 0) - (b.y || 0)) < 0.004;
    for (let k = 0; k < 12 && els.some((e) => this.page.els.some((o) => near(o, e))); k++) for (const e of els) { e.x = r4((e.x || 0) + 0.03); e.y = r4((e.y || 0) + 0.03); }
    this.change('Tambah', () => { this.page.els.push(...els); }, { coalesce: false });
    this.select(els.map((e) => e.id));
    if (edit && els.length === 1 && els[0].type === 'text') { this.stage.render(); this.stage.startEdit(els[0], { selectAll: true }); }
  }
  deleteSel() {
    const ids = new Set(this.selected().filter((e) => !e.locked).map((e) => e.id));
    if (!ids.size) return;
    this.change('Hapus', () => { this.page.els = this.page.els.filter((e) => !ids.has(e.id)); }, { coalesce: false });
    this.select([]);
  }
  duplicateSel() {
    const sel = this.selected();
    if (!sel.length) return;
    const copies = duplicateEls(this.design, sel, 30 * (Math.min(this.design.width, this.design.height) / 1080));
    for (const c of copies) delete c.locked;
    this.change('Duplikat', () => { this.page.els.push(...copies); }, { coalesce: false });
    this.select(copies.map((c) => c.id));
  }
  toggleLock() {
    const sel = this.selected();
    if (!sel.length) return;
    const lock = !sel.every((e) => e.locked);
    this.change('Kunci', () => { for (const e of sel) e.locked = lock; }, { coalesce: false });
    this.stage.drawOverlay();
  }
  /** Layer order: up, down, top, bottom (the selection, or ids). */
  layer(to, ids = this.sel) {
    const page = this.page;
    const idx = (id) => page.els.findIndex((e) => e.id === id);
    const list = [...ids].filter((id) => idx(id) >= 0).sort((a, b) => idx(a) - idx(b));
    if (!list.length) return;
    this.change('Urutan lapisan', () => {
      // (several: in the order that keeps them in their order)
      const order = to === 'top' || to === 'down' ? list : [...list].reverse();
      if (to === 'up') for (const id of [...list].reverse()) moveEl(page, id, 'up');
      else if (to === 'down') for (const id of list) moveEl(page, id, 'down');
      else for (const id of order) moveEl(page, id, to);
    }, { coalesce: false });
  }
  boxesOf(els) {
    const out = {};
    for (const e of els) { const b = this.stage.boxes.get(e.id); if (b) out[e.id] = aabb(b); }
    return out;
  }
  moveBy(moves) {
    const W = this.design.width;
    const H = this.design.height;
    for (const [id, m] of Object.entries(moves)) {
      const el = this.page.els.find((e) => e.id === id);
      if (el) { el.x = r4((el.x || 0) + m.dx / W); el.y = r4((el.y || 0) + m.dy / H); }
    }
  }
  align(how) {
    const els = this.selected().filter((e) => !e.locked);
    if (!els.length) return;
    this.change('Ratakan', () => this.moveBy(alignMoves(this.boxesOf(els), this.design, how)), { coalesce: false });
  }
  distribute(how) {
    const els = this.selected().filter((e) => !e.locked);
    if (els.length < 3) return;
    this.change('Sebarkan', () => this.moveBy(distributeMoves(this.boxesOf(els), how)), { coalesce: false });
  }
  copy() {
    const sel = this.selected();
    if (!sel.length) return;
    this.clipboard = clone(sel);
    this.clipboardText = sel.filter((e) => e.type === 'text').map((e) => e.text.content).join('\n') || 'Najja Desain';
    navigator.clipboard?.writeText?.(this.clipboardText).catch(() => {});
    this.toast(`${sel.length} elemen disalin`);
  }
  paste() {
    if (!this.clipboard?.length) return;
    const copies = duplicateEls(this.design, this.clipboard, 30 * (Math.min(this.design.width, this.design.height) / 1080));
    // (photos of another design come along: their library entries too)
    this.addEls(copies);
    this.clipboard = clone(copies);
  }

  // ---------------------------------------------------------------------------------------------
  // photos
  pickPhotos(opts = {}) {
    const input = document.querySelector('.ds-file');
    input.multiple = !(opts.slot || opts.replace || opts.bg);
    input.value = '';
    input.onchange = () => { const files = [...input.files]; input.onchange = null; if (files.length) this.addPhotos(files, opts); };
    input.click();
  }
  /** Imported photos: into a slot, in place of a photo, as the background, or added to the page (at a point). */
  async addPhotos(files, { at = null, slot = null, replace = null, bg = false } = {}) {
    let media;
    try { media = await this.assets.importFiles(files); } catch (err) { this.toast(`Foto tidak bisa diimpor: ${err.message}`, 'err'); return; }
    if (!media.length) { this.toast('Tidak ada gambar yang bisa dipakai', 'err'); return; }
    const added = [];
    this.change('Tambah foto', () => {
      this.design.media.push(...media);
      let rest = media;
      if (bg) {
        this.page.bg = { ...(this.page.bg || {}), mediaId: media[0].id };
        rest = media.slice(1);
      } else if (slot && this.page.els.some((e) => e.id === slot.id && e.slot)) {
        const i = this.page.els.findIndex((e) => e.id === slot.id);
        this.page.els[i] = fillSlot(this.design, this.page.els[i], media[0]);
        added.push(slot.id);
        rest = media.slice(1);
      } else if (replace && this.findEl(replace.id)) {
        this.swapMedia(this.findEl(replace.id).el, media[0]);
        added.push(replace.id);
        rest = media.slice(1);
      }
      rest.forEach((m, i) => {
        const el = imageEl(this.design, m, at ? { x: r4(at.x / this.design.width - 0.5), y: r4(at.y / this.design.height - 0.5) } : {});
        el.x = r4((el.x || 0) + i * 0.04);
        el.y = r4((el.y || 0) + i * 0.04);
        this.page.els.push(el);
        added.push(el.id);
      });
    }, { coalesce: false });
    this.select(added);
    if (this.ui.tab === 'up') this.ui.renderPanel();
  }
  /** A photo of the design's library put to use (Unggahan panel). */
  usePhoto(mediaId) {
    const m = this.design.media.find((x) => x.id === mediaId);
    if (!m) return;
    const one = this.one();
    if (one?.slot) {
      this.change('Isi bingkai', () => { this.page.els[this.page.els.indexOf(one)] = fillSlot(this.design, one, m); }, { coalesce: false });
      this.select([one.id]);
      return;
    }
    this.addEls([imageEl(this.design, m)]);
  }
  /** Another photo in an image element: the same place and size (and frame, for a filled slot). */
  swapMedia(el, m) {
    if (el.fromSlot) {
      Object.assign(el, fillSlot(this.design, slotOf(el), m), { filter: el.filter, adjust: el.adjust, dropShadow: el.dropShadow });
      return;
    }
    const env = envFor(this.design, 1, this.assets.sources);
    const before = baseSize(el, env, null);
    const oldSide = Math.max(before.w, before.h) * (el.scale ?? 1);
    el.mediaId = m.id;
    el.crop = { l: 0, t: 0, r: 0, b: 0 };
    el.name = m.name;
    const after = baseSize(el, env, null);
    el.scale = r4(oldSide / Math.max(1, Math.max(after.w, after.h)));
  }
  /**
   * (v1.13.1) A photo dragged onto a photo frame goes into it: the frame (empty, or with a photo, which it replaces)
   * gets the photo, cropped to it; the dragged photo is no longer a separate element. Part of the drag's undo step.
   */
  dropIntoFrame(imgId, frameId) {
    const page = this.page;
    const img = page.els.find((e) => e.id === imgId);
    const fi = page.els.findIndex((e) => e.id === frameId);
    const m = img && this.design.media.find((x) => x.id === img.mediaId);
    const slot = fi >= 0 ? slotOf(page.els[fi]) : null;
    if (!img || !m || !slot) return false;
    const filled = fillSlot(this.design, slot, m);
    Object.assign(filled, { filter: img.filter, adjust: img.adjust, flipH: !!img.flipH, flipV: !!img.flipV });
    page.els[fi] = filled;
    page.els = page.els.filter((e) => e.id !== imgId);
    this.sel = [filled.id];
    return true;
  }
  /** A filled frame back to an empty one. */
  unslot(el) {
    const f = el.fromSlot;
    if (!f) return;
    const s = slotEl(this.design, f.kind, 100, 100, {}, f.label);
    const at = slotOf(el);
    Object.assign(s, { id: el.id, x: el.x, y: el.y, rotation: el.rotation, scale: at.scale, opacity: el.opacity });
    s.shape.w = f.w;
    s.shape.h = f.h;
    s.shape.radius = f.radius;
    this.change('Kosongkan bingkai', () => { this.page.els[this.page.els.indexOf(el)] = s; }, { coalesce: false });
    this.select([s.id]);
  }
  imageToBg(el) {
    this.change('Jadikan latar', () => {
      this.page.bg = { ...(this.page.bg || {}), mediaId: el.mediaId };
      this.page.els = this.page.els.filter((e) => e !== el);
    }, { coalesce: false });
    this.select([]);
  }
  /** Crop a photo, keeping how big its pixels are on the page. */
  setCrop(el, crop) {
    const m = this.design.media.find((x) => x.id === el.mediaId);
    if (!m) return;
    const W = this.design.width;
    const H = this.design.height;
    const fit = (c) => Math.min(W / Math.max(1, m.width * (1 - c.l - c.r)), H / Math.max(1, m.height * (1 - c.t - c.b)));
    this.change('Potong', () => {
      const k0 = fit(el.crop || { l: 0, t: 0, r: 0, b: 0 });
      el.crop = { ...crop };
      el.scale = r4((el.scale ?? 1) * (k0 / fit(el.crop)));
    });
  }
  async removeBg(el) {
    if (this.cutting) { this.toast('Masih menghapus latar foto lain…'); return; }
    this.cutting = true;
    const id = el.id;
    const t = this.ui.busy('Menghapus latar… (biasanya 5–30 detik)');
    try {
      const m = await this.assets.removeBackground(el.mediaId, (p) => t.set(`Menghapus latar… ${Math.round((p || 0) * 100)}%`));
      const hit = this.findEl(id);
      this.change('Hapus latar', () => {
        this.design.media.push(m);
        if (hit) this.swapMedia(hit.el, m);
      }, { coalesce: false });
      t.done(hit ? 'Latar foto dihapus' : 'Foto tanpa latar ada di Unggahan', 'ok');
    } catch (err) {
      t.done(`Hapus latar gagal: ${err.message}`, 'err');
    } finally { this.cutting = false; }
  }

  // ---------------------------------------------------------------------------------------------
  // size of the page (v1.13.1)
  /** Another page size for this design (undoable). */
  resize(w, h, sizeId = null) {
    if (this.stage.editing) this.stage.endEdit();
    if (w === this.design.width && h === this.design.height) return;
    this.change('Ubah ukuran', () => resizeDesign(this.design, w, h, sizeId), { coalesce: false });
    this.sizeChanged();
    this.toast(`Ukuran desain: ${this.design.width} × ${this.design.height} px`, 'ok');
  }
  /** A copy of this design in another size (opened), this one as it is. */
  async copyResized(w, h, sizeId = null) {
    if (this.stage.editing) this.stage.endEdit();
    await this.save().catch(() => {});
    const copy = JSON.parse(JSON.stringify(this.design));
    const fresh = newDesign({ w, h });
    copy.id = fresh.id;
    delete copy.rev;
    delete copy.ownerId;
    copy.createdAt = copy.updatedAt = Date.now();
    resizeDesign(copy, w, h, sizeId);
    const size = sizeById(sizeId);
    copy.name = `${this.design.name || 'Desain'} · ${size?.name || `${copy.width}×${copy.height}`}`.slice(0, 80);
    copy.thumb = undefined;
    try {
      await storage.putProject(copy, { baseRev: storage.server ? 0 : null });
    } catch (err) { this.toast(`Salinan tidak bisa dibuat: ${err.message}`, 'err'); return; }
    location.href = `/design?id=${encodeURIComponent(copy.id)}`;
  }
  sizeChanged() {
    this.stage.zoomFit();
    this.ui.init(false);
  }

  // ---------------------------------------------------------------------------------------------
  // pages
  gotoPage(i) {
    if (i < 0 || i >= this.design.pages.length) return;
    if (this.stage.editing) this.stage.endEdit();
    this.pageIndex = i;
    this.sel = [];
    this.stage.invalidate(true);
    this.ui.renderPages();
    this.ui.refreshContext();
    if (this.ui.tab === 'layers' || this.ui.tab === 'bg') this.ui.renderPanel();
  }
  addPage(after = this.pageIndex, page = newPage()) {
    this.change('Tambah halaman', () => { this.design.pages.splice(after + 1, 0, page); }, { coalesce: false });
    this.gotoPage(after + 1);
  }
  duplicatePageAt(i) {
    this.change('Duplikat halaman', () => duplicatePage(this.design, i), { coalesce: false });
    this.gotoPage(i + 1);
  }
  deletePage(i) {
    if (this.design.pages.length < 2) return;
    if (this.stage.editing) this.stage.endEdit();
    // (the page shown moves with the deletion in the same step: the last page deleted while on it left the editor
    // pointing past the end — v1.13.1)
    this.change('Hapus halaman', () => {
      this.design.pages.splice(i, 1);
      this.pageIndex = Math.min(this.pageIndex > i ? this.pageIndex - 1 : this.pageIndex, this.design.pages.length - 1);
      this.sel = [];
    }, { coalesce: false });
    this.gotoPage(this.pageIndex);
  }
  movePage(i, d) {
    const j = i + d;
    if (j < 0 || j >= this.design.pages.length) return;
    this.change('Pindah halaman', () => { const [p] = this.design.pages.splice(i, 1); this.design.pages.splice(j, 0, p); }, { coalesce: false });
    this.gotoPage(j);
  }
  /** A template: on this page when it is empty, else as a new page after it. */
  applyTemplate(t) {
    const out = t.make(this.design);
    if (!this.page.els.length) {
      this.change('Template', () => { this.page.bg = out.bg; this.page.els = out.els; }, { coalesce: false });
      this.select([]);
      this.ui.renderPages();
    } else {
      const p = newPage(out.bg);
      p.els = out.els;
      this.addPage(this.pageIndex, p);
      this.toast('Template ditambahkan sebagai halaman baru');
    }
    preloadFonts({ clips: out.els }).then(() => this.stage.invalidate(true));
  }

  // ---------------------------------------------------------------------------------------------
  // export
  /**
   * The pages as image files ({ name, blob, width, height, reduced }; several pages: one ZIP). fmt: png | jpg | tpng;
   * scale: 1 | 2. (v1.13.2) Before drawing: a photo that does not load stops the export (code PHOTOS, with the
   * list); a font that did not load stops it too (code FONTS) unless anyway: true; a size this device cannot draw
   * is made smaller (reduced: true) instead of giving an empty or broken file.
   */
  async exportFiles({ fmt = 'png', pages = 'cur', scale = 1, anyway = false, onProgress = () => {} } = {}) {
    if (this.stage.editing) this.stage.endEdit();
    const d = this.design;
    const list = pages === 'all' ? d.pages.map((p, i) => [p, i]) : [[this.page, this.pageIndex]];
    const chosen = list.map(([p]) => p);
    await preloadFonts({ clips: chosen.flatMap((p) => p.els) }).catch(() => {});
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
    const sources = await this.assets.exportSources(chosen);
    if (sources.failed.length) {
      const what = sources.failed.map((f) => photoLabel(d, f)).join(', ');
      throw Object.assign(new Error(`${sources.failed.length} foto tidak bisa dimuat: ${what}. Periksa koneksi lalu coba lagi, atau ganti foto itu.`), { code: 'PHOTOS', failed: sources.failed });
    }
    if (!anyway && document.fonts) {
      const fonts = fontsOf(chosen);
      await Promise.race([Promise.all(fonts.map((f) => document.fonts.load(f.spec, f.text || undefined).catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]);
      const missing = [...new Set(fonts.filter((f) => !document.fonts.check(f.spec, f.text || undefined)).map((f) => f.family))];
      if (missing.length) throw Object.assign(new Error(`Font belum termuat: ${missing.join(', ')}. Teksnya akan memakai font pengganti.`), { code: 'FONTS', fonts: missing });
    }
    const size = exportScale(d.width, d.height, scale, canvasFits);
    const type = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
    const ext = fmt === 'jpg' ? 'jpg' : 'png';
    const base = safeName(d.name);
    const files = [];
    for (const [k, [p, i]] of list.entries()) {
      const c = pageCanvas(d, p, size, { sources, transparent: fmt === 'tpng' });
      const blob = await toBlob(c, type, 0.92);
      c.width = 0; // (free the memory at once: tablets keep little)
      c.height = 0;
      files.push({ name: `${base}${d.pages.length > 1 ? `-${i + 1}` : ''}.${ext}`, blob });
      onProgress((k + 1) / list.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    const info = { width: Math.round(d.width * size), height: Math.round(d.height * size), reduced: size < scale };
    if (files.length === 1) return { ...files[0], ...info };
    const z = zip(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) }))));
    return { name: `${base}.zip`, blob: new Blob([z], { type: 'application/zip' }), ...info };
  }

  // ---------------------------------------------------------------------------------------------
  listen() {
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('copy', (e) => {
      if (typing(e.target) || !this.sel.length || this.stage.editing) return;
      e.preventDefault();
      this.copy();
      e.clipboardData?.setData('text/plain', this.clipboardText);
    });
    document.addEventListener('cut', (e) => {
      if (typing(e.target) || !this.sel.length || this.stage.editing) return;
      e.preventDefault();
      this.copy();
      e.clipboardData?.setData('text/plain', this.clipboardText);
      this.deleteSel();
    });
    document.addEventListener('paste', (e) => {
      if (typing(e.target) || this.stage.editing) return;
      const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
      if (files.length) { e.preventDefault(); this.addPhotos(files, { slot: this.one()?.slot ? this.one() : null }); return; }
      const text = e.clipboardData?.getData('text/plain') || '';
      if (this.clipboard && (!text || text === this.clipboardText)) { e.preventDefault(); this.paste(); return; }
      if (text.trim()) {
        e.preventDefault();
        this.addEls([textEl(this.design, { ...TEXT_KINDS.body, content: text.trim().slice(0, 2000), width: text.length > 40 ? 800 : 0 })]);
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.unsaved || this.saving || this.uploadsN) { this.save(); e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.unsaved) this.save(); });
  }
  onKey(e) {
    if (typing(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); this.duplicateSel(); return; }
    if (mod && k === 's') { e.preventDefault(); this.save(); return; }
    if (mod && k === 'a') { e.preventDefault(); this.select(this.page.els.filter((x) => !x.locked && !x.hidden).map((x) => x.id)); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); this.stage.setZoom(this.stage.zoom * 1.25); return; }
    if (mod && k === '-') { e.preventDefault(); this.stage.setZoom(this.stage.zoom / 1.25); return; }
    if (mod && k === '0') { e.preventDefault(); this.stage.zoomFit(); return; }
    if (mod) return;
    if (k === 'delete' || k === 'backspace') { if (this.sel.length) { e.preventDefault(); this.deleteSel(); } return; }
    if (k === 'escape') { if (!this.ui.popEl.hidden) this.ui.closePop(); else this.select([]); return; }
    if (k === 'enter') { const one = this.one(); if (one?.type === 'text' && !one.locked) { e.preventDefault(); this.stage.startEdit(one); } return; }
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (arrows[k] && this.sel.length) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1);
      const els = this.selected().filter((x) => !x.locked);
      this.change('Geser', () => { for (const el of els) { el.x = r4((el.x || 0) + (arrows[k][0] * step) / this.design.width); el.y = r4((el.y || 0) + (arrows[k][1] * step) / this.design.height); } });
    }
  }
}

const app = new DesignApp();
app.boot().catch((err) => { console.error(err); app.fail(`Najja Desain tidak bisa dimuat: ${err.message}`); });
