// Najja Editor — bootstrap and app shell, laid out like a tablet video editor:
// top bar · large preview · control row · timeline (centre playhead) · bottom toolbar · bottom sheets.
import { store, newProject } from './store.js';
import { prefs } from './db.js';
import { storage } from './storage.js';
import { account } from './account.js';
import { remote } from './remote.js';
import { restoreMedia, importFile, detectType, uploadsPending, setCacheGate } from './media.js';
import { Engine } from './engine.js';
import { Player } from './player.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { Library } from './library.js';
import { Sheet, openSheet } from './sheet.js';
import { Toolbar } from './toolbar.js';
import * as actions from './actions.js';
import { tools } from './api.js';
import { bridge } from './bridge.js';
import { exportVideo, exportState, cancelExport, supportedFormats, exportSize } from './exporter.js';
import { fastExportAvailable } from './fastexport.js';
import { RESOLUTIONS, FPS_OPTIONS } from './presets.js';
import { icon, LOGO } from './icons.js';
import { toast, modal, contextMenu, confirmDialog } from './ui.js';
import { escapeHtml, fmtDur, fmtBytes, downloadBlob, fmtTC } from './util.js';

const $ = (s) => document.querySelector(s);
document.documentElement.dataset.theme = 'dark';

// ---------------------------------------------------------------------------------------------
// Shell
const topbar = $('#topbar');
topbar.innerHTML = `
  <div class="tb-left">
    <button class="icon-btn" data-tb="close" title="Proyek saya" aria-label="Tutup proyek">${icon('x', 22)}</button>
    <div class="brand" title="Najja Editor">${LOGO}<span class="wordmark">NAJJA</span></div>
    <div class="proj"><input class="proj-name" aria-label="Nama proyek" spellcheck="false" maxlength="80"><span class="save-state" title="Status penyimpanan"></span></div>
  </div>
  <div class="tb-right">
    <button class="icon-btn" data-tb="search" title="Cari fitur" aria-label="Cari fitur">${icon('search', 20)}</button>
    <button class="icon-btn" data-tb="menu" title="Menu lainnya" aria-label="Menu lainnya">${icon('dots', 20)}</button>
    <button class="mcp-pill" data-tb="mcp" title="AI · MCP">${icon('ai', 15)}<span>MCP</span><i></i></button>
    <button class="avatar-btn" data-tb="account" hidden aria-label="Akun"></button>
    <button class="res-btn" data-tb="res" title="Resolusi dan frame rate ekspor"><span class="res-label">1080p</span>${icon('chevronDown', 14)}</button>
    <button class="btn btn-export" data-tb="export">Ekspor</button>
  </div>`;

const engine = new Engine(document.createElement('canvas'));
// Background downloads of media to this device pause while the preview plays or a frame is being
// captured (the player and the seek need the bandwidth).
setCacheGate(() => !engine.playing && !engine.capturing);
const player = new Player($('#viewer'), engine);
engine.canvas = player.canvas;
engine.ctx = player.canvas.getContext('2d', { alpha: false });
const timeline = new Timeline($('#timeline'), engine);
const inspector = new Inspector(engine);
const library = new Library(engine);
const sheet = new Sheet($('#sheet'));
Object.assign(actions.app, { engine, player, timeline, inspector, library, sheet, toast, openSheet, newProject: createProject, openProject, runExport });
const toolbar = new Toolbar($('#toolbar'), { engine, timeline });
actions.app.toolbar = toolbar;
player.app = actions.app;

// A sheet that edits one clip closes when another clip (or nothing) gets selected.
store.on('selection', (id) => {
  document.body.classList.toggle('has-selection', !!id);
  if (sheet.cur?.bound && sheet.cur.bound !== id) sheet.close();
});
store.on('project', (label) => { if (label === 'load') sheet.close(); });

const nameInput = topbar.querySelector('.proj-name');
const saveState = topbar.querySelector('.save-state');
nameInput.addEventListener('change', () => store.mutate('Ganti nama', (P) => { P.name = nameInput.value.trim() || 'Proyek tanpa judul'; }));
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
const syncName = () => { if (document.activeElement !== nameInput) nameInput.value = store.P.name; document.title = `${store.P.name} · Najja Editor`; };
store.on('project', syncName);
store.on('rename', syncName);
store.on('save', (s) => {
  saveState.className = `save-state ${s}`;
  saveState.innerHTML = s === 'saving' ? '<i class="spin"></i><span>Menyimpan…</span>'
    : s === 'error' ? `${icon('x', 13)}<span>Gagal menyimpan — mencoba lagi…</span>`
      : `${icon('check', 13)}<span>${storage.server ? 'Tersimpan di server' : 'Tersimpan'}</span>`;
});

