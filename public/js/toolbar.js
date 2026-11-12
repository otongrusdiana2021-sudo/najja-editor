// Bottom toolbar (iPad layout). Three levels, like a tablet video editor:
//   root (nothing selected)  → Edit · Audio · Teks · Efek · Overlay · Keterangan · Filter · Sesuaikan
//   category (Audio, Teks…)  → that category's tools, with a back button
//   clip (a clip selected)   → tools for that kind of clip, with a back button
// Tools that are planned but not built yet are shown greyed with "Segera" (they explain themselves when tapped).
import { store, sortedClips, clipEnd } from './store.js';
import { icon } from './icons.js';
import { escapeHtml } from './util.js';
import { toast } from './ui.js';
import * as actions from './actions.js';
import { categoryOf, CATEGORIES } from './timeline.js';

const SOON_NOTE = {
  videoai: 'Video AI membuat klip baru dari gambar atau teks dengan model AI.',
  retouch: 'Retouch merapikan wajah (kulit, bentuk) secara otomatis.',
  lipsync: 'Lipsync menyamakan gerak bibir dengan suara.',
  motion: 'Tiru gerakan memindahkan gerakan dari satu video ke foto/video lain.',
  expr: 'Ubah ekspresi mengganti ekspresi wajah dengan AI.',
  stab: 'Stabilkan meredam video yang goyang (diproses di server).',
  track: 'Pelacakan kamera membuat teks/stiker mengikuti objek yang bergerak.',
  vsplit: 'Pisah suara memisahkan vokal dari musik latar.',
  denoise: 'Kurangi kebisingan membersihkan desis dan suara latar.',
  afx: 'Efek audio: suara robot, gema, radio, chipmunk, dan lainnya.',
  enhance: 'Sempurnakan suara membuat suara bicara lebih jelas dan penuh.',
  reverse: 'Putar mundur memutar klip dari akhir ke awal (diproses di server).',
  mask: 'Tutupi (mask): lingkaran, persegi, garis, cermin, hati, bintang.',
  bodyfx: 'Efek tubuh butuh pemisahan orang dari latar secara otomatis.',
};

const tool = (id, label, ic, run, extra = {}) => ({ id, label, icon: ic, run, ...extra });
const soon = (id, label, ic) => ({ id, label, icon: ic, soon: true });
const SEP = 'sep';

export class Toolbar {
  constructor(root, { engine, timeline }) {
    this.root = root;
    this.engine = engine;
    this.timeline = timeline;
    this.cat = null;
    root.addEventListener('click', (e) => this.onClick(e));
    store.on('selection', () => {
      const c = store.selected();
      if (c) this.cat = categoryOf(c); // back from a clip returns to its category (main clip: the main menu)
      this.render();
    });
    store.on('project', () => this.render());
    this.render();
  }

  get app() { return actions.app; }
  open(id, opts) { this.app.openSheet(id, opts); }

  // ---------------------------------------------------------------------------------------------
  rootTools() {
    return [
      tool('edit', 'Edit', 'scissors', () => this.editAtPlayhead()),
      tool('cat-audio', 'Audio', 'audio', () => this.openCategory('audio')),
      tool('cat-text', 'Teks', 'text', () => this.openCategory('text')),
      tool('cat-effect', 'Efek', 'effects', () => this.openCategory('effect')),
      tool('cat-overlay', 'Overlay', 'addOverlay', () => this.openCategory('overlay')),
      tool('captions', 'Keterangan', 'subtitle', () => this.open('caption')),
      tool('filter-layer', 'Filter', 'filter', () => this.addLayer('filter')),
      tool('adjust-layer', 'Sesuaikan', 'adjust', () => this.addLayer('adjust')),
    ];
  }

  categoryTools(cat) {
    switch (cat) {
      case 'audio': return [
        tool('extract', 'Ekstrak', 'extract', () => this.open('media', { mode: 'extract' })),
        tool('music', 'Suara', 'disc', () => this.open('music')),
        tool('sfx', 'Efek suara', 'sfx', () => this.open('sfx')),
        tool('record', this.app.library?.recorder ? 'Berhenti' : 'Rekam', 'mic', () => this.open('record'), { on: !!this.app.library?.recorder }),
      ];
      case 'text': return [
        tool('add-text', 'Tambah teks', 'textAdd', () => this.addText()),
        tool('templates', 'Template teks', 'template', () => this.open('templates')),
        tool('auto-text', 'Teks otomatis', 'subtitle', () => this.open('caption')),
      ];
      case 'effect': return [
        tool('video-fx', 'Efek video', 'videoFx', () => this.open('effect')),
        soon('bodyfx', 'Efek tubuh', 'bodyFx'),
      ];
      case 'overlay': return [
        tool('add-overlay', 'Tambah overlay', 'addOverlay', () => this.open('media', { mode: 'overlay' })),
      ];
      default: return [];
    }
  }

