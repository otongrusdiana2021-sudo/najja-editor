// Asset panels for the bottom sheet: music, sound effects, voiceover, text templates, captions, effects, transitions,
// filters and the AI/MCP panel. Media cards are shared with the media picker (sheet.js).
import { store, sortedClips, clipEnd } from './store.js';
import {
  importFile, mediaRT, onMediaChange, removeMedia, ensureStockAudio, synthAudio, importFromServerUrl,
} from './media.js';
import {
  TEXT_PRESETS, TEXT_TEMPLATES, STICKERS, BADGES, EFFECTS, TRANSITIONS, FILTERS, SOLIDS, GRADIENTS, SFX,
} from './presets.js';
import { icon } from './icons.js';
import { escapeHtml, fmtDur, fmtBytes, pickFiles } from './util.js';
import { cssFilterFor } from './render.js';
import { drawFiltered } from './gpufx.js';
import { favs, star, onStar } from './favs.js';
import { startPreviews } from './previews.js';
import { LANGUAGES, SOURCES, LINE_LENGTH, langName, transcribeProject, cuesFromSegments, transcribeStatus } from './captions.js';
import { setDragPayload } from './timeline.js';
import * as actions from './actions.js';
import { toast, modal, confirmDialog } from './ui.js';
import { bridge } from './bridge.js';
import { account } from './account.js';
import { PROMPT_GROUPS, fillPrompt, claudeUrl, parseToolCalls, guideForOtherAi, EXAMPLE_JSON } from './aicmds.js';

const TITLES = {
  music: 'Suara', sfx: 'Efek suara', record: 'Rekam suara', templates: 'Template teks', caption: 'Keterangan',
  effect: 'Efek video', transition: 'Transisi', filter: 'Filter', ai: 'AI · MCP',
};

/** Asset panels (music, sound effects, text templates, captions, effects, transitions, filters, AI), shown in a bottom sheet. */
const tplTile = (t) => `<button class="ttpl" draggable="true" data-template="${t.id}"><span class="tp-prev tp-${t.preset}">${escapeHtml(t.text.split('\n')[0])}</span><em>${t.name}</em>${star('template', t.id)}</button>`;
const styleTile = (p) => `<button class="tstyle" draggable="true" data-text="${p.id}" title="${p.name}"><span class="tp-prev tp-${p.id}">Teks</span><em>${p.name}</em>${star('textstyle', p.id)}</button>`;

export class Library {
  constructor(engine) {
    this.panel = null;
    this.engine = engine;
    this.tab = null;
    this.opts = {};
    this.fxCat = 'Semua';
    this.trDuration = 0.6;
    this.preview = null;
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.multiple = true;
    this.fileInput.accept = 'video/*,image/*,audio/*,.mkv,.mov';
    this.fileInput.onchange = () => { this.importFiles([...this.fileInput.files]); this.fileInput.value = ''; };
    // in the page (hidden): iPadOS may never deliver the choice of a detached input
    this.fileInput.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(this.fileInput);
    this.onClickH = (e) => this.onClick(e);
    this.onInputH = (e) => this.onInput(e);
    this.onDragStartH = (e) => this.onDragStart(e);
    this.onDragEndH = () => setDragPayload(null);
    onMediaChange(() => { if (this.tab === 'music') this.render(); });
    store.on('selection', () => { if (['filter', 'transition'].includes(this.tab)) this.render(); });
    store.on('project', () => { if (['filter', 'transition'].includes(this.tab) && !store._live) this.render(); });
    // (not while a box of the AI panel is being typed in: the redraw would lose the cursor)
    bridge.on(() => {
      if (this.tab !== 'ai') return;
      const a = document.activeElement;
      if (a?.dataset?.aiInput && this.panel?.contains(a)) return;
      this.render();
    });
  }

  static title(tab) { return TITLES[tab] || ''; }

  /** Show one panel inside `el`. Returns a function that removes it. */
  mount(el, tab, opts = {}) {
    this.unmount();
    this.panel = el;
    this.tab = tab;
    this.opts = opts;
    el.addEventListener('click', this.onClickH);
    el.addEventListener('input', this.onInputH);
    el.addEventListener('dragstart', this.onDragStartH);
    el.addEventListener('dragend', this.onDragEndH);
    this.render();
    return () => this.unmount(el);
  }
  unmount(el = this.panel) {
    if (!el) return;
    el.removeEventListener('click', this.onClickH);
    el.removeEventListener('input', this.onInputH);
    el.removeEventListener('dragstart', this.onDragStartH);
    el.removeEventListener('dragend', this.onDragEndH);
    if (this.panel === el) {
      this.panel = null;
      this.tab = null;
      this.opts = {};
      if (this.preview) { this.preview.audio.pause(); this.preview = null; }
    }
  }
  /** Legacy entry point (menus, MCP pill): open a panel in the bottom sheet. */
  open(tab) { actions.app.openSheet?.(tab); }

  render() {
    if (!this.panel) return;
    const fn = {
      music: this.musicPanel, sfx: this.sfxPanel, record: this.recordPanel, templates: this.templatePanel, caption: this.captionPanel,
      effect: this.effectPanel, transition: this.transitionPanel, filter: this.filterPanel, ai: this.aiPanel,
    }[this.tab];
    if (!fn) return;
    this.panel.innerHTML = `<div class="lib-body tab-${this.tab}">${fn.call(this)}</div>`;
    if (this.tab === 'filter' || this.tab === 'transition') this.paintFilterThumbs();
    if (this.tab === 'transition') startPreviews(this.panel); // each tile plays the real transition (previews.js)
    if (this.tab === 'caption') this.wireCaptions();
  }

  /** "★ Favorit" section of a tab (nothing when there are none). */
  favSection(kind, all, tile, gridClass) {
    const list = favs.pick(kind, all);
    if (!list.length) return '';
    const items = list.map(tile).join('');
    return `<div class="lib-section fav-section"><h4>★ Favorit</h4>${gridClass ? `<div class="${gridClass}">${items}</div>` : items}</div>`;
  }

