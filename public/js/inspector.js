// Right-hand inspector: properties of the selected clip, or project settings when nothing is selected.
import { store, setSpeed, sortedClips, MIN_CLIP, KF_PROPS, kfValue, upsertKeyframe, removeKeyframe, keyframeAt } from './store.js';
import {
  ASPECTS, FILTERS, ADJUSTMENTS, BLEND_MODES, ANIM_IN, ANIM_OUT, ANIM_LOOP, FONTS, TEXT_PRESETS, TRANSITIONS, EFFECTS, FPS_OPTIONS,
} from './presets.js';
import { icon } from './icons.js';
import { escapeHtml, getPath, setPath, clamp, fmtSec, normHex, deepMerge, clone } from './util.js';
import { presetStyle } from './actions.js';
import * as actions from './actions.js';
import { setAspect } from './player.js';

const TABS = {
  video: [['basic', 'Video'], ['anim', 'Animasi'], ['adjust', 'Warna'], ['speed', 'Kecepatan'], ['audio', 'Audio']],
  image: [['basic', 'Foto'], ['anim', 'Animasi'], ['adjust', 'Warna']],
  solid: [['basic', 'Latar'], ['anim', 'Animasi'], ['adjust', 'Warna']],
  text: [['text', 'Teks'], ['anim', 'Animasi']],
  sticker: [['sticker', 'Stiker'], ['anim', 'Animasi']],
  audio: [['audio', 'Audio'], ['speed', 'Kecepatan']],
  effect: [['effect', 'Efek']],
};

const sec = (title, body, extra = '') => `<section class="isec"><div class="isec-head"><span>${title}</span>${extra}</div><div class="isec-body">${body}</div></section>`;

function slider(label, path, min, max, step = 1, { scale = 1, unit = '', decimals = 0 } = {}) {
  return `<div class="ctl"><label>${label}</label><div class="ctl-row">
    <input type="range" data-path="${path}" data-scale="${scale}" min="${min}" max="${max}" step="${step}">
    <span class="num"><input type="number" data-path="${path}" data-scale="${scale}" min="${min}" max="${max}" step="${step}" data-dec="${decimals}">${unit ? `<em>${unit}</em>` : ''}</span>
  </div></div>`;
}
const color = (label, path) => `<div class="ctl ctl-inline"><label>${label}</label><span class="color-in"><input type="color" data-path="${path}" data-kind="color"><input type="text" data-path="${path}" data-kind="hex" maxlength="7" spellcheck="false"></span></div>`;
const toggle = (label, path) => `<label class="switch-row"><span>${label}</span><input type="checkbox" class="switch" data-path="${path}" data-kind="bool"></label>`;
const select = (label, path, options) => `<div class="ctl ctl-inline"><label>${label}</label><select data-path="${path}" data-kind="str">${options.map(([v, n]) => `<option value="${escapeHtml(v)}">${escapeHtml(n)}</option>`).join('')}</select></div>`;

export class Inspector {
  constructor(root, engine) {
    this.root = root;
    this.engine = engine;
    this.tab = {};
    this.animTab = 'in';
    root.addEventListener('input', (e) => this.onInput(e, false));
    root.addEventListener('change', (e) => this.onInput(e, true));
    root.addEventListener('click', (e) => this.onClick(e));
    store.on('selection', () => this.render());
    store.on('project', () => this.render());
    store.on('transform', () => this.syncValues());
    store.on('live', () => this.syncValues());
    this.render();
  }

  target() { return store.selected(); }

  render() {
    if (this.root.contains(document.activeElement) && document.activeElement.matches('textarea, input[type="text"], input[type="number"]') && store._live) return;
    const c = this.target();
    if (!c) { this.renderProject(); return; }
    const tabs = TABS[c.type] || [];
    const tab = tabs.find((t) => t[0] === this.tab[c.type]) ? this.tab[c.type] : tabs[0]?.[0];
    let body = '';
    switch (tab) {
      case 'basic': body = this.basicPanel(c); break;
      case 'anim': body = this.animPanel(c); break;
      case 'adjust': body = this.adjustPanel(); break;
      case 'speed': body = this.speedPanel(c); break;
      case 'audio': body = this.audioPanel(c); break;
      case 'text': body = this.textPanel(c); break;
      case 'sticker': body = this.stickerPanel(c); break;
      case 'effect': body = this.effectPanel(c); break;
      default: break;
    }
    this.root.innerHTML = `
      <div class="insp-tabs" role="tablist">${tabs.map(([id, name]) => `<button role="tab" class="${id === tab ? 'on' : ''}" data-tab="${id}">${name}</button>`).join('')}</div>
      <div class="insp-body" data-type="${c.type}">${body}</div>`;
    this.syncValues(true);
  }

