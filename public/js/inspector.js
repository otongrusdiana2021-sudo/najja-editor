// Clip properties, shown one section at a time inside a bottom sheet (Volume, Animasi, Kecepatan, Pangkas,
// Transformasi, Campuran, Sesuaikan, Teks…). Edits the selected clip, or the project for the 'project' section.
import { store, setSpeed, KF_PROPS, kfValue, upsertKeyframe, keyframeAt, subtitleTrackOf, subtitlesMatch } from './store.js';
import {
  ADJUSTMENTS, BLEND_MODES, ANIM_IN, ANIM_OUT, ANIM_LOOP, FONTS, TEXT_PRESETS, EFFECTS, FPS_OPTIONS,
} from './presets.js';
import { icon } from './icons.js';
import { toast } from './ui.js';
import { escapeHtml, getPath, setPath, clamp, fmtSec, normHex, deepMerge, clone } from './util.js';
import { presetStyle } from './actions.js';
import { favs, star, onStar } from './favs.js';
import { startPreviews } from './previews.js';
import { startBgRemove, redoBgRemove, cancelBgRemove, bgStatus, bgStale, onBgProgress } from './bgremove.js';
import * as actions from './actions.js';
import { KINETIC, KINETIC_GROUPS, SPRINGS, kineticById, makeMotion } from './kinetic.js';

const sec = (title, body, extra = '') => `<section class="isec">${title ? `<div class="isec-head"><span>${title}</span>${extra}</div>` : ''}<div class="isec-body">${body}</div></section>`;

function slider(label, path, min, max, step = 1, { scale = 1, unit = '', decimals = 0 } = {}) {
  return `<div class="ctl"><label>${label}</label><div class="ctl-row">
    <input type="range" data-path="${path}" data-scale="${scale}" min="${min}" max="${max}" step="${step}">
    <span class="num"><input type="number" inputmode="decimal" data-path="${path}" data-scale="${scale}" min="${min}" max="${max}" step="${step}" data-dec="${decimals}">${unit ? `<em>${unit}</em>` : ''}</span>
  </div></div>`;
}
const color = (label, path) => `<div class="ctl ctl-inline"><label>${label}</label><span class="color-in"><input type="color" data-path="${path}" data-kind="color"><input type="text" data-path="${path}" data-kind="hex" maxlength="7" spellcheck="false"></span></div>`;
const toggle = (label, path) => `<label class="switch-row"><span>${label}</span><input type="checkbox" class="switch" data-path="${path}" data-kind="bool"></label>`;
const select = (label, path, options) => `<div class="ctl ctl-inline"><label>${label}</label><select data-path="${path}" data-kind="str">${options.map(([v, n]) => `<option value="${escapeHtml(v)}">${escapeHtml(n)}</option>`).join('')}</select></div>`;

const TEXT_TABS = [['style', 'Gaya'], ['font', 'Font'], ['color', 'Warna'], ['anim', 'Animasi']];
const SWATCHES = ['#ffffff', '#000000', '#ffe600', '#f8f8a8', '#ff2d55', '#ff7a1a', '#22c55e', '#47c9d7', '#3b82f6', '#a855f7', '#ff5fa8', '#8b5a2b'];
const FONT_CATS = ['Populer', 'Dasar', 'Tebal', 'Serif', 'Tulisan tangan'];

export class Inspector {
  constructor(engine) {
    this.engine = engine;
    this.root = null;
    this.section = null;
    this.animTab = 'in';
    this.textTab = 'style';
    this.onInputH = (e) => this.onInput(e, false);
    this.onChangeH = (e) => this.onInput(e, true);
    this.onClickH = (e) => this.onClick(e);
    // A redraw between a finger going down and the tap completing would swallow the tap (e.g. touching a tab
    // blurs the text box, which saves and redraws). Redraws wait until the finger is lifted.
    this.onDownH = () => { this.holding = true; };
    this.onUpH = () => setTimeout(() => {
      this.holding = false;
      if (this.pending) { this.pending = false; this.render(); }
    }, 0);
    window.addEventListener('pointerup', this.onUpH);
    window.addEventListener('pointercancel', this.onUpH);
    store.on('project', () => { if (this.root) this.render(); });
    store.on('transform', () => this.syncValues());
    onBgProgress((clipId) => { if (this.root && this.section === 'chroma' && (!clipId || store.selection === clipId)) this.render(); });
    store.on('live', () => this.syncValues());
    engine.on((k) => { if (k === 'time' && this.root && !engine.playing && store.selected()?.keyframes?.length) this.syncValues(true); });
  }

  /** Show one section inside `el`. Returns a function that removes it. */
  mount(el, section, { tab } = {}) {
    this.unmount();
    this.root = el;
    this.section = section;
    if (tab && TEXT_TABS.some(([id]) => id === tab)) this.textTab = tab;
    el.addEventListener('input', this.onInputH);
    el.addEventListener('change', this.onChangeH);
    el.addEventListener('click', this.onClickH);
    el.addEventListener('pointerdown', this.onDownH, true);
    this.render();
    return () => this.unmount(el);
  }
  unmount(el = this.root) {
    if (!el) return;
    el.removeEventListener('input', this.onInputH);
    el.removeEventListener('change', this.onChangeH);
    el.removeEventListener('click', this.onClickH);
    el.removeEventListener('pointerdown', this.onDownH, true);
    if (this.root === el) { this.root = null; this.section = null; this.holding = false; this.pending = false; }
  }

  target() { return store.selected(); }