  // ---------------------------------------------------------------------------------------------
  mediaCard(m) {
    const rt = mediaRT.get(m.id) || {};
    const status = rt.status || 'ready';
    const thumb = rt.poster ? `<img src="${rt.poster}" alt="" draggable="false">` : `<div class="mc-ph">${icon(m.type === 'audio' ? 'audio' : m.type === 'image' ? 'image' : 'video', 26)}</div>`;
    const used = store.P.clips.some((c) => c.mediaId === m.id);
    return `<div class="media-card ${status} type-${m.type} ${rt.upload ? 'uploading' : ''}" draggable="${status === 'ready'}" data-media="${m.id}" title="${escapeHtml(m.name)}">
      <div class="mc-thumb">${thumb}
        ${m.type !== 'image' && m.duration ? `<span class="mc-dur">${fmtDur(m.duration)}</span>` : ''}
        ${status === 'processing' && !rt.upload ? '<span class="mc-spin"></span>' : ''}
        ${rt.convert ? `<span class="mc-up conv" title="Server sedang membuat salinan MP4 (H.264) supaya video bisa diputar di semua perangkat"><i style="width:${Math.round((rt.convert.progress || 0) * 100)}%"></i><b>${icon('rotate', 11)} Konversi ${Math.round((rt.convert.progress || 0) * 100)}%</b></span>` : ''}
        ${rt.cache && !rt.convert ? `<span class="mc-up conv" title="Mengunduh video ke perangkat ini sekali, supaya pemutaran dan ekspor lancar"><i style="width:${Math.round((rt.cache.progress || 0) * 100)}%"></i><b>${icon('download', 11)} Memuat ${Math.round((rt.cache.progress || 0) * 100)}%</b></span>` : ''}
        ${rt.playError && !rt.convert ? `<span class="mc-up err" title="${escapeHtml(rt.playError)}"><b>${icon('help', 11)} Tidak bisa diputar</b></span>` : ''}
        ${status === 'missing' ? `<span class="mc-missing">${icon('help', 14)} Hilang</span>` : ''}
        ${rt.upload?.state === 'uploading' ? `<span class="mc-up" title="Mengunggah ke server"><i style="width:${Math.round((rt.upload.progress || 0) * 100)}%"></i><b>${icon('upload', 11)} ${Math.round((rt.upload.progress || 0) * 100)}%</b></span>` : ''}
        ${rt.upload?.state === 'error' ? `<button class="mc-up err" data-retry="${m.id}" title="${escapeHtml(rt.upload.error || '')}"><b>${icon('rotate', 11)} Gagal unggah · coba lagi</b></button>` : ''}
        ${used ? '<span class="mc-used">Dipakai</span>' : ''}
        <button class="mc-add" data-add="${m.id}" title="Tambah ke timeline">${icon('plus', 16)}</button>
        <button class="mc-del" data-del="${m.id}" title="Hapus dari pustaka">${icon('x', 13)}</button>
      </div>
      <div class="mc-name">${escapeHtml(m.name)}</div>
    </div>`;
  }

  audioRow(s) {
    return `<div class="audio-row" draggable="true" data-sfx="${s.id}">
        <button class="ar-play" data-play="${s.id}" title="Dengarkan" aria-label="Dengarkan">${icon(this.preview?.id === s.id ? 'pause' : 'play', 14)}</button>
        <div class="ar-info"><b>${s.name}</b><span>${fmtDur(s.dur)} · ${s.kind === 'music' ? 'Musik' : 'Efek suara'}</span></div>${star('sfx', s.id)}
        <button class="ar-add" data-addsfx="${s.id}" title="Tambah di playhead" aria-label="Tambah">${icon('plus', 16)}</button></div>`;
  }

  musicPanel() {
    const mine = store.P.media.filter((m) => m.type === 'audio' && !m.stock);
    return `
      ${this.favSection('sfx', SFX.filter((s) => s.kind === 'music'), (s) => this.audioRow(s), '')}
      <div class="lib-section"><h4>Musik bawaan</h4>${SFX.filter((s) => s.kind === 'music').map((s) => this.audioRow(s)).join('')}</div>
      <div class="lib-section"><h4>Audio saya <button class="btn sm ghost" data-do="importAudio">${icon('upload', 14)} Impor audio</button></h4>
        ${mine.length ? `<div class="media-grid">${mine.map((m) => this.mediaCard(m)).join('')}</div>` : '<p class="hint">Audio yang kamu impor (MP3, WAV, M4A) muncul di sini. Ketuk untuk menambah di playhead.</p>'}</div>`;
  }

  sfxPanel() {
    return `${this.favSection('sfx', SFX.filter((s) => s.kind === 'sfx'), (s) => this.audioRow(s), '')}<div class="lib-section">${SFX.filter((s) => s.kind === 'sfx').map((s) => this.audioRow(s)).join('')}</div>
      <p class="hint">Ketuk ▶ untuk mendengar, + untuk menaruh di playhead.</p>`;
  }

  recordPanel() {
    return `<div class="rec-card">
        <button class="btn ${this.recorder ? 'btn-danger' : 'btn-primary'} wide big" data-do="record">${icon(this.recorder ? 'pause' : 'mic', 18)} ${this.recorder ? 'Berhenti merekam' : 'Mulai merekam'}</button>
        <span class="hint">${this.recorder ? '<i class="rec-dot"></i> Merekam… timeline ikut diputar' : 'Rekam suara dari mikrofon mulai dari posisi playhead. Hasilnya masuk ke lane audio.'}</span>
      </div>`;
  }

  templatePanel() {
    return `
      ${this.favSection('template', TEXT_TEMPLATES, (t) => tplTile(t), 'ttpl-grid')}
      ${this.favSection('textstyle', TEXT_PRESETS, (p) => styleTile(p), 'tstyle-grid')}
      <div class="lib-section"><h4>Template judul</h4><div class="ttpl-grid">${TEXT_TEMPLATES.map(tplTile).join('')}</div></div>
      <div class="lib-section"><h4>Gaya teks</h4><div class="tstyle-grid">${TEXT_PRESETS.map(styleTile).join('')}</div></div>`;
  }

