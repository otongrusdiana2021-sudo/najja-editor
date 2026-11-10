// Multi-track timeline: ruler, playhead, clips, drag/trim with snapping, magnetic main track, drop from library.
import {
  store, sortedClips, trackAccepts, TRACK_KIND_FOR, createTrack, insertIntoMain, overlaps, packMain, clipEnd, getMedia, MIN_CLIP,
} from './store.js';
import { mediaRT } from './media.js';
import { icon } from './icons.js';
import { clamp, escapeHtml, fmtDur, rafThrottle } from './util.js';
import { prefs } from './db.js';
import { EFFECTS, TRANSITIONS } from './presets.js';
import * as actions from './actions.js';
import { contextMenu } from './ui.js';

const TRACK_H = { main: 64, overlay: 52, text: 32, audio: 46, effect: 28 };
const GAP = 6;
const TOP_PAD = 26;
const HEAD_W = 92;
const ZMIN = 6;
const ZMAX = 900;
const TYPE_ICON = { video: 'video', image: 'image', audio: 'audio', text: 'text', sticker: 'sticker', solid: 'palette', effect: 'effects' };

export let dragPayload = null; // set by library dragstart
export function setDragPayload(p) { dragPayload = p; }

export class Timeline {
  constructor(root, engine) {
    this.root = root;
    this.engine = engine;
    this.pps = prefs.get('zoom', 60);
    this.snap = prefs.get('snap', true);
    this.layoutRows = [];
    this.root.innerHTML = this.template();
    this.$ = (s) => this.root.querySelector(s);
    this.scroll = this.$('.tl-scroll');
    this.content = this.$('.tl-content');
    this.lanes = this.$('.tl-lanes');
    this.heads = this.$('.tl-heads-inner');
    this.ruler = this.$('.tl-ruler');
    this.playhead = this.$('.tl-playhead');
    this.snapline = this.$('.tl-snapline');
    this.ghost = this.$('.tl-ghost');
    this.newTrackLine = this.$('.tl-newtrack');
    this.zoomInput = this.$('.tl-zoom');
    this.paintSoon = rafThrottle(() => { this.paintRuler(); this.updatePlayhead(); this.paintMedia(); });
    this.renderSoon = rafThrottle(() => this.render());
    this.bind();
    this.lastDur = 0;
    this.lastTrackCount = 0;
    store.on('project', (label) => {
      const d = store.duration();
      this.render();
      // First content (or a freshly loaded project): fit the whole edit into view.
      if ((this.lastDur === 0 && d > 0) || label === 'load') requestAnimationFrame(() => { this.fit(); this.ensureMainVisible(true); });
      this.lastDur = d;
    });
    store.on('live', () => this.renderSoon());
    store.on('selection', () => this.updateSelection());
    store.on('media', () => this.renderSoon());
    engine.on((kind) => {
      if (kind === 'time' || kind === 'pause' || kind === 'play') { this.updatePlayhead(); if (engine.playing) this.follow(); }
      if (kind === 'play' || kind === 'pause') this.updateToolbar();
    });
    new ResizeObserver(() => this.paintSoon()).observe(this.scroll);
    this.render();
  }

