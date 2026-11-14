// Preview sound scheduled on the audio clock (v1.7.3).
//
// Before: each clip's sound came from its <video>/<audio> element, routed through Web Audio for volume and fades
// (createMediaElementSource). Safari delays and drifts sound taken from media elements that way (WebKit bugs
// 221334, 239696, 204228, 301824), every cut waited for the next element to start, and other tracks were only
// corrected once they were 0.3 s off — with a seek, which is an audible jump.
//
// Now, like browser editors such as Canva or CapCut web: the sound of every audible clip is decoded in blocks of a
// few seconds (WebCodecs AudioDecoder on the file's AAC track, only the stretches that are played) and started
// sample-accurately at its place on the timeline (AudioBufferSourceNode). The preview clock follows what the
// speakers play (AudioContext.getOutputTimestamp), and the muted video elements follow the clock (engine.js).
// Per clip fallback to the element's sound, as before: sped-up clips (the element keeps the pitch), files not on
// this device yet (still streamed), and sound this browser cannot decode. Real-time exports keep the element path.
import { store } from './store.js';
import { mediaRT } from './media.js';
import { blobOfUrl } from './util.js';
import { metrics } from './metrics.js';
import { ByteSource, demuxAudio, decodeAudioRange } from './fastexport.js';

const BLOCK = 8; // seconds of source decoded at a time
const AHEAD = 1.0; // timeline seconds of sound scheduled ahead of what the speakers play
const PREFETCH = 8; // timeline seconds decoded ahead
const START_LEAD = 0.05; // seconds between deciding to start and the first scheduled sample
const START_WAIT_MS = 700; // play waits at most this long for the first sound to be decoded
const KEEP_S = 150; // decoded seconds kept in memory, all files together (≈ 55 MB at 48 kHz stereo)
const FULL_MAX_S = 150; // MP3/WAV/… are decoded whole up to this length; longer ones keep the element's sound
const UPDATE_MS = 90;
// A decoder that does not answer within these is given up on (the file is then decoded another way): an 8 s block
// takes ~0.1–0.3 s even on a tablet.
const BLOCK_TIMEOUT_MS = 2500;
const FULL_TIMEOUT_MS = 20000;
const withTimeout = (p, ms, what) => {
  let t = null;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
};

const speedOf = (c) => c.speed || 1;
const audibleType = (c) => c.type === 'video' || c.type === 'audio';

/** The sound of one media file: opened once (container + codec check), decoded block by block. */
class Source {
  constructor(id, url) {
    this.id = id;
    this.url = url;
    this.state = 'opening'; // opening | blocks | full | silent | failed
    this.blocks = new Map(); // block index (0 for a whole-file decode) -> { state, buffer, start, used }
    this.fails = 0;
    this.ready = this.open().catch(() => { this.state = 'failed'; });
  }
  async open() {
    const blob = blobOfUrl(this.url);
    if (!blob) { this.state = 'failed'; return; }
    this.blob = blob;
    this.src = new ByteSource(blob, 4 << 20);
    if (typeof AudioDecoder === 'function') {
      let moov = null;
      try { moov = await this.src.moov(); } catch { moov = null; }
      if (moov) {
        let track = null;
        try { track = demuxAudio(moov); } catch (err) {
          if (/no audio track/.test(err?.message || '')) { this.state = 'silent'; return; }
        }
        if (track) {
          const cfg = { codec: track.codec, sampleRate: track.sampleRate, numberOfChannels: track.channels, ...(track.description ? { description: track.description } : {}) };
          const ok = await AudioDecoder.isConfigSupported(cfg).then((r) => !!r.supported, () => false);
          if (ok) { this.track = track; this.state = 'blocks'; return; }
        }
      }
    }
    const dur = store.media(this.id)?.duration || 0;
    this.state = dur > 0 && dur <= FULL_MAX_S ? 'full' : 'failed';
  }
  blockOf(s) { return this.state === 'full' ? 0 : Math.max(0, Math.floor(s / BLOCK + 1e-9)); }
  blockEnd(k) { return this.state === 'full' ? Infinity : (k + 1) * BLOCK; }
}

let decodeCtx = null;

