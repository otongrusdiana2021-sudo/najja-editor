// Project model, editing operations, undo/redo and autosave.
import { uid, clone, deepMerge, clamp, debounce } from './util.js';
import { ASPECTS, DEFAULT_TEXT, ADJUSTMENTS } from './presets.js';
import { prefs } from './db.js';
import { storage } from './storage.js';
import { metrics } from './metrics.js';
import { planFor } from './plan.js';

export const MIN_CLIP = 0.1;
export const VISUAL_TYPES = ['video', 'image', 'solid', 'text', 'sticker'];
export const TRACK_KIND_FOR = { video: 'overlay', image: 'overlay', solid: 'overlay', text: 'text', sticker: 'text', audio: 'audio', effect: 'effect' };
export const TRACK_NAMES = { main: 'Utama', overlay: 'Overlay', text: 'Teks', audio: 'Audio', effect: 'Efek' };

export function trackAccepts(track, type) {
  if (!track) return false;
  switch (track.kind) {
    case 'main': return ['video', 'image', 'solid'].includes(type);
    case 'overlay':
    case 'text': return VISUAL_TYPES.includes(type);
    case 'audio': return type === 'audio';
    case 'effect': return type === 'effect';
    default: return false;
  }
}

export function newProject({ name = 'Proyek tanpa judul', aspect = '16:9' } = {}) {
  const a = ASPECTS[aspect] || ASPECTS['16:9'];
  return {
    id: uid('p'),
    name,
    aspect: ASPECTS[aspect] ? aspect : '16:9',
    width: a.w,
    height: a.h,
    fps: 30,
    background: { mode: 'color', color: '#000000', blur: 40 },
    magnet: true,
    tracks: [{ id: 'main', kind: 'main', name: TRACK_NAMES.main, muted: false, hidden: false, locked: false }],
    clips: [],
    media: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
  };
}

const zeroAdjust = () => Object.fromEntries(ADJUSTMENTS.map((a) => [a.id, 0]));

export function makeClip(type, props = {}) {
  const base = { id: uid('c'), type, trackId: null, start: 0, duration: 3, in: 0, speed: 1, name: '' };
  if (type !== 'audio' && type !== 'effect') {
    Object.assign(base, {
      x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false, blend: 'source-over',
      crop: { l: 0, t: 0, r: 0, b: 0 },
      filter: { name: 'none', intensity: 1 },
      adjust: zeroAdjust(),
      animIn: { type: 'none', duration: 0.5 },
      animOut: { type: 'none', duration: 0.5 },
      animLoop: { type: 'none', speed: 1 },
      transition: { type: 'none', duration: 0.6 },
      keyframes: [],
    });
  }
  if (type === 'video' || type === 'image') base.chroma = { enabled: false, color: '#00ff00', similarity: 0.4, smoothness: 0.08 };
  if (type === 'video' || type === 'audio') Object.assign(base, { volume: 1, fadeIn: 0, fadeOut: 0, muted: false });
  if (type === 'text') base.text = clone(DEFAULT_TEXT);
  if (type === 'sticker') base.sticker = { emoji: '🔥', badge: null };
  if (type === 'solid') base.solid = { color: '#111111', color2: null, angle: 135 };
  if (type === 'effect') base.effect = { type: 'shake', intensity: 0.7 };
  return deepMerge(base, props);
}

// ---------------------------------------------------------------------------------------------
// Pure model helpers (operate on a project object)
export const clipEnd = (c) => c.start + c.duration;
export function sortedClips(P, trackId) {
  return P.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
}
export function projectDuration(P) {
  let d = 0;
  for (const c of P.clips) d = Math.max(d, c.start + c.duration);
  return d;
}
export function getMedia(P, id) {
  return P.media.find((m) => m.id === id);
}
export function overlaps(P, trackId, start, end, excludeId) {
  return P.clips.some((c) => c.trackId === trackId && c.id !== excludeId && c.start < end - 1e-4 && c.start + c.duration > start + 1e-4);
}
export function packMain(P) {
  if (!P.magnet) return;
  let t = 0;
  for (const c of sortedClips(P, 'main')) {
    c.start = t;
    t += c.duration;
  }
}
/** Earliest start >= start where [start, start+dur) is free on a track. */
export function findFreeStart(P, trackId, start, dur, excludeId) {
  let s = Math.max(0, start);
  const list = sortedClips(P, trackId).filter((c) => c.id !== excludeId);
  for (let i = 0; i < 200; i++) {
    const hit = list.find((c) => c.start < s + dur - 1e-4 && c.start + c.duration > s + 1e-4);
    if (!hit) return s;
    s = hit.start + hit.duration;
  }
  return s;
}

