// Byte access to a media copy for the editor's own decoders (preview pictures, framesource.js, and preview sound,
// audio.js) (v1.14, P2-6).
//
// Before, the preview's pictures came from <video> elements and its sound was scheduled only once the whole copy was
// on this device: until then, the browser's media loader decided what to download and when. On an iPad (WebKit) it
// often waited at a cut for seconds. Now the editor reads the bytes it needs itself: from the copy on this device (a
// Blob, read in slices) or from the server (HTTP Range). Pictures and sound of one file share what was read, and when
// the device copy arrives, the same reader switches to it (same bytes) without anyone noticing.
//
// (v1.14.1) Exact ranges, not windows. The first version read the server copy in aligned 1 MB windows. A timeline of
// jump cuts needs ~150 KB per cut (from the keyframe before the in-point to the out-point), so most of every window
// was never used: in the lab (2-minute copy, 30 cuts, 10 Mbps) it fetched the whole 18.4 MB file to play cuts that
// need 3.0 MB, and the cuts came late — the stutter still seen on an iPad on Wi-Fi. Now callers ask for the ranges
// they will use (a stretch of video samples, the runs of audio samples) and only those are fetched, merged into as
// few requests as possible. A read nobody announced is fetched with a little read-ahead (MIN_READ).
import { blobOfUrl } from './util.js';

const MIN_READ = 64 << 10; // a server read is at least this long (a lone sample read then serves its neighbours too)
const MIN_READ_BLOB = 2 << 20; // a slice of a device copy (local: big slices are cheap)
const MAX_READ = 4 << 20; // longer ranges are fetched in pieces (each one usable as soon as it is here)
// (v1.14.3) Holes less than this apart are fetched as one request, the bytes between them again. The server's light
// copy (ffmpeg) puts the sound between the pictures every ~20 ms: read hole by hole, an iPad sent 3,730 requests of
// under 1 KB in 3 minutes (365 a second at the start of play), and the sound and the next cuts came late.
const JOIN_GAP = 64 << 10;
const BUDGET = 48 << 20; // bytes kept in memory, all files together
const RETRIES = 4;
// Reads ahead of need (low priority) run at most this many at a time, all files together; a read needed now starts at
// once and overtakes them. (Over HTTP/1.1 a browser opens 6 connections to a host: dozens of small sound reads
// queued in front of the bytes of the next cut made it late.)
const LOW_PARALLEL = 3;
let lowActive = 0;
const lowQueue = []; // reads waiting: { f, start }
function pumpLow() {
  while (lowActive < LOW_PARALLEL && lowQueue.length) {
    const q = lowQueue.shift();
    if (!q.f.started) { lowActive++; q.start(() => { lowActive--; pumpLow(); }); }
  }
}

let uid = 0;
let kept = 0;
const owners = new Set(); // readers holding bytes (for the shared budget)
let clock = 0;
/** Over the budget: drop the pieces used longest ago, across all files. */
function evict() {
  if (kept <= BUDGET) return;
  const all = [];
  for (const o of owners) for (const s of o.segs) all.push([o, s]);
  all.sort((x, y) => x[1].used - y[1].used);
  for (const [o, s] of all) {
    if (kept <= BUDGET) break;
    const i = o.segs.indexOf(s);
    if (i >= 0) { o.segs.splice(i, 1); kept -= s.buf.length; }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sizeOf = (res) => Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1]) || 0;

export class MediaBytes {
  /** load(start, end, { low }) → Uint8Array of [start, end); size: bytes in the file (0: learnt from the first read). */
  constructor({ load, size = 0, blob = null, url = null, minRead = MIN_READ }) {
    this.id = ++uid;
    this.load = load;
    this.size = size;
    this.blob = blob;
    this.url = url;
    this.minRead = minRead;
    this.segs = []; // bytes here: { a, z, buf, used }, sorted by a, never overlapping
    this.inflight = []; // being fetched: { a, z, p }
    this.stats = { reads: 0, loads: 0, bytes: 0, waits: 0 };
    owners.add(this);
  }
  static fromBlob(blob) {
    const b = new MediaBytes({ size: blob.size, blob, minRead: MIN_READ_BLOB });
    b.load = (a, z) => blob.slice(a, z).arrayBuffer().then((x) => new Uint8Array(x));
    return b;
  }
  static fromUrl(url, { fetch: fetchImpl = (...a) => fetch(...a) } = {}) {
    const b = new MediaBytes({ url });
    b.load = async (a, z, { low = false } = {}) => {
      let err = null;
      for (let i = 0; i < RETRIES; i++) {
        if (b.blob) return b.fromDevice(a, z); // (the device copy arrived meanwhile)
        try {
          // (no-store: Chromium's HTTP cache lets one request per URL through at a time — parallel ranges of one file
          // then waited for each other, a round trip each (measured: 8 reads 1.25 s instead of 0.2 s at 150 ms RTT).
          // The editor keeps its own copies; the browser's cache has nothing to add here.)
          const res = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', priority: low ? 'low' : 'high', headers: { Range: `bytes=${a}-${z - 1}` } });
          if (res.status === 206) {
            if (!b.size) b.size = sizeOf(res);
            return new Uint8Array(await res.arrayBuffer());
          }
          if (res.status === 200) {
            // the server ignored the range and sends the whole file: keep it, and read it like a device copy
            b.useBlob(await res.blob());
            return b.fromDevice(a, z);
          }
          if (res.status === 416) { res.body?.cancel().catch(() => {}); b.size = sizeOf(res) || b.size; return new Uint8Array(0); }
          res.body?.cancel().catch(() => {});
          err = new Error(`HTTP ${res.status}`);
          if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
        } catch (e) { err = e; }
        await sleep(400 * 2 ** i);
      }
      throw err || new Error('read failed');
    };
    return b;
  }
  fromDevice(a, z) { return this.blob.slice(a, Math.min(z, this.blob.size)).arrayBuffer().then((x) => new Uint8Array(x)); }
  /** The device copy of the same file is here: read it from now on (bytes already read stay valid). */
  useBlob(blob) {
    if (this.blob || !blob) return;
    this.blob = blob;
    this.size = blob.size;
    this.minRead = MIN_READ_BLOB;
    this.load = (a, z) => this.fromDevice(a, z);
  }