export class PreviewAudio {
  constructor(engine) {
    this.E = engine;
    this.sources = new Map(); // mediaId -> Source
    this.nodes = new Map(); // `${clipId}:${block}` -> { node, g, clipId, at, end, ta }
    this.done = new Set(); // segments already scheduled since the last (re)start
    this.queue = []; // decode requests { s, k, needAt }
    this.busy = false;
    this.anchor = null; // { t0, c0 }: timeline time t0 is played at context time c0
    this.pending = null; // waiting for the first sound: { t, at, until }
    this.pll = null;
    this.lastUpdate = 0;
    this.sig = '';
    this.gsig = '';
    this.pid = null;
    this.live = false;
    this.lastProblem = null;
  }
  get ctx() { return this.E.audioCtx; }
  supported() {
    const ctx = this.ctx;
    return !!ctx && typeof ctx.createBufferSource === 'function' && typeof AudioBuffer === 'function';
  }

  // ---- which clips play here -------------------------------------------------------------------
  /** The decodable sound of a media file on this device, or null (not here yet: its element plays it). */
  source(id) {
    if (this.pid !== store.P?.id) this.reset();
    const rt = mediaRT.get(id);
    const url = [rt?.url, rt?.local].find((u) => u && String(u).startsWith('blob:') && blobOfUrl(u)) || null;
    let s = this.sources.get(id);
    // that file failed (or was removed from this device), and another local copy is here now: try that one
    if (s && s.state === 'failed' && url && url !== s.url) { this.sources.delete(id); s = null; }
    if (!s) {
      if (!url) return null;
      s = new Source(id, url);
      this.sources.set(id, s);
      s.ready.then(() => { if (s.state !== 'opening') metrics.count(`audio_source_${s.state}`); });
    }
    return s;
  }
  /** Is this clip's sound played by the scheduler (true) or by its media element (false)? */
  covers(clip) {
    if (Math.abs(speedOf(clip) - 1) > 1e-6) return false; // the element keeps the pitch of sped-up sound
    if (store.media(clip.mediaId)?.hasAudio === false) return true; // nothing to play
    const s = this.source(clip.mediaId);
    return !!s && s.state !== 'failed';
  }
  audible(c) {
    return audibleType(c) && !c.muted && !store.track(c.trackId)?.muted && (c.volume ?? 1) > 0 && store.media(c.mediaId)?.hasAudio !== false;
  }
  /** Audible clips this scheduler plays that overlap timeline [a, b). */
  clipsIn(a, b) {
    const out = [];
    for (const c of store.P?.clips || []) {
      if (c.start >= b || c.start + c.duration <= a || !this.audible(c) || !this.covers(c)) continue;
      out.push(c);
    }
    return out;
  }