  render(force = false) {
    if (!this.root) return;
    if (!force && this.holding) { this.pending = true; return; }
    const ae = document.activeElement;
    if (!force && this.root.contains(ae) && ae.matches('textarea, input[type="text"], input[type="number"]') && store._live) return;
    if (this.section === 'project') { this.root.innerHTML = this.projectPanel(); this.syncValues(true); return; }
    const c = this.target();
    if (!c) { this.root.innerHTML = '<p class="hint pad">Pilih klip dulu.</p>'; return; }
    let body = '';
    switch (this.section) {
      case 'transform': body = this.transformSection(c, { fit: c.type === 'video' || c.type === 'image' }); break;
      case 'blend': body = sec('', `${slider('Opasitas', 'opacity', 0, 100, 1, { scale: 100, unit: '%' })}${select('Mode campuran', 'blend', BLEND_MODES.map((b) => [b.id, b.name]))}`); break;
      case 'crop': body = this.cropPanel(c); break;
      case 'layer': body = this.layerPanel(c); break;
      case 'chroma': body = this.chromaPanel(c); break;
      case 'anim': body = this.animPanel(c); break;
      case 'adjust': body = this.adjustPanel(); break;
      case 'speed': body = this.speedPanel(c); break;
      case 'volume': body = this.volumePanel(c); break;
      case 'text': body = this.textPanel(c); break;
      case 'sticker': body = this.stickerPanel(c); break;
      case 'effect': body = this.effectPanel(c); break;
      case 'clipfx': body = this.clipFxPanel(c); break;
      case 'solid': body = sec('', `${color('Warna', 'solid.color')}${toggle('Gradien', 'solid.gradient')}${c.solid?.color2 ? `${color('Warna 2', 'solid.color2')}${slider('Sudut', 'solid.angle', 0, 360, 1, { unit: '°' })}` : ''}`); break;
      default: break;
    }
    if (['text', 'transform', 'anim', 'blend'].includes(this.section)) body = this.linkRow(c) + body;
    this.root.innerHTML = `<div class="insp-body sec-${this.section}" data-type="${c.type}">${body}</div>`;
    this.syncValues(true);
    startPreviews(this.root); // live previews of the animations, where the section has them (previews.js)
  }

  /** On a subtitle line: the switch that makes a change to one line a change to all of them (store.js, linked subtitles). */
  linkRow(c) {
    const tr = subtitleTrackOf(store.P, c);
    if (!tr) return '';
    const n = store.P.clips.filter((x) => x.trackId === tr.id && x.type === 'text').length;
    if (n < 2) return '';
    const on = tr.linked !== false;
    const same = on ? subtitlesMatch(store.P, c) : true;
    return `<div class="sub-link ${on ? 'on' : ''}">
      <label class="switch-row"><span>${icon('subtitle', 15)} Terapkan ke semua subtitle <em>${n} baris</em></span><input type="checkbox" class="switch" data-do="subLink" ${on ? 'checked' : ''}></label>
      <p class="hint">${on ? 'Skala, posisi, ukuran, font, warna, dan animasi satu subtitle berlaku untuk semua subtitle. Teks dan waktunya tetap masing-masing.' : 'Mati: setiap subtitle diatur sendiri-sendiri.'}</p>
      ${same ? '' : `<button class="btn sm" data-do="subMatch">Samakan semua dengan subtitle ini</button>`}
    </div>`;
  }

  // ---------------------------------------------------------------------------------------------
  transformSection(c, { fit = false } = {}) {
    const local = this.engine.time - c.start;
    const has = !!keyframeAt(c, local);
    const n = c.keyframes?.length || 0;
    const kfBtn = `<span class="kf-ctl">${n ? '<button class="kf-nav" data-do="kfPrev" title="Keyframe sebelumnya">‹</button>' : ''}<button class="kf-btn ${has ? 'on' : ''}" data-do="kf" title="${has ? 'Hapus' : 'Tambah'} keyframe di playhead">◆</button>${n ? `<button class="kf-nav" data-do="kfNext" title="Keyframe berikutnya">›</button><em>${n}</em>` : ''}</span>`;
    return sec('Posisi & ukuran', `
      ${slider('Skala', 'scale', 1, 400, 1, { scale: 100, unit: '%' })}
      <div class="ctl-2">
        <div class="ctl"><label>Posisi X</label><span class="num wide"><input type="number" inputmode="decimal" data-path="x" data-scale="${store.P.width}" step="1"><em>px</em></span></div>
        <div class="ctl"><label>Posisi Y</label><span class="num wide"><input type="number" inputmode="decimal" data-path="y" data-scale="${store.P.height}" step="1"><em>px</em></span></div>
      </div>
      ${slider('Rotasi', 'rotation', -180, 180, 1, { unit: '°' })}
      <div class="btn-row">
        ${fit ? `<button class="btn sm" data-do="fill">${icon('fit', 14)} Isi layar</button><button class="btn sm" data-do="fit">Sesuaikan</button>` : ''}
        <button class="btn sm" data-do="rot90">${icon('rotate', 14)} Putar 90°</button>
        <button class="btn sm icon-only" data-do="flipH" title="Cermin horizontal">${icon('flipH', 15)}</button>
        <button class="btn sm icon-only" data-do="flipV" title="Balik vertikal">${icon('flipV', 15)}</button>
        <button class="btn sm ghost" data-do="resetTransform">Reset</button>
      </div>
      <p class="hint">Geser klip langsung di layar pratinjau; cubit dengan dua jari untuk memperbesar atau memutar.${n ? ' Keyframe aktif: ubah posisi/skala/rotasi/opasitas di waktu lain untuk membuat gerakan.' : ''}</p>`, kfBtn);
  }