  /** Is [a, z) in memory? */
  covered(a, z) {
    let at = a;
    for (const s of this.segs) {
      if (s.z <= at) continue;
      if (s.a > at) return false;
      at = s.z;
      if (at >= z) return true;
    }
    return at >= z;
  }
  has(off, len) { return this.covered(off, off + Math.max(1, len)); }
  /** Is this byte range still to come from the network (not on this device, not in memory)? */
  remote(off, len) { return !this.blob && !this.has(off, len); }
  /** Parts of [a, z) neither in memory nor being fetched. */
  gaps(a, z) {
    const taken = [...this.segs, ...this.inflight].sort((x, y) => x.a - y.a);
    const out = [];
    let at = a;
    for (const s of taken) {
      if (s.z <= at) continue;
      if (s.a >= z) break;
      if (s.a > at) out.push([at, s.a]);
      at = Math.max(at, s.z);
      if (at >= z) break;
    }
    if (at < z) out.push([at, z]);
    return out;
  }
  /**
   * Fetch what is missing of [a, z) (merged into few requests). Resolves when all of it is here. A short range is
   * read a little further (minRead), up to the next piece already here or on its way.
   */
  ensure(a, z, { low = false, exact = false } = {}) {
    if (this.size) z = Math.min(z, this.size);
    if (z <= a) return Promise.resolve();
    // a read needed now: what was queued ahead of need for this range starts at once
    if (!low) for (const f of this.inflight) if (!f.started && f.a < z && f.z > a) f.startNow();
    const holes = [];
    for (const g of this.gaps(a, z)) {
      const last = holes[holes.length - 1];
      if (last && g[0] - last[1] <= JOIN_GAP) last[1] = g[1];
      else holes.push([...g]);
    }
    for (let [ga, gz] of holes) {
      if (!exact && gz - ga < this.minRead) {
        const next = [...this.segs, ...this.inflight].filter((s) => s.a >= gz).reduce((m, s) => Math.min(m, s.a), Infinity);
        gz = Math.min(ga + this.minRead, next, this.size || Infinity);
      }
      for (let p = ga; p < gz; p += MAX_READ) this.fetchRange(p, Math.min(gz, p + MAX_READ), low);
    }
    const waits = this.inflight.filter((f) => f.a < z && f.z > a).map((f) => f.p);
    return waits.length ? Promise.all(waits).then(() => this.ensureAgain(a, z, low, exact)) : Promise.resolve();
  }
  /** (a fetch can come back short — the end of the file, a size learnt only now: ask again for what is still missing) */
  ensureAgain(a, z, low, exact) {
    if (this.size) z = Math.min(z, this.size);
    return this.covered(a, z) || z <= a ? undefined : this.ensure(a, z, { low, exact });
  }
  fetchRange(a, z, low) {
    this.stats.loads++;
    const f = { a, z, p: null, started: false };
    let go;
    f.p = new Promise((resolve) => { go = resolve; }).then(() => this.load(a, z, { low: f.low })).then((buf) => {
      this.stats.bytes += buf.length;
      if (buf.length) this.insert(a, buf);
    }).finally(() => { this.inflight = this.inflight.filter((x) => x !== f); f.done?.(); });
    f.low = low;
    // (local: a blob slice needs no queue)
    const run = (done = null) => { if (f.started) return; f.started = true; f.done = done; go(); };
    f.startNow = () => { f.low = false; run(); };
    this.inflight.push(f);
    f.p.catch(() => {});
    if (low && !this.blob) { lowQueue.push({ f, start: run }); pumpLow(); } else run();
    return f.p;
  }
  /** Keep bytes [a, a + buf.length), without overlapping what is here already. */
  insert(a, buf) {
    let pieces = [[a, a + buf.length]];
    for (const s of this.segs) pieces = pieces.flatMap(([x, y]) => (s.z <= x || s.a >= y ? [[x, y]] : [[x, Math.min(y, s.a)], [Math.max(x, s.z), y]].filter(([p, q]) => q > p)));
    for (const [x, y] of pieces) {
      const seg = { a: x, z: y, buf: buf.subarray(x - a, y - a), used: ++clock };
      let i = this.segs.length;
      while (i > 0 && this.segs[i - 1].a > x) i--;
      this.segs.splice(i, 0, seg);
      kept += seg.buf.length;
    }
    evict();
  }
  /** Bytes [off, off+len) when they are in memory, else null (no wait). */
  peek(off, len) {
    const z = off + len;
    if (!this.covered(off, z)) return null;
    const parts = [];
    for (const s of this.segs) {
      if (s.z <= off || s.a >= z) continue;
      s.used = ++clock;
      parts.push(s);
    }
    if (parts.length === 1) return parts[0].buf.subarray(off - parts[0].a, z - parts[0].a);
    const out = new Uint8Array(len);
    for (const s of parts) {
      const x = Math.max(off, s.a);
      const y = Math.min(z, s.z);
      out.set(s.buf.subarray(x - s.a, y - s.a), x - off);
    }
    return out;
  }
  async read(off, len) {
    this.stats.reads++;
    const hit = this.peek(off, len);
    if (hit) return hit;
    this.stats.waits++;
    for (let i = 0; i < 3; i++) {
      await this.ensure(off, off + len);
      const z = this.size ? Math.min(off + len, this.size) : off + len;
      const got = this.peek(off, Math.max(0, z - off));
      if (got || z <= off) return got || new Uint8Array(0);
      // (dropped again before it was read: memory is short; fetch once more)
    }
    throw new Error('bytes not kept in memory');
  }
  /** Start fetching [off, off+len) ahead of need (low priority unless high; exact: no read-ahead past it). */
  prefetch(off, len = this.minRead, { high = false, exact = false } = {}) {
    if (off < 0 || (this.size && off >= this.size)) return;
    this.ensure(off, off + len, { low: !high, exact }).catch(() => {});
  }
  /** The moov box (sample tables) as an ArrayBuffer of its own, found by walking the top-level boxes. */
  async moov() {
    let p = 0;
    for (let guard = 0; guard < 64; guard++) {
      const h = await this.read(p, 16);
      if (h.length < 8) break;
      const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      let size = dv.getUint32(0);
      const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
      if (size === 1 && h.length >= 16) size = Number(dv.getBigUint64(8));
      else if (size === 0) size = (this.size || p + 8) - p;
      if (size < 8) break;
      if (type === 'moov') {
        const box = await this.read(p, size);
        return box.buffer.slice(box.byteOffset, box.byteOffset + box.byteLength);
      }
      p += size;
      if (this.size && p >= this.size) break;
    }
    throw new Error('no moov box');
  }
}