function trackInsertIndex(P, kind) {
  const firstVisual = P.tracks.findIndex((t) => t.kind !== 'effect');
  if (kind === 'effect') return 0;
  if (kind === 'audio') return P.tracks.length;
  return firstVisual < 0 ? P.tracks.length : firstVisual; // top of the visual stack
}
export function createTrack(P, kind, index) {
  const tr = { id: uid('t'), kind, name: TRACK_NAMES[kind] || kind, muted: false, hidden: false, locked: false };
  P.tracks.splice(index ?? trackInsertIndex(P, kind), 0, tr);
  return tr;
}
/** First unlocked track of `kind` that is free in [start,end); creates one if needed. Searches bottom-up for visual tracks (closest to main). */
export function findOrCreateTrack(P, kind, start, end, excludeId) {
  const candidates = P.tracks.filter((t) => t.kind === kind && !t.locked);
  if (kind === 'overlay' || kind === 'text') candidates.reverse();
  for (const tr of candidates) if (!overlaps(P, tr.id, start, end, excludeId)) return tr;
  return createTrack(P, kind);
}

/** Put a clip on the main track at the insertion point closest to `atTime` (magnetic), or append. */
export function insertIntoMain(P, clip, atTime) {
  clip.trackId = 'main';
  if (!P.clips.includes(clip)) P.clips.push(clip);
  if (!P.magnet) {
    clip.start = findFreeStart(P, 'main', atTime ?? projectEndOf(P, 'main', clip.id), clip.duration, clip.id);
    return;
  }
  const list = sortedClips(P, 'main').filter((c) => c.id !== clip.id);
  let idx = list.length;
  if (atTime != null) {
    idx = list.findIndex((c) => atTime < c.start + c.duration / 2);
    if (idx < 0) idx = list.length;
  }
  list.splice(idx, 0, clip);
  let t = 0;
  for (const c of list) {
    c.start = t;
    t += c.duration;
  }
}
export function projectEndOf(P, trackId, excludeId) {
  let e = 0;
  for (const c of P.clips) if (c.trackId === trackId && c.id !== excludeId) e = Math.max(e, c.start + c.duration);
  return e;
}

/** Place a clip on a track. target: 'auto' | 'main' | 'overlay' | 'text' | 'audio' | 'effect' | 'new' | trackId */
export function placeClip(P, clip, target = 'auto', start) {
  let kind = TRACK_KIND_FOR[clip.type];
  let tr = null;
  if (target && target !== 'auto' && target !== 'new') {
    tr = P.tracks.find((t) => t.id === target) || null;
    if (!tr && ['main', 'overlay', 'text', 'audio', 'effect'].includes(target)) {
      if (target === 'main') tr = P.tracks.find((t) => t.kind === 'main');
      else kind = target;
    }
  } else if (target === 'auto' && ['video', 'image', 'solid'].includes(clip.type)) {
    tr = P.tracks.find((t) => t.kind === 'main');
  }
  if (tr && !trackAccepts(tr, clip.type)) {
    if (tr.kind === 'main' && (clip.type === 'text' || clip.type === 'sticker')) kind = 'text';
    tr = null;
  }
  if (tr && tr.kind === 'main') {
    insertIntoMain(P, clip, start);
    return clip;
  }
  if (kind === 'main') kind = 'overlay';
  const s = Math.max(0, start ?? 0);
  if (!tr) tr = target === 'new' ? createTrack(P, kind) : findOrCreateTrack(P, kind, s, s + clip.duration, clip.id);
  if (overlaps(P, tr.id, s, s + clip.duration, clip.id)) {
    const idx = P.tracks.indexOf(tr);
    tr = createTrack(P, tr.kind, kind === 'audio' ? idx + 1 : idx);
  }
  clip.trackId = tr.id;
  clip.start = s;
  if (!P.clips.includes(clip)) P.clips.push(clip);
  return clip;
}