  template() {
    const b = (act, ic, title, extra = '') => `<button class="tl-btn ${extra}" data-act="${act}" title="${title}" aria-label="${title}">${icon(ic, 17)}</button>`;
    return `
    <div class="tl-toolbar">
      <div class="tl-tools">
        ${b('undo', 'undo', 'Urungkan (Ctrl+Z)')}${b('redo', 'redo', 'Ulangi (Ctrl+Shift+Z)')}
        <span class="tl-sep"></span>
        ${b('split', 'split', 'Pisah (Ctrl+B)')}${b('delete', 'trash', 'Hapus (Delete)')}${b('duplicate', 'copy', 'Duplikat (Ctrl+D)')}
        ${b('freeze', 'freeze', 'Bekukan frame')}${b('flip', 'flipH', 'Cermin')}${b('rotate', 'rotate', 'Putar 90°')}${b('extract', 'detach', 'Ekstrak audio')}
      </div>
      <div class="tl-tools">
        ${b('magnet', 'magnet', 'Track utama magnetis', 'toggle')}${b('snap', 'snap', 'Snap otomatis', 'toggle')}
        <span class="tl-sep"></span>
        ${b('zoomOut', 'zoomOut', 'Perkecil')}<input class="tl-zoom" type="range" min="0" max="1000" aria-label="Zoom timeline">${b('zoomIn', 'zoomIn', 'Perbesar')}${b('fit', 'fit', 'Sesuaikan ke layar')}
      </div>
    </div>
    <div class="tl-body">
      <div class="tl-corner"></div>
      <div class="tl-ruler-wrap"><canvas class="tl-ruler"></canvas></div>
      <div class="tl-heads"><div class="tl-heads-inner"></div></div>
      <div class="tl-scroll">
        <div class="tl-content">
          <div class="tl-lanes"></div>
          <div class="tl-ghost"></div>
          <div class="tl-newtrack"></div>
        </div>
      </div>
      <div class="tl-playhead"><div class="tl-ph-knob"></div><div class="tl-ph-line"></div></div>
      <div class="tl-snapline"></div>
    </div>`;
  }