  /** "Hasilkan keterangan otomatis" (v1.9): auto subtitles from the speech, like a phone editor's; plus script / SRT. */
  captionPanel() {
    const C = this.cap || (this.cap = { from: 'video', lang: 'id', preset: 'subtitle', len: 'medium', pos: '0.36', upper: false, replace: true, open: null, adv: false, q: '' });
    const presets = [{ id: 'subtitle', name: 'Default' }, ...TEXT_PRESETS.filter((p) => !['default', 'subtitle', 'minimal', 'bebas'].includes(p.id))];
    const st = this.capStatus;
    const langs = LANGUAGES.filter(([c, n]) => !C.q || n.toLowerCase().includes(C.q.toLowerCase()) || c.startsWith(C.q.toLowerCase()));
    const row = (key, ic, label, value) => `<button class="ac-row ${C.open === key ? 'open' : ''}" data-capopen="${key}">${icon(ic, 20)}<span>${label}</span><em>${escapeHtml(value)}</em>${icon('chevronRight', 16)}</button>`;
    return `
      <div class="autocap">
        <h3 class="ac-title">Hasilkan keterangan otomatis</h3>
        ${row('from', 'sparkle', 'Hasilkan dari', SOURCES.find(([k]) => k === C.from)[1])}
        ${C.open === 'from' ? `<div class="ac-pick">${SOURCES.map(([k, n]) => `<button class="chip ${C.from === k ? 'on' : ''}" data-capfrom="${k}">${n}</button>`).join('')}</div>` : ''}
        ${row('lang', 'translate', 'Bahasa sumber', langName(C.lang))}
        ${C.open === 'lang' ? `<div class="ac-pick ac-langs"><input class="ac-q" type="search" placeholder="Cari bahasa…" value="${escapeHtml(C.q)}"><div class="ac-lang-list">${langs.map(([c, n]) => `<button class="ac-lang ${C.lang === c ? 'on' : ''}" data-caplang="${c}">${escapeHtml(n)}${c !== 'auto' ? `<small>${c}</small>` : ''}</button>`).join('')}</div></div>` : ''}
        <div class="ac-card"><div class="ac-card-h">${icon('subtitle', 20)}<span>Template</span></div>
          <div class="ac-tpls">${presets.map((p) => `<button class="ac-tpl ${C.preset === p.id ? 'on' : ''}" data-cappreset="${p.id}"><span class="tp-prev tp-${p.id === 'subtitle' ? 'default' : p.id}">${p.id === 'subtitle' ? 'Default' : escapeHtml(p.name)}</span></button>`).join('')}</div></div>
        <button class="ac-row ac-adv ${C.adv ? 'open' : ''}" data-capadv>${icon('settings', 20)}<span>Opsi lanjutan</span>${icon(C.adv ? 'chevronUp' : 'chevronDown', 16)}</button>
        ${C.adv ? `<div class="ac-advbody">
          <div class="ctl ctl-inline"><label>Panjang baris</label><div class="seg">${[['short', 'Pendek'], ['medium', 'Sedang'], ['long', 'Panjang']].map(([k, n]) => `<button class="${C.len === k ? 'on' : ''}" data-caplen="${k}">${n}</button>`).join('')}</div></div>
          <div class="ctl ctl-inline"><label>Posisi</label><div class="seg">${[['0.36', 'Bawah'], ['0', 'Tengah'], ['-0.36', 'Atas']].map(([k, n]) => `<button class="${C.pos === k ? 'on' : ''}" data-cappos="${k}">${n}</button>`).join('')}</div></div>
          <label class="ac-check"><input type="checkbox" data-capupper ${C.upper ? 'checked' : ''}> Huruf kapital semua</label>
          <label class="ac-check"><input type="checkbox" data-capreplace ${C.replace ? 'checked' : ''}> Ganti subtitle yang sudah ada</label>
        </div>` : ''}
        ${this.capBusy ? `<div class="ac-prog"><div class="ai-bar"><i style="width:${Math.max(3, Math.round((this.capBusy.p || 0) * 100))}%"></i></div><span>${escapeHtml(this.capBusy.label || '')}</span><button class="btn sm ghost" data-do="capCancel">Batal</button></div>`
          : `<button class="ac-go" data-do="autoCaptions" ${st && !st.ok ? 'disabled' : ''}>Hasilkan</button>`}
        ${st && !st.ok ? `<p class="hint warn">${escapeHtml(st.reason)}</p>` : st?.state && st.state !== 'ready' ? '<p class="hint">Model suara diunduh ke server saat pertama dipakai (sekali saja).</p>' : ''}
      </div>
      <details class="ac-manual" ${this.capManual ? 'open' : ''}><summary>Buat dari naskah atau file SRT</summary>
      <div class="seg wide"><button class="${(this.capMode || 'script') === 'script' ? 'on' : ''}" data-capmode="script">Naskah</button><button class="${this.capMode === 'srt' ? 'on' : ''}" data-capmode="srt">SRT</button></div>
      <textarea class="cap-input" rows="6" placeholder="${this.capMode === 'srt' ? '1\n00:00:00,000 --> 00:00:02,500\nHalo semuanya!' : 'Tempel naskah di sini. Kalimat akan dibagi rata sepanjang video.'}">${escapeHtml(this.capText || '')}</textarea>
      <div class="btn-row"><button class="btn btn-primary" data-do="makeCaptions">${icon('subtitle', 15)} Buat subtitle</button><button class="btn ghost" data-do="srtFile">${icon('file', 15)} Buka .srt</button></div></details>
      ${store.P.tracks.some((t) => t.subtitle) ? `<label class="ac-check ac-link"><input type="checkbox" data-caplink ${store.P.tracks.some((t) => t.subtitle && t.linked !== false) ? 'checked' : ''}> Ubah satu subtitle, semua ikut <small>(skala, posisi, ukuran, font, warna, animasi)</small></label>
      <button class="btn sm ghost danger" data-do="clearCaptions">${icon('trash', 14)} Hapus semua subtitle</button>` : ''}`;
  }

  /** Caption tab controls that are not buttons; and whether the server can transcribe (checked once a minute). */
  wireCaptions() {
    const C = this.cap;
    const q = this.panel.querySelector('.ac-q');
    if (q) {
      q.oninput = () => {
        C.q = q.value;
        const v = q.value.toLowerCase();
        for (const b of this.panel.querySelectorAll('.ac-lang')) b.hidden = !!v && !b.textContent.toLowerCase().includes(v);
      };
    }
    const up = this.panel.querySelector('[data-capupper]');
    if (up) up.onchange = () => { C.upper = up.checked; };
    const rp = this.panel.querySelector('[data-capreplace]');
    if (rp) rp.onchange = () => { C.replace = rp.checked; };
    const lk = this.panel.querySelector('[data-caplink]');
    if (lk) lk.onchange = () => actions.setSubtitleLink(lk.checked);
    const man = this.panel.querySelector('.ac-manual');
    if (man) man.ontoggle = () => { this.capManual = man.open; };
    if (!this.capStatusAt || Date.now() - this.capStatusAt > 60000) {
      this.capStatusAt = Date.now();
      transcribeStatus().then((st) => { this.capStatus = st; if (this.tab === 'caption' && !this.capBusy) this.render(); });
    }
  }

  /** Auto subtitles: mix the chosen sound, transcribe it on the server, put the lines on the subtitle track. */
  async autoCaptions() {
    const C = this.cap;
    if (this.capBusy) return;
    const ctl = new AbortController();
    this.capBusy = { p: 0, label: 'Menyiapkan…', ctl };
    this.render();
    const progress = (p, label) => {
      if (!this.capBusy) return;
      Object.assign(this.capBusy, { p, label });
      const bar = this.panel?.querySelector('.ac-prog');
      if (bar) { bar.querySelector('i').style.width = `${Math.max(3, Math.round(p * 100))}%`; bar.querySelector('span').textContent = label; }
    };
    try {
      const res = await transcribeProject({ from: C.from, lang: C.lang, onProgress: progress, signal: ctl.signal });
      const cues = cuesFromSegments(res.segments, { maxChars: LINE_LENGTH[C.len] || LINE_LENGTH.medium, upper: C.upper });
      if (!cues.length) { toast('Tidak ada ucapan yang terdengar di audio itu', { type: 'warn', timeout: 5000 }); return; }
      actions.addSubtitles(cues, { preset: C.preset, y: Number(C.pos), replace: C.replace });
      toast(`${cues.length} baris subtitle dibuat${C.lang === 'auto' && res.language ? ` (bahasa: ${langName(res.language)})` : ''}`, { type: 'ok', timeout: 4000 });
    } catch (err) {
      if (!ctl.signal.aborted) toast(`Subtitle otomatis gagal: ${err.message}`, { type: 'error', timeout: 6000 });
    } finally {
      this.capBusy = null;
      this.render();
    }
  }

