// Preview pictures decoded by the editor itself (v1.14, P2-6).
//
// Before, every picture of the preview came from a <video> element (a few per file, plan.js), and at every cut the
// browser's media player had to load, seek and start one. How fast that happens is the browser's business: Chrome on a
// PC does it in a few milliseconds, WebKit on an iPad (every iPad browser) often waited for seconds while the timeline
// stood still. Now, like browser editors built on WebCodecs, the editor reads the samples of the video track itself
// (mediabytes.js), decodes them with the device's VideoDecoder (hardware), and keeps the frames it will show next:
//  - a stretch that is coming up (the next cut) is decoded from the keyframe before its in-point ahead of time, so its
//    first picture is ready when the playhead gets there;
//  - while it plays, a few frames are decoded ahead of the clock (the audio clock, audio.js), and the picture shown is
//    the frame for the clock's time — no seeking, no waiting for a player to start;
//  - a jump (seek, scrub, a stretch elsewhere in the file) restarts at the keyframe before the new time;
//  - paused, it decodes exactly the frame at the playhead.
// The <video> path stays for what this cannot play (engine.js decodes()): files that are not H.264 MP4/MOV, browsers
// without WebCodecs, a decoder that fails here, real-time exports.
import { demuxVideo } from './fastexport.js';
import { mediaBytes, copyOf } from './mediabytes.js';
import { metrics } from './metrics.js';

const AHEAD = 10; // frames decoded ahead of the clock while playing (≈ 0.33 s at 30 fps)
const PRIME = 3; // ... of a stretch that comes up next (its first pictures)
const EXTRA_STILL = 2; // samples fed past the frame wanted while paused (a decoder may keep the newest one until more input)
const MAX_EXTRA = 8; // more input for a decoder that holds frames back
const DECODE_QUEUE = 6; // samples waiting inside the decoder at most
const STUCK_MS = 150; // nothing out for this long while a frame is needed: give the decoder more input
const RESYNC_MS = 900; // ... and still nothing: flush it (then go on from the keyframe before)
const WARMUP_MS = 1500; // a hardware decoder's first frame may take this long
const MAX_RESYNCS = 6; // in 10 s: a decoder that only gives frames on a flush cannot play a preview
const FLUSH_MS = 3000;
const PREFETCH_S = 3; // seconds of samples whose bytes are read ahead of the decoder
const SCRUB_WAIT_MS = 1500; // a jump while paused waits at most this long for the picture of the jump before it

export const decoderSupported = () => typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function' && typeof VideoFrame === 'function';

const withTimeout = (p, ms, what) => {
  let t = null;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not answer within ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
};

/** The video track of one copy of a media file: sample table, decoder config and indexes, shared by its FrameSources. */
export class VideoFile {
  constructor(ident, bytes, { env = globalThis, track = null, cfg = null } = {}) {
    this.ident = ident;
    this.bytes = bytes;
    this.state = 'opening'; // opening | ready | failed
    this.at = Date.now();
    if (track) { this.setTrack(track, cfg); this.state = 'ready'; this.ready = Promise.resolve(); return; }
    this.ready = this.open(env).catch((e) => {
      this.state = 'failed';
      this.error = String(e?.message || e);
      this.transient = !!e?.transient; // a network error: tried again later
      metrics.count(this.transient ? 'decoder_file_unreachable' : 'decoder_file_unsupported');
    });
  }
  async open(env) {
    let moov;
    try { moov = await this.bytes.moov(); } catch (e) {
      if (/no moov/.test(e?.message || '')) throw e;
      throw Object.assign(new Error(`reading the file: ${e?.message || e}`), { transient: true });
    }
    const track = demuxVideo(moov); // (throws for what it cannot read: HEVC, rotated, no video track…)
    const cfg = { codec: track.codec, description: track.description, codedWidth: track.width, codedHeight: track.height, optimizeForLatency: true };
    const ok = await env.VideoDecoder.isConfigSupported(cfg).then((r) => !!r?.supported, () => false);
    if (!ok) throw new Error(`no decoder for ${track.codec}`);
    this.setTrack(track, cfg);
    this.state = 'ready';
  }
  setTrack(track, cfg) {
    this.track = track;
    this.cfg = cfg;
    const S = track.samples;
    const n = S.length;
    // suffix minimum of presentation times (decode order): once sample i is fed, no unfed one is earlier than this
    this.suffixMin = new Float64Array(n + 1);
    this.suffixMin[n] = Infinity;
    for (let i = n - 1; i >= 0; i--) this.suffixMin[i] = Math.min(S[i].pts, this.suffixMin[i + 1]);
    this.keys = [];
    for (let i = 0; i < n; i++) if (S[i].key) this.keys.push(i);
    if (!this.keys.length || this.keys[0] !== 0) this.keys.unshift(0);
    const sorted = Float64Array.from(S.map((s) => s.pts)).sort();
    this.firstPts = n ? sorted[0] : 0;
    const span = n > 1 ? (sorted[n - 1] - sorted[0]) / (n - 1) : 1 / 30;
    this.frameDur = span > 0 && span < 1 ? span : 1 / 30;
  }
  /** Sample index of the last keyframe presented at or before t (where decoding for t starts). */
  keyIndexAt(t) {
    const S = this.track.samples;
    const K = this.keys;
    let lo = 0;
    let hi = K.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (S[K[mid]].pts <= t + 1e-6) lo = mid; else hi = mid - 1; }
    return K[lo];
  }
  /** Keyframe at or before sample index i (decode order). */
  keyBefore(i) {
    const K = this.keys;
    let lo = 0;
    let hi = K.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (K[mid] <= i) lo = mid; else hi = mid - 1; }
    return K[lo];
  }
}

