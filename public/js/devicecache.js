// Persistent device cache for server media (Origin Private File System).
// The VPS stays the source of truth; this is only a copy so a refresh — or reopening the browser —
// plays straight from disk instead of downloading the video again.
//
// Layout: najja-media/<key>/ holds meta.json plus numbered segment files. A download appends
// segments (at most 4 MB each, closed whenever the download pauses), so an interrupted download
// resumes where it stopped. The finished file is a Blob made of the segment files: disk-backed,
// never loaded into memory as a whole.
// key = <media id>_p<version> for the server's H.264 copy, <media id>_f for an original file.

const ROOT = 'najja-media';
const SEGMENT = 4 * 1024 * 1024; // an interrupted download loses at most this much
const DEFAULT_LIMIT = 5 * 1024 ** 3; // 5 GB, chosen by the owner

let rootDir = null;
let rootPromise = null;
async function root() {
  if (rootDir) return rootDir;
  if (!rootPromise) {
    rootPromise = (async () => {
      if (!navigator.storage?.getDirectory || typeof FileSystemFileHandle === 'undefined' || !('createWritable' in FileSystemFileHandle.prototype)) return null;
      try {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
        rootDir = dir;
        return dir;
      } catch {
        return null; // e.g. private window
      }
    })();
  }
  return rootPromise;
}

async function readMeta(dir) {
  try { return JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text()); } catch { return null; }
}
async function writeMeta(dir, meta) {
  const w = await (await dir.getFileHandle('meta.json', { create: true })).createWritable();
  await w.write(JSON.stringify(meta));
  await w.close();
}
/** Segment files of an entry, in order, with their sizes. */
async function segments(dir) {
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file' || !/^\d{6}$/.test(name)) continue;
    const f = await h.getFile();
    if (f.size) out.push({ n: Number(name), file: f });
  }
  return out.sort((a, b) => a.n - b.n);
}

const lockName = (key) => `najja-cache-${key}`;
/**
 * Run fn holding the download lock for key, so only one tab writes an entry. A second tab waits, then finds
 * the entry complete (fn checks that first) instead of downloading the same file again.
 */
async function withLock(key, fn) {
  if (!navigator.locks?.request) return fn();
  return navigator.locks.request(lockName(key), fn);
}