  // ---------------------------------------------------------------------------------------------
  get headW() { return HEAD_W; }
  timeAt(clientX) {
    const r = this.scroll.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + this.scroll.scrollLeft) / this.pps);
  }
  setZoom(pps, anchorClientX) {
    pps = clamp(pps, ZMIN, ZMAX);
    const r = this.scroll.getBoundingClientRect();
    const ax = anchorClientX ?? (r.left + Math.min(r.width / 2, Math.max(0, this.engine.time * this.pps - this.scroll.scrollLeft)));
    const tAnchor = (ax - r.left + this.scroll.scrollLeft) / this.pps;
    this.pps = pps;
    prefs.set('zoom', pps);
    this.render();
    this.scroll.scrollLeft = Math.max(0, tAnchor * pps - (ax - r.left));
    this.paintSoon();
  }
  fit() {
    const w = this.scroll.clientWidth - 60;
    this.setZoom(w / Math.max(5, store.duration()));
    this.scroll.scrollLeft = 0;
  }
  follow() {
    const x = this.engine.time * this.pps;
    const sl = this.scroll.scrollLeft;
    const w = this.scroll.clientWidth;
    if (x > sl + w - 40 || x < sl) this.scroll.scrollLeft = Math.max(0, x - 60);
  }

  // ---------------------------------------------------------------------------------------------
  computeLayout() {
    const rows = [];
    let y = TOP_PAD;
    for (const tr of store.P.tracks) {
      const h = TRACK_H[tr.kind] || 48;
      rows.push({ track: tr, top: y, h });
      y += h + GAP;
    }
    this.layoutRows = rows;
    return y;
  }

  render() {
    const P = store.P;
    const bottom = this.computeLayout();
    const dur = store.duration();
    const vw = this.scroll.clientWidth || 800;
    const width = Math.max(vw + 1, dur * this.pps + vw * 0.7);
    this.content.style.width = `${width}px`;
    this.content.style.height = `${Math.max(this.scroll.clientHeight, bottom + 60)}px`;
    this.heads.style.height = this.content.style.height;

    // track headers
    this.heads.innerHTML = this.layoutRows.map(({ track: tr, top, h }) => `
      <div class="tl-head kind-${tr.kind}" data-track="${tr.id}" style="top:${top}px;height:${h}px">
        ${tr.kind === 'main' ? `<span class="tl-head-label">${icon('video', 14)}</span>` : `<span class="tl-head-label">${icon(tr.kind === 'audio' ? 'audio' : tr.kind === 'text' ? 'text' : tr.kind === 'effect' ? 'effects' : 'layers', 14)}</span>`}
        <div class="tl-head-btns">
          <button data-hact="lock" class="${tr.locked ? 'on' : ''}" title="${tr.locked ? 'Buka kunci' : 'Kunci'} track">${icon(tr.locked ? 'lock' : 'unlock', 13)}</button>
          ${tr.kind !== 'audio' ? `<button data-hact="hide" class="${tr.hidden ? 'on' : ''}" title="${tr.hidden ? 'Tampilkan' : 'Sembunyikan'} track">${icon(tr.hidden ? 'eyeOff' : 'eye', 13)}</button>` : ''}
          ${['main', 'audio', 'overlay'].includes(tr.kind) ? `<button data-hact="mute" class="${tr.muted ? 'on' : ''}" title="${tr.muted ? 'Bunyikan' : 'Bisukan'} track">${icon(tr.muted ? 'mute' : 'volume', 13)}</button>` : ''}
        </div>
      </div>`).join('');

    // lanes
    const html = [];
    for (const { track: tr, top, h } of this.layoutRows) {
      const clips = sortedClips(P, tr.id);
      const inner = clips.map((c) => this.clipHtml(c, tr, h)).join('');
      let marks = '';
      if (tr.kind === 'main') {
        for (let i = 1; i < clips.length; i++) {
          const a = clips[i - 1];
          const b = clips[i];
          if (Math.abs(clipEnd(a) - b.start) > 0.01) continue;
          const on = b.transition?.type && b.transition.type !== 'none';
          const tdef = TRANSITIONS.find((x) => x.id === b.transition?.type);
          marks += `<button class="tr-mark ${on ? 'on' : ''}" data-tr="${b.id}" style="left:${b.start * this.pps}px" title="${on ? `Transisi: ${tdef?.name}` : 'Tambah transisi'}">${on ? '⧓' : '+'}</button>`;
        }
        if (!clips.length) marks = `<div class="lane-empty">${icon('upload', 16)}<span>Tarik media ke sini untuk mulai mengedit</span></div>`;
      }
      html.push(`<div class="lane kind-${tr.kind} ${tr.hidden ? 'is-hidden' : ''} ${tr.locked ? 'is-locked' : ''}" data-track="${tr.id}" style="top:${top}px;height:${h}px">${inner}${marks}</div>`);
    }
    this.lanes.innerHTML = html.join('');
    this.updateToolbar();
    this.paintRuler();
    this.updatePlayhead();
    this.paintMedia();
    // Keep the main track visible when tracks are added above it.
    if (this.layoutRows.length !== this.lastTrackCount) {
      this.lastTrackCount = this.layoutRows.length;
      this.ensureMainVisible(false);
    }
  }

  ensureMainVisible(force) {
    const main = this.layoutRows.find((r) => r.track.kind === 'main');
    if (!main || !this.scroll.clientHeight) return;
    const below = this.layoutRows.filter((r) => r.track.kind === 'audio').reduce((a, r) => a + r.h + GAP, 0);
    const want = Math.max(0, main.top + main.h + below + 24 - this.scroll.clientHeight);
    const hidden = main.top + main.h > this.scroll.scrollTop + this.scroll.clientHeight || main.top < this.scroll.scrollTop;
    if (force || hidden) this.scroll.scrollTop = Math.min(want, Math.max(0, main.top - 8));
  }

  clipHtml(c, tr, h) {
    const left = c.start * this.pps;
    const width = Math.max(3, c.duration * this.pps);
    const m = c.mediaId ? getMedia(store.P, c.mediaId) : null;
    let label = c.name || m?.name || '';
    if (c.type === 'text') label = c.text?.content?.replace(/\n/g, ' ') || 'Teks';
    if (c.type === 'sticker') label = c.sticker?.badge ? c.sticker.badge.text : `${c.sticker?.emoji || ''} Stiker`;
    if (c.type === 'effect') label = EFFECTS.find((e) => e.id === c.effect?.type)?.name || 'Efek';
    const sel = store.selection === c.id ? ' selected' : '';
    const missing = c.mediaId && mediaRT.get(c.mediaId)?.status === 'missing' ? ' missing' : '';
    let style = `left:${left}px;width:${width}px`;
    if (c.type === 'solid') {
      const s = c.solid || {};
      style += `;--solid:${s.color2 ? `linear-gradient(${(s.angle ?? 135) - 45 + 45}deg, ${s.color}, ${s.color2})` : s.color}`;
    }
    const badges = [];
    if (c.speed && c.speed !== 1) badges.push(`<span class="cb">${c.speed}x</span>`);
    if (c.filter && c.filter.name !== 'none') badges.push(`<span class="cb">${icon('filter', 11)}</span>`);
    if ((c.animIn?.type && c.animIn.type !== 'none') || (c.animOut?.type && c.animOut.type !== 'none') || (c.animLoop?.type && c.animLoop.type !== 'none')) badges.push(`<span class="cb">${icon('wand', 11)}</span>`);
    if (c.muted) badges.push(`<span class="cb">${icon('mute', 11)}</span>`);
    const showDur = width > 70;
    return `<div class="clip clip-${c.type}${sel}${missing}" data-id="${c.id}" style="${style}">
      ${c.type === 'video' || c.type === 'image' ? '<div class="clip-strip"></div>' : ''}
      ${c.type === 'audio' ? '<canvas class="clip-wave"></canvas>' : ''}
      <div class="clip-label">${icon(TYPE_ICON[c.type], 12)}<span class="nm">${escapeHtml(label)}</span>${showDur ? `<span class="du">${fmtDur(c.duration)}</span>` : ''}</div>
      ${badges.length && h >= 40 ? `<div class="clip-badges">${badges.join('')}</div>` : ''}
      ${c.keyframes?.length ? `<div class="kf-dots">${c.keyframes.map((k) => `<i style="left:${k.t * this.pps}px"></i>`).join('')}</div>` : ''}
      ${tr.locked ? '' : '<div class="trim trim-l" data-side="l"></div><div class="trim trim-r" data-side="r"></div>'}
    </div>`;
  }

  updateSelection() {
    this.lanes.querySelectorAll('.clip.selected').forEach((el) => el.classList.remove('selected'));
    if (store.selection) this.lanes.querySelector(`.clip[data-id="${store.selection}"]`)?.classList.add('selected');
    this.updateToolbar();
  }

  updateToolbar() {
    const P = store.P;
    const q = (a) => this.root.querySelector(`[data-act="${a}"]`);
    q('undo').disabled = !store.past.length;
    q('redo').disabled = !store.future.length;
    const sel = store.selected();
    q('delete').disabled = !sel;
    q('duplicate').disabled = !sel;
    q('extract').disabled = !(sel && sel.type === 'video');
    q('magnet').classList.toggle('on', !!P.magnet);
    q('snap').classList.toggle('on', !!this.snap);
    const v = (Math.log(this.pps / ZMIN) / Math.log(ZMAX / ZMIN)) * 1000;
    if (document.activeElement !== this.zoomInput) this.zoomInput.value = String(Math.round(v));
  }

  // ---------------------------------------------------------------------------------------------
  paintRuler() {
    const wrap = this.ruler.parentElement;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
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
    const major = steps.find((s) => s * this.pps >= 84) || 1800;
    const minor = major / (major >= 1 ? (major % 5 === 0 ? 5 : major === 2 ? 4 : 2) : 2);
    const sl = this.scroll.scrollLeft;
    const t0 = Math.floor(sl / this.pps / minor) * minor;
    const t1 = (sl + w) / this.pps;
    ctx.font = '500 10px Poppins, sans-serif';
    ctx.textBaseline = 'top';
    for (let t = t0; t <= t1 + minor; t += minor) {
      const x = Math.round(t * this.pps - sl) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? fg2 : fg;
      ctx.globalAlpha = isMajor ? 0.9 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, h - (isMajor ? 9 : 5));
      ctx.stroke();
      if (isMajor) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = fg2;
        const tt = Math.round(t * fps) / fps;
        const mm = String(Math.floor(tt / 60)).padStart(2, '0');
        const ss = String(Math.floor(tt % 60)).padStart(2, '0');
        const fr = Math.round((tt % 1) * fps);
        ctx.fillText(major < 1 && fr ? `${fr}f` : `${mm}:${ss}`, x + 4, 5);
      }
    }
  }

  updatePlayhead() {
    const x = this.engine.time * this.pps - this.scroll.scrollLeft;
    this.playhead.style.transform = `translateX(${HEAD_W + x}px)`;
    this.playhead.style.visibility = x < -1 || x > this.scroll.clientWidth + 1 ? 'hidden' : 'visible';
  }

  /** Filmstrips and waveforms for the visible part of each clip. */
  paintMedia() {
    const sl = this.scroll.scrollLeft;
    const vw = this.scroll.clientWidth;
    const P = store.P;
    for (const el of this.lanes.querySelectorAll('.clip-video, .clip-image, .clip-audio')) {
      const c = store.clip(el.dataset.id);
      if (!c) continue;
      const rt = mediaRT.get(c.mediaId);
      const m = getMedia(P, c.mediaId);
      const left = c.start * this.pps;
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
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const mid = h * 0.58;
    const amp = h * 0.36 * Math.min(1.6, c.volume ?? 1);
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
    this.root.querySelector('.tl-toolbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const t = this.engine.time;
      switch (act) {
        case 'undo': store.undo(); break;
        case 'redo': store.redo(); break;
        case 'split': actions.splitAt(t); break;
        case 'delete': actions.deleteSelected(); break;
        case 'duplicate': if (store.selection) actions.duplicateClip(store.selection); break;
        case 'freeze': actions.freezeFrame(); break;
        case 'flip': actions.toggleFlip('h'); break;
        case 'rotate': actions.rotate90(); break;
        case 'extract': actions.extractAudio(); break;
        case 'magnet': actions.setMagnet(!store.P.magnet); break;
        case 'snap': this.snap = !this.snap; prefs.set('snap', this.snap); this.updateToolbar(); break;
        case 'zoomIn': this.setZoom(this.pps * 1.4); break;
        case 'zoomOut': this.setZoom(this.pps / 1.4); break;
        case 'fit': this.fit(); break;
        default: break;
      }
    });
    this.zoomInput.addEventListener('input', () => {
      this.setZoom(ZMIN * (ZMAX / ZMIN) ** (Number(this.zoomInput.value) / 1000));
    });

    this.scroll.addEventListener('scroll', () => {
      this.heads.style.transform = `translateY(${-this.scroll.scrollTop}px)`;
      this.paintSoon();
    }, { passive: true });

    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.setZoom(this.pps * Math.exp(-e.deltaY * 0.0022), e.clientX);
      } else if (e.shiftKey && !e.deltaX) {
        e.preventDefault();
        this.scroll.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Ruler + playhead scrubbing
    const scrubFrom = (e) => {
      e.preventDefault();
      const wasPlaying = this.engine.playing;
      this.engine.pause();
      const seek = (ev) => this.engine.seek(this.timeAt(ev.clientX));
      seek(e);
      const move = (ev) => seek(ev);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (wasPlaying) this.engine.play();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    this.ruler.parentElement.addEventListener('pointerdown', scrubFrom);
    this.playhead.querySelector('.tl-ph-knob').addEventListener('pointerdown', scrubFrom);

    // Track header buttons
    this.heads.addEventListener('click', (e) => {
      const b = e.target.closest('[data-hact]');
      if (!b) return;
      const id = b.closest('[data-track]').dataset.track;
      store.mutate('Track', () => {
        const tr = store.track(id);
        if (!tr) return;
        if (b.dataset.hact === 'lock') tr.locked = !tr.locked;
        if (b.dataset.hact === 'hide') tr.hidden = !tr.hidden;
        if (b.dataset.hact === 'mute') tr.muted = !tr.muted;
      });
    });

    // Clips
    this.lanes.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      const mark = e.target.closest('.tr-mark');
      if (mark) {
        e.stopPropagation();
        store.select(mark.dataset.tr);
        actions.app.library?.open('transition');
        return;
      }
      const clipEl = e.target.closest('.clip');
      if (!clipEl) {
        store.select(null);
        scrubFrom(e);
        return;
      }
      const clip = store.clip(clipEl.dataset.id);
      if (!clip) return;
      store.select(clip.id);
      const tr = store.track(clip.trackId);
      if (tr?.locked) return;
      const trim = e.target.closest('.trim');
      if (trim) this.startTrim(e, clip, trim.dataset.side);
      else this.startDrag(e, clip, clipEl);
    });
    this.lanes.addEventListener('dblclick', (e) => {
      const clipEl = e.target.closest('.clip');
      if (!clipEl) return;
      actions.app.inspector?.focusPrimary();
    });
    this.lanes.addEventListener('contextmenu', (e) => {
      const clipEl = e.target.closest('.clip');
      e.preventDefault();
      if (!clipEl) {
        contextMenu(e.clientX, e.clientY, [
          { label: 'Tempel', icon: 'copy', kbd: 'Ctrl+V', disabled: !store.clipboard, run: () => actions.paste() },
          { label: 'Sesuaikan zoom', icon: 'fit', run: () => this.fit() },
        ]);
        return;
      }
      const clip = store.clip(clipEl.dataset.id);
      store.select(clip.id);
      const t = this.engine.time;
      const canSplit = t > clip.start && t < clipEnd(clip);
      contextMenu(e.clientX, e.clientY, [
        { label: 'Pisah di playhead', icon: 'split', kbd: 'Ctrl+B', disabled: !canSplit, run: () => actions.splitAt(t, clip.id) },
        { label: 'Duplikat', icon: 'copy', kbd: 'Ctrl+D', run: () => actions.duplicateClip(clip.id) },
        { label: 'Salin', icon: 'copy', kbd: 'Ctrl+C', run: () => actions.copySelected() },
        { label: 'Tempel', icon: 'copy', kbd: 'Ctrl+V', disabled: !store.clipboard, run: () => actions.paste() },
        'sep',
        ...(clip.type === 'video' ? [
          { label: 'Ekstrak audio', icon: 'detach', run: () => actions.extractAudio(clip.id) },
          { label: 'Bekukan frame', icon: 'freeze', disabled: !canSplit, run: () => actions.freezeFrame() },
        ] : []),
        ...(clip.type !== 'audio' && clip.type !== 'effect' ? [{ label: 'Cermin', icon: 'flipH', run: () => actions.toggleFlip('h') }] : []),
        'sep',
        { label: 'Hapus', icon: 'trash', kbd: 'Del', danger: true, run: () => actions.deleteClips([clip.id]) },
      ]);
    });

    // Drop from library / files
    this.scroll.addEventListener('dragover', (e) => {
      const files = e.dataTransfer?.types?.includes('Files');
      if (!dragPayload && !files) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!dragPayload) return;
      const type = dragPayload.clipType;
      const t = this.snapTime(Math.max(0, this.timeAt(e.clientX)), dragPayload.duration || 3, null);
      const target = this.dropTarget(e.clientY, type);
      this.showGhost(target, t, dragPayload.duration || 3, e.clientX);
    });
    this.scroll.addEventListener('dragleave', (e) => {
      if (!this.scroll.contains(e.relatedTarget)) this.hideGhost();
    });
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
      const t = this.snapTime(Math.max(0, this.timeAt(e.clientX)), payload.duration || 3, null);
      let trackArg = 'auto';
      if (target?.track) trackArg = target.track.id;
      else if (target?.newTop || target?.newBottom) trackArg = 'new';
      const start = target?.track?.kind === 'main' ? this.timeAt(e.clientX) : t;
      try {
        await payload.drop({ track: trackArg, start });
      } catch (err) {
        actions.app.toast?.(err.message, { type: 'error' });
      }
    });
  }

  // ---------------------------------------------------------------------------------------------
  /** Which track the pointer is over, for a clip of `type`. */
  dropTarget(clientY, type) {
    const r = this.scroll.getBoundingClientRect();
    const y = clientY - r.top + this.scroll.scrollTop;
    const rows = this.layoutRows;
    if (!rows.length) return null;
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (y < first.top - 2) return type === 'audio' ? null : { newTop: true };
    if (y > last.top + last.h + 2) return type === 'audio' ? { newBottom: true } : null;
    let row = rows.find((rw) => y >= rw.top - GAP / 2 && y < rw.top + rw.h + GAP / 2);
    if (!row) row = y < first.top ? first : last;
    if (!trackAccepts(row.track, type)) {
      if (type === 'audio') return { newBottom: true };
      if (row.track.kind === 'audio') return null;
      if (row.track.kind === 'main' || row.track.kind === 'effect') return null;
      return null;
    }
    return { track: row.track, row };
  }

  showGhost(target, t, dur, clientX) {
    this.ghost.style.display = 'none';
    this.newTrackLine.style.display = 'none';
    if (!target) return;
    if (target.newTop || target.newBottom) {
      const rows = this.layoutRows;
      const y = target.newTop ? rows[0].top - 4 : rows[rows.length - 1].top + rows[rows.length - 1].h + 2;
      this.newTrackLine.style.display = 'block';
      this.newTrackLine.style.top = `${y}px`;
      this.newTrackLine.style.left = `${t * this.pps}px`;
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
      this.ghost.style.cssText = `display:block;left:${x * this.pps - 2}px;top:${row.top - 3}px;height:${row.h + 6}px;width:4px`;
      return;
    }
    this.ghost.className = 'tl-ghost';
    this.ghost.style.cssText = `display:block;left:${t * this.pps}px;top:${row.top}px;height:${row.h}px;width:${Math.max(4, dur * this.pps)}px`;
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
    const x = HEAD_W + t * this.pps - this.scroll.scrollLeft;
    this.snapline.style.display = 'block';
    this.snapline.style.transform = `translateX(${x}px)`;
  }
  snapTime(t, dur, excludeId, pts) {
    if (!this.snap) { this.showSnap(null); return t; }
    const th = 8 / this.pps;
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

  autoScroll(clientX) {
    const r = this.scroll.getBoundingClientRect();
    if (clientX > r.right - 40) this.scroll.scrollLeft += 14;
    else if (clientX < r.left + 30) this.scroll.scrollLeft -= 14;
  }

  startDrag(e, clip, el) {
    const sx = e.clientX;
    const sy = e.clientY;
    const grab = this.timeAt(e.clientX) - clip.start;
    const pts = this.snapPoints(clip.id);
    let dragging = false;
    let state = null;
    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        dragging = true;
        this.dragging = clip.id;
        el.classList.add('dragging');
        this.engine.pause();
      }
      this.autoScroll(ev.clientX);
      const t = this.snapTime(Math.max(0, this.timeAt(ev.clientX) - grab), clip.duration, clip.id, pts);
      const target = this.dropTarget(ev.clientY, clip.type) || { track: store.track(clip.trackId), row: this.layoutRows.find((r) => r.track.id === clip.trackId) };
      state = { t, target, pt: this.timeAt(ev.clientX) };
      this.showGhost(target, t, clip.duration, ev.clientX);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.dragging = null;
      el.classList.remove('dragging');
      this.hideGhost();
      if (!dragging || !state) return;
      const { t, target, pt } = state;
      store.mutate('Pindah klip', (P) => {
        const c = P.clips.find((x) => x.id === clip.id);
        if (!c) return;
        if (target.newTop || target.newBottom) {
          const kind = TRACK_KIND_FOR[c.type];
          const tr = createTrack(P, kind);
          c.trackId = tr.id;
          c.start = t;
          return;
        }
        const tr = target.track;
        if (tr.kind === 'main') {
          if (P.magnet) insertIntoMain(P, c, pt - grab + c.duration / 2 > 0 ? pt : 0);
          else {
            c.trackId = 'main';
            c.start = t;
            if (overlaps(P, 'main', t, t + c.duration, c.id)) c.start = sortedClips(P, 'main').filter((x) => x.id !== c.id).reduce((e2, x) => Math.max(e2, clipEnd(x)), 0);
          }
          return;
        }
        if (overlaps(P, tr.id, t, t + c.duration, c.id)) {
          const idx = P.tracks.indexOf(tr);
          const nt = createTrack(P, tr.kind, tr.kind === 'audio' ? idx + 1 : idx);
          c.trackId = nt.id;
        } else c.trackId = tr.id;
        c.start = t;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  startTrim(e, clip, side) {
    e.stopPropagation();
    this.engine.pause();
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
    const move = (ev) => {
      this.autoScroll(ev.clientX);
      let t = this.timeAt(ev.clientX);
      if (this.snap) {
        const th = 8 / this.pps;
        const best = pts.reduce((b, p) => (Math.abs(p - t) < th && (!b || Math.abs(p - t) < Math.abs(b - t)) ? p : b), null);
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
      this.showSnap(null);
      store.commitLive('Pangkas klip');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}