  cropPanel() {
    return sec('', `<div class="ctl-2">${slider('Kiri', 'crop.l', 0, 90, 1, { scale: 100, unit: '%' })}${slider('Kanan', 'crop.r', 0, 90, 1, { scale: 100, unit: '%' })}</div>
      <div class="ctl-2">${slider('Atas', 'crop.t', 0, 90, 1, { scale: 100, unit: '%' })}${slider('Bawah', 'crop.b', 0, 90, 1, { scale: 100, unit: '%' })}</div>
      <div class="btn-row"><button class="btn sm ghost" data-do="resetCrop">Reset pangkas</button></div>`);
  }

  /** "Lapisan": the clip's place among the clips it overlaps (front/back), like a layer list. */
  layerPanel(c) {
    const info = actions.layerInfo(c.id);
    if (!info) return '<p class="hint pad">Klip di track utama selalu paling bawah. Pindahkan ke Overlay untuk mengatur lapisannya.</p>';
    const top = info.index === info.count;
    const bottom = info.index === 1;
    const b = (doId, ic, label, off) => `<button class="layer-btn" data-do="${doId}" ${off ? 'disabled' : ''}>${icon(ic, 18)}<span>${label}</span></button>`;
    const fx = c.type === 'effect';
    const what = fx ? (c.effect?.type === 'adjust' ? 'Lapisan ini' : 'Efek ini') : '';
    const fxNote = fx ? `<p class="hint">${what} hanya mengenai lapisan <b>di bawahnya</b>${info.count > 1 ? (top ? ' — sekarang semua lapisan kena.' : '. Lapisan di atasnya (misalnya teks atau stiker) tetap seperti aslinya.') : '.'}</p>` : '';
    return `${sec('', `${fxNote}<p class="layer-pos">${info.count > 1 ? `Lapisan <b>${info.index}</b> dari ${info.count} <span class="hint">(1 = paling belakang)</span>` : '<span class="hint">Tidak ada klip lain yang tumpang tindih di waktu ini.</span>'}</p>
      <div class="layer-grid">${b('layerFront', 'layers', 'Paling depan', top)}${b('layerUp', 'chevronUp', 'Maju', top)}${b('layerDown', 'chevronDown', 'Mundur', bottom)}${b('layerBack', 'layers', 'Paling belakang', bottom)}</div>`)}`;
  }

  chromaPanel(c) {
    // (v1.11) "Hapus latar otomatis", like a phone editor's: one switch, the background goes and every object in
    // front stays; the clip is analysed once (on this device's GPU, or on the server) — bgremove.js
    const cut = c.cutout || {};
    const on = !!cut.enabled;
    const st = on ? bgStatus(c) : null;
    let state = '';
    if (this.bgBusy) state = `<p class="hint">${escapeHtml(this.bgBusy)}</p>`;
    else if (st?.state === 'running') {
      const pct = Math.round((st.p || 0) * 100);
      const eta = st.eta != null ? ` · sisa ±${st.eta >= 90 ? `${Math.round(st.eta / 60)} mnt` : `${st.eta} dtk`}` : '';
      const what = st.retrying ? `Mencoba lagi (${st.retrying})…`
        : st.stage === 'model' ? `Mengunduh model AI ke perangkat ini (sekali saja) · ${pct}%`
          : st.stage === 'init' ? 'Menyiapkan AI di GPU…'
            : st.stage === 'upload' ? `Menunggu video selesai diunggah ke server · ${pct}%`
              : st.stage === 'save' ? 'Menyimpan hasil…'
                : st.stage === 'download' ? 'Mengunduh model AI ke server (sekali saja)…'
                  : st.stage === 'queued' ? 'Menunggu giliran di server…'
                    : st.stage === 'prepare' ? 'Menyiapkan frame video di server…'
                      : `Menganalisis video${st.frame ? ` · frame ${st.frame}/${st.frames}` : ''}${eta} · ${pct}%`;
      state = `<div class="ac-prog cut-prog"><div class="ai-bar"><i style="width:${Math.max(3, st.stage === 'model' || st.stage === 'frames' ? pct : 4)}%"></i></div><span>${escapeHtml(what)}</span><button class="btn sm ghost" data-do="cutCancel">Batal</button></div>
        <p class="hint">${st.engine === 'device' ? 'Diproses di GPU perangkat ini (cepat). Hasilnya disimpan di server Najja supaya ekspor dan perangkat lain langsung memakainya.' : 'Diproses di server Najja karena GPU perangkat ini tidak bisa dipakai (butuh browser dengan WebGPU), jadi bisa beberapa menit. Boleh sambil mengedit atau menutup lembar ini.'}</p>`;
    } else if (st?.state === 'error') {
      state = `<p class="hint warn">${escapeHtml(st.error || 'Analisis berhenti')}</p><button class="btn sm" data-do="cutRedo">Coba lagi</button>`;
    } else if (on && cut.masks) {
      state = `<p class="hint ok">✓ Latar dihapus · ${cut.masks.n} frame dianalisis</p>`;
      if (bgStale(c)) state += `<p class="hint warn">Klip ini sekarang memakai bagian video yang belum dianalisis (dipotong/diperpanjang setelahnya).</p><button class="btn sm" data-do="cutRedo">Analisis ulang</button>`;
    } else if (on) {
      state = `<p class="hint">Klip ini belum dianalisis.</p><button class="btn sm" data-do="cutStart">Analisis sekarang</button>`;
    }
    const auto = sec('', `<label class="switch-row cut-row"><span class="cut-title">${icon('bgRemove', 20)}<span><b>Hapus latar otomatis</b><em>Latar hilang, semua objek di depan tetap: orang, produk, tas, hewan.</em></span></span><input type="checkbox" class="switch" data-do="cutout" ${on ? 'checked' : ''} ${this.bgBusy ? 'disabled' : ''}></label>
      ${state}
      ${on && cut.masks ? `${slider('Ketelitian', 'cutout.threshold', 10, 90, 1, { scale: 100, unit: '%' })}${slider('Tepi halus', 'cutout.edge', 0, 60, 1, { scale: 100, unit: '%' })}` : ''}
      ${on && c.trackId === 'main' ? `<p class="hint">Klip ini di track utama, jadi latarnya diganti warna latar proyek. Pindahkan ke Overlay supaya bisa ditaruh di atas video atau foto lain.</p><button class="btn sm" data-do="cutToOverlay">${icon('toOverlay', 14)} Pindah ke Overlay</button>` : ''}`);
    return `${auto}${sec('Kunci kroma (layar hijau/biru)', `${toggle('Hapus warna latar', 'chroma.enabled')}${c.chroma?.enabled ? `${color('Warna kunci', 'chroma.color')}${slider('Kemiripan', 'chroma.similarity', 0, 100, 1, { scale: 100, unit: '%' })}${slider('Kehalusan', 'chroma.smoothness', 0, 100, 1, { scale: 100, unit: '%' })}` : ''}`)}`;
  }

