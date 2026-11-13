// Bottom sheet (iPad layout): panels slide up over the timeline and toolbar while the preview stays visible.
// openSheet(id, opts) knows every panel: asset panels come from Library, clip properties from Inspector,
// plus the media picker (add / overlay / replace / extract audio) and the cover picker.
import { store } from './store.js';
import { importFile, onMediaChange, removeMedia, mediaRT } from './media.js';
import { SOLIDS, GRADIENTS } from './presets.js';
import { icon } from './icons.js';
import { escapeHtml, pickFiles } from './util.js';
import { toast, confirmDialog } from './ui.js';
import * as actions from './actions.js';
import { Library } from './library.js';

export class Sheet {
  constructor(el) {
    this.el = el;
    this.cur = null;
    this.seq = 0;
    el.hidden = true;
    el.addEventListener('click', (e) => { if (e.target.closest('[data-sh="ok"]')) this.close(); });
  }
  get id() { return this.cur?.id || null; }

  /** size: 'dock' covers the timeline + toolbar; 'tall' covers most of the screen. */
  open({ id, title, size = 'dock', bound = null, render, onClose }) {
    this.close(true);
    const seq = ++this.seq;
    this.el.className = `sheet size-${size} sheet-${id}`;
    this.el.innerHTML = `<div class="sh-head"><h3>${escapeHtml(title)}</h3><button class="sh-ok" data-sh="ok" title="Selesai" aria-label="Selesai">${icon('check', 20)}</button></div><div class="sh-body"></div>`;
    this.el.hidden = false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => { if (seq === this.seq) this.el.classList.add('in'); });
    const body = this.el.querySelector('.sh-body');
    this.cur = { id, bound, dispose: null, onClose };
    this.cur.dispose = render(body) || null;
    actions.app.toolbar?.render();
  }

  close(immediate = false) {
    if (!this.cur) return;
    const { dispose, onClose } = this.cur;
    this.cur = null;
    try { dispose?.(); } catch (err) { console.error(err); }
    try { onClose?.(); } catch (err) { console.error(err); }
    document.body.classList.remove('sheet-open');
    this.el.classList.remove('in');
    const seq = ++this.seq;
    if (immediate) { this.el.hidden = true; this.el.innerHTML = ''; } else setTimeout(() => { if (seq === this.seq) { this.el.hidden = true; this.el.innerHTML = ''; } }, 200);
    actions.app.toolbar?.render();
  }
}

// ---------------------------------------------------------------------------------------------
const CLIP_SECTIONS = {
  volume: ['volume', 'Volume'],
  anim: ['anim', 'Animasi'],
  speed: ['speed', 'Kecepatan'],
  crop: ['crop', 'Pangkas'],
  transform: ['transform', 'Transformasi'],
  blend: ['blend', 'Campuran'],
  adjust: ['adjust', 'Sesuaikan'],
  bgremove: ['chroma', 'Hapus latar belakang'],
  text: ['text', 'Teks'],
  sticker: ['sticker', 'Label'],
  'effect-edit': ['effect', 'Efek'],
  solid: ['solid', 'Warna'],
  project: ['project', 'Pengaturan proyek'],
};
const LIB_TABS = ['music', 'sfx', 'record', 'templates', 'caption', 'effect', 'transition', 'filter', 'ai'];
const CLOSE_ON_PICK = ['music', 'sfx', 'templates', 'effect'];

/** Open a panel by id. opts: { tab, mode, range } */
export function openSheet(id, opts = {}) {
  const { sheet, library, inspector } = actions.app;
  if (!sheet) return;
  if (LIB_TABS.includes(id)) {
    sheet.open({
      id,
      title: Library.title(id),
      size: id === 'ai' || id === 'caption' ? 'tall' : 'dock',
      render: (body) => library.mount(body, id, { ...opts, onPick: CLOSE_ON_PICK.includes(id) ? () => sheet.close() : undefined }),
      onClose: opts.onClose,
    });
    return;
  }
  if (CLIP_SECTIONS[id]) {
    const [section, title] = CLIP_SECTIONS[id];
    if (section !== 'project' && !store.selected()) { toast('Pilih klip dulu', { type: 'warn' }); return; }
    sheet.open({
      id,
      title,
      size: id === 'text' ? 'text' : 'dock',
      bound: section === 'project' ? null : store.selection,
      render: (body) => {
        const off = inspector.mount(body, section, opts);
        if (id === 'text' && opts.focus) setTimeout(() => inspector.focusPrimary(), 60);
        return off;
      },
      onClose: opts.onClose,
    });
    return;
  }
  if (id === 'media') { mediaSheet(sheet, opts.mode || 'append'); return; }
  if (id === 'cover') { coverSheet(sheet); return; }
  console.warn('[najja] sheet tidak dikenal:', id);
}

