// Byte access to a media copy for the editor's own decoders (preview pictures, framesource.js, and preview sound,
// audio.js) (v1.14, P2-6).
//
// Before, the preview's pictures came from <video> elements and its sound was scheduled only once the whole copy was
// on this device: until then, the browser's media loader decided what to download and when. On an iPad (WebKit) it
// often waited at a cut for seconds. Now the editor reads exactly the bytes it needs: from the copy on this device (a
// Blob, read in slices) or from the server (HTTP Range, in aligned windows read a little ahead). Pictures and sound of
// one file share the windows, so a stretch is fetched once. When the device copy arrives, the same reader switches to
// it (same bytes) without anyone noticing.
import { blobOfUrl } from './util.js';

const WIN_NET = 1 << 20; // a server read: 1 MB (≈ 3–5 s of the 720p preview copy)
const WIN_BLOB = 2 << 20; // a slice of a device copy
const BUDGET = 48 << 20; // windows kept in memory, all files together
const RETRIES = 4;

let uid = 0;
const lru = new Map(); // `${owner.id}:${window}` -> { owner, w, bytes } (most recently used last)
let kept = 0;
function touch(owner, w, buf) {
  const k = `${owner.id}:${w}`;
  const old = lru.get(k);
  if (old) { lru.delete(k); kept -= old.bytes; }
  lru.set(k, { owner, w, bytes: buf.length });
  kept += buf.length;
  for (const [key, e] of lru) {
    if (kept <= BUDGET || key === k) break;
    lru.delete(key);
    kept -= e.bytes;
    e.owner.windows.delete(e.w);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sizeOf = (res) => Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1]) || 0;

export class MediaBytes {
  /**
   * load(start, end, { low }) → Uint8Array of [start, end); size: bytes in the file (0: learnt from the first read).
   */
  constructor({ load, size = 0, win = WIN_NET, blob = null, url = null }) {
    this.id = ++uid;
    this.load = load;
    this.size = size;
    this.win = win;
    this.blob = blob;
    this.url = url;
    this.windows = new Map(); // window index -> Uint8Array
    this.loading = new Map(); // window index -> promise
    this.stats = { reads: 0, loads: 0, bytes: 0, waits: 0 };
  }
  static fromBlob(blob) {
    const b = new MediaBytes({ size: blob.size, win: WIN_BLOB, blob });
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
          const res = await fetchImpl(url, { credentials: 'same-origin', priority: low ? 'low' : 'high', headers: { Range: `bytes=${a}-${z - 1}` } });
          if (res.status === 206) {
            if (!b.size) b.size = sizeOf(res);
            return new Uint8Array(await res.arrayBuffer());
          }
          if (res.status === 200) {
            // the server ignored the range and sends the whole file: keep it, and read it like a device copy
            const whole = await res.blob();
            b.useBlob(whole);
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
  /** The device copy of the same file is here: read it from now on (windows already read stay valid). */
  useBlob(blob) {
    if (this.blob || !blob) return;
    this.blob = blob;
    this.size = blob.size;
    this.load = (a, z) => this.fromDevice(a, z);
  }
  /** Is [off, off+len) in memory? */
  has(off, len) {
    for (let w = Math.floor(off / this.win), last = Math.floor((off + len - 1) / this.win); w <= last; w++) if (!this.windows.has(w)) return false;
    return true;
  }
  /** Is this byte range being waited for from the network (not on this device, not in memory)? */
  remote(off, len) { return !this.blob && !this.has(off, len); }
  window(w, low = false) {
    const have = this.windows.get(w);
    if (have) { touch(this, w, have); return have; }
    let p = this.loading.get(w);
    if (!p) {
      const a = w * this.win;
      const z = this.size ? Math.min(this.size, a + this.win) : a + this.win;
      this.stats.loads++;
      p = this.load(a, z, { low }).then((buf) => {
        this.windows.set(w, buf);
        this.stats.bytes += buf.length;
        touch(this, w, buf);
        return buf;
      }).finally(() => this.loading.delete(w));
      this.loading.set(w, p);
    }
    return p;
  }
  /** Bytes [off, off+len) when they are in memory, else null (no wait). */
  peek(off, len) {
    const w0 = Math.floor(off / this.win);
    if (Math.floor((off + len - 1) / this.win) !== w0) return null;
    const buf = this.windows.get(w0);
    if (!buf) return null;
    touch(this, w0, buf);
    const p = off - w0 * this.win;
    return p + len <= buf.length ? buf.subarray(p, p + len) : null;
  }
  async read(off, len) {
    this.stats.reads++;
    const hit = this.peek(off, len);
    if (hit) return hit;
    this.stats.waits++;
    const w0 = Math.floor(off / this.win);
    const w1 = Math.floor((off + Math.max(1, len) - 1) / this.win);
    const parts = [];
    for (let w = w0; w <= w1; w++) parts.push(await this.window(w));
    if (w0 === w1) { const p = off - w0 * this.win; return parts[0].subarray(p, p + len); }
    const out = new Uint8Array(len);
    let o = 0;
    for (let i = 0; i < parts.length; i++) {
      const base = (w0 + i) * this.win;
      const a = Math.max(off, base);
      const z = Math.min(off + len, base + parts[i].length);
      if (z > a) { out.set(parts[i].subarray(a - base, z - base), o); o += z - a; }
    }
    return o === len ? out : out.subarray(0, o);
  }
  /** Start reading the window holding `off` (ahead of need), at low priority. */
  prefetch(off) {
    if (off < 0 || (this.size && off >= this.size)) return;
    const w = Math.floor(off / this.win);
    if (!this.windows.has(w) && !this.loading.has(w)) this.window(w, true)?.catch?.(() => {});
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