  animPanel(c) {
    if (this.animTab === 'kin' && c.type !== 'text') this.animTab = 'in';
    const tabs = `<div class="seg wide">${[['in', 'Masuk', 'animIn'], ['out', 'Keluar', 'animOut'], ['loop', 'Kombo', 'animLoop'], ...(c.type === 'text' ? [['kin', 'Kinetik', null]] : [])].map(([id, n, k]) => {
      const set = k ? c[k]?.type && c[k].type !== 'none' : !!c.text?.motion?.type;
      return `<button class="${this.animTab === id ? 'on' : ''}" data-animtab="${id}">${n}${set ? ' •' : ''}</button>`;
    }).join('')}</div>`;
    if (this.animTab === 'kin') return tabs + this.kineticPanel(c);
    const lists = { in: ANIM_IN, out: ANIM_OUT, loop: ANIM_LOOP };
    const keys = { in: 'animIn', out: 'animOut', loop: 'animLoop' };
    const key = keys[this.animTab];
    const cur = c[key]?.type || 'none';
    // favourites first (★), then the rest in their usual order
    const all = lists[this.animTab].filter((a) => c.type === 'text' || a.id !== 'typewriter');
    const favKind = `anim-${this.animTab}`;
    const fav = favs.pick(favKind, all);
    const items = [...fav, ...all.filter((a) => !fav.includes(a))];
    return `
      ${tabs}
      <div class="anim-grid">${items.map((a) => `<button class="anim-chip ${cur === a.id ? 'on' : ''}" data-anim="${a.id}" data-key="${key}"><canvas class="anim-prev" data-prev="${this.animTab}:${a.id}" data-target="${c.type === 'text' ? 'text' : 'visual'}" width="128" height="80"></canvas><span>${a.name}</span>${a.id !== 'none' ? star(favKind, a.id) : ''}</button>`).join('')}</div>
      ${cur !== 'none' ? (this.animTab === 'loop'
        ? slider('Kecepatan', 'animLoop.speed', 0.25, 4, 0.05, { unit: 'x', decimals: 2 })
        : slider('Durasi', `${key}.duration`, 0.1, Math.max(0.2, Math.min(5, c.duration)), 0.1, { unit: 's', decimals: 1 })) : ''}`;
  }

  /** (v1.12) Teks kinetik: words / letters that move on their own, with spring motion (kinetic.js). */
  kineticPanel(c) {
    const m = c.text?.motion || null;
    const cur = m?.type || 'none';
    const k = kineticById(cur);
    const chip = (a) => `<button class="anim-chip ${cur === a.id ? 'on' : ''}" data-kin="${a.id}"><canvas class="anim-prev" data-prev="kin:${a.id}" data-target="text" width="128" height="80"></canvas><span>${a.name}</span>${a.id !== 'none' ? star('kin', a.id) : ''}</button>`;
    const fav = favs.pick('kin', KINETIC.filter((a) => a.id !== 'none'));
    const groups = [
      ...(fav.length ? [['★ Favorit', fav]] : []),
      ...KINETIC_GROUPS.map(([g, name], i) => [name, [...(i === 0 ? [KINETIC[0]] : []), ...KINETIC.filter((a) => a.group === g)]]),
    ];
    const timed = Array.isArray(c.text?.words) && c.text.words.length > 0;
    let ctl = '';
    if (k && k.id !== 'none') {
      if (k.spring) ctl += `<div class="ctl"><label>Gaya gerak</label><div class="chip-row">${Object.entries(SPRINGS).map(([id, sp]) => `<button class="chip ${m.spring === id ? 'on' : ''}" data-kspring="${id}">${sp.name}</button>`).join('')}</div></div>`;
      if (k.stagger != null) ctl += slider(k.unit === 'char' ? 'Jeda antar huruf' : k.unit === 'line' ? 'Jeda antar baris' : 'Jeda antar kata', 'text.motion.stagger', 0.01, 0.5, 0.005, { unit: 's', decimals: 3 });
      ctl += slider('Kecepatan', 'text.motion.speed', 0.25, 3, 0.05, { unit: 'x', decimals: 2 });
      if (k.color) ctl += color('Warna sorot', 'text.motion.color');
      if (k.group === 'in') ctl += `<div class="ctl"><label>Keluar</label><div class="seg">${[['none', 'Tetap'], ['reverse', 'Kebalikan']].map(([id, n]) => `<button class="${(m.out || 'none') === id ? 'on' : ''}" data-kout="${id}">${n}</button>`).join('')}</div></div>`;
      if (timed && (k.unit === 'word' || k.unit === 'char') && (k.group === 'in' || k.id === 'karaoke')) ctl += '<p class="hint ok">Subtitle otomatis: tiap kata bergerak tepat saat diucapkan.</p>';
      else if (k.group === 'in') ctl += '<p class="hint">Kata/huruf masuk bergantian; kalau klipnya pendek, jedanya dirapatkan supaya semua masuk.</p>';
    }
    return `
      <p class="hint">Teks bergerak per kata, per huruf, atau per baris dengan gerak pegas. Bisa digabung dengan animasi Masuk/Keluar/Kombo klip.</p>
      ${ctl ? `<div class="kin-ctl">${ctl}</div>` : ''}
      ${groups.map(([name, list]) => `${name ? `<h5 class="kin-h">${name}</h5>` : ''}<div class="anim-grid">${list.map(chip).join('')}</div>`).join('')}`;
  }