export function mediaMaxDuration(P, clip) {
  if (clip.type !== 'video' && clip.type !== 'audio') return Infinity;
  const m = getMedia(P, clip.mediaId);
  if (!m || !m.duration) return Infinity;
  return Math.max(MIN_CLIP, (m.duration - clip.in) / (clip.speed || 1));
}

export function splitClip(P, clip, t) {
  if (!clip || t <= clip.start + MIN_CLIP / 2 || t >= clip.start + clip.duration - MIN_CLIP / 2) return null;
  const d = t - clip.start;
  const b = clone(clip);
  b.id = uid('c');
  b.start = t;
  b.duration = clip.duration - d;
  b.in = (clip.in || 0) + d * (clip.speed || 1);
  clip.duration = d;
  if (clip.animOut) clip.animOut = { type: 'none', duration: clip.animOut.duration };
  if (b.animIn) b.animIn = { type: 'none', duration: b.animIn.duration };
  if (b.transition) b.transition = { type: 'none', duration: b.transition.duration || 0.6 };
  if (clip.keyframes?.length) {
    const all = clip.keyframes;
    clip.keyframes = all.filter((k) => k.t < d);
    b.keyframes = all.filter((k) => k.t >= d).map((k) => ({ ...k, t: k.t - d }));
  }
  if ('fadeOut' in clip) { clip.fadeOut = 0; b.fadeIn = 0; }
  P.clips.splice(P.clips.indexOf(clip) + 1, 0, b);
  return b;
}

export const KF_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'];
/** Interpolated keyframed property at clip-local time (falls back to the static value). */
export function kfValue(clip, prop, local) {
  const ks = clip.keyframes;
  if (!ks || !ks.length) return clip[prop];
  if (local <= ks[0].t) return ks[0][prop] ?? clip[prop];
  const last = ks[ks.length - 1];
  if (local >= last.t) return last[prop] ?? clip[prop];
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (local >= a.t && local <= b.t) {
      const u = (local - a.t) / Math.max(1e-6, b.t - a.t);
      const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      const va = a[prop] ?? clip[prop];
      const vb = b[prop] ?? clip[prop];
      return va + (vb - va) * e;
    }
  }
  return clip[prop];
}
export function keyframeAt(clip, local, tol = 1 / 60) {
  return (clip.keyframes || []).find((k) => Math.abs(k.t - local) <= tol) || null;
}
/** Add/update a keyframe at clip-local time with the current interpolated values, overridden by `values`. */
export function upsertKeyframe(clip, local, values = {}) {
  if (!clip.keyframes) clip.keyframes = [];
  local = Math.max(0, Math.min(clip.duration, local));
  let k = keyframeAt(clip, local);
  if (!k) {
    k = { t: Math.round(local * 1000) / 1000 };
    for (const p of KF_PROPS) k[p] = kfValue(clip, p, local);
    clip.keyframes.push(k);
    clip.keyframes.sort((a, b) => a.t - b.t);
  }
  Object.assign(k, values);
  return k;
}
export function removeKeyframe(clip, local) {
  const k = keyframeAt(clip, local);
  if (k) clip.keyframes = clip.keyframes.filter((x) => x !== k);
  return !!k;
}

export function setSpeed(P, clip, speed) {
  speed = clamp(Number(speed) || 1, 0.1, 10);
  const src = clip.duration * (clip.speed || 1);
  clip.speed = speed;
  if (clip.type === 'video' || clip.type === 'audio') clip.duration = Math.max(MIN_CLIP, src / speed);
}

