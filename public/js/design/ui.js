// Najja Desain (v1.13): everything around the canvas — the side rail and its panels (templates, elements, text,
// uploads, background, layers), the element toolbar that follows the selection (like a tablet design app), the
// popovers (colours, fonts, effects, position, photo tools), the pages strip, the context menu and the export dialog.
// Light: plain HTML strings, one delegated listener per area, canvases drawn only for what is on screen.
import { FONTS, FILTERS, ADJUSTMENTS, STICKERS, GRADIENTS } from '../presets.js';
import { escapeHtml, clone, clamp } from '../util.js';
import { fontWeightFor, shapePath } from '../render.js';
import { drawPage, boxOf, envFor } from './draw.js';
import { textEl, shapeEl, slotEl, iconEl, emojiEl, badgeEl, swatchEl, TEXT_KINDS, SHAPE_NAMES, SIZES, aabb, union } from './model.js';
import { templatesFor, COMBOS, ICON_NODES } from './templates.js';
import { searchIcons } from './assets.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
const narrow = () => window.matchMedia('(max-width: 820px)').matches;
const esc = (s) => escapeHtml(String(s ?? ''));

// ---- interface icons (simple strokes, drawn for Najja)
const IC = {
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  shapes: '<circle cx="7.5" cy="7.5" r="4.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M17.5 2.5l4 7h-8z"/>',
  text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
  upload: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1 0 1.6-.7 1.6-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1 0-.9.7-1.5 1.5-1.5H16a5 5 0 005-5c0-4.3-4-7.9-9-7.9z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15.2" cy="7.6" r="1"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.6-1.7"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.1 3.8M6.6 6.6A17 17 0 002 12s3.6 7 10 7a9.6 9.6 0 005.3-1.6"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  chev: '<path d="M7 10l5 5 5-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  opacity: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 010 18z" fill="currentColor"/>',
  alignL: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignC: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignR: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  spacing: '<path d="M4 4v16M20 4v16M8 12h8M10.5 9.5L8 12l2.5 2.5M13.5 9.5L16 12l-2.5 2.5"/>',
  sparkle: '<path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/><path d="M19 15v5M16.5 17.5h5"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 8"/>',
  wand: '<path d="M4 20L15 9"/><path d="M15 3v2M15 11v2M11 7h2M17 7h2"/><path d="M19.5 14l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z"/>',
  filter: '<circle cx="9" cy="10" r="5.5"/><circle cx="15" cy="10" r="5.5"/><circle cx="12" cy="15" r="5.5"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  crop: '<path d="M6 2v14a2 2 0 002 2h14"/><path d="M18 22V8a2 2 0 00-2-2H2"/>',
  frame: '<rect x="4" y="4" width="16" height="16" rx="6"/><path d="M8.5 15l2.5-3 2 2 1.5-1.5 2 2.5"/>',
  shadow: '<rect x="3" y="3" width="13" height="13" rx="2"/><path d="M20 8v10a2 2 0 01-2 2H8"/>',
  flip: '<path d="M12 3v18"/><path d="M8.5 7L4 12l4.5 5zM15.5 7l4.5 5-4.5 5z"/>',
  border: '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.5"/>',
  corner: '<path d="M4 20v-9a7 7 0 017-7h9"/>',
  pos: '<rect x="4" y="4" width="10" height="10" rx="1.5"/><rect x="10" y="10" width="10" height="10" rx="1.5" fill="currentColor" opacity=".25"/>',
  dots: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  aL: '<path d="M4 3v18"/><rect x="7" y="6" width="12" height="4" rx="1"/><rect x="7" y="14" width="7" height="4" rx="1"/>',
  aC: '<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4" rx="1"/><rect x="8" y="14" width="8" height="4" rx="1"/>',
  aR: '<path d="M20 3v18"/><rect x="5" y="6" width="12" height="4" rx="1"/><rect x="10" y="14" width="7" height="4" rx="1"/>',
  aT: '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="12" rx="1"/><rect x="14" y="7" width="4" height="7" rx="1"/>',
  aM: '<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="8" width="4" height="8" rx="1"/>',
  aB: '<path d="M3 20h18"/><rect x="6" y="5" width="4" height="12" rx="1"/><rect x="14" y="10" width="4" height="7" rx="1"/>',
  dH: '<path d="M4 4v16M20 4v16"/><rect x="9" y="7" width="6" height="10" rx="1"/>',
  dV: '<path d="M4 4h16M4 20h16"/><rect x="7" y="9" width="10" height="6" rx="1"/>',
  share: '<path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/>',
  download: '<path d="M12 3v12M7.5 10.5L12 15l4.5-4.5"/><path d="M5 21h14"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/>',
  page: '<rect x="5" y="3" width="14" height="18" rx="2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  sticker: '<path d="M4 4h10l6 6v8a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><path d="M14 4v4a2 2 0 002 2h4"/>',
};
const I = (n, cls = '') => `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''}>${IC[n] || ''}</svg>`;

const TABS = [
  ['tpl', 'Template', 'layout', 'Template'],
  ['el', 'Elemen', 'shapes', 'Elemen'],
  ['text', 'Teks', 'text', 'Teks'],
  ['up', 'Unggahan', 'upload', 'Unggahan'],
  ['bg', 'Latar', 'palette', 'Latar belakang'],
  ['layers', 'Lapisan', 'layers', 'Lapisan'],
];
// colours to start from (Najja's own set: neutrals, marketplace reds and oranges, teal, natural bag colours)
const PALETTE = ['#000000', '#3A3F47', '#7A828E', '#BFC5CD', '#E9ECF0', '#FFFFFF', '#E53935',
  '#FF6B5B', '#F06292', '#C2185B', '#8E5CF7', '#5B3FD1', '#129AA9', '#47C9D7',
  '#9BE3EA', '#2D8CFF', '#1F4FB8', '#1F2A44', '#00A86B', '#7BC67E', '#D8F06B',
  '#FFD400', '#FFB547', '#FF7A1A', '#8B5A2B', '#C9A27C', '#E8D8C3', '#F6EFE7'];
const SHAPES = ['rect', 'rounded', 'circle', 'triangle', 'rtriangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'parallelogram', 'trapezoid', 'star', 'star4', 'star6',
  'burst', 'scallop', 'heart', 'cross', 'arch', 'semicircle', 'drop', 'blob', 'cloud', 'shield', 'tag', 'ticket', 'ribbon', 'chevron', 'bubble', 'bubble2', 'arrow',
  'darrow', 'pill', 'line'];
const FRAMES = [['rect', 'Persegi'], ['rounded', 'Sudut bulat'], ['circle', 'Lingkaran'], ['pill', 'Kapsul'], ['arch', 'Lengkung'], ['hexagon', 'Segi enam'],
  ['octagon', 'Segi delapan'], ['pentagon', 'Segi lima'], ['diamond', 'Belah ketupat'], ['heart', 'Hati'], ['star', 'Bintang'], ['star4', 'Bintang 4'],
  ['burst', 'Lencana'], ['scallop', 'Bunga'], ['blob', 'Blob'], ['drop', 'Tetes'], ['shield', 'Perisai'], ['semicircle', 'Setengah lingkaran'],
  ['triangle', 'Segitiga'], ['cloud', 'Awan'], ['ticket', 'Kupon'], ['parallelogram', 'Jajar genjang'], ['bubble2', 'Balon'], ['cross', 'Plus']];
/** A photo frame's size when added (1080 px page). */
const FRAME_DIMS = { pill: [700, 420], arch: [480, 640], semicircle: [640, 320], drop: [440, 580], shield: [460, 560], parallelogram: [640, 440], ticket: [700, 380], cloud: [640, 440], bubble2: [600, 460] };
const MP_BADGES = [
  { text: 'GRATIS ONGKIR', icon: '🚚', bg: '#00A86B', fg: '#FFFFFF' },
  { text: 'BEST SELLER', icon: '⭐', bg: '#FFB800', fg: '#1B1B1B' },
  { text: 'DISKON 50%', icon: '🏷️', bg: '#E53935', fg: '#FFFFFF' },
  { text: 'FLASH SALE', icon: '⚡', bg: '#FF5A1F', fg: '#FFFFFF' },
  { text: 'NEW', icon: '✨', bg: '#111111', fg: '#FFFFFF' },
  { text: 'BISA COD', icon: '💵', bg: '#2563EB', fg: '#FFFFFF' },
  { text: 'ORI 100%', icon: '✅', bg: '#FFFFFF', fg: '#111111' },
  { text: 'STOK TERBATAS', icon: '🔥', bg: '#B91C1C', fg: '#FFFFFF' },
  { text: 'TERLARIS', icon: '🏆', bg: '#7C3AED', fg: '#FFFFFF' },
  { text: 'PROMO', icon: '🎁', bg: '#EC4899', fg: '#FFFFFF' },
  { text: 'GARANSI', icon: '🛡️', bg: '#0EA5E9', fg: '#FFFFFF' },
  { text: 'READY STOCK', icon: '📦', bg: '#16A34A', fg: '#FFFFFF' },
];
const MP_SWATCHES = [['#141414', 'Hitam'], ['#F5F5F0', 'Putih'], ['#8B5A2B', 'Cokelat'], ['#E8D8C3', 'Krem'], ['#1F2A44', 'Navy'], ['#C62828', 'Merah'], ['#6B7B3A', 'Olive'], ['#F4A6B8', 'Pink'], ['#9AA0A6', 'Abu'], ['#3B82F6', 'Biru'], ['#2E7D32', 'Hijau'], ['#F2C14E', 'Mustard']];
const POPULAR_ICONS = ['shopping-bag', 'shopping-cart', 'truck', 'package', 'gift', 'tag', 'badge-percent', 'percent', 'star', 'heart', 'thumbs-up', 'sparkles', 'zap', 'flame', 'clock', 'timer', 'shield-check', 'circle-check', 'check', 'award', 'crown', 'gem', 'store', 'wallet', 'credit-card', 'banknote', 'map-pin', 'phone', 'message-circle', 'mail', 'camera', 'sun', 'moon', 'leaf', 'droplets', 'feather', 'briefcase', 'backpack', 'luggage', 'shirt', 'watch', 'ruler', 'scissors', 'smile', 'arrow-right', 'arrow-down', 'chevron-right', 'plus'];
const EFFECTS = [['none', 'Tidak ada'], ['shadow', 'Bayangan'], ['lift', 'Angkat'], ['hollow', 'Berongga'], ['splice', 'Sambung'], ['outline', 'Garis tepi'], ['echo', 'Gema'], ['glitch', 'Glitch'], ['neon', 'Neon'], ['bg', 'Latar']];
const FX_COLOR = { shadow: '#000000', splice: '#47C9D7', echo: '', glitch: '#00E5FF' };
const MASKS = ['none', 'rect', 'circle', 'pill', 'arch', 'hexagon', 'octagon', 'pentagon', 'diamond', 'heart', 'star', 'star4', 'burst', 'scallop', 'blob', 'drop',
  'shield', 'semicircle', 'triangle', 'cloud', 'ticket', 'bubble2'];
const MASK_NAMES = { none: 'Tanpa', rect: 'Sudut', circle: 'Lingkaran', pill: 'Kapsul', arch: 'Lengkung', hexagon: 'Segi 6', octagon: 'Segi 8', pentagon: 'Segi 5', diamond: 'Ketupat',
  heart: 'Hati', star: 'Bintang', star4: 'Bintang 4', burst: 'Lencana', scallop: 'Bunga', blob: 'Blob', drop: 'Tetes', shield: 'Perisai', semicircle: 'Setengah', triangle: 'Segitiga',
  cloud: 'Awan', ticket: 'Kupon', bubble2: 'Balon' };
const MINI = { width: 1080, height: 1080, media: [] };

