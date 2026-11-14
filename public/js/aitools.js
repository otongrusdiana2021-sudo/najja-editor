// AI tools of the home screen (v1.8): remove a photo's background, upscale a photo — for video thumbnails.
// The work runs on the Najja server (lib/ai.js → ai/server.py). This panel picks the photo, shows the progress, and
// keeps the result: the share sheet on iPad/iPhone (→ "Save Image" to Photos), a download elsewhere, or a project's
// media library.
import { icon } from './icons.js';
import { escapeHtml, pickFiles, downloadBlob, sleep } from './util.js';
import { toast } from './ui.js';

const TOOLS = {
  cutout: {
    title: 'Hapus latar belakang', icon: 'bgRemove', suffix: 'tanpa-latar',
    hint: 'Foto produk atau orang. Latarnya dihapus otomatis — hasilnya PNG transparan, siap ditempel di thumbnail.',
    work: 'Menghapus latar…',
  },
  upscale: {
    title: 'Upscale gambar', icon: 'upscale', suffix: 'upscale',
    hint: 'Perbesar foto 2× atau 4× dengan AI supaya tetap tajam sebagai thumbnail (hasil maks. 4096 px).',
    work: 'Memperbesar…',
  },
};

/** Decode a picked photo (orientation applied), keep it within maxSide, encode PNG (transparency) or JPEG. */
async function preparePhoto(file, maxSide) {
  let src;
  let w;
  let h;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width;
    h = src.height;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      src = new Image();
      src.src = url;
      await src.decode();
      w = src.naturalWidth;
      h = src.naturalHeight;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  if (!w || !h) throw new Error('Gambar tidak bisa dibaca');
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  src.close?.();
  const alpha = /png|webp|gif/i.test(file.type);
  const type = alpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => c.toBlob(r, type, 0.95));
  if (!blob) throw new Error('Gambar tidak bisa diproses');
  return { blob, type, width: c.width, height: c.height, scaledFrom: k < 1 ? { width: w, height: h } : null };
}

export class AiTools {
  /** @param addToProject(file) put a result into a project's media (the app asks which project) */
  constructor({ addToProject, enabled = () => true }) {
    this.deps = { addToProject, enabled };
    this.el = null;
  }

  open(tool) {
    if (!TOOLS[tool]) return;
    this.close();
    this.tool = tool;
    this.scale = 2;
    this.run = null;
    this.el = document.createElement('div');
    this.el.className = 'ai-panel';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', TOOLS[tool].title);
    this.el.innerHTML = `<header class="ai-head">
        <button class="hm-round" data-back aria-label="Kembali">${icon('chevronLeft', 22)}</button>
        <h2>${TOOLS[tool].title}</h2><span class="ai-badge">AI</span>
      </header>
      <div class="ai-body"></div>`;
    document.body.appendChild(this.el);
    requestAnimationFrame(() => this.el?.classList.add('in'));
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    this.showPick();
  }
  close() {
    if (!this.el) return;
    if (this.run && !this.run.finished) this.cancel();
    this.revoke();
    const el = this.el;
    this.el = null;
    el.classList.remove('in');
    setTimeout(() => el.remove(), 220);
  }
  revoke() {
    for (const u of this.urls || []) URL.revokeObjectURL(u);
    this.urls = [];
  }
  url(blob) {
    const u = URL.createObjectURL(blob);
    (this.urls ||= []).push(u);
    return u;
  }
  body(html) { if (this.el) this.el.querySelector('.ai-body').innerHTML = html; }

  // ---- 1. pick a photo ------------------------------------------------------------------------
  async showPick() {
    const T = TOOLS[this.tool];
    this.body(`<div class="ai-pickcard">
        <div class="ai-ic">${icon(T.icon, 40)}</div>
        <b>${T.title}</b>
        <p>${T.hint}</p>
        ${this.tool === 'upscale' ? `<div class="seg ai-scale" role="group" aria-label="Perbesar"><button data-scale="2" class="${this.scale === 2 ? 'on' : ''}">2×</button><button data-scale="4" class="${this.scale === 4 ? 'on' : ''}">4×</button></div>` : ''}
        <button class="btn btn-primary ai-pick" data-pick>${icon('image', 17)} Pilih foto</button>
        <p class="ai-status"></p>
      </div>`);
    this.watchStatus();
  }
  /** Whether the server's AI service is up and its model is there (shown under the button, polled while open). */
  async watchStatus() {
    const tool = this.tool;
    for (let i = 0; this.el && this.tool === tool && this.el.querySelector('.ai-pickcard'); i++) {
      const line = this.el.querySelector('.ai-status');
      const btn = this.el.querySelector('[data-pick]');
      let st = null;
      if (!this.deps.enabled()) {
        line.textContent = 'Alat AI butuh server Najja (editor ini berjalan tanpa server).';
        btn.disabled = true;
        return;
      }
      try { st = await (await fetch('/api/ai', { cache: 'no-store', credentials: 'same-origin' })).json(); } catch { st = null; }
      if (!this.el || this.tool !== tool) return;
      const t = st?.tools?.[tool];
      if (!st?.available) {
        line.textContent = st?.reason || 'Layanan AI di server belum siap.';
        line.className = 'ai-status warn';
        btn.disabled = true;
      } else if (t?.state === 'downloading') {
        line.textContent = `Model AI sedang diunduh ke server (${Math.round((t.progress || 0) * 100)}%) — sekali saja. Kamu bisa langsung memilih foto.`;
        line.className = 'ai-status';
        btn.disabled = false;
      } else {
        line.textContent = t?.state === 'ready' ? `Diproses di server Najja · ${t.model}` : 'Model AI diunduh ke server saat pertama dipakai (sekali saja).';
        line.className = 'ai-status';
        btn.disabled = false;
        if (t?.state === 'ready') return;
      }
      await sleep(i < 10 ? 2000 : 5000);
    }
  }

