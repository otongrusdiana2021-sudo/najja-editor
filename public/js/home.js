// Home screen (v1.8): the first screen. Projects to continue, a new project, and two AI tools for thumbnails
// (background removal, upscaling). Laid out like the tablet home of mobile video editors — hero, a big "new project"
// card, tools, a grid of projects — drawn in Najja's own colours, font (Poppins) and artwork.
import { storage } from './storage.js';
import { prefs } from './db.js';
import { icon, MARK_PATHS } from './icons.js';
import { escapeHtml, uid, clone } from './util.js';
import { toast, contextMenu, confirmDialog, modal } from './ui.js';

const SORTS = {
  edited: ['Terakhir diubah', (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)],
  created: ['Terakhir dibuat', (a, b) => (b.createdAt || 0) - (a.createdAt || 0)],
  name: ['Nama (A–Z)', (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id')],
  size: ['Ukuran terbesar', (a, b) => (b.size || 0) - (a.size || 0)],
};

/** "3927MB", "640KB" (as project cards show it). */
export function cardSize(b) {
  if (!b) return null;
  if (b >= 1048576) return `${Math.round(b / 1048576)}MB`;
  return `${Math.max(1, Math.round(b / 1024))}KB`;
}
/** "02:11", "1:02:11". */
export function cardDur(t) {
  const s = Math.max(0, Math.round(t || 0));
  const p = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

// Hero artwork: a tablet with the Najja editor (preview + timeline lanes in the editor's colours) and the brand tile.
const ART = `<svg class="hm-art-svg" viewBox="0 0 420 300" aria-hidden="true">
  <defs>
    <linearGradient id="hmScreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f1f23"/><stop offset="1" stop-color="#141417"/></linearGradient>
    <linearGradient id="hmPrev" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#173f45"/><stop offset="1" stop-color="#0d2226"/></linearGradient>
    <linearGradient id="hmTile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1b1f"/><stop offset="1" stop-color="#0b0b0d"/></linearGradient>
    <radialGradient id="hmGlow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#47c9d7" stop-opacity="0.35"/><stop offset="1" stop-color="#47c9d7" stop-opacity="0"/></radialGradient>
    <linearGradient id="hmFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#47c9d7" stop-opacity="0.22"/><stop offset="1" stop-color="#47c9d7" stop-opacity="0"/></linearGradient>
  </defs>
  <ellipse cx="210" cy="250" rx="190" ry="34" fill="url(#hmFloor)"/>
  <circle cx="230" cy="120" r="140" fill="url(#hmGlow)"/>
  <g transform="rotate(-4 200 130)">
    <rect x="40" y="26" width="300" height="196" rx="18" fill="#0a0a0c" stroke="#36363d" stroke-width="2"/>
    <rect x="50" y="36" width="280" height="176" rx="10" fill="url(#hmScreen)"/>
    <rect x="58" y="44" width="40" height="6" rx="3" fill="#36363d"/><rect x="288" y="43" width="34" height="9" rx="4.5" fill="#47c9d7"/>
    <rect x="58" y="58" width="58" height="72" rx="5" fill="#26262b"/>
    <rect x="62" y="62" width="23" height="23" rx="3" fill="#2f4d63"/><rect x="89" y="62" width="23" height="23" rx="3" fill="#4c3a5e"/>
    <rect x="62" y="89" width="23" height="23" rx="3" fill="#5c4a2a"/><rect x="89" y="89" width="23" height="23" rx="3" fill="#2a5a4a"/>
    <rect x="124" y="58" width="128" height="72" rx="5" fill="url(#hmPrev)"/>
    <path d="M168 120c0-17 9-29 20-29s20 12 20 29z" fill="#e8b4c8"/><rect x="171" y="98" width="34" height="24" rx="5" fill="#f4d1dc"/>
    <circle cx="178" cy="106" r="2.4" fill="#d16d97"/><circle cx="188" cy="112" r="2.4" fill="#d16d97"/><circle cx="198" cy="105" r="2.4" fill="#d16d97"/>
    <path d="M178 98c0-8 5-12 10-12s10 4 10 12" fill="none" stroke="#e8b4c8" stroke-width="3"/>
    <rect x="260" y="58" width="62" height="72" rx="5" fill="#26262b"/>
    <rect x="266" y="66" width="44" height="4" rx="2" fill="#47c9d7"/><rect x="266" y="76" width="50" height="3" rx="1.5" fill="#36363d"/><rect x="266" y="84" width="38" height="3" rx="1.5" fill="#36363d"/><circle cx="300" cy="104" r="9" fill="none" stroke="#47c9d7" stroke-width="3"/>
    <rect x="58" y="138" width="264" height="66" rx="5" fill="#161619"/>
    <rect x="72" y="146" width="96" height="14" rx="3" fill="#23434a"/><rect x="170" y="146" width="70" height="14" rx="3" fill="#23434a"/><rect x="242" y="146" width="72" height="14" rx="3" fill="#23434a"/>
    <rect x="96" y="164" width="64" height="9" rx="3" fill="#4c9a3c"/><rect x="200" y="164" width="44" height="9" rx="3" fill="#d0701a"/>
    <rect x="72" y="177" width="150" height="9" rx="3" fill="#148a9c"/><rect x="232" y="177" width="56" height="9" rx="3" fill="#7a55d8"/>
    <rect x="72" y="190" width="60" height="7" rx="3" fill="#b84bd0" opacity="0.8"/>
    <rect x="178" y="141" width="2" height="60" rx="1" fill="#fff"/><path d="M174 140h10l-5 5z" fill="#fff"/>
  </g>
  <g transform="translate(296 168)">
    <rect width="92" height="92" rx="22" fill="url(#hmTile)" stroke="#47c9d7" stroke-opacity="0.55" stroke-width="2"/>
    <g transform="translate(17 10) scale(0.58)" fill="none" stroke="#47C9D7" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${MARK_PATHS}</g>
    <text x="46" y="82" text-anchor="middle" font-family="Raleway, Poppins, sans-serif" font-size="11" letter-spacing="3" fill="#ececf0">NAJJA</text>
  </g>
</svg>`;

export class Home {
  /**
   * @param el            the <main id="home"> element
   * @param open(id)      open a project in the editor
   * @param create()      start a new project (dialog)
   * @param currentId()   id of the project loaded in the editor (null: none)
   * @param tools         { open(tool) } the AI tool panel
   * @param onDeleted(id) a project was deleted (the editor may have it open)
   * @param onRenamed(id, name)
   */
  constructor(el, { open, create, currentId, tools, onDeleted, onRenamed }) {
    this.el = el;
    this.deps = { open, create, currentId, tools, onDeleted, onRenamed };
    this.list = [];
    this.loaded = false;
    this.query = '';
    this.sort = SORTS[prefs.get('homeSort')] ? prefs.get('homeSort') : 'edited';
    this.selecting = false;
    this.selected = new Set();
    this.render();
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('input', (e) => { if (e.target.matches('.hm-search input')) { this.query = e.target.value.trim().toLowerCase(); this.renderGrid(); } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target.matches('.hm-search input')) this.toggleSearch(false); });
  }
  get visible() { return !this.el.hidden; }

  async show() {
    this.el.hidden = false;
    document.body.classList.add('at-home');
    this.el.querySelector('.hm-scroll').scrollTop = 0;
    await this.refresh();
  }
  hide() {
    this.el.hidden = true;
    document.body.classList.remove('at-home');
    this.setSelecting(false);
    this.toggleSearch(false);
  }

  async refresh() {
    try {
      this.list = await storage.listProjects();
      this.loaded = true;
    } catch (err) {
      toast(`Gagal memuat daftar proyek: ${err.message}`, { type: 'error' });
    }
    this.renderGrid();
  }

  render() {
    this.el.innerHTML = `<div class="hm-scroll">
      <header class="hm-hero">
        <div class="hm-top">
          <div class="hm-brand"><svg viewBox="0 0 100 100" fill="none" stroke="#47C9D7" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MARK_PATHS}</svg><span class="wordmark">NAJJA</span><em>Editor</em></div>
          <div class="hm-search"><input type="search" placeholder="Cari proyek" aria-label="Cari proyek" enterkeyhint="search"><button class="hm-round" data-search aria-label="Cari proyek">${icon('search', 21)}</button></div>
        </div>
        <div class="hm-art">${ART}</div>
        <div class="hm-tag"><span>Lebih cepat. Lebih rapi.</span><b>Video produk yang menjual</b></div>
        <button class="hm-new" data-new><i>${icon('plus', 26)}</i><b>Proyek baru</b></button>
      </header>
      <section class="hm-tools" aria-label="Alat">
        <button class="hm-tool" data-tool="cutout">${icon('bgRemove', 30)}<b>Hapus latar belakang</b></button>
        <button class="hm-tool" data-tool="upscale">${icon('upscale', 30)}<b>Upscale gambar</b></button>
      </section>
      <section class="hm-projects" aria-label="Proyek">
        <div class="hm-ph">
          <h2>Proyek</h2>
          <div class="hm-actions">
            <button class="hm-pill" data-sort>${icon('menu', 15)}<span class="hm-sort-l">${SORTS[this.sort][0]}</span></button>
            <button class="hm-pill" data-select>${icon('check', 15)}<span>Pilih</span></button>
          </div>
        </div>
        <div class="hm-grid"></div>
      </section>
    </div>
    <div class="hm-selbar" role="toolbar" aria-label="Proyek terpilih">
      <span class="hm-selcount">0 dipilih</span>
      <button class="btn" data-selcancel>Batal</button>
      <button class="btn btn-danger" data-seldel>${icon('trash', 15)} Hapus</button>
    </div>`;
    this.renderGrid();
  }

  /** Projects matching the search, in the chosen order. */
  shown() {
    const q = this.query;
    return this.list.filter((p) => !q || String(p.name || '').toLowerCase().includes(q)).sort(SORTS[this.sort][1]);
  }

  renderGrid() {
    const grid = this.el.querySelector('.hm-grid');
    if (!grid) return;
    if (!this.loaded) {
      grid.innerHTML = Array.from({ length: 6 }, () => '<div class="hm-card skel"><div class="hm-thumb"></div><div class="hm-meta"><span></span></div></div>').join('');
      return;
    }
    const items = this.shown();
    const cur = this.deps.currentId();
    if (!items.length) {
      grid.innerHTML = `<div class="hm-empty">${this.query ? `Tidak ada proyek bernama “${escapeHtml(this.query)}”.` : 'Belum ada proyek. Ketuk <b>Proyek baru</b> untuk mulai.'}</div>`;
      return;
    }
    grid.innerHTML = items.map((p) => {
      const size = cardSize(p.size);
      const sel = this.selected.has(p.id);
      return `<div class="hm-card ${p.id === cur ? 'current' : ''} ${sel ? 'sel' : ''}" data-id="${escapeHtml(p.id)}">
        <button class="hm-thumb" data-open="${escapeHtml(p.id)}" aria-label="Buka ${escapeHtml(p.name || 'proyek')}">
          ${p.thumb ? `<img src="${p.thumb}" alt="" loading="lazy" draggable="false">` : `<span class="hm-ph-ic">${icon('video', 28)}</span>`}
          <span class="hm-check" aria-hidden="true">${icon('check', 16)}</span>
        </button>
        <div class="hm-meta"><span>${size ? `${size}<i>|</i>` : ''}${cardDur(p.duration)}</span><button class="hm-more" data-more="${escapeHtml(p.id)}" aria-label="Pilihan proyek">${icon('dots', 18)}</button></div>
        <div class="hm-name" title="${escapeHtml(p.name || '')}">${escapeHtml(p.name || 'Tanpa judul')}</div>
      </div>`;
    }).join('');
  }

  async onClick(e) {
    const t = (sel) => e.target.closest(sel);
    let b;
    if (t('[data-new]')) return this.deps.create();
    if ((b = t('[data-tool]'))) return this.deps.tools.open(b.dataset.tool);
    if (t('[data-search]')) return this.toggleSearch();
    if ((b = t('[data-sort]'))) return this.sortMenu(b);
    if (t('[data-select]')) return this.setSelecting(!this.selecting);
    if (t('[data-selcancel]')) return this.setSelecting(false);
    if (t('[data-seldel]')) return this.deleteMany([...this.selected]);
    if ((b = t('[data-more]'))) return this.moreMenu(b.dataset.more, b);
    if ((b = t('[data-open]'))) {
      const id = b.dataset.open;
      if (this.selecting) {
        if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
        b.closest('.hm-card').classList.toggle('sel', this.selected.has(id));
        this.updateSelbar();
        return;
      }
      b.closest('.hm-card').classList.add('opening');
      await this.deps.open(id);
    }
    return undefined;
  }

  toggleSearch(on = !this.el.querySelector('.hm-search').classList.contains('on')) {
    const box = this.el.querySelector('.hm-search');
    box.classList.toggle('on', on);
    const input = box.querySelector('input');
    if (on) input.focus();
    else if (this.query) { input.value = ''; this.query = ''; this.renderGrid(); }
  }

  sortMenu(btn) {
    const r = btn.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 6, Object.entries(SORTS).map(([k, [label]]) => ({
      label, icon: k === this.sort ? 'check' : undefined,
      run: () => { this.sort = k; prefs.set('homeSort', k); this.el.querySelector('.hm-sort-l').textContent = label; this.renderGrid(); },
    })));
  }

  setSelecting(on) {
    this.selecting = on;
    this.selected.clear();
    this.el.classList.toggle('selecting', on);
    this.el.querySelector('[data-select] span').textContent = on ? 'Selesai' : 'Pilih';
    this.el.querySelectorAll('.hm-card.sel').forEach((c) => c.classList.remove('sel'));
    this.updateSelbar();
  }
  updateSelbar() {
    this.el.querySelector('.hm-selcount').textContent = `${this.selected.size} dipilih`;
    this.el.querySelector('[data-seldel]').disabled = !this.selected.size;
  }

  moreMenu(id, btn) {
    const p = this.list.find((x) => x.id === id);
    if (!p) return;
    const r = btn.getBoundingClientRect();
    contextMenu(Math.max(8, r.right - 220), r.bottom + 4, [
      { label: 'Buka', icon: 'edit', run: () => this.deps.open(id) },
      { label: 'Ganti nama', icon: 'textAdd', run: () => this.rename(p) },
      { label: 'Duplikat', icon: 'copy', run: () => this.duplicate(p) },
      'sep',
      { label: 'Hapus', icon: 'trash', danger: true, run: () => this.deleteMany([id]) },
    ]);
  }

  async rename(p) {
    const name = await promptName('Ganti nama proyek', p.name || '');
    if (name == null || name === p.name) return;
    try {
      if (p.id === this.deps.currentId()) await this.deps.onRenamed(p.id, name);
      else {
        const rec = await storage.getProject(p.id);
        if (!rec) throw new Error('proyek tidak ditemukan');
        rec.name = name;
        rec.updatedAt = Date.now();
        await storage.putProject(rec, { baseRev: rec.rev ?? null });
      }
      p.name = name;
      this.renderGrid();
    } catch (err) {
      toast(`Gagal mengganti nama: ${err.message}`, { type: 'error' });
    }
  }

  async duplicate(p) {
    try {
      const rec = await storage.getProject(p.id);
      if (!rec) throw new Error('proyek tidak ditemukan');
      const copy = clone(rec);
      delete copy.rev;
      delete copy.ownerId;
      copy.id = uid('p');
      copy.name = `${rec.name || 'Proyek'} (salinan)`;
      copy.createdAt = copy.updatedAt = Date.now();
      await storage.putProject(copy);
      toast('Proyek diduplikat', { type: 'ok', timeout: 2000 });
      await this.refresh();
    } catch (err) {
      toast(`Gagal menduplikat: ${err.message}`, { type: 'error' });
    }
  }

  async deleteMany(ids) {
    if (!ids.length) return;
    const one = ids.length === 1 ? this.list.find((x) => x.id === ids[0]) : null;
    const ok = await confirmDialog(one ? 'Hapus proyek?' : `Hapus ${ids.length} proyek?`,
      `${one ? `“${one.name || 'Tanpa judul'}” akan` : 'Proyek ini akan'} dihapus permanen dari ${storage.server ? 'server' : 'browser'}. Media di pustaka tidak ikut terhapus.`, 'Hapus', true);
    if (!ok) return;
    let failed = 0;
    for (const id of ids) {
      try {
        await storage.deleteProject(id);
        await this.deps.onDeleted(id);
      } catch { failed++; }
    }
    if (failed) toast(`${failed} proyek gagal dihapus`, { type: 'error' });
    this.setSelecting(false);
    await this.refresh();
  }
}

/** A small "name" dialog. Resolves the trimmed name, or null when cancelled. */
export function promptName(title, value = '') {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      body: `<div class="ctl"><label>Nama</label><input class="pn-name" value="${escapeHtml(value)}" maxlength="80"></div>`,
      footer: '<button class="btn" data-x>Batal</button><button class="btn btn-primary" data-ok>Simpan</button>',
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    const input = m.el.querySelector('.pn-name');
    const ok = () => { if (done) return; done = true; const v = input.value.trim(); m.close(); resolve(v || null); };
    m.el.querySelector('[data-x]').onclick = () => m.close();
    m.el.querySelector('[data-ok]').onclick = ok;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}