store.thumbProvider = () => {
  if (store.P.cover?.thumb) return store.P.cover.thumb;
  const src = player.canvas;
  if (!src.width) return undefined;
  const c = document.createElement('canvas');
  c.width = 240;
  c.height = Math.round((240 * src.height) / src.width);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
};

topbar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tb]');
  if (!b) return;
  switch (b.dataset.tb) {
    case 'close': projectsDialog(); break;
    case 'menu': {
      const r = b.getBoundingClientRect();
      contextMenu(r.right - 240, r.bottom + 6, [
        { label: 'Proyek baru', icon: 'plus', run: () => newProjectDialog() },
        { label: 'Proyek saya…', icon: 'folder', kbd: 'Ctrl+O', run: () => projectsDialog() },
        { label: 'Tambah media…', icon: 'upload', kbd: 'Ctrl+I', run: () => openSheet('media', { mode: 'append' }) },
        { label: 'Pengaturan proyek', icon: 'settings', run: () => openSheet('project') },
        'sep',
        { label: 'Ekspor lanjutan…', icon: 'export', kbd: 'Ctrl+E', run: () => exportDialog() },
        { label: 'Simpan proyek (.json)', icon: 'download', run: () => downloadBlob(new Blob([JSON.stringify(store.P, null, 2)], { type: 'application/json' }), `${store.P.name}.najja.json`) },
        'sep',
        ...(installPrompt ? [{ label: 'Pasang sebagai aplikasi', icon: 'download', run: () => installApp() }] : []),
        { label: 'Pintasan keyboard', icon: 'keyboard', kbd: '?', run: () => shortcutsDialog() },
        { label: 'Tentang Najja Editor', icon: 'help', run: () => aboutDialog() },
      ]);
      break;
    }
    case 'search': searchDialog(); break;
    case 'mcp': openSheet('ai'); break;
    case 'res': resPopover(b); break;
    case 'export': quickExport(); break;
    default: break;
  }
});

function updateMcpPill() {
  const pill = topbar.querySelector('.mcp-pill');
  const st = bridge.state;
  pill.classList.toggle('on', !!st.connected);
  pill.classList.toggle('off', st.available === false);
  pill.classList.toggle('busy', st.log[0]?.state === 'run');
  pill.title = st.connected ? `MCP aktif${st.clients.length ? ` · ${st.clients.map((c) => c.name).join(', ')}` : ''}` : st.available === false ? 'MCP offline — jalankan npm start' : 'Menghubungkan MCP…';
}
bridge.on(updateMcpPill);

// ---------------------------------------------------------------------------------------------
// Export settings popover (resolution · frame rate), then "Ekspor" renders straight away.
const expPrefs = () => ({
  resolution: prefs.get('exp.res', '1080p'),
  fps: prefs.get('exp.fps', 0) || store.P.fps || 30,
  quality: prefs.get('exp.q', 'recommended'),
});
const resName = (r) => (r === '2k' ? '2K' : r === '4k' ? '4K' : r);
function syncResLabel() { topbar.querySelector('.res-label').textContent = resName(expPrefs().resolution); }
syncResLabel();