/** Draw elements (made for a 1080 px page) centred into a canvas, filling `fill` of it. */
export function drawEls(canvas, els, { fill = 0.84, bg = null, sources, media = [] } = {}) {
  const cw = canvas.width;
  const ch = canvas.height;
  const ctx = canvas.getContext('2d');
  const env = envFor({ ...MINI, media }, 1, sources);
  const bs = els.map((e) => boxOf(ctx, e, env));
  const u = union(bs.map(aabb));
  const uw = Math.max(1, u.x2 - u.x1);
  const uh = Math.max(1, u.y2 - u.y1);
  const W = Math.max(uw / fill, ((uh / fill) * cw) / ch);
  const H = (W * ch) / cw;
  const ucx = (u.x1 + u.x2) / 2;
  const ucy = (u.y1 + u.y2) / 2;
  const moved = els.map((e, i) => ({ ...e, x: (bs[i].cx - ucx) / W, y: (bs[i].cy - ucy) / H }));
  // (a photo's base size follows the page it is on: kept as big as it was measured)
  const env2 = envFor({ width: W, height: H, media }, 1, sources);
  moved.forEach((e, i) => { if (e.type === 'image') { const b = boxOf(ctx, e, env2); if (b.w > 0) e.scale = (e.scale ?? 1) * (bs[i].w / b.w); } });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  drawPage(ctx, { width: W, height: H, media }, { bg: bg || {}, els: moved }, { scale: cw / W, background: !!bg, sources });
}
const svgOfNodes = (nodes, attrs = '') => `<svg viewBox="0 0 24 24"${attrs}>${(nodes || []).filter(([t]) => /^(path|circle|rect|line|polyline|polygon|ellipse)$/.test(t)).map(([t, a]) => `<${t} ${Object.entries(a || {}).filter(([k]) => /^[a-z-]+$/i.test(k)).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`).join('')}</svg>`;
const rangeRow = (label, key, min, max, value, step = 1, suf = '') => `<div class="ds-row"><label>${label}</label><input type="range" data-r="${key}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${Math.round(value * 100) / 100}${suf}</output></div>`;
const colorIn = (key, value, label = '') => `<div class="ds-row"><label>${label}</label><label class="ds-sw" style="background:${esc(value)};width:32px;height:32px;flex:none;position:relative"><input type="color" class="ds-cin" data-ci="${key}" value="${/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000'}" style="position:absolute;inset:0;opacity:0;width:100%;height:100%;border:0;padding:0"></label></div>`;
const gradCss = (g) => `linear-gradient(${(g[2] ?? 135) + 90}deg,${g[0]},${g[1]})`;
const isHex = (s) => /^#[0-9a-f]{6}$/i.test(String(s || ''));

export class UI {
  constructor(app) {
    this.app = app;
    this.railEl = $('.ds-rail');
    this.panelEl = $('.ds-panel');
    this.ctxEl = $('.ds-ctx');
    this.popEl = $('.ds-pop');
    this.pagesEl = $('.ds-pages');
    this.toastsEl = $('.ds-toasts');
    this.nameEl = $('.ds-name');
    this.tab = null;
    this.iconQuery = '';
    this.allIcons = false;
    this.expand = { shapes: false, frames: false };
    this.popKey = null;
    this.tileRun = 0;
    this.tplRun = 0;
    this.railEl.innerHTML = TABS.map(([id, label, ic]) => `<button class="ds-rb" data-tab="${id}" aria-label="${label}">${I(ic)}<span>${label}</span></button>`).join('');
    this.railEl.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) this.openTab(this.tab === b.dataset.tab ? null : b.dataset.tab); });
    this.panelEl.addEventListener('click', (e) => this.onPanelClick(e));
    this.panelEl.addEventListener('input', (e) => this.onPanelInput(e));
    this.ctxEl.addEventListener('click', (e) => this.onCtxClick(e));
    this.ctxEl.addEventListener('change', (e) => this.onCtxChange(e));
    this.ctxEl.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && this.ctxEl.scrollWidth > this.ctxEl.clientWidth) { this.ctxEl.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    this.ctxEl.addEventListener('keydown', (e) => { if (!e.target.matches('input')) return; e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
    this.pagesEl.addEventListener('click', (e) => this.onPagesClick(e));
    this.pagesEl.addEventListener('contextmenu', (e) => { const b = e.target.closest('[data-pg]'); if (b) { e.preventDefault(); this.pageMenu(+b.dataset.pg, e.clientX, e.clientY); } });
    document.addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b) this.cmd(b.dataset.cmd); });
    // a popover closes when the finger goes down anywhere else (not on the button that opened it: that one toggles)
    document.addEventListener('pointerdown', (e) => {
      if (this.popEl.hidden || this.popEl.contains(e.target)) return;
      const a = e.target.closest?.('[data-act]');
      if (a && a.dataset.act === this.popKey) return;
      this.closePop();
    }, true);
    this.nameEl.addEventListener('change', () => this.app.rename(this.nameEl.value));
    this.nameEl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') this.nameEl.blur(); });
    window.addEventListener('resize', () => this.closePop());
  }

  // ---------------------------------------------------------------------------------------------
  // top bar, toasts
  init(first = true) {
    const d = this.app.design;
    this.nameEl.value = d.name || '';
    $('.ds-size').textContent = `${d.width} × ${d.height} px`;
    document.title = `${d.name || 'Desain'} · Najja Desain`;
    this.renderPages();
    this.refreshContext();
    if (first) this.openTab(narrow() ? null : d.pages.length === 1 && !d.pages[0].els.length ? 'tpl' : null);
    else if (this.tab) this.renderPanel();
  }
  updateTop() {
    $('[data-cmd="undo"]').disabled = !this.app.history.canUndo;
    $('[data-cmd="redo"]').disabled = !this.app.history.canRedo;
    if (document.activeElement !== this.nameEl) this.nameEl.value = this.app.design.name || '';
  }
  saveState(state, msg = '') {
    const el = $('.ds-save');
    el.classList.toggle('err', state === 'error');
    el.textContent = { saving: 'Menyimpan…', saved: 'Tersimpan', dirty: 'Belum tersimpan', uploading: 'Mengunggah foto…', error: msg || 'Gagal menyimpan', local: 'Tersimpan di perangkat' }[state] || '';
    el.dataset.state = state;
  }
  showZoom(z) { const el = $('.ds-zl'); if (el) el.textContent = `${Math.round(z * 100)}%`; }
  toast(msg, type = '') {
    const t = document.createElement('div');
    t.className = `ds-toast ${type}`;
    t.textContent = msg;
    this.toastsEl.appendChild(t);
    setTimeout(() => t.remove(), type === 'err' ? 6000 : 3200);
  }
  /** A message that stays while something runs: set(text), done(text, type). */
  busy(msg) {
    const t = document.createElement('div');
    t.className = 'ds-toast';
    t.textContent = msg;
    this.toastsEl.appendChild(t);
    return {
      set: (m) => { t.textContent = m; },
      done: (m, type = '') => { t.className = `ds-toast ${type}`; t.textContent = m; setTimeout(() => t.remove(), type === 'err' ? 6000 : 2600); },
    };
  }
  cmd(name) {
    const st = this.app.stage;
    switch (name) {
      case 'home': return this.app.goHome();
      case 'undo': return this.app.undo();
      case 'redo': return this.app.redo();
      case 'export': return this.exportDialog();
      case 'resize': return this.resizeDialog();
      case 'zoomIn': return st.setZoom(st.zoom * 1.25);
      case 'zoomOut': return st.setZoom(st.zoom / 1.25);
      case 'zoomFit': return st.zoomFit();
      default: return undefined;
    }
  }
  /** After any change of the design: toolbar, layers, thumbnails. */
  changed() {
    this.refreshContext();
    if (this.tab === 'layers' || this.tab === 'up') {
      clearTimeout(this.panelT);
      this.panelT = setTimeout(() => { if (this.tab === 'layers' || this.tab === 'up') this.renderPanel(); }, 180);
    }
    this.schedThumbs();
  }
  afterRender() { this.schedThumbs(); }
  schedThumbs() {
    clearTimeout(this.thumbT);
    this.thumbT = setTimeout(() => this.drawPageThumbs([this.app.pageIndex]), 450);
  }
  fontsChanged() {
    clearTimeout(this.fontT);
    this.fontT = setTimeout(() => { if (this.tab === 'tpl' || this.tab === 'text' || this.tab === 'el') this.drawPanelCanvases(); this.drawPageThumbs(); }, 300);
  }

  // ---------------------------------------------------------------------------------------------
  // panels
  openTab(id) {
    this.tab = id;
    $$('.ds-rb', this.railEl).forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    this.panelEl.hidden = !id;
    if (id) this.renderPanel();
    else this.panelEl.innerHTML = '';
    // (the page area changes size: the canvas fits again)
    requestAnimationFrame(() => this.app.stage?.layout());
  }
  renderPanel() {
    const t = TABS.find((x) => x[0] === this.tab);
    if (!t) return;
    const keep = this.shownTab === this.tab ? $('.ds-pb', this.panelEl)?.scrollTop || 0 : 0;
    this.shownTab = this.tab;
    const body = { tpl: () => this.panelTemplates(), el: () => this.panelElements(), text: () => this.panelText(), up: () => this.panelUploads(), bg: () => this.panelBg(), layers: () => this.panelLayers() }[this.tab]();
    this.panelEl.innerHTML = `<div class="ds-ph"><h2>${t[3]}</h2><button class="ds-ib sm" data-close aria-label="Tutup panel">${I('x')}</button></div><div class="ds-pb">${body}</div>`;
    if (keep) $('.ds-pb', this.panelEl).scrollTop = keep;
    this.drawPanelCanvases();
    if (this.tab === 'el') this.fillIcons();
  }
  drawPanelCanvases() {
    const d = this.app.design;
    const dpr = DPR();
    // template pictures: a few per frame (27 templates; the panel opens at once)
    const tpls = $$('canvas[data-tplc]', this.panelEl);
    const tplRun = ++this.tplRun;
    const list = templatesFor(d.sizeId);
    const drawTpl = (i) => {
      if (tplRun !== this.tplRun) return;
      for (const c of tpls.slice(i, i + 4)) {
        const t = list.find((x) => x.id === c.dataset.tplc);
        if (!t) continue;
        const W = Math.round(150 * dpr);
        const k = W / d.width;
        c.width = W;
        c.height = Math.max(1, Math.round(d.height * k));
        const tmp = { width: d.width, height: d.height, sizeId: d.sizeId, media: [] };
        const out = t.make(tmp);
        drawPage(c.getContext('2d'), tmp, { bg: out.bg, els: out.els }, { scale: k });
      }
      if (i + 4 < tpls.length) requestAnimationFrame(() => drawTpl(i + 4));
    };
    drawTpl(0);
    // (drawn a few per frame: a long panel opens at once, its pictures follow)
    const tiles = $$('canvas[data-draw]', this.panelEl);
    const run = ++this.tileRun;
    const step = (i) => {
      if (run !== this.tileRun) return;
      for (const c of tiles.slice(i, i + 18)) {
        const els = this.specEls(c.dataset.draw, MINI);
        if (!els) continue;
        const wide = /^(badge|combo):/.test(c.dataset.draw);
        c.width = Math.round((wide ? 160 : 80) * dpr);
        c.height = Math.round((wide ? (c.dataset.draw.startsWith('combo') ? 100 : 56) : 80) * dpr);
        drawEls(c, els, { fill: wide ? 0.9 : 0.78 });
      }
      if (i + 18 < tiles.length) requestAnimationFrame(() => step(i + 18));
    };
    step(0);
    for (const c of $$('canvas[data-mthumb]', this.panelEl)) this.drawMediaThumb(c, c.dataset.mthumb);
    for (const c of $$('canvas[data-lthumb]', this.panelEl)) {
      const el = this.app.page.els.find((x) => x.id === c.dataset.lthumb);
      if (!el) continue;
      c.width = c.height = Math.round(46 * dpr);
      try { drawEls(c, [{ ...el, hidden: false, opacity: Math.max(0.35, el.opacity ?? 1) }], { fill: 0.86, sources: this.app.assets.sources, media: d.media }); } catch { /* (a photo still loading) */ }
    }
  }
  drawMediaThumb(c, id) {
    const s = this.app.assets.sources.get(id);
    const dpr = DPR();
    c.width = c.height = Math.round(100 * dpr);
    const g = c.getContext('2d');
    if (!s) { this.app.assets.load(id).then(() => this.drawMediaThumb(c, id)).catch(() => {}); return; }
    const k = Math.max(c.width / s.w, c.height / s.h);
    g.drawImage(s.el, (c.width - s.w * k) / 2, (c.height - s.h * k) / 2, s.w * k, s.h * k);
  }

  panelTemplates() {
    const d = this.app.design;
    const list = templatesFor(d.sizeId);
    const mine = list.filter((t) => t.for.includes(d.sizeId));
    const rest = list.filter((t) => !t.for.includes(d.sizeId));
    const cols = d.width / d.height > 1.6 ? '' : ' g2';
    const tile = (t) => `<button class="ds-tile tpl" data-tpl="${t.id}" title="${esc(t.name)}"><canvas data-tplc="${t.id}"></canvas><b>${esc(t.name)}</b></button>`;
    return `<p class="ds-hint">Ketuk template: dipakai di halaman yang kosong, atau ditambahkan sebagai halaman baru. Bingkai abu-abu = tempat foto produk — ketuk lalu pilih foto.</p>
      ${mine.length ? `<div class="ds-sec">Untuk ukuran ini</div><div class="ds-grid${cols}"${cols ? '' : ' style="grid-template-columns:1fr"'}>${mine.map(tile).join('')}</div>` : ''}
      <div class="ds-sec">${mine.length ? 'Template lain <small>disesuaikan ke ukuran ini</small>' : 'Template <small>disesuaikan ke ukuran ini</small>'}</div>
      <div class="ds-grid${cols}"${cols ? '' : ' style="grid-template-columns:1fr"'}>${rest.map(tile).join('')}</div>`;
  }
  panelElements() {
    return `<input class="ds-search" type="search" placeholder="Cari ikon: tas, kirim, bintang, jam…" data-iconq value="${esc(this.iconQuery)}" enterkeyhint="search">
      <div data-iconres></div>
      <div data-elbody${this.iconQuery ? ' hidden' : ''}>
        <div class="ds-sec">Bentuk <button class="ds-link" data-expand="shapes">${this.expand.shapes ? 'Lebih sedikit' : `Lihat semua (${SHAPES.length})`}</button></div>
        <div class="ds-grid g4">${(this.expand.shapes ? SHAPES : SHAPES.slice(0, 12)).map((k) => `<button class="ds-tile" data-add="shape:${k}" title="${SHAPE_NAMES[k] || k}" aria-label="${SHAPE_NAMES[k] || k}"><canvas data-draw="shape:${k}"></canvas></button>`).join('')}</div>
        <div class="ds-sec">Bingkai foto <button class="ds-link" data-expand="frames">${this.expand.frames ? 'Lebih sedikit' : `Lihat semua (${FRAMES.length})`}</button></div>
        <p class="ds-hint" style="margin-top:-4px">Isi dengan foto produk: ketuk bingkai lalu Pilih foto, atau geser foto ke atasnya.</p>
        <div class="ds-grid g4">${(this.expand.frames ? FRAMES : FRAMES.slice(0, 8)).map(([k, n]) => `<button class="ds-tile" data-add="frame:${k}" title="${n}" aria-label="Bingkai ${n}"><canvas data-draw="frame:${k}"></canvas></button>`).join('')}</div>
        <div class="ds-sec">Label marketplace</div>
        <div class="ds-grid g2">${MP_BADGES.map((b, i) => `<button class="ds-tile" style="aspect-ratio:2.6" data-add="badge:${i}" title="${esc(b.text)}"><canvas data-draw="badge:${i}"></canvas></button>`).join('')}</div>
        <div class="ds-sec">Warna varian</div>
        <div class="ds-grid g4">${MP_SWATCHES.map(([c, n], i) => `<button class="ds-tile" data-add="swatch:${i}" title="${n}"><canvas data-draw="swatch:${i}"></canvas></button>`).join('')}</div>
        <div class="ds-sec">Ikon <small>Lucide · bebas pakai</small></div>
        <div class="ds-grid g6" data-icons><span class="ds-hint" style="grid-column:1/-1">Memuat ikon…</span></div>
        <button class="ds-btn wide" data-allicons style="margin-top:8px">${this.allIcons ? 'Lebih sedikit' : 'Lihat semua ikon'}</button>
        <div class="ds-sec">Emoji</div>
        <div class="ds-grid g6">${STICKERS.map((e) => `<button class="ds-tile emoji" data-add="emoji:${e}">${e}</button>`).join('')}</div>
      </div>`;
  }
  async fillIcons() {
    const box = $('[data-icons]', this.panelEl);
    const res = $('[data-iconres]', this.panelEl);
    let icons;
    try { icons = await this.app.assets.loadIcons(); } catch (err) {
      icons = Object.entries(ICON_NODES).map(([name, nodes]) => ({ name, nodes, tags: [] }));
      if (box) box.insertAdjacentHTML('beforebegin', `<p class="ds-hint">Set ikon lengkap belum bisa dimuat (${esc(err.message)}); ikon dasar dulu.</p>`);
    }
    if (this.tab !== 'el') return;
    const tile = (ic) => `<button class="ds-tile" data-add="icon:${esc(ic.name)}" title="${esc(ic.name)}">${svgOfNodes(ic.nodes, ' style="width:60%;height:60%"')}</button>`;
    if (box) {
      const by = new Map(icons.map((ic) => [ic.name, ic]));
      const pop = POPULAR_ICONS.map((n) => by.get(n)).filter(Boolean);
      const list = this.allIcons ? [...pop, ...icons.filter((ic) => !POPULAR_ICONS.includes(ic.name))] : pop;
      // (all ±1,600 icons: drawn in pieces so the panel stays smooth)
      box.innerHTML = list.slice(0, 120).map(tile).join('');
      if (list.length > 120) {
        let i = 120;
        const more = () => { if (this.tab !== 'el' || !box.isConnected || i >= list.length) return; box.insertAdjacentHTML('beforeend', list.slice(i, i + 200).map(tile).join('')); i += 200; requestAnimationFrame(more); };
        requestAnimationFrame(more);
      }
    }
    if (res) {
      const q = this.iconQuery;
      res.innerHTML = q ? (() => {
        const found = searchIcons(icons, q, 120);
        return found.length ? `<div class="ds-sec">Ikon “${esc(q)}” <small>${found.length}</small></div><div class="ds-grid g6">${found.map(tile).join('')}</div>` : `<p class="ds-hint">Tidak ada ikon untuk “${esc(q)}”. Coba kata lain (mis. tas, hadiah, bintang).</p>`;
      })() : '';
    }
  }
  panelText() {
    return `<button class="ds-btn acc wide" data-add="text:body" data-edit>${I('text')} Tambah kotak teks</button>
      <div class="ds-sec">Gaya teks dasar</div>
      <button class="ds-tbtn" data-add="text:heading" style="font:800 26px/1.2 Poppins">Tambahkan judul</button>
      <button class="ds-tbtn" data-add="text:sub" style="font:600 18px/1.2 Poppins">Tambahkan subjudul</button>
      <button class="ds-tbtn" data-add="text:body" style="font:400 14px/1.2 Poppins">Tambahkan sedikit teks isi</button>
      <div class="ds-sec">Kombinasi teks marketplace</div>
      <div class="ds-grid g2">${COMBOS.map((c) => `<button class="ds-tile" style="aspect-ratio:1.6;background:#fff" data-add="combo:${c.id}" title="${esc(c.name)}"><canvas data-draw="combo:${c.id}"></canvas></button>`).join('')}</div>
      <p class="ds-hint">Ketuk dua kali (atau ketuk teks yang sudah dipilih) untuk mengubah tulisannya.</p>`;
  }
  panelUploads() {
    const d = this.app.design;
    const imgs = d.media.filter((m) => m.type === 'image');
    const slot = this.app.one()?.slot;
    return `<button class="ds-up" data-upload>${I('upload')}<b>Unggah foto</b><small>JPG, PNG, WEBP, HEIC · bisa pilih banyak</small></button>
      <p class="ds-hint">${slot ? '<b>Bingkai foto dipilih</b> — ketuk foto untuk mengisinya.' : 'Tarik & lepas foto ke halaman, atau tempel (Ctrl+V). Foto disimpan di server Najja.'}</p>
      ${imgs.length ? `<div class="ds-sec">Foto di desain ini <small>${imgs.length}</small></div><div class="ds-grid">${imgs.map((m) => `<button class="ds-tile" data-media="${esc(m.id)}" title="${esc(m.name)}"><canvas data-mthumb="${esc(m.id)}"></canvas>${m.local ? '<b>belum di server</b>' : ''}</button>`).join('')}</div>` : ''}`;
  }
  panelBg() {
    const page = this.app.page;
    const bg = page.bg || {};
    const doc = this.docColors();
    const sw = (c) => `<button class="ds-sw ${!bg.color2 && !bg.mediaId && same(bg.color, c) ? 'on' : ''}" data-bgc="${c}" style="background:${c}" title="${c}"></button>`;
    return `${doc.length ? `<div class="ds-sec">Warna di desain</div><div class="ds-swatches">${doc.map(sw).join('')}</div>` : ''}
      <div class="ds-sec">Warna</div>
      <div class="ds-swatches"><label class="ds-sw add" title="Warna lain" style="position:relative"><span>+</span><input type="color" class="ds-cin" data-bgcustom value="${isHex(bg.color) ? bg.color : '#ffffff'}" style="position:absolute;inset:0;opacity:0;width:100%;height:100%;border:0;padding:0"></label>${PALETTE.map(sw).join('')}</div>
      <div class="ds-sec">Gradasi</div>
      <div class="ds-grid g4">${GRADIENTS.map((g, i) => `<button class="ds-tile ${bg.color2 && same(bg.color, g[0]) && same(bg.color2, g[1]) ? 'on' : ''}" data-bgg="${i}" style="background:${gradCss(g)}"></button>`).join('')}</div>
      <div class="ds-sec">Foto latar</div>
      <button class="ds-btn wide" data-bgphoto>${I('image')} Pilih foto untuk latar</button>
      ${bg.mediaId ? `<button class="ds-btn wide danger" data-bgphotox style="margin-top:6px">${I('x')} Hapus foto latar</button>` : ''}
      <div class="ds-sec"></div>
      <button class="ds-btn wide" data-bgall>${I('copy')} Pakai latar ini di semua halaman</button>`;
  }
  panelLayers() {
    const els = [...this.app.page.els].reverse();
    if (!els.length) return '<p class="ds-hint">Halaman ini masih kosong. Tambahkan teks, foto, atau elemen.</p>';
    return `<p class="ds-hint">Paling atas = paling depan.</p>${els.map((e) => `<div class="ds-layer ${this.app.sel.includes(e.id) ? 'on' : ''}" data-lsel="${e.id}">
        <canvas data-lthumb="${e.id}"></canvas><span>${esc(layerName(e))}</span>
        <button class="ds-ib" data-lact="hide" title="${e.hidden ? 'Tampilkan' : 'Sembunyikan'}">${I(e.hidden ? 'eyeOff' : 'eye')}</button>
        <button class="ds-ib" data-lact="lock" title="${e.locked ? 'Buka kunci' : 'Kunci'}">${I(e.locked ? 'lock' : 'unlock')}</button>
        <button class="ds-ib" data-lact="up" title="Maju">${I('up')}</button>
        <button class="ds-ib" data-lact="down" title="Mundur">${I('down')}</button>
      </div>`).join('')}`;
  }

  /** The elements a panel tile adds (`spec`: kind:arg), made for page/design `p`. */
  specEls(spec, p) {
    const i = spec.indexOf(':');
    const kind = spec.slice(0, i);
    const arg = spec.slice(i + 1);
    switch (kind) {
      case 'text': return [textEl(p, { ...TEXT_KINDS[arg] })];
      case 'combo': return COMBOS.find((c) => c.id === arg)?.make(p) || null;
      case 'shape': return [arg === 'rounded' ? shapeEl(p, 'rect', { name: SHAPE_NAMES.rounded }, { radius: Math.round(70 * (Math.min(p.width, p.height) / 1080)) }) : shapeEl(p, arg)];
      case 'frame': {
        const dims = FRAME_DIMS[arg] || [560, 560];
        return [slotEl(p, arg === 'rounded' ? 'rect' : arg, dims[0], dims[1], { radius: arg === 'rounded' ? 60 : 0 })];
      }
      case 'badge': return [badgeEl(p, MP_BADGES[+arg])];
      case 'swatch': { const [c, n] = MP_SWATCHES[+arg]; return [swatchEl(p, c, n)]; }
      case 'icon': {
        const nodes = this.app.assets.icons?.find((x) => x.name === arg)?.nodes || ICON_NODES[arg];
        return nodes ? [iconEl(p, arg, nodes)] : null;
      }
      case 'emoji': return [emojiEl(p, arg)];
      default: return null;
    }
  }
  onPanelClick(e) {
    const t = (s) => e.target.closest(s);
    let b;
    if (t('[data-close]')) return this.openTab(null);
    if ((b = t('[data-add]'))) {
      const els = this.specEls(b.dataset.add, this.app.design);
      if (els) this.app.addEls(els, { edit: b.hasAttribute('data-edit') });
      if (narrow()) this.openTab(null);
      return undefined;
    }
    if ((b = t('[data-tpl]'))) {
      const tpl = templatesFor(this.app.design.sizeId).find((x) => x.id === b.dataset.tpl);
      if (tpl) this.app.applyTemplate(tpl);
      if (narrow()) this.openTab(null);
      return undefined;
    }
    if (t('[data-allicons]')) { this.allIcons = !this.allIcons; return this.renderPanel(); }
    if ((b = t('[data-expand]'))) { this.expand[b.dataset.expand] = !this.expand[b.dataset.expand]; return this.renderPanel(); }
    if (t('[data-upload]')) return this.app.pickPhotos({ slot: this.app.one()?.slot ? this.app.one() : null });
    if ((b = t('[data-media]'))) { this.app.usePhoto(b.dataset.media); if (narrow()) this.openTab(null); return undefined; }
    if ((b = t('[data-bgc]'))) return this.setBg({ color: b.dataset.bgc });
    if ((b = t('[data-bgg]'))) { const g = GRADIENTS[+b.dataset.bgg]; return this.setBg({ color: g[0], color2: g[1], angle: g[2] }); }
    if (t('[data-bgphoto]')) return this.app.pickPhotos({ bg: true });
    if (t('[data-bgphotox]')) return this.setBg({ ...this.app.page.bg, mediaId: null });
    if (t('[data-bgall]')) {
      const bg = clone(this.app.page.bg);
      this.app.change('Latar semua halaman', () => { for (const p of this.app.design.pages) p.bg = clone(bg); });
      this.drawPageThumbs();
      return this.toast('Latar dipakai di semua halaman', 'ok');
    }
    if ((b = t('[data-lact]'))) {
      const id = b.closest('[data-lsel]').dataset.lsel;
      const el = this.app.page.els.find((x) => x.id === id);
      const act = b.dataset.lact;
      if (!el) return undefined;
      if (act === 'hide') this.app.change('Sembunyikan', () => { el.hidden = !el.hidden; });
      if (act === 'lock') this.app.change('Kunci', () => { el.locked = !el.locked; });
      if (act === 'up' || act === 'down') this.app.layer(act, [id]);
      return undefined;
    }
    if ((b = t('[data-lsel]'))) return this.app.select([b.dataset.lsel]);
    return undefined;
  }
  onPanelInput(e) {
    if (e.target.matches('[data-iconq]')) {
      this.iconQuery = e.target.value.trim();
      const body = $('[data-elbody]', this.panelEl);
      if (body) body.hidden = !!this.iconQuery;
      clearTimeout(this.iconT);
      this.iconT = setTimeout(() => this.fillIcons(), 120);
    }
    if (e.target.matches('[data-bgcustom]')) this.setBg({ color: e.target.value }, false);
  }
  setBg(bg, rerender = true) {
    const keepPhoto = 'mediaId' in bg ? bg.mediaId : null;
    this.app.change('Warna latar', () => { this.app.page.bg = { ...bg, mediaId: keepPhoto || undefined }; if (!this.app.page.bg.mediaId) delete this.app.page.bg.mediaId; });
    if (rerender && this.tab === 'bg') this.renderPanel();
  }
  /** Colours the design uses (for "Warna di desain"). */
  docColors() {
    const out = [];
    const add = (c) => { if (isHex(c) && !out.some((x) => same(x, c))) out.push(c.toUpperCase()); };
    for (const p of this.app.design.pages) {
      add(p.bg?.color);
      add(p.bg?.color2);
      for (const e of p.els) {
        add(e.text?.color);
        add(e.shape?.fill);
        add(e.shape?.fill2);
        add(e.sticker?.icon?.color);
        add(e.sticker?.badge?.bg);
        add(e.sticker?.swatch?.color);
      }
    }
    return out.slice(0, 14);
  }

  // ---------------------------------------------------------------------------------------------
  // the element toolbar
  refreshContext() {
    const sel = this.app.selected();
    let h;
    if (!sel.length) h = this.ctxPage();
    else if (sel.length > 1) h = this.ctxMulti(sel);
    else h = this.ctxOne(sel[0]);
    this.ctxEl.innerHTML = h;
    this.updateTop();
  }
  ctxPage() {
    const bg = this.app.page.bg || {};
    const css = bg.color2 ? gradCss([bg.color, bg.color2, bg.angle]) : bg.color || '#fff';
    return `<button class="ds-cb" data-act="pagebg" title="Warna latar halaman"><span class="sw" style="background:${esc(css)}"></span>Latar</button>
      <span class="ds-sep"></span>
      <button class="ds-cb" data-act="tab:tpl">${I('layout')}Template</button>
      <button class="ds-cb" data-act="addtext">${I('text')}Teks</button>
      <button class="ds-cb" data-act="tab:up">${I('image')}Foto</button>
      <button class="ds-cb" data-act="tab:el">${I('shapes')}Elemen</button>
      <span class="ds-sep"></span>
      <button class="ds-cb" data-act="resize" title="Ubah ukuran desain">${I('crop')}${this.app.design.width}×${this.app.design.height}</button>`;
  }
  ctxTail(el) {
    return `<span class="ds-sep"></span>
      <button class="ds-cb" data-act="opacity" title="Transparansi">${I('opacity')}</button>
      <button class="ds-cb" data-act="position" title="Posisi">${I('pos')}Posisi</button>
      <button class="ds-cb" data-act="lock" title="${el?.locked ? 'Buka kunci' : 'Kunci'}">${I(el?.locked ? 'lock' : 'unlock')}</button>
      <button class="ds-cb" data-act="dup" title="Duplikat (Ctrl+D)">${I('copy')}</button>
      <button class="ds-cb" data-act="del" title="Hapus (Del)">${I('trash')}</button>
      <button class="ds-cb" data-act="more" title="Lainnya">${I('dots')}</button>`;
  }
  ctxOne(el) {
    if (el.locked) return `<button class="ds-cb on" data-act="lock">${I('lock')}Terkunci · buka</button><button class="ds-cb" data-act="dup" title="Duplikat">${I('copy')}</button><button class="ds-cb" data-act="more">${I('dots')}</button>`;
    let h = '';
    if (el.type === 'text') {
      const tx = el.text;
      const f = FONTS.find((x) => x.name === tx.font);
      const size = Math.round((tx.size || 0) * (el.scale ?? 1));
      const fx = fxOf(tx);
      h = `<button class="ds-cb font" data-act="font" style="font-family:'${esc(tx.font)}',Poppins"><span>${esc(f?.label || tx.font)}</span>${I('chev')}</button>
        <span class="ds-num"><button data-act="size-" aria-label="Perkecil huruf">−</button><input data-k="size" value="${size}" inputmode="numeric" aria-label="Ukuran huruf"><button data-act="size+" aria-label="Perbesar huruf">+</button></span>
        <button class="ds-cb" data-act="color" title="Warna teks"><span class="tc" style="border-bottom-color:${esc(tx.gradient?.enabled ? tx.gradient.from : tx.color)}">A</span></button>
        <button class="ds-cb ${(tx.weight || 400) >= 600 ? 'on' : ''}" data-act="bold" title="Tebal"><b>B</b></button>
        <button class="ds-cb ${tx.italic ? 'on' : ''}" data-act="italic" title="Miring"${f && !f.italic ? ' disabled style="opacity:.35"' : ''}><i style="font-family:serif;font-size:16px">I</i></button>
        <button class="ds-cb" data-act="align" title="Perataan">${I(tx.align === 'left' ? 'alignL' : tx.align === 'right' ? 'alignR' : 'alignC')}</button>
        <button class="ds-cb ${tx.upper ? 'on' : ''}" data-act="upper" title="Huruf besar">aA</button>
        <button class="ds-cb" data-act="spacing" title="Spasi">${I('spacing')}</button>
        <span class="ds-sep"></span>
        <button class="ds-cb ${fx !== 'none' || tx.curve ? 'on' : ''}" data-act="effects">${I('sparkle')}Efek</button>`;
    } else if (el.type === 'image') {
      h = `<button class="ds-cb" data-act="replace">${I('image')}Ganti</button>
        <button class="ds-cb" data-act="cutout">${I('wand')}Hapus latar</button>
        <button class="ds-cb ${el.filter?.name && el.filter.name !== 'none' ? 'on' : ''}" data-act="filter">${I('filter')}Filter</button>
        <button class="ds-cb" data-act="adjust">${I('sliders')}Sesuaikan</button>
        <button class="ds-cb" data-act="crop">${I('crop')}Potong</button>
        <button class="ds-cb ${el.mask?.kind && el.mask.kind !== 'none' ? 'on' : ''}" data-act="mask">${I('frame')}Bingkai</button>
        <button class="ds-cb ${el.dropShadow?.enabled ? 'on' : ''}" data-act="dshadow">${I('shadow')}Bayangan</button>
        <button class="ds-cb" data-act="flip">${I('flip')}Balik</button>`;
    } else if (el.type === 'shape') {
      const sh = el.shape || {};
      const css = sh.fill === 'none' ? 'transparent' : sh.fill2 ? gradCss([sh.fill, sh.fill2, sh.angle]) : sh.fill || '#47C9D7';
      h = `${el.slot ? `<button class="ds-cb on" data-act="slotpick">${I('image')}Pilih foto</button><span class="ds-sep"></span>` : ''}
        <button class="ds-cb" data-act="fill" title="Warna"><span class="sw" style="background:${esc(css)}"></span>${el.slot ? 'Warna' : ''}</button>
        ${el.slot ? '' : `<button class="ds-cb ${sh.stroke?.enabled ? 'on' : ''}" data-act="border">${I('border')}Garis tepi</button>`}
        ${['rect'].includes(sh.kind) ? `<button class="ds-cb" data-act="radius">${I('corner')}Sudut</button>` : ''}
        ${el.slot ? '' : `<button class="ds-cb ${sh.shadow?.enabled ? 'on' : ''}" data-act="sshadow">${I('shadow')}Bayangan</button>`}`;
    } else if (el.type === 'sticker') {
      const st = el.sticker || {};
      if (st.icon) {
        h = `<button class="ds-cb" data-act="icolor" title="Warna garis"><span class="sw" style="background:${esc(st.icon.color || '#111')}"></span>Warna</button>
          <button class="ds-cb" data-act="ifill" title="Warna isi"><span class="sw" style="background:${st.icon.fill && st.icon.fill !== 'none' ? esc(st.icon.fill) : 'transparent'}"></span>Isi</button>
          <button class="ds-cb" data-act="istroke">${I('border')}Ketebalan</button>`;
      } else if (st.badge) {
        h = `<button class="ds-cb" data-act="btext">${I('text')}Ubah teks</button>
          <button class="ds-cb" data-act="bbg" title="Warna label"><span class="sw" style="background:${esc(st.badge.bg)}"></span>Latar</button>
          <button class="ds-cb" data-act="bfg" title="Warna teks"><span class="tc" style="border-bottom-color:${esc(st.badge.fg)}">A</span></button>`;
      } else if (st.swatch) {
        h = `<button class="ds-cb" data-act="swcolor"><span class="sw" style="background:${esc(st.swatch.color)}"></span>Warna</button>
          <button class="ds-cb" data-act="swlabel">${I('text')}Nama</button>
          <button class="ds-cb" data-act="swlcolor" title="Warna nama"><span class="tc" style="border-bottom-color:${esc(st.swatch.labelColor || '#111')}">A</span></button>`;
      } else h = `<span class="ds-cb" style="pointer-events:none;font-size:20px">${esc(st.emoji || '')}</span>`;
    }
    return h + this.ctxTail(el);
  }
  ctxMulti(sel) {
    return `<span class="ds-cb" style="pointer-events:none">${sel.length} dipilih</span><span class="ds-sep"></span>
      <button class="ds-cb" data-act="alignpop">${I('aC')}Ratakan</button>${this.ctxTail(null)}`;
  }

  onCtxChange(e) {
    if (e.target.dataset.k !== 'size') return;
    const el = this.app.one();
    if (el?.type !== 'text') return;
    const v = clamp(Number(e.target.value) || 0, 4, 2000);
    this.app.change('Ukuran huruf', () => { el.text.size = Math.round((v / (el.scale ?? 1)) * 10) / 10; });
  }
  onCtxClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (this.popKey === act && !this.popEl.hidden) { this.closePop(); return; }
    const app = this.app;
    const el = app.one();
    const sel = app.selected();
    const ch = (label, fn) => app.change(label, fn);
    if (act.startsWith('tab:')) { this.openTab(act.slice(4)); return; }
    if (act === 'resize') { this.resizeDialog(); return; }
    switch (act) {
      case 'addtext': app.addEls([textEl(app.design, { ...TEXT_KINDS.body })], { edit: true }); return;
      case 'pagebg': {
        const bg = app.page.bg || {};
        this.colorPop(b, act, { title: 'Warna latar', value: bg.color, onPick: (c) => this.setBg({ color: c }), onGradient: (g) => this.setBg({ color: g[0], color2: g[1], angle: g[2] }) });
        return;
      }
      case 'opacity': {
        const v = Math.round((sel[0]?.opacity ?? 1) * 100);
        this.openPop(b, act, `<h3>Transparansi</h3>${rangeRow('', 'op', 0, 100, v, 1, '%')}`, (p) => this.bindRanges(p, { op: (x) => ch('Transparansi', () => { for (const s of app.selected()) s.opacity = x / 100; }) }));
        return;
      }
      case 'position': this.positionPop(b, act); return;
      case 'alignpop': this.alignPop(b, act); return;
      case 'lock': app.toggleLock(); return;
      case 'dup': app.duplicateSel(); return;
      case 'del': app.deleteSel(); return;
      case 'more': { const r = b.getBoundingClientRect(); this.contextMenu(r.left, r.bottom + 6, 'more'); return; }
      default: break;
    }
    if (!el) return;
    const tx = el.text;
    switch (act) {
      // ---- text
      case 'font': this.fontPop(b, act, el); break;
      case 'size-':
      case 'size+': {
        const cur = Math.round(tx.size * (el.scale ?? 1));
        const step = cur >= 100 ? 4 : cur >= 40 ? 2 : 1;
        const v = Math.max(4, cur + (act === 'size+' ? step : -step));
        ch('Ukuran huruf', () => { tx.size = Math.round((v / (el.scale ?? 1)) * 10) / 10; });
        break;
      }
      case 'color':
        this.colorPop(b, act, { title: 'Warna teks', value: tx.color, onPick: (c) => ch('Warna teks', () => { tx.color = c; if (tx.gradient) tx.gradient.enabled = false; }), onGradient: (g) => ch('Warna teks', () => { tx.gradient = { enabled: true, from: g[0], to: g[1] }; }) });
        break;
      case 'bold': {
        const f = FONTS.find((x) => x.name === tx.font);
        const bold = (tx.weight || 400) >= 600;
        const w = f ? (bold ? f.weights.reduce((a, x) => (Math.abs(x - 400) < Math.abs(a - 400) ? x : a)) : Math.max(...f.weights.filter((x) => x >= 600), f.weights.at(-1))) : bold ? 400 : 700;
        ch('Tebal', () => { tx.weight = w; });
        break;
      }
      case 'italic': ch('Miring', () => { tx.italic = !tx.italic; }); break;
      case 'align': ch('Perataan', () => { tx.align = tx.align === 'center' || !tx.align ? 'left' : tx.align === 'left' ? 'right' : 'center'; }); break;
      case 'upper': ch('Huruf besar', () => { tx.upper = !tx.upper; }); break;
      case 'spacing':
        this.openPop(b, act, `<h3>Spasi</h3>${rangeRow('Jarak huruf', 'ls', -10, 80, Math.round(((tx.letterSpacing || 0) / tx.size) * 200), 1)}${rangeRow('Jarak baris', 'lh', 0.7, 2.5, tx.lineHeight || 1.2, 0.05)}`, (p) => this.bindRanges(p, {
          ls: (x) => ch('Jarak huruf', () => { tx.letterSpacing = Math.round(((x / 200) * tx.size) * 10) / 10; }),
          lh: (x) => ch('Jarak baris', () => { tx.lineHeight = x; }),
        }));
        break;
      case 'effects': this.effectsPop(b, act, el); break;
      // ---- photo
      case 'replace': app.pickPhotos({ replace: el }); break;
      case 'cutout': app.removeBg(el); break;
      case 'filter': this.filterPop(b, act, el); break;
      case 'adjust': this.adjustPop(b, act, el); break;
      case 'crop': this.cropPop(b, act, el); break;
      case 'mask': this.maskPop(b, act, el); break;
      case 'dshadow': this.shadowPop(b, act, el, 'dropShadow', { blur: 40, y: 22, opacity: 0.3 }); break;
      case 'flip': {
        const r = b.getBoundingClientRect();
        this.menu(r.left, r.bottom + 6, [
          { label: 'Balik horizontal', icon: 'flip', run: () => ch('Balik', () => { el.flipH = !el.flipH; }) },
          { label: 'Balik vertikal', icon: 'flip', run: () => ch('Balik', () => { el.flipV = !el.flipV; }) },
        ], act);
        break;
      }
      case 'unslot': app.unslot(el); break;
      // ---- shape
      case 'slotpick': app.pickPhotos({ slot: el }); break;
      case 'fill': {
        const sh = el.shape;
        this.colorPop(b, act, {
          title: 'Warna', value: sh.fill, none: !el.slot,
          onPick: (c) => ch('Warna bentuk', () => { sh.fill = c; delete sh.fill2; }),
          onGradient: el.slot ? null : (g) => ch('Warna bentuk', () => { sh.fill = g[0]; sh.fill2 = g[1]; sh.angle = g[2]; }),
        });
        break;
      }
      case 'border': this.borderPop(b, act, el); break;
      case 'radius': {
        const sh = el.shape;
        const max = Math.min(sh.w, sh.h) / 2;
        this.openPop(b, act, `<h3>Sudut</h3>${rangeRow('Kelengkungan', 'rad', 0, 100, Math.round(((sh.radius || 0) / max) * 100), 1, '%')}`, (p) => this.bindRanges(p, { rad: (x) => ch('Sudut', () => { sh.radius = Math.round((x / 100) * max); }) }));
        break;
      }
      case 'sshadow': this.shadowPop(b, act, el, 'shape.shadow', { blur: 30, y: 14, opacity: 0.3 }); break;
      // ---- icon, label, colour circle
      case 'icolor': this.colorPop(b, act, { title: 'Warna ikon', value: el.sticker.icon.color, onPick: (c) => ch('Warna ikon', () => { el.sticker.icon.color = c; }) }); break;
      case 'ifill': this.colorPop(b, act, { title: 'Isi ikon', value: el.sticker.icon.fill, none: true, onPick: (c) => ch('Isi ikon', () => { el.sticker.icon.fill = c === 'none' ? undefined : c; }) }); break;
      case 'istroke':
        this.openPop(b, act, `<h3>Ketebalan garis</h3>${rangeRow('', 'sw', 0.5, 4, el.sticker.icon.stroke ?? 2, 0.25)}`, (p) => this.bindRanges(p, { sw: (x) => ch('Ketebalan ikon', () => { el.sticker.icon.stroke = x; }) }));
        break;
      case 'btext': this.textPop(b, act, 'Teks label', [['Teks', el.sticker.badge.text, (v) => { el.sticker.badge.text = v; el.name = v; }], ['Emoji', el.sticker.badge.icon || '', (v) => { el.sticker.badge.icon = v; }]]); break;
      case 'bbg': this.colorPop(b, act, { title: 'Warna label', value: el.sticker.badge.bg, onPick: (c) => ch('Warna label', () => { el.sticker.badge.bg = c; }) }); break;
      case 'bfg': this.colorPop(b, act, { title: 'Warna teks label', value: el.sticker.badge.fg, onPick: (c) => ch('Warna teks label', () => { el.sticker.badge.fg = c; }) }); break;
      case 'swcolor': this.colorPop(b, act, { title: 'Warna varian', value: el.sticker.swatch.color, onPick: (c) => ch('Warna varian', () => { el.sticker.swatch.color = c; }) }); break;
      case 'swlabel': this.textPop(b, act, 'Nama warna', [['Nama', el.sticker.swatch.label || '', (v) => { el.sticker.swatch.label = v; el.name = `Warna ${v}`; }]]); break;
      case 'swlcolor': this.colorPop(b, act, { title: 'Warna nama', value: el.sticker.swatch.labelColor, onPick: (c) => ch('Warna nama', () => { el.sticker.swatch.labelColor = c; }) }); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // popovers
  openPop(anchor, key, html, bind, cls = '') {
    // a new element each time: the listeners of the popover before it go with it (v1.13.1: they piled up on one
    // element, so picking a colour for a variant circle also ran the page colour's picker opened earlier)
    const p = document.createElement('div');
    p.className = `ds-pop ${cls}`;
    p.innerHTML = html;
    p.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.closePop(); });
    this.popEl.replaceWith(p);
    this.popEl = p;
    this.popKey = key;
    bind?.(p);
    this.place(p, anchor);
    return p;
  }
  place(p, anchor) {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    const pw = p.offsetWidth;
    const ph = p.offsetHeight;
    const x = clamp(r.left + r.width / 2 - pw / 2, 8, window.innerWidth - pw - 8);
    let y = r.bottom + 8;
    if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 8);
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
  }
  closePop() {
    if (this.popEl.hidden) return;
    const p = document.createElement('div');
    p.className = 'ds-pop';
    p.hidden = true;
    this.popEl.replaceWith(p);
    this.popEl = p;
    this.popKey = null;
  }
  bindRanges(p, handlers) {
    p.addEventListener('input', (e) => {
      const k = e.target.dataset.r;
      if (!k || !handlers[k]) return;
      const v = Number(e.target.value);
      handlers[k](v);
      const o = e.target.parentElement.querySelector('output');
      if (o) o.textContent = `${Math.round(v * 100) / 100}${o.textContent.replace(/^[-\d.]+/, '')}`;
    });
  }
  /** Colours: the design's, the basic ones, a custom one, a code; gradients when onGradient. */
  colorPop(anchor, key, { title = 'Warna', value, none = false, onPick, onGradient = null }) {
    const doc = this.docColors();
    const sw = (c) => `<button class="ds-sw ${same(c, value) ? 'on' : ''}" data-c="${c}" style="background:${c}" title="${c}"></button>`;
    const html = `<h3>${title}</h3>
      ${doc.length ? `<div class="ds-sec" style="margin-top:4px">Warna di desain</div><div class="ds-swatches">${doc.map(sw).join('')}</div>` : ''}
      <div class="ds-sec">Warna dasar</div>
      <div class="ds-swatches">${none ? `<button class="ds-sw none ${value === 'none' || !value ? 'on' : ''}" data-c="none" title="Tanpa warna"></button>` : ''}<label class="ds-sw add" title="Warna lain" style="position:relative"><span>+</span><input type="color" class="ds-cin" value="${isHex(value) ? value : '#000000'}" style="position:absolute;inset:0;opacity:0;width:100%;height:100%;border:0;padding:0"></label>${PALETTE.map(sw).join('')}</div>
      ${onGradient ? `<div class="ds-sec">Gradasi</div><div class="ds-grid g6">${GRADIENTS.map((g, i) => `<button class="ds-tile" data-g="${i}" style="background:${gradCss(g)}"></button>`).join('')}</div>` : ''}
      <div class="ds-row"><label>Kode warna</label><input class="ds-hex" value="${isHex(value) ? value.toUpperCase() : ''}" maxlength="7" spellcheck="false" placeholder="#FFFFFF" style="width:110px;height:34px;border:1px solid var(--line2);border-radius:8px;padding:0 10px"></div>`;
    this.openPop(anchor, key, html, (p) => {
      p.addEventListener('click', (e) => {
        const c = e.target.closest('[data-c]');
        if (c) { onPick(c.dataset.c); $$('.ds-sw.on', p).forEach((x) => x.classList.remove('on')); c.classList.add('on'); }
        const g = e.target.closest('[data-g]');
        if (g) onGradient?.(GRADIENTS[+g.dataset.g]);
      });
      p.addEventListener('input', (e) => { if (e.target.matches('.ds-cin')) onPick(e.target.value); });
      p.addEventListener('change', (e) => {
        if (!e.target.matches('.ds-hex')) return;
        let v = e.target.value.trim();
        if (/^[0-9a-f]{6}$/i.test(v)) v = `#${v}`;
        if (isHex(v)) onPick(v.toUpperCase()); else e.target.value = '';
      });
    });
  }
  textPop(anchor, key, title, fields) {
    const html = `<h3>${title}</h3>${fields.map(([label, v], i) => `<div class="ds-field"><span>${label}</span><input class="ds-search" style="padding-left:12px;background-image:none" data-tf="${i}" value="${esc(v)}" maxlength="40"></div>`).join('')}`;
    this.openPop(anchor, key, html, (p) => {
      p.addEventListener('input', (e) => { const i = e.target.dataset.tf; if (i != null) this.app.change(title, () => fields[+i][2](e.target.value)); });
      $('input', p)?.focus();
    });
  }
  fontPop(anchor, key, el) {
    const tx = el.text;
    const cats = [...new Set(FONTS.map((f) => f.cat))];
    const html = `<h3>Font</h3><input class="ds-search" type="search" placeholder="Cari font" data-fq>
      <div class="ds-fonts">${cats.map((c) => `<div class="ds-sec" data-fcat>${c}</div>${FONTS.filter((f) => f.cat === c).map((f) => `<button data-font="${esc(f.name)}" class="${f.name === tx.font ? 'on' : ''}" style="font-family:'${esc(f.name)}'">${esc(f.label || f.name)}</button>`).join('')}`).join('')}</div>`;
    this.openPop(anchor, key, html, (p) => {
      p.addEventListener('click', (e) => {
        const b = e.target.closest('[data-font]');
        if (!b) return;
        const f = FONTS.find((x) => x.name === b.dataset.font);
        this.app.change('Font', () => { tx.font = f.name; tx.weight = fontWeightFor(f.name, tx.weight || 400); if (!f.italic) tx.italic = false; });
        $$('[data-font].on', p).forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
      });
      p.addEventListener('input', (e) => {
        if (!e.target.matches('[data-fq]')) return;
        const q = e.target.value.trim().toLowerCase();
        $$('[data-font]', p).forEach((b) => { b.hidden = !!q && !`${b.dataset.font} ${b.textContent}`.toLowerCase().includes(q); });
        $$('[data-fcat]', p).forEach((s) => { s.hidden = !!q; });
      });
    });
  }
  effectsPop(anchor, key, el) {
    const tx = el.text;
    const render = (p) => {
      const cur = fxOf(tx);
      p.innerHTML = `<h3>Efek</h3><div class="ds-fx">${EFFECTS.map(([id, n]) => `<button data-fx="${id}" class="${cur === id ? 'on' : ''}"><canvas data-fxc="${id}"></canvas>${n}</button>`).join('')}</div>
        <div data-fxopts>${this.fxOptions(tx, cur)}</div>
        <div class="ds-sec">Bentuk</div>
        <div class="ds-chipbar"><button class="ds-chip ${tx.curve ? '' : 'on'}" data-curve="0">Lurus</button><button class="ds-chip ${tx.curve ? 'on' : ''}" data-curve="40">Lengkung</button></div>
        ${tx.curve ? `${rangeRow('Lengkung', 'curve', -100, 100, tx.curve)}${String(tx.content || '').includes('\n') ? '<p class="ds-hint">Lengkung hanya untuk teks satu baris.</p>' : ''}` : ''}`;
      const dpr = DPR();
      for (const c of $$('canvas[data-fxc]', p)) {
        c.width = Math.round(84 * dpr);
        c.height = Math.round(52 * dpr);
        const t = { ...clone(tx), content: 'Ag', size: 150, width: 0, curve: 0, upper: false, color: c.dataset.fxc === 'neon' ? '#19B3C4' : '#25303D', gradient: { enabled: false } };
        applyFx(t, c.dataset.fxc);
        const one = textEl(MINI, {});
        one.text = t;
        drawEls(c, [one], { fill: 0.72 });
      }
    };
    this.openPop(anchor, key, '', (p) => {
      render(p);
      p.addEventListener('click', (e) => {
        const b = e.target.closest('[data-fx]');
        if (b) { this.app.change('Efek teks', () => applyFx(tx, b.dataset.fx)); render(p); return; }
        const c = e.target.closest('[data-curve]');
        if (c) { this.app.change('Lengkung', () => { tx.curve = +c.dataset.curve || 0; if (tx.curve) tx.width = 0; }); render(p); }
      });
      this.bindRanges(p, {
        curve: (v) => this.app.change('Lengkung', () => { tx.curve = v || (v === 0 ? 0 : v); }),
        off: (v) => this.app.change('Efek teks', () => { tx.effect.offset = v; }),
        int: (v) => this.app.change('Efek teks', () => { tx.effect.intensity = v; }),
        bgop: (v) => this.app.change('Efek teks', () => { tx.bg.opacity = v / 100; }),
        bgrad: (v) => this.app.change('Efek teks', () => { tx.bg.radius = Math.round((v / 100) * tx.size * 0.6); }),
        bgpad: (v) => this.app.change('Efek teks', () => { tx.bg.padding = v; }),
        stw: (v) => this.app.change('Efek teks', () => { tx.stroke.width = Math.max(1, Math.round((v / 100) * tx.size * 0.12 * 10) / 10); }),
      });
      p.addEventListener('input', (e) => {
        const k = e.target.dataset.ci;
        if (!k) return;
        e.target.parentElement.style.background = e.target.value;
        this.app.change('Efek teks', () => {
          if (k === 'fx1') tx.effect.color = e.target.value;
          if (k === 'fx2') tx.effect.color2 = e.target.value;
          if (k === 'bgc') tx.bg.color = e.target.value;
          if (k === 'stc') tx.stroke.color = e.target.value;
        });
      });
    });
    this.popEl.style.width = '330px';
    this.place(this.popEl, anchor);
  }
  fxOptions(tx, cur) {
    const e = tx.effect || {};
    const off = rangeRow('Jarak', 'off', 0, 100, e.offset ?? 50);
    const int = (label) => rangeRow(label, 'int', 0, 100, e.intensity ?? 50);
    switch (cur) {
      case 'shadow': return off + int('Kekuatan') + colorIn('fx1', e.color || '#000000', 'Warna');
      case 'lift': return int('Kekuatan');
      case 'hollow': return int('Ketebalan');
      case 'splice': return int('Ketebalan') + off + colorIn('fx1', e.color || '#47C9D7', 'Warna');
      case 'echo': return off + colorIn('fx1', e.color || tx.color || '#000000', 'Warna');
      case 'glitch': return off + colorIn('fx1', e.color || '#00E5FF', 'Warna 1') + colorIn('fx2', e.color2 || '#FF2DAA', 'Warna 2');
      case 'neon': return int('Kekuatan');
      case 'outline': return rangeRow('Ketebalan', 'stw', 1, 100, Math.round(((tx.stroke?.width || 4) / (tx.size * 0.12)) * 100)) + colorIn('stc', tx.stroke?.color || '#111111', 'Warna');
      case 'bg': return colorIn('bgc', tx.bg?.color || '#FFD400', 'Warna') + rangeRow('Transparansi', 'bgop', 0, 100, Math.round((tx.bg?.opacity ?? 1) * 100), 1, '%') + rangeRow('Sudut', 'bgrad', 0, 100, Math.round(((tx.bg?.radius || 0) / (tx.size * 0.6)) * 100)) + rangeRow('Ruang', 'bgpad', 0.3, 2.5, tx.bg?.padding ?? 1, 0.1);
      default: return '';
    }
  }
  positionPop(anchor, key) {
    const sel = this.app.selected();
    const el = sel.length === 1 ? sel[0] : null;
    const html = `<h3>Posisi</h3>
      <div class="ds-sec" style="margin-top:4px">Urutan lapisan</div>
      <div class="ds-grid g2"><button class="ds-btn" data-pos="up">${I('up')}Maju</button><button class="ds-btn" data-pos="down">${I('down')}Mundur</button><button class="ds-btn" data-pos="top">Paling depan</button><button class="ds-btn" data-pos="bottom">Paling belakang</button></div>
      <div class="ds-sec">Ratakan ke halaman</div>
      ${alignGrid()}
      ${el ? rangeRow('Putar', 'rot', -180, 180, Math.round(el.rotation || 0), 1, '°') : ''}`;
    this.openPop(anchor, key, html, (p) => {
      p.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pos]');
        if (b) this.app.layer(b.dataset.pos);
        const a = e.target.closest('[data-align]');
        if (a) this.app.align(a.dataset.align);
      });
      this.bindRanges(p, { rot: (v) => this.app.change('Putar', () => { el.rotation = v; }) });
    });
  }
  alignPop(anchor, key) {
    const n = this.app.selected().length;
    const html = `<h3>Ratakan ${n} elemen</h3>${alignGrid()}
      <div class="ds-sec">Sebarkan rata</div>
      <div class="ds-grid g2"><button class="ds-btn" data-dist="h" ${n < 3 ? 'disabled' : ''}>${I('dH')}Mendatar</button><button class="ds-btn" data-dist="v" ${n < 3 ? 'disabled' : ''}>${I('dV')}Tegak</button></div>
      ${n < 3 ? '<p class="ds-hint">Sebarkan butuh 3 elemen atau lebih.</p>' : ''}
      <div class="ds-sec">Lapisan</div>
      <div class="ds-grid g2"><button class="ds-btn" data-pos="top">Paling depan</button><button class="ds-btn" data-pos="bottom">Paling belakang</button></div>`;
    this.openPop(anchor, key, html, (p) => p.addEventListener('click', (e) => {
      const a = e.target.closest('[data-align]');
      if (a) this.app.align(a.dataset.align);
      const d = e.target.closest('[data-dist]');
      if (d && !d.disabled) this.app.distribute(d.dataset.dist);
      const b = e.target.closest('[data-pos]');
      if (b) this.app.layer(b.dataset.pos);
    }));
  }
  borderPop(anchor, key, el) {
    const sh = el.shape;
    const st = () => sh.stroke || (sh.stroke = { enabled: false, color: '#111111', width: 6 });
    const render = (p) => {
      const s = sh.stroke || {};
      const mode = !s.enabled ? 'none' : s.dash ? 'dash' : 'solid';
      p.innerHTML = `<h3>Garis tepi</h3><div class="ds-chipbar"><button class="ds-chip ${mode === 'none' ? 'on' : ''}" data-bm="none">Tanpa</button><button class="ds-chip ${mode === 'solid' ? 'on' : ''}" data-bm="solid">Garis</button><button class="ds-chip ${mode === 'dash' ? 'on' : ''}" data-bm="dash">Putus-putus</button></div>
        ${s.enabled ? rangeRow('Ketebalan', 'bw', 1, 60, s.width || 6) + colorIn('bc', s.color || '#111111', 'Warna') : ''}`;
    };
    this.openPop(anchor, key, '', (p) => {
      render(p);
      p.addEventListener('click', (e) => {
        const b = e.target.closest('[data-bm]');
        if (!b) return;
        this.app.change('Garis tepi', () => { const s = st(); s.enabled = b.dataset.bm !== 'none'; s.dash = b.dataset.bm === 'dash'; });
        render(p);
      });
      this.bindRanges(p, { bw: (v) => this.app.change('Garis tepi', () => { st().width = v; }) });
      p.addEventListener('input', (e) => { if (e.target.dataset.ci === 'bc') { e.target.parentElement.style.background = e.target.value; this.app.change('Garis tepi', () => { st().color = e.target.value; }); } });
    });
  }
  /** A shadow (photo: dropShadow; shape: shape.shadow). */
  shadowPop(anchor, key, el, path, def) {
    const get = () => (path === 'dropShadow' ? el.dropShadow : el.shape.shadow);
    const set = (v) => { if (path === 'dropShadow') el.dropShadow = v; else el.shape.shadow = v; };
    const render = (p) => {
      const s = get() || {};
      p.innerHTML = `<h3>Bayangan</h3><div class="ds-chipbar"><button class="ds-chip ${s.enabled ? '' : 'on'}" data-sh="0">Tanpa</button><button class="ds-chip ${s.enabled ? 'on' : ''}" data-sh="1">Bayangan</button></div>
        ${s.enabled ? rangeRow('Kabur', 'blur', 0, 120, s.blur ?? def.blur) + rangeRow('Jarak', 'sy', -80, 80, s.y ?? def.y) + rangeRow('Geser', 'sx', -80, 80, s.x ?? 0) + rangeRow('Pekat', 'sop', 0, 100, Math.round((s.opacity ?? def.opacity) * 100), 1, '%') + colorIn('shc', s.color || '#000000', 'Warna') : ''}
        ${path === 'dropShadow' ? '<p class="ds-hint">Paling bagus untuk foto produk yang latarnya sudah dihapus.</p>' : ''}`;
    };
    const upd = (fn) => this.app.change('Bayangan', () => { const s = { enabled: true, color: '#000000', blur: def.blur, x: 0, y: def.y, opacity: def.opacity, ...(get() || {}) }; fn(s); set(s); });
    this.openPop(anchor, key, '', (p) => {
      render(p);
      p.addEventListener('click', (e) => { const b = e.target.closest('[data-sh]'); if (b) { upd((s) => { s.enabled = b.dataset.sh === '1'; }); render(p); } });
      this.bindRanges(p, { blur: (v) => upd((s) => { s.blur = v; }), sy: (v) => upd((s) => { s.y = v; }), sx: (v) => upd((s) => { s.x = v; }), sop: (v) => upd((s) => { s.opacity = v / 100; }) });
      p.addEventListener('input', (e) => { if (e.target.dataset.ci === 'shc') { e.target.parentElement.style.background = e.target.value; upd((s) => { s.color = e.target.value; }); } });
    });
  }
  filterPop(anchor, key, el) {
    const html = `<h3>Filter</h3><div class="ds-grid">${FILTERS.map((f) => `<button class="ds-tile ${(el.filter?.name || 'none') === f.id ? 'on' : ''}" data-f="${f.id}" style="${(el.filter?.name || 'none') === f.id ? 'box-shadow:0 0 0 2px var(--sel)' : ''}"><canvas data-ft="${f.id}"></canvas><b>${esc(f.name)}</b></button>`).join('')}</div>
      ${rangeRow('Kekuatan', 'fi', 0, 100, Math.round((el.filter?.intensity ?? 1) * 100), 1, '%')}`;
    this.openPop(anchor, key, html, (p) => {
      const m = this.app.design.media.find((x) => x.id === el.mediaId);
      const src = this.app.assets.sources.get(el.mediaId);
      if (m && src) {
        // one small copy of the photo for all the previews
        const k = Math.min(1, 160 / Math.max(src.w, src.h));
        const small = document.createElement('canvas');
        small.width = Math.max(1, Math.round(src.w * k));
        small.height = Math.max(1, Math.round(src.h * k));
        small.getContext('2d').drawImage(src.el, 0, 0, small.width, small.height);
        const sources = new Map([[m.id, { el: small, w: small.width, h: small.height }]]);
        const media = [{ ...m }];
        const dpr = DPR();
        const tiles = $$('canvas[data-ft]', p);
        let i = 0;
        const step = () => {
          if (this.popKey !== key || i >= tiles.length) return;
          for (const c of tiles.slice(i, i + 6)) {
            c.width = c.height = Math.round(84 * dpr);
            const one = { ...clone(el), x: 0, y: 0, rotation: 0, opacity: 1, flipH: false, flipV: false, mask: null, dropShadow: null, filter: { name: c.dataset.ft, intensity: 1 } };
            try { drawEls(c, [one], { fill: 1, sources, media }); } catch { /* (no preview) */ }
          }
          i += 6;
          requestAnimationFrame(step);
        };
        step();
      }
      p.addEventListener('click', (e) => {
        const b = e.target.closest('[data-f]');
        if (!b) return;
        this.app.change('Filter', () => { el.filter = { name: b.dataset.f, intensity: el.filter?.intensity ?? 1 }; });
        $$('[data-f]', p).forEach((x) => { x.style.boxShadow = x === b ? '0 0 0 2px var(--sel)' : ''; });
      });
      this.bindRanges(p, { fi: (v) => this.app.change('Filter', () => { el.filter = { name: el.filter?.name || 'none', intensity: v / 100 }; }) });
    });
  }
  adjustPop(anchor, key, el) {
    const list = ADJUSTMENTS.filter((a) => a.id !== 'hue');
    const render = (p) => {
      p.innerHTML = `<h3>Sesuaikan</h3>${list.map((a) => rangeRow(a.name, a.id, a.min, a.max, el.adjust?.[a.id] || 0)).join('')}<button class="ds-btn wide" data-reset>Atur ulang</button>`;
    };
    this.openPop(anchor, key, '', (p) => {
      render(p);
      this.bindRanges(p, Object.fromEntries(list.map((a) => [a.id, (v) => this.app.change('Sesuaikan', () => { el.adjust = { ...(el.adjust || {}), [a.id]: v }; })])));
      p.addEventListener('click', (e) => { if (e.target.closest('[data-reset]')) { this.app.change('Sesuaikan', () => { for (const a of ADJUSTMENTS) if (el.adjust) el.adjust[a.id] = 0; }); render(p); } });
    });
  }
  cropPop(anchor, key, el) {
    const sides = [['l', 'Kiri'], ['r', 'Kanan'], ['t', 'Atas'], ['b', 'Bawah']];
    const render = (p) => {
      const c = el.crop || {};
      p.innerHTML = `<h3>Potong</h3>${sides.map(([k, n]) => rangeRow(n, k, 0, 45, Math.round((c[k] || 0) * 100), 1, '%')).join('')}<button class="ds-btn wide" data-reset>Tanpa potongan</button>`;
    };
    this.openPop(anchor, key, '', (p) => {
      render(p);
      this.bindRanges(p, Object.fromEntries(sides.map(([k]) => [k, (v) => this.app.setCrop(el, { ...(el.crop || { l: 0, t: 0, r: 0, b: 0 }), [k]: v / 100 })])));
      p.addEventListener('click', (e) => { if (e.target.closest('[data-reset]')) { this.app.setCrop(el, { l: 0, t: 0, r: 0, b: 0 }); render(p); } });
    });
  }
  maskPop(anchor, key, el) {
    const render = (p) => {
      const cur = el.mask?.kind || 'none';
      p.innerHTML = `<h3>Bingkai foto</h3><div class="ds-grid g4">${MASKS.map((k) => `<button class="ds-tile" data-mask="${k}" title="${MASK_NAMES[k]}" style="${cur === k ? 'box-shadow:0 0 0 2px var(--sel)' : ''}"><canvas data-mk="${k}"></canvas><b>${MASK_NAMES[k]}</b></button>`).join('')}</div>
        ${cur === 'rect' ? rangeRow('Sudut', 'mrad', 0, 100, Math.round((el.mask.radius || 0) * 100), 1, '%') : ''}`;
      const dpr = DPR();
      for (const c of $$('canvas[data-mk]', p)) {
        c.width = c.height = Math.round(64 * dpr);
        const g = c.getContext('2d');
        g.translate(c.width / 2, c.height / 2 - 6 * dpr);
        g.fillStyle = '#9fb0c0';
        const k = c.dataset.mk;
        const s = 30 * dpr;
        if (k === 'none') { g.fillRect(-s * 0.9, -s * 0.65, s * 1.8, s * 1.3); continue; }
        const [fw, fh] = FRAME_DIMS[k] || [560, 560];
        const fk = (s * 1.6) / Math.max(fw, fh);
        g.fill(shapePath(k, fw * fk, fh * fk, k === 'rect' ? s * 0.35 : 0));
      }
    };
    this.openPop(anchor, key, '', (p) => {
      render(p);
      p.addEventListener('click', (e) => {
        const b = e.target.closest('[data-mask]');
        if (!b) return;
        this.app.change('Bingkai foto', () => { el.mask = b.dataset.mask === 'none' ? null : { kind: b.dataset.mask, radius: b.dataset.mask === 'rect' ? (el.mask?.radius || 0.25) : 0 }; });
        render(p);
      });
      this.bindRanges(p, { mrad: (v) => this.app.change('Bingkai foto', () => { el.mask = { kind: 'rect', radius: v / 100 }; }) });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // menus
  menu(x, y, items, key = 'menu', above = false) {
    const html = items.map((it, i) => (it.sep ? '<div class="ds-msep"></div>' : `<button class="ds-mi ${it.danger ? 'danger' : ''}" data-mi="${i}" ${it.disabled ? 'disabled style="opacity:.4"' : ''}>${it.icon ? I(it.icon) : ''}<span>${esc(it.label)}</span>${it.kbd ? `<kbd>${it.kbd}</kbd>` : ''}</button>`)).join('');
    this.openPop({ x, y }, key, html, (p) => p.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mi]');
      if (!b || b.disabled) return;
      this.closePop();
      items[+b.dataset.mi].run();
    }), 'ds-menu');
    const p = this.popEl;
    p.style.left = `${clamp(x, 8, window.innerWidth - p.offsetWidth - 8)}px`;
    p.style.top = `${clamp(above ? y - p.offsetHeight : y, 8, window.innerHeight - p.offsetHeight - 8)}px`;
  }
  contextMenu(x, y, key = 'menu') {
    const app = this.app;
    const sel = app.selected();
    const one = sel.length === 1 ? sel[0] : null;
    const items = sel.length ? [
      { label: 'Salin', icon: 'copy', kbd: 'Ctrl+C', run: () => app.copy() },
      { label: 'Tempel', icon: 'paste', kbd: 'Ctrl+V', run: () => app.paste(), disabled: !app.clipboard },
      { label: 'Duplikat', icon: 'copy', kbd: 'Ctrl+D', run: () => app.duplicateSel() },
      { label: 'Hapus', icon: 'trash', kbd: 'Del', danger: true, run: () => app.deleteSel() },
      { sep: true },
      { label: 'Paling depan', icon: 'up', run: () => app.layer('top') },
      { label: 'Paling belakang', icon: 'down', run: () => app.layer('bottom') },
      { label: sel.every((e) => e.locked) ? 'Buka kunci' : 'Kunci', icon: 'lock', run: () => app.toggleLock() },
      ...(one?.type === 'text' && !one.locked ? [{ sep: true }, { label: 'Ubah teks', icon: 'text', run: () => app.stage.startEdit(one) }] : []),
      ...(one?.type === 'image' ? [{ sep: true }, { label: 'Jadikan latar halaman', icon: 'image', run: () => app.imageToBg(one) }, ...(one.fromSlot ? [{ label: 'Kosongkan bingkai', icon: 'frame', run: () => app.unslot(one) }] : [])] : []),
      ...(one?.slot ? [{ sep: true }, { label: 'Pilih foto', icon: 'image', run: () => app.pickPhotos({ slot: one }) }] : []),
    ] : [
      { label: 'Tempel', icon: 'paste', kbd: 'Ctrl+V', run: () => app.paste(), disabled: !app.clipboard },
      { label: 'Pilih semua', icon: 'check', kbd: 'Ctrl+A', run: () => app.select(app.page.els.filter((e) => !e.locked && !e.hidden).map((e) => e.id)) },
      { sep: true },
      { label: 'Tambah halaman', icon: 'plus', run: () => app.addPage() },
      { label: 'Ubah ukuran desain', icon: 'crop', run: () => this.resizeDialog() },
    ];
    this.menu(x, y, items, key);
  }
  pageMenu(i, x, y, above = false) {
    const app = this.app;
    const n = app.design.pages.length;
    this.menu(x, y, [
      { label: 'Duplikat halaman', icon: 'copy', run: () => app.duplicatePageAt(i) },
      { label: 'Tambah halaman kosong', icon: 'plus', run: () => app.addPage(i) },
      { label: 'Geser ke kiri', icon: 'up', disabled: i === 0, run: () => app.movePage(i, -1) },
      { label: 'Geser ke kanan', icon: 'down', disabled: i === n - 1, run: () => app.movePage(i, 1) },
      { sep: true },
      { label: 'Hapus halaman', icon: 'trash', danger: true, disabled: n === 1, run: () => app.deletePage(i) },
    ], 'pagemenu', above);
  }

  // ---------------------------------------------------------------------------------------------
  // pages strip
  renderPages() {
    const d = this.app.design;
    this.pagesEl.innerHTML = d.pages.map((p, i) => `<button class="ds-pg ${i === this.app.pageIndex ? 'on' : ''}" data-pg="${i}" aria-label="Halaman ${i + 1}"><canvas></canvas><i>${i + 1}</i></button>`).join('') + `<button class="ds-pgadd" data-pgadd aria-label="Tambah halaman" title="Tambah halaman">+</button>`;
    this.drawPageThumbs();
    $('.ds-pg.on', this.pagesEl)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  drawPageThumbs(only = null) {
    const d = this.app.design;
    const cs = $$('.ds-pg canvas', this.pagesEl);
    const hpx = (narrow() ? 52 : 64) * DPR();
    const k = hpx / d.height;
    d.pages.forEach((p, i) => {
      if (only && !only.includes(i)) return;
      const c = cs[i];
      if (!c) return;
      c.width = Math.max(1, Math.round(d.width * k));
      c.height = Math.max(1, Math.round(hpx));
      c.style.width = `${c.width / DPR()}px`;
      drawPage(c.getContext('2d'), d, p, { scale: k, sources: this.app.assets.sources });
    });
  }
  onPagesClick(e) {
    if (e.target.closest('[data-pgadd]')) { this.app.addPage(); return; }
    const b = e.target.closest('[data-pg]');
    if (!b) return;
    const i = +b.dataset.pg;
    if (i === this.app.pageIndex) { const r = b.getBoundingClientRect(); this.pageMenu(i, r.left, r.top - 8, true); return; }
    this.app.gotoPage(i);
  }

  // ---------------------------------------------------------------------------------------------
  // the page size (v1.13.1)
  resizeDialog() {
    this.closePop();
    const d = this.app.design;
    const st = { id: d.sizeId || null, w: d.width, h: d.height };
    const bg = document.createElement('div');
    bg.className = 'ds-modal-bg';
    bg.innerHTML = `<div class="ds-modal" role="dialog" aria-label="Ubah ukuran">
      <h2>Ubah ukuran</h2>
      <p class="ds-hint" style="margin-top:-6px">Sekarang ${d.width} × ${d.height} px. Semua halaman ikut; posisi dan ukuran elemen disesuaikan.</p>
      <div class="ds-rsz">${SIZES.map((z) => `<button data-z="${z.id}"><i style="aspect-ratio:${z.w}/${z.h}"></i><b>${esc(z.name)}</b><small>${z.w} × ${z.h}</small></button>`).join('')}</div>
      <div class="ds-field"><span>Ukuran khusus (px)</span><div class="ds-wh"><input type="number" data-wh="w" min="64" max="8000" inputmode="numeric" aria-label="Lebar"><span>×</span><input type="number" data-wh="h" min="64" max="8000" inputmode="numeric" aria-label="Tinggi"><button class="ds-btn" data-swap title="Tukar lebar dan tinggi">⇄</button></div></div>
      <div class="ds-actions"><button class="ds-btn" data-x>Batal</button><button class="ds-btn" data-copy>Salin & ubah ukuran</button><button class="ds-btn acc" data-go>Ubah ukuran</button></div>
    </div>`;
    document.body.appendChild(bg);
    const W = $('[data-wh="w"]', bg);
    const H = $('[data-wh="h"]', bg);
    const sync = () => {
      W.value = st.w;
      H.value = st.h;
      $$('[data-z]', bg).forEach((b) => b.classList.toggle('on', b.dataset.z === st.id));
    };
    sync();
    const read = () => {
      const w = Math.round(Number(W.value));
      const h = Math.round(Number(H.value));
      if (!(w >= 64 && w <= 8000 && h >= 64 && h <= 8000)) { this.toast('Ukuran 64–8000 px', 'err'); return null; }
      const z = SIZES.find((x) => x.w === w && x.h === h);
      return { w, h, id: z ? z.id : null };
    };
    bg.addEventListener('input', (e) => { if (e.target.dataset.wh) { st.id = null; $$('[data-z]', bg).forEach((b) => b.classList.remove('on')); } });
    bg.addEventListener('keydown', (e) => e.stopPropagation());
    bg.addEventListener('click', (e) => {
      if (e.target === bg || e.target.closest('[data-x]')) { bg.remove(); return; }
      const z = e.target.closest('[data-z]');
      if (z) { const s = SIZES.find((x) => x.id === z.dataset.z); Object.assign(st, { id: s.id, w: s.w, h: s.h }); sync(); return; }
      if (e.target.closest('[data-swap]')) { Object.assign(st, { id: null, w: Number(H.value) || st.h, h: Number(W.value) || st.w }); sync(); return; }
      if (e.target.closest('[data-go]')) { const r = read(); if (r) { bg.remove(); this.app.resize(r.w, r.h, r.id); } return; }
      if (e.target.closest('[data-copy]')) { const r = read(); if (r) { bg.remove(); this.app.copyResized(r.w, r.h, r.id); } }
    });
  }

  // ---------------------------------------------------------------------------------------------
  // export
  exportDialog() {
    this.closePop();
    const d = this.app.design;
    const n = d.pages.length;
    const big = d.width * d.height * 4 > 16.7e6;
    const st = { fmt: 'png', pages: n > 1 ? 'all' : 'cur', scale: 1 };
    const bg = document.createElement('div');
    bg.className = 'ds-modal-bg';
    const canShare = typeof navigator.canShare === 'function';
    bg.innerHTML = `<div class="ds-modal" role="dialog" aria-label="Ekspor desain">
      <h2>Ekspor desain</h2>
      <div class="ds-field"><span>Jenis file</span><div class="ds-seg" data-k="fmt"><button data-v="png">PNG</button><button data-v="jpg">JPG</button><button data-v="tpng">PNG transparan</button></div></div>
      ${n > 1 ? `<div class="ds-field"><span>Halaman</span><div class="ds-seg" data-k="pages"><button data-v="cur">Halaman ini (${this.app.pageIndex + 1})</button><button data-v="all">Semua ${n} halaman</button></div></div>` : ''}
      <div class="ds-field"><span>Ukuran</span><div class="ds-seg" data-k="scale"><button data-v="1">${d.width} × ${d.height}</button><button data-v="2" ${big ? 'disabled title="Terlalu besar untuk perangkat ini"' : ''}>${d.width * 2} × ${d.height * 2} (2×)</button></div></div>
      <p class="ds-hint" data-note></p>
      <div class="ds-prog" hidden><i></i></div>
      <div class="ds-actions"><button class="ds-btn" data-x>Batal</button>${canShare ? `<button class="ds-btn" data-share>${I('share')}Bagikan</button>` : ''}<button class="ds-btn acc" data-dl>${I('download')}Unduh</button></div>
    </div>`;
    document.body.appendChild(bg);
    const sync = () => {
      for (const seg of $$('[data-k]', bg)) for (const b of $$('button', seg)) b.classList.toggle('on', String(st[seg.dataset.k]) === b.dataset.v);
      const many = st.pages === 'all' && n > 1;
      $('[data-note]', bg).textContent = `${many ? `${n} file dalam satu ZIP. ` : ''}${st.fmt === 'jpg' ? 'JPG: file kecil, cocok untuk marketplace.' : st.fmt === 'tpng' ? 'Tanpa warna latar halaman (untuk ditempel di desain lain).' : 'PNG: kualitas terbaik.'}${canShare ? ' Di iPad, “Bagikan” → Simpan Gambar untuk menaruhnya di Foto.' : ''}`;
    };
    sync();
    const close = () => bg.remove();
    let busy = false;
    const run = async (share) => {
      if (busy) return;
      busy = true;
      const prog = $('.ds-prog', bg);
      prog.hidden = false;
      $$('.ds-actions button', bg).forEach((b) => { b.disabled = true; });
      try {
        const out = await this.app.exportFiles({ ...st, onProgress: (f) => { $('i', prog).style.width = `${Math.round(f * 100)}%`; } });
        if (share) {
          const file = new File([out.blob], out.name, { type: out.blob.type });
          if (navigator.canShare?.({ files: [file] })) {
            try { await navigator.share({ files: [file], title: d.name || 'Desain' }); } catch (err) { if (err?.name !== 'AbortError') throw err; }
          } else downloadBlobFile(out.blob, out.name);
        } else downloadBlobFile(out.blob, out.name);
        close();
        this.toast(share ? 'Siap dibagikan' : `Diunduh: ${out.name}`, 'ok');
      } catch (err) {
        this.toast(`Ekspor gagal: ${err.message}`, 'err');
        busy = false;
        prog.hidden = true;
        $$('.ds-actions button', bg).forEach((b) => { b.disabled = false; });
      }
    };
    bg.addEventListener('click', (e) => {
      if (e.target === bg || e.target.closest('[data-x]')) { if (!busy) close(); return; }
      const v = e.target.closest('[data-v]');
      if (v && !v.disabled) { const k = v.closest('[data-k]').dataset.k; st[k] = k === 'scale' ? +v.dataset.v : v.dataset.v; sync(); return; }
      if (e.target.closest('[data-dl]')) run(false);
      if (e.target.closest('[data-share]')) run(true);
    });
  }
}