export const deviceCache = {
  /** Bytes this device may keep (5 GB; localStorage 'najja.deviceCacheMB' overrides it, for tests). */
  limit() {
    try {
      const mb = Number(localStorage.getItem('najja.deviceCacheMB'));
      if (mb > 0) return mb * 1024 * 1024;
    } catch { /* storage blocked */ }
    return DEFAULT_LIMIT;
  },
  async available() { return !!(await root()); },

  /** Cache key per server copy: _e<v> light preview copy, _p<v> full-quality H.264 copy, _f original file. */
  keyFor(id, url) {
    if (!id || !url || url.startsWith('blob:')) return null;
    const e = /\/edit\?v=(\d+)/.exec(url);
    if (e) return `${id}_e${e[1]}`;
    const v = /\/proxy\?v=(\d+)/.exec(url);
    if (v) return `${id}_p${v[1]}`;
    if (/\/file(\?|$)/.test(url)) return `${id}_f`;
    return null;
  },

  /** The cached copy for key as a blob: URL (disk-backed), or null. Marks it as recently used. */
  async open(key) {
    const r = await root();
    if (!r || !key) return null;
    try {
      const dir = await r.getDirectoryHandle(key);
      const meta = await readMeta(dir);
      if (!meta?.complete) return null;
      const segs = await segments(dir);
      const size = segs.reduce((a, s) => a + s.file.size, 0);
      if (size !== meta.size) return null;
      meta.lastUsed = Date.now();
      writeMeta(dir, meta).catch(() => {});
      return URL.createObjectURL(new Blob(segs.map((s) => s.file), { type: meta.type || '' }));
    } catch {
      return null;
    }
  },

  /** Every entry with its size and state. */
  async list() {
    const r = await root();
    if (!r) return [];
    const out = [];
    for await (const [name, h] of r.entries()) {
      if (h.kind !== 'directory') continue;
      const meta = (await readMeta(h)) || {};
      const segs = await segments(h);
      out.push({ key: name, id: meta.id || name.split('_')[0], name: meta.name || '', size: segs.reduce((a, s) => a + s.file.size, 0), total: meta.size || 0, complete: !!meta.complete, lastUsed: meta.lastUsed || 0 });
    }
    return out;
  },
  async usage() { return (await this.list()).reduce((a, e) => a + e.size, 0); },

  async remove(key) {
    const r = await root();
    if (r) await r.removeEntry(key, { recursive: true }).catch(() => {});
  },
  /** Drop every copy of a media item (e.g. it was deleted), except `keep`; with `sameKind`, only older versions of keep's kind. */
  async removeMedia(id, keep = null, { sameKind = false } = {}) {
    const kind = (k) => (k || '').slice(id.length + 1, id.length + 2);
    for (const e of await this.list()) {
      if (e.id !== id || e.key === keep) continue;
      if (sameKind && kind(e.key) !== kind(keep)) continue;
      await this.remove(e.key);
    }
  },
  async clear() {
    for (const e of await this.list()) await this.remove(e.key);
  },

  /** Make room for `bytes` more, removing least recently used entries not in `protect` (media ids). */
  async makeRoom(bytes, protect = new Set(), current = null) {
    const limit = this.limit();
    const all = await this.list();
    let used = all.reduce((a, e) => a + e.size, 0);
    if (used + bytes <= limit) return true;
    for (const e of all.filter((x) => x.key !== current && !protect.has(x.id)).sort((a, b) => a.lastUsed - b.lastUsed)) {
      await this.remove(e.key);
      used -= e.size;
      if (used + bytes <= limit) return true;
    }
    return used + bytes <= limit;
  },

  async persisted() {
    try { return !!(await navigator.storage?.persisted?.()); } catch { return false; }
  },

  /**
   * Download src into the cache under key, resuming a partial download. Returns a blob: URL when complete,
   * or null (no space, no OPFS, another tab is downloading it, or it was stopped).
   * fetchFrom(offset) → Response; hooks: shouldPause(), waitResume(), stillWanted(), onProgress(0..1).
   */
  async download(key, { id, name, fetchFrom, shouldPause, waitResume, stillWanted, onProgress, protect }) {
    const r = await root();
    if (!r || !key) return null;
    return withLock(key, async () => {
      const dir = await r.getDirectoryHandle(key, { create: true });
      let meta = await readMeta(dir);
      let segs = await segments(dir);
      let got = segs.reduce((a, s) => a + s.file.size, 0);
      let next = segs.length ? segs[segs.length - 1].n + 1 : 0;
      if (meta?.complete && got === meta.size) return this.open(key);
      for (let attempt = 0; attempt < 30; attempt++) {
        await waitResume();
        if (!stillWanted()) return null;
        let res;
        try { res = await fetchFrom(got); } catch { await new Promise((ok) => setTimeout(ok, 2000)); continue; }
        if (!res.ok || !res.body) return null;
        if (got && res.status !== 206) { // the server ignored the range: start over
          for (const s of segs) await dir.removeEntry(String(s.n).padStart(6, '0')).catch(() => {});
          segs = [];
          got = 0;
          next = 0;
        }
        const total = Number((res.headers.get('content-range') || '').split('/')[1]) || (got + Number(res.headers.get('content-length'))) || 0;
        if (!meta || meta.size !== total) {
          if (!total || !(await this.makeRoom(total - got, protect, key))) { res.body.cancel().catch(() => {}); return null; }
          meta = { id, name, key, size: total, type: res.headers.get('content-type') || '', complete: false, created: Date.now(), lastUsed: Date.now() };
          await writeMeta(dir, meta);
          navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict it
        }
        const reader = res.body.getReader();
        let w = null;
        let inSeg = 0;
        const closeSeg = async () => { if (w) { await w.close(); w = null; inSeg = 0; } };
        let paused = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!stillWanted()) { reader.cancel().catch(() => {}); await closeSeg(); return null; }
            let off = 0;
            while (off < value.length) {
              if (!w) w = await (await dir.getFileHandle(String(next++).padStart(6, '0'), { create: true })).createWritable();
              const n = Math.min(value.length - off, SEGMENT - inSeg);
              await w.write(value.subarray(off, off + n));
              off += n;
              inSeg += n;
              got += n;
              if (inSeg >= SEGMENT) await closeSeg();
            }
            onProgress?.(total ? got / total : 0);
            if (shouldPause()) { paused = true; reader.cancel().catch(() => {}); break; } // resume later from `got`
          }
        } catch {
          paused = true; // connection dropped: retry from where it stopped
        }
        await closeSeg();
        if (!paused && got >= total) break;
      }
      segs = await segments(dir);
      got = segs.reduce((a, s) => a + s.file.size, 0);
      if (got !== meta?.size) return null;
      meta.complete = true;
      meta.lastUsed = Date.now();
      await writeMeta(dir, meta);
      await this.removeMedia(id, key, { sameKind: true }); // older versions of this copy (the preview and export copies stay)
      return this.open(key);
    });
  },
};