  clipTools(c) {
    const id = c.id;
    const onMain = c.trackId === 'main';
    const split = tool('split', 'Bagi', 'split', () => {
      const t = this.engine.time;
      if (t <= c.start + 0.05 || t >= clipEnd(c) - 0.05) { toast('Geser playhead ke tengah klip untuk membagi', { type: 'warn' }); return; }
      actions.splitAt(t, id);
    });
    const del = tool('delete', 'Hapus', 'trash', () => actions.deleteClips([id]));
    const dup = tool('dup', 'Duplikat', 'copy', () => actions.duplicateClip(id));
    const anim = tool('anim', 'Animasi', 'anim', () => this.open('anim'));
    const fx = tool('fx', 'Efek', 'effects', () => this.open('effect', { range: { start: c.start, duration: c.duration } }));
    const adjust = tool('adjust', 'Sesuaikan', 'adjust', () => this.open('adjust'));
    const filter = tool('filter', 'Filter', 'filter', () => this.open('filter'));
    const transform = tool('transform', 'Transformasi', 'transform', () => this.open('transform'));
    const blend = tool('blend', 'Campuran', 'blend', () => this.open('blend'));
    const move = onMain
      ? tool('to-overlay', 'Overlay', 'toOverlay', () => { actions.moveToOverlay(id); toast('Klip dipindah ke overlay', { type: 'ok' }); })
      : tool('to-main', 'Utama', 'toMain', () => { actions.moveToMain(id); toast('Klip dipindah ke track utama', { type: 'ok' }); });
    const audioSoon = [soon('vsplit', 'Pisah suara', 'voiceSplit'), soon('denoise', 'Kurangi kebisingan', 'denoise'), soon('afx', 'Efek audio', 'audioFx'), soon('enhance', 'Sempurnakan suara', 'enhance')];
    switch (c.type) {
      case 'video': return [
        split, tool('volume', 'Volume', 'volume', () => this.open('volume')), anim, fx, del, soon('videoai', 'Video AI', 'videoAI'),
        tool('speed', 'Kecepatan', 'speed', () => this.open('speed')), tool('crop', 'Pangkas', 'crop', () => this.open('crop')), dup,
        tool('replace', 'Ganti', 'replace', () => this.open('media', { mode: 'replace' })), move, adjust, filter, SEP,
        soon('retouch', 'Retouch', 'retouch'), tool('bgremove', 'Hapus Latar Belakang', 'bgRemove', () => this.open('bgremove')), SEP,
        soon('lipsync', 'Lipsync', 'lips'), soon('motion', 'Tiru gerakan', 'motion'), soon('expr', 'Ubah ekspresi', 'expression'), SEP,
        transform, soon('stab', 'Stabilkan', 'stabilize'), soon('track', 'Pelacakan kamera', 'crosshair'), SEP,
        ...audioSoon, SEP,
        tool('freeze', 'Beku', 'freeze', () => actions.freezeFrame()), soon('reverse', 'Putar mundur', 'reverse'), soon('mask', 'Tutupi', 'mask'),
        ...(onMain ? [] : [blend]),
      ];
      case 'image': return [
        split, anim, fx, del, tool('crop', 'Pangkas', 'crop', () => this.open('crop')), dup,
        tool('replace', 'Ganti', 'replace', () => this.open('media', { mode: 'replace' })), move, adjust, filter, SEP,
        soon('retouch', 'Retouch', 'retouch'), tool('bgremove', 'Hapus Latar Belakang', 'bgRemove', () => this.open('bgremove')), SEP,
        transform, soon('mask', 'Tutupi', 'mask'), ...(onMain ? [] : [blend]),
      ];
      case 'solid': return [
        tool('solid', 'Warna', 'palette', () => this.open('solid')), split, anim, fx, del, dup, move, adjust, filter, transform, ...(onMain ? [] : [blend]),
      ];
      case 'text': return [
        tool('text-edit', 'Edit', 'edit', () => this.open('text', { tab: 'style', focus: true })),
        tool('text-font', 'Font', 'font', () => this.open('text', { tab: 'font' })),
        tool('text-color', 'Warna', 'palette', () => this.open('text', { tab: 'color' })),
        tool('text-anim', 'Animasi', 'anim', () => this.open('text', { tab: 'anim' })),
        split, dup, del, transform,
      ];
      case 'sticker': return [
        ...(c.sticker?.badge ? [tool('label', 'Edit', 'edit', () => this.open('sticker'))] : []),
        anim, split, dup, del, transform, blend,
      ];
      case 'audio': return [
        split, tool('volume', 'Volume', 'volume', () => this.open('volume')), tool('speed', 'Kecepatan', 'speed', () => this.open('speed')), del, dup, SEP, ...audioSoon,
      ];
      case 'effect':
        if (c.effect?.type === 'adjust') return [filter, adjust, split, dup, del];
        return [tool('fx-edit', 'Ganti efek', 'replace', () => this.open('effect-edit')), split, dup, del];
      default: return [split, dup, del];
    }
  }