// ---------------------------------------------------------------------------------------------
const MEDIA_MODES = {
  append: { title: 'Tambah media', types: ['video', 'image'], hint: 'Ketuk untuk menambah ke akhir video.' },
  overlay: { title: 'Tambah overlay', types: ['video', 'image'], hint: 'Ketuk untuk menaruh di atas video, mulai dari playhead.' },
  replace: { title: 'Ganti klip', types: ['video', 'image'], hint: 'Ketuk media pengganti. Posisi, durasi, dan efek klip tetap.' },
  extract: { title: 'Ekstrak audio', types: ['video'], hint: 'Ketuk video yang audionya mau dipakai. Audio ditaruh di playhead.' },
};

function mediaSheet(sheet, mode) {
  const M = MEDIA_MODES[mode] || MEDIA_MODES.append;
  const { library, engine } = actions.app;
  let filter = 'all';
  const replaceId = mode === 'replace' ? store.selection : null;
  sheet.open({
    id: 'media',
    title: M.title,
    size: 'tall',
    bound: replaceId,
    render: (body) => {
      const draw = () => {
        const list = store.P.media.filter((m) => !m.stock && M.types.includes(m.type) && (filter === 'all' || m.type === filter)).slice().reverse();
        const chips = M.types.length > 1 ? [['all', 'Semua'], ['video', 'Video'], ['image', 'Foto']]
          .map(([id, n]) => `<button class="chip ${filter === id ? 'on' : ''}" data-mf="${id}">${n}</button>`).join('') : '';
        body.innerHTML = `<div class="lib-body media-picker">
          <div class="mp-top"><div class="chip-row">${chips}</div>
            <div class="mp-actions"><button class="btn ghost" data-do="url" title="Impor dari URL">${icon('link', 16)} URL</button><button class="btn btn-primary" data-do="import">${icon('upload', 16)} Impor dari perangkat</button></div></div>
          <p class="hint">${M.hint}</p>
          ${list.length ? `<div class="media-grid big">${list.map((m) => library.mediaCard(m)).join('')}</div>`
            : `<button class="dropzone" data-do="import">${icon('upload', 28)}<b>Impor video atau foto</b><span>Dari galeri / file di perangkat ini, atau tarik file ke sini</span></button>`}
          ${mode === 'append' ? `<div class="lib-section"><h4>Warna solid</h4><div class="swatch-grid">${SOLIDS.map((c) => `<button class="swatch" data-solid="${c}" style="background:${c}" title="Latar ${c}"></button>`).join('')}</div></div>
          <div class="lib-section"><h4>Gradien</h4><div class="swatch-grid">${GRADIENTS.map(([a, b, ang], i) => `<button class="swatch" data-grad="${i}" style="background:linear-gradient(${ang}deg,${a},${b})" title="Gradien"></button>`).join('')}</div></div>` : ''}
        </div>`;
      };
      const choose = (m, i = 0) => {
        try {
          if (mode === 'append') actions.addMediaClip(m.id, { track: 'main' });
          else if (mode === 'overlay') { const c = actions.addMediaClip(m.id, { track: 'overlay', start: engine.time + i * 0.001 }); store.select(c.id); }
          else if (mode === 'replace') actions.replaceMedia(replaceId, m.id);
          else if (mode === 'extract') actions.addAudioFromMedia(m.id);
          return true;
        } catch (err) { toast(err.message, { type: 'error', timeout: 4000 }); return false; }
      };
      const fromDevice = () => {
        pickFiles({ multiple: mode === 'append' || mode === 'overlay', accept: mode === 'extract' ? 'video/*,.mov,.mkv' : 'video/*,image/*,.mov,.mkv' }).then(async (files) => {
          if (!files.length) return;
          sheet.close();
          const done = toast(files.length > 1 ? `Mengimpor ${files.length} file…` : 'Mengimpor…', { timeout: 0 });
          try {
            let i = 0;
            for (const f of files) {
              try { const m = await importFile(f); if (M.types.includes(m.type)) choose(m, i++); } catch (err) { toast(err.message, { type: 'error', timeout: 4500 }); }
              if (mode === 'replace') break;
            }
          } finally { done(); }
        });
      };
      const onClick = (e) => {
        const b = e.target.closest('button, [data-media]');
        if (!b) return;
        const d = b.dataset;
        if (d.mf) { filter = d.mf; draw(); return; }
        if (d.do === 'import') { fromDevice(); return; }
        if (d.do === 'url') { sheet.close(); library.importUrl(); return; }
        if (d.retry) { e.stopPropagation(); mediaRT.get(d.retry)?.upload?.retry?.(); return; }
        if (d.del) {
          e.stopPropagation();
          const used = store.P.clips.some((c) => c.mediaId === d.del);
          confirmDialog('Hapus media?', used ? 'Media ini dipakai di timeline. Klip yang memakainya juga akan dihapus.' : 'Media akan dihapus dari pustaka proyek.', 'Hapus', true)
            .then((ok) => ok && removeMedia(d.del));
          return;
        }
        if (d.solid) { actions.addSolid({ color: d.solid, track: 'main' }); sheet.close(); return; }
        if (d.grad) { const [a, c2, ang] = GRADIENTS[+d.grad]; actions.addSolid({ color: a, color2: c2, angle: ang, track: 'main' }); sheet.close(); return; }
        const id = d.add || b.closest('[data-media]')?.dataset.media;
        const m = id && store.media(id);
        if (!m) return;
        if (mediaRT.get(m.id)?.status === 'processing') { toast('Media masih diproses, tunggu sebentar', { type: 'warn' }); return; }
        if (choose(m)) sheet.close();
      };
      draw();
      body.addEventListener('click', onClick);
      const off = onMediaChange(() => draw());
      return () => { off(); body.removeEventListener('click', onClick); };
    },
  });
}