let popEl = null;
function closePopover() { popEl?.remove(); popEl = null; }
function resPopover(anchor) {
  if (popEl) { closePopover(); return; }
  const o = expPrefs();
  popEl = document.createElement('div');
  popEl.className = 'popover res-pop';
  const draw = () => {
    const P = store.P;
    const { width, height } = exportSize(P, o.resolution);
    const bpp = { low: 0.06, recommended: 0.1, high: 0.16 }[o.quality];
    const bytes = (Math.min(60e6, Math.max(1.5e6, width * height * o.fps * bpp)) + 192000) * store.duration() / 8;
    popEl.innerHTML = `
      <div class="pop-row"><label>Resolusi</label><div class="chip-row">${Object.keys(RESOLUTIONS).map((r) => `<button class="chip ${o.resolution === r ? 'on' : ''}" data-res="${r}">${resName(r)}</button>`).join('')}</div></div>
      <div class="pop-row"><label>Frame rate</label><div class="chip-row">${FPS_OPTIONS.map((f) => `<button class="chip ${o.fps === f ? 'on' : ''}" data-fps="${f}">${f}</button>`).join('')}</div></div>
      <div class="pop-row"><label>Kualitas</label><div class="seg wide">${[['low', 'Hemat'], ['recommended', 'Rekomendasi'], ['high', 'Tinggi']].map(([q, n]) => `<button class="${o.quality === q ? 'on' : ''}" data-q="${q}">${n}</button>`).join('')}</div></div>
      <p class="hint">${width}×${height} · ${o.fps} fps · ±${fmtBytes(bytes)} · MP4</p>
      <button class="btn ghost wide" data-more>${icon('settings', 15)} Pengaturan lain…</button>`;
  };
  draw();
  document.body.appendChild(popEl);
  const r = anchor.getBoundingClientRect();
  const w = popEl.offsetWidth;
  popEl.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  popEl.style.top = `${r.bottom + 8}px`;
  popEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.res) { o.resolution = b.dataset.res; prefs.set('exp.res', o.resolution); }
    if (b.dataset.fps) { o.fps = Number(b.dataset.fps); prefs.set('exp.fps', o.fps); }
    if (b.dataset.q) { o.quality = b.dataset.q; prefs.set('exp.q', o.quality); }
    if (b.hasAttribute('data-more')) { closePopover(); exportDialog(); return; }
    syncResLabel();
    draw();
  });
  setTimeout(() => {
    const off = (e) => { if (!popEl?.contains(e.target) && !anchor.contains(e.target)) { closePopover(); window.removeEventListener('pointerdown', off, true); } };
    window.addEventListener('pointerdown', off, true);
  });
}

function quickExport() {
  closePopover();
  if (store.duration() <= 0) { toast('Timeline masih kosong', { type: 'warn' }); return; }
  const rec = supportedFormats();
  const mp4 = rec.mp4 || fastExportAvailable();
  if (!mp4 && !rec.webm) { toast('Browser ini tidak bisa mengekspor video. Gunakan Chrome, Edge, atau Safari terbaru.', { type: 'error', timeout: 5000 }); return; }
  const o = expPrefs();
  runExport({ ...o, format: mp4 ? 'mp4' : 'webm', filename: store.P.name }, { download: true });
}

// ---------------------------------------------------------------------------------------------
// Search: find any tool by name and run it.
function searchDialog() {
  const m = modal({
    title: 'Cari fitur',
    body: `<input type="text" class="search-in" placeholder="mis. transisi, volume, teks, filter…" autocomplete="off"><div class="search-list"></div>`,
  });
  const input = m.el.querySelector('.search-in');
  const listEl = m.el.querySelector('.search-list');
  const extra = [
    { id: 'x-transition', label: 'Transisi', icon: 'transition', where: 'Antar klip utama', run: () => openSheet('transition') },
    { id: 'x-media', label: 'Tambah media', icon: 'upload', where: 'Track utama', run: () => openSheet('media', { mode: 'append' }) },
    { id: 'x-cover', label: 'Sampul', icon: 'cover', where: 'Proyek', run: () => openSheet('cover') },
    { id: 'x-project', label: 'Pengaturan proyek', icon: 'settings', where: 'Proyek', run: () => openSheet('project') },
    { id: 'x-export', label: 'Ekspor video', icon: 'export', where: 'Proyek', run: () => quickExport() },
    { id: 'x-ai', label: 'AI · MCP', icon: 'ai', where: 'Proyek', run: () => openSheet('ai') },
  ];
  let items = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const all = [...toolbar.catalog(), ...extra];
    const seen = new Set();
    items = all.filter((it) => {
      const key = `${it.label}|${it.where}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return !q || it.label.toLowerCase().includes(q) || it.where.toLowerCase().includes(q);
    }).slice(0, 40);
    listEl.innerHTML = items.length ? items.map((it, i) => `<button class="search-item ${it.soon ? 'soon' : ''}" data-i="${i}">${icon(it.icon, 18)}<span>${escapeHtml(it.label)}</span><em>${escapeHtml(it.soon ? 'Segera' : it.where)}</em></button>`).join('')
      : '<p class="hint">Tidak ada fitur dengan nama itu.</p>';
  };
  const run = (it) => {
    if (!it) return;
    m.close();
    if (it.soon) { toast(`${it.label} segera hadir.`, { type: 'info' }); return; }
    try { it.run(); } catch (err) { toast(err.message, { type: 'error' }); }
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(items[0]); });
  listEl.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) run(items[+b.dataset.i]); });
  draw();
  setTimeout(() => input.focus(), 50);
}

// ---------------------------------------------------------------------------------------------
// Installable app (PWA)
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Najja Editor terpasang sebagai aplikasi', { type: 'ok' }); });
async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => null);
  installPrompt = null;
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Touch: no page zoom (pinch belongs to the timeline and the preview); lift sheets above the on-screen keyboard.
document.addEventListener('gesturestart', (e) => e.preventDefault());
if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${kb}px`);
    document.body.classList.toggle('kb-open', kb > 80);
  };
  vv.addEventListener('resize', onVV);
  vv.addEventListener('scroll', onVV);
}

