// Account menu (VPS mode): who is logged in, change password, manage users, log out.
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
        <p class="hint">Semua pengguna memakai proyek dan media yang sama di server ini. Admin bisa menambah atau menghapus pengguna.</p>
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
          if (!(await confirmDialog('Hapus pengguna?', `${b.dataset.del} tidak bisa masuk lagi.`, 'Hapus', true))) return;
          try { await api(`/api/users/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); render(); } catch (err) { toast(err.message, { type: 'error' }); }
        };
      }
    };
    render();
  },
};