const files = new Map(); // copy identity -> VideoFile
/** The decodable video track of what the preview plays of a media item: a VideoFile (check .state), or null. */
export function videoFileFor(rt) {
  if (!decoderSupported()) return null;
  const ident = copyOf(rt);
  const bytes = ident && mediaBytes(rt); // (switches the shared reader to the device copy once it is here)
  if (!bytes) return null;
  let f = files.get(ident);
  if (f && f.state === 'failed' && f.transient && Date.now() - f.at > 5000) f = null; // (unreachable before: try again)
  if (!f) { f = new VideoFile(ident, bytes); files.set(ident, f); }
  return f;
}

/**
 * The frames of one stretch of a video file at a time: one decoder, fed ahead of what is shown (see the top of the file).
 * want(t, …) says which source time is needed (each tick); frame(t) is the picture for t (a VideoFrame, valid until
 * the next frame() call), or null while it is not decoded yet.
 */
export class FrameSource {
  constructor(file, { onFrame = () => {}, env = globalThis, now = () => performance.now() } = {}) {
    this.file = file;
    this.S = file.track.samples;
    this.fd = file.frameDur;
    this.onFrame = onFrame;
    this.now = now;
    this.queue = []; // decoded frames after the one shown, sorted by time
    this.cur = null; // the frame shown (the newest at or before the target)
    this.standIn = false; // cur is from before a jump: shown until the new picture is out, but not the right one
    this.pending = new Map(); // timestamp (µs) fed and not out of the decoder yet -> sample index
    this.target = null;
    this.mode = 'still';
    this.ahead = 0;
    this.end = Infinity;
    this.next = null; // next sample to feed (decode order)
    this.from = 0;
    this.gen = 0;
    this.extra = 0;
    this.extraAt = 0;
    this.maxOut = -Infinity;
    this.dupBelow = -Infinity;
    this.resyncs = [];
    this.closed = false;
    this.failed = null;
    this.waitingBytes = false; // the pump waits for bytes from the network
    this.stats = { decoded: 0, shown: 0, restarts: 0, flushes: 0, lost: 0, fed: 0 };
    this.Chunk = env.EncodedVideoChunk;
    this.dec = new env.VideoDecoder({ output: (f) => this.onOutput(f), error: (e) => this.fail(e) });
    this.dec.addEventListener?.('dequeue', () => this.kick());
  }

