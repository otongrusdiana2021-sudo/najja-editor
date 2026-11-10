// Editing actions shared by the UI (toolbar, shortcuts, menus, panels) and the MCP API.
import {
  store, makeClip, placeClip, splitClip, sortedClips, insertIntoMain, findFreeStart, MIN_CLIP, TRACK_KIND_FOR, clipEnd,
} from './store.js';
import { mediaRT, importCanvasAsImage } from './media.js';
import { TEXT_PRESETS, TEXT_TEMPLATES, DEFAULT_TEXT, FILTERS, TRANSITIONS, EFFECTS, BADGES } from './presets.js';
import { clone, deepMerge, uid } from './util.js';
import { toast } from './ui.js';

export const app = { engine: null, timeline: null, library: null, inspector: null, player: null };

const now = () => app.engine?.time ?? 0;

export function presetStyle(id) {
  const p = TEXT_PRESETS.find((x) => x.id === id) || TEXT_PRESETS[0];
  const base = clone(DEFAULT_TEXT);
  deepMerge(base, clone(p.style));
  base.preset = p.id;
  return base;
}

export function select(id) {
  store.select(id);
}

// ---------------------------------------------------------------------------------------------
// Adding things
export function addMediaClip(mediaId, { track = 'auto', start, sourceIn = 0, duration, props = {} } = {}) {
  const m = store.media(mediaId);
  if (!m) throw new Error(`Media tidak ditemukan: ${mediaId}`);
  if (mediaRT.get(mediaId)?.status === 'missing') throw new Error('File media ini hilang dari penyimpanan browser. Impor ulang filenya.');
  const type = m.type;
  const speed = props.speed || 1;
  const inPt = Math.max(0, Math.min(sourceIn || 0, Math.max(0, (m.duration || 0) - MIN_CLIP)));
  let dur = duration;
  if (!dur) dur = type === 'image' ? 3 : Math.max(MIN_CLIP, ((m.duration || 3) - inPt) / speed);
  if (type !== 'image' && m.duration) dur = Math.min(dur, (m.duration - inPt) / speed);
  const clip = makeClip(type, { mediaId, in: inPt, duration: dur, name: m.name, ...props });
  return store.mutate('Tambah klip', (P) => {
    const target = type === 'audio' && track === 'auto' ? 'audio' : track;
    placeClip(P, clip, target, start ?? (target === 'auto' || target === 'main' ? undefined : now()));
    return clip;
  });
}

export function addText({ text = 'Teks baru', preset = 'default', template, start, duration = 3, track = 'auto', style = {}, props = {} } = {}) {
  const tpl = TEXT_TEMPLATES.find((t) => t.id === template);
  const tx = presetStyle(tpl?.preset || preset);
  tx.content = text;
  if (tpl) {
    if (tpl.size) tx.size = tpl.size;
    if (tpl.align) tx.align = tpl.align;
  }
  deepMerge(tx, style);
  const clipProps = {
    text: tx,
    duration,
    name: text.split('\n')[0].slice(0, 40),
    x: tpl?.x ?? 0,
    y: tpl?.y ?? 0,
    animIn: { type: tpl?.animIn || 'none', duration: 0.5 },
    animOut: { type: tpl?.animOut || 'none', duration: 0.5 },
    animLoop: { type: tpl?.animLoop || 'none', speed: 1 },
    ...props,
  };
  const clip = makeClip('text', clipProps);
  return store.mutate('Tambah teks', (P) => placeClip(P, clip, track === 'auto' ? 'text' : track, start ?? now()));
}

export function addSticker({ emoji, badge, start, duration = 3, props = {} } = {}) {
  const sticker = badge ? { emoji: null, badge: typeof badge === 'string' ? (BADGES.find((b) => b.id === badge) || { text: badge, bg: '#ff0033', fg: '#fff', icon: '' }) : badge } : { emoji: emoji || '🔥', badge: null };
  const clip = makeClip('sticker', { sticker: clone(sticker), duration, name: badge ? sticker.badge.text : sticker.emoji, scale: badge ? 1 : 0.8, ...props });
  return store.mutate('Tambah stiker', (P) => placeClip(P, clip, 'text', start ?? now()));
}

