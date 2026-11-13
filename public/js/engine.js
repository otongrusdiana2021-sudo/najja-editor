// Playback engine: master clock, media element sync, Web Audio mixing and preview rendering.
import { store } from './store.js';
import { compilePlan } from './plan.js';
import { mediaRT } from './media.js';
import { renderFrame, preloadFonts, onFontsLoaded } from './render.js';
import { clamp } from './util.js';
import { metrics } from './metrics.js';

const AC = window.AudioContext || window.webkitAudioContext;
// A main video reporting "not enough data" for less than this is ridden out (the clock keeps going): a clip that
// just started or Safari hesitating for a moment. Holding the playhead and pausing the video for such dips is what
// made playback stutter on iPad (10 holds of ~50 ms in 10 seconds).
const STALL_GRACE_MS = 300;
// Furthest the timeline clock may run ahead of the picture of the main video (see tick).
const VIDEO_LEAD = 0.15;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.time = 0;
    this.playing = false;
    this.loop = false;
    this.els = new Map(); // element key (first clip of a chain) -> { el, mediaId, url, clip, gain, src, hold }
    this.buffering = false;
    // The main video's picture drives the timeline while it plays (see tick). false: the old wall clock that
    // seeks videos which fall behind — kept as a switch for A/B measurements.
    this.videoClock = true;
    this.scrubUntil = 0;
    this.boxes = new Map();
    this.needsRender = true;
    this.exportTarget = null;
    this.audioCtx = null;
    this.master = null;
    this.monitor = null;
    this.listeners = new Set();
    // Media elements live in the page (invisible): Safari plays and presents frames of attached videos more
    // reliably than of detached ones.
    this.host = document.createElement('div');
    this.host.className = 'media-host';
    this.host.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.host);
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
    this.lastFi = -1;
    this.clockBase = this.time;
    this.clockStart = performance.now();
    this.sync();
    this.session = { at: performance.now(), t: this.time, draws: 0, skipped: 0, shown: 0, needed: 0, vq: this.videoQuality(), lastTick: 0, gaps: 0 };
    this.emit('play');
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.endSession();
    if (this.buffering) { this.buffering = false; this.emit('buffer'); }
    this.sync();
    this.requestRender();
    this.emit('pause');
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  /** Decoded/dropped frame counters of the main video element (where the browser reports them). */
  videoQuality() {
    const q = this.masterEl()?.el.getVideoPlaybackQuality?.();
    return q ? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames } : null;
  }
  /** Playback metrics for one play → pause stretch (blueprint 9.1 "Playback"). */
  endSession() {
    const S = this.session;
    this.session = null;
    if (!S || this.exportTarget) return;
    const secs = (performance.now() - S.at) / 1000;
    if (secs < 1) return;
    const fps = store.P?.fps || 30;
    // Missed = pictures the video presented that never reached the preview (or, without video, project frames
    // skipped). Not "project frame numbers that jumped": with a 30 fps video and 30 fps project, the phase between
    // the clock and the decoder makes numbers jump while every picture is drawn.
    // A 60 fps video in a 30 fps project needs only every other picture: `needed` counts project frames that had a
    // new picture, so drawing one of two is not a miss.
    const expected = S.needed > 0 ? S.needed : Math.max(1, (this.time - S.t) * fps);
    metrics.sample('fps_rendered', S.draws / secs);
    if (S.shown > 0) metrics.sample('video_presented_fps', S.shown / secs); // pictures the video decoder delivered
    metrics.sample('playback_speed_pct', (100 * (this.time - S.t)) / secs); // timeline seconds per real second
    metrics.count('raf_gap_over_50ms', S.gaps);
    if (S.held) metrics.count('clock_held_for_video', S.held); // ticks the clock waited for a slow decoder
    metrics.sample('preview_frames_missed_pct', (100 * S.skipped) / expected);
    const q = this.videoQuality();
    if (q && S.vq && q.total > S.vq.total) metrics.sample('video_dropped_frames_pct', (100 * (q.dropped - S.vq.dropped)) / (q.total - S.vq.total));
    metrics.count('playback_seconds', Math.round(secs));
  }
  /** Do all videos on screen show their frame for the playhead? (for seek_to_frame_ms) */
  visibleReady() {
    for (const E of this.els.values()) {
      const c = E.clip;
      if (c?.type !== 'video' || this.time < c.start || this.time >= c.start + c.duration) continue;
      if (!this.frameReady(E)) return false;
    }
    return true;
  }
  seek(t) {
    if (!this.exportTarget) this.seekAt = performance.now();
    this.time = clamp(t, 0, Math.max(0, this.duration));
    if (this.playing) { this.clockBase = this.time; this.clockStart = performance.now(); }
    this.sync();
    this.requestRender();
    this.emit('time');
  }
  /** A scrub (finger/mouse moving the timeline) seeks here: quick seeks while moving, the exact frame after. */
  scrub(t) {
    this.scrubUntil = performance.now() + 180;
    this.seek(t);
    clearTimeout(this.scrubDone);
    this.scrubDone = setTimeout(() => { this.scrubUntil = 0; if (!this.playing) { this.sync(); this.requestRender(); } }, 200);
  }
  /** Every element on screen plays from a copy on this device (no network used while playing). */
  playingLocal() {
    for (const E of this.els.values()) if (!E.el.paused && !String(E.el.currentSrc || E.url).startsWith('blob:')) return false;
    return true;
  }
  step(frames) {
    const fps = store.P.fps || 30;
    this.pause();
    this.seek(Math.round((this.time + frames / fps) * fps) / fps);
  }
  requestRender() { this.needsRender = true; }

  tick(now) {
    if (this.session) { if (this.session.lastTick && now - this.session.lastTick > 50) this.session.gaps++; this.session.lastTick = now; }
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
          metrics.sample('buffer_wait_ms', now - this.bufferSince);
          this.emit('buffer');
        }
      } else {
        const wall = this.clockBase + (now - this.clockStart) / 1000;
        this.time = wall;
        const M = !this.exportTarget && this.masterEl();
        // The clock may not run more than VIDEO_LEAD ahead of the main video's picture. A decoder slower than real
        // time (a 4K/HEVC/HDR original on a tablet) then makes playback a little slower but smooth — instead of the
        // clock running away, the video being seeked to catch up, stalling on the seek, and the playhead being held
        // (the stutter seen on iPad). Short start delays at cuts stay below it, so music on other tracks stays in
        // step with the timeline, as before.
        if (this.videoClock && M && !M.el.paused && !M.el.seeking && M.el.readyState >= 2) {
          const c = M.clip;
          const tt = c.start + (M.el.currentTime - c.in) / (c.speed || 1);
          if (tt >= c.start - 0.1 && tt < c.start + c.duration && wall - tt > VIDEO_LEAD && wall - tt < 1) {
            this.time = tt + VIDEO_LEAD;
            this.clockBase = this.time;
            this.clockStart = now;
            if (this.session) this.session.held = (this.session.held || 0) + 1;
          }
        }
        const starving = M && !M.noHold && (M.el.played.length || M.el.readyState < 2) && Engine.starved(M.el);
        if (starving) {
          if (M.starvedSince == null) M.starvedSince = now;
          if (now - M.starvedSince >= STALL_GRACE_MS) {
            this.buffering = true;
            this.bufferSince = now;
            // why (Diagnostik): right after a clip started or mid-clip, local copy or streamed, decoder state
            metrics.count(M.playAt && now - M.playAt < 1000 ? 'buffer_at_clip_start' : 'buffer_mid_clip');
            metrics.count(String(M.el.currentSrc || M.el.src).startsWith('blob:') ? 'buffer_src_local' : 'buffer_src_server');
            metrics.count(`buffer_readystate_${M.el.readyState}${M.el.seeking ? '_seeking' : ''}`);
            this.emit('buffer');
          }
        } else if (M?.starvedSince != null) {
          // Recovered within the grace time: follow the video instead of seeking it to the clock (a seek would
          // starve it again).
          M.starvedSince = null;
          if (!M.el.seeking && !M.el.paused) {
            const c = M.clip;
            const tt = c.start + (M.el.currentTime - c.in) / (c.speed || 1);
            if (Math.abs(tt - this.time) < 1) { this.time = this.clockBase = tt; this.clockStart = now; }
          }
          metrics.count('stall_ridden_out');
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
          this.endSession();
          this.emit('ended');
          this.emit('pause');
        }
      }
      this.sync();
      this.emit('time');
    }
    if (this.exportTarget) this.renderExport();
    // Redraw only when the picture can have changed: a new video frame, or the next project frame for clips
    // without video (text, images, effects). A 120 Hz screen no longer means 120 redraws a second.
    let draw = this.needsRender;
    if (this.playing) {
      const fi = Math.floor(this.time * (store.P?.fps || 30) + 1e-6);
      const M = this.masterEl();
      if (M && M.frames != null && !this.buffering && !M.el.paused) {
        if (M.frames !== M.drawn || fi - this.lastFi >= 2) draw = true; // video late: keep overlays moving
      } else if (fi !== this.lastFi) draw = true;
      if (draw) {
        const S = this.session;
        if (S && M && M.frames != null && !this.buffering) {
          const n = M.drawn >= 0 ? M.frames - M.drawn : 0;
          // missed: pictures not drawn although the project needed them (a 60 fps video in a 30 fps project
          // presents two pictures per project frame; drawing one of them is not a miss)
          const due = Math.min(n, this.lastFi >= 0 ? fi - this.lastFi : 1);
          if (n > 0) S.shown += n; // decoder pictures (video_presented_fps)
          if (due > 0) { S.needed += due; S.skipped += due - 1; }
        } else if (S && this.lastFi >= 0 && fi > this.lastFi) { S.needed += fi - this.lastFi; S.skipped += fi - this.lastFi - 1; }
        this.lastFi = fi;
        if (M) M.drawn = M.frames;
      }
    }
    // Seek → the right picture is on screen (waits for the decoder, not just for 'seeked').
    if (this.seekAt) {
      const ms = performance.now() - this.seekAt;
      if (this.visibleReady()) { this.seekAt = null; metrics.sample('seek_to_frame_ms', ms); draw = true; } else if (ms > 10000) { this.seekAt = null; metrics.count('seek_timeouts'); }
    }
    if (draw) {
      this.needsRender = false;
      this.render();
    }
  }

  env(s, boxes = null) {
    return {
      project: store.P,
      plan: store.plan(),
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
    const t0 = performance.now();
    renderFrame(this.ctx, this.time, this.env(this.canvas.width / P.width, this.boxes));
    const ms = performance.now() - t0;
    // Draw time while playing (moving average): the player lowers the preview resolution when it is too slow.
    if (this.playing) {
      this.drawMs = this.drawMs == null ? ms : this.drawMs * 0.9 + ms * 0.1;
      metrics.sample('frame_draw_ms', ms);
      if (this.session) this.session.draws++;
    }
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
    return (P === store.P ? store.plan() : compilePlan(P)).chainKeys;
  }
  keyFor(clip) { return this.keys?.get(clip.id) || clip.id; }

  /** The file an element plays: the preview copy, or the full-quality one during a real-time export. */
  urlFor(rt) { return (this.useExportSources && rt?.exportUrl) || rt?.url; }

  createEl(key, clip) {
    const rt = mediaRT.get(clip.mediaId);
    const url = this.urlFor(rt);
    if (!url) return null;
    const el = document.createElement(clip.type === 'audio' ? 'audio' : 'video');
    // A local copy can buffer freely. A file still on the server is being saved to this device in the
    // background; the player then only fetches what it shows (play, seek), so it is not downloaded twice.
    el.preload = url.startsWith('blob:') ? 'auto' : 'metadata';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.disableRemotePlayback = true;
    el.crossOrigin = 'anonymous';
    el.src = url;
    const E = { el, mediaId: clip.mediaId, url, clip, gain: null, src: null, vol: -1, hold: null, frames: null, drawn: -1 };
    // Count the frames the video presents: during playback the preview redraws when the video has a new
    // picture (≈30 times a second) instead of on every screen refresh (60–120 times a second).
    if (clip.type !== 'audio' && typeof el.requestVideoFrameCallback === 'function') {
      E.frames = 0;
      const onFrame = () => { E.frames++; if (this.els.get(key) === E) el.requestVideoFrameCallback(onFrame); };
      el.requestVideoFrameCallback(onFrame);
    }
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
    // While paused, sync() can only position an element that has metadata and is not mid-seek. A new element
    // (far seek) or one still seeking to an older position (fast scrub) is positioned again once it can be,
    // otherwise the preview would keep showing the wrong frame.
    const resync = () => { if (this.els.get(key) === E && !this.playing && !this.exportTarget) this.sync(); };
    // When the element last settled on a position (used to decide that no newer frame is coming).
    const settled = () => { E.settledAt = performance.now(); rr(); resync(); };
    el.addEventListener('loadedmetadata', resync);
    el.addEventListener('loadeddata', settled);
    el.addEventListener('seeked', settled);
    this.els.set(key, E);
    this.host.appendChild(el);
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
    const el = E.el;
    // While a finger scrubs the timeline, Safari's fastSeek (nearest keyframe) keeps the picture moving with the
    // finger; the exact frame follows when the scrub stops (see scrub()).
    if (performance.now() < this.scrubUntil && typeof el.fastSeek === 'function' && E.clip?.type === 'video') { E.fastTarget = t; el.fastSeek(t); } else { E.fastTarget = null; el.currentTime = t; }
    // 'seeked' alone does not prove the decoder already shows the new picture (hardware decoders can
    // lag a frame behind), so remember when a frame for this exact position is actually presented.
    E.shownAt = null;
    const at = el.currentTime;
    el.requestVideoFrameCallback?.(() => { if (el.currentTime === at) E.shownAt = at; });
  }
  /** Position inside the source file that clip shows at timeline time t. */
  localTime(clip, t) {
    const speed = clip.speed || 1;
    const srcEnd = clip.in + clip.duration * speed;
    return clamp(clip.in + (t - clip.start) * speed, clip.in, Math.max(clip.in, srcEnd - 0.04));
  }
  disposeEl(id) {
    const E = this.els.get(id);
    if (!E) return;
    try { E.el.pause(); } catch { /* ignore */ }
    try { E.src?.disconnect(); E.gain?.disconnect(); } catch { /* ignore */ }
    E.el.removeAttribute('src');
    try { E.el.load(); } catch { /* ignore */ }
    E.el.remove();
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
    // Element groups, chain keys and the main track order come from the compiled plan (once per project change,
    // not on every tick).
    const plan = store.plan();
    this.keys = plan.chainKeys;
    const mainList = plan.main.clips;
    const margins = (clip) => {
      if (clip.trackId !== 'main') return [0, 0];
      const i = plan.mainIndex.get(clip.id) ?? -1;
      const pre = clip.transition?.type && clip.transition.type !== 'none' ? (clip.transition.duration || 0.6) / 2 : 0;
      const next = mainList[i + 1];
      const post = next?.transition?.type && next.transition.type !== 'none' ? (next.transition.duration || 0.6) / 2 : 0;
      return [pre, post];
    };
    const groups = plan.groups;
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
      const want = this.urlFor(mediaRT.get(clip.mediaId));
      if (E && E.mediaId !== clip.mediaId) { this.disposeEl(key); E = null; }
      // New source for this media (H.264 copy, or the copy saved on this device): swap it in when that
      // cannot cause a visible gap — while paused, or when the current element shows no picture anyway.
      // (also during playback for an element not on screen, e.g. the next clip, where nobody sees the swap)
      const offScreen = this.playing && !this.exportTarget && !(t >= clip.start - 0.6 && t < end);
      if (E && want && E.url !== want && (!(this.playing || this.exportTarget) || offScreen || (clip.type === 'video' && !E.el.videoWidth))) {
        this.disposeEl(key);
        E = null;
      }
      if (!E) E = this.createEl(key, clip);
      if (!E) continue;
      E.clip = clip;
      alive.add(key);
      const el = E.el;
      const speed = clip.speed || 1;
      const local = this.localTime(clip, t);
      const active = t >= clip.start && t < end;
      if (Math.abs(el.playbackRate - speed) > 0.001) el.playbackRate = speed;
      if (running && active && el.readyState >= 1) {
        if (el.paused) {
          if (Math.abs(el.currentTime - local) > 0.05) this.seekEl(E, local);
          E.playAt = performance.now();
          el.play().catch((err) => { metrics.count(`play_rejected_${err?.name || 'error'}`); });
        } else if (Math.abs(el.currentTime - local) > 0.3 && !el.seeking && E.starvedSince == null) {
          // (not while it waits for data: a seek would make it wait longer)
          metrics.count('drift_seek');
          this.seekEl(E, local);
        }
      } else {
        if (!el.paused) el.pause();
        // While buffering, leave positions alone: seeking a starved element only makes it wait longer.
        // (a quick scrub seek lands on a keyframe near `local`: do not ask again for the same target)
        const quick = performance.now() < this.scrubUntil && E.fastTarget === local;
        if (!this.buffering && el.readyState >= 1 && !el.seeking && !quick && Math.abs(el.currentTime - local) > 0.02) this.seekEl(E, local);
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
    // A copy on this device can play on as soon as it can play; a stream from the server first buffers a few seconds.
    if (String(el.currentSrc || el.src).startsWith('blob:')) return true;
    return el.readyState >= 4 || Engine.bufferedAhead(el) >= Math.min(3, el.duration - el.currentTime - 0.1);
  }

  /**
   * Is this element showing the picture for the playhead? Needs: data for the current position, the
   * position we asked for, and (where the browser can tell us) a frame actually presented there.
   */
  frameReady(E) {
    const el = E.el;
    const c = E.clip;
    if (el.error) return true; // nothing better will come
    if (el.readyState < 2 || el.seeking) return false;
    if (c.type !== 'video') return true;
    if (Math.abs(el.currentTime - this.localTime(c, this.time)) > 0.04) return false; // sync() seeks it there
    if (E.shownAt === el.currentTime || !el.requestVideoFrameCallback) return true;
    // No frame callback (e.g. the element sat on this position before we asked): accept shortly after it settled.
    return performance.now() - (E.settledAt || 0) > 500;
  }

  /**
   * Wait until every media element needed at the current time shows its frame for the playhead.
   * Resolves with the ids of clips whose picture could not be confirmed before the timeout (empty when exact).
   */
  async settle(timeout = 15000) {
    const deadline = performance.now() + timeout;
    for (;;) {
      this.sync();
      const pending = [];
      for (const E of this.els.values()) {
        const c = E.clip;
        if (!c) continue;
        const onScreen = this.time >= c.start - 0.001 && this.time < c.start + c.duration;
        const near = this.time >= c.start - 1 && this.time <= c.start + c.duration + 1;
        if (onScreen ? !this.frameReady(E) : near && (E.el.readyState < 2 || E.el.seeking)) pending.push(E);
      }
      if (!pending.length) return [];
      if (performance.now() > deadline) return pending.filter((E) => E.clip.type === 'video').map((E) => E.clip.id);
      await Promise.race([
        ...pending.map(({ el }) => new Promise((r) => {
          for (const ev of ['seeked', 'loadeddata', 'canplay', 'error']) el.addEventListener(ev, r, { once: true });
        })),
        new Promise((r) => setTimeout(r, 100)),
      ]);
    }
  }

  /** Render a still of the composition at time t (used by MCP get_frame, thumbnails, freeze frame). */
  async capture(t, maxW = 960, { timeout = 20000 } = {}) {
    const P = store.P;
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.capturing = (this.capturing || 0) + 1; // background downloads step aside while we seek
    try {
      if (t != null) this.seek(t);
      await preloadFonts(P);
      const stale = await this.settle(timeout);
      const w = Math.max(16, Math.min(maxW, P.width));
      const c = document.createElement('canvas');
      c.width = Math.round(w);
      c.height = Math.round((w * P.height) / P.width);
      renderFrame(c.getContext('2d', { alpha: false }), this.time, this.env(c.width / P.width));
      c.staleClips = stale; // video clips that were still loading: their picture may be from another time
      return c;
    } finally {
      this.capturing--;
    }
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