// ---------------------------------------------------------------------------------------------
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const alignGrid = () => `<div class="ds-grid">${[['left', 'aL', 'Kiri'], ['center', 'aC', 'Tengah'], ['right', 'aR', 'Kanan'], ['top', 'aT', 'Atas'], ['middle', 'aM', 'Tengah'], ['bottom', 'aB', 'Bawah']].map(([k, ic, n]) => `<button class="ds-btn" data-align="${k}" style="flex-direction:column;gap:2px;padding:6px 0;font-size:11px">${I(ic)}${n}</button>`).join('')}</div>`;
function layerName(e) {
  if (e.type === 'text') return String(e.text?.content || 'Teks').split('\n')[0].slice(0, 40) || 'Teks';
  if (e.slot) return 'Bingkai foto (kosong)';
  return e.name || { image: 'Foto', shape: 'Bentuk', sticker: 'Elemen' }[e.type] || 'Elemen';
}
/** The effect a text shows (one at a time, like a tablet design app). */
export function fxOf(tx) {
  if (tx.bg?.enabled) return 'bg';
  if (tx.effect?.type && tx.effect.type !== 'none') return tx.effect.type;
  if (tx.stroke?.enabled) return 'outline';
  if (tx.shadow?.enabled) return 'shadow-old';
  return 'none';
}
/** Put effect `id` on a text (the others off; its own settings kept when it is chosen again). */
export function applyFx(tx, id) {
  const prev = tx.effect?.type === id ? tx.effect : null;
  tx.effect = null;
  tx.bg = { color: '#FFD400', opacity: 1, radius: Math.round(tx.size * 0.18), padding: 1, ...(tx.bg || {}), enabled: false };
  tx.stroke = { color: '#111111', width: Math.max(2, Math.round(tx.size * 0.05)), ...(tx.stroke || {}), enabled: false };
  tx.shadow = { ...(tx.shadow || {}), enabled: false };
  if (id === 'bg') { tx.bg.enabled = true; if (!tx.bg.color || same(tx.bg.color, '#000000')) { tx.bg.color = '#FFD400'; tx.bg.opacity = 1; } } else if (id === 'outline') tx.stroke.enabled = true;
  else if (id !== 'none') tx.effect = prev || { type: id, color: FX_COLOR[id] || '', color2: '#FF2DAA', offset: 50, intensity: 50 };
}
function downloadBlobFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