  adjustPanel() {
    return sec('', ADJUSTMENTS.map((a) => slider(a.name, `adjust.${a.id}`, a.min, a.max, 1)).join(''), '');
  }

  speedPanel(c) {
    const presets = [0.25, 0.5, 1, 1.5, 2, 3, 5];
    return sec('', `
      <div class="chip-row">${presets.map((s) => `<button class="chip ${Math.abs((c.speed || 1) - s) < 0.001 ? 'on' : ''}" data-speed="${s}">${s}x</button>`).join('')}</div>
      ${slider('Kecepatan', 'speed', 0.1, 10, 0.05, { unit: 'x', decimals: 2 })}
      <p class="hint">Durasi: <b>${fmtSec(c.duration)}</b> · Sumber: ${fmtSec(c.duration * (c.speed || 1))}</p>`);
  }

  volumePanel(c) {
    return `${sec('', `
      ${slider('Volume', 'volume', 0, 200, 1, { scale: 100, unit: '%' })}
      ${slider('Fade in', 'fadeIn', 0, Math.min(10, c.duration / 2), 0.1, { unit: 's', decimals: 1 })}
      ${slider('Fade out', 'fadeOut', 0, Math.min(10, c.duration / 2), 0.1, { unit: 's', decimals: 1 })}
      ${toggle('Bisukan klip ini', 'muted')}`)}
      ${sec('Suara', `${toggle('Kurangi kebisingan', 'voice.denoise')}<p class="hint">Menghilangkan desis, dengung, kipas/AC, dan bising jalan yang terus-menerus; suara orang tetap.</p>
        ${toggle('Sempurnakan suara', 'voice.enhance')}<p class="hint">Suara lebih jelas dan rata: dengung rendah dipotong, kejernihan dinaikkan, volume diratakan.</p>`)}`;
  }