  effectPanel() {
    const fav = favs.pick('effect', EFFECTS);
    const cats = [...(fav.length ? ['★ Favorit'] : []), 'Semua', ...new Set(EFFECTS.map((e) => e.cat))];
    if (!cats.includes(this.fxCat)) this.fxCat = 'Semua';
    const list = this.fxCat === '★ Favorit' ? fav : EFFECTS.filter((e) => this.fxCat === 'Semua' || e.cat === this.fxCat);
    return `
      <div class="chip-row">${cats.map((c) => `<button class="chip ${this.fxCat === c ? 'on' : ''}" data-fxcat="${c}">${c}</button>`).join('')}</div>
      <div class="tile-grid">${list.map((f) => `<button class="tile fx-tile" draggable="true" data-effect="${f.id}" style="--a:${f.colors[0]};--b:${f.colors[1]}"><span class="tile-art fx-${f.id}"><b>${f.icon}</b></span><em>${f.name}</em>${star('effect', f.id)}</button>`).join('')}</div>
      <p class="hint">${this.opts.range ? 'Efek dipasang sepanjang klip terpilih.' : 'Ketuk untuk menambah di playhead (3 detik).'}</p>`;
  }

  transitionPanel() {
    const sel = store.selected();
    const list = sortedClips(store.P, 'main');
    const valid = sel && sel.trackId === 'main' && list.indexOf(sel) > 0;
    const cur = valid ? sel.transition?.type : null;
    const trTile = (t) => `<button class="tile tr-tile ${cur === t.id ? 'on' : ''}" data-transition="${t.id}"><canvas class="tile-art tr-prev" data-prev="tr:${t.id}" width="160" height="100"></canvas><em>${t.name}</em>${t.id !== 'none' ? star('transition', t.id) : ''}</button>`;
    return `
      <p class="hint">${valid ? `Transisi masuk ke klip <b>${escapeHtml(sel.name || '')}</b>.` : 'Ketuk tombol di antara dua klip di track utama untuk memilih sambungannya.'}</p>
      ${this.favSection('transition', TRANSITIONS.filter((t) => t.id !== 'none'), trTile, 'tile-grid')}
      <div class="tile-grid">${TRANSITIONS.map(trTile).join('')}</div>
      <div class="ctl"><label>Durasi transisi: <b class="tr-dur-v">${this.trDuration.toFixed(1)}s</b></label><input type="range" class="tr-dur" min="0.2" max="2" step="0.1" value="${this.trDuration}"></div>
      <button class="btn sm ghost" data-do="trAll">${icon('layers', 14)} Terapkan ke semua klip</button>`;
  }

  filterPanel() {
    const c = actions.targetVisual();
    const cur = c?.filter?.name || 'none';
    const fltTile = (f) => `<button class="tile flt-tile ${cur === f.id ? 'on' : ''}" data-filter="${f.id}"><canvas class="flt-thumb" data-f="${f.id}" width="120" height="80"></canvas><em>${f.name}</em>${f.id !== 'none' ? star('filter', f.id) : ''}</button>`;
    return `
      <p class="hint">${c ? `Diterapkan ke: <b>${escapeHtml(c.name || c.type)}</b>` : 'Pilih klip video/foto atau letakkan playhead di atas klip.'}</p>
      ${c && cur !== 'none' ? `<div class="ctl"><label>Intensitas: <b class="flt-v">${Math.round((c.filter.intensity ?? 1) * 100)}%</b></label><input type="range" class="flt-int" min="0" max="100" value="${Math.round((c.filter.intensity ?? 1) * 100)}"></div>` : ''}
      ${this.favSection('filter', FILTERS.filter((f) => f.id !== 'none'), fltTile, 'tile-grid filter-grid')}
      <div class="tile-grid filter-grid">${FILTERS.map(fltTile).join('')}</div>
      <button class="btn sm ghost" data-do="fltAll">${icon('layers', 14)} Terapkan filter ini ke semua klip</button>`;
  }