  // ---------------------------------------------------------------------------------------------
  transformSection(c, { fit = false } = {}) {
    const local = this.engine.time - c.start;
    const has = !!keyframeAt(c, local);
    const n = c.keyframes?.length || 0;
    const kfBtn = `<span class="kf-ctl">${n ? `<button class="kf-nav" data-do="kfPrev" title="Keyframe sebelumnya">‹</button>` : ''}<button class="kf-btn ${has ? 'on' : ''}" data-do="kf" title="${has ? 'Hapus' : 'Tambah'} keyframe di playhead">◆</button>${n ? `<button class="kf-nav" data-do="kfNext" title="Keyframe berikutnya">›</button><em>${n}</em>` : ''}</span>`;
    return sec('Transformasi', `
      ${slider('Skala', 'scale', 1, 400, 1, { scale: 100, unit: '%' })}
      <div class="ctl-2">
        <div class="ctl"><label>Posisi X</label><span class="num wide"><input type="number" data-path="x" data-scale="${store.P.width}" step="1"><em>px</em></span></div>
        <div class="ctl"><label>Posisi Y</label><span class="num wide"><input type="number" data-path="y" data-scale="${store.P.height}" step="1"><em>px</em></span></div>
      </div>
      ${slider('Rotasi', 'rotation', -180, 180, 1, { unit: '°' })}
      <div class="btn-row">
        ${fit ? `<button class="btn sm" data-do="fill">${icon('fit', 14)} Isi layar</button><button class="btn sm" data-do="fit">Sesuaikan</button>` : ''}
        <button class="btn sm icon-only" data-do="flipH" title="Cermin horizontal">${icon('flipH', 15)}</button>
        <button class="btn sm icon-only" data-do="flipV" title="Balik vertikal">${icon('flipV', 15)}</button>
        <button class="btn sm ghost" data-do="resetTransform">Reset</button>
      </div>${n ? '<p class="hint">Keyframe aktif: ubah posisi/skala/rotasi/opasitas di waktu lain untuk membuat gerakan.</p>' : ''}`, kfBtn);
  }

  basicPanel(c) {
    const P = store.P;
    let out = this.transformSection(c, { fit: c.type !== 'solid' });
    out += sec('Campuran', `${slider('Opasitas', 'opacity', 0, 100, 1, { scale: 100, unit: '%' })}${select('Mode', 'blend', BLEND_MODES.map((b) => [b.id, b.name]))}`);
    if (c.type === 'solid') {
      out += sec('Warna', `${color('Warna', 'solid.color')}${toggle('Gradien', 'solid.gradient')}${c.solid.color2 ? `${color('Warna 2', 'solid.color2')}${slider('Sudut', 'solid.angle', 0, 360, 1, { unit: '°' })}` : ''}`);
    } else {
      out += sec('Chroma key', `${toggle('Hapus warna latar', 'chroma.enabled')}${c.chroma?.enabled ? `${color('Warna kunci', 'chroma.color')}${slider('Kemiripan', 'chroma.similarity', 0, 100, 1, { scale: 100, unit: '%' })}${slider('Kehalusan', 'chroma.smoothness', 0, 100, 1, { scale: 100, unit: '%' })}` : ''}`);
      out += sec('Potong', `<div class="ctl-2">${slider('Kiri', 'crop.l', 0, 90, 1, { scale: 100, unit: '%' })}${slider('Kanan', 'crop.r', 0, 90, 1, { scale: 100, unit: '%' })}</div><div class="ctl-2">${slider('Atas', 'crop.t', 0, 90, 1, { scale: 100, unit: '%' })}${slider('Bawah', 'crop.b', 0, 90, 1, { scale: 100, unit: '%' })}</div>`);
    }
    out += sec('Filter', `${select('Filter', 'filter.name', FILTERS.map((f) => [f.id, f.name]))}${c.filter.name !== 'none' ? slider('Intensitas', 'filter.intensity', 0, 100, 1, { scale: 100, unit: '%' }) : ''}`,
      `<button class="link" data-open="filter">Lihat semua</button>`);
    if (c.trackId === 'main') {
      const list = sortedClips(P, 'main');
      if (list.indexOf(c) > 0) {
        out += sec('Transisi masuk', `${select('Jenis', 'transition.type', TRANSITIONS.map((t) => [t.id, t.name]))}${c.transition.type !== 'none' ? slider('Durasi', 'transition.duration', 0.1, 3, 0.1, { unit: 's', decimals: 1 }) : ''}`,
          `<button class="link" data-open="transition">Galeri</button>`);
      }
    }
    return out;
  }

