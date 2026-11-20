// Najja Desain (v1.13): the canvas — the page drawn by render.js, the selection (handles, guides) as light HTML on top.
// Touch first: one finger moves, resizes and turns; two fingers zoom and pan; a tap on a selected text edits it.
// Smooth on a tablet: while something is dragged, the elements under and over it are kept as two pictures and only
// what moves is drawn again; nothing is drawn when nothing changed.
import { drawPage, boxOf, envFor } from './draw.js';
import { aabb, union, hit, snap, snapAngle } from './model.js';
import { layoutText } from '../render.js';

const ROT_ICON = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>';
const r4 = (v) => Math.round(v * 10000) / 10000;

export class Stage {
  constructor(app) {
    this.app = app;
    this.el = document.querySelector('.ds-stage');
    this.scroller = this.el.querySelector('.ds-scroller');
    this.pageEl = this.el.querySelector('.ds-page');
    this.canvas = this.el.querySelector('.ds-canvas');
    this.ov = this.el.querySelector('.ds-ov');
    this.ctx = this.canvas.getContext('2d');
    this.zoom = 1;
    this.fit = true;
    this.boxes = new Map();
    this.pointers = new Map();
    this.op = null;
    this.editing = null;
    this.layers = null;
    this.guides = [];
    this.tag = null;
    this.hover = null;
    new ResizeObserver(() => this.layout()).observe(this.el);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    this.el.addEventListener('pointerup', (e) => this.up(e));
    this.el.addEventListener('pointercancel', (e) => this.up(e, true));
    this.el.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.drawOverlay(); } });
    this.el.addEventListener('dblclick', (e) => { const el = this.hitAt(this.pagePoint(e)); if (el?.type === 'text' && !el.locked) this.startEdit(el); });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const el = this.hitAt(this.pagePoint(e));
      if (el && !this.app.sel.includes(el.id)) this.app.select([el.id]);
      this.app.ui.contextMenu(e.clientX, e.clientY);
    });
    this.el.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }, { passive: false });
    // photos dropped on the page (a computer)
    this.el.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
    this.el.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      const pt = this.pagePoint(e);
      this.app.addPhotos(files, { at: pt, slot: this.hitAt(pt)?.slot ? this.hitAt(pt) : null });
    });
  }
  get design() { return this.app.design; }
  get page() { return this.app.page; }

  // ---- size and zoom
  layout() {
    const d = this.design;
    if (!d) return;
    // (never while an element is being dragged: the page would move under the finger; done after it)
    if (this.op?.moved && this.op.kind !== 'pinch') { this.layoutLater = true; return; }
    this.layoutLater = false;
    const sw = this.el.clientWidth;
    const sh = this.el.clientHeight;
    const padX = sw < 600 ? 18 : 48;
    const padTop = 66; // (room for the element toolbar)
    const padBottom = 46; // (room for the turn handle under an element at the page's bottom)
    if (this.fit) this.zoom = Math.max(0.02, Math.min((sw - padX * 2) / d.width, (sh - padTop - padBottom) / d.height));
    const pw = d.width * this.zoom;
    const ph = d.height * this.zoom;
    const W = Math.max(sw, pw + padX * 2);
    const H = Math.max(sh, ph + padTop + padBottom);
    this.scroller.style.width = `${W}px`;
    this.scroller.style.height = `${H}px`;
    this.pageLeft = Math.round((W - pw) / 2);
    this.pageTop = Math.round(Math.max(padTop, (H - ph) / 2 + (sh > ph + padTop + padBottom ? (padTop - padBottom) / 2 : 0)));
    Object.assign(this.pageEl.style, { left: `${this.pageLeft}px`, top: `${this.pageTop}px`, width: `${pw}px`, height: `${ph}px` });
    // the canvas's pixels: the screen's (≤ 2×), never more than a tablet can hold
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let bs = this.zoom * dpr;
    bs = Math.min(bs, 4096 / Math.max(d.width, d.height), Math.sqrt(16e6 / (d.width * d.height)));
    this.bs = bs;
    const cw = Math.max(1, Math.round(d.width * bs));
    const ch = Math.max(1, Math.round(d.height * bs));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    this.app.ui?.showZoom(this.zoom);
    this.invalidate(true);
  }
  setZoom(z, cx, cy) {
    const r = this.el.getBoundingClientRect();
    const ax = cx ?? r.left + r.width / 2;
    const ay = cy ?? r.top + r.height / 2;
    const before = this.clientToPage(ax, ay);
    this.fit = false;
    this.zoom = Math.max(0.05, Math.min(8, z));
    this.layout();
    // the point under the fingers stays there
    this.el.scrollLeft = this.pageLeft + before.x * this.zoom - (ax - r.left);
    this.el.scrollTop = this.pageTop + before.y * this.zoom - (ay - r.top);
  }
  zoomFit() { this.fit = true; this.layout(); this.el.scrollLeft = 0; this.el.scrollTop = 0; }
  clientToPage(x, y) {
    const r = this.pageEl.getBoundingClientRect();
    return { x: (x - r.left) / this.zoom, y: (y - r.top) / this.zoom };
  }
  pagePoint(e) { return this.clientToPage(e.clientX, e.clientY); }

  // ---- drawing
  invalidate(full = false) {
    if (full) this.layers = null;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }
  render() {
    const d = this.design;
    if (!d) return;
    const ctx = this.ctx;
    const sources = this.app.assets.sources;
    const skip = this.editing ? new Set([this.editing]) : null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.layers) {
      // dragging: the pictures under and over, the moving part drawn again
      const L = this.layers;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(L.under, 0, 0);
      drawPage(ctx, d, this.page, { scale: this.bs, sources, boxes: this.boxes, skip, from: L.lo, to: L.hi + 1, background: false });
      if (L.over) ctx.drawImage(L.over, 0, 0);
    } else {
      this.boxes = new Map();
      drawPage(ctx, d, this.page, { scale: this.bs, sources, boxes: this.boxes, skip });
    }
    this.drawOverlay();
    this.app.ui?.afterRender();
  }
  /** The pictures under and over the selection, for a drag. */
  makeLayers() {
    const els = this.page.els;
    const idx = els.map((e, i) => (this.app.sel.includes(e.id) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    const lo = Math.min(...idx);
    const hi = Math.max(...idx);
    const mk = (from, to, background) => {
      const c = document.createElement('canvas');
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      drawPage(c.getContext('2d'), this.design, this.page, { scale: this.bs, sources: this.app.assets.sources, from, to, background, skip: this.editing ? new Set([this.editing]) : null });
      return c;
    };
    this.layers = { lo, hi, under: mk(0, lo, true), over: hi + 1 < els.length ? mk(hi + 1, els.length, false) : null };
  }

  // ---- overlay: selection, handles, guides
  drawOverlay() {
    const z = this.zoom;
    const sel = this.app.selected();
    let html = '';
    const boxHtml = (b, cls, handles) => {
      const t = `translate(${b.cx * z}px,${b.cy * z}px) rotate(${b.rot}rad) translate(${(-b.w * z) / 2}px,${(-b.h * z) / 2}px)`;
      return `<div class="ds-box ${cls}" style="width:${b.w * z}px;height:${b.h * z}px;transform:${t}">${handles}</div>`;
    };
    if (this.hover && !sel.some((e) => e.id === this.hover) && !this.op) {
      const b = this.boxes.get(this.hover);
      if (b) html += boxHtml(b, 'hover', '');
    }
    if (sel.length === 1 && !this.editing) {
      const e = sel[0];
      const b = this.boxes.get(e.id);
      if (b) {
        let hs = '';
        if (!e.locked && !(this.op && this.op.kind !== 'idle' && this.op.moved && this.op.kind === 'move')) {
          const pos = { nw: [0, 0], ne: [100, 0], se: [100, 100], sw: [0, 100], n: [50, 0], s: [50, 100], e: [100, 50], w: [0, 50] };
          const sides = e.type === 'text' ? ['e', 'w'] : e.type === 'shape' ? ['n', 's', 'e', 'w'] : [];
          for (const k of ['nw', 'ne', 'se', 'sw']) hs += `<i class="ds-h" data-h="${k}" style="left:${pos[k][0]}%;top:${pos[k][1]}%"></i>`;
          for (const k of sides) hs += `<i class="ds-h side ${k === 'e' || k === 'w' ? 'v' : 'hz'}" data-h="${k}" style="left:${pos[k][0]}%;top:${pos[k][1]}%"></i>`;
          hs += `<i class="ds-h rot" data-h="rot" style="left:50%;top:calc(100% + 30px)">${ROT_ICON}</i>`;
        }
        html += boxHtml(b, e.locked ? 'locked' : '', hs);
      }
    } else if (sel.length > 1) {
      const bs = sel.map((e) => this.boxes.get(e.id)).filter(Boolean).map(aabb);
      if (bs.length) {
        const u = union(bs);
        for (const e of sel) { const b = this.boxes.get(e.id); if (b) html += boxHtml(b, 'hover', ''); }
        const hs = this.op?.moved ? '' : ['nw', 'ne', 'se', 'sw'].map((k, i) => `<i class="ds-h" data-h="${k}" style="left:${[0, 100, 100, 0][i]}%;top:${[0, 0, 100, 100][i]}%"></i>`).join('');
        html += boxHtml({ cx: (u.x1 + u.x2) / 2, cy: (u.y1 + u.y2) / 2, w: u.x2 - u.x1, h: u.y2 - u.y1, rot: 0 }, 'multi', hs);
      }
    }
    if (this.op?.dropFrame) {
      const b = this.boxes.get(this.op.dropFrame);
      if (b) html += boxHtml(b, 'drop', '<span class="ds-droptag">Lepas untuk mengisi bingkai</span>');
    }
    for (const g of this.guides) html += g.axis === 'x' ? `<div class="ds-guide x" style="left:${g.at * z}px"></div>` : `<div class="ds-guide y" style="top:${g.at * z}px"></div>`;
    if (this.marq) { const m = this.marq; html += `<div class="ds-marq" style="left:${Math.min(m.x1, m.x2) * z}px;top:${Math.min(m.y1, m.y2) * z}px;width:${Math.abs(m.x2 - m.x1) * z}px;height:${Math.abs(m.y2 - m.y1) * z}px"></div>`; }
    if (this.tag) html += `<div class="ds-tag" style="left:${this.tag.x * z}px;top:${this.tag.y * z + 12}px">${this.tag.text}</div>`;
    if (this.editArea) {
      if (this.ov.firstChild !== this.editArea || this.ov.childNodes.length !== 1) { this.ov.textContent = ''; this.ov.appendChild(this.editArea); }
      return;
    }
    this.ov.innerHTML = html;
  }

  // ---- hit tests
  /** The photo frame under a point (an empty slot, or a frame with a photo in it), not `exceptId`. */
  frameAt(pt, exceptId) {
    const els = this.page.els;
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.id === exceptId || e.hidden || e.locked || !(e.slot || (e.type === 'image' && e.fromSlot))) continue;
      const b = this.boxes.get(e.id);
      if (b && hit(b, pt.x, pt.y)) return e;
    }
    return null;
  }
  hitAt(pt) {
    const els = this.page.els;
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.hidden) continue;
      const b = this.boxes.get(e.id);
      if (b && hit(b, pt.x, pt.y, 4 / this.zoom)) return e;
    }
    return null;
  }

  // ---- pointer input
  down(e) {
    if (this.editArea && e.target === this.editArea) return;
    if (this.editArea) { this.endEdit(); }
    try { this.el.setPointerCapture?.(e.pointerId); } catch { /* (a pointer the browser no longer tracks) */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) { this.startPinch(); return; }
    if (this.pointers.size > 2) return;
    const pt = this.pagePoint(e);
    const h = e.target.closest?.('[data-h]')?.dataset.h;
    const sel = this.app.selected();
    if (h && sel.length) { this.startHandle(h, pt, e); return; }
    const el = this.hitAt(pt);
    clearTimeout(this.pressT);
    if (el) {
      const wasSel = this.app.sel.includes(el.id);
      if (e.shiftKey || e.metaKey) {
        this.app.select(wasSel ? this.app.sel.filter((id) => id !== el.id) : [...this.app.sel, el.id]);
        return;
      }
      if (!wasSel) this.app.select([el.id]);
      this.op = { kind: 'move', start: pt, client: { x: e.clientX, y: e.clientY }, wasSel, el, moved: false, pointerType: e.pointerType };
      if (e.pointerType !== 'mouse') this.pressT = setTimeout(() => { if (this.op && !this.op.moved) { this.op = null; this.app.ui.contextMenu(e.clientX, e.clientY); } }, 550);
      return;
    }
    // the empty page or around it: a frame to select several (mouse), a pan (finger)
    if (e.pointerType === 'mouse' && e.button === 0) this.op = { kind: 'marq', start: pt, moved: false };
    else this.op = { kind: 'pan', client: { x: e.clientX, y: e.clientY }, scroll: { x: this.el.scrollLeft, y: this.el.scrollTop }, moved: false };
  }
  move(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.op?.kind === 'pinch') { this.pinchMove(); return; }
    const op = this.op;
    if (!op) {
      if (e.pointerType === 'mouse') {
        const el = this.hitAt(this.pagePoint(e));
        const id = el?.id || null;
        if (id !== this.hover) { this.hover = id; this.drawOverlay(); }
      }
      return;
    }
    const pt = this.pagePoint(e);
    if (op.kind === 'pan') {
      const dx = e.clientX - op.client.x;
      const dy = e.clientY - op.client.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) op.moved = true;
      this.el.scrollLeft = op.scroll.x - dx;
      this.el.scrollTop = op.scroll.y - dy;
      return;
    }
    if (op.kind === 'marq') {
      if (Math.hypot(pt.x - op.start.x, pt.y - op.start.y) * this.zoom > 4) op.moved = true;
      this.marq = { x1: op.start.x, y1: op.start.y, x2: pt.x, y2: pt.y };
      this.drawOverlay();
      return;
    }
    if (op.kind === 'move') this.moveSel(op, pt, e);
    else if (op.kind === 'scale') this.scaleSel(op, pt);
    else if (op.kind === 'side') this.sideSel(op, pt);
    else if (op.kind === 'rot') this.rotSel(op, pt, e);
  }
  up(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    clearTimeout(this.pressT);
    const op = this.op;
    if (op?.kind === 'pinch') { if (this.pointers.size < 2) this.op = null; return; }
    this.op = null;
    if (this.layoutLater) this.layout();
    if (!op) return;
    if (op.kind === 'marq') {
      const m = this.marq;
      this.marq = null;
      if (op.moved && m) {
        const r = { x1: Math.min(m.x1, m.x2), y1: Math.min(m.y1, m.y2), x2: Math.max(m.x1, m.x2), y2: Math.max(m.y1, m.y2) };
        const ids = this.page.els.filter((el) => !el.hidden && !el.locked).filter((el) => { const b = this.boxes.get(el.id); if (!b) return false; const a = aabb(b); return a.x1 < r.x2 && a.x2 > r.x1 && a.y1 < r.y2 && a.y2 > r.y1; }).map((el) => el.id);
        this.app.select(ids);
      } else this.app.select([]);
      this.drawOverlay();
      return;
    }
    if (op.kind === 'pan') { if (!op.moved && !cancelled) this.app.select([]); return; }
    this.guides = [];
    this.tag = null;
    if (op.moved) {
      this.layers = null;
      if (op.kind === 'move' && op.dropFrame) {
        const one = op.items[0].el;
        one.opacity = op.op0;
        this.app.dropIntoFrame(one.id, op.dropFrame);
      }
      this.app.end(op.before, op.label || 'Ubah');
      this.invalidate(true);
      return;
    }
    // a tap on a text already selected: edit it (like a tablet design app)
    if (op.kind === 'move' && op.wasSel && op.el?.type === 'text' && !op.el.locked && this.app.sel.length === 1 && !cancelled) this.startEdit(op.el);
    this.drawOverlay();
  }

  // ---- operations
  startHandle(h, pt, e) {
    const sel = this.app.selected().filter((x) => !x.locked);
    if (!sel.length) return;
    const z = { start: pt, moved: false, before: null };
    if (h === 'rot') {
      const b = this.boxes.get(sel[0].id);
      this.op = { ...z, kind: 'rot', el: sel[0], c: { x: b.cx, y: b.cy }, a0: Math.atan2(pt.y - b.cy, pt.x - b.cx), r0: sel[0].rotation || 0, label: 'Putar' };
    } else if (h.length === 2) {
      const items = sel.map((el) => ({ el, b: this.boxes.get(el.id), scale: el.scale ?? 1, x: el.x || 0, y: el.y || 0 }));
      let anchor;
      let corner;
      if (sel.length === 1) {
        const { b } = items[0];
        const sx = h.includes('e') ? 1 : -1;
        const sy = h.includes('s') ? 1 : -1;
        const c = Math.cos(b.rot);
        const s = Math.sin(b.rot);
        const off = (lx, ly) => ({ x: b.cx + lx * c - ly * s, y: b.cy + lx * s + ly * c });
        corner = off((sx * b.w) / 2, (sy * b.h) / 2);
        anchor = off((-sx * b.w) / 2, (-sy * b.h) / 2);
      } else {
        const u = union(items.map((i) => aabb(i.b)));
        corner = { x: h.includes('e') ? u.x2 : u.x1, y: h.includes('s') ? u.y2 : u.y1 };
        anchor = { x: h.includes('e') ? u.x1 : u.x2, y: h.includes('s') ? u.y1 : u.y2 };
      }
      this.op = { ...z, kind: 'scale', items, anchor, corner, label: 'Ubah ukuran' };
    } else {
      const el = sel[0];
      const b = this.boxes.get(el.id);
      this.op = { ...z, kind: 'side', h, el, b, x: el.x || 0, y: el.y || 0, w0: el.type === 'text' ? (el.text.width || b.w / (el.scale ?? 1)) : el.shape?.w, h0: el.shape?.h, label: 'Ubah ukuran' };
    }
    e.stopPropagation();
  }
  beginOp(op) {
    if (op.moved) return;
    op.moved = true;
    op.before = this.app.begin();
    this.makeLayers();
  }
  moveSel(op, pt, e) {
    const dx0 = pt.x - op.start.x;
    const dy0 = pt.y - op.start.y;
    if (!op.moved) {
      if (Math.hypot(dx0, dy0) * this.zoom < (op.pointerType === 'mouse' ? 3 : 6)) return;
      if (this.app.selected().every((x) => x.locked)) return;
      clearTimeout(this.pressT);
      op.items = this.app.selected().filter((x) => !x.locked).map((el) => ({ el, x: el.x || 0, y: el.y || 0, b: this.boxes.get(el.id) }));
      op.bounds = union(op.items.map((i) => aabb(i.b)));
      const moving = new Set(op.items.map((i) => i.el.id));
      op.others = this.page.els.filter((x) => !moving.has(x.id) && !x.hidden && this.boxes.get(x.id)).map((x) => aabb(this.boxes.get(x.id)));
      op.label = 'Pindahkan';
      this.beginOp(op);
    }
    let dx = dx0;
    let dy = dy0;
    this.guides = [];
    // (v1.13.1) one photo dragged over a photo frame: it goes into the frame when let go (like a tablet design app)
    // (a framed photo moves with its frame: only a loose photo goes into a frame)
    const one = op.items.length === 1 && op.items[0].el.type === 'image' && op.items[0].el.mediaId && !op.items[0].el.fromSlot ? op.items[0].el : null;
    if (one) {
      const f = this.frameAt(pt, one.id);
      if ((f?.id || null) !== op.dropFrame) {
        op.dropFrame = f?.id || null;
        if (op.op0 == null) op.op0 = one.opacity ?? 1;
        one.opacity = op.dropFrame ? Math.round(op.op0 * 0.45 * 100) / 100 : op.op0;
      }
    }
    if (!e.altKey && !op.dropFrame) {
      const b = op.bounds;
      const s = snap({ x1: b.x1 + dx, y1: b.y1 + dy, x2: b.x2 + dx, y2: b.y2 + dy }, op.others, this.design, 7 / this.zoom);
      dx += s.dx;
      dy += s.dy;
      this.guides = s.guides;
    }
    const W = this.design.width;
    const H = this.design.height;
    for (const it of op.items) { it.el.x = r4(it.x + dx / W); it.el.y = r4(it.y + dy / H); }
    this.invalidate();
  }
  scaleSel(op, pt) {
    this.beginOp(op);
    const dx = op.corner.x - op.anchor.x;
    const dy = op.corner.y - op.anchor.y;
    const d2 = dx * dx + dy * dy || 1;
    let k = ((pt.x - op.anchor.x) * dx + (pt.y - op.anchor.y) * dy) / d2;
    k = Math.max(0.03, k);
    const W = this.design.width;
    const H = this.design.height;
    for (const it of op.items) {
      it.el.scale = Math.max(0.01, Math.round(it.scale * k * 10000) / 10000);
      const cx = op.anchor.x + (it.b.cx - op.anchor.x) * k;
      const cy = op.anchor.y + (it.b.cy - op.anchor.y) * k;
      it.el.x = r4(cx / W - 0.5);
      it.el.y = r4(cy / H - 0.5);
    }
    const one = op.items.length === 1 ? op.items[0] : null;
    this.tag = one ? { x: one.b.cx + ((op.corner.x - one.b.cx) * k), y: Math.max(op.corner.y, op.anchor.y) + 0, text: one.el.type === 'text' ? `${Math.round(one.el.text.size * one.el.scale)} px` : `${Math.round(one.b.w * k)} × ${Math.round(one.b.h * k)}` } : null;
    this.invalidate();
  }
  sideSel(op, pt) {
    this.beginOp(op);
    const { el, b, h } = op;
    const c = Math.cos(b.rot);
    const s = Math.sin(b.rot);
    const axis = h === 'e' || h === 'w' ? { x: c, y: s } : { x: -s, y: c };
    const sign = h === 'e' || h === 's' ? 1 : -1;
    const half = h === 'e' || h === 'w' ? b.w / 2 : b.h / 2;
    const anchor = { x: b.cx - axis.x * half * sign, y: b.cy - axis.y * half * sign };
    const len = Math.max(20 / this.zoom, ((pt.x - anchor.x) * axis.x + (pt.y - anchor.y) * axis.y) * sign);
    const sc = el.scale ?? 1;
    if (el.type === 'text') el.text.width = Math.max(el.text.size * 0.6, Math.round(len / sc));
    else if (h === 'e' || h === 'w') el.shape.w = Math.max(4, Math.round(len / sc));
    else el.shape.h = Math.max(2, Math.round(len / sc));
    const ncx = anchor.x + axis.x * (len / 2) * sign;
    const ncy = anchor.y + axis.y * (len / 2) * sign;
    el.x = r4(ncx / this.design.width - 0.5);
    el.y = r4(ncy / this.design.height - 0.5);
    this.tag = { x: ncx, y: ncy + (h === 'n' || h === 's' ? 0 : b.h / 2), text: `${Math.round(len)} px` };
    this.layers = null;
    this.invalidate();
  }
  rotSel(op, pt, e) {
    this.beginOp(op);
    const a = Math.atan2(pt.y - op.c.y, pt.x - op.c.x);
    let deg = op.r0 + ((a - op.a0) * 180) / Math.PI;
    deg = ((deg + 180) % 360 + 360) % 360 - 180;
    if (!e.shiftKey) deg = snapAngle(deg);
    else deg = Math.round(deg / 15) * 15;
    op.el.rotation = Math.round(deg * 10) / 10;
    this.tag = { x: op.c.x, y: op.c.y + (this.boxes.get(op.el.id)?.h || 0) / 2 + 40 / this.zoom, text: `${Math.round(deg)}°` };
    this.invalidate();
  }
  startPinch() {
    clearTimeout(this.pressT);
    // (an operation of one finger stops: its change is kept)
    if (this.op?.moved && this.op.before) { this.layers = null; this.app.end(this.op.before, this.op.label || 'Ubah'); }
    const [a, b] = [...this.pointers.values()];
    this.op = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.zoom, mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, scroll0: { x: this.el.scrollLeft, y: this.el.scrollTop } };
    this.op.anchor = this.clientToPage(this.op.mid0.x, this.op.mid0.y);
    this.guides = [];
  }
  pinchMove() {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const op = this.op;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.fit = false;
    this.zoom = Math.max(0.05, Math.min(8, op.z0 * (d / op.d0)));
    this.layout();
    const r = this.el.getBoundingClientRect();
    this.el.scrollLeft = this.pageLeft + op.anchor.x * this.zoom - (mid.x - r.left);
    this.el.scrollTop = this.pageTop + op.anchor.y * this.zoom - (mid.y - r.top);
  }

  // ---- editing a text where it is
  /** selectAll: a new text (its placeholder words replaced by typing); else the caret goes to the end. */
  startEdit(el, { selectAll = false } = {}) {
    if (this.editing) this.endEdit();
    const b = this.boxes.get(el.id);
    if (!b) return;
    this.editing = el.id;
    this.editBefore = this.app.begin();
    const z = this.zoom;
    const tx = el.text;
    const sc = el.scale ?? 1;
    const ta = document.createElement('textarea');
    ta.className = 'ds-edit';
    ta.value = tx.content ?? '';
    ta.spellcheck = false;
    ta.setAttribute('autocapitalize', 'off');
    const px = tx.size * sc * z;
    Object.assign(ta.style, {
      font: `${tx.italic ? 'italic ' : ''}${tx.weight || 400} ${px}px "${tx.font}", Poppins, sans-serif`,
      lineHeight: String(tx.lineHeight || 1.2),
      letterSpacing: `${(tx.letterSpacing || 0) * sc * z}px`,
      textAlign: tx.align || 'center',
      color: /^#[0-9a-f]{6}$/i.test(tx.color || '') ? tx.color : '#111111',
      textTransform: tx.upper ? 'uppercase' : 'none',
    });
    this.editArea = ta;
    const place = () => {
      const L = layoutText(this.ctx, { ...tx, content: ta.value || ' ' });
      const w = (tx.width ? tx.width : Math.max(L.w, tx.size * 0.6)) * sc * z + 4;
      const h = L.h * sc * z + 4;
      const bb = this.boxes.get(el.id) || b;
      Object.assign(ta.style, { width: `${w}px`, height: `${h}px`, transform: `translate(${bb.cx * z}px,${bb.cy * z}px) rotate(${bb.rot}rad) translate(${-w / 2}px,${-h / 2}px)` });
    };
    place();
    ta.addEventListener('input', () => { tx.content = ta.value; this.invalidate(); place(); this.app.ui.refreshContext(); });
    ta.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') { ev.preventDefault(); this.endEdit(); } });
    ta.addEventListener('blur', () => setTimeout(() => { if (this.editArea === ta) this.endEdit(); }, 0));
    this.ov.textContent = '';
    this.ov.appendChild(ta);
    this.invalidate();
    ta.focus();
    if (selectAll) ta.select();
    else ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  endEdit() {
    const id = this.editing;
    if (!id) return;
    this.editing = null;
    const ta = this.editArea;
    this.editArea = null;
    ta?.remove();
    const el = this.page.els.find((x) => x.id === id);
    if (el && !String(el.text?.content ?? '').trim()) {
      // (an emptied text goes, like in a tablet design app)
      this.page.els.splice(this.page.els.indexOf(el), 1);
      this.app.select([]);
    } else if (el) el.name = String(el.text.content).split('\n')[0].slice(0, 40);
    this.app.end(this.editBefore, 'Edit teks');
    this.invalidate(true);
  }
}

export { boxOf, envFor };