  aiPanel() {
    // (v1.12.3) Tabs: connect (ready to paste, no placeholders), prompts (write or pick, copy or open in Claude),
    // paste JSON (tool calls from any AI, run here), activity.
    const st = bridge.state;
    const base = location.origin;
    const http = `${base}/mcp`;
    const auth = !!st.status?.auth;
    const tab = this.aiTab || 'connect';
    const copyRow = (text) => `<div class="copy-row"><code>${escapeHtml(text)}</code><button class="btn sm" data-copy="${escapeHtml(text)}" title="Salin">${icon('copy', 14)}</button></div>`;
    const status = `
      <div class="mcp-status ${st.connected ? 'ok' : st.available === false ? 'off' : 'wait'}">
        <span class="dot"></span>
        <div><b>${st.connected ? 'Server MCP aktif' : st.available === false ? 'Mode offline' : 'Menghubungkan…'}</b>
        <span>${st.connected ? (st.clients.length ? `Agen terhubung: ${st.clients.map((c) => escapeHtml(c.name)).join(', ')}` : 'Menunggu AI agent terhubung') : st.available === false ? 'Jalankan <code>npm start</code> agar AI bisa mengedit lewat MCP.' : ''}</span></div>
      </div>
      <div class="seg wide ai-tabs">${[['connect', 'Hubungkan'], ['prompt', 'Prompt'], ['json', 'Tempel JSON'], ['log', `Aktivitas${st.log.length ? ` (${st.log.length})` : ''}`]].map(([id, n]) => `<button class="${tab === id ? 'on' : ''}" data-aitab="${id}">${n}</button>`).join('')}</div>`;
    let body = '';
    if (tab === 'connect') {
      const ccOauth = `claude mcp add --transport http najja-editor --scope user ${http}`;
      const jsonUrl = JSON.stringify({ mcpServers: { 'najja-editor': { url: http } } }, null, 2);
      const fresh = this.aiFresh;
      const ccToken = fresh ? `claude mcp add --transport http najja-editor --scope user ${http} --header "Authorization: Bearer ${fresh}"` : '';
      const stdio = st.status?.mcp?.stdio;
      const desktopCfg = JSON.stringify({ mcpServers: { 'najja-editor': auth ? { command: 'node', args: ['C:\\najja-editor-main\\mcp-stdio.js'], env: { NAJJA_URL: base, NAJJA_TOKEN: fresh || '' } } : (stdio || { command: 'node', args: ['mcp-stdio.js'] }) } }, null, 2);
      body = auth ? `
        <div class="lib-section ai-card"><h4>1 · Claude: desktop, claude.ai, HP <span class="tag">paling mudah</span></h4>
          <ol class="ai-steps"><li>Di Claude buka <b>Kustomisasi → Konektor → Tambahkan konektor kustom</b> (Settings → Connectors → Add custom connector).</li><li>Tempel alamat ini, kolom OAuth dikosongkan:</li></ol>
          ${copyRow(http)}
          <ol class="ai-steps" start="3"><li>Klik <b>Hubungkan</b>, masuk dengan akun Najja, lalu <b>Izinkan</b>.</li><li>Biarkan tab editor ini terbuka; buka tab <b>Prompt</b> untuk perintah siap pakai.</li></ol></div>
        <div class="lib-section ai-card"><h4>2 · Claude Code (terminal)</h4>
          <p class="hint">Jalankan di PowerShell/Terminal, lalu di Claude Code ketik <code>/mcp</code> → najja-editor → <b>Authenticate</b>.</p>
          ${copyRow(ccOauth)}</div>
        <div class="lib-section ai-card"><h4>3 · JSON untuk Cursor, VS Code, Windsurf, dll.</h4>
          <pre class="code">${escapeHtml(jsonUrl)}</pre><button class="btn sm" data-copy="${escapeHtml(jsonUrl)}">${icon('copy', 14)} Salin JSON</button></div>
        <details class="lib-section ai-card" ${fresh ? 'open' : ''}><summary>Cara lama: pakai token AI</summary>
          <p class="hint">Untuk aplikasi yang tidak bisa login OAuth. Tombol ini membuat token baru dan mengisinya langsung ke perintah di bawah (token lama dicabut). Token hanya tampil sekali.</p>
          ${fresh ? `<p class="hint ok">Token baru dibuat. Salin sekarang.</p>${copyRow(ccToken)}<p class="hint">Claude Desktop lewat file konfigurasi (butuh Node.js dan folder najja-editor di <code>C:\\najja-editor-main</code>):</p><pre class="code">${escapeHtml(desktopCfg)}</pre><button class="btn sm" data-copy="${escapeHtml(desktopCfg)}">${icon('copy', 14)} Salin JSON</button>` : ''}
          <div class="tok-actions"><button class="btn sm" data-ai-filltoken>${icon('ai', 14)} Buat token & isi otomatis</button><button class="btn sm ghost" data-aitoken>Kelola token & aplikasi terhubung</button></div></details>`
        : `
        <div class="lib-section ai-card"><h4>Claude Code</h4>${copyRow(`claude mcp add --transport http najja-editor ${http}`)}</div>
        <div class="lib-section ai-card"><h4>Claude Desktop / Cursor (stdio)</h4><pre class="code">${escapeHtml(desktopCfg)}</pre><button class="btn sm" data-copy="${escapeHtml(desktopCfg)}">${icon('copy', 14)} Salin JSON</button></div>`;
    } else if (tab === 'prompt') {
      const proj = store.P?.name || 'proyek ini';
      const text = this.aiPrompt ?? '';
      body = `
        <div class="lib-section"><h4>Tulis perintah</h4>
          <textarea class="ai-prompt" data-ai-input="prompt" rows="5" placeholder="Contoh: Edit proyek ini pakai Story Pop, produk Olive Bag, harga 149 ribu…">${escapeHtml(text)}</textarea>
          <div class="tok-actions"><button class="btn btn-primary sm" data-ai-open ${text.trim() ? '' : 'disabled'}>${icon('ai', 14)} Buka di Claude</button><button class="btn sm" data-ai-copyprompt ${text.trim() ? '' : 'disabled'}>${icon('copy', 14)} Salin</button>${text ? '<button class="btn sm ghost" data-ai-clear>Kosongkan</button>' : ''}</div>
          <p class="hint">"Buka di Claude" membuka chat baru di claude.ai dengan perintah ini sudah terisi (juga disalin). Claude-nya harus sudah tersambung ke Najja, dan tab editor ini tetap terbuka.</p></div>
        <div class="lib-section"><h4>Perintah siap pakai</h4><p class="hint">Ketuk untuk memasukkan ke kotak di atas, lalu ganti bagian <b>[...]</b>.</p>
          ${PROMPT_GROUPS.map(([g, list]) => `<div class="ai-group"><h5>${escapeHtml(g)}</h5>${list.map((p) => { const f = fillPrompt(p, proj); return `<button class="prompt-chip" data-ai-tpl="${escapeHtml(f)}">${escapeHtml(f)}</button>`; }).join('')}</div>`).join('')}</div>`;
    } else if (tab === 'json') {
      const text = this.aiJson ?? '';
      const res = this.aiResults || [];
      body = `
        <div class="lib-section"><h4>Tempel perintah JSON</h4>
          <p class="hint">Perintah dari AI mana pun (ChatGPT, Claude tanpa konektor) atau tulisan sendiri langsung dijalankan di editor ini. Formatnya <code>{"tool": "...", "arguments": {...}}</code>, atau daftar <code>[...]</code> yang dijalankan berurutan.</p>
          <textarea class="ai-json" data-ai-input="json" rows="9" spellcheck="false" placeholder='[ { "tool": "add_text", "arguments": { "text": "DISKON 50%", "start": 0 } } ]'>${escapeHtml(text)}</textarea>
          <div class="tok-actions"><button class="btn btn-primary sm" data-ai-run ${text.trim() && !this.aiRunning ? '' : 'disabled'}>${icon('play', 14)} ${this.aiRunning ? 'Menjalankan…' : 'Jalankan'}</button><button class="btn sm" data-ai-example>Contoh</button><button class="btn sm" data-ai-guide>${icon('copy', 14)} Salin panduan untuk AI lain</button>${text ? '<button class="btn sm ghost" data-ai-jsonclear>Kosongkan</button>' : ''}</div>
          <p class="hint">"Salin panduan" menyalin daftar tool beserta formatnya. Tempel ke ChatGPT/Claude, tulis permintaanmu di akhir, lalu tempel jawabannya di sini. Setiap perintah bisa dibatalkan dengan Urungkan.</p></div>
        ${res.length ? `<div class="lib-section"><h4>Hasil</h4><ul class="mcp-log">${res.map((r) => `<li class="${r.state}"><span class="lt">${escapeHtml(r.tool)}</span><span class="ls">${r.state === 'ok' ? `${r.ms} ms${r.note ? ` · ${escapeHtml(r.note)}` : ''}` : r.state === 'skip' ? 'dilewati' : escapeHtml(r.error || 'gagal')}</span></li>`).join('')}</ul></div>` : ''}`;
    } else {
      const log = st.log.slice(0, 40);
      body = `
        <div class="lib-section"><h4>Aktivitas AI</h4>
          ${log.length ? `<ul class="mcp-log">${log.map((l) => `<li class="${l.state}"><span class="lt">${escapeHtml(l.tool)}${l.local ? ' <em>(JSON)</em>' : ''}</span><span class="ls">${l.state === 'ok' ? `${l.ms} ms` : l.state === 'error' ? escapeHtml(l.error || 'gagal') : l.state === 'wait' ? 'antri' : '…'}</span></li>`).join('')}</ul>` : '<p class="hint">Belum ada perintah dari AI.</p>'}</div>
        <details class="lib-section tools-list"><summary>${(st.status?.tools || []).length} tool tersedia</summary>
          <ul>${(st.status?.tools || []).map((t) => `<li><code>${t.name}</code><span>${escapeHtml(t.description.split('. ')[0])}.</span></li>`).join('')}</ul></details>`;
    }
    return status + body;
  }