  animPanel(c) {
    const lists = { in: ANIM_IN, out: ANIM_OUT, loop: ANIM_LOOP };
    const key = { in: 'animIn', out: 'animOut', loop: 'animLoop' }[this.animTab];
    const cur = c[key]?.type || 'none';
    const items = lists[this.animTab].filter((a) => c.type === 'text' || a.id !== 'typewriter');
    return `
      <div class="seg wide">${[['in', 'Masuk'], ['out', 'Keluar'], ['loop', 'Kombo']].map(([id, n]) => `<button class="${this.animTab === id ? 'on' : ''}" data-animtab="${id}">${n}${c[{ in: 'animIn', out: 'animOut', loop: 'animLoop' }[id]]?.type !== 'none' ? ' •' : ''}</button>`).join('')}</div>
      <div class="anim-grid">${items.map((a) => `<button class="anim-chip ${cur === a.id ? 'on' : ''}" data-anim="${a.id}" data-key="${key}"><span class="anim-demo a-${this.animTab}-${a.id}"></span><span>${a.name}</span></button>`).join('')}</div>
      ${cur !== 'none' ? (this.animTab === 'loop'
        ? slider('Kecepatan', 'animLoop.speed', 0.25, 4, 0.05, { unit: 'x', decimals: 2 })
        : slider('Durasi', `${key}.duration`, 0.1, Math.max(0.2, Math.min(5, c.duration)), 0.1, { unit: 's', decimals: 1 })) : ''}`;
  }

  adjustPanel() {
    return sec('Penyesuaian', ADJUSTMENTS.map((a) => slider(a.name, `adjust.${a.id}`, a.min, a.max, 1)).join(''), '<button class="link" data-do="resetAdjust">Reset</button>');
  }

  speedPanel(c) {
    const presets = [0.25, 0.5, 1, 1.5, 2, 3, 5];
    return sec('Kecepatan', `
      <div class="chip-row">${presets.map((s) => `<button class="chip ${Math.abs((c.speed || 1) - s) < 0.001 ? 'on' : ''}" data-speed="${s}">${s}x</button>`).join('')}</div>
      ${slider('Kecepatan', 'speed', 0.1, 10, 0.05, { unit: 'x', decimals: 2 })}
      <p class="hint">Durasi: <b>${fmtSec(c.duration)}</b> · Sumber: ${fmtSec(c.duration * (c.speed || 1))}</p>`);
  }

  audioPanel(c) {
    return sec('Audio', `
      ${slider('Volume', 'volume', 0, 200, 1, { scale: 100, unit: '%' })}
      ${slider('Fade in', 'fadeIn', 0, Math.min(10, c.duration / 2), 0.1, { unit: 's', decimals: 1 })}
      ${slider('Fade out', 'fadeOut', 0, Math.min(10, c.duration / 2), 0.1, { unit: 's', decimals: 1 })}
      ${toggle('Bisukan klip', 'muted')}
      ${c.type === 'video' ? `<button class="btn sm" data-do="extract">${icon('detach', 14)} Ekstrak audio</button>` : ''}`);
  }