export function summarizeClip(P, c) {
  const tr = P.tracks.find((t) => t.id === c.trackId);
  const r = (v) => Math.round(v * 1000) / 1000;
  const o = { id: c.id, type: c.type, track: c.trackId, track_kind: tr?.kind, start: r(c.start), end: r(c.start + c.duration), duration: r(c.duration) };
  if (c.name) o.name = c.name;
  if (c.mediaId) { o.media_id = c.mediaId; o.source_in = r(c.in); }
  if (c.speed !== 1) o.speed = c.speed;
  if ('volume' in c) { o.volume = c.volume; if (c.muted) o.muted = true; }
  if ('x' in c) Object.assign(o, { x: r(c.x), y: r(c.y), scale: r(c.scale), rotation: r(c.rotation), opacity: r(c.opacity) });
  if (c.text) Object.assign(o, { text: c.text.content, font: c.text.font, size: c.text.size, color: c.text.color, preset: c.text.preset });
  if (c.sticker) o.sticker = c.sticker.badge ? { badge: c.sticker.badge.text } : { emoji: c.sticker.emoji };
  if (c.solid) o.solid = c.solid;
  if (c.effect) o.effect = c.effect;
  if (c.filter && c.filter.name !== 'none') o.filter = c.filter;
  if (c.transition && c.transition.type !== 'none') o.transition = c.transition;
  const anim = {};
  if (c.animIn && c.animIn.type !== 'none') anim.in = c.animIn.type;
  if (c.animOut && c.animOut.type !== 'none') anim.out = c.animOut.type;
  if (c.animLoop && c.animLoop.type !== 'none') anim.loop = c.animLoop.type;
  if (Object.keys(anim).length) o.animation = anim;
  if (c.keyframes?.length) o.keyframes = c.keyframes.length;
  if (c.chroma?.enabled) o.chroma = c.chroma;
  if (c.adjust) {
    const adj = Object.fromEntries(Object.entries(c.adjust).filter(([, v]) => v));
    if (Object.keys(adj).length) o.adjust = adj;
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
class Store {
  constructor() {
    this.project = newProject();
    this.selection = null;
    this.past = [];
    this.future = [];
    this.listeners = new Map();
    this.saveState = 'saved';
    this.clipboard = null;
    this.rev = 0; // bumped on every change of the project (render plan cache key)
    this._live = null;
    this.thumbProvider = null;
    this.scheduleSave = debounce(() => this.save(), 700);
  }
  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt)?.delete(fn);
  }
  emit(evt, data) {
    if (evt === 'project') this.rev++;
    for (const fn of this.listeners.get(evt) || []) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  }

  // getters
  get P() { return this.project; }
  clip(id) { return this.project.clips.find((c) => c.id === id); }
  track(id) { return this.project.tracks.find((t) => t.id === id); }
  media(id) { return getMedia(this.project, id); }
  duration() { return projectDuration(this.project); }
  /** Compiled render plan of the current project (rebuilt only after a change). */
  plan() { return planFor(this.project, this.rev); }
  selected() { return this.selection ? this.clip(this.selection) : null; }

  // history
  snapshot() { return JSON.stringify(this.project); }
  pushHistory(snap) {
    this.past.push(snap);
    if (this.past.length > 150) this.past.shift();
    this.future = [];
  }
  mutate(label, fn) {
    const snap = this._live || this.snapshot();
    this._live = null;
    const result = fn(this.project);
    if (this.snapshot() !== snap) this.pushHistory(snap);
    this.normalize();
    this.touch(label);
    return result;
  }
  /** Mutate without recording history yet (drag, slider...). Call commitLive() when done. */
  live(fn, kind = 'live') {
    if (!this._live) this._live = this.snapshot();
    fn(this.project);
    this.rev++;
    this.emit(kind);
  }
  commitLive(label) {
    if (!this._live) return;
    const snap = this._live;
    this._live = null;
    if (snap !== this.snapshot()) this.pushHistory(snap);
    this.normalize();
    this.touch(label);
  }
  cancelLive() {
    if (!this._live) return;
    this.project = JSON.parse(this._live);
    this._live = null;
    this.emit('project');
  }
  undo() {
    if (this._live) this.commitLive();
    if (!this.past.length) return false;
    const media = this.project.media;
    this.future.push(this.snapshot());
    this.project = JSON.parse(this.past.pop());
    this.project.media = media;
    this.afterRestore();
    return true;
  }
  redo() {
    if (!this.future.length) return false;
    const media = this.project.media;
    this.past.push(this.snapshot());
    this.project = JSON.parse(this.future.pop());
    this.project.media = media;
    this.afterRestore();
    return true;
  }
  afterRestore() {
    if (this.selection && !this.clip(this.selection)) this.selection = null;
    this.normalize();
    this.touch('history');
    this.emit('selection', this.selection);
  }
  touch(label) {
    this.project.updatedAt = Date.now();
    this.emit('project', label);
    this.scheduleSave();
  }

  setProject(p, { keepHistory = false } = {}) {
    this.project = p;
    if (!keepHistory) { this.past = []; this.future = []; }
    this.selection = null;
    this._live = null;
    this.normalize();
    this.emit('project', 'load');
    this.emit('selection', null);
    prefs.set('lastProject', p.id);
  }

  select(id) {
    if (id && !this.clip(id)) id = null;
    if (this.selection === id) return;
    this.selection = id;
    this.emit('selection', id);
  }

  normalize() {
    const P = this.project;
    if (!P.tracks.some((t) => t.kind === 'main')) P.tracks.push({ id: 'main', kind: 'main', name: TRACK_NAMES.main, muted: false, hidden: false, locked: false });
    const ids = new Set(P.tracks.map((t) => t.id));
    for (const c of P.clips) {
      if (!ids.has(c.trackId) || !trackAccepts(this.track(c.trackId), c.type)) {
        const kind = TRACK_KIND_FOR[c.type];
        c.trackId = (kind === 'overlay' && P.tracks.find((t) => t.kind === 'main').id) || findOrCreateTrack(P, kind, c.start, c.start + c.duration, c.id).id;
        ids.add(c.trackId);
      }
      c.duration = Math.max(MIN_CLIP, Number(c.duration) || MIN_CLIP);
      c.start = Math.max(0, Number(c.start) || 0);
      if (c.type === 'video' || c.type === 'audio') {
        c.in = Math.max(0, Number(c.in) || 0);
        const max = mediaMaxDuration(P, c);
        if (c.duration > max + 1e-3) c.duration = Math.max(MIN_CLIP, max);
      }
    }
    packMain(P);
    // Drop empty non-main tracks, keep display order: effects, visual overlays, main, audio
    const used = new Set(P.clips.map((c) => c.trackId));
    const keep = P.tracks.filter((t) => t.kind === 'main' || used.has(t.id));
    const order = { effect: 0, overlay: 1, text: 1, main: 2, audio: 3 };
    P.tracks = keep.map((t, i) => [t, i]).sort((a, b) => order[a[0].kind] - order[b[0].kind] || a[1] - b[1]).map(([t]) => t);
    if (this.selection && !this.clip(this.selection)) {
      this.selection = null;
      this.emit('selection', null);
    }
  }

  async save() {
    this.saveState = 'saving';
    this.emit('save', this.saveState);
    const rec = clone(this.project);
    try { rec.thumb = this.thumbProvider ? await this.thumbProvider() : undefined; } catch { /* ignore */ }
    rec.duration = this.duration();
    try {
      const ack = metrics.timer('save_ack_ms');
      await storage.putProject(rec);
      ack();
      prefs.set('lastProject', this.project.id);
      this.saveState = 'saved';
    } catch (err) {
      metrics.count('save_failed');
      console.warn('save failed', err);
      this.saveState = 'error';
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.scheduleSave(), 5000);
    }
    this.emit('save', this.saveState);
  }
}

export const store = new Store();