  /** (v1.12.3) Text typed in the AI · MCP panel is kept between redraws. */
  onInput(e) {
    const k = e.target?.dataset?.aiInput;
    if (!k) return;
    if (k === 'prompt') this.aiPrompt = e.target.value;
    if (k === 'json') this.aiJson = e.target.value;
    // (the buttons follow without redrawing the box being typed in)
    const has = !!e.target.value.trim();
    for (const b of this.panel.querySelectorAll(k === 'prompt' ? '[data-ai-open],[data-ai-copyprompt]' : '[data-ai-run]')) b.disabled = !has || (k === 'json' && !!this.aiRunning);
  }

  /** Full input schemas of the tools (for "Salin panduan untuk AI lain"), from this server's MCP endpoint. */
  async aiToolSchemas() {
    if (this.aiSchemas) return this.aiSchemas;
    try {
      const r = await fetch('/mcp', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const j = await r.json();
      if (j.result?.tools?.length) this.aiSchemas = j.result.tools;
    } catch { /* fall back to names and descriptions */ }
    return this.aiSchemas || (bridge.state.status?.tools || []);
  }

  /** Run the pasted JSON tool calls one after another; stops at the first error. */
  async aiRunJson() {
    let calls;
    try { calls = parseToolCalls(this.aiJson, bridge.toolNames()); } catch (err) { toast(err.message, { type: 'error', timeout: 6000 }); return; }
    this.aiRunning = true;
    this.aiResults = calls.map((c) => ({ tool: c.tool, state: 'wait' }));
    this.render();
    let failed = false;
    for (let i = 0; i < calls.length; i++) {
      const r = this.aiResults[i];
      if (failed) { r.state = 'skip'; continue; }
      const t0 = performance.now();
      try {
        const out = await bridge.runLocal(calls[i].tool, calls[i].args);
        // (v1.13.2) the checker's notes (an unknown field, a value outside the list...) show next to the result
        Object.assign(r, { state: 'ok', ms: Math.round(performance.now() - t0), note: [out?.data?.id, ...(out?.notes || [])].filter(Boolean).join(' · ') });
      } catch (err) {
        Object.assign(r, { state: 'error', error: err.message });
        failed = true;
      }
      if (this.tab === 'ai') this.render();
    }
    this.aiRunning = false;
    if (this.tab === 'ai') this.render();
    const ok = this.aiResults.filter((r) => r.state === 'ok').length;
    toast(failed ? `${ok} dari ${calls.length} perintah jalan; berhenti di yang gagal` : `${ok} perintah dijalankan`, { type: failed ? 'warn' : 'ok', timeout: 4500 });
  }

  // ---------------------------------------------------------------------------------------------
  async importFiles(files, { addAt } = {}) {
    let t = addAt;
    for (const f of files) {
      try {
        const m = await importFile(f);
        if (addAt != null) {
          const clip = actions.addMediaClip(m.id, { start: t });
          t = clip.start + clip.duration;
        }
      } catch (err) {
        toast(err.message, { type: 'error', timeout: 4500 });
      }
    }
  }

  async importUrl() {
    const m = modal({
      title: 'Impor dari URL',
      body: `<div class="ctl"><label>URL video, foto, atau audio</label><input type="url" class="url-in" placeholder="https://contoh.com/video.mp4"></div><p class="hint">File diunduh lewat server Najja (perlu <code>npm start</code>).</p>`,
      footer: '<button class="btn" data-x>Batal</button><button class="btn btn-primary" data-go>Impor</button>',
    });
    const input = m.el.querySelector('.url-in');
    input.focus();
    m.el.querySelector('[data-x]').onclick = m.close;
    const go = async () => {
      const url = input.value.trim();
      if (!url) return;
      m.close();
      const done = toast('Mengunduh media…', { timeout: 0 });
      try {
        const r = await fetch('/api/import-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Gagal mengunduh');
        await importFromServerUrl(j.server_url, j.name, j.mime);
        toast('Media diimpor', { type: 'ok' });
      } catch (err) {
        toast(err.message.includes('Failed to fetch') ? 'Server Najja tidak berjalan — impor URL butuh npm start' : err.message, { type: 'error', timeout: 5000 });
      } finally { done(); }
    };
    m.el.querySelector('[data-go]').onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  async toggleRecord() {
    if (this.recorder) {
      this.recorder.stop();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast('Izin mikrofon ditolak atau tidak tersedia', { type: 'error' });
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const startAt = this.engine.time;
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      this.recorder = null;
      this.engine.pause();
      this.render();
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (blob.size < 1000) return;
      try {
        const n = store.P.media.filter((m) => m.name.startsWith('Voiceover')).length + 1;
        const m = await importFile(new File([blob], `Voiceover ${n}.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`, { type: blob.type }));
        actions.addMediaClip(m.id, { track: 'audio', start: startAt });
        toast('Voiceover ditambahkan', { type: 'ok' });
      } catch (err) { toast(err.message, { type: 'error' }); }
    };
    rec.start(250);
    this.recorder = rec;
    if (store.duration() > startAt + 0.1) this.engine.play();
    this.render();
  }

  previewSfx(id) {
    if (this.preview?.id === id) { this.preview.audio.pause(); this.preview = null; this.render(); return; }
    this.preview?.audio.pause();
    synthAudio(id).then((blob) => {
      const audio = new Audio(URL.createObjectURL(blob));
      audio.play().catch(() => {});
      audio.onended = () => { this.preview = null; this.render(); };
      this.preview = { id, audio };
      this.render();
    });
  }

  async addSfx(id, start) {
    try {
      const m = await ensureStockAudio(id);
      actions.addMediaClip(m.id, { track: 'audio', start: start ?? this.engine.time });
    } catch (err) { toast(err.message, { type: 'error' }); }
  }

  makeCaptions() {
    const text = this.panel.querySelector('.cap-input').value;
    this.capText = text;
    this.capPreset = this.cap?.preset || 'subtitle';
    const y = Number(this.cap?.pos ?? 0.36);
    let items;
    if ((this.capMode || 'script') === 'srt') items = actions.parseSrt(text);
    else items = actions.scriptToItems(text, 0, Math.max(store.duration(), 4));
    if (!items.length) return toast(this.capMode === 'srt' ? 'Format SRT tidak terbaca' : 'Naskah masih kosong', { type: 'warn' });
    actions.addSubtitles(items, { preset: this.capPreset, y, replace: true });
    toast(`${items.length} baris subtitle dibuat`, { type: 'ok' });
  }

  // ---------------------------------------------------------------------------------------------
  payloadFor(el) {
    const d = el.dataset;
    const at = (start) => start;
    if (d.media) {
      const m = store.media(d.media);
      if (!m) return null;
      return { clipType: m.type, duration: m.type === 'image' ? 3 : m.duration, drop: ({ track, start }) => actions.addMediaClip(m.id, { track, start: at(start) }) };
    }
    if (d.solid) return { clipType: 'solid', duration: 3, drop: ({ track, start }) => actions.addSolid({ color: d.solid, track: track === 'auto' ? 'main' : track, start }) };
    if (d.grad) {
      const [a, b, ang] = GRADIENTS[+d.grad];
      return { clipType: 'solid', duration: 3, drop: ({ track, start }) => actions.addSolid({ color: a, color2: b, angle: ang, track: track === 'auto' ? 'main' : track, start }) };
    }
    if (d.text) return { clipType: 'text', duration: 3, drop: ({ track, start }) => actions.addText({ text: d.text === 'default' ? 'Teks baru' : TEXT_PRESETS.find((p) => p.id === d.text)?.name || 'Teks', preset: d.text, track, start }) };
    if (d.template) {
      const t = TEXT_TEMPLATES.find((x) => x.id === d.template);
      return { clipType: 'text', duration: 3, drop: ({ track, start }) => actions.addText({ text: t.text, template: t.id, track, start }) };
    }
    if (d.emoji) return { clipType: 'sticker', duration: 3, drop: ({ start }) => actions.addSticker({ emoji: d.emoji, start }) };
    if (d.badge) return { clipType: 'sticker', duration: 3, drop: ({ start }) => actions.addSticker({ badge: d.badge, start }) };
    if (d.effect) return { clipType: 'effect', duration: 3, drop: ({ start }) => actions.addEffect({ effect: d.effect, start }) };
    if (d.sfx) {
      const s = SFX.find((x) => x.id === d.sfx);
      return { clipType: 'audio', duration: s?.dur || 2, drop: ({ start }) => this.addSfx(d.sfx, start) };
    }
    return null;
  }

  onDragStart(e) {
    const el = e.target.closest('[draggable="true"]');
    if (!el) return;
    const p = this.payloadFor(el);
    if (!p) return;
    setDragPayload(p);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', 'najja');
  }

  onClick(e) {
    if (onStar(e)) { this.render(); return; }
    const t = e.target.closest('button, [data-media]');
    if (!t) return;
    const d = t.dataset;
    const run = (fn) => {
      try {
        const r = fn();
        if (r && typeof r === 'object' && 'id' in r) { store.select(r.id); this.opts.onPick?.(r); }
      } catch (err) { toast(err.message, { type: 'error', timeout: 4000 }); }
    };
    if ('aitoken' in d) { account.aiToken(); return; }
    // (v1.12.3) AI · MCP panel
    if (d.aitab) { this.aiTab = d.aitab; this.render(); return; }
    if (d.aiTpl) { this.aiPrompt = d.aiTpl; this.render(); const ta = this.panel.querySelector('.ai-prompt'); if (ta) { ta.focus(); const i = ta.value.indexOf('['); if (i >= 0) ta.setSelectionRange(i, ta.value.indexOf(']', i) + 1); } return; }
    if ('aiCopyprompt' in d || 'aiOpen' in d) {
      const text = (this.aiPrompt || '').trim();
      if (!text) return;
      navigator.clipboard?.writeText(text).catch(() => {});
      if ('aiOpen' in d) window.open(claudeUrl(text), '_blank', 'noopener');
      toast('aiOpen' in d ? 'Membuka Claude (perintah juga disalin)' : 'Perintah disalin, tempel di Claude', { type: 'ok' });
      return;
    }
    if ('aiClear' in d) { this.aiPrompt = ''; this.render(); return; }
    if ('aiJsonclear' in d) { this.aiJson = ''; this.aiResults = []; this.render(); return; }
    if ('aiExample' in d) { this.aiJson = EXAMPLE_JSON; this.render(); return; }
    if ('aiRun' in d) { this.aiRunJson(); return; }
    if ('aiGuide' in d) {
      this.aiToolSchemas().then((tools) => navigator.clipboard?.writeText(guideForOtherAi(tools, store.P?.name)))
        .then(() => toast('Panduan disalin. Tempel ke AI lain, tambahkan permintaanmu di akhir.', { type: 'ok', timeout: 5000 }))
        .catch(() => toast('Gagal menyalin', { type: 'error' }));
      return;
    }
    if ('aiFilltoken' in d) {
      (async () => {
        let info = {};
        try { info = await (await fetch('/api/me/token', { credentials: 'same-origin' })).json(); } catch { /* ignore */ }
        if (info.exists && !(await confirmDialog('Buat token baru?', 'Token AI yang lama dicabut; aplikasi yang memakainya harus diatur ulang. Konektor Claude (OAuth) tidak terpengaruh.', 'Buat baru'))) return;
        try {
          const r = await fetch('/api/me/token', { method: 'POST', credentials: 'same-origin' });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          this.aiFresh = j.token; // (only in this page's memory: gone on reload)
          this.render();
        } catch (err) { toast(err.message, { type: 'error' }); }
      })();
      return;
    }
    if (d.copy) { navigator.clipboard?.writeText(d.copy).then(() => toast('Disalin', { type: 'ok' })).catch(() => toast('Gagal menyalin', { type: 'error' })); return; }
    if (d.mfilter) { this.mediaFilter = d.mfilter; this.render(); return; }
    if (d.fxcat) { this.fxCat = d.fxcat; this.render(); return; }
    if (d.capmode) { this.capText = this.panel.querySelector('.cap-input')?.value; this.capMode = d.capmode; this.capManual = true; this.render(); return; }
    if (this.cap && (d.capopen || d.capfrom || d.caplang || d.cappreset || d.caplen || d.cappos || 'capadv' in d)) {
      const C = this.cap;
      if (d.capopen) C.open = C.open === d.capopen ? null : d.capopen;
      if (d.capfrom) { C.from = d.capfrom; C.open = null; }
      if (d.caplang) { C.lang = d.caplang; C.open = null; C.q = ''; }
      if (d.cappreset) C.preset = d.cappreset;
      if (d.caplen) C.len = d.caplen;
      if (d.cappos) C.pos = d.cappos;
      if ('capadv' in d) C.adv = !C.adv;
      this.render();
      return;
    }
    if (d.retry) { e.stopPropagation(); mediaRT.get(d.retry)?.upload?.retry?.(); return; }
    if (d.add || (t.dataset.media && !e.target.closest('button'))) {
      const id = d.add || t.dataset.media;
      const m = store.media(id);
      run(() => actions.addMediaClip(id, m?.type === 'audio' ? { track: 'audio', start: this.engine.time } : {}));
      return;
    }
    if (d.del) {
      e.stopPropagation();
      const used = store.P.clips.some((c) => c.mediaId === d.del);
      confirmDialog('Hapus media?', used ? 'Media ini dipakai di timeline. Klip yang memakainya juga akan dihapus.' : 'Media akan dihapus dari pustaka proyek.', 'Hapus', true)
        .then((ok) => ok && removeMedia(d.del));
      return;
    }
    if (d.play) { this.previewSfx(d.play); return; }
    if (d.addsfx) { this.addSfx(d.addsfx); return; }
    if (d.solid || d.grad) { const p = this.payloadFor(t); run(() => p.drop({ track: 'main' })); return; }
    if (d.effect && this.opts.range) {
      const r = this.opts.range;
      run(() => actions.addEffect({ effect: d.effect, start: r.start, duration: r.duration }));
      return;
    }
    if (d.text || d.template || d.emoji || d.badge || d.effect) { const p = this.payloadFor(t); run(() => p.drop({ track: 'auto', start: this.engine.time })); return; }
    if (d.transition) {
      const sel = store.selected();
      const list = sortedClips(store.P, 'main');
      let target = sel && sel.trackId === 'main' && list.indexOf(sel) > 0 ? sel : null;
      if (!target) {
        const tm = this.engine.time;
        target = list.slice(1).reduce((best, c) => (!best || Math.abs(c.start - tm) < Math.abs(best.start - tm) ? c : best), null);
      }
      if (!target) { toast('Butuh minimal 2 klip di track utama', { type: 'warn' }); return; }
      run(() => actions.applyTransition(target.id, d.transition, this.trDuration));
      store.select(target.id);
      this.engine.pause();
      this.engine.seek(Math.max(0, target.start - this.trDuration / 2 - 0.3));
      this.engine.play();
      const stop = target.start + this.trDuration / 2 + 0.4;
      const off = this.engine.on((k) => { if (k === 'time' && this.engine.time >= stop) { this.engine.pause(); off(); } if (k === 'pause') off(); });
      return;
    }
    if (d.filter) {
      const c = actions.targetVisual();
      if (!c) { toast('Pilih klip video/foto dulu', { type: 'warn' }); return; }
      run(() => actions.applyFilter(c.id, d.filter, c.filter?.intensity ?? 1));
      store.select(c.id);
      return;
    }
    switch (d.do) {
      case 'import': this.fileInput.click(); break;
      case 'importAudio': {
        const at = this.engine.time;
        pickFiles({ multiple: true, accept: 'audio/*,.mp3,.wav,.m4a,.aac,.ogg' }).then((files) => { if (files.length) this.importFiles(files, { addAt: at }); });
        break;
      }
      case 'url': this.importUrl(); break;
      case 'record': this.toggleRecord(); break;
      case 'extract': actions.extractAudio(); break;
      case 'makeCaptions': this.makeCaptions(); break;
      case 'autoCaptions': this.autoCaptions(); break;
      case 'capCancel': this.capBusy?.ctl.abort(); break;
      case 'srtFile': {
        pickFiles({ accept: '.srt,.vtt,text/plain' }).then(async (files) => { if (!files.length) return; this.capText = await files[0].text(); this.capMode = 'srt'; this.render(); });
        break;
      }
      case 'clearCaptions':
        store.mutate('Hapus subtitle', (P) => { const ids = P.tracks.filter((x) => x.subtitle).map((x) => x.id); P.clips = P.clips.filter((c) => !ids.includes(c.trackId)); });
        this.render();
        break;
      case 'trAll': {
        const cur = store.selected()?.transition?.type;
        run(() => actions.applyTransition('all', cur && cur !== 'none' ? cur : 'fade', this.trDuration));
        toast('Transisi diterapkan ke semua klip', { type: 'ok' });
        break;
      }
      case 'fltAll': {
        const c = actions.targetVisual();
        const f = c?.filter?.name;
        if (!f || f === 'none') { toast('Pilih filter dulu', { type: 'warn' }); break; }
        run(() => actions.applyFilter('all', f, c.filter.intensity));
        toast('Filter diterapkan ke semua klip', { type: 'ok' });
        break;
      }
      default: break;
    }
  }

  paintFilterThumbs() {
    if (!this.sample) this.sample = makeSampleScene();
    const intensity = this.panel.querySelector('.flt-int');
    if (intensity) {
      intensity.oninput = () => {
        const c = actions.targetVisual();
        if (!c) return;
        store.live(() => { c.filter.intensity = Number(intensity.value) / 100; });
        this.panel.querySelector('.flt-v').textContent = `${intensity.value}%`;
      };
      intensity.onchange = () => store.commitLive('Intensitas filter');
    }
    const trd = this.panel.querySelector('.tr-dur');
    if (trd) trd.oninput = () => { this.trDuration = Number(trd.value); this.panel.querySelector('.tr-dur-v').textContent = `${this.trDuration.toFixed(1)}s`; };
    for (const cv of this.panel.querySelectorAll('.flt-thumb')) {
      const ctx = cv.getContext('2d');
      const fake = { filter: { name: cv.dataset.f, intensity: 1 }, adjust: {} };
      drawFiltered(ctx, cssFilterFor(fake), this.sample, 0, 0, cv.width, cv.height);
      const f = FILTERS.find((x) => x.id === cv.dataset.f);
      if (f?.overlay) {
        ctx.globalCompositeOperation = f.overlay.mode;
        ctx.globalAlpha = f.overlay.alpha;
        ctx.fillStyle = f.overlay.color;
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
    }
  }
}

function makeSampleScene() {
  const c = document.createElement('canvas');
  c.width = 240;
  c.height = 160;
  const x = c.getContext('2d');
  const sky = x.createLinearGradient(0, 0, 0, 160);
  sky.addColorStop(0, '#5aa9ff');
  sky.addColorStop(0.6, '#ffd59e');
  sky.addColorStop(1, '#ff9a6b');
  x.fillStyle = sky;
  x.fillRect(0, 0, 240, 160);
  x.fillStyle = '#fff3b0';
  x.beginPath();
  x.arc(170, 70, 22, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#2f7d4f';
  x.beginPath();
  x.moveTo(0, 120);
  x.quadraticCurveTo(60, 80, 120, 115);
  x.quadraticCurveTo(180, 140, 240, 105);
  x.lineTo(240, 160);
  x.lineTo(0, 160);
  x.fill();
  x.fillStyle = '#1f5a3a';
  x.beginPath();
  x.moveTo(0, 140);
  x.quadraticCurveTo(90, 115, 240, 145);
  x.lineTo(240, 160);
  x.lineTo(0, 160);
  x.fill();
  x.fillStyle = '#e8505b';
  x.fillRect(40, 108, 16, 22);
  return c;
}

export { clipEnd, fmtBytes };