// ---------------------------------------------------------------------------------------------
// Keyboard shortcuts
const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) && !['range', 'checkbox', 'button', 'color'].includes(el.type);
window.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-wrap')) return;
  if (isTyping(document.activeElement)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (k === ' ') { stop(); engine.toggle(); return; }
  if (mod && k === 'z') { stop(); e.shiftKey ? store.redo() : store.undo(); return; }
  if (mod && k === 'y') { stop(); store.redo(); return; }
  if ((mod && k === 'b') || (!mod && k === 's')) { stop(); actions.splitAt(engine.time); return; }
  if (k === 'delete' || k === 'backspace') { stop(); actions.deleteSelected(); return; }
  if (mod && k === 'd') { stop(); if (store.selection) actions.duplicateClip(store.selection); return; }
  if (mod && k === 'c') { stop(); actions.copySelected(); return; }
  if (mod && k === 'v') { stop(); actions.paste(); return; }
  if (mod && k === 'e') { stop(); exportDialog(); return; }
  if (mod && k === 'i') { stop(); openSheet('media', { mode: 'append' }); return; }
  if (mod && k === 'o') { stop(); projectsDialog(); return; }
  if (mod && k === 'k') { stop(); searchDialog(); return; }
  if (mod && k === 's') { stop(); store.save().then(() => toast('Proyek tersimpan', { type: 'ok' })); return; }
  if (mod && (k === '=' || k === '+')) { stop(); timeline.setZoom(timeline.pps * 1.4); return; }
  if (mod && k === '-') { stop(); timeline.setZoom(timeline.pps / 1.4); return; }
  if (mod && k === '0') { stop(); timeline.fit(); return; }
  if (k === 'arrowleft') { stop(); e.shiftKey ? engine.seek(engine.time - 1) : engine.step(-1); return; }
  if (k === 'arrowright') { stop(); e.shiftKey ? engine.seek(engine.time + 1) : engine.step(1); return; }
  if (k === 'home') { stop(); engine.seek(0); return; }
  if (k === 'end') { stop(); engine.seek(store.duration()); return; }
  if (k === 'escape') { if (sheet.cur) sheet.close(); else toolbar.back(); return; }
  if (k === '?' || (e.shiftKey && k === '/')) { stop(); shortcutsDialog(); }
});

// Drop files anywhere: they go to the end of the main track (audio to an audio lane at the playhead).
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (e.defaultPrevented || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files].filter((f) => detectType(f));
  for (const f of files) {
    try {
      const m = await importFile(f);
      actions.addMediaClip(m.id, m.type === 'audio' ? { track: 'audio', start: engine.time } : { track: 'main' });
    } catch (err) { toast(err.message, { type: 'error', timeout: 4500 }); }
  }
});
window.addEventListener('beforeunload', (e) => {
  store.scheduleSave.flush?.();
  if (uploadsPending() || remote.pending > 0) { e.preventDefault(); e.returnValue = ''; }
});