export function addSolid({ color = '#111111', color2 = null, angle = 135, start, duration = 3, track = 'main' } = {}) {
  const clip = makeClip('solid', { solid: { color, color2, angle }, duration, name: color2 ? 'Gradien' : 'Warna' });
  return store.mutate('Tambah latar', (P) => placeClip(P, clip, track, start));
}

export function addEffect({ effect = 'shake', start, duration = 3, intensity = 0.7 } = {}) {
  const def = EFFECTS.find((e) => e.id === effect);
  if (!def) throw new Error(`Efek tidak dikenal: ${effect}`);
  const clip = makeClip('effect', { effect: { type: effect, intensity }, duration, name: def.name });
  return store.mutate('Tambah efek', (P) => placeClip(P, clip, 'effect', start ?? now()));
}

// ---------------------------------------------------------------------------------------------
// Target helpers
export function mainClipAt(t) {
  return sortedClips(store.P, 'main').find((c) => t >= c.start && t < clipEnd(c)) || null;
}
/** The selected visual clip, or the main-track clip under the playhead. */
export function targetVisual() {
  const sel = store.selected();
  if (sel && !['audio', 'effect'].includes(sel.type)) return sel;
  return mainClipAt(now());
}

export function applyFilter(clipId, filter, intensity = 1) {
  if (!FILTERS.find((f) => f.id === filter)) throw new Error(`Filter tidak dikenal: ${filter}`);
  const ids = clipId === 'all'
    ? sortedClips(store.P, 'main').filter((c) => c.filter).map((c) => c.id)
    : [clipId];
  store.mutate('Filter', () => {
    for (const id of ids) {
      const c = store.clip(id);
      if (!c?.filter) continue;
      c.filter = { name: filter, intensity: Math.max(0, Math.min(1, intensity)) };
    }
  });
  return ids;
}

export function applyTransition(clipId, type, duration = 0.6) {
  if (!TRANSITIONS.find((t) => t.id === type)) throw new Error(`Transisi tidak dikenal: ${type}`);
  const list = sortedClips(store.P, 'main');
  const targets = clipId === 'all' ? list.slice(1) : list.filter((c) => c.id === clipId);
  if (!targets.length) throw new Error('Transisi hanya bisa dipasang pada klip di track utama yang punya klip sebelumnya.');
  if (clipId !== 'all' && list.indexOf(targets[0]) === 0) throw new Error('Klip pertama tidak punya klip sebelumnya untuk transisi.');
  store.mutate('Transisi', () => {
    for (const c of targets) c.transition = { type, duration: Math.max(0.1, Math.min(5, duration)) };
  });
  return targets.map((c) => c.id);
}

// ---------------------------------------------------------------------------------------------
// Timeline operations
export function splitAt(t = now(), clipId) {
  const P = store.P;
  let targets;
  if (clipId) targets = [store.clip(clipId)].filter(Boolean);
  else {
    const sel = store.selected();
    targets = sel && t > sel.start && t < clipEnd(sel) ? [sel] : P.clips.filter((c) => t > c.start && t < clipEnd(c) && !store.track(c.trackId)?.locked);
  }
  targets = targets.filter((c) => t > c.start + MIN_CLIP / 2 && t < clipEnd(c) - MIN_CLIP / 2);
  if (!targets.length) return [];
  const created = store.mutate('Pisah', (p) => targets.map((c) => [c.id, splitClip(p, c, t)?.id]));
  return created;
}

export function deleteClips(ids) {
  ids = ids.filter((id) => store.clip(id));
  if (!ids.length) return 0;
  store.mutate('Hapus', (P) => { P.clips = P.clips.filter((c) => !ids.includes(c.id)); });
  if (ids.includes(store.selection)) store.select(null);
  return ids.length;
}
export function deleteSelected() {
  if (store.selection) deleteClips([store.selection]);
}