function coverSheet(sheet) {
  const { engine, player } = actions.app;
  sheet.open({
    id: 'cover',
    title: 'Sampul',
    size: 'dock',
    render: (body) => {
      const draw = () => {
        const cur = store.P.cover?.thumb;
        body.innerHTML = `<div class="lib-body cover-sheet">
          <div class="cover-row">
            <div class="cover-now">${cur ? `<img src="${cur}" alt="Sampul">` : `<span>${icon('cover', 26)}</span>`}<em>${cur ? 'Sampul sekarang' : 'Belum ada sampul'}</em></div>
            <div class="cover-actions">
              <p class="hint">Geser timeline sampai frame yang kamu mau tepat di garis putih, lalu ketuk tombol di bawah. Sampul dipakai sebagai gambar proyek di daftar proyek.</p>
              <button class="btn btn-primary" data-do="set">${icon('cover', 16)} Pakai frame di playhead</button>
              ${cur ? `<button class="btn ghost" data-do="clear">${icon('x', 15)} Hapus sampul</button>` : ''}
            </div>
          </div></div>`;
      };
      const onClick = (e) => {
        const b = e.target.closest('[data-do]');
        if (!b) return;
        if (b.dataset.do === 'set') {
          engine.pause();
          const src = player.canvas;
          const c = document.createElement('canvas');
          c.width = 320;
          c.height = Math.round((320 * src.height) / Math.max(1, src.width));
          c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
          actions.setCover(c.toDataURL('image/jpeg', 0.75));
          toast('Sampul disimpan', { type: 'ok' });
        } else actions.setCover(null);
        draw();
      };
      draw();
      body.addEventListener('click', onClick);
      return () => body.removeEventListener('click', onClick);
    },
  });
}