  textPanel(c) {
    const t = c.text;
    let tab = '';
    switch (this.textTab) {
      case 'font':
        tab = `<div class="fmt-row">
            <button class="btn sm icon-only ${t.weight >= 600 ? 'on' : ''}" data-do="bold" title="Tebal"><b>B</b></button>
            <button class="btn sm icon-only ${t.italic ? 'on' : ''}" data-do="italic" title="Miring"><i>I</i></button>
            <div class="seg">${['left', 'center', 'right'].map((a) => `<button class="${t.align === a ? 'on' : ''}" data-align="${a}" title="Rata ${a === 'left' ? 'kiri' : a === 'right' ? 'kanan' : 'tengah'}">${a === 'left' ? '⇤' : a === 'right' ? '⇥' : '↔'}</button>`).join('')}</div>
          </div>
          ${slider('Ukuran', 'text.size', 8, 400, 1, { unit: 'px' })}
          ${['★ Favorit', ...FONT_CATS].map((cat) => {
            const list = cat === '★ Favorit' ? favs.pick('font', FONTS, (f) => f.name) : FONTS.filter((f) => (f.cat || 'Dasar') === cat);
            return list.length ? `<div class="font-cat"><h5>${cat}</h5><div class="font-grid">${list.map((f) => `<button class="font-item ${t.font === f.name ? 'on' : ''}" data-font="${escapeHtml(f.name)}" style="font-family:'${f.name}'">${escapeHtml(f.label || f.name)}${star('font', f.name)}</button>`).join('')}</div></div>` : '';
          }).join('')}`;
        break;
      case 'color':
        tab = `${sec('Warna teks', `<div class="swatch-row">${SWATCHES.map((s) => `<button class="sw ${normHex(t.color) === s ? 'on' : ''}" data-swatch="${s}" style="background:${s}" title="${s}"></button>`).join('')}</div>${color('Lainnya', 'text.color')}${slider('Opasitas', 'opacity', 0, 100, 1, { scale: 100, unit: '%' })}`)}
          ${sec('Garis tepi', `${toggle('Aktif', 'text.stroke.enabled')}${t.stroke.enabled ? `${color('Warna', 'text.stroke.color')}${slider('Tebal', 'text.stroke.width', 1, 40, 1)}` : ''}`)}
          ${sec('Latar', `${toggle('Aktif', 'text.bg.enabled')}${t.bg.enabled ? `${color('Warna', 'text.bg.color')}${slider('Opasitas', 'text.bg.opacity', 0, 100, 1, { scale: 100, unit: '%' })}${slider('Sudut bulat', 'text.bg.radius', 0, 80, 1)}` : ''}`)}
          ${sec('Bayangan', `${toggle('Aktif', 'text.shadow.enabled')}${t.shadow.enabled ? `${color('Warna', 'text.shadow.color')}${slider('Opasitas', 'text.shadow.opacity', 0, 100, 1, { scale: 100, unit: '%' })}${slider('Blur', 'text.shadow.blur', 0, 80, 1)}<div class="ctl-2">${slider('Geser X', 'text.shadow.x', -40, 40, 1)}${slider('Geser Y', 'text.shadow.y', -40, 40, 1)}</div>` : ''}`)}
          ${sec('Gradien', `${toggle('Aktif', 'text.gradient.enabled')}${t.gradient.enabled ? `${color('Dari', 'text.gradient.from')}${color('Ke', 'text.gradient.to')}` : ''}`)}
          ${sec('Spasi', `<div class="ctl-2">${slider('Huruf', 'text.letterSpacing', -10, 60, 1)}${slider('Baris', 'text.lineHeight', 0.6, 3, 0.05, { decimals: 2 })}</div>`)}`;
        break;
      case 'anim':
        tab = this.animPanel(c);
        break;
      default:
        tab = `<div class="preset-grid big">${TEXT_PRESETS.map((p) => `<button class="tp ${t.preset === p.id ? 'on' : ''}" data-preset="${p.id}" title="${p.name}"><span class="tp-prev tp-${p.id}">Aa</span><em>${p.name}</em></button>`).join('')}</div>`;
    }
    return `<textarea class="text-input" data-path="text.content" data-kind="str" rows="2" placeholder="Ketik teks…"></textarea>
      <div class="sub-tabs">${TEXT_TABS.map(([id, n]) => `<button class="${this.textTab === id ? 'on' : ''}" data-texttab="${id}">${n}</button>`).join('')}</div>
      <div class="sub-body">${tab}</div>`;
  }

  stickerPanel(c) {
    const b = c.sticker?.badge;
    return b ? sec('Label', `<div class="ctl"><label>Teks</label><input type="text" data-path="sticker.badge.text" data-kind="str"></div>${color('Latar', 'sticker.badge.bg')}${color('Teks', 'sticker.badge.fg')}`)
      : '<p class="hint pad">Stiker emoji tidak punya pengaturan teks. Atur posisi dan ukuran lewat Transformasi.</p>';
  }

  /** Effects on the footage itself (v1.10.2), or — "Semua lapisan" — on an effect track over the clip's time. */
  clipFxPanel(c) {
    if (!actions.CLIP_FX_TYPES.includes(c.type)) return '<p class="hint pad">Efek klip untuk video, foto, atau warna solid.</p>';
    const toClip = (this.fxTarget || 'clip') === 'clip';
    const applied = c.fx || [];
    const fav = favs.pick('effect', EFFECTS);
    const cats = [...(fav.length ? ['★ Favorit'] : []), 'Semua', ...new Set(EFFECTS.map((e) => e.cat))];
    if (!cats.includes(this.cfxCat)) this.cfxCat = 'Semua';
    const list = this.cfxCat === '★ Favorit' ? fav : EFFECTS.filter((e) => this.cfxCat === 'Semua' || e.cat === this.cfxCat);
    const on = new Set(applied.map((f) => f.type));
    const rows = applied.map((f, i) => {
      const def = EFFECTS.find((e) => e.id === f.type);
      return `<div class="cfx-row"><span class="cfx-name"><i style="--a:${def?.colors[0]};--b:${def?.colors[1]}">${def?.icon || '✦'}</i>${escapeHtml(def?.name || f.type)}</span>
        ${slider('', `fx.${i}.intensity`, 0, 100, 1, { scale: 100, unit: '%' })}<button class="btn sm icon-only ghost" data-do="cfxDel" data-i="${i}" title="Hapus efek ini">${icon('trash', 15)}</button></div>`;
    }).join('');
    return `${sec('', `<div class="ctl ctl-inline"><label>Terapkan ke</label><div class="seg"><button class="${toClip ? 'on' : ''}" data-fxtarget="clip">Klip ini</button><button class="${toClip ? '' : 'on'}" data-fxtarget="all">Semua lapisan</button></div></div>
      <p class="hint">${toClip ? 'Efek menempel di footage ini: hanya klip ini yang kena, dan efeknya ikut saat klip digeser, dipotong, atau diduplikat.' : `Efek ditaruh di track efek selama klip ini (${fmtSec(c.duration)}) dan mengenai semua lapisan di bawahnya.`}</p>
      ${toClip && applied.length ? `<div class="cfx-list">${rows}</div>${c.trackId === 'main' ? '<button class="btn sm" data-do="cfxMain">Terapkan efek ini ke semua klip utama</button>' : ''}` : ''}`)}
      <div class="chip-row">${cats.map((x) => `<button class="chip ${this.cfxCat === x ? 'on' : ''}" data-cfxcat="${x}">${x}</button>`).join('')}</div>
      <div class="tile-grid cfx-grid">${list.map((f) => `<button class="tile fx-tile ${toClip && on.has(f.id) ? 'on' : ''}" data-cfx="${f.id}" style="--a:${f.colors[0]};--b:${f.colors[1]}"><span class="tile-art fx-${f.id}"><b>${f.icon}</b></span><em>${f.name}</em>${toClip && on.has(f.id) ? '<i class="cfx-on">✓</i>' : ''}${star('effect', f.id)}</button>`).join('')}</div>`;
  }

