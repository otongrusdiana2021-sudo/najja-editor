// Toasts, context menus and modal dialogs.
import { icon } from './icons.js';
import { escapeHtml } from './util.js';

let toastHost = null;
let aiToast = null;
export function toast(message, { type = 'info', timeout = 2600, action } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    document.body.appendChild(toastHost);
  }
  // AI activity reuses one toast so rapid MCP calls never pile up over the preview.
  if (type === 'ai' && aiToast?.el.isConnected) {
    aiToast.el.querySelector('span').textContent = message;
    aiToast.el.classList.remove('bump');
    void aiToast.el.offsetWidth;
    aiToast.el.classList.add('bump');
    clearTimeout(aiToast.timer);
    aiToast.timer = setTimeout(aiToast.close, timeout || 2600);
    return aiToast.close;
  }
  while (toastHost.children.length >= 3) toastHost.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const ic = { info: 'sparkles', ok: 'check', error: 'x', ai: 'ai', warn: 'help' }[type] || 'sparkles';
  el.innerHTML = `${icon(ic, 16)}<span>${escapeHtml(message)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); close(); };
    el.appendChild(b);
  }
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 250); if (aiToast?.el === el) aiToast = null; };
  const timer = timeout ? setTimeout(close, timeout) : null;
  if (type === 'ai') aiToast = { el, close, timer };
  return close;
}

let menuEl = null;
export function closeMenu() { menuEl?.remove(); menuEl = null; }
/** items: [{label, icon, kbd, run, disabled, danger} | 'sep'] */
export function contextMenu(x, y, items) {
  closeMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'ctx-menu';
  menuEl.innerHTML = items.map((it, i) => (it === 'sep' ? '<div class="ctx-sep"></div>'
    : `<button data-i="${i}" ${it.disabled ? 'disabled' : ''} class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon, 15) : '<span class="ic-sp"></span>'}<span>${escapeHtml(it.label)}</span>${it.kbd ? `<kbd>${escapeHtml(it.kbd)}</kbd>` : ''}</button>`)).join('');
  document.body.appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menuEl.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menuEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const it = items[+b.dataset.i];
    closeMenu();
    it.run?.();
  });
  setTimeout(() => {
    const off = (e) => { if (!menuEl?.contains(e.target)) { closeMenu(); window.removeEventListener('pointerdown', off, true); } };
    window.addEventListener('pointerdown', off, true);
  });
}

/** Modal dialog. Returns { el, close }. */
export function modal({ title, body, footer = '', wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
    <div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="icon-btn" data-close aria-label="Tutup">${icon('x', 18)}</button></div>
    <div class="modal-body">${body}</div>${footer ? `<div class="modal-foot">${footer}</div>` : ''}</div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));
  const close = () => {
    wrap.classList.remove('in');
    setTimeout(() => wrap.remove(), 200);
    window.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-close]').onclick = close;
  return { el: wrap.querySelector('.modal'), close };
}

export function confirmDialog(title, message, okLabel = 'Ya', danger = false) {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title,
      body: `<p class="muted">${escapeHtml(message)}</p>`,
      footer: `<button class="btn" data-no>Batal</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${escapeHtml(okLabel)}</button>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    m.el.querySelector('[data-no]').onclick = () => { answered = true; resolve(false); m.close(); };
    m.el.querySelector('[data-yes]').onclick = () => { answered = true; resolve(true); m.close(); };
  });
}