export function duplicateClip(id, start) {
  const src = store.clip(id);
  if (!src) throw new Error(`Klip tidak ditemukan: ${id}`);
  const copy = clone(src);
  copy.id = uid('c');
  const created = store.mutate('Duplikat', (P) => {
    if (src.trackId === 'main' && P.magnet) {
      insertIntoMain(P, copy, start ?? clipEnd(src) - 0.001);
      // insert right after the source
      const list = sortedClips(P, 'main').filter((c) => c.id !== copy.id);
      const idx = start != null ? undefined : list.indexOf(src) + 1;
      if (idx !== undefined) {
        list.splice(idx, 0, copy);
        let t = 0;
        for (const c of list) { c.start = t; t += c.duration; }
      }
    } else {
      P.clips.push(copy);
      const s = start ?? clipEnd(src);
      copy.start = findFreeStart(P, copy.trackId, s, copy.duration, copy.id);
      if (start != null && copy.start !== s) placeClip(P, copy, 'new', s);
    }
    return copy;
  });
  store.select(created.id);
  return created;
}

export function copySelected() {
  const c = store.selected();
  if (!c) return;
  store.clipboard = clone(c);
  toast('Klip disalin');
}
export function paste() {
  const src = store.clipboard;
  if (!src) return;
  const copy = clone(src);
  copy.id = uid('c');
  const t = now();
  const created = store.mutate('Tempel', (P) => {
    const kind = src.trackId === 'main' ? 'main' : (TRACK_KIND_FOR[src.type]);
    if (kind === 'main') insertIntoMain(P, copy, t);
    else placeClip(P, copy, kind, t);
    return copy;
  });
  store.select(created.id);
}

export function moveClip(id, { start, track } = {}) {
  const c = store.clip(id);
  if (!c) throw new Error(`Klip tidak ditemukan: ${id}`);
  return store.mutate('Pindah', (P) => {
    const tgt = track || c.trackId;
    const s = start ?? c.start;
    const curTrack = store.track(c.trackId);
    if ((tgt === 'main' || store.track(tgt)?.kind === 'main')) {
      if (!['video', 'image', 'solid'].includes(c.type)) throw new Error('Track utama hanya untuk video, foto, dan latar warna.');
      insertIntoMain(P, c, s);
    } else if (tgt === c.trackId && curTrack?.kind !== 'main') {
      if (P.clips.some((o) => o.trackId === c.trackId && o.id !== c.id && o.start < s + c.duration - 1e-4 && o.start + o.duration > s + 1e-4)) placeClip(P, c, 'new', s);
      else c.start = Math.max(0, s);
    } else {
      placeClip(P, c, tgt === c.trackId ? 'auto' : tgt, s);
      if (c.trackId === 'main') insertIntoMain(P, c, s);
    }
    return c;
  });
}

export function toggleFlip(axis = 'h') {
  const c = targetVisual();
  if (!c) return toast('Pilih klip dulu', { type: 'warn' });
  store.mutate('Cermin', () => { if (axis === 'h') c.flipH = !c.flipH; else c.flipV = !c.flipV; });
}
export function rotate90() {
  const c = targetVisual();
  if (!c) return toast('Pilih klip dulu', { type: 'warn' });
  store.mutate('Putar', () => { c.rotation = ((Math.round((c.rotation || 0) / 90) * 90 + 90 + 180) % 360) - 180; });
}

export function extractAudio(clipId) {
  const c = clipId ? store.clip(clipId) : store.selected();
  if (!c || c.type !== 'video') return toast('Pilih klip video untuk mengekstrak audio', { type: 'warn' });
  const m = store.media(c.mediaId);
  if (m && m.hasAudio === false) return toast('Video ini tidak punya audio', { type: 'warn' });
  const a = makeClip('audio', { mediaId: c.mediaId, in: c.in, speed: c.speed, duration: c.duration, volume: c.volume, name: `Audio · ${c.name || m?.name || ''}` });
  store.mutate('Ekstrak audio', (P) => {
    placeClip(P, a, 'audio', c.start);
    c.muted = true;
  });
  toast('Audio diekstrak ke track audio', { type: 'ok' });
  return a;
}

