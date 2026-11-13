// Timeline, iPad style: the playhead stays in the centre and the edit scrolls under it.
// The main track sits on top with a filmstrip; every other layer gets a coloured lane below it, grouped by
// kind (overlay, audio, text, effect). Touch: swipe = scrub, pinch = zoom, tap = select, long-press = move.
// Mouse: drag empty space = scrub, drag a clip = move, wheel = scrub, Ctrl/⌘ + wheel = zoom.
import {
  store, sortedClips, trackAccepts, TRACK_KIND_FOR, createTrack, insertIntoMain, overlaps, packMain, clipEnd, getMedia, MIN_CLIP,
} from './store.js';
import { mediaRT } from './media.js';
import { icon } from './icons.js';
import { clamp, escapeHtml, rafThrottle } from './util.js';
import { prefs } from './db.js';
import { EFFECTS, TRANSITIONS } from './presets.js';
import * as actions from './actions.js';
import { contextMenu } from './ui.js';
import { metrics } from './metrics.js';

const MAIN_H = 64;
const LANE_H = 30;
const LANE_FOCUS_H = 42;
const GAP = 6;
const RULER_H = 26;
const TOP_PAD = RULER_H + 12;
const ZMIN = 6;
const ZMAX = 900;
const LONG_PRESS = 380;

/** Lane groups below the main track, in display order. */
export const CATEGORIES = {
  overlay: { label: 'Overlay', icon: 'layers', add: 'Tambah overlay' },
  audio: { label: 'Audio', icon: 'audio', add: 'Tambah audio' },
  text: { label: 'Teks', icon: 'text', add: 'Tambah teks' },
  effect: { label: 'Efek', icon: 'effects', add: 'Tambah efek' },
};
const ORDER = Object.keys(CATEGORIES);
const TYPE_ICON = { video: 'video', image: 'image', audio: 'audio', text: 'text', sticker: 'sticker', solid: 'palette', effect: 'effects' };

/** The lane group a clip belongs to (null for the main track). */
export function categoryOf(clip) {
  if (!clip) return null;
  const tr = store.track(clip.trackId);
  return tr && tr.kind !== 'main' ? tr.kind : null;
}

export let dragPayload = null; // set by panels on dragstart (desktop drag & drop)
export function setDragPayload(p) { dragPayload = p; }