  async onClick(e) {
    const t = (s) => e.target.closest(s);
    let b;
    if (t('[data-back]')) return this.close();
    if ((b = t('[data-scale]'))) {
      this.scale = Number(b.dataset.scale);
      this.el.querySelectorAll('[data-scale]').forEach((x) => x.classList.toggle('on', x === b));
      return undefined;
    }
    if (t('[data-pick]')) return this.pick();
    if (t('[data-cancel]')) { this.cancel(); return this.showPick(); }
    if (t('[data-again]')) return this.showPick();
    if (t('[data-retry]')) return this.start(this.lastFile);
    if (t('[data-save]')) return this.save();
    if (t('[data-add]')) return this.add();
    return undefined;
  }

  async pick() {
    const [file] = await pickFiles({ accept: 'image/*' });
    if (!file || !this.el) return;
    this.lastFile = file;
    this.start(file);
  }

  // ---- 2. send it, follow the progress ---------------------------------------------------------
  async start(file) {
    if (!file || !this.el) return;
    const T = TOOLS[this.tool];
    const run = { finished: false, id: null };
    this.run = run;
    this.revoke();
    const base = (file.name || 'foto').replace(/\.[^.]+$/, '').slice(0, 60) || 'foto';
    this.body(`<div class="ai-stage"><div class="ai-photo"><img alt=""><div class="ai-scan"></div></div>
        <div class="ai-prog"><div class="ai-bar"><i></i></div><span class="ai-prog-l">Menyiapkan foto…</span></div>
        <button class="btn" data-cancel>Batal</button></div>`);
    try {
      const maxSide = this.tool === 'upscale' ? (this.scale === 4 ? 1024 : 2048) : 4096;
      const prep = await preparePhoto(file, maxSide);
      if (this.run !== run) return;
      this.el.querySelector('.ai-photo img').src = this.url(prep.blob);
      this.progress(0.02, 'Mengirim ke server…');
      const q = new URLSearchParams({ name: base, ...(this.tool === 'upscale' ? { scale: String(this.scale) } : {}) });
      const r = await fetch(`/api/ai/${this.tool}?${q}`, { method: 'POST', body: prep.blob, headers: { 'content-type': prep.type }, credentials: 'same-origin' });
      const rec = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(rec.error || `HTTP ${r.status}`);
      run.id = rec.id;
      let x = rec;
      while (this.run === run && !['done', 'failed', 'cancelled'].includes(x.state)) {
        this.progress(x.progress, x.stage === 'download' ? 'Mengunduh model AI ke server (sekali saja)…' : x.state === 'queued' ? 'Menunggu giliran…' : T.work);
        await sleep(600);
        const rr = await fetch(`/api/ai/${rec.id}`, { cache: 'no-store', credentials: 'same-origin' });
        if (!rr.ok) throw new Error('Permintaan tidak ditemukan');
        x = await rr.json();
      }
      if (this.run !== run) return;
      run.finished = true;
      if (x.state !== 'done') throw new Error(x.error || 'gagal');
      this.progress(1, 'Selesai');
      const blob = await (await fetch(x.resultUrl, { credentials: 'same-origin' })).blob();
      if (this.run !== run) return;
      const ext = blob.type === 'image/png' ? 'png' : 'jpg';
      this.result = { rec: x, blob, file: new File([blob], `${base}-${T.suffix}${this.tool === 'upscale' ? `-${x.scale || this.scale}x` : ''}.${ext}`, { type: blob.type }), before: prep };
      this.showResult();
    } catch (err) {
      if (this.run !== run || !this.el) return;
      run.finished = true;
      this.body(`<div class="ai-pickcard"><div class="ai-ic err">${icon('x', 36)}</div><b>Gagal memproses</b><p>${escapeHtml(err.message || String(err))}</p>
        <button class="btn btn-primary" data-retry>Coba lagi</button><button class="btn" data-again>Pilih foto lain</button></div>`);
    }
  }
  progress(p, label) {
    if (!this.el) return;
    const pct = Math.max(0, Math.min(100, Math.round((p || 0) * 100)));
    const bar = this.el.querySelector('.ai-bar i');
    if (bar) bar.style.width = `${Math.max(3, pct)}%`;
    const l = this.el.querySelector('.ai-prog-l');
    if (l) l.textContent = pct > 2 && pct < 100 ? `${label} ${pct}%` : label;
  }
  cancel() {
    const run = this.run;
    this.run = null;
    if (run?.id && !run.finished) fetch(`/api/ai/${run.id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  }

  // ---- 3. the result: compare, save, add to a project -----------------------------------------
  showResult() {
    const { rec, blob, before } = this.result;
    const afterUrl = this.url(blob);
    const beforeUrl = this.el.querySelector('.ai-photo img')?.src || this.url(before.blob);
    const src = before.scaledFrom || before;
    const info = this.tool === 'upscale'
      ? `${src.width}×${src.height} → <b>${rec.result.width}×${rec.result.height}</b>`
      : `<b>${rec.result.width}×${rec.result.height}</b> · PNG transparan`;
    this.body(`<div class="ai-result">
        <div class="ai-compare ${this.tool === 'cutout' ? 'checker' : ''}" style="--pos:50%">
          <img class="ai-after" src="${afterUrl}" alt="Hasil" draggable="false">
          <div class="ai-before"><img src="${beforeUrl}" alt="Asli" draggable="false"></div>
          <div class="ai-handle" aria-hidden="true"><span>${icon('chevronLeft', 14)}${icon('chevronRight', 14)}</span></div>
          <em class="ai-lbl l">Asli</em><em class="ai-lbl r">Hasil</em>
        </div>
        <p class="ai-info">${info} · ${((rec.result.ms || 0) / 1000).toFixed(1).replace('.', ',')} dtk · ketuk gambar untuk zoom</p>
        <div class="ai-actions">
          <button class="btn btn-primary" data-save>${icon('download', 17)} Simpan</button>
          <button class="btn" data-add>${icon('plus', 17)} Tambahkan ke proyek</button>
          <button class="btn" data-again>${icon('image', 17)} Foto lain</button>
        </div>
      </div>`);
    const box = this.el.querySelector('.ai-compare');
    // as large as fits (width of the panel, 60% of the height), keeping the picture's proportions
    const fit = () => {
      if (!box.isConnected) { window.removeEventListener('resize', fit); return; }
      const maxW = Math.min(820, this.el.querySelector('.ai-body').clientWidth - 32);
      const k = Math.min(maxW / rec.result.width, (innerHeight * 0.6) / rec.result.height);
      box.style.width = `${Math.round(rec.result.width * k)}px`;
      box.style.height = `${Math.round(rec.result.height * k)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    this.bindCompare(box);
  }
  /** Drag the line to compare; a tap (no drag) zooms in where tapped, a second tap zooms out. */
  bindCompare(box) {
    let down = null;
    const set = (e) => {
      const r = box.getBoundingClientRect();
      box.style.setProperty('--pos', `${Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100))}%`);
    };
    box.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, moved: false }; box.setPointerCapture(e.pointerId); });
    box.addEventListener('pointermove', (e) => {
      if (!down) return;
      if (Math.abs(e.clientX - down.x) > 6) down.moved = true;
      if (down.moved && !box.classList.contains('zoom')) set(e);
    });
    box.addEventListener('pointerup', (e) => {
      if (down && !down.moved) {
        const r = box.getBoundingClientRect();
        box.style.setProperty('--zx', `${((e.clientX - r.left) / r.width) * 100}%`);
        box.style.setProperty('--zy', `${((e.clientY - r.top) / r.height) * 100}%`);
        box.classList.toggle('zoom');
      }
      down = null;
    });
  }
  async save() {
    const { file, blob } = this.result || {};
    if (!file) return;
    // iPad/iPhone: the share sheet ("Save Image" puts it in Photos); elsewhere a download
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name }); return; } catch (err) { if (err?.name === 'AbortError') return; }
    }
    downloadBlob(blob, file.name);
    toast(`Disimpan: ${file.name}`, { type: 'ok', timeout: 2500 });
  }
  async add() {
    if (!this.result?.file) return;
    const done = await this.deps.addToProject(this.result.file);
    if (done) this.close();
  }
}