  // ---------------------------------------------------------------------------------------------
  render() {
    const c = store.selected();
    let items;
    let back = false;
    let title = '';
    if (c) {
      items = this.clipTools(c);
      back = true;
      this.timeline?.setFocus(categoryOf(c));
    } else if (this.cat) {
      items = this.categoryTools(this.cat);
      back = true;
      title = CATEGORIES[this.cat]?.label || '';
      this.timeline?.setFocus(this.cat);
    } else {
      items = this.rootTools();
      this.timeline?.setFocus(null);
    }
    this.items = items.filter((x) => x !== SEP);
    const active = this.app.sheet?.id;
    const sheetFor = { volume: 'volume', anim: 'anim', 'text-anim': 'text', speed: 'speed', crop: 'crop', adjust: 'adjust', filter: 'filter', transform: 'transform', blend: 'blend', bgremove: 'bgremove', music: 'music', sfx: 'sfx', record: 'record', templates: 'templates', captions: 'caption', 'auto-text': 'caption', 'video-fx': 'effect', fx: 'effect', 'fx-edit': 'effect-edit', solid: 'solid', label: 'sticker' };
    const html = items.map((it) => {
      if (it === SEP) return '<i class="tool-sep"></i>';
      const on = it.on || (active && sheetFor[it.id] === active);
      return `<button class="tool ${it.soon ? 'soon' : ''} ${on ? 'on' : ''}" data-tool="${it.id}" title="${escapeHtml(it.label)}${it.soon ? ' — segera hadir' : ''}">
        <span class="tool-ic">${icon(it.icon, 24)}${it.soon ? '<em class="tool-badge">Segera</em>' : ''}</span><span class="tool-lb">${escapeHtml(it.label)}</span></button>`;
    }).join('');
    const scroll = this.root.querySelector('.tb-scroll');
    const keep = scroll && this.root.dataset.level === (c ? `clip:${c.type}:${c.trackId === 'main'}` : this.cat || 'root') ? scroll.scrollLeft : 0;
    this.root.dataset.level = c ? `clip:${c.type}:${c.trackId === 'main'}` : this.cat || 'root';
    this.root.innerHTML = `${back ? `<button class="tb-back" data-back title="Kembali" aria-label="Kembali">${icon('chevronLeft', 22)}</button>` : ''}
      ${title ? `<span class="tb-title">${escapeHtml(title)}</span>` : ''}
      <div class="tb-scroll">${html}</div>`;
    this.root.querySelector('.tb-scroll').scrollLeft = keep;
  }

  onClick(e) {
    if (e.target.closest('[data-back]')) { this.back(); return; }
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    const it = this.items.find((x) => x.id === b.dataset.tool);
    if (!it) return;
    if (it.soon) {
      toast(`${it.label} segera hadir. ${SOON_NOTE[it.id] || ''}`.trim(), { type: 'info', timeout: 3400 });
      return;
    }
    try { it.run(); } catch (err) { toast(err.message, { type: 'error', timeout: 4000 }); }
  }

  back() {
    this.app.sheet?.close();
    if (store.selection) {
      store.select(null);
      return;
    }
    this.cat = null;
    this.render();
  }

  openCategory(cat) {
    this.app.sheet?.close();
    this.cat = CATEGORIES[cat] ? cat : null;
    if (store.selection) store.select(null);
    else this.render();
  }

  /** The "+ Tambah …" button in an empty lane of a category. */
  addInCategory(kind) {
    if (kind === 'overlay') this.open('media', { mode: 'overlay' });
    else if (kind === 'audio') this.open('music');
    else if (kind === 'text') this.addText();
    else if (kind === 'effect') this.open('effect');
  }

  /** Filter / adjustment layer over everything at the playhead; dropped again if nothing was changed. */
  addLayer(kind) {
    const layer = actions.addAdjustLayer({ kind });
    const neutral = (c) => c && (c.filter?.name || 'none') === 'none' && !Object.values(c.adjust || {}).some((v) => v);
    this.open(kind === 'filter' ? 'filter' : 'adjust', {
      onClose: () => { if (neutral(store.clip(layer.id))) actions.deleteClips([layer.id]); },
    });
  }

  addText() {
    const c = actions.addText({ text: 'Teks baru', start: this.engine.time });
    store.select(c.id);
    this.open('text', { tab: 'style', focus: true });
  }

  /** "Edit": select the main clip under the playhead (or the nearest one). */
  editAtPlayhead() {
    const list = sortedClips(store.P, 'main');
    if (!list.length) { toast('Belum ada klip — ketuk + untuk menambah video', { type: 'info' }); this.open('media', { mode: 'append' }); return; }
    const t = this.engine.time;
    const c = list.find((x) => t >= x.start && t < clipEnd(x)) || list.reduce((a, b) => (Math.abs(b.start - t) < Math.abs(a.start - t) ? b : a));
    store.select(c.id);
  }

  /** Every tool the search can run, with where it lives. */
  catalog() {
    const out = [];
    for (const it of this.rootTools()) out.push({ ...it, where: 'Menu utama' });
    for (const cat of Object.keys(CATEGORIES)) for (const it of this.categoryTools(cat)) out.push({ ...it, where: CATEGORIES[cat].label });
    const sel = store.selected();
    if (sel) for (const it of this.clipTools(sel)) if (it !== SEP) out.push({ ...it, where: 'Klip terpilih' });
    return out;
  }
}
