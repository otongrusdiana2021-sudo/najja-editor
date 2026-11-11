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
    this.els = new Map(); // clipId -> { el, mediaId, gain, src }
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
    this.clockBase = this.time;
    this.clockStart = performance.now();
    this.sync();
    this.emit('play');
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
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
      this.time = this.clockBase + (now - this.clockStart) / 1000;
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
      const E = this.els.get(clip.id);
      const v = E?.el;
      return v && v.readyState >= 2 && v.videoWidth ? { el: v, w: v.videoWidth, h: v.videoHeight } : null;
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
  createEl(clip) {
    const rt = mediaRT.get(clip.mediaId);
    if (!rt?.url) return null;
    const el = document.createElement(clip.type === 'audio' ? 'audio' : 'video');
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.src = rt.url;
    const E = { el, mediaId: clip.mediaId, url: rt.url, gain: null, src: null, vol: -1 };
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
    this.els.set(clip.id, E);
    return E;
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
    const t = this.time;
    const alive = new Set();
    const mainList = sortedClips(P, 'main');
    for (const clip of P.clips) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      const tr = store.track(clip.trackId);
      const end = clip.start + clip.duration;
      let pre = 0;
      let post = 0;
      if (clip.trackId === 'main') {
        const i = mainList.indexOf(clip);
        if (clip.transition?.type && clip.transition.type !== 'none') pre = (clip.transition.duration || 0.6) / 2;
        const next = mainList[i + 1];
        if (next?.transition?.type && next.transition.type !== 'none') post = (next.transition.duration || 0.6) / 2;
      }
      const lookahead = this.playing ? 2.5 : 0.5;
      if (t < clip.start - pre - lookahead || t > end + post + 1) {
        if (this.els.has(clip.id) && (t < clip.start - 12 || t > end + 12)) this.disposeEl(clip.id);
        if (this.els.has(clip.id)) {
          alive.add(clip.id);
          const E = this.els.get(clip.id);
          if (!E.el.paused) E.el.pause();
          this.setGain(E, 0);
        }
        continue;
      }
      let E = this.els.get(clip.id);
      // A different media, or the same media switched to its H.264 copy: reload the element.
      if (E && (E.mediaId !== clip.mediaId || E.url !== mediaRT.get(clip.mediaId)?.url)) { this.disposeEl(clip.id); E = null; }
      if (!E) E = this.createEl(clip);
      if (!E) continue;
      alive.add(clip.id);
      const el = E.el;
      const speed = clip.speed || 1;
      const srcEnd = clip.in + clip.duration * speed;
      const local = clamp(clip.in + (t - clip.start) * speed, clip.in, Math.max(clip.in, srcEnd - 0.04));
      const active = t >= clip.start && t < end;
      if (Math.abs(el.playbackRate - speed) > 0.001) el.playbackRate = speed;
      if (this.playing && active && el.readyState >= 1) {
        if (el.paused) {
          if (Math.abs(el.currentTime - local) > 0.05) el.currentTime = local;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - local) > 0.3 && !el.seeking) {
          el.currentTime = local;
        }
      } else {
        if (!el.paused) el.pause();
        if (el.readyState >= 1 && !el.seeking && Math.abs(el.currentTime - local) > 0.02) el.currentTime = local;
      }
      let vol = 0;
      if (active && this.playing && !clip.muted && !tr?.muted) {
        vol = clip.volume ?? 1;
        const lt = t - clip.start;
        if (clip.fadeIn > 0) vol *= clamp(lt / clip.fadeIn, 0, 1);
        if (clip.fadeOut > 0) vol *= clamp((clip.duration - lt) / clip.fadeOut, 0, 1);
      }
      this.setGain(E, vol);
    }
    for (const id of [...this.els.keys()]) if (!alive.has(id)) this.disposeEl(id);
  }

  /** Wait until every media element needed at the current time has a decoded frame. */
  async settle(timeout = 4000) {
    const deadline = performance.now() + timeout;
    for (;;) {
      this.sync();
      const pending = [];
      for (const [id, E] of this.els) {
        const c = store.clip(id);
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
