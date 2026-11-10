// Account menu (VPS mode): who is logged in, change password, manage users, log out.
import { icon } from './icons.js';
import { modal, toast, contextMenu, confirmDialog } from './ui.js';
import { escapeHtml } from './util.js';

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
      'sep',
      { label: 'Keluar', icon: 'x', danger: true, run: () => { location.href = '/logout'; } },
    ]);
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
