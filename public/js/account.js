// Account menu (VPS mode): who is logged in, personal AI token, change password, manage users, log out.
import { icon } from './icons.js';
import { modal, toast, contextMenu, confirmDialog } from './ui.js';
import { escapeHtml, fmtBytes } from './util.js';
import { deviceCache } from './devicecache.js';
import { clearDeviceCache } from './media.js';

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/me/password') { location.href = '/login'; throw new Error('Sesi habis'); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export const account = {
  me: null,
  btn: null,

  async init(btn) {
    this.btn = btn;
    try { this.me = await api('/api/me'); } catch { this.me = null; }
    if (!this.me || this.me.via !== 'session') return;
    btn.hidden = false;
    btn.textContent = this.me.email[0].toUpperCase();
    btn.title = this.me.email;
    btn.addEventListener('click', () => this.menu());
  },

  menu() {
    const r = this.btn.getBoundingClientRect();
    contextMenu(r.right - 230, r.bottom + 6, [
      { label: this.me.email, icon: 'ai', disabled: true },
      'sep',
      { label: 'Token AI (MCP)', icon: 'ai', run: () => this.aiToken() },
      { label: 'Ganti password', icon: 'lock', run: () => this.changePassword() },
      ...(this.me.role === 'admin' ? [{ label: 'Kelola pengguna', icon: 'layers', run: () => this.users() }] : []),
      { label: 'Penyimpanan perangkat', icon: 'download', run: () => this.storage() },
      'sep',
      { label: 'Keluar', icon: 'x', danger: true, run: () => { location.href = '/logout'; } },
    ]);
  },

  /** Videos kept on this device so a refresh does not download them again (max 5 GB). */
  async storage() {
    const m = modal({ title: 'Penyimpanan perangkat', body: '<div class="dc-body"><p class="hint">Memuat…</p></div>' });
    const body = m.el.querySelector('.dc-body');
    const render = async () => {
      if (!(await deviceCache.available())) {
        body.innerHTML = '<p class="hint">Browser ini tidak menyediakan penyimpanan permanen (misalnya jendela penyamaran). Video diputar langsung dari server.</p>';
        return;
      }
      const list = (await deviceCache.list()).sort((a, b) => b.lastUsed - a.lastUsed);
      const used = list.reduce((a, e) => a + e.size, 0);
      const limit = deviceCache.limit();
      const persisted = await deviceCache.persisted();
      const ago = (t) => (t ? new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : '—');
      body.innerHTML = `
        <p class="hint">Video dari server disimpan di perangkat ini supaya saat refresh atau buka ulang tidak perlu diunduh lagi. File asli tetap aman di server; menghapus salinan ini tidak menghilangkan apa pun.</p>
        <div class="dc-bar"><i style="width:${Math.min(100, (used / limit) * 100).toFixed(1)}%"></i></div>
        <div class="dc-meta"><b>${fmtBytes(used)}</b> dari ${fmtBytes(limit)} · ${persisted ? 'tersimpan permanen ✓' : 'bisa dibersihkan browser saat disk penuh'}</div>
        <div class="dc-list">${list.length ? list.map((e) => `<div class="user-row"><div><b>${escapeHtml(e.name || e.id)}</b><span>${fmtBytes(e.size)}${e.complete ? '' : ` · terunduh ${Math.round((e.size / Math.max(1, e.total)) * 100)}%`} · dipakai ${ago(e.lastUsed)}</span></div></div>`).join('') : '<p class="hint">Belum ada video tersimpan.</p>'}</div>
        ${list.length ? `<button class="btn" data-clear>${icon('x', 14)} Hapus semua salinan</button>` : ''}`;
      const btn = body.querySelector('[data-clear]');
      if (btn) btn.onclick = async () => {
        if (!(await confirmDialog('Hapus salinan video?', 'Video akan diunduh lagi dari server saat dibutuhkan.', 'Hapus', true))) return;
        await clearDeviceCache();
        toast('Salinan video di perangkat ini dihapus');
        render();
      };
    };
    render();
  },

  /**
   * Personal AI (MCP) token: an AI agent connected with it works only in this account's projects.
   * The token is shown once; the server keeps only a hash.
   */
  async aiToken() {
    const m = modal({ title: 'Token AI (MCP)', body: '<div class="tok-body"><p class="hint">Memuat…</p></div>' });
    const body = m.el.querySelector('.tok-body');
    const when = (t) => (t ? new Date(t).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
    const copyBtn = (text, label) => `<button class="btn sm" data-copy="${escapeHtml(text)}">${icon('copy', 14)}${label ? ` ${label}` : ''}</button>`;
    const render = async (fresh = null) => {
      let info;
      try { info = await api('/api/me/token'); } catch (err) { body.innerHTML = `<p class="hint danger">${escapeHtml(err.message)}</p>`; return; }
      const cmd = fresh ? `claude mcp add --transport http najja-editor ${location.origin}/mcp --header "Authorization: Bearer ${fresh}"` : '';
      body.innerHTML = `
        <p class="hint">AI agent (Claude Code, Claude Desktop, Cursor) yang memakai token ini hanya bisa membuka dan mengedit proyek di akun <b>${escapeHtml(this.me?.email || "ini")}</b>, dan hanya lewat editor yang kamu buka di browser.</p>
        ${fresh ? `<div class="tok-fresh"><b>Salin sekarang — token ini hanya ditampilkan sekali.</b>
            <div class="copy-row"><code>${escapeHtml(fresh)}</code>${copyBtn(fresh)}</div>
            <p class="hint">Perintah Claude Code:</p><div class="copy-row"><code>${escapeHtml(cmd)}</code>${copyBtn(cmd)}</div></div>`
          : info.exists ? `<div class="user-row"><div><b>Token aktif ••••${escapeHtml(info.hint || '')}</b><span>Dibuat ${when(info.createdAt)} · terakhir dipakai ${when(info.lastUsedAt)}</span></div></div>`
            : '<p class="hint">Belum ada token AI untuk akun ini.</p>'}
        <div class="tok-actions">
          <button class="btn btn-primary" data-new>${icon('ai', 15)} ${info.exists ? 'Buat token baru' : 'Buat token'}</button>
          ${info.exists ? `<button class="btn" data-revoke>${icon('x', 14)} Cabut token</button>` : ''}
        </div>
        ${info.exists && !fresh ? '<p class="hint">Membuat token baru otomatis mencabut token lama.</p>' : ''}`;
      for (const b of body.querySelectorAll('[data-copy]')) {
        b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Disalin', { type: 'ok' })).catch(() => toast('Gagal menyalin', { type: 'error' }));
      }
      body.querySelector('[data-new]').onclick = async () => {
        if (info.exists && !(await confirmDialog('Buat token baru?', 'AI agent yang memakai token lama harus diatur ulang.', 'Buat baru'))) return;
        try { render((await api('/api/me/token', { method: 'POST' })).token); } catch (err) { toast(err.message, { type: 'error' }); }
      };
      const rv = body.querySelector('[data-revoke]');
      if (rv) rv.onclick = async () => {
        if (!(await confirmDialog('Cabut token AI?', 'AI agent yang memakai token ini tidak bisa mengedit lagi.', 'Cabut', true))) return;
        try { await api('/api/me/token', { method: 'DELETE' }); toast('Token dicabut'); render(); } catch (err) { toast(err.message, { type: 'error' }); }
      };
    };
    render();
  },

  changePassword() {
    const m = modal({
      title: 'Ganti password',
      body: `<div class="ctl"><label>Password lama</label><input type="password" class="pw-cur" autocomplete="current-password"></div>
        <div class="ctl"><label>Password baru (min. 8 karakter)</label><input type="password" class="pw-new" autocomplete="new-password"></div>
        <div class="ctl"><label>Ulangi password baru</label><input type="password" class="pw-new2" autocomplete="new-password"></div>
        <p class="hint">Perangkat lain yang sedang login akan otomatis keluar.</p><p class="hint danger pw-err"></p>`,
      footer: '<button class="btn" data-x>Batal</button><button class="btn btn-primary" data-go>Simpan</button>',
    });
    const $ = (s) => m.el.querySelector(s);
    $('.pw-cur').focus();
    $('[data-x]').onclick = m.close;
    $('[data-go]').onclick = async () => {
      const next = $('.pw-new').value;
      if (next !== $('.pw-new2').value) { $('.pw-err').textContent = 'Password baru tidak sama.'; return; }
      try {
        await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current: $('.pw-cur').value, next }) });
        m.close();
        toast('Password diganti', { type: 'ok' });
      } catch (err) { $('.pw-err').textContent = err.message; }
    };
  },

  async users() {
    const m = modal({ title: 'Kelola pengguna', wide: false, body: '<div class="users-body"><p class="hint">Memuat…</p></div>' });
    const body = m.el.querySelector('.users-body');
    const render = async () => {
      let list = [];
      try { list = await api('/api/users'); } catch (err) { body.innerHTML = `<p class="hint danger">${escapeHtml(err.message)}</p>`; return; }
      body.innerHTML = `
        <p class="hint">Setiap pengguna punya proyek, media, dan hasil ekspor sendiri; pengguna lain tidak bisa melihatnya. Menghapus pengguna memindahkan datanya ke akun kamu (dicadangkan dulu).</p>
        <div class="user-list">${list.map((u) => `<div class="user-row">
          <span class="avatar sm">${escapeHtml(u.email[0].toUpperCase())}</span>
          <div><b>${escapeHtml(u.email)}</b><span>${u.role === 'admin' ? 'Admin' : 'Editor'} · sejak ${new Date(u.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
          ${u.email === this.me.email ? '<em>Kamu</em>' : `<button class="icon-btn" data-del="${escapeHtml(u.email)}" title="Hapus">${icon('trash', 15)}</button>`}
        </div>`).join('')}</div>
        <div class="isec-head" style="margin-top:6px"><span>Tambah pengguna</span></div>
        <div class="ctl"><label>Email</label><input type="email" class="nu-email" autocomplete="off"></div>
        <div class="ctl-2"><div class="ctl"><label>Password awal</label><input type="password" class="nu-pw" autocomplete="new-password"></div>
        <div class="ctl"><label>Peran</label><select class="nu-role"><option value="editor">Editor</option><option value="admin">Admin</option></select></div></div>
        <p class="hint danger nu-err"></p>
        <button class="btn btn-primary" data-add>${icon('plus', 15)} Tambah</button>`;
      body.querySelector('[data-add]').onclick = async () => {
        try {
          await api('/api/users', { method: 'POST', body: JSON.stringify({ email: body.querySelector('.nu-email').value, password: body.querySelector('.nu-pw').value, role: body.querySelector('.nu-role').value }) });
          toast('Pengguna ditambahkan', { type: 'ok' });
          render();
        } catch (err) { body.querySelector('.nu-err').textContent = err.message; }
      };
      for (const b of body.querySelectorAll('[data-del]')) {
        b.onclick = async () => {
          if (!(await confirmDialog('Hapus pengguna?', `${b.dataset.del} tidak bisa masuk lagi. Proyek dan medianya dipindah ke akun kamu.`, 'Hapus', true))) return;
          try {
            const r = await api(`/api/users/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
            if (r.moved?.projects || r.moved?.media) toast(`Dipindah ke akun kamu: ${r.moved.projects} proyek, ${r.moved.media} media`, { type: 'ok' });
            render();
          } catch (err) { toast(err.message, { type: 'error' }); }
        };
      }
    };
    render();
  },
};