  /**
   * The source time needed now. playing: keep `ahead` frames decoded after it (default AHEAD); still: decode exactly
   * the frame at t. end: source time where the stretch ends (nothing is decoded far past it).
   */
  want(t, { playing = false, ahead = playing ? AHEAD : 0, end = Infinity } = {}) {
    if (this.closed || this.failed || !Number.isFinite(t)) return;
    this.mode = playing ? 'play' : 'still';
    this.ahead = ahead;
    this.end = end;
    if (!playing) this.scrubAhead(t);
    if (this.jumps(t)) {
      // Paused (a scrub): while the picture of the last jump is still on its way (bytes from the server, the decoder),
      // a new jump waits for it instead of throwing it away. Before, a finger moving faster than the bytes came
      // restarted the decoder at every position and no picture was shown until it stopped (iPad, streamed copy).
      if (!playing && this.inFlight && this.now() - this.restartAt < SCRUB_WAIT_MS) {
        this.deferred = { t, end };
        this.kick();
        return;
      }
      this.restart(t);
    }
    this.deferred = null;
    this.target = t;
    this.trim(t);
    this.kick();
  }
  /** Paused and moving (a scrub): read the bytes a few seconds further in the direction of the finger already. */
  scrubAhead(t) {
    const last = this.lastStill;
    this.lastStill = t;
    if (last == null || Math.abs(t - last) < 1e-3) return;
    const dir = Math.sign(t - last);
    for (const s of [2, 5]) {
      // (the group of pictures there: from its keyframe to the next one)
      const k = this.file.keyIndexAt(Math.max(0, t + dir * s));
      let j = k + 1;
      while (j < this.S.length - 1 && !this.S[j].key) j++;
      this.file.bytes.prefetch?.(this.S[k].offset, this.S[j].offset - this.S[k].offset + this.S[j].size);
    }
  }
  /**
   * The bytes of the samples from i on that will be decoded soon, as one request: while playing up to PREFETCH_S
   * ahead (never far past the stretch's end), paused up to the frame wanted. (Asked sample by sample, every sample
   * not here would wait for its own round trip.)
   */
  announce(i, { high = true } = {}) {
    const S = this.S;
    const b = this.file.bytes;
    if (!b.prefetch || b.has?.(S[i].offset, S[i].size)) return;
    const limit = this.mode === 'play' ? Math.min(this.end + 0.3, S[i].pts + PREFETCH_S) : Math.max(S[i].pts, this.target ?? 0) + 0.25;
    let j = i;
    while (j + 1 < S.length && S[j + 1].pts <= limit) j++;
    j = Math.min(S.length - 1, j + 3 + (this.extra || 0));
    b.prefetch(S[i].offset, S[j].offset + S[j].size - S[i].offset, { high });
  }
  /** The jump in flight showed its picture: go on to where the finger is now. */
  settleJump() {
    if (!this.inFlight || this.target == null || !this.final(this.target)) return;
    this.inFlight = false;
    const d = this.deferred;
    if (d) { this.deferred = null; this.want(d.t, { end: d.end }); }
  }
  /** Does reaching t mean starting again at a keyframe (back in time, or a keyframe far after the decode position)? */
  jumps(t) {
    if (this.next == null) return true;
    const lim = t + this.fd / 2;
    // the earliest picture still here or to come: its frame was passed already (closed) when t is before it
    let earliest = this.file.suffixMin[this.next];
    for (const ts of this.pending.keys()) earliest = Math.min(earliest, ts / 1e6);
    if (this.queue.length) earliest = Math.min(earliest, this.queue[0].timestamp / 1e6);
    if (this.cur && !this.standIn) earliest = Math.min(earliest, this.cur.timestamp / 1e6);
    if (lim + 1e-6 < earliest && earliest > this.file.firstPts + 1e-6) return true;
    const k = this.file.keyIndexAt(t);
    const at = this.next < this.S.length ? this.S[this.next].pts : Infinity;
    return k > this.next && this.S[k].pts - at > 0.2;
  }
  restart(t) {
    this.gen++;
    this.stats.restarts++;
    for (const f of this.queue) f.close();
    this.queue = [];
    this.pending.clear();
    if (this.cur) this.standIn = true; // (the old picture until the new one is out)
    try {
      if (this.dec.state === 'configured') this.dec.reset();
      this.dec.configure(this.file.cfg);
    } catch (e) { this.fail(e); return; }
    this.next = this.from = this.file.keyIndexAt(t);
    this.ended = false;
    this.flushedEnd = false;
    // (a decoder that kept frames back until more input before gets that much more input from the start: Safari's
    // took 150 ms longer for every first frame otherwise)
    this.extra = this.file.extraNeeded || 0;
    this.extraAt = 0;
    this.maxOut = -Infinity;
    this.dupBelow = -Infinity;
    this.gotOut = false;
    this.lastOut = this.now();
    this.primeAt = this.now();
    this.restartAt = this.now();
    this.inFlight = true;
  }
  /** The slot moves on to another stretch: its last picture belongs to the old one (not shown for the new one). */
  drop() {
    this.cur?.close();
    this.cur = null;
    this.standIn = false;
  }
  /** Make cur the newest decoded frame at or before t. */
  trim(t) {
    const lim = Math.round((t + this.fd / 2) * 1e6);
    let moved = false;
    while (this.queue.length && this.queue[0].timestamp <= lim) {
      const old = this.cur;
      this.cur = this.queue.shift();
      old?.close();
      this.standIn = false;
      moved = true;
    }
    // before the first picture of the file (an edit-list delay): its first frame
    if (!this.cur && this.queue.length && t + this.fd / 2 < this.file.firstPts && this.queue[0].timestamp <= Math.round(this.file.firstPts * 1e6) + 1) {
      this.cur = this.queue.shift();
      moved = true;
    }
    return moved;
  }
  /** The picture for source time t (valid until the next call), or null. */
  frame(t) {
    if (this.closed) return null;
    if (this.trim(t)) this.kick();
    if (this.cur && this.cur !== this.lastShown) { this.lastShown = this.cur; this.stats.shown++; }
    return this.cur;
  }
  /** Seconds the picture for t is behind t (Infinity: none yet, or only the one from before a jump). */
  lag(t) {
    if (!this.cur || this.standIn) return Infinity;
    return Math.max(0, t - this.cur.timestamp / 1e6 - this.fd);
  }
  /** Is cur exactly the frame for t (every sample shown at or before t has been decoded)? */
  final(t) {
    if (this.next == null || this.standIn || this.closed) return false;
    const lim = t + this.fd / 2;
    if (this.needs(lim) || this.waitingFor(lim)) return false;
    return !!this.cur || (this.ended && !this.queue.length);
  }
  /** After a stall: the picture for t is here and some frames after it (or the stretch ends). */
  canResume(t) {
    if (!this.final(t)) return false;
    const atEnd = this.ended || this.next >= this.S.length || this.S[this.next].pts > this.end;
    return atEnd || this.queue.length >= Math.min(4, this.ahead || 4);
  }
  /** Is a sample shown at or before lim (seconds) still to be fed? (frames out before a flush are not needed again) */
  needs(lim) {
    return this.file.suffixMin[this.next] <= lim && lim * 1e6 > this.dupBelow;
  }
  /** Is a frame shown at or before lim fed and not out of the decoder yet? */
  waitingFor(lim) {
    const us = lim * 1e6;
    for (const ts of this.pending.keys()) if (ts <= us && ts > this.dupBelow) return true;
    return false;
  }