  // ---- clock -----------------------------------------------------------------------------------
  /** Context time of the sample the speakers play right now. */
  heard() {
    const ctx = this.ctx;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      const a = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      if (a <= ctx.currentTime + 0.02 && a > ctx.currentTime - 1) { this.clockSource = 'output'; return a; }
    }
    this.clockSource = 'estimate';
    return ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
  }
  /** Start the sound at timeline time t: play, a seek while playing, or resume after buffering. */
  start(t) {
    this.stopNodes();
    this.anchor = null;
    this.pll = null;
    this.live = false;
    [this.sig, this.gsig] = this.signature();
    const now = performance.now();
    this.pending = { t, at: now, until: now + START_WAIT_MS };
    this.prefetch(t, 2);
  }
  stop() {
    this.stopNodes();
    this.anchor = null;
    this.pending = null;
    this.pll = null;
    this.live = false;
  }
  /** Sound for [t, t + 0.3] is decoded (or will not come from here). */
  firstReady(t) {
    for (const c of this.clipsIn(t, t + 0.3)) {
      const s = this.source(c.mediaId);
      if (!s || s.state === 'opening') return false;
      if (s.state === 'failed' || s.state === 'silent') continue;
      const k = s.blockOf(c.in + Math.max(0, t - c.start) * speedOf(c));
      if (s.blocks.get(k)?.state !== 'ready') { this.request(s, k, t); return false; }
    }
    return true;
  }
  /**
   * Timeline time being heard now. Before the first sound it returns the start time (the playhead waits for the
   * sound). `live`: the video elements may run (their own start delay is about as long as the sound's).
   */
  clock(now, preroll = 0.05) {
    const ctx = this.ctx;
    if (this.pending) {
      const p = this.pending;
      if (ctx.state !== 'running' || (!this.firstReady(p.t) && now < p.until)) { this.live = false; return p.t; }
      this.anchor = { t0: p.t, c0: ctx.currentTime + START_LEAD };
      this.pending = null;
      metrics.sample('audio_start_wait_ms', now - p.at);
      this.update(true);
    }
    if (!this.anchor) { this.live = false; return null; }
    const { t0, c0 } = this.anchor;
    const target = t0 + (this.heard() - c0);
    this.live = target >= t0 - preroll;
    if (target <= t0) { this.pll = null; return t0; }
    // smooth: a wall-clock estimate pulled toward the audio clock (audio time advances in blocks on some devices)
    let est = this.pll ? this.pll.v + (now - this.pll.at) / 1000 : target;
    const err = target - est;
    est = Math.abs(err) > 0.08 ? target : est + err * 0.15;
    this.pll = { v: est, at: now };
    return Math.max(t0, est);
  }

  // ---- scheduling ------------------------------------------------------------------------------
  /** Schedule the sound of the next second and decode ahead. Called every tick while playing (throttled). */
  update(force = false) {
    if (!this.anchor || !this.E.playing) return;
    const now = performance.now();
    if (!force && now - this.lastUpdate < UPDATE_MS) return;
    this.lastUpdate = now;
    const ctx = this.ctx;
    const { t0, c0 } = this.anchor;
    const from = Math.max(t0, t0 + (ctx.currentTime - c0)); // what the audio graph renders now
    const to = from + AHEAD;
    for (const c of this.clipsIn(from, from + PREFETCH)) {
      const s = this.source(c.mediaId);
      if (!s || s.state === 'failed' || s.state === 'silent') continue;
      for (const seg of this.segments(c, s, from, from + PREFETCH)) {
        const b = s.blocks.get(seg.k);
        if (b?.state === 'ready') b.used = now;
        else this.request(s, seg.k, seg.ts);
        if (seg.ts >= to || this.done.has(seg.key)) continue;
        if (b?.state === 'ready') {
          try { this.schedule(c, seg, b); } catch (err) { this.done.add(seg.key); this.problem('schedule', err, s); }
        } else if (s.state !== 'opening' && seg.ts <= from + 0.02 && !this.done.has(`${seg.key}:u`)
          && ![...this.nodes.values()].some((r) => r.clipId === c.id && r.end > ctx.currentTime + 0.02)) {
          metrics.count('audio_underrun');
          this.done.add(`${seg.key}:u`);
          this.problem('underrun', `${s.state === 'full' ? 'file' : `block ${seg.k}`} not decoded yet (${b?.state || 'not requested'})`, s);
        }
      }
    }
  }
  /** Pieces of clip c inside timeline [a, b): one per decoded block. */
  segments(c, s, a, b) {
    const out = [];
    const sp = speedOf(c);
    const ta = Math.max(c.start, a);
    const tb = Math.min(c.start + c.duration, b);
    if (tb <= ta || s.state === 'opening') return out;
    const endSrc = c.in + c.duration * sp;
    let src = c.in + (ta - c.start) * sp;
    const lim = c.in + (tb - c.start) * sp;
    while (src < lim - 1e-6) {
      const k = s.blockOf(src);
      const segS = Math.max(c.in, s.state === 'full' ? c.in : k * BLOCK);
      const segE = Math.min(endSrc, s.blockEnd(k));
      // (a whole-file decode has its own key: a file that switches from blocks to whole is scheduled again)
      out.push({ k, key: s.state === 'full' ? `${c.id}:all` : `${c.id}:${k}`, segS, segE, ts: c.start + (segS - c.in) / sp });
      src = segE;
    }
    return out;
  }
  schedule(c, seg, b) {
    const ctx = this.ctx;
    const { t0, c0 } = this.anchor;
    this.done.add(seg.key);
    const when = c0 + (seg.ts - t0);
    let at = when;
    let offset = seg.segS - b.start;
    let dur = seg.segE - seg.segS;
    const min = ctx.currentTime + 0.012;
    if (at < min) {
      const late = min - at;
      at = min;
      offset += late;
      dur -= late;
      // late = later than its sound was due (not: a clip the playhead started in the middle of)
      const due = c0 + (Math.max(seg.ts, t0) - t0);
      if (min - due > 0.03 && dur > 0.03) {
        metrics.count('audio_late_join');
        metrics.sample('audio_late_join_ms', (min - due) * 1000);
        metrics.event('audio_late_join', { ms: Math.round((min - due) * 1000), at: Math.round(seg.ts * 100) / 100, block: seg.k });
      }
    }
    if (offset < 0) { at -= offset; dur += offset; offset = 0; } // the block starts a hair after: start that much later
    dur = Math.min(dur, b.buffer.duration - offset);
    if (dur <= 0.01) return;
    // Another piece of this clip still sounding past `at` (the file switched to a whole-file decode): it hands over
    // here instead of playing twice.
    for (const r2 of this.nodes.values()) {
      if (r2.clipId !== c.id || r2.end <= at + 0.005) continue;
      try {
        r2.g.gain.cancelScheduledValues(at);
        r2.g.gain.setTargetAtTime(0, at, 0.004);
        r2.node.stop(at + 0.03);
        r2.end = at;
      } catch { /* already stopped */ }
    }
    const node = ctx.createBufferSource();
    node.buffer = b.buffer;
    const g = ctx.createGain();
    const rec = { node, g, clipId: c.id, at, end: at + dur, ta: seg.ts + (at - when) };
    // joining a sound in the middle (start of play, after a seek or a late block): a few ms fade, no click
    this.gains(rec, c, at, at > when + 0.002);
    node.connect(g).connect(this.E.master);
    node.start(at, offset, dur);
    node.onended = () => {
      if (this.nodes.get(seg.key) === rec) this.nodes.delete(seg.key);
      try { g.disconnect(); } catch { /* already */ }
    };
    this.nodes.set(seg.key, rec);
    b.used = performance.now();
  }
  /** Volume and fades of the clip as gain automation, from context time `from` to the end of the node. */
  gains(rec, c, from, fadeIn = false) {
    const g = rec.g.gain;
    const ta = rec.ta + (from - rec.at); // timeline time at `from`
    const tb = rec.ta + (rec.end - rec.at);
    const vol = c.volume ?? 1;
    const gainAt = (t) => {
      const lt = t - c.start;
      let v = vol;
      if (c.fadeIn > 0) v *= Math.min(1, Math.max(0, lt / c.fadeIn));
      if (c.fadeOut > 0) v *= Math.min(1, Math.max(0, (c.duration - lt) / c.fadeOut));
      return v;
    };
    const ctxOf = (t) => rec.at + (t - rec.ta);
    const pts = [ta, tb];
    if (c.fadeIn > 0) pts.push(c.start + c.fadeIn);
    if (c.fadeOut > 0) pts.push(c.start + c.duration - c.fadeOut);
    if (fadeIn) pts.push(Math.min(tb, ta + 0.008));
    const corners = [...new Set(pts)].filter((t) => t >= ta && t <= tb).sort((x, y) => x - y);
    g.cancelScheduledValues(0);
    g.setValueAtTime(fadeIn ? 0 : gainAt(corners[0]), Math.max(0, ctxOf(corners[0])));
    for (const t of corners.slice(1)) g.linearRampToValueAtTime(gainAt(t), ctxOf(t));
  }
  stopNodes() {
    const ctx = this.ctx;
    if (ctx) {
      const now = ctx.currentTime;
      for (const rec of this.nodes.values()) {
        try {
          rec.g.gain.cancelScheduledValues(0);
          rec.g.gain.setValueAtTime(rec.g.gain.value, now);
          rec.g.gain.linearRampToValueAtTime(0, now + 0.012); // no click
          rec.node.stop(now + 0.015);
        } catch { /* not started or already stopped */ }
      }
    }
    this.nodes.clear();
    this.done.clear();
  }

  /** What the scheduled sound depends on: [timing and mute, volume and fades]. */
  signature() {
    const sig = [];
    const gsig = [];
    for (const c of store.P?.clips || []) {
      if (!audibleType(c)) continue;
      sig.push(`${c.id}:${c.mediaId}:${c.trackId}:${c.start}:${c.duration}:${c.in}:${speedOf(c)}:${!!c.muted}:${!!store.track(c.trackId)?.muted}:${(c.volume ?? 1) > 0}`);
      gsig.push(`${c.volume ?? 1}:${c.fadeIn || 0}:${c.fadeOut || 0}`);
    }
    return [sig.join('|'), gsig.join('|')];
  }
  /** The project changed: reschedule if the sound would differ (volume and fades: change the live nodes only). */
  invalidate() {
    if (this.pid !== store.P?.id) { this.reset(); return; }
    if (!this.anchor) return; // nothing scheduled: start() takes the project as it is then
    const [s, gs] = this.signature();
    if (s !== this.sig) {
      this.sig = s;
      this.gsig = gs;
      if (this.anchor) { metrics.count('audio_reschedule'); this.stopNodes(); this.update(true); }
      return;
    }
    if (gs !== this.gsig) {
      this.gsig = gs;
      const ctx = this.ctx;
      if (!ctx) return;
      for (const rec of this.nodes.values()) {
        const c = store.P.clips.find((x) => x.id === rec.clipId);
        if (c) this.gains(rec, c, Math.max(rec.at, ctx.currentTime + 0.005));
      }
    }
  }
  reset() {
    this.stop();
    this.sources.clear();
    this.queue = [];
    // a decode still running (or stuck) belongs to the old state: a new pump starts fresh
    this.gen = (this.gen || 0) + 1;
    this.busy = false;
    this.pid = store.P?.id || null;
  }

  // ---- decoding --------------------------------------------------------------------------------
  /** Decode the sound around timeline time t ahead of time (paused, after a seek), so play starts at once. */
  prefetch(t, secs = 2) {
    if (!this.supported()) return;
    for (const c of this.clipsIn(t, t + secs)) {
      const s = this.source(c.mediaId);
      if (!s) continue;
      if (s.state === 'opening') { s.ready.then(() => { if (!this.E.playing) this.prefetch(this.E.time, secs); }); continue; }
      for (const seg of this.segments(c, s, t, t + secs)) this.request(s, seg.k, seg.ts);
    }
  }
  request(s, k, needAt) {
    if (s.state === 'failed' || s.state === 'silent') return;
    const b = s.blocks.get(k);
    if (b) {
      if (b.state === 'queued' && needAt < b.needAt) { b.needAt = needAt; b.q.needAt = needAt; }
      return;
    }
    const nb = { state: 'queued', needAt };
    nb.q = { s, k, needAt };
    s.blocks.set(k, nb);
    this.queue.push(nb.q);
    this.pump();
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    const gen = this.gen;
    try {
      while (this.queue.length && gen === this.gen) {
        const t = this.E.time;
        // a seek moved away from these: forget them (they are asked for again when needed)
        this.queue = this.queue.filter((q) => {
          const keep = q.needAt > t - 3 && q.needAt < t + PREFETCH + 6;
          if (!keep && q.s.blocks.get(q.k)?.state === 'queued') q.s.blocks.delete(q.k);
          return keep;
        });
        if (!this.queue.length) break;
        this.queue.sort((a, b) => a.needAt - b.needAt);
        const q = this.queue.shift();
        await this.decode(q.s, q.k);
      }
    } finally {
      if (gen === this.gen) this.busy = false;
    }
  }
  async decode(s, k) {
    const b = s.blocks.get(k);
    if (!b || b.state !== 'queued') return;
    b.state = 'decoding';
    const t0 = performance.now();
    let mode = s.state;
    try {
      await s.ready;
      mode = s.state;
      if (mode === 'blocks') {
        const r = await withTimeout(decodeAudioRange(s.src, s.track, k * BLOCK, (k + 1) * BLOCK, { timeoutMs: BLOCK_TIMEOUT_MS }), BLOCK_TIMEOUT_MS + 1500, 'audio block');
        if (!r) throw new Error('no audio decoded');
        this.checkSound(s, r.buffer, Math.max(0, r.start), (k + 1) * BLOCK);
        b.buffer = r.buffer;
        b.start = r.start;
      } else if (mode === 'full') {
        const rate = this.ctx?.sampleRate || 48000;
        const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!decodeCtx || decodeCtx.sampleRate !== rate) decodeCtx = new OAC(2, 1, rate);
        const ctx = decodeCtx;
        // (old Safari: callback form only)
        const buf = await withTimeout(s.blob.arrayBuffer().then((ab) => new Promise((res, rej) => {
          const p = ctx.decodeAudioData(ab, res, rej);
          if (p?.then) p.then(res, rej);
        })), FULL_TIMEOUT_MS, 'decodeAudioData');
        this.checkSound(s, buf, 0, buf.duration);
        b.buffer = buf;
        b.start = 0;
      } else {
        s.blocks.delete(k);
        return;
      }
      if (s.blocks.get(k) !== b || s.state !== mode) return; // the file switched to another way of decoding
      b.state = 'ready';
      b.used = performance.now();
      metrics.sample('audio_decode_ms', performance.now() - t0);
      this.evict();
      if (this.E.playing) this.update(true);
    } catch (err) {
      if (s.blocks.get(k) === b) s.blocks.delete(k);
      if (s.state !== mode) return;
      metrics.count('audio_decode_failed');
      this.problem(mode === 'full' ? 'decode_file' : 'decode_block', err, s);
      this.degrade(s);
    }
  }
  /**
   * Decoding this file failed: blocks (AudioDecoder) → the whole file (decodeAudioData, for files up to FULL_MAX_S)
   * → its clips take their media element's sound (the engine makes those elements again with their sound).
   */
  degrade(s) {
    const dur = store.media(s.id)?.duration || 0;
    s.blocks.clear();
    s.state = s.state === 'blocks' && dur > 0 && dur <= FULL_MAX_S ? 'full' : 'failed';
    metrics.count(`audio_source_to_${s.state}`);
    this.queue = this.queue.filter((q) => q.s !== s);
    if (s.state === 'failed') {
      // its clips now sound from their elements: stop what was scheduled from this file (no sound twice)
      const now = this.ctx?.currentTime || 0;
      for (const [key, rec] of this.nodes) {
        if (store.P?.clips.find((c) => c.id === rec.clipId)?.mediaId !== s.id) continue;
        try { rec.g.gain.cancelScheduledValues(0); rec.g.gain.setTargetAtTime(0, now, 0.004); rec.node.stop(now + 0.03); } catch { /* stopped */ }
        this.nodes.delete(key);
      }
    }
    if (this.E.playing && this.anchor) this.update(true); // ask for the whole file now
    this.E.sync?.();
  }
  /** A decoder that returns digital silence where the file's waveform (made by the server) has sound is broken. */
  checkSound(s, buf, a, b) {
    const peaks = mediaRT.get(s.id)?.peaks;
    if (!peaks?.length) return;
    let want = 0;
    for (let i = Math.max(0, Math.floor(a * 100)), e = Math.min(peaks.length, Math.ceil(b * 100)); i < e; i++) if (peaks[i] > want) want = peaks[i];
    if (want < 0.08) return; // quiet there anyway
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i += 5) if (Math.abs(d[i]) > 1e-5) return;
    }
    throw new Error('decoded silence where the waveform has sound');
  }
  /** Remember what went wrong (Diagnostik shows the last one; the JSON keeps the latest events). */
  problem(what, err, s = null) {
    const msg = String(err?.message || err || '').slice(0, 160);
    metrics.count(`audio_problem_${what}`);
    metrics.event('audio_problem', { what, msg, ...(s ? { file: String(store.media(s.id)?.name || s.id).slice(0, 40), mode: s.state } : {}) });
    this.lastProblem = `${what}: ${msg}`;
  }
  /** Keep at most KEEP_S decoded seconds: drop the blocks used longest ago (never ones playing now). */
  evict() {
    let total = 0;
    const all = [];
    for (const s of this.sources.values()) {
      for (const [k, b] of s.blocks) if (b.state === 'ready') { total += b.buffer.duration; all.push([s, k, b]); }
    }
    if (total <= KEEP_S) return;
    all.sort((x, y) => x[2].used - y[2].used);
    const now = performance.now();
    for (const [s, k, b] of all) {
      if (total <= KEEP_S) break;
      if (now - b.used < 4000) continue;
      s.blocks.delete(k);
      total -= b.buffer.duration;
    }
  }
  /** For Diagnostik. */
  info() {
    const ctx = this.ctx;
    let decodedS = 0;
    const states = {};
    for (const s of this.sources.values()) {
      states[s.state] = (states[s.state] || 0) + 1;
      for (const b of s.blocks.values()) if (b.state === 'ready') decodedS += b.buffer.duration;
    }
    return {
      sampleRate: ctx?.sampleRate || null,
      latencyMs: ctx ? Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000) : null,
      state: ctx?.state || null,
      clock: this.clockSource || null,
      lastProblem: this.lastProblem,
      decodedS: Math.round(decodedS),
      sources: states,
      audioDecoder: typeof AudioDecoder === 'function',
    };
  }
}