  effectPanel(c) {
    return `${sec('', `<div class="fx-grid">${EFFECTS.map((f) => `<button class="fx-chip ${c.effect.type === f.id ? 'on' : ''}" data-effect="${f.id}" style="--a:${f.colors[0]};--b:${f.colors[1]}"><span>${f.icon}</span>${f.name}</button>`).join('')}</div>`)}
      ${sec('', `${slider('Intensitas', 'effect.intensity', 0, 100, 1, { scale: 100, unit: '%' })}<p class="hint">Efek berlaku untuk lapisan di bawahnya selama ${fmtSec(c.duration)} (atur di Lapisan: taruh di bawah teks supaya teksnya tidak kena).</p>`)}`;
  }

  projectPanel() {
    const P = store.P;
    return `<div class="insp-body project-panel">
      ${sec('Proyek', `<div class="ctl"><label>Nama proyek</label><input type="text" data-ppath="name" data-kind="str" maxlength="80"></div>
        <div class="stats"><div><b>${fmtSec(store.duration())}</b><span>Durasi</span></div><div><b>${P.clips.length}</b><span>Klip</span></div><div><b>${P.media.length}</b><span>Media</span></div><div><b>${P.aspect}</b><span>Rasio</span></div></div>`)}
      ${sec('Latar kanvas', `<div class="seg wide"><button class="${P.background.mode === 'color' ? 'on' : ''}" data-bgmode="color">Warna</button><button class="${P.background.mode === 'blur' ? 'on' : ''}" data-bgmode="blur">Blur</button></div>
        ${P.background.mode === 'blur' ? slider('Kekuatan blur', 'background.blur', 0, 100, 1).replace(/data-path/g, 'data-ppath') : color('Warna', 'background.color').replace(/data-path/g, 'data-ppath')}`)}
      ${sec('Frame rate', `<div class="chip-row">${FPS_OPTIONS.map((f) => `<button class="chip ${P.fps === f ? 'on' : ''}" data-fps="${f}">${f} fps</button>`).join('')}</div>`)}
      ${sec('Track utama', `<label class="switch-row"><span>Magnet (klip utama selalu rapat)</span><input type="checkbox" class="switch" data-do="magnet" ${P.magnet ? 'checked' : ''}></label>`)}
    </div>`;
  }