function shortcutsDialog() {
  const rows = [
    ['Spasi', 'Putar / jeda'], ['Ctrl + B  atau  S', 'Bagi klip di playhead'], ['Delete', 'Hapus klip terpilih'], ['Ctrl + D', 'Duplikat klip'],
    ['Ctrl + C / V', 'Salin / tempel klip'], ['Ctrl + Z', 'Urungkan'], ['Ctrl + Shift + Z', 'Ulangi'], ['← / →', 'Mundur / maju 1 frame'],
    ['Shift + ← / →', 'Mundur / maju 1 detik'], ['Home / End', 'Ke awal / akhir'], ['Ctrl + = / -', 'Zoom timeline'], ['Ctrl + 0', 'Sesuaikan timeline'],
    ['Ctrl + scroll / cubit', 'Zoom timeline'], ['Scroll / geser', 'Geser timeline (scrub)'], ['Ctrl + K', 'Cari fitur'], ['Ctrl + E', 'Ekspor lanjutan'],
    ['Ctrl + I', 'Tambah media'], ['Ctrl + O', 'Proyek saya'], ['Esc', 'Tutup panel / kembali'],
  ];
  modal({ title: 'Pintasan keyboard', body: `<div class="kbd-list">${rows.map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`).join('')}</div>` });
}
function aboutDialog() {
  modal({
    title: 'Tentang Najja Editor',
    body: `<div class="about">${LOGO}<div><b>Najja Editor</b><p class="hint">Editor video berbasis web dengan server MCP bawaan. Editing berjalan di browser kamu; proyek dan media tersimpan di server kamu sendiri.</p>
      <p class="hint">Tata letak ramah iPad · Format: MP4/WebM · Resolusi 480p–4K · Font antarmuka: Poppins</p></div></div>`,
  });
}

// ---------------------------------------------------------------------------------------------
// Projects
async function createProject({ name = 'Proyek tanpa judul', aspect = '16:9' } = {}) {
  engine.pause();
  await store.save();
  store.setProject(newProject({ name, aspect }));
  engine.seek(0);
  await store.save();
  timeline.fit();
}

async function openProject(id) {
  engine.pause();
  await store.save();
  const rec = await storage.getProject(id);
  if (!rec) return toast('Proyek tidak ditemukan', { type: 'error' });
  delete rec.thumb;
  delete rec.duration;
  const missing = await restoreMedia(rec);
  store.setProject(rec);
  engine.seek(0);
  timeline.fit();
  if (missing.length) toast(`${missing.length} file media tidak ditemukan${storage.server ? ' di server' : ' di browser ini'}`, { type: 'warn', timeout: 5000 });
}

function newProjectDialog() {
  const ratios = ['16:9', '9:16', '1:1', '4:5', '4:3', '21:9'];
  let pick = '16:9';
  const m = modal({
    title: 'Proyek baru',
    body: `<div class="ctl"><label>Nama</label><input class="np-name" value="Proyek tanpa judul" maxlength="80"></div>
      <div class="ratio-grid">${ratios.map((r) => `<button class="ratio-chip ${r === pick ? 'on' : ''}" data-r="${r}"><i style="aspect-ratio:${r.replace(':', '/')}"></i><b>${r}</b></button>`).join('')}</div>`,
    footer: '<button class="btn" data-x>Batal</button><button class="btn btn-primary" data-go>Buat</button>',
  });
  m.el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-r]');
    if (r) { pick = r.dataset.r; m.el.querySelectorAll('[data-r]').forEach((x) => x.classList.toggle('on', x === r)); }
  });
  m.el.querySelector('[data-x]').onclick = m.close;
  m.el.querySelector('[data-go]').onclick = () => {
    createProject({ name: m.el.querySelector('.np-name').value.trim() || 'Proyek tanpa judul', aspect: pick }).then(() => openSheet('media', { mode: 'append' }));
    m.close();
  };
}

async function projectsDialog() {
  await store.save();
  let list = [];
  try { list = (await storage.listProjects()).sort((a, b) => b.updatedAt - a.updatedAt); } catch (err) { toast(`Gagal memuat daftar proyek: ${err.message}`, { type: 'error' }); }
  const m = modal({
    title: 'Proyek saya',
    wide: true,
    body: `<div class="proj-grid">
      <button class="proj-card new" data-new>${icon('plus', 26)}<b>Proyek baru</b></button>
      ${list.map((p) => `<div class="proj-card ${p.id === store.P.id ? 'current' : ''}" data-open="${p.id}">
        <div class="pc-thumb" style="aspect-ratio:${p.width}/${p.height}">${p.thumb ? `<img src="${p.thumb}" alt="">` : icon('video', 22)}</div>
        <div class="pc-meta"><b>${escapeHtml(p.name)}</b><span>${fmtDur(p.duration || 0)} · ${p.aspect} · ${new Date(p.updatedAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</span></div>
        ${p.id === store.P.id ? '<em>Sedang dibuka</em>' : `<button class="pc-del" data-delp="${p.id}" title="Hapus proyek">${icon('trash', 14)}</button>`}
      </div>`).join('')}</div>`,
  });
  m.el.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delp]');
    if (del) {
      e.stopPropagation();
      if (await confirmDialog('Hapus proyek?', `Proyek ini akan dihapus permanen dari ${storage.server ? 'server' : 'browser'}.`, 'Hapus', true)) {
        await storage.deleteProject(del.dataset.delp);
        del.closest('.proj-card').remove();
      }
      return;
    }
    if (e.target.closest('[data-new]')) { m.close(); newProjectDialog(); return; }
    const card = e.target.closest('[data-open]');
    if (card && card.dataset.open !== store.P.id) { m.close(); openProject(card.dataset.open); }
  });
}

// ---------------------------------------------------------------------------------------------
// Export
function exportDialog() {
  const P = store.P;
  if (store.duration() <= 0) { toast('Timeline masih kosong', { type: 'warn' }); return; }
  const rec = supportedFormats();
  const fast = fastExportAvailable(); // WebCodecs: MP4 faster than real time, even where MediaRecorder lacks MP4
  const fmts = { mp4: rec.mp4 || fast, webm: rec.webm };
  const sel = store.selected();
  const o = { ...expPrefs(), format: fmts.mp4 ? 'mp4' : 'webm', range: 'all' };
  const est = () => {
    const { width, height } = exportSize(P, o.resolution);
    const bpp = { low: 0.06, recommended: 0.1, high: 0.16 }[o.quality];
    const dur = o.range === 'sel' && sel ? sel.duration : store.duration();
    const bytes = (Math.min(60e6, Math.max(1.5e6, width * height * o.fps * bpp)) + 192000) * dur / 8;
    return `${width}×${height} · ${o.fps} fps · ±${fmtBytes(bytes)} · ${fmtDur(dur)}`;
  };
  const m = modal({
    title: 'Ekspor video',
    body: `
      <div class="exp-preview"><canvas class="exp-thumb"></canvas><div><b class="exp-name-l">${escapeHtml(P.name)}</b><span class="exp-est">${est()}</span></div></div>
      <div class="ctl"><label>Nama file</label><input class="exp-name" value="${escapeHtml(P.name)}" maxlength="80"></div>
      <div class="ctl"><label>Resolusi</label><div class="chip-row">${Object.keys(RESOLUTIONS).map((r) => `<button class="chip ${o.resolution === r ? 'on' : ''}" data-res="${r}">${r.toUpperCase().replace('P', 'p')}</button>`).join('')}</div></div>
      <div class="ctl-2">
        <div class="ctl"><label>Frame rate</label><select class="exp-fps">${FPS_OPTIONS.map((f) => `<option ${f === o.fps ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
        <div class="ctl"><label>Format</label><select class="exp-fmt">${fmts.mp4 ? `<option value="mp4" ${o.format === 'mp4' ? 'selected' : ''}>MP4 (H.264)</option>` : ''}${fmts.webm ? '<option value="webm">WebM</option>' : ''}</select></div>
      </div>
      <div class="ctl"><label>Kualitas</label><div class="seg wide">${[['low', 'Rendah'], ['recommended', 'Rekomendasi'], ['high', 'Tinggi']].map(([q, n]) => `<button class="${o.quality === q ? 'on' : ''}" data-q="${q}">${n}</button>`).join('')}</div></div>
      <div class="ctl"><label>Rentang</label><div class="seg wide"><button class="on" data-range="all">Seluruh video</button><button data-range="sel" ${sel ? '' : 'disabled'}>Klip terpilih</button></div></div>
      ${!fmts.mp4 && !fmts.webm ? '<p class="hint danger">Browser ini tidak mendukung perekaman video. Gunakan Chrome atau Edge terbaru.</p>' : `<p class="hint">${fast ? 'MP4 dirender secepat kemampuan perangkat ini (lebih cepat dari durasi video di PC dengan GPU). WebM direkam real-time.' : 'Ekspor berjalan real-time di browser.'} Biarkan tab ini tetap terbuka.</p>`}`,
    footer: `<button class="btn" data-x>Batal</button><button class="btn btn-export" data-go ${!fmts.mp4 && !fmts.webm ? 'disabled' : ''}>${icon('export', 15)} Ekspor</button>`,
  });
  const thumb = m.el.querySelector('.exp-thumb');
  thumb.width = 160;
  thumb.height = Math.round((160 * P.height) / P.width);
  thumb.getContext('2d').drawImage(player.canvas, 0, 0, thumb.width, thumb.height);
  const refresh = () => { m.el.querySelector('.exp-est').textContent = est(); };
  m.el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.res) { o.resolution = b.dataset.res; m.el.querySelectorAll('[data-res]').forEach((x) => x.classList.toggle('on', x === b)); refresh(); }
    if (b.dataset.q) { o.quality = b.dataset.q; m.el.querySelectorAll('[data-q]').forEach((x) => x.classList.toggle('on', x === b)); refresh(); }
    if (b.dataset.range) { o.range = b.dataset.range; m.el.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x === b)); refresh(); }
  });
  m.el.querySelector('.exp-fps').onchange = (e) => { o.fps = Number(e.target.value); refresh(); };
  m.el.querySelector('.exp-fmt').onchange = (e) => { o.format = e.target.value; };
  m.el.querySelector('[data-x]').onclick = m.close;
  m.el.querySelector('[data-go]').onclick = () => {
    prefs.set('exp.res', o.resolution);
    prefs.set('exp.fps', o.fps);
    prefs.set('exp.q', o.quality);
    syncResLabel();
    const filename = m.el.querySelector('.exp-name').value.trim() || P.name;
    m.close();
    runExport({ ...o, filename, range: o.range === 'sel' && sel ? [sel.start, sel.start + sel.duration] : undefined }, { download: true, saveToServer: false });
  };
}

