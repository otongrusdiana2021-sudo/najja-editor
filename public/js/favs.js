// Favourites (v1.9): a star on every effect, transition, filter, animation, font, text style and sound; favourites
// are listed first in their tab, so the ones you use are quick to find. Kept on this device (prefs).
import { prefs } from './db.js';

const key = (kind) => `fav.${kind}`;
export const favs = {
  list(kind) { const v = prefs.get(key(kind), []); return Array.isArray(v) ? v : []; },
  has(kind, id) { return this.list(kind).includes(String(id)); },
  toggle(kind, id) {
    const l = this.list(kind);
    const i = l.indexOf(String(id));
    if (i >= 0) l.splice(i, 1); else l.unshift(String(id));
    prefs.set(key(kind), l.slice(0, 200));
    return i < 0;
  },
  /** The items of `all` that are favourites, in the order they were starred (newest first). */
  pick(kind, all, idOf = (x) => x.id) {
    const l = this.list(kind);
    return l.map((id) => all.find((x) => String(idOf(x)) === id)).filter(Boolean);
  },
};

/** The star inside a tile (a span: tiles are buttons). */
export const star = (kind, id) => {
  const on = favs.has(kind, id);
  return `<span class="fav ${on ? 'on' : ''}" data-fav="${kind}:${String(id).replace(/"/g, '&quot;')}" role="button" aria-pressed="${on}" aria-label="${on ? 'Hapus dari favorit' : 'Jadikan favorit'}" title="${on ? 'Hapus dari favorit' : 'Favorit'}">${on ? '★' : '☆'}</span>`;
};

/** Click on a star: toggles it and returns true (the caller re-renders), else false. */
export function onStar(e) {
  const el = e.target.closest?.('[data-fav]');
  if (!el) return false;
  e.preventDefault();
  e.stopPropagation();
  const s = el.dataset.fav;
  const i = s.indexOf(':');
  favs.toggle(s.slice(0, i), s.slice(i + 1));
  return true;
}