const fmtShort = (t) => {
  const s = Math.max(0, t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const fmtClipDur = (d) => (d < 60 ? `${d.toFixed(1)}s` : `${Math.floor(d / 60)}m${String(Math.round(d % 60)).padStart(2, '0')}s`);

export class Timeline {
  constructor(root, engine) {
    this.root = root;
    this.engine = engine;
    this.pps = prefs.get('zoom', 40);
    this.snap = prefs.get('snap', true);
    this.focus = null;
    this.layoutRows = [];
    this.pad = 400;
    this.progScroll = null;
    this.userScrollUntil = 0;
    this.suppressSeek = false;
    this.root.innerHTML = `
      <div class="tl-body">
        <div class="tl-scroll">
          <div class="tl-content">
            <div class="tl-ruler-wrap"><canvas class="tl-ruler"></canvas></div>
            <div class="tl-lanes"></div>
            <div class="tl-ghost"></div>
            <div class="tl-newtrack"></div>
          </div>
        </div>
        <div class="tl-time"><b class="tl-cur">00:00</b><span>/</span><span class="tl-dur">00:00</span></div>
        <div class="tl-playhead"></div>
        <div class="tl-snapline"></div>
        <button class="tl-add" title="Tambah media ke akhir video" aria-label="Tambah media">${icon('plus', 22)}</button>
      </div>`;
    this.$ = (s) => this.root.querySelector(s);
    this.body = this.$('.tl-body');
    this.scroll = this.$('.tl-scroll');
    this.content = this.$('.tl-content');
    this.lanes = this.$('.tl-lanes');
    this.rulerWrap = this.$('.tl-ruler-wrap');
    this.ruler = this.$('.tl-ruler');
    this.playhead = this.$('.tl-playhead');
    this.snapline = this.$('.tl-snapline');
    this.ghost = this.$('.tl-ghost');
    this.newTrackLine = this.$('.tl-newtrack');
    this.addBtn = this.$('.tl-add');
    this.tCur = this.$('.tl-cur');
    this.tDur = this.$('.tl-dur');
    this.paintSoon = rafThrottle(() => { this.paintRuler(); this.paintMedia(); this.placeOverlays(); });
    this.renderSoon = rafThrottle(() => this.render());
    this.bind();
    this.lastDur = 0;
    store.on('project', (label) => {
      const d = store.duration();
      this.render();
      if ((this.lastDur === 0 && d > 0) || label === 'load') requestAnimationFrame(() => this.fit());
      this.lastDur = d;
    });
    // While a finger is on the timeline the element it touched must survive (the browser keeps sending that
    // finger's events to it), so live edits only move the existing elements; the full redraw waits.
    store.on('live', () => { if (this.touchDrag || this.pinch) this.relayout(); else this.renderSoon(); });
    store.on('selection', () => this.updateSelection());
    store.on('media', () => this.renderSoon());
    engine.on((kind) => {
      if (kind === 'time' || kind === 'pause' || kind === 'play') { this.syncScroll(); this.updateTime(); }
    });
    new ResizeObserver(() => { this.render(); }).observe(this.scroll);
    this.render();
  }

  // ---------------------------------------------------------------------------------------------
  /** Show only the main track plus one lane group (null = everything, compact). */
  setFocus(kind) {
    const k = kind && CATEGORIES[kind] ? kind : null;
    if (k === this.focus) return;
    this.focus = k;
    this.render();
  }

  timeAt(clientX) {
    const r = this.scroll.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + this.scroll.scrollLeft - this.pad) / this.pps);
  }
  xOf(t) { return this.pad + t * this.pps; }

  setZoom(pps) {
    pps = clamp(pps, ZMIN, ZMAX);
    if (Math.abs(pps - this.pps) < 1e-6) return;
    this.pps = pps;
    prefs.set('zoom', pps);
    if (this.pinch || this.touchDrag) this.relayout();
    else this.render();
    this.syncScroll(true);
  }

  /** Move and resize the existing clip elements (zoom, live trim) without rebuilding them. */
  relayout() {
    this.content.style.width = `${this.pad * 2 + store.duration() * this.pps}px`;
    for (const el of this.lanes.querySelectorAll('.clip')) {
      const c = store.clip(el.dataset.id);
      if (!c) continue;
      el.style.left = `${this.xOf(c.start)}px`;
      el.style.width = `${Math.max(4, c.duration * this.pps)}px`;
      const du = el.querySelector('.clip-dur');
      if (du) du.textContent = fmtClipDur(c.duration);
      el.querySelectorAll('.kf-dots i').forEach((i, n) => { const k = c.keyframes?.[n]; if (k) i.style.left = `${k.t * this.pps}px`; });
    }
    for (const m of this.lanes.querySelectorAll('.tr-mark')) { const c = store.clip(m.dataset.tr); if (c) m.style.left = `${this.xOf(c.start)}px`; }
    this.updateTime();
    this.paintRuler();
    this.paintMedia();
  }

  /** A touch drag / pinch ended: catch up on the redraw that waited for it. */
  releaseTouch() {
    this.touchDrag = false;
    if (this.renderPending) { this.renderPending = false; this.render(); }
  }
  /** Zoom so the whole edit spans the visible width. */
  fit() {
    const w = this.scroll.clientWidth || 800;
    this.setZoom(clamp((w - 80) / Math.max(4, store.duration()), 14, 160));
    this.syncScroll(true);
  }

  /** Keep the playhead time in the centre (programmatic scroll, not a user scrub). */
  syncScroll(force = false) {
    if (!force && performance.now() < this.userScrollUntil) return;
    const target = this.engine.time * this.pps;
    if (!force && Math.abs(this.scroll.scrollLeft - target) < 0.75) return;
    this.progScroll = target;
    this.scroll.scrollLeft = target;
    this.paintSoon();
  }

  updateTime() {
    this.tCur.textContent = fmtShort(this.engine.time);
    this.tDur.textContent = fmtShort(store.duration());
  }

  // ---------------------------------------------------------------------------------------------
  computeLayout() {
    const P = store.P;
    const rows = [];
    let y = TOP_PAD;
    const main = P.tracks.find((t) => t.kind === 'main');
    rows.push({ track: main, kind: 'main', top: y, h: MAIN_H });
    y += MAIN_H + GAP + 6;
    for (const kind of ORDER) {
      if (this.focus && this.focus !== kind) continue;
      const trs = P.tracks.filter((t) => t.kind === kind);
      if (!this.focus) {
        // Overview: one compact lane per kind; its layers open up when the kind is being edited.
        if (trs.length) { rows.push({ track: trs[0], tracks: trs, kind, top: y, h: LANE_H, first: true }); y += LANE_H + GAP; }
        continue;
      }
      trs.forEach((tr, i) => { rows.push({ track: tr, tracks: [tr], kind, top: y, h: LANE_FOCUS_H, first: i === 0 }); y += LANE_FOCUS_H + GAP; });
      rows.push({ placeholder: kind, kind, top: y, h: LANE_FOCUS_H });
      y += LANE_FOCUS_H + GAP;
    }
    this.allRows = rows;
    this.layoutRows = rows.filter((r) => r.track);
    return y;
  }

  render() {
    if (this.touchDrag || this.pinch) { this.renderPending = true; return; }
    const P = store.P;
    const vw = this.scroll.clientWidth || 800;
    this.pad = Math.round(vw / 2);
    const bottom = this.computeLayout();
    const dur = store.duration();
    this.content.style.width = `${this.pad * 2 + dur * this.pps}px`;
    this.content.style.height = `${Math.max(this.scroll.clientHeight, bottom + 8)}px`;
    this.rulerWrap.style.width = `${vw}px`;
    this.playhead.style.left = `${this.pad}px`;
    this.body.classList.toggle('focused', !!this.focus);

    const html = [];
    for (const row of this.allRows) {
      const { top, h, kind } = row;
      if (row.placeholder) {
        const cat = CATEGORIES[kind];
        html.push(`<div class="lane lane-ph kind-${kind}" style="top:${top}px;height:${h}px"><button class="lane-add" data-addkind="${kind}" style="left:${this.pad}px">${icon('plus', 14)}<span>${cat.add}</span></button></div>`);
        continue;
      }
      const tr = row.track;
      const clips = row.tracks ? row.tracks.flatMap((t) => sortedClips(P, t.id)).sort((a, b) => a.start - b.start) : sortedClips(P, tr.id);
      let inner = clips.map((c) => this.clipHtml(c, row)).join('');
      if (kind === 'main') {
        for (let i = 1; i < clips.length; i++) {
          const a = clips[i - 1];
          const b = clips[i];
          if (Math.abs(clipEnd(a) - b.start) > 0.01) continue;
          const on = b.transition?.type && b.transition.type !== 'none';
          const tdef = TRANSITIONS.find((x) => x.id === b.transition?.type);
          inner += `<button class="tr-mark ${on ? 'on' : ''}" data-tr="${b.id}" data-prev="${a.id}" style="left:${this.xOf(b.start)}px" title="${on ? `Transisi: ${tdef?.name}` : 'Tambah transisi'}" aria-label="Transisi">${on ? '<i class="bow"></i>' : '<i class="bar"></i>'}</button>`;
        }
        if (!clips.length) inner += `<button class="main-empty" data-gutter="add" style="left:${this.pad}px">${icon('plus', 18)}<span>Tambah video atau foto</span></button>`;
        inner += this.mainGutter(tr);
      } else if (row.first && !this.focus) {
        inner += `<button class="lane-cat" data-cat="${kind}" style="left:${this.pad - 40}px" title="${CATEGORIES[kind].label}" aria-label="${CATEGORIES[kind].label}">${icon(CATEGORIES[kind].icon, 15)}</button>`;
      }
      html.push(`<div class="lane kind-${kind} ${tr.hidden ? 'is-hidden' : ''} ${tr.locked ? 'is-locked' : ''}" data-track="${tr.id}" style="top:${top}px;height:${h}px">${inner}</div>`);
    }
    this.lanes.innerHTML = html.join('');
    this.lanes.style.height = `${bottom}px`;
    this.updateSelection();
    this.updateTime();
    this.paintRuler();
    this.paintMedia();
    this.placeOverlays();
    // Re-centre on the playhead after a layout change, but never fight a scrub or a drag in progress.
    if (!this.suppressSeek && performance.now() >= this.userScrollUntil) this.syncScroll(true);
  }

  mainGutter(tr) {
    const P = store.P;
    const cover = P.cover?.thumb || this.firstPoster();
    const right = this.pad - 12;
    const coverW = MAIN_H;
    const narrow = this.pad < 330;
    const items = [
      `<button class="gut-btn" data-gutter="mute" title="${tr.muted ? 'Bunyikan' : 'Bisukan'} audio semua klip utama">${icon(tr.muted ? 'mute' : 'volume', 18)}<span>${tr.muted ? 'Bunyikan audio klip' : 'Bisukan audio klip'}</span></button>`,
      narrow ? '' : `<button class="gut-btn soon" data-gutter="aicut" title="Pemotong klip AI — segera hadir">${icon('scissors', 18)}<span>Pemotong klip AI</span></button>`,
      `<button class="gut-cover" data-gutter="cover" title="Sampul video" style="width:${coverW}px;height:${coverW}px">${cover ? `<img src="${cover}" alt="">` : ''}<span>${icon('wand', 13)}Sampul</span></button>`,
    ].filter(Boolean);
    return `<div class="main-gutter" style="right:calc(100% - ${right}px)">${items.join('')}</div>`;
  }

  firstPoster() {
    const c = sortedClips(store.P, 'main').find((x) => x.mediaId);
    return c ? mediaRT.get(c.mediaId)?.poster || '' : '';
  }

  clipHtml(c, row) {
    const tr = store.track(c.trackId) || row.track;
    const x = this.xOf(c.start);
    const w = Math.max(4, c.duration * this.pps);
    const m = c.mediaId ? getMedia(store.P, c.mediaId) : null;
    let label = c.name || m?.name || '';
    if (c.type === 'text') label = c.text?.content?.replace(/\n/g, ' ') || 'Teks';
    if (c.type === 'sticker') label = c.sticker?.badge ? c.sticker.badge.text : `${c.sticker?.emoji || ''} Stiker`;
    if (c.type === 'effect') label = c.effect?.type === 'adjust' ? (c.name || 'Penyesuaian') : (EFFECTS.find((e) => e.id === c.effect?.type)?.name || c.name || 'Efek');
    const sel = store.selection === c.id ? ' selected' : '';
    const missing = c.mediaId && mediaRT.get(c.mediaId)?.status === 'missing' ? ' missing' : '';
    const fx = c.type === 'effect' ? ` fx-${c.effect?.type === 'adjust' ? 'adjust' : 'fx'}` : '';
    let style = `left:${x}px;width:${w}px`;
    if (c.type === 'solid') {
      const s = c.solid || {};
      style += `;--solid:${s.color2 ? `linear-gradient(${s.angle ?? 135}deg, ${s.color}, ${s.color2})` : s.color}`;
    }
    const strip = (c.type === 'video' || c.type === 'image') && (tr.kind === 'main' || row.h >= 36);
    const badges = [];
    if (c.speed && c.speed !== 1) badges.push(`<span class="cb">${c.speed}x</span>`);
    if (c.filter && c.filter.name !== 'none') badges.push(`<span class="cb">${icon('filter', 10)}</span>`);
    if ((c.animIn?.type && c.animIn.type !== 'none') || (c.animOut?.type && c.animOut.type !== 'none') || (c.animLoop?.type && c.animLoop.type !== 'none')) badges.push(`<span class="cb">${icon('wand', 10)}</span>`);
    if (c.muted || (tr.kind === 'main' && tr.muted && c.type === 'video')) badges.push(`<span class="cb">${icon('mute', 10)}</span>`);
    const nameLine = tr.kind === 'main'
      ? (badges.length ? `<div class="clip-badges">${badges.join('')}</div>` : '')
      : `<div class="clip-label">${icon(c.type === 'effect' && c.effect?.type === 'adjust' ? 'adjust' : TYPE_ICON[c.type], 11)}<span class="nm">${c.type === 'sticker' && !c.sticker?.badge ? escapeHtml(c.sticker?.emoji || '') : escapeHtml(label)}</span>${badges.join('')}</div>`;
    return `<div class="clip clip-${c.type}${fx}${sel}${missing}${strip ? ' has-strip' : ''}" data-id="${c.id}" style="${style}">
      ${strip ? '<div class="clip-strip"></div>' : ''}
      ${c.type === 'audio' ? '<canvas class="clip-wave"></canvas>' : ''}
      ${nameLine}
      <span class="clip-dur">${fmtClipDur(c.duration)}</span>
      ${c.keyframes?.length ? `<div class="kf-dots">${c.keyframes.map((k) => `<i style="left:${k.t * this.pps}px"></i>`).join('')}</div>` : ''}
      ${tr.locked ? '' : '<i class="trim trim-l" data-side="l"></i><i class="trim trim-r" data-side="r"></i>'}
    </div>`;
  }

  updateSelection() {
    const id = store.selection;
    this.lanes.querySelectorAll('.clip.selected').forEach((el) => el.classList.remove('selected'));
    if (id) this.lanes.querySelector(`.clip[data-id="${id}"]`)?.classList.add('selected');
    // The trim handles of the selected clip take the place of the transition buttons beside it.
    for (const m of this.lanes.querySelectorAll('.tr-mark')) m.classList.toggle('hide', !!id && (m.dataset.tr === id || m.dataset.prev === id));
  }

  /** Things outside the scrolled content that follow it: the add button next to the main track. */
  placeOverlays() {
    const main = this.layoutRows[0];
    if (!main) return;
    const y = main.top - this.scroll.scrollTop + (MAIN_H - 44) / 2;
    this.addBtn.style.transform = `translateY(${y}px)`;
    this.addBtn.style.visibility = y < RULER_H - 10 ? 'hidden' : 'visible';
  }

  // ---------------------------------------------------------------------------------------------
  paintRuler() {
    const w = this.rulerWrap.clientWidth;
    const h = this.rulerWrap.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.ruler.width !== Math.round(w * dpr)) { this.ruler.width = Math.round(w * dpr); this.ruler.style.width = `${w}px`; }
    if (this.ruler.height !== Math.round(h * dpr)) { this.ruler.height = Math.round(h * dpr); this.ruler.style.height = `${h}px`; }
    const ctx = this.ruler.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(this.root);
    const fg = cs.getPropertyValue('--text-3').trim() || '#777';
    const fg2 = cs.getPropertyValue('--text-2').trim() || '#aaa';
    const fps = store.P.fps || 30;
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    const major = steps.find((s) => s * this.pps >= 70) || 1800;
    const minor = major / 2;
    const sl = this.scroll.scrollLeft;
    const t0 = Math.max(0, Math.floor((sl - this.pad) / this.pps / minor) * minor);
    const t1 = (sl + w - this.pad) / this.pps;
    ctx.font = '500 10.5px Poppins, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let t = t0; t <= t1 + minor; t += minor) {
      const x = Math.round(this.pad + t * this.pps - sl) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      const tt = Math.round(t * fps) / fps;
      const fr = Math.round((tt % 1) * fps);
      // Seconds get a label; half seconds stay a dot unless zoomed in to single frames.
      if (isMajor && !(fr && major >= 0.5)) {
        ctx.fillStyle = fg2;
        ctx.fillText(fr ? `${fr}f` : fmtShort(tt), x, h / 2);
      } else {
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.arc(x, h / 2, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Filmstrips and waveforms for the visible part of each clip. */
  paintMedia() {
    const sl = this.scroll.scrollLeft;
    const vw = this.scroll.clientWidth;
    const P = store.P;
    for (const el of this.lanes.querySelectorAll('.clip.has-strip, .clip-audio')) {
      const c = store.clip(el.dataset.id);
      if (!c) continue;
      const rt = mediaRT.get(c.mediaId);
      const m = getMedia(P, c.mediaId);
      const left = this.xOf(c.start);
      const width = c.duration * this.pps;
      const x0 = Math.max(0, sl - left - 200);
      const x1 = Math.min(width, sl + vw - left + 200);
      if (x1 <= x0) continue;
      if (c.type === 'audio') {
        this.paintWave(el.querySelector('.clip-wave'), c, rt, x0, x1, el.clientHeight);
        continue;
      }
      const strip = el.querySelector('.clip-strip');
      if (!strip || !rt) continue;
      const h = el.clientHeight;
      if (c.type === 'image' || !rt.sprite) {
        strip.style.backgroundImage = rt.poster ? `url(${rt.poster})` : '';
        strip.innerHTML = '';
        continue;
      }
      const cellW = Math.max(24, (rt.spriteW / rt.spriteH) * h);
      const j0 = Math.floor(x0 / cellW);
      const j1 = Math.ceil(x1 / cellW);
      const key = `${j0}:${j1}:${cellW}:${this.pps}:${c.in}:${c.speed}:${h}`;
      if (strip.dataset.key === key) continue;
      strip.dataset.key = key;
      let out = '';
      const N = rt.spriteN;
      for (let j = j0; j < j1; j++) {
        const srcT = c.in + ((j * cellW + cellW / 2) / this.pps) * (c.speed || 1);
        const idx = clamp(Math.floor((srcT / (m?.duration || 1)) * N), 0, N - 1);
        out += `<i style="left:${j * cellW}px;width:${cellW}px;background-image:url(${rt.sprite});background-size:${N * cellW}px ${h}px;background-position:${-idx * cellW}px 0"></i>`;
      }
      strip.innerHTML = out;
    }
  }

  paintWave(cv, c, rt, x0, x1, h) {
    if (!cv) return;
    const peaks = rt?.peaks;
    const w = Math.max(1, Math.round(x1 - x0));
    const dpr = window.devicePixelRatio || 1;
    cv.style.left = `${x0}px`;
    cv.style.width = `${w}px`;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!peaks) return;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    const mid = h * 0.5;
    const amp = h * 0.42 * Math.min(1.6, c.volume ?? 1);
    for (let px = 0; px < w; px += 2) {
      const ta = c.in + ((x0 + px) / this.pps) * (c.speed || 1);
      const tb = c.in + ((x0 + px + 2) / this.pps) * (c.speed || 1);
      let mx = 0;
      for (let i = Math.floor(ta * 100); i <= Math.floor(tb * 100) && i < peaks.length; i++) if (peaks[i] > mx) mx = peaks[i];
      const a = Math.max(0.5, mx * amp);
      ctx.fillRect(px, mid - a, 1.4, a * 2);
    }
  }

  // ---------------------------------------------------------------------------------------------
  bind() {
    this.scroll.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.addBtn.addEventListener('click', () => actions.app.openSheet?.('media', { mode: 'append' }));

    // Wheel: scrub sideways; Ctrl/⌘ (and trackpad pinch) zooms around the playhead.
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.setZoom(this.pps * Math.exp(-e.deltaY * 0.0022));
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const r = this.scroll.getBoundingClientRect();
      const overflowY = this.scroll.scrollHeight > this.scroll.clientHeight + 2;
      const nearTop = e.clientY - r.top < TOP_PAD + MAIN_H + GAP;
      if (e.shiftKey ? overflowY : (!overflowY || nearTop)) {
        e.preventDefault();
        if (e.shiftKey) this.scroll.scrollTop += e.deltaY;
        else this.scroll.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Pinch to zoom (touch). The pan of the same gesture must not move the playhead.
    const dist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    this.scroll.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) { this.pinch = { d0: dist(e.touches) || 1, pps0: this.pps }; this.cancelPress?.(); }
    }, { passive: true });
    this.scroll.addEventListener('touchmove', (e) => {
      if (this.touchDrag) { if (e.cancelable) e.preventDefault(); return; }
      if (this.pinch && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        this.setZoom(this.pinch.pps0 * (dist(e.touches) / this.pinch.d0));
      }
    }, { passive: false });
    const endPinch = (e) => {
      if (!this.pinch || e.touches.length >= 2) return;
      this.pinch = null;
      this.renderPending = false;
      this.render();
      this.syncScroll(true);
    };
    this.scroll.addEventListener('touchend', endPinch, { passive: true });
    this.scroll.addEventListener('touchcancel', endPinch, { passive: true });

    // Ruler: tap = jump there, drag = scrub (mouse; touch scrolls natively)
    this.rulerWrap.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        const sx = e.clientX;
        const up = (ev) => { window.removeEventListener('pointerup', up); if (Math.abs(ev.clientX - sx) < 6) this.seekTo(this.timeAt(ev.clientX)); };
        window.addEventListener('pointerup', up);
        return;
      }
      this.startPan(e, (ev) => this.seekTo(this.timeAt(ev.clientX)));
    });

    this.lanes.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.lanes.addEventListener('click', (e) => this.onClick(e));
    this.lanes.addEventListener('dblclick', (e) => {
      const c = store.clip(e.target.closest('.clip')?.dataset.id);
      if (c?.type === 'text') actions.app.openSheet?.('text', { tab: 'edit' });
    });
    this.lanes.addEventListener('contextmenu', (e) => this.onContextMenu(e));

    // Drop from panels (desktop) / files
    this.scroll.addEventListener('dragover', (e) => {
      const files = e.dataTransfer?.types?.includes('Files');
      if (!dragPayload && !files) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!dragPayload) return;
      const t = this.snapTime(this.timeAt(e.clientX), dragPayload.duration || 3, null);
      this.showGhost(this.dropTarget(e.clientY, dragPayload.clipType), t, dragPayload.duration || 3, e.clientX);
    });
    this.scroll.addEventListener('dragleave', (e) => { if (!this.scroll.contains(e.relatedTarget)) this.hideGhost(); });
    this.scroll.addEventListener('drop', async (e) => {
      e.preventDefault();
      const payload = dragPayload;
      this.hideGhost();
      if (e.dataTransfer?.files?.length && !payload) {
        actions.app.library?.importFiles([...e.dataTransfer.files], { addAt: this.timeAt(e.clientX) });
        return;
      }
      if (!payload) return;
      dragPayload = null;
      const target = this.dropTarget(e.clientY, payload.clipType);
      const t = this.snapTime(this.timeAt(e.clientX), payload.duration || 3, null);
      let trackArg = 'auto';
      if (target?.track) trackArg = target.track.id;
      else if (target?.newTrack) trackArg = 'new';
      const start = target?.track?.kind === 'main' ? this.timeAt(e.clientX) : t;
      try { await payload.drop({ track: trackArg, start }); } catch (err) { actions.app.toast?.(err.message, { type: 'error' }); }
    });
  }

  onScroll() {
    const sl = this.scroll.scrollLeft;
    this.paintSoon();
    if (this.progScroll != null && Math.abs(sl - this.progScroll) < 2) { this.progScroll = null; return; }
    this.progScroll = null;
    if (this.pinch || this.suppressSeek) return;
    // The person moved the timeline: the time under the centre line is the new playhead position.
    this.userScrollUntil = performance.now() + 180;
    if (this.engine.playing) this.engine.pause();
    this.engine.seek(clamp(sl / this.pps, 0, store.duration()));
  }

  /** Scroll so time t is under the playhead. */
  seekTo(t) {
    this.engine.pause();
    this.engine.seek(clamp(t, 0, store.duration()));
    this.syncScroll(true);
  }

  /** Mouse drag on empty space or the ruler scrubs like a finger would. */
  startPan(e, onTap) {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const sl = this.scroll.scrollLeft;
    const st = this.scroll.scrollTop;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      this.body.classList.add('panning');
      this.scroll.scrollLeft = sl - (ev.clientX - sx);
      this.scroll.scrollTop = st - (ev.clientY - sy);
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.body.classList.remove('panning');
      this.justPanned = moved;
      if (!moved) onTap?.(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  onPointerDown(e) {
    if (e.button === 2) return;
    if (e.target.closest('button')) return; // gutter, transition marks, add buttons: handled on click
    const clipEl = e.target.closest('.clip');
    const touch = e.pointerType === 'touch';
    if (!clipEl) {
      if (!touch) this.startPan(e, () => { this.justPanned = false; });
      return;
    }
    const clip = store.clip(clipEl.dataset.id);
    if (!clip) return;
    const locked = store.track(clip.trackId)?.locked;
    const trim = e.target.closest('.trim');
    if (trim && store.selection === clip.id && !locked) { this.startTrim(e, clip, trim.dataset.side); return; }
    if (touch) { this.pressClip(e, clip, clipEl); return; }
    store.select(clip.id);
    if (!locked) this.startDrag(e, clip, clipEl);
  }

  /** Touch on a clip: a tap selects it, a long press lifts it so it can be moved. */
  pressClip(e, clip, el) {
    const sx = e.clientX;
    const sy = e.clientY;
    let done = false;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('pointermove', move);
      this.cancelPress = null;
    };
    const up = () => { const tap = !done; finish(); if (tap) store.select(store.selection === clip.id ? null : clip.id); };
    const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) finish(); };
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      if (store.track(clip.trackId)?.locked) return;
      this.touchDrag = true; // set first: selecting may change the lanes, and their redraw must wait
      store.select(clip.id);
      el.classList.add('lifted');
      navigator.vibrate?.(12);
      this.startDrag(e, clip, el, { immediate: true, onEnd: () => { el.classList.remove('lifted'); this.releaseTouch(); } });
    }, LONG_PRESS);
    this.cancelPress = finish;
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('pointermove', move);
  }

  onClick(e) {
    const b = e.target.closest('button');
    if (b?.dataset.tr) {
      store.select(b.dataset.tr);
      actions.app.openSheet?.('transition');
      return;
    }
    if (b?.dataset.cat) { actions.app.toolbar?.openCategory(b.dataset.cat); return; }
    if (b?.dataset.addkind) { actions.app.toolbar?.addInCategory(b.dataset.addkind); return; }
    if (b?.dataset.gutter) {
      const g = b.dataset.gutter;
      if (g === 'add') actions.app.openSheet?.('media', { mode: 'append' });
      if (g === 'mute') store.mutate('Bisukan audio klip', (P) => { const tr = P.tracks.find((t) => t.kind === 'main'); tr.muted = !tr.muted; });
      if (g === 'cover') actions.app.openSheet?.('cover');
      if (g === 'aicut') actions.app.toast?.('Pemotong klip AI segera hadir — butuh transkripsi otomatis dulu.', { type: 'info', timeout: 3200 });
      return;
    }
    if (e.target.closest('.clip')) return;
    if (this.justPanned) { this.justPanned = false; return; }
    store.select(null);
  }

  onContextMenu(e) {
    e.preventDefault();
    const clipEl = e.target.closest('.clip');
    if (!clipEl) {
      contextMenu(e.clientX, e.clientY, [
        { label: 'Tempel', icon: 'copy', kbd: 'Ctrl+V', disabled: !store.clipboard, run: () => actions.paste() },
        { label: 'Sesuaikan zoom', icon: 'fit', kbd: 'Ctrl+0', run: () => this.fit() },
      ]);
      return;
    }
    const clip = store.clip(clipEl.dataset.id);
    store.select(clip.id);
    const t = this.engine.time;
    const canSplit = t > clip.start && t < clipEnd(clip);
    contextMenu(e.clientX, e.clientY, [
      { label: 'Bagi di playhead', icon: 'split', kbd: 'Ctrl+B', disabled: !canSplit, run: () => actions.splitAt(t, clip.id) },
      { label: 'Duplikat', icon: 'copy', kbd: 'Ctrl+D', run: () => actions.duplicateClip(clip.id) },
      { label: 'Salin', icon: 'copy', kbd: 'Ctrl+C', run: () => actions.copySelected() },
      { label: 'Tempel', icon: 'copy', kbd: 'Ctrl+V', disabled: !store.clipboard, run: () => actions.paste() },
      'sep',
      { label: 'Hapus', icon: 'trash', kbd: 'Del', danger: true, run: () => actions.deleteClips([clip.id]) },
    ]);
  }

  // ---------------------------------------------------------------------------------------------
  /** Where a clip of `type` would land for a pointer at clientY: an existing lane of its kind, or a new one. */
  dropTarget(clientY, type) {
    const r = this.scroll.getBoundingClientRect();
    const y = clientY - r.top + this.scroll.scrollTop;
    const kind = TRACK_KIND_FOR[type];
    const row = this.layoutRows.find((rw) => y >= rw.top - GAP / 2 && y < rw.top + rw.h + GAP / 2);
    if (row) {
      const fits = row.track.kind === 'main' ? trackAccepts(row.track, type) : row.track.kind === kind && trackAccepts(row.track, type);
      if (fits) return { track: row.track, row };
    }
    if (y < TOP_PAD || row?.track.kind === 'main') return null;
    // A new lane of this kind, shown under the last lane of that kind (or at the bottom).
    const same = this.layoutRows.filter((rw) => rw.track.kind === kind);
    const last = same.at(-1) || this.layoutRows.at(-1);
    return { newTrack: true, y: last.top + last.h + 2 };
  }

  showGhost(target, t, dur, clientX) {
    this.ghost.style.display = 'none';
    this.newTrackLine.style.display = 'none';
    if (!target) return;
    if (target.newTrack) {
      this.newTrackLine.style.display = 'block';
      this.newTrackLine.style.top = `${target.y}px`;
      this.newTrackLine.style.left = `${this.xOf(t)}px`;
      this.newTrackLine.style.width = `${Math.max(20, dur * this.pps)}px`;
      return;
    }
    const { row } = target;
    if (row.track.kind === 'main' && store.P.magnet) {
      const pt = this.timeAt(clientX);
      const list = sortedClips(store.P, 'main').filter((c) => !this.dragging || c.id !== this.dragging);
      let x = 0;
      for (const c of list) {
        if (pt < c.start + c.duration / 2) { x = c.start; break; }
        x = clipEnd(c);
      }
      this.ghost.className = 'tl-ghost insert';
      this.ghost.style.cssText = `display:block;left:${this.xOf(x) - 2}px;top:${row.top - 3}px;height:${row.h + 6}px;width:4px`;
      return;
    }
    this.ghost.className = 'tl-ghost';
    this.ghost.style.cssText = `display:block;left:${this.xOf(t)}px;top:${row.top}px;height:${row.h}px;width:${Math.max(4, dur * this.pps)}px`;
  }
  hideGhost() {
    this.ghost.style.display = 'none';
    this.newTrackLine.style.display = 'none';
    this.snapline.style.display = 'none';
  }

  snapPoints(excludeId) {
    const pts = [0, this.engine.time];
    for (const c of store.P.clips) {
      if (c.id === excludeId) continue;
      pts.push(c.start, clipEnd(c));
    }
    return pts;
  }
  showSnap(t) {
    if (t == null) { this.snapline.style.display = 'none'; return; }
    this.snapline.style.display = 'block';
    this.snapline.style.transform = `translateX(${this.xOf(t) - this.scroll.scrollLeft}px)`;
  }
  snapTime(t, dur, excludeId, pts) {
    t = Math.max(0, t);
    if (!this.snap) { this.showSnap(null); return t; }
    const th = 10 / this.pps;
    pts = pts || this.snapPoints(excludeId);
    let best = null;
    for (const p of pts) {
      for (const [edge, off] of [[t, 0], [t + dur, dur]]) {
        const d = Math.abs(edge - p);
        if (d < th && (!best || d < best.d)) best = { d, t: p - off, at: p };
      }
    }
    this.showSnap(best ? best.at : null);
    return best ? Math.max(0, best.t) : t;
  }

  /** Scroll while dragging near an edge; the playhead catches up when the drag ends. */
  autoScroll(clientX) {
    const r = this.scroll.getBoundingClientRect();
    if (clientX > r.right - 48) this.scroll.scrollLeft += 12;
    else if (clientX < r.left + 48) this.scroll.scrollLeft -= 12;
  }
  endHold() {
    this.suppressSeek = false;
    const t = clamp(this.scroll.scrollLeft / this.pps, 0, store.duration());
    if (Math.abs(t - this.engine.time) > 1e-3) this.engine.seek(t);
    this.syncScroll(true);
  }

  startDrag(e, clip, el, { immediate = false, onEnd } = {}) {
    const sx = e.clientX;
    const sy = e.clientY;
    const grab = this.timeAt(e.clientX) - clip.start;
    const pts = this.snapPoints(clip.id);
    let dragging = false;
    let state = null;
    const begin = () => {
      dragging = true;
      this.dragging = clip.id;
      this.suppressSeek = true;
      el.classList.add('dragging');
      this.engine.pause();
    };
    if (immediate) begin();
    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        begin();
      }
      this.autoScroll(ev.clientX);
      metrics.afterPaint('timeline_drag_ms', ev.timeStamp);
      const t = this.snapTime(this.timeAt(ev.clientX) - grab, clip.duration, clip.id, pts);
      const target = this.dropTarget(ev.clientY, clip.type) || { track: store.track(clip.trackId), row: this.layoutRows.find((r) => r.track.id === clip.trackId) };
      state = { t, target, pt: this.timeAt(ev.clientX) };
      this.showGhost(target, t, clip.duration, ev.clientX);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.dragging = null;
      el.classList.remove('dragging');
      this.hideGhost();
      onEnd?.();
      if (dragging) this.endHold();
      if (!dragging || !state || !state.target?.row && !state.target?.newTrack) return;
      const { t, target, pt } = state;
      store.mutate('Pindah klip', (P) => {
        const c = P.clips.find((x) => x.id === clip.id);
        if (!c) return;
        const wasMain = c.trackId === 'main';
        if (target.newTrack) {
          const tr = createTrack(P, TRACK_KIND_FOR[c.type]);
          c.trackId = tr.id;
          c.start = t;
          if (wasMain) packMain(P);
          return;
        }
        const tr = target.track;
        if (tr.kind === 'main') {
          if (P.magnet) insertIntoMain(P, c, pt);
          else {
            c.trackId = tr.id;
            c.start = t;
            if (overlaps(P, tr.id, t, t + c.duration, c.id)) c.start = sortedClips(P, tr.id).filter((x) => x.id !== c.id).reduce((e2, x) => Math.max(e2, clipEnd(x)), 0);
          }
          return;
        }
        if (overlaps(P, tr.id, t, t + c.duration, c.id)) {
          const idx = P.tracks.indexOf(tr);
          const nt = createTrack(P, tr.kind, tr.kind === 'audio' ? idx + 1 : idx);
          c.trackId = nt.id;
        } else c.trackId = tr.id;
        c.start = t;
        if (wasMain) packMain(P);
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  startTrim(e, clip, side) {
    e.stopPropagation();
    e.preventDefault();
    this.engine.pause();
    this.suppressSeek = true;
    if (e.pointerType === 'touch') this.touchDrag = true;
    const orig = { start: clip.start, dur: clip.duration, in: clip.in || 0 };
    const id = clip.id;
    const speed = clip.speed || 1;
    const isMedia = clip.type === 'video' || clip.type === 'audio';
    const mediaDur = isMedia ? (getMedia(store.P, clip.mediaId)?.duration || Infinity) : Infinity;
    const magnetMain = clip.trackId === 'main' && store.P.magnet;
    const pts = this.snapPoints(id);
    const neighbors = sortedClips(store.P, clip.trackId).filter((c) => c.id !== id);
    const prevEnd = neighbors.filter((c) => c.start < orig.start).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    const nextStart = neighbors.filter((c) => c.start >= orig.start + orig.dur - 1e-4).reduce((m, c) => Math.min(m, c.start), Infinity);
    const grabOffset = this.timeAt(e.clientX) - (side === 'r' ? orig.start + orig.dur : orig.start);
    const move = (ev) => {
      this.autoScroll(ev.clientX);
      metrics.afterPaint('timeline_trim_ms', ev.timeStamp);
      let t = this.timeAt(ev.clientX) - grabOffset;
      if (this.snap) {
        const th = 10 / this.pps;
        const best = pts.reduce((b, p) => (Math.abs(p - t) < th && (b == null || Math.abs(p - t) < Math.abs(b - t)) ? p : b), null);
        if (best != null) t = best;
        this.showSnap(best);
      }
      store.live((P) => {
        const c = P.clips.find((x) => x.id === id);
        if (!c) return;
        if (side === 'r') {
          let end = Math.max(orig.start + MIN_CLIP, t);
          if (isMedia) end = Math.min(end, orig.start + (mediaDur - orig.in) / speed);
          if (!magnetMain) end = Math.min(end, nextStart);
          c.duration = Math.max(MIN_CLIP, end - c.start);
        } else {
          let delta = t - orig.start;
          const minDelta = isMedia ? -orig.in / speed : -Infinity;
          delta = clamp(delta, Math.max(minDelta, magnetMain ? -Infinity : prevEnd - orig.start, -orig.start), orig.dur - MIN_CLIP);
          if (isMedia || c.type === 'image') c.in = Math.max(0, orig.in + delta * speed);
          c.duration = orig.dur - delta;
          if (!magnetMain) c.start = orig.start + delta;
        }
        if (magnetMain) packMain(P);
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.showSnap(null);
      this.releaseTouch();
      store.commitLive('Pangkas klip');
      this.endHold();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
}