  onOutput(f) {
    const ts = f.timestamp;
    if (this.closed || !this.pending.has(ts)) { f.close(); return; }
    this.pending.delete(ts);
    this.stats.decoded++;
    this.lastOut = this.now();
    this.gotOut = true;
    if (ts <= this.dupBelow) { f.close(); return; } // given again after a flush
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].timestamp > ts) i--;
    if ((i > 0 && this.queue[i - 1].timestamp === ts) || (this.cur && !this.standIn && this.cur.timestamp === ts)) { f.close(); return; }
    this.queue.splice(i, 0, f);
    if (ts > this.maxOut) this.maxOut = ts;
    const wasNew = this.target != null && this.trim(this.target);
    if (wasNew && this.primeAt != null) {
      metrics.sample('decoder_first_frame_ms', this.now() - this.primeAt);
      this.primeAt = null;
    }
    if (wasNew) this.onFrame(this);
    this.settleJump();
    this.kick();
  }
  fail(e) {
    if (this.failed || this.closed) return;
    this.failed = e || new Error('decoder error');
    metrics.count('decoder_error');
    this.close();
    this.onFrame(this);
  }

  kick() {
    if (this.wake) { const w = this.wake; this.wake = null; w(); } else if (!this.running && !this.closed) this.pump();
  }
  sleep(ms) { return new Promise((r) => { const t = setTimeout(() => { if (this.wake === r) this.wake = null; r(); }, ms); this.wake = () => { clearTimeout(t); r(); }; }); }
  /** What to do next: 'feed' a sample, 'flush' the decoder, wait (ms) for output, or 'done' until want()/frame(). */
  step() {
    if (this.next == null || this.target == null) return 'done';
    const S = this.S;
    const n = S.length;
    const lim = this.target + this.fd / 2;
    const waiting = this.waitingFor(lim);
    if (this.next < n) {
      if (this.dec.decodeQueueSize >= DECODE_QUEUE) return STUCK_MS;
      if (this.needs(lim)) return 'feed'; // a sample shown at or before the target
      // (past the stretch's end nothing is shown — but a decoder that keeps `extra` frames back needs that much more
      // input to give out the stretch's last frames: without it Safari froze the last ~100 ms before every cut)
      const past = S[this.next].pts > this.end + (3 + this.extra) * this.fd;
      if (this.mode === 'play') {
        // decoded frames kept: at most `ahead`; input in flight may be `extra` more (for a decoder that keeps some
        // back until more input). Keeping more frames than that stalls a hardware decoder with few output pictures.
        if (!past && this.queue.length < this.ahead && this.queue.length + this.pending.size < this.ahead + this.extra) return 'feed';
      } else if (waiting) {
        // paused: the frame wanted is inside the decoder; a few samples more push it out
        let after = 0;
        for (const ts of this.pending.keys()) if (ts > lim * 1e6) after++;
        if (after < EXTRA_STILL + this.extra) return 'feed';
      }
    }
    if (waiting) {
      // fed, and not out: a decoder that waits for more input gets it (at most every STUCK_MS); one that waits for a
      // flush is flushed (not while a hardware decoder may still be starting)
      const now = this.now();
      const quiet = now - this.lastOut;
      if (quiet > STUCK_MS && now - this.extraAt > STUCK_MS && this.next < n && this.extra < MAX_EXTRA) {
        this.extra = Math.min(MAX_EXTRA, (this.extra || 2) * 2);
        this.extraAt = now;
        this.file.extraNeeded = Math.max(this.file.extraNeeded || 0, this.extra);
        return 'feed';
      }
      if (quiet - (this.gotOut ? 0 : WARMUP_MS) > RESYNC_MS && this.pending.size) return 'flush';
      return STUCK_MS;
    }
    if (this.next >= n && this.pending.size && !this.ended && !this.flushedEnd) return 'flush'; // the file's last frames
    return 'done';
  }
  async pump() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (!this.closed && !this.failed) {
        const s = this.step();
        if (s === 'done') break;
        if (s === 'feed') await this.feed();
        else if (s === 'flush') await this.flush();
        else await this.sleep(s);
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.running = false;
    }
  }
  async feed() {
    const gen = this.gen;
    const i = this.next;
    const s = this.S[i];
    const bytes = this.file.bytes;
    let data = bytes.peek(s.offset, s.size);
    if (!data) {
      this.announce(i);
      this.waitingBytes = true;
      try {
        data = await bytes.read(s.offset, s.size);
      } catch (e) {
        metrics.count('decoder_read_retry');
        await this.sleep(1000); // (the network: try again; the engine shows "buffering" meanwhile)
        return;
      } finally {
        this.waitingBytes = false;
      }
      if (gen !== this.gen || this.closed) return;
    }
    // while playing: the next stretch of bytes, a second before they are needed
    if (this.mode === 'play') {
      const m = Math.min(this.S.length - 1, i + Math.round(1 / this.fd));
      if (this.S[m].pts <= this.end + 0.3) this.announce(m, { high: false });
    }
    const ts = Math.round(s.pts * 1e6);
    this.pending.set(ts, i);
    this.next = i + 1;
    this.stats.fed++;
    this.dec.decode(new this.Chunk({ type: s.key ? 'key' : 'delta', timestamp: ts, data }));
  }
  async flush() {
    const gen = this.gen;
    const before = [...this.pending.keys()];
    this.stats.flushes++;
    metrics.count('decoder_flush');
    try {
      await withTimeout(this.dec.flush(), FLUSH_MS, 'video decoder flush');
    } catch (e) {
      if (gen === this.gen && !this.closed) throw e;
      return; // (a restart or close ended it)
    }
    if (gen !== this.gen || this.closed) return;
    for (const ts of before) if (this.pending.delete(ts)) this.stats.lost++;
    this.lastOut = this.now();
    if (this.next >= this.S.length) { this.flushedEnd = true; this.ended = true; return; }
    // a decoder that gives frames only on a flush cannot play a preview: the engine falls back to the video element
    const now = this.now();
    this.resyncs = this.resyncs.filter((x) => now - x < 10000);
    this.resyncs.push(now);
    if (this.resyncs.length > MAX_RESYNCS) throw new Error('video decoder holds frames until a flush');
    // more input after a flush starts at a keyframe; frames given again are dropped
    this.dupBelow = this.maxOut;
    this.next = this.file.keyBefore(this.next);
    this.extra = 0;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.gen++;
    for (const f of this.queue) f.close();
    this.queue = [];
    this.cur?.close();
    this.cur = null;
    this.pending.clear();
    try { this.dec.close(); } catch { /* closed */ }
    this.kick();
  }
}