let exportOverlay = null;
async function runExport(opts, { download = true, saveToServer = false, fromAI = false } = {}) {
  exportOverlay?.remove();
  const ov = document.createElement('div');
  ov.className = 'export-overlay';
  ov.innerHTML = `<div class="export-card">
    <div class="ex-ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="bg"/><circle cx="60" cy="60" r="52" class="fg"/></svg><b class="ex-pct">0%</b></div>
    <h3>${fromAI ? 'AI sedang mengekspor video…' : 'Mengekspor video…'}</h3>
    <p class="hint ex-sub">Jangan tutup atau sembunyikan tab ini.</p>
    <div class="ex-actions"><button class="btn" data-cancel>Batal</button></div></div>`;
  document.body.appendChild(ov);
  exportOverlay = ov;
  const fg = ov.querySelector('.fg');
  const C = 2 * Math.PI * 52;
  fg.style.strokeDasharray = `${C}`;
  fg.style.strokeDashoffset = `${C}`;
  ov.querySelector('[data-cancel]').onclick = () => cancelExport();
  let started = performance.now();
  try {
    const res = await exportVideo(engine, opts, (p) => {
      ov.querySelector('.ex-pct').textContent = `${Math.round(p * 100)}%`;
      fg.style.strokeDashoffset = `${C * (1 - p)}`;
      const el = (performance.now() - started) / 1000;
      if (p > 0.03) ov.querySelector('.ex-sub').textContent = `${exportState.mode === 'fast' ? 'Merender cepat' : 'Merender real-time'} · sisa ±${Math.max(0, Math.round(el / p - el))} detik · jangan tutup tab ini`;
    }, (p) => {
      ov.querySelector('.ex-sub').textContent = `Menyiapkan media di perangkat ini… ${Math.round(p * 100)}%`;
      started = performance.now();
    });
    const toServer = (saveToServer || storage.server) && storage.server;
    const saveCopy = () => remote.upload(res.blob, {
      target: 'export', filename: res.filename, mime: res.mime,
      onProgress: (p) => { const el = ov.querySelector('.ex-srv'); if (el) el.textContent = `Menyimpan salinan ke server… ${Math.round(p * 100)}%`; },
    }).then((j) => { exportState.result.serverPath = j.path; exportState.result.serverUrl = j.url; }, (err) => { exportState.result.serverError = err.message; });
    const srvLine = () => (exportState.result?.serverPath ? 'Salinan tersimpan di server ✓'
      : exportState.result?.serverError ? `Gagal menyimpan salinan ke server: ${escapeHtml(exportState.result.serverError)}` : '');
    if (toServer && !download) {
      // AI export: the agent needs the server path, so report "done" only once the file is on the server.
      ov.querySelector('.ex-sub').textContent = 'Menyimpan hasil ekspor ke server…';
      Object.assign(exportState, { state: 'running', phase: 'saving' });
      try { await saveCopy(); } finally { Object.assign(exportState, { state: 'done', phase: null }); }
    }
    // Your own export: the file is yours right away; the server copy uploads in the background.
    if (download) downloadBlob(res.blob, res.filename);
    const took = `${res.mode === 'fast' ? 'Dirender cepat' : 'Dirender real-time'} dalam ${Math.max(1, Math.round(res.seconds))} detik`;
    ov.querySelector('.export-card').innerHTML = `
      <div class="ex-done">${icon('check', 34)}</div>
      <h3>Ekspor selesai</h3>
      <p class="hint">${escapeHtml(res.filename)} · ${res.width}×${res.height} · ${fmtBytes(res.size)}<br>${took}<br><span class="ex-srv">${toServer && download ? 'Menyimpan salinan ke server…' : srvLine()}</span></p>
      <div class="ex-actions"><button class="btn" data-close>Tutup</button><button class="btn btn-primary" data-dl>${icon('download', 15)} Unduh</button></div>`;
    ov.querySelector('[data-dl]').onclick = () => downloadBlob(res.blob, res.filename);
    ov.querySelector('[data-close]').onclick = () => ov.remove();
    if (toServer && download) saveCopy().then(() => { const el = ov.querySelector('.ex-srv'); if (el) el.innerHTML = srvLine(); });
    if (fromAI) setTimeout(() => ov.isConnected && ov.remove(), 6000);
    return res;
  } catch (err) {
    ov.remove();
    toast(err.message, { type: err.message.includes('dibatalkan') ? 'info' : 'error', timeout: 5000 });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// MCP bridge feedback
const AI_LABEL = {
  add_media_clip: 'menambah klip', add_text: 'menambah teks', add_subtitles: 'membuat subtitle', add_sticker: 'menambah stiker', add_solid: 'menambah latar',
  add_effect: 'menambah efek', update_clip: 'mengubah klip', apply_filter: 'memasang filter', apply_transition: 'memasang transisi', split_clip: 'memisah klip',
  delete_clip: 'menghapus klip', move_clip: 'memindah klip', duplicate_clip: 'menduplikat klip', import_media: 'mengimpor media', new_project: 'membuat proyek baru',
  set_project: 'mengubah pengaturan proyek', history: 'urungkan/ulangi', export_video: 'mulai ekspor',
};
bridge.start({
  tools,
  onDone: (tool) => {
    const label = AI_LABEL[tool];
    if (label) toast(`AI ${label}`, { type: 'ai', timeout: 1800 });
    if (store.selection) {
      const el = document.querySelector(`.clip[data-id="${store.selection}"]`);
      if (el) { el.classList.remove('ai-flash'); void el.offsetWidth; el.classList.add('ai-flash'); }
    }
  },
  onClient: (c) => toast(`${c.name} terhubung lewat MCP`, { type: 'ai', timeout: 3500 }),
});

// ---------------------------------------------------------------------------------------------
// Boot
(async function boot() {
  await storage.init();
  if (storage.status?.auth) account.init(topbar.querySelector('.avatar-btn'));
  let lastId = prefs.get('lastProject');
  let loaded = false;
  if (storage.server) {
    const list = await storage.listProjects().catch(() => []);
    if (!list.some((p) => p.id === lastId)) lastId = list[0]?.id || null;
  }
  if (lastId) {
    const rec = await storage.getProject(lastId);
    if (rec) {
      delete rec.thumb;
      delete rec.duration;
      await restoreMedia(rec);
      store.setProject(rec);
      loaded = true;
    }
  }
  if (!loaded) {
    store.setProject(newProject());
    store.save();
  }
  syncName();
  player.layout();
  requestAnimationFrame(() => timeline.fit());
  document.body.classList.add('ready');
}());

export { fmtTC, importFile };