/**
 * Byte runs of the given samples ({ offset, size }), merged where they are adjacent in the file (or less than `join`
 * bytes apart): the few requests that fetch exactly them.
 */
export function runsOf(samples, join = 0) {
  const sorted = [...samples].sort((x, y) => x.offset - y.offset);
  const runs = [];
  for (const s of sorted) {
    const last = runs[runs.length - 1];
    if (last && s.offset <= last.z + join) last.z = Math.max(last.z, s.offset + s.size);
    else runs.push({ a: s.offset, z: s.offset + s.size });
  }
  return runs;
}

// One reader per copy of a media file, shared by its picture and sound decoders.
const shared = new Map(); // copy identity -> MediaBytes
/** Which copy rt.url is: a device copy of a server copy counts as that server copy (same bytes). */
export function copyOf(rt) {
  const url = rt?.url;
  if (!url) return null;
  return url.startsWith('blob:') && rt.remoteUrl && rt.cacheKey ? rt.remoteUrl : url;
}
/** The reader for what the preview plays of a media item now, or null (no copy, or a blob this page cannot read). */
export function mediaBytes(rt) {
  const ident = copyOf(rt);
  if (!ident) return null;
  const blob = rt.url.startsWith('blob:') ? blobOfUrl(rt.url) : null;
  let b = shared.get(ident);
  if (!b) {
    if (ident.startsWith('blob:')) { if (!blob) return null; b = MediaBytes.fromBlob(blob); } else b = MediaBytes.fromUrl(ident);
    shared.set(ident, b);
  }
  if (blob) b.useBlob(blob);
  return b;
}