  textPanel(c) {
    const t = c.text;
    return `
      ${sec('Isi teks', `<textarea class="text-input" data-path="text.content" data-kind="str" rows="3" placeholder="Ketik teks…"></textarea>`)}
      ${sec('Gaya cepat', `<div class="preset-grid">${TEXT_PRESETS.map((p) => `<button class="tp ${t.preset === p.id ? 'on' : ''}" data-preset="${p.id}" title="${p.name}"><span class="tp-prev tp-${p.id}">Aa</span></button>`).join('')}</div>`)}
      ${sec('Font', `
        <select class="font-select" data-path="text.font" data-kind="str">${FONTS.map((f) => `<option value="${f.name}" style="font-family:'${f.name}'">${f.name}</option>`).join('')}</select>
        ${slider('Ukuran', 'text.size', 8, 400, 1, { unit: 'px' })}
        <div class="btn-row">
          <button class="btn sm icon-only ${t.weight >= 600 ? 'on' : ''}" data-do="bold" title="Tebal"><b>B</b></button>
          <button class="btn sm icon-only ${t.italic ? 'on' : ''}" data-do="italic" title="Miring"><i>I</i></button>
          <div class="seg">${['left', 'center', 'right'].map((a) => `<button class="${t.align === a ? 'on' : ''}" data-align="${a}" title="Rata ${a === 'left' ? 'kiri' : a === 'right' ? 'kanan' : 'tengah'}">${a === 'left' ? '⇤' : a === 'right' ? '⇥' : '↔'}</button>`).join('')}</div>
        </div>
        ${color('Warna', 'text.color')}
        <div class="ctl-2">${slider('Spasi huruf', 'text.letterSpacing', -10, 60, 1)}${slider('Spasi baris', 'text.lineHeight', 0.6, 3, 0.05, { decimals: 2 })}</div>`)}
      ${sec('Garis tepi', `${toggle('Aktif', 'text.stroke.enabled')}${t.stroke.enabled ? `${color('Warna', 'text.stroke.color')}${slider('Tebal', 'text.stroke.width', 1, 40, 1)}` : ''}`)}
      ${sec('Latar', `${toggle('Aktif', 'text.bg.enabled')}${t.bg.enabled ? `${color('Warna', 'text.bg.color')}${slider('Opasitas', 'text.bg.opacity', 0, 100, 1, { scale: 100, unit: '%' })}${slider('Sudut bulat', 'text.bg.radius', 0, 80, 1)}` : ''}`)}
      ${sec('Bayangan', `${toggle('Aktif', 'text.shadow.enabled')}${t.shadow.enabled ? `${color('Warna', 'text.shadow.color')}${slider('Blur', 'text.shadow.blur', 0, 80, 1)}${slider('Jarak', 'text.shadow.y', -40, 40, 1)}` : ''}`)}
      ${sec('Gradien', `${toggle('Aktif', 'text.gradient.enabled')}${t.gradient.enabled ? `${color('Dari', 'text.gradient.from')}${color('Ke', 'text.gradient.to')}` : ''}`)}
      ${this.transformSection(c)}
      ${sec('Campuran', slider('Opasitas', 'opacity', 0, 100, 1, { scale: 100, unit: '%' }))}`;
  }

  stickerPanel(c) {
    const b = c.sticker?.badge;
    return `${b ? sec('Label', `<div class="ctl"><label>Teks</label><input type="text" data-path="sticker.badge.text" data-kind="str"></div>${color('Latar', 'sticker.badge.bg')}${color('Teks', 'sticker.badge.fg')}`) : ''}
      ${this.transformSection(c)}${sec('Campuran', slider('Opasitas', 'opacity', 0, 100, 1, { scale: 100, unit: '%' }))}`;
  }

  effectPanel(c) {
    return `${sec('Efek', `<div class="fx-grid">${EFFECTS.map((f) => `<button class="fx-chip ${c.effect.type === f.id ? 'on' : ''}" data-effect="${f.id}" style="--a:${f.colors[0]};--b:${f.colors[1]}"><span>${f.icon}</span>${f.name}</button>`).join('')}</div>`)}
      ${sec('Pengaturan', `${slider('Intensitas', 'effect.intensity', 0, 100, 1, { scale: 100, unit: '%' })}<p class="hint">Efek berlaku untuk seluruh layer di bawahnya selama ${fmtSec(c.duration)}.</p>`)}`;
  }

  renderProject() {
    const P = store.P;
    const media = P.media.length;
    this.root.innerHTML = `
      <div class="insp-tabs"><button class="on">Proyek</button></div>
      <div class="insp-body project-panel">
        ${sec('Draf', `<div class="ctl"><label>Nama proyek</label><input type="text" data-ppath="name" data-kind="str" maxlength="80"></div>
          <div class="stats"><div><b>${fmtSec(store.duration())}</b><span>Durasi</span></div><div><b>${P.clips.length}</b><span>Klip</span></div><div><b>${media}</b><span>Media</span></div></div>`)}
        ${sec('Rasio kanvas', `<div class="ratio-grid">${Object.entries(ASPECTS).map(([k, a]) => `<button class="ratio-chip ${P.aspect === k ? 'on' : ''}" data-aspect="${k}"><i style="aspect-ratio:${a.w}/${a.h}"></i><b>${k}</b><span>${a.hint}</span></button>`).join('')}</div>`)}
        ${sec('Latar kanvas', `<div class="seg wide"><button class="${P.background.mode === 'color' ? 'on' : ''}" data-bgmode="color">Warna</button><button class="${P.background.mode === 'blur' ? 'on' : ''}" data-bgmode="blur">Blur</button></div>
          ${P.background.mode === 'blur' ? slider('Kekuatan blur', 'background.blur', 0, 100, 1).replace(/data-path/g, 'data-ppath') : color('Warna', 'background.color').replace(/data-path/g, 'data-ppath')}`)}
        ${sec('Frame rate', `<div class="chip-row">${FPS_OPTIONS.map((f) => `<button class="chip ${P.fps === f ? 'on' : ''}" data-fps="${f}">${f} fps</button>`).join('')}</div>`)}
        <div class="tips">${icon('help', 15)}<div><b>Tips</b><span>Pilih klip di timeline untuk mengedit propertinya. Spasi = putar/jeda, Ctrl+B = pisah, Delete = hapus.</span></div></div>
      </div>`;
    this.syncValues(true);
  }

