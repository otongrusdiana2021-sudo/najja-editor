// Playback engine: master clock, media element sync, Web Audio mixing and preview rendering.
import { store, sortedClips } from './store.js';
import { mediaRT } from './media.js';
import { renderFrame, preloadFonts, onFontsLoaded } from './render.js';
import { clamp } from './util.js';

const AC = window.AudioContext || window.webkitAudioContext;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.time = 0;
    this.playing = false;
    this.loop = false;
    this.els = new Map(); // element key (first clip of a chain) -> { el, mediaId, url, clip, gain, src, hold }
    this.buffering = false;
    this.boxes = new Map();
    this.needsRender = true;
    this.exportTarget = null;
    this.audioCtx = null;
    this.master = null;
    this.monitor = null;
    this.listeners = new Set();
    this.lastEmit = 0;
    onFontsLoaded(() => this.requestRender());
    store.on('project', () => { this.clampTime(); this.sync(); this.requestRender(); });
    store.on('live', () => { this.sync(); this.requestRender(); });
    store.on('media', () => { if (store.P) this.sync(); this.requestRender(); });
    const resume = () => { if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => {}); };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
    this.raf = (now) => { requestAnimationFrame(this.raf); this.tick(now); };
    requestAnimationFrame(this.raf);
    // Keep ticking in background tabs (rAF pauses there) so exports and playback continue.
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),16)'], { type: 'text/javascript' })));
      w.onmessage = () => { if (document.hidden && (this.playing || this.exportTarget)) this.tick(performance.now()); };
    } catch { /* ignore */ }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind) { for (const fn of this.listeners) fn(kind, this); }
  get duration() { return store.duration(); }

  ensureAudio() {
    if (!AC) return null;
    if (!this.audioCtx) {
      this.audioCtx = new AC({ latencyHint: 'interactive' });
      this.master = this.audioCtx.createGain();
      this.monitor = this.audioCtx.createGain();
      this.master.connect(this.monitor).connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }

  clampTime() {
    const d = this.duration;
    if (this.time > d) this.time = d;
  }

  play() {
    const d = this.duration;
    if (d <= 0) return;
    if (this.time >= d - 0.02) this.time = 0;
    this.ensureAudio();
    this.playing = true;
    this.buffering = false;
    this.clockBase = this.time;
    this.clockStart = performance.now();
    this.sync();
    this.emit('play');
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this.buffering) { this.buffering = false; this.emit('buffer'); }
    this.sync();
    this.requestRender();
    this.emit('pause');
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(t) {
    this.time = clamp(t, 0, Math.max(0, this.duration));
    if (this.playing) { this.clockBase = this.time; this.clockStart = performance.now(); }
    this.sync();
    this.requestRender();
    this.emit('time');
  }
  step(frames) {
    const fps = store.P.fps || 30;
    this.pause();
    this.seek(Math.round((this.time + frames / fps) * fps) / fps);
  }
  requestRender() { this.needsRender = true; }

  tick(now) {
    if (this.playing) {
      if (this.buffering) {
        // Hold the playhead until the main video has data again (instead of racing ahead and flashing black).
        const M = this.masterEl();
        this.clockBase = this.time;
        this.clockStart = now;
        const giveUp = now - this.bufferSince > 15000;
        if (!M || this.exportTarget || Engine.canResume(M.el) || giveUp) {
          if (M && giveUp) M.noHold = true; // this file will not load: play on rather than stall again
          if (M && !M.el.seeking) {
            const c = M.clip;
            const tt = c.start + (M.el.currentTime - c.in) / (c.speed || 1);
            if (Math.abs(tt - this.time) < 1) this.time = this.clockBase = tt;
          }
          this.buffering = false;
          this.emit('buffer');
        }
      } else {
        this.time = this.clockBase + (now - this.clockStart) / 1000;
        const M = !this.exportTarget && this.masterEl();
        if (M && !M.noHold && (M.el.played.length || M.el.readyState < 2) && Engine.starved(M.el)) {
          this.buffering = true;
          this.bufferSince = now;
          this.emit('buffer');
        }
      }
      const d = this.duration;
      if (this.time >= d) {
        if (this.loop && !this.exportTarget && d > 0) {
          this.time = 0;
          this.clockBase = 0;
          this.clockStart = now;
        } else {
          this.time = d;
          this.playing = false;
          this.emit('ended');
          this.emit('pause');
        }
      }
      this.sync();
      this.emit('time');
    }
    if (this.exportTarget) this.renderExport();
    if (this.playing || this.needsRender) {
      this.needsRender = false;
      this.render();
    }
  }

  env(s, boxes = null) {
    return {
      project: store.P,
      s,
      boxes,
      mediaMeta: (id) => store.media(id),
      source: (clip) => this.sourceFor(clip),
    };
  }
  sourceFor(clip) {
    if (clip.type === 'image') {
      const img = mediaRT.get(clip.mediaId)?.img;
      return img && img.complete && img.naturalWidth ? { el: img, w: img.naturalWidth, h: img.naturalHeight } : null;
    }
    if (clip.type === 'video') {
      const E = this.els.get(this.keyFor(clip));
      const v = E?.el;
      if (v && v.readyState >= 2 && v.videoWidth && !v.seeking) return { el: v, w: v.videoWidth, h: v.videoHeight };
      return E?.hold || null; // while seeking or stalled: the last picture instead of a black gap
    }
    return null;
  }

  render() {
    const P = store.P;
    if (!this.canvas.width) return;
    renderFrame(this.ctx, this.time, this.env(this.canvas.width / P.width, this.boxes));
    this.emit('render');
  }

  // ---------------------------------------------------------------------------------------------
  // Media elements
  /**
   * Clips cut from one continuous stretch of the same file (split clips, jump cuts) share one media
   * element, so playback runs straight through the cut: no seek, no extra download, no flash.
   * Returns Map clipId -> element key (the id of the first clip in its chain).
   */
  chainKeys(P) {
    const keys = new Map();
    const byTrack = new Map();
    for (const c of P.clips) {
      if (c.type !== 'video' && c.type !== 'audio') continue;
      if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
      byTrack.get(c.trackId).push(c);
    }
    for (const list of byTrack.values()) {
      list.sort((a, b) => a.start - b.start);
      let prev = null;
      for (const c of list) {
        const sp = c.speed || 1;
        const joins = !!prev && prev.mediaId === c.mediaId && prev.type === c.type
          && Math.abs((prev.speed || 1) - sp) < 1e-6
          && Math.abs(prev.start + prev.duration - c.start) < 0.002
          && Math.abs(prev.in + prev.duration * sp - c.in) < 0.05
          && !(c.transition?.type && c.transition.type !== 'none');
        keys.set(c.id, joins ? keys.get(prev.id) : c.id);
        prev = c;
      }
    }
    return keys;
  }
  keyFor(clip) { return this.keys?.get(clip.id) || clip.id; }

  createEl(key, clip) {
    const rt = mediaRT.get(clip.mediaId);
    if (!rt?.url) return null;
    const el = document.createElement(clip.type === 'audio' ? 'audio' : 'video');
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.src = rt.url;
    const E = { el, mediaId: clip.mediaId, url: rt.url, clip, gain: null, src: null, vol: -1, hold: null };
    const ctx = this.ensureAudio();
    if (ctx) {
      try {
        E.src = ctx.createMediaElementSource(el);
        E.gain = ctx.createGain();
        E.gain.gain.value = 0;
        E.src.connect(E.gain).connect(this.master);
      } catch { E.src = null; }
    }
    if (!E.src) el.volume = 0;
    const rr = () => this.requestRender();
    el.addEventListener('loadeddata', rr);
    el.addEventListener('seeked', rr);
    this.els.set(key, E);
    return E;
  }
  /** Keep the current picture so a seek or a stall shows the last frame instead of a black gap. */
  holdFrame(E) {
    const v = E.el;
    if (E.clip?.type !== 'video' || v.readyState < 2 || !v.videoWidth || v.seeking) return;
    const k = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(1, Math.round(v.videoWidth * k));
    const h = Math.max(1, Math.round(v.videoHeight * k));
    const c = E.hold && E.hold.w === w && E.hold.h === h ? E.hold.el : Object.assign(document.createElement('canvas'), { width: w, height: h });
    try {
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      E.hold = { el: c, w, h };
    } catch { /* keep the previous picture */ }
  }
  seekEl(E, t) {
    this.holdFrame(E);
    E.el.currentTime = t;
  }
  disposeEl(id) {
    const E = this.els.get(id);
    if (!E) return;
    try { E.el.pause(); } catch { /* ignore */ }
    try { E.src?.disconnect(); E.gain?.disconnect(); } catch { /* ignore */ }
    E.el.removeAttribute('src');
    try { E.el.load(); } catch { /* ignore */ }
    this.els.delete(id);
  }
  setGain(E, v) {
    if (Math.abs(E.vol - v) < 0.001) return;
    E.vol = v;
    if (E.gain && this.audioCtx) E.gain.gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.015);
    else E.el.volume = clamp(v, 0, 1);
  }

  /** Keep each media element in step with the timeline clock. */
  sync() {
    const P = store.P;
    if (!P) return;
    const t = this.time;
    this.keys = this.chainKeys(P);
    const mainList = sortedClips(P, 'main');
    const margins = (clip) => {
      if (clip.trackId !== 'main') return [0, 0];
      const i = mainList.indexOf(clip);
      const pre = clip.transition?.type && clip.transition.type !== 'none' ? (clip.transition.duration || 0.6) / 2 : 0;
      const next = mainList[i + 1];
      const post = next?.transition?.type && next.transition.type !== 'none' ? (next.transition.duration || 0.6) / 2 : 0;
      return [pre, post];
    };
    const groups = new Map();
    for (const clip of P.clips) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      const k = this.keyFor(clip);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(clip);
    }
    const lookahead = this.playing ? 2.5 : 0.5;
    const running = this.playing && !this.buffering;
    const alive = new Set();
    for (const [key, clips] of groups) {
      // The clip driving this element now: the one on screen, else the next to start, else the one just ended.
      const win = (c) => { const [pre, post] = margins(c); return [c.start - pre, c.start + c.duration + post]; };
      const clip = clips.find((c) => { const [a, b] = win(c); return t >= a && t < b; })
        || clips.find((c) => { const [a] = win(c); return t < a && t >= a - lookahead; })
        || clips.find((c) => { const [, b] = win(c); return t >= b && t <= b + 1; });
      if (!clip) {
        const E = this.els.get(key);
        if (E && clips.some((c) => t >= c.start - 12 && t <= c.start + c.duration + 12)) {
          alive.add(key);
          if (!E.el.paused) E.el.pause();
          this.setGain(E, 0);
        }
        continue;
      }
      const tr = store.track(clip.trackId);
      const end = clip.start + clip.duration;
      let E = this.els.get(key);
      const want = mediaRT.get(clip.mediaId)?.url;
      if (E && E.mediaId !== clip.mediaId) { this.disposeEl(key); E = null; }
      // New source for this media (H.264 copy, or the copy saved on this device): swap it in when that
      // cannot cause a visible gap — while paused, or when the current element shows no picture anyway.
      if (E && want && E.url !== want && (!(this.playing || this.exportTarget) || (clip.type === 'video' && !E.el.videoWidth))) {
        this.disposeEl(key);
        E = null;
      }
      if (!E) E = this.createEl(key, clip);
      if (!E) continue;
      E.clip = clip;
      alive.add(key);
      const el = E.el;
      const speed = clip.speed || 1;
      const srcEnd = clip.in + clip.duration * speed;
      const local = clamp(clip.in + (t - clip.start) * speed, clip.in, Math.max(clip.in, srcEnd - 0.04));
      const active = t >= clip.start && t < end;
      if (Math.abs(el.playbackRate - speed) > 0.001) el.playbackRate = speed;
      if (running && active && el.readyState >= 1) {
        if (el.paused) {
          if (Math.abs(el.currentTime - local) > 0.05) this.seekEl(E, local);
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - local) > 0.3 && !el.seeking) {
          this.seekEl(E, local);
        }
      } else {
        if (!el.paused) el.pause();
        // While buffering, leave positions alone: seeking a starved element only makes it wait longer.
        if (!this.buffering && el.readyState >= 1 && !el.seeking && Math.abs(el.currentTime - local) > 0.02) this.seekEl(E, local);
      }
      let vol = 0;
      if (active && running && !clip.muted && !tr?.muted) {
        vol = clip.volume ?? 1;
        const lt = t - clip.start;
        if (clip.fadeIn > 0) vol *= clamp(lt / clip.fadeIn, 0, 1);
        if (clip.fadeOut > 0) vol *= clamp((clip.duration - lt) / clip.fadeOut, 0, 1);
      }
      this.setGain(E, vol);
    }
    for (const id of [...this.els.keys()]) if (!alive.has(id)) this.disposeEl(id);
  }

  /** The main-track video on screen now (the preview clock waits for it when it runs out of data). */
  masterEl() {
    for (const E of this.els.values()) {
      const c = E.clip;
      if (c?.type === 'video' && c.trackId === 'main' && this.time >= c.start && this.time < c.start + c.duration) return E;
    }
    return null;
  }
  /** Seconds of media buffered ahead of the playhead of an element. */
  static bufferedAhead(el) {
    const b = el.buffered;
    for (let i = 0; i < b.length; i++) if (el.currentTime >= b.start(i) - 0.05 && el.currentTime <= b.end(i)) return b.end(i) - el.currentTime;
    return 0;
  }
  static starved(el) {
    if (el.error || el.ended || !el.duration || el.currentTime >= el.duration - 0.3) return false;
    return el.readyState < 3 || el.seeking;
  }
  static canResume(el) {
    if (el.seeking || el.readyState < 3) return false;
    return el.readyState >= 4 || Engine.bufferedAhead(el) >= Math.min(3, el.duration - el.currentTime - 0.1);
  }

  /** Wait until every media element needed at the current time has a decoded frame. */
  async settle(timeout = 4000) {
    const deadline = performance.now() + timeout;
    for (;;) {
      this.sync();
      const pending = [];
      for (const E of this.els.values()) {
        const c = E.clip;
        if (!c) continue;
        const near = this.time >= c.start - 1 && this.time <= c.start + c.duration + 1;
        if (near && (E.el.readyState < 2 || E.el.seeking)) pending.push(E.el);
      }
      if (!pending.length || performance.now() > deadline) return;
      await Promise.race([
        ...pending.map((el) => new Promise((r) => { el.addEventListener('seeked', r, { once: true }); el.addEventListener('loadeddata', r, { once: true }); el.addEventListener('error', r, { once: true }); })),
        new Promise((r) => setTimeout(r, 250)),
      ]);
    }
  }

  /** Render a still of the composition at time t (used by MCP get_frame, thumbnails, freeze frame). */
  async capture(t, maxW = 960) {
    const P = store.P;
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    if (t != null) this.seek(t);
    await preloadFonts(P);
    await this.settle();
    const w = Math.max(16, Math.min(maxW, P.width));
    const c = document.createElement('canvas');
    c.width = Math.round(w);
    c.height = Math.round((w * P.height) / P.width);
    renderFrame(c.getContext('2d', { alpha: false }), this.time, this.env(c.width / P.width));
    return c;
  }

  // Export rendering hook (see exporter.js)
  renderExport() {
    const X = this.exportTarget;
    if (!X || !this.playing) return;
    const fps = X.fps;
    if (X.lastT >= 0 && this.time - X.lastT < 1 / fps - 0.004 && this.time < this.duration) return;
    X.lastT = this.time;
    renderFrame(X.ctx, this.time, this.env(X.canvas.width / store.P.width));
    X.track?.requestFrame?.();
    X.onFrame?.(this.time);
  }
}