  // ---------------------------------------------------------------------------------------------
  syncValues(force = false) {
    if (!this.root) return;
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
      else if (path === 'solid.gradient') obj.solid.color2 = value ? (obj.solid.color2 || '#47c9d7') : null;
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
      if (kind === 'bool') this.render(); // show/hide the controls that depend on the switch
    }
  }

  onClick(e) {
    if (onStar(e)) { this.render(true); return; }
    const c = this.target();
    const t = e.target.closest('button, input[data-do]');
    if (!t) return;
    const d = t.dataset;
    if (d.animtab || d.texttab) {
      if (this.root.contains(document.activeElement)) document.activeElement.blur(); // commits what was typed
      if (store._live) store.commitLive('Ubah teks');
      if (d.animtab) this.animTab = d.animtab; else this.textTab = d.texttab;
      this.render(true);
      return;
    }
    if (d.fps) { store.mutate('FPS', (P) => { P.fps = Number(d.fps); }); return; }
    if (d.fxtarget) { this.fxTarget = d.fxtarget; this.render(true); return; }
    if (d.cfxcat) { this.cfxCat = d.cfxcat; this.render(true); return; }
    if (d.cfx && c) {
      try {
        if ((this.fxTarget || 'clip') === 'clip') actions.toggleClipEffect(c.id, d.cfx);
        else {
          actions.addEffect({ effect: d.cfx, start: c.start, duration: c.duration });
          store.select(c.id);
          toast('Efek ditaruh di track efek selama klip ini', { type: 'ok' });
        }
      } catch (err) { toast(err.message, { type: 'warn' }); }
      return;
    }
    if (d.do === 'cutout' && c) {
      if (!t.checked) {
        if (bgStatus(c)?.state === 'running') cancelBgRemove(c.id);
        store.mutate('Hapus latar mati', () => { const x = store.clip(c.id); x.cutout = { ...(x.cutout || {}), enabled: false }; });
        return;
      }
      t.checked = false;
      this.runBg(() => startBgRemove(c.id));
      return;
    }
    if (d.do === 'cutStart' && c) { this.runBg(() => startBgRemove(c.id)); return; }
    if (d.do === 'cutRedo' && c) { this.runBg(() => redoBgRemove(c.id)); return; }
    if (d.do === 'cutCancel' && c) { cancelBgRemove(c.id); return; }
    if (d.do === 'cutToOverlay' && c) { actions.moveToOverlay(c.id); toast('Klip dipindah ke Overlay', { type: 'ok' }); return; }
    if (d.do === 'cfxDel' && c) { actions.removeClipEffect(c.id, Number(d.i)); return; }
    if (d.do === 'cfxMain' && c) { const n = actions.clipEffectsToMain(c.id); toast(`Efek diterapkan ke ${n} klip lain di track utama`, { type: 'ok' }); return; }
    if (d.bgmode) { store.mutate('Latar', (P) => { P.background.mode = d.bgmode; }); return; }
    if (d.do === 'magnet') { actions.setMagnet(t.checked); return; }
    if (!c) return;
    if (d.do === 'subLink') { actions.setSubtitleLink(t.checked, c.trackId); return; }
    if (d.do === 'subMatch') { const n = actions.matchSubtitles(c.id); toast(`${n} subtitle disamakan`, { type: 'ok' }); return; }
    const mut = (label, fn) => store.mutate(label, () => fn(store.clip(c.id)));
    if (d.anim) {
      mut('Animasi', (x) => { x[d.key] = { ...(x[d.key] || {}), type: d.anim, ...(d.key !== 'animLoop' && !x[d.key]?.duration ? { duration: 0.5 } : {}) }; });
      this.previewAnim(c, d.key);
      return;
    }
    if (d.kin) {
      mut('Teks kinetik', (x) => {
        const old = x.text.motion || {};
        const m = makeMotion(d.kin, { speed: old.speed, out: old.out, color: old.color });
        if (m) x.text.motion = m; else delete x.text.motion;
      });
      this.render(true);
      if (d.kin !== 'none') this.previewKinetic(store.clip(c.id));
      return;
    }
    if (d.kspring) { mut('Gaya gerak', (x) => { if (x.text.motion) x.text.motion.spring = d.kspring; }); this.render(true); this.previewKinetic(store.clip(c.id)); return; }
    if (d.kout) { mut('Keluar kinetik', (x) => { if (x.text.motion) x.text.motion.out = d.kout; }); this.render(true); return; }
    if (d.speed) { mut('Kecepatan', (x) => setSpeed(store.P, x, Number(d.speed))); return; }
    if (d.preset) {
      mut('Gaya teks', (x) => {
        const content = x.text.content;
        const size = x.text.size;
        const keep = { ...(x.text.motion ? { motion: x.text.motion } : {}), ...(x.text.words ? { words: x.text.words } : {}) };
        const base = presetStyle(d.preset);
        x.text = { ...deepMerge(base, { content }), ...keep };
        if (!TEXT_PRESETS.find((p) => p.id === d.preset)?.style.size) x.text.size = size;
      });
      return;
    }
    if (d.font) { mut('Font', (x) => { x.text.font = d.font; }); return; }
    if (d.swatch) { mut('Warna teks', (x) => { x.text.color = d.swatch; x.text.gradient.enabled = false; }); return; }
    if (d.align) { mut('Rata', (x) => { x.text.align = d.align; }); return; }
    if (d.effect) { mut('Efek', (x) => { x.effect.type = d.effect; x.name = EFFECTS.find((f) => f.id === d.effect)?.name || x.name; }); return; }
    if (d.do && d.do.startsWith('layer') && c) {
      const where = { layerFront: 'front', layerUp: 'up', layerDown: 'down', layerBack: 'back' }[d.do];
      if (where) { actions.moveLayer(c.id, where); this.render(true); return; }
    }
    switch (d.do) {
      case 'flipH': mut('Cermin', (x) => { x.flipH = !x.flipH; }); break;
      case 'flipV': mut('Balik', (x) => { x.flipV = !x.flipV; }); break;
      case 'rot90': mut('Putar', (x) => { x.rotation = ((Math.round((x.rotation || 0) / 90) * 90 + 90 + 180) % 360) - 180; }); break;
      case 'resetTransform': mut('Reset', (x) => Object.assign(x, { x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false })); break;
      case 'resetCrop': mut('Reset pangkas', (x) => { x.crop = { l: 0, t: 0, r: 0, b: 0 }; }); break;
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
      case 'kf': actions.toggleKeyframe(c.id); break;
      case 'kfPrev':
      case 'kfNext': {
        const local = this.engine.time - c.start;
        const ks = (c.keyframes || []).map((k) => k.t);
        const target = d.do === 'kfPrev' ? ks.filter((x) => x < local - 1e-3).pop() : ks.find((x) => x > local + 1e-3);
        if (target != null) { this.engine.pause(); this.engine.seek(c.start + target); this.render(); }
        break;
      }
      case 'bold': mut('Tebal', (x) => { x.text.weight = x.text.weight >= 600 ? 400 : 700; }); break;
      case 'italic': mut('Miring', (x) => { x.text.italic = !x.text.italic; }); break;
      default: break;
    }
  }

  /** Start the background removal (bgremove.js); the analysis itself reports its progress through onBgProgress. */
  async runBg(fn) {
    this.bgBusy = 'Memulai…';
    this.render(true);
    try {
      const p = fn();
      this.bgBusy = null;
      this.render(true);
      await p;
      this.engine.requestRender();
    } catch (err) {
      toast(err.message, { type: 'error', timeout: 7000 });
    } finally {
      this.bgBusy = null;
      this.render(true);
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

  /** Play a text clip from its start (its kinetic animation), up to 3 seconds. */
  previewKinetic(c) {
    if (!c) return;
    const E = this.engine;
    E.seek(c.start);
    E.play();
    const stopAt = c.start + Math.min(c.duration - 0.01, 3);
    const off = E.on((kind) => { if (kind === 'time' && E.time >= stopAt) { E.pause(); off(); } if (kind === 'pause') off(); });
  }

  focusPrimary() {
    const ta = this.root?.querySelector('.text-input');
    if (ta) { ta.focus(); ta.select(); }
  }
}

export { clamp, clone };