  // ---------------------------------------------------------------------------------------------
  syncValues(force = false) {
    const c = this.target();
    const P = store.P;
    for (const el of this.root.querySelectorAll('[data-path], [data-ppath]')) {
      if (!force && el === document.activeElement) continue;
      const isProject = el.hasAttribute('data-ppath');
      const obj = isProject ? P : c;
      if (!obj) continue;
      const path = el.dataset.path || el.dataset.ppath;
      let v = path === 'solid.gradient' ? !!obj.solid?.color2 : getPath(obj, path);
      if (!isProject && obj.keyframes?.length && KF_PROPS.includes(path)) v = kfValue(obj, path, this.engine.time - obj.start);
      const kind = el.dataset.kind;
      if (kind === 'bool') el.checked = !!v;
      else if (kind === 'color') el.value = normHex(v) || '#000000';
      else if (kind === 'hex') el.value = normHex(v) || '';
      else if (kind === 'str') el.value = v ?? '';
      else {
        const scale = Number(el.dataset.scale || 1);
        const dec = Number(el.dataset.dec || 0);
        v = Number(v || 0) * scale;
        el.value = el.type === 'number' ? String(Math.round(v * 10 ** dec) / 10 ** dec) : String(v);
      }
    }
  }

  onInput(e, commit) {
    const el = e.target;
    const path = el.dataset.path || el.dataset.ppath;
    if (!path) return;
    const isProject = el.hasAttribute('data-ppath');
    const c = this.target();
    if (!isProject && !c) return;
    const kind = el.dataset.kind;
    let value;
    if (kind === 'bool') value = el.checked;
    else if (kind === 'color') value = el.value;
    else if (kind === 'hex') { value = normHex(el.value); if (!value) return; }
    else if (kind === 'str') value = el.value;
    else {
      const n = parseFloat(el.value);
      if (!Number.isFinite(n)) return;
      value = n / Number(el.dataset.scale || 1);
    }
    store.live((P) => {
      const obj = isProject ? P : store.clip(c.id);
      if (!obj) return;
      if (!isProject && obj.keyframes?.length && KF_PROPS.includes(path)) upsertKeyframe(obj, this.engine.time - obj.start, { [path]: value });
      else if (path === 'speed') setSpeed(P, obj, value);
      else if (path === 'solid.gradient') obj.solid.color2 = value ? (obj.solid.color2 || '#6c5cff') : null;
      else if (path === 'text.content') { setPath(obj, path, value); obj.name = String(value).split('\n')[0].slice(0, 40); }
      else if (path === 'name' && isProject) P.name = value;
      else setPath(obj, path, value);
    });
    // mirror paired controls (range <-> number)
    for (const other of this.root.querySelectorAll(`[data-${isProject ? 'ppath' : 'path'}="${path}"]`)) {
      if (other !== el && other.dataset.kind === el.dataset.kind) other.value = el.value;
      if (other !== el && (kind === 'color' || kind === 'hex') && (other.dataset.kind === 'color' || other.dataset.kind === 'hex')) other.value = normHex(value) || other.value;
    }
    this.engine.requestRender();
    if (commit) {
      store.commitLive('Ubah properti');
      if (isProject && path === 'name') store.emit('rename');
    }
  }