export async function freezeFrame() {
  const c = store.selected()?.type === 'video' ? store.selected() : mainClipAt(now());
  const t = now();
  if (!c || c.type !== 'video' || t <= c.start || t >= clipEnd(c)) return toast('Letakkan playhead di atas klip video untuk membekukan frame', { type: 'warn' });
  app.engine.pause();
  app.engine.seek(t);
  await app.engine.settle();
  const src = app.engine.sourceFor(c);
  if (!src) return toast('Frame belum siap, coba lagi', { type: 'warn' });
  const cv = document.createElement('canvas');
  cv.width = src.w;
  cv.height = src.h;
  cv.getContext('2d').drawImage(src.el, 0, 0);
  const media = await importCanvasAsImage(cv, `Freeze ${Math.round(t * 10) / 10}s`);
  store.mutate('Bekukan frame', (P) => {
    const right = splitClip(P, c, t);
    const img = makeClip('image', {
      mediaId: media.id, duration: 3, name: 'Freeze frame',
      x: c.x, y: c.y, scale: c.scale, rotation: c.rotation, flipH: c.flipH, flipV: c.flipV, filter: clone(c.filter), adjust: clone(c.adjust), crop: clone(c.crop),
    });
    if (c.trackId === 'main' && P.magnet) {
      const list = sortedClips(P, 'main');
      list.splice(list.indexOf(c) + 1, 0, img);
      img.trackId = 'main';
      P.clips.push(img);
      let s = 0;
      for (const x of list) { x.start = s; s += x.duration; }
    } else {
      img.trackId = c.trackId;
      P.clips.push(img);
      img.start = t;
      if (right) for (const x of P.clips) if (x.trackId === c.trackId && x.start >= t - 1e-4 && x.id !== img.id) x.start += 3;
    }
  });
  toast('Frame dibekukan 3 detik', { type: 'ok' });
}

export function setMagnet(on) {
  store.mutate('Magnet', (P) => { P.magnet = on; });
}

// ---------------------------------------------------------------------------------------------
// Subtitles / captions
export function parseSrt(text) {
  const items = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
  const ts = (s) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 10 ** m[4].length : null;
  };
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim());
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const start = ts(a);
    const end = ts(z);
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (start != null && end != null && end > start && body) items.push({ start, end, text: body });
  }
  return items;
}
/** Split a script into caption items spread over [t0, t1]. */
export function scriptToItems(script, t0, t1, maxWords = 7) {
  const sentences = String(script).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const chunks = [];
  for (const s of sentences) {
    const words = s.split(' ');
    for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  if (!chunks.length) return [];
  const totalWords = chunks.reduce((a, c) => a + c.split(' ').length, 0);
  const span = Math.max(1, t1 - t0);
  let t = t0;
  return chunks.map((c) => {
    const d = (span * c.split(' ').length) / totalWords;
    const item = { start: t, end: t + d, text: c };
    t += d;
    return item;
  });
}
export function addSubtitles(items, { preset = 'subtitle', y = 0.36, size, font, color, animIn = 'fade', replace = false } = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('Tidak ada baris subtitle');
  return store.mutate('Subtitle', (P) => {
    let tr = P.tracks.find((t) => t.subtitle);
    if (tr && replace) { P.clips = P.clips.filter((c) => c.trackId !== tr.id); }
    if (!tr || !P.tracks.includes(tr)) {
      tr = { id: uid('t'), kind: 'text', name: 'Subtitle', subtitle: true, muted: false, hidden: false, locked: false };
      const idx = P.tracks.findIndex((t) => t.kind === 'main');
      P.tracks.splice(Math.max(0, idx), 0, tr);
    }
    const ids = [];
    for (const it of items) {
      const start = Math.max(0, Number(it.start) || 0);
      const end = Math.max(start + MIN_CLIP, Number(it.end) || start + 2);
      const tx = presetStyle(preset);
      tx.content = String(it.text || '').trim();
      if (size) tx.size = size;
      if (font) tx.font = font;
      if (color) tx.color = color;
      const c = makeClip('text', { text: tx, start, duration: end - start, y, name: tx.content.slice(0, 40), trackId: tr.id, animIn: { type: animIn || 'none', duration: 0.25 } });
      // avoid overlaps on the subtitle track
      const prev = P.clips.filter((x) => x.trackId === tr.id && x.start < c.start + c.duration && x.start + x.duration > c.start);
      for (const p of prev) { if (p.start < c.start) p.duration = Math.max(MIN_CLIP, c.start - p.start); }
      P.clips.push(c);
      ids.push(c.id);
    }
    return ids;
  });
}
