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
import { escapeHtml, fmtDur, fmtBytes } from './util.js';
import { cssFilterFor } from './render.js';
import { setDragPayload } from './timeline.js';
import * as actions from './actions.js';
import { toast, modal, confirmDialog } from './ui.js';
import { bridge } from './bridge.js';
import { account } from './account.js';

const TITLES = {
  music: 'Suara', sfx: 'Efek suara', record: 'Rekam suara', templates: 'Template teks', caption: 'Keterangan',
  effect: 'Efek video', transition: 'Transisi', filter: 'Filter', ai: 'AI · MCP',
};

/** Asset panels (music, sound effects, text templates, captions, effects, transitions, filters, AI), shown in a bottom sheet. */
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
    this.onClickH = (e) => this.onClick(e);
    this.onDragStartH = (e) => this.onDragStart(e);
    this.onDragEndH = () => setDragPayload(null);
    onMediaChange(() => { if (this.tab === 'music') this.render(); });
    store.on('selection', () => { if (['filter', 'transition'].includes(this.tab)) this.render(); });
    store.on('project', () => { if (['filter', 'transition'].includes(this.tab) && !store._live) this.render(); });
    bridge.on(() => { if (this.tab === 'ai') this.render(); });
  }

  static title(tab) { return TITLES[tab] || ''; }

  /** Show one panel inside `el`. Returns a function that removes it. */
  mount(el, tab, opts = {}) {
    this.unmount();
    this.panel = el;
    this.tab = tab;
    this.opts = opts;
    el.addEventListener('click', this.onClickH);
    el.addEventListener('dragstart', this.onDragStartH);
    el.addEventListener('dragend', this.onDragEndH);
    this.render();
    return () => this.unmount(el);
  }
  unmount(el = this.panel) {
    if (!el) return;
    el.removeEventListener('click', this.onClickH);
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
        <div class="ar-info"><b>${s.name}</b><span>${fmtDur(s.dur)} · ${s.kind === 'music' ? 'Musik' : 'Efek suara'}</span></div>
        <button class="ar-add" data-addsfx="${s.id}" title="Tambah di playhead" aria-label="Tambah">${icon('plus', 16)}</button></div>`;
  }

  musicPanel() {
    const mine = store.P.media.filter((m) => m.type === 'audio' && !m.stock);
    return `
      <div class="lib-section"><h4>Musik bawaan</h4>${SFX.filter((s) => s.kind === 'music').map((s) => this.audioRow(s)).join('')}</div>
      <div class="lib-section"><h4>Audio saya <button class="btn sm ghost" data-do="importAudio">${icon('upload', 14)} Impor audio</button></h4>
        ${mine.length ? `<div class="media-grid">${mine.map((m) => this.mediaCard(m)).join('')}</div>` : '<p class="hint">Audio yang kamu impor (MP3, WAV, M4A) muncul di sini. Ketuk untuk menambah di playhead.</p>'}</div>`;
  }

  sfxPanel() {
    return `<div class="lib-section">${SFX.filter((s) => s.kind === 'sfx').map((s) => this.audioRow(s)).join('')}</div>
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
      <div class="lib-section"><h4>Template judul</h4><div class="ttpl-grid">${TEXT_TEMPLATES.map((t) => `<button class="ttpl" draggable="true" data-template="${t.id}"><span class="tp-prev tp-${t.preset}">${escapeHtml(t.text.split('\n')[0])}</span><em>${t.name}</em></button>`).join('')}</div></div>
      <div class="lib-section"><h4>Gaya teks</h4><div class="tstyle-grid">${TEXT_PRESETS.map((p) => `<button class="tstyle" draggable="true" data-text="${p.id}" title="${p.name}"><span class="tp-prev tp-${p.id}">Teks</span><em>${p.name}</em></button>`).join('')}</div></div>`;
  }

  captionPanel() {
    return `
      <div class="soon-card">${icon('mic', 22)}<div><b>Teks otomatis dari suara</b><span>Subtitle langsung dari ucapan di video (transkripsi). Segera hadir — sementara pakai naskah, SRT, atau minta AI lewat MCP (<code>add_subtitles</code>).</span></div></div>
      <div class="seg wide"><button class="${(this.capMode || 'script') === 'script' ? 'on' : ''}" data-capmode="script">Naskah</button><button class="${this.capMode === 'srt' ? 'on' : ''}" data-capmode="srt">SRT</button></div>
      <textarea class="cap-input" rows="8" placeholder="${this.capMode === 'srt' ? '1\n00:00:00,000 --> 00:00:02,500\nHalo semuanya!' : 'Tempel naskah di sini. Kalimat akan dibagi rata sepanjang video.'}">${escapeHtml(this.capText || '')}</textarea>
      <div class="ctl ctl-inline"><label>Gaya</label><select class="cap-preset">${TEXT_PRESETS.map((p) => `<option value="${p.id}" ${p.id === (this.capPreset || 'subtitle') ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div>
      <div class="ctl ctl-inline"><label>Posisi</label><select class="cap-pos"><option value="0.36">Bawah</option><option value="0">Tengah</option><option value="-0.36">Atas</option></select></div>
      <div class="btn-row"><button class="btn btn-primary" data-do="makeCaptions">${icon('subtitle', 15)} Buat subtitle</button><button class="btn ghost" data-do="srtFile">${icon('file', 15)} Buka .srt</button></div>
      ${store.P.tracks.some((t) => t.subtitle) ? `<button class="btn sm ghost danger" data-do="clearCaptions">${icon('trash', 14)} Hapus semua subtitle</button>` : ''}`;
  }

  effectPanel() {
    const cats = ['Semua', ...new Set(EFFECTS.map((e) => e.cat))];
    const list = EFFECTS.filter((e) => this.fxCat === 'Semua' || e.cat === this.fxCat);
    return `
      <div class="chip-row">${cats.map((c) => `<button class="chip ${this.fxCat === c ? 'on' : ''}" data-fxcat="${c}">${c}</button>`).join('')}</div>
      <div class="tile-grid">${list.map((f) => `<button class="tile fx-tile" draggable="true" data-effect="${f.id}" style="--a:${f.colors[0]};--b:${f.colors[1]}"><span class="tile-art fx-${f.id}"><b>${f.icon}</b></span><em>${f.name}</em></button>`).join('')}</div>
      <p class="hint">${this.opts.range ? 'Efek dipasang sepanjang klip terpilih.' : 'Ketuk untuk menambah di playhead (3 detik).'}</p>`;
  }

  transitionPanel() {
    const sel = store.selected();
    const list = sortedClips(store.P, 'main');
    const valid = sel && sel.trackId === 'main' && list.indexOf(sel) > 0;
    const cur = valid ? sel.transition?.type : null;
    return `
      <p class="hint">${valid ? `Transisi masuk ke klip <b>${escapeHtml(sel.name || '')}</b>.` : 'Ketuk tombol di antara dua klip di track utama untuk memilih sambungannya.'}</p>
      <div class="tile-grid">${TRANSITIONS.map((t) => `<button class="tile tr-tile ${cur === t.id ? 'on' : ''}" data-transition="${t.id}"><span class="tile-art tr-art tr-${t.id}"><i class="a"></i><i class="b"></i><b class="tr-ic">${t.icon}</b></span><em>${t.name}</em></button>`).join('')}</div>
      <div class="ctl"><label>Durasi transisi: <b class="tr-dur-v">${this.trDuration.toFixed(1)}s</b></label><input type="range" class="tr-dur" min="0.2" max="2" step="0.1" value="${this.trDuration}"></div>
      <button class="btn sm ghost" data-do="trAll">${icon('layers', 14)} Terapkan ke semua klip</button>`;
  }

  filterPanel() {
    const c = actions.targetVisual();
    const cur = c?.filter?.name || 'none';
    return `
      <p class="hint">${c ? `Diterapkan ke: <b>${escapeHtml(c.name || c.type)}</b>` : 'Pilih klip video/foto atau letakkan playhead di atas klip.'}</p>
      ${c && cur !== 'none' ? `<div class="ctl"><label>Intensitas: <b class="flt-v">${Math.round((c.filter.intensity ?? 1) * 100)}%</b></label><input type="range" class="flt-int" min="0" max="100" value="${Math.round((c.filter.intensity ?? 1) * 100)}"></div>` : ''}
      <div class="tile-grid filter-grid">${FILTERS.map((f) => `<button class="tile flt-tile ${cur === f.id ? 'on' : ''}" data-filter="${f.id}"><canvas class="flt-thumb" data-f="${f.id}" width="120" height="80"></canvas><em>${f.name}</em></button>`).join('')}</div>
      <button class="btn sm ghost" data-do="fltAll">${icon('layers', 14)} Terapkan filter ini ke semua klip</button>`;
  }

  aiPanel() {
    const st = bridge.state;
    const base = location.origin;
    const http = `${base}/mcp`;
    const stdio = st.status?.mcp?.stdio;
    const auth = !!st.status?.auth;
    const remote = auth || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const desktopEntry = remote
      ? { command: 'node', args: ['/path/ke/najja-editor/mcp-stdio.js'], env: { NAJJA_URL: base, ...(auth ? { NAJJA_TOKEN: '<TOKEN_AI_KAMU>' } : {}) } }
      : (stdio ? { command: stdio.command, args: stdio.args } : { command: 'node', args: ['/path/ke/najja-editor/mcp-stdio.js'] });
    const desktopCfg = JSON.stringify({ mcpServers: { 'najja-editor': desktopEntry } }, null, 2);
    const ccCmd = `claude mcp add --transport http najja-editor ${http}${auth ? ' --header "Authorization: Bearer <TOKEN_AI_KAMU>"' : ''}`;
    const log = st.log.slice(0, 30);
    return `
      <div class="mcp-status ${st.connected ? 'ok' : st.available === false ? 'off' : 'wait'}">
        <span class="dot"></span>
        <div><b>${st.connected ? 'Server MCP aktif' : st.available === false ? 'Mode offline' : 'Menghubungkan…'}</b>
        <span>${st.connected ? (st.clients.length ? `Agen terhubung: ${st.clients.map((c) => escapeHtml(c.name)).join(', ')}` : 'Menunggu AI agent terhubung') : st.available === false ? 'Jalankan <code>npm start</code> agar AI bisa mengedit lewat MCP.' : ''}</span></div>
      </div>
      <div class="lib-section"><h4>Endpoint MCP (HTTP)</h4>
        <div class="copy-row"><code>${escapeHtml(http)}</code><button class="btn sm" data-copy="${escapeHtml(http)}">${icon('copy', 14)}</button></div></div>
      <div class="lib-section"><h4>Claude Code</h4>
        <div class="copy-row"><code>${escapeHtml(ccCmd)}</code><button class="btn sm" data-copy="${escapeHtml(ccCmd)}">${icon('copy', 14)}</button></div></div>
      <div class="lib-section"><h4>Claude Desktop / Cursor (stdio)</h4>
        <pre class="code">${escapeHtml(desktopCfg)}</pre><button class="btn sm" data-copy="${escapeHtml(desktopCfg)}">${icon('copy', 14)} Salin konfigurasi</button>
        ${remote ? '<p class="hint">mcp-stdio.js dijalankan dari salinan Najja di komputer kamu; ia meneruskan perintah ke server ini.</p>' : ''}</div>
      ${auth ? `<p class="hint">Ganti <code>&lt;TOKEN_AI_KAMU&gt;</code> dengan token AI pribadimu: AI hanya bisa mengedit proyek di akunmu.</p><button class="btn sm" data-aitoken>${icon('ai', 14)} Buat / kelola token AI</button>` : ''}
      <div class="lib-section"><h4>Contoh perintah ke AI</h4>
        ${['Buat video promo 15 detik rasio 9:16 dengan judul "DISKON 50%" dan efek konfeti', 'Tambahkan subtitle dari naskah ini dan beri filter Sinematik ke semua klip', 'Potong klip pertama di detik 4, beri transisi Larut, lalu ekspor 1080p'].map((p) => `<button class="prompt-chip" data-copy="${escapeHtml(p)}">“${escapeHtml(p)}”</button>`).join('')}</div>
      <div class="lib-section"><h4>Aktivitas AI ${log.length ? `<span class="count">${st.log.length}</span>` : ''}</h4>
        ${log.length ? `<ul class="mcp-log">${log.map((l) => `<li class="${l.state}"><span class="lt">${escapeHtml(l.tool)}</span><span class="ls">${l.state === 'ok' ? `${l.ms} ms` : l.state === 'error' ? escapeHtml(l.error || 'gagal') : '…'}</span></li>`).join('')}</ul>` : '<p class="hint">Belum ada perintah dari AI.</p>'}</div>
      <details class="lib-section tools-list"><summary>${(st.status?.tools || []).length} tool tersedia</summary>
        <ul>${(st.status?.tools || []).map((t) => `<li><code>${t.name}</code><span>${escapeHtml(t.description.split('. ')[0])}.</span></li>`).join('')}</ul></details>`;
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
    this.capPreset = this.panel.querySelector('.cap-preset').value;
    const y = Number(this.panel.querySelector('.cap-pos').value);
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
    if (d.copy) { navigator.clipboard?.writeText(d.copy).then(() => toast('Disalin', { type: 'ok' })).catch(() => toast('Gagal menyalin', { type: 'error' })); return; }
    if (d.mfilter) { this.mediaFilter = d.mfilter; this.render(); return; }
    if (d.fxcat) { this.fxCat = d.fxcat; this.render(); return; }
    if (d.capmode) { this.capText = this.panel.querySelector('.cap-input')?.value; this.capMode = d.capmode; this.render(); return; }
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
        const fi = document.createElement('input');
        fi.type = 'file';
        fi.multiple = true;
        fi.accept = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg';
        fi.onchange = () => this.importFiles([...fi.files], { addAt: this.engine.time });
        fi.click();
        break;
      }
      case 'url': this.importUrl(); break;
      case 'record': this.toggleRecord(); break;
      case 'extract': actions.extractAudio(); break;
      case 'makeCaptions': this.makeCaptions(); break;
      case 'srtFile': {
        const fi = document.createElement('input');
        fi.type = 'file';
        fi.accept = '.srt,.vtt,text/plain';
        fi.onchange = async () => { this.capText = await fi.files[0].text(); this.capMode = 'srt'; this.render(); };
        fi.click();
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
      ctx.filter = cssFilterFor(fake);
      ctx.drawImage(this.sample, 0, 0, cv.width, cv.height);
      ctx.filter = 'none';
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