  onClick(e) {
    const c = this.target();
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.tab && c) { this.tab[c.type] = d.tab; this.render(); return; }
    if (d.animtab) { this.animTab = d.animtab; this.render(); return; }
    if (d.open) { actions.app.library?.open(d.open); return; }
    if (d.aspect) { setAspect(d.aspect); return; }
    if (d.fps) { store.mutate('FPS', (P) => { P.fps = Number(d.fps); }); return; }
    if (d.bgmode) { store.mutate('Latar', (P) => { P.background.mode = d.bgmode; }); return; }
    if (!c) return;
    const mut = (label, fn) => store.mutate(label, () => fn(store.clip(c.id)));
    if (d.anim) {
      mut('Animasi', (x) => { x[d.key] = { ...(x[d.key] || {}), type: d.anim, ...(d.key !== 'animLoop' && !x[d.key]?.duration ? { duration: 0.5 } : {}) }; });
      this.previewAnim(c, d.key);
      return;
    }
    if (d.speed) { mut('Kecepatan', (x) => setSpeed(store.P, x, Number(d.speed))); return; }
    if (d.preset) {
      mut('Gaya teks', (x) => {
        const content = x.text.content;
        const size = x.text.size;
        const base = presetStyle(d.preset);
        x.text = deepMerge(base, { content });
        if (!TEXT_PRESETS.find((p) => p.id === d.preset)?.style.size) x.text.size = size;
      });
      return;
    }
    if (d.align) { mut('Rata', (x) => { x.text.align = d.align; }); return; }
    if (d.effect) { mut('Efek', (x) => { x.effect.type = d.effect; x.name = EFFECTS.find((f) => f.id === d.effect)?.name || x.name; }); return; }
    switch (d.do) {
      case 'flipH': mut('Cermin', (x) => { x.flipH = !x.flipH; }); break;
      case 'flipV': mut('Balik', (x) => { x.flipV = !x.flipV; }); break;
      case 'resetTransform': mut('Reset', (x) => Object.assign(x, { x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false })); break;
      case 'fill': {
        const P = store.P;
        const m = store.media(c.mediaId);
        if (!m?.width) break;
        const cr = c.crop;
        const sw = m.width * (1 - cr.l - cr.r);
        const sh = m.height * (1 - cr.t - cr.b);
        const fit = Math.min(P.width / sw, P.height / sh);
        const cover = Math.max(P.width / sw, P.height / sh);
        mut('Isi layar', (x) => Object.assign(x, { scale: cover / fit, x: 0, y: 0 }));
        break;
      }
      case 'fit': mut('Sesuaikan', (x) => Object.assign(x, { scale: 1, x: 0, y: 0 })); break;
      case 'kf': {
        const local = this.engine.time - c.start;
        if (local < 0 || local > c.duration) { actions.app.toast?.('Letakkan playhead di dalam klip untuk menambah keyframe', { type: 'warn' }); break; }
        mut('Keyframe', (x) => { if (!removeKeyframe(x, local)) upsertKeyframe(x, local); });
        break;
      }
      case 'kfPrev':
      case 'kfNext': {
        const local = this.engine.time - c.start;
        const ks = (c.keyframes || []).map((k) => k.t);
        const target = d.do === 'kfPrev' ? ks.filter((t) => t < local - 1e-3).pop() : ks.find((t) => t > local + 1e-3);
        if (target != null) { this.engine.pause(); this.engine.seek(c.start + target); this.render(); }
        break;
      }
      case 'resetAdjust': mut('Reset penyesuaian', (x) => { for (const a of ADJUSTMENTS) x.adjust[a.id] = 0; }); break;
      case 'bold': mut('Tebal', (x) => { x.text.weight = x.text.weight >= 600 ? 400 : 700; }); break;
      case 'italic': mut('Miring', (x) => { x.text.italic = !x.text.italic; }); break;
      case 'extract': actions.extractAudio(c.id); break;
      default: break;
    }
  }

  previewAnim(c, key) {
    const E = this.engine;
    const start = key === 'animOut' ? Math.max(c.start, c.start + c.duration - (c.animOut?.duration || 0.5) - 0.2) : c.start;
    const end = key === 'animIn' ? Math.min(c.start + c.duration, c.start + (c.animIn?.duration || 0.5) + 0.4) : c.start + c.duration - 0.01;
    E.seek(start);
    E.play();
    const stopAt = Math.min(end, key === 'animLoop' ? c.start + Math.min(c.duration, 2.5) : end);
    const off = E.on((kind) => { if (kind === 'time' && E.time >= stopAt) { E.pause(); off(); } if (kind === 'pause') off(); });
  }

  focusPrimary() {
    const ta = this.root.querySelector('.text-input');
    if (ta) { ta.focus(); ta.select(); }
  }
}

export { MIN_CLIP, clamp, clone };
