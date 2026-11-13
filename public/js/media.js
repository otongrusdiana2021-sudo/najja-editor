// Media import, thumbnails (filmstrip sprites), waveforms, persistence and synthesized stock audio.
import { uid, waitEvent, clamp, objectUrl, revokeUrl } from './util.js';
import { db } from './db.js';
import { store } from './store.js';
import { SFX } from './presets.js';
import { remote } from './remote.js';
import { toast } from './ui.js';
import { deviceCache } from './devicecache.js';
import { metrics } from './metrics.js';

/** Runtime data per media id (not serialized): { url, img, sprite, spriteN, spriteW, spriteH, poster, peaks, status, error } */
export const mediaRT = new Map();
const listeners = new Set();
export const onMediaChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = (id) => { for (const fn of listeners) fn(id); store.emit('media', id); };

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i;

export function detectType(file) {
  const t = file.type || '';
  if (t.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  if (t.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  if (t.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
  return null;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gambar tidak dapat dibaca'));
    img.src = url;
  });
}

async function probeVideo(url) {
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.src = url;
  const ok = await Promise.race([
    waitEvent(v, 'loadedmetadata', 15000),
    new Promise((r) => v.addEventListener('error', () => r(false), { once: true })),
  ]);
  if (!ok || !v.videoWidth) throw new Error('Format video tidak didukung browser ini');
  return v;
}

async function probeAudio(url) {
  const a = document.createElement('audio');
  a.preload = 'metadata';
  a.src = url;
  const ok = await Promise.race([
    waitEvent(a, 'loadedmetadata', 15000),
    new Promise((r) => a.addEventListener('error', () => r(false), { once: true })),
  ]);
  if (!ok) throw new Error('Format audio tidak didukung');
  return a.duration;
}

/** Can this browser actually decode the video track? (Some decode the audio of an HEVC file but show no picture.) */
async function canPlayVideo(url) {
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.src = url;
  try {
    const ok = await Promise.race([
      waitEvent(v, 'loadeddata', 20000),
      new Promise((r) => v.addEventListener('error', () => r(false), { once: true })),
    ]);
    return !!ok && v.videoWidth > 0;
  } catch {
    return false;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

// ---------------------------------------------------------------------------------------------
// Server renditions (lib/media-proxy.js). For every heavy video the server makes a light 720p copy that the
// preview plays (small to download, cheap to decode and draw, keyframe every 0.5 s so seeks are instant), plus
// the filmstrip, poster and waveform. Files a browser may not decode (iPhone HEVC on many PCs...) also get a
// full-quality H.264 copy, which exports use. The original stays on the server untouched.
//   rt.url        what the preview plays now (a device copy when there is one)
//   rt.src        the copy chosen for the preview (rt.url becomes its device copy once downloaded)
//   rt.local      the original file on the device that imported it, when this browser decodes it
//   rt.exportSrc  the copy exports read (full quality); rt.exportUrl: its device copy, during an export
const watching = new Set();
/** The library entry for a media id; during project load the project is not installed yet, so callers pass it. */
const entryOf = (id, fallback) => store.P?.media?.find((m) => m.id === id) || fallback;
const NO_CONVERTER = 'Video ini (mis. HEVC dari iPhone) tidak bisa diputar di browser ini, dan server belum bisa mengonversinya. Jalankan ulang installer Najja di VPS agar konversi otomatis aktif.';
const busy = (s) => s === 'pending' || s === 'running';

/**
 * Apply the server's state of a media item: thumbnails, waveform, and which copy to play and to export.
 * Resolves once the preview source is set up (a device copy is used straight away when there is one).
 */
async function applyServerState(id, st, { entry, announce = false } = {}) {
  const rt = mediaRT.get(id);
  if (!rt || !st) return;
  rt.server = st;
  const e = entryOf(id, entry);
  if (st.probe && e && e.type === 'video') {
    if (!e.duration && st.probe.duration) e.duration = st.probe.duration;
    if (!e.width && st.probe.width) { e.width = st.probe.width; e.height = st.probe.height; }
    if (st.probe.hasVideo) e.hasAudio = !!st.probe.hasAudio;
  }
  const a = st.assets;
  if (a) {
    const q = `?v=${a.v || 0}`;
    // Server filmstrip replaces the quick one made while importing (it has more frames).
    if (a.sprite && (!rt.sprite || rt.spriteQuick)) Object.assign(rt, { sprite: remote.assetUrl(id, 'sprite', q), spriteN: a.sprite.n, spriteW: a.sprite.w, spriteH: a.sprite.h, spriteQuick: false });
    if (a.poster && !rt.poster) rt.poster = remote.assetUrl(id, 'poster', q);
    if (a.peaks && !rt.peaks && !rt.peaksLoading) {
      rt.peaksLoading = true;
      remote.getPeaks(id).then((p) => { rt.peaks = p; changed(id); }).catch(() => {}).finally(() => { rt.peaksLoading = false; });
    }
  }
  if (e?.type === 'image') { changed(id); return; }

  const ed = st.edit;
  const safe = st.state === 'none' || rt.originalOk;
  const editUrl = ed?.state === 'ready' ? remote.editUrl(id, ed.v) : null;
  const hiUrl = st.state === 'ready' ? remote.proxyUrl(id, st.v) : null;
  const fileUrl = remote.mediaUrl(id);
  const preview = editUrl || rt.local || hiUrl || (safe ? fileUrl : null);
  // Exports read full quality: the H.264 copy of a file browsers may not decode, else the original.
  rt.exportSrc = hiUrl || (st.state === 'none' && rt.local) || (safe ? fileUrl : null) || rt.local || editUrl || preview;
  const waiting = busy(ed?.state) || busy(st.state) || !a;
  if (!preview) {
    const name = e?.name || 'video';
    if (busy(ed?.state) || busy(st.state)) {
      rt.convert = { progress: busy(ed?.state) ? (ed.progress || 0) : (st.progress || 0) };
      if (announce) toast(`"${name}" sedang disiapkan server supaya bisa diputar di perangkat ini. Cukup sekali.`, { timeout: 6000 });
      watchServer(id);
    } else if (st.state === 'unavailable') {
      rt.convert = null;
      rt.playError = NO_CONVERTER;
      toast(`"${name}": ${NO_CONVERTER}`, { type: 'warn', timeout: 12000 });
    } else if (st.state === 'error' || ed?.state === 'error') {
      rt.convert = null;
      rt.playError = st.error || ed?.error || 'Konversi gagal';
      toast(`Konversi "${name}" gagal: ${rt.playError}`, { type: 'error', timeout: 10000 });
    }
    changed(id);
    return;
  }
  if (rt.importAt && editUrl) { metrics.sample('asset_ready_ms', performance.now() - rt.importAt); rt.importAt = null; }
  const wasWaiting = !!rt.convert;
  rt.convert = null;
  rt.playError = null;
  if (rt.status !== 'missing') rt.status = 'ready';
  await setPreview(id, preview);
  if (wasWaiting) toast(`"${e?.name || 'Video'}" siap diputar`, { type: 'ok', timeout: 3500 });
  if (waiting) watchServer(id);
  changed(id);
}

/** Point the preview at `src`; plays a device copy right away, otherwise streams while one is downloaded. */
async function setPreview(id, src) {
  const rt = mediaRT.get(id);
  if (!rt || !src || rt.src === src) return;
  rt.src = src;
  if (src.startsWith('blob:')) { rt.url = src; rt.cacheKey = null; changed(id); return; }
  const key = deviceCache.keyFor(id, src);
  const local = key ? await deviceCache.open(key).catch(() => null) : null;
  if (rt.src !== src) { if (local) revokeUrl(local); return; }
  if (local) { useLocal(id, rt, local, src, key); return; }
  // Keep playing what is already on this device (e.g. the original just imported) until the new copy is here.
  if (!rt.url || !rt.url.startsWith('blob:')) rt.url = src;
  changed(id);
  cacheLocally(id);
}

/** Poll the server while copies or thumbnails are being made. */
async function watchServer(id) {
  if (watching.has(id)) return;
  watching.add(id);
  try {
    for (let i = 0; i < 1800; i++) {
      await new Promise((r) => setTimeout(r, i < 30 ? 1500 : 3000));
      const rt = mediaRT.get(id);
      if (!rt) return;
      let st;
      try { st = await remote.proxyStatus(id); } catch { continue; }
      const before = JSON.stringify([rt.convert, rt.src, rt.exportSrc, !!rt.sprite, !!rt.peaks]);
      if (rt.convert && busy(st.edit?.state || '') && Math.abs((rt.convert.progress || 0) - (st.edit.progress || 0)) > 0.005) { rt.convert = { progress: st.edit.progress || 0 }; changed(id); }
      watching.delete(id); // applyServerState may start a new watch; this one ends either way
      await applyServerState(id, st);
      if (JSON.stringify([rt.convert, rt.src, rt.exportSrc, !!rt.sprite, !!rt.peaks]) !== before && store.P?.media?.some((m) => m.id === id)) store.scheduleSave();
      return;
    }
  } finally {
    watching.delete(id);
  }
}

/** A browser-safe original with no light copy: make sure it really decodes here, else ask for an H.264 copy. */
async function checkPlayable(id, entry) {
  const rt = mediaRT.get(id);
  if (!rt?.url || rt.server?.edit?.state === 'ready') return;
  await cacheLocally(id); // check the device copy (no extra download just to probe)
  if (await canPlayVideo(rt.url)) return;
  try {
    await applyServerState(id, await remote.requestProxy(id, true), { announce: true, entry });
  } catch (err) {
    rt.playError = err.message;
    changed(id);
  }
}

/** The server marked the codec unsafe but has no copy yet: some browsers (Safari + HEVC) play the original anyway. */
async function tryOriginal(id, entry) {
  const rt = mediaRT.get(id);
  if (!rt || rt.src) return;
  if (await canPlayVideo(remote.mediaUrl(id))) {
    rt.originalOk = true;
    await applyServerState(id, rt.server || { state: 'none' }, { entry });
  }
}

// ---------------------------------------------------------------------------------------------
// Device cache: each server copy is downloaded once (one request, in the background) and then played from
// disk. Streaming the same file to several players at once over a home connection is what made video drop out
// mid-way; after the download, playback and export never wait on the network.
const DEVICE_FILE_MAX = 1024 ** 3; // larger files keep streaming
const DEVICE_TOTAL_MAX = 2 * 1024 ** 3;
let deviceBytes = 0;
let cacheChain = Promise.resolve();
const caching = new Map(); // `${id}|${src}` -> promise<blob url | null>

/** Downloads yield to playback: while the preview plays, the player gets the whole connection. */
let cacheGate = () => true;
export function setCacheGate(fn) { cacheGate = fn; }
let forceCache = 0; // > 0 while an export waits for its media
const gateOpen = () => forceCache > 0 || cacheGate();
async function waitGate() { while (!gateOpen()) await new Promise((r) => setTimeout(r, 400)); }

/** Media ids of the open project: never evicted from the device cache to make room. */
const projectIds = () => new Set((store.P?.media || []).map((m) => m.id));

/** Play `id` from a local copy: a disk-backed blob: URL (persistent cache) or an in-memory one. */
function useLocal(id, rt, url, src, key = null) {
  rt.remoteUrl = src;
  rt.cacheKey = key;
  rt.url = url;
  changed(id);
}

/** Download one server copy of a media item to this device (queued, one at a time). Resolves its blob: URL. */
function fetchToDevice(id, src, { onProgress, stillWanted = () => true } = {}) {
  const k = `${id}|${src}`;
  if (caching.has(k)) return caching.get(k);
  const job = cacheChain.then(() => downloadToDevice(id, src, onProgress, stillWanted)).catch(() => null);
  cacheChain = job;
  caching.set(k, job);
  job.finally(() => caching.delete(k));
  return job;
}

/** Download the preview copy to this device, then play from it. Resolves true once it plays locally. */
export async function cacheLocally(id) {
  const rt = mediaRT.get(id);
  if (!remote.enabled || !rt?.url || rt.status === 'missing') return false;
  const src = rt.src || rt.url;
  if (src.startsWith('blob:')) return true;
  if (rt.cacheKey && rt.remoteUrl === src) return true;
  const url = await fetchToDevice(id, src, {
    stillWanted: () => mediaRT.get(id) === rt && (rt.src || src) === src,
    onProgress: (p) => { rt.cache = p == null ? null : { progress: p }; changed(id); },
  });
  if (!url) return false;
  if (mediaRT.get(id) !== rt || (rt.src || src) !== src) { if (url !== rt.exportUrl) revokeUrl(url); return false; }
  useLocal(id, rt, url, src, deviceCache.keyFor(id, src));
  return true;
}

async function downloadToDevice(id, src, onProgress, stillWanted) {
  // Persistent copy on this device (survives refresh and browser restarts), limited to 5 GB.
  const key = deviceCache.keyFor(id, src);
  if (key && await deviceCache.available()) {
    let last = 0;
    try {
      const url = (await deviceCache.open(key)) || await (async () => {
        onProgress?.(0);
        return deviceCache.download(key, {
          id,
          name: entryOf(id)?.name || '',
          fetchFrom: (off) => fetch(src, { credentials: 'same-origin', headers: off ? { Range: `bytes=${off}-` } : {} }),
          shouldPause: () => !gateOpen(),
          waitResume: waitGate,
          stillWanted,
          protect: projectIds(),
          onProgress: (p) => { if (performance.now() - last > 400) { last = performance.now(); onProgress?.(p); } },
        });
      })();
      onProgress?.(null);
      if (url) {
        if (!stillWanted()) { revokeUrl(url); return null; }
        return url;
      }
    } catch { /* fall through to the in-memory copy */ }
    onProgress?.(null);
    if (!stillWanted()) return null;
  }
  return downloadToMemory(src, onProgress, stillWanted);
}

/** Fallback when the browser has no persistent storage (or no room): keep a copy in memory for this tab. */
async function downloadToMemory(src, onProgress, stillWanted) {
  const parts = [];
  let got = 0;
  let total = 0;
  let type = '';
  let last = 0;
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      await waitGate();
      if (!stillWanted()) return null;
      let r;
      try {
        r = await fetch(src, { credentials: 'same-origin', headers: got ? { Range: `bytes=${got}-` } : {} });
      } catch {
        await new Promise((res) => setTimeout(res, 2000));
        continue;
      }
      if (!r.ok || !r.body) return null;
      if (got && r.status !== 206) { parts.length = 0; got = 0; } // no range support: start over
      if (!total) {
        total = Number((r.headers.get('content-range') || '').split('/')[1]) || Number(r.headers.get('content-length')) || 0;
        type = r.headers.get('content-type') || '';
        if (total > DEVICE_FILE_MAX || deviceBytes + total > DEVICE_TOTAL_MAX) { r.body.cancel().catch(() => {}); return null; }
        onProgress?.(0);
      }
      const reader = r.body.getReader();
      let paused = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          got += value.length;
          if (!stillWanted()) { reader.cancel().catch(() => {}); return null; }
          if (total && performance.now() - last > 400) { last = performance.now(); onProgress?.(got / total); }
          if (!gateOpen()) { paused = true; reader.cancel().catch(() => {}); break; } // resume later from `got`
        }
      } catch {
        paused = true; // connection dropped: retry from where it stopped
      }
      if (!paused && (!total || got >= total)) break;
    }
  } finally {
    onProgress?.(null);
  }
  if (!stillWanted() || (total && got !== total)) return null;
  const blob = new Blob(parts, { type });
  deviceBytes += blob.size;
  return objectUrl(blob);
}

/** Remove every copy kept on this device; media in use goes back to streaming from the server. */
export async function clearDeviceCache() {
  for (const [id, rt] of mediaRT) {
    if (rt.cacheKey && rt.remoteUrl) {
      const local = rt.url;
      rt.url = rt.remoteUrl;
      rt.cacheKey = null;
      changed(id);
      setTimeout(() => revokeUrl(local), 2000);
    }
    if (rt.exportUrl && rt.exportUrl !== rt.local && rt.exportUrl !== rt.url) revokeUrl(rt.exportUrl);
    rt.exportUrl = null;
  }
  await deviceCache.clear();
}

/**
 * Before an export: every audio/video file used in the project at full quality on this device, so rendering
 * never waits on the network. Sets rt.exportUrl (falls back to the preview copy when that is all there is).
 */
export async function cacheProjectMedia(P, onProgress = () => {}) {
  const ids = [...new Set(P.clips.filter((c) => c.type === 'video' || c.type === 'audio').map((c) => c.mediaId))].filter((id) => mediaRT.get(id));
  forceCache++;
  try {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const rt = mediaRT.get(id);
      // The full-quality copy of a file browsers cannot read is still being made: wait for it rather than
      // export from the light preview copy.
      for (let k = 0; remote.enabled && rt.server && busy(rt.server.state) && k < 3600; k++) {
        onProgress((i + (rt.server.progress || 0)) / ids.length, 'quality');
        await new Promise((r) => setTimeout(r, 2000));
        try { await applyServerState(id, await remote.proxyStatus(id)); } catch { /* retry */ }
      }
      const src = rt.exportSrc || rt.src || rt.url;
      if (!src) continue;
      if (src.startsWith('blob:')) { rt.exportUrl = src; continue; }
      if (src === (rt.src || rt.url) && await cacheLocally(id)) { rt.exportUrl = rt.url; continue; }
      if (!remote.enabled || rt.convert) continue;
      const url = await fetchToDevice(id, src, { onProgress: (p) => { if (p != null) onProgress((i + p) / ids.length); } });
      rt.exportUrl = url || null;
      onProgress((i + 1) / ids.length);
    }
  } finally {
    forceCache--;
  }
  onProgress(1);
}

async function seekTo(v, t) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return;
  v.currentTime = t;
  await waitEvent(v, 'seeked', 4000);
}

/** Filmstrip from a video element (n frames; each one a seek). */
async function makeSprite(v, duration, maxFrames = 48) {
  const N = clamp(Math.ceil(duration / 1.5), 4, maxFrames);
  const h = 72;
  const w = Math.max(24, Math.round((v.videoWidth / v.videoHeight) * h));
  const c = document.createElement('canvas');
  c.width = w * N;
  c.height = h;
  const ctx = c.getContext('2d');
  for (let i = 0; i < N; i++) {
    await seekTo(v, Math.min(duration - 0.05, ((i + 0.5) * duration) / N));
    try { ctx.drawImage(v, i * w, 0, w, h); } catch { /* ignore */ }
  }
  return { sprite: c.toDataURL('image/jpeg', 0.72), spriteN: N, spriteW: w, spriteH: h };
}
/** Library thumbnail: one frame near the start. */
async function makePoster(v, duration) {
  await seekTo(v, Math.min(duration * 0.1, 1));
  const poster = document.createElement('canvas');
  const pw = 320;
  poster.width = pw;
  poster.height = Math.max(1, Math.round((pw * v.videoHeight) / v.videoWidth));
  try { poster.getContext('2d').drawImage(v, 0, 0, poster.width, poster.height); } catch { /* ignore */ }
  return poster.toDataURL('image/jpeg', 0.8);
}

function imagePoster(img) {
  const c = document.createElement('canvas');
  const pw = 320;
  c.width = pw;
  c.height = Math.max(1, Math.round((pw * img.naturalHeight) / img.naturalWidth));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

let decodeCtx = null;
/** Waveform by decoding the whole file in the browser: only for small files (the server does it otherwise). */
async function computePeaks(blob, limit = 150 * 1024 * 1024) {
  if (blob.size > limit) return null;
  try {
    decodeCtx = decodeCtx || new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
    const buf = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
    const rate = 100; // peaks per second
    const n = Math.max(1, Math.ceil(buf.duration * rate));
    const peaks = new Float32Array(n);
    const chans = [];
    for (let ch = 0; ch < Math.min(2, buf.numberOfChannels); ch++) chans.push(buf.getChannelData(ch));
    const step = buf.sampleRate / rate;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const s0 = Math.floor(i * step);
      const s1 = Math.min(buf.length, Math.floor((i + 1) * step));
      let m = 0;
      for (const d of chans) for (let s = s0; s < s1; s += 4) { const v = Math.abs(d[s]); if (v > m) m = v; }
      peaks[i] = m;
      if (m > max) max = m;
    }
    if (max > 0) for (let i = 0; i < n; i++) peaks[i] = Math.min(1, peaks[i] / max);
    return peaks;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Import. The clip is usable as soon as the browser has read the file's header: upload, thumbnails, waveform
// and the server's light copy all happen in the background.
const metaOf = (entry, rt, { sprite = true } = {}) => ({
  entry,
  ...(sprite && rt.sprite && !rt.spriteQuick ? { sprite: rt.sprite, spriteN: rt.spriteN, spriteW: rt.spriteW, spriteH: rt.spriteH } : {}),
  poster: rt.poster && rt.poster.startsWith('data:') ? rt.poster : undefined,
  hasPeaks: !!rt.peaks,
});

/** Save a freshly imported media item: to the VPS (server mode) or this browser (IndexedDB). */
async function persistMedia(entry, file, rt, { adoptFrom } = {}) {
  if (!remote.enabled) {
    await rt.ready; // thumbnails and waveform are stored with the file
    await db.putMedia({ id: entry.id, blob: file, meta: entry, sprite: rt.sprite, spriteN: rt.spriteN, spriteW: rt.spriteW, spriteH: rt.spriteH, poster: rt.poster, peaks: rt.peaks || null });
    return;
  }
  rt.upload = { state: 'uploading', progress: 0 };
  changed(entry.id);
  let last = 0;
  try {
    const upAt = performance.now();
    if (adoptFrom) await remote.adopt(entry.id, adoptFrom, file.name, file.type);
    else {
      await remote.upload(file, {
        target: 'media', mediaId: entry.id, filename: file.name, mime: file.type,
        onProgress: (p) => {
          rt.upload.progress = p;
          if (performance.now() - last > 200) { last = performance.now(); changed(entry.id); }
        },
      });
    }
    if (!adoptFrom) {
      const ms = performance.now() - upAt;
      metrics.sample('upload_ms', ms);
      if (file.size > 1e6) metrics.sample('upload_mbps', (file.size * 8) / 1e6 / (ms / 1000));
    }
    // The server makes the filmstrip and waveform of videos from its light copy; audio/image keep the browser's.
    await remote.putMeta(entry.id, metaOf(entry, rt, { sprite: entry.type !== 'video' }));
    if (rt.peaks && entry.type === 'audio') await remote.putPeaks(entry.id, rt.peaks);
    rt.upload = null;
    rt.uploaded = true;
    changed(entry.id);
    store.scheduleSave();
    if (entry.type !== 'image') applyServerState(entry.id, await remote.proxyStatus(entry.id), { entry });
  } catch (err) {
    rt.upload = { state: 'error', error: err.message, retry: () => persistMedia(entry, file, rt, { adoptFrom }) };
    changed(entry.id);
    toast(`Upload "${entry.name}" ke server gagal: ${err.message}`, { type: 'error', timeout: 8000, action: { label: 'Coba lagi', run: () => rt.upload.retry() } });
  }
}
export const uploadsPending = () => [...mediaRT.values()].some((rt) => rt.upload?.state === 'uploading');

/** Import a video this browser cannot decode: store the original on the server, which makes copies that play. */
async function importViaServer(file, entry, rt, { silent, adoptFrom }) {
  const id = entry.id;
  store.P.media.push(entry);
  rt.upload = { state: 'uploading', progress: 0 };
  rt.local = null;
  rt.url = null;
  rt.src = null;
  rt.exportSrc = null;
  changed(id);
  let last = 0;
  try {
    if (adoptFrom) await remote.adopt(id, adoptFrom, file.name, file.type);
    else {
      await remote.upload(file, {
        target: 'media', mediaId: id, filename: file.name, mime: file.type,
        onProgress: (p) => {
          rt.upload.progress = p;
          if (performance.now() - last > 200) { last = performance.now(); changed(id); }
        },
      });
    }
    rt.upload = null;
    const st = await remote.requestProxy(id, true);
    if (st.state === 'unavailable') throw new Error(NO_CONVERTER);
    if (st.state === 'error' && st.edit?.state !== 'ready') throw new Error(`Konversi gagal: ${st.error || 'tidak diketahui'}`);
    const p = st.probe || {};
    if (!p.hasVideo) throw new Error('File ini tidak berisi video');
    entry.duration = p.duration || 0;
    entry.width = p.width || 0;
    entry.height = p.height || 0;
    entry.hasAudio = !!p.hasAudio;
    await remote.putMeta(id, { entry });
    rt.uploaded = true;
    await applyServerState(id, st, { announce: true, entry });
    changed(id);
    if (!silent) store.scheduleSave();
    return entry;
  } catch (err) {
    mediaRT.delete(id);
    const idx = store.P.media.findIndex((m) => m.id === id);
    if (idx >= 0) store.P.media.splice(idx, 1);
    changed(id);
    remote.deleteMedia(id, store.P.id).catch(() => {});
    throw err;
  }
}

/** Import a File/Blob into the project's media library. Returns the media entry as soon as it can be used. */
export async function importFile(file, { name, silent = false, adoptFrom } = {}) {
  const type = detectType(file);
  if (!type) throw new Error(`Jenis file tidak didukung: ${file.name || file.type}`);
  const id = uid('m');
  const importAt = performance.now();
  const url = objectUrl(file);
  const entry = { id, name: name || file.name || `${type}-${id}`, type, duration: 0, width: 0, height: 0, size: file.size, hasAudio: type !== 'image', createdAt: Date.now() };
  const rt = { url, src: url, local: url, exportSrc: url, status: 'processing', importAt: remote.enabled && type === 'video' ? importAt : null };
  mediaRT.set(id, rt);
  try {
    if (type === 'video') {
      let v;
      try {
        v = await probeVideo(url);
      } catch (err) {
        revokeUrl(url);
        if (!remote.enabled) throw err;
        return await importViaServer(file, entry, rt, { silent, adoptFrom });
      }
      entry.duration = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
      entry.width = v.videoWidth;
      entry.height = v.videoHeight;
      store.P.media.push(entry);
      rt.status = 'ready';
      // Background: library thumbnail, then a filmstrip (a quick one when the server will make the full one).
      rt.ready = (async () => {
        try {
          rt.poster = await makePoster(v, entry.duration);
          changed(id);
          if (!rt.sprite || rt.spriteQuick) {
            const s = await makeSprite(v, entry.duration, remote.enabled ? 16 : 48);
            if (!rt.sprite || rt.spriteQuick) Object.assign(rt, s, { spriteQuick: remote.enabled });
          }
          if (!remote.enabled) { rt.peaks = await computePeaks(file); entry.hasAudio = !!rt.peaks; }
        } catch { /* thumbnails are optional */ } finally {
          v.removeAttribute('src');
          v.load();
          changed(id);
          if (remote.enabled && rt.uploaded) remote.putMeta(id, metaOf(entry, rt, { sprite: false })).catch(() => {});
        }
      })();
    } else if (type === 'image') {
      const img = await loadImage(url);
      entry.width = img.naturalWidth;
      entry.height = img.naturalHeight;
      rt.img = img;
      rt.poster = imagePoster(img);
      store.P.media.push(entry);
      rt.status = 'ready';
      rt.ready = Promise.resolve();
    } else {
      entry.duration = await probeAudio(url);
      store.P.media.push(entry);
      rt.status = 'ready';
      rt.ready = computePeaks(file, 60 * 1024 * 1024).then((p) => { rt.peaks = p; changed(id); });
    }
  } catch (err) {
    mediaRT.delete(id);
    revokeUrl(url);
    const idx = store.P.media.findIndex((m) => m.id === id);
    if (idx >= 0) store.P.media.splice(idx, 1);
    changed(id);
    throw err;
  }
  changed(id);
  // time until the media can be put on the timeline (local metadata only: no upload, no server)
  metrics.afterPaint('import_visible_ms', importAt);
  metrics.count(`import_${type}`);
  (type === 'audio' ? rt.ready.catch(() => {}) : Promise.resolve()).then(() => persistMedia(entry, file, rt, { adoptFrom }));
  if (!silent) store.scheduleSave();
  return entry;
}

/** Restore runtime data for the media of a project (server: copies, thumbnails; browser: IndexedDB). */
export async function restoreMedia(P) {
  const missing = [];
  if (remote.enabled) {
    await Promise.all(P.media.map(async (m) => {
      if (mediaRT.has(m.id)) return;
      try {
        const meta = await remote.getMeta(m.id);
        if (!meta.file) throw new Error('upload belum selesai');
        const rt = { url: null, src: null, status: 'ready', sprite: meta.sprite, spriteN: meta.spriteN, spriteW: meta.spriteW, spriteH: meta.spriteH, poster: meta.poster, peaks: null, uploaded: true };
        mediaRT.set(m.id, rt);
        const peaks = meta.hasPeaks ? remote.getPeaks(m.id).then((p) => { rt.peaks = p; }).catch(() => {}) : null;
        if (m.type === 'image') {
          rt.img = await loadImage(remote.mediaUrl(m.id)).catch(() => { rt.status = 'error'; return null; });
        } else {
          const st = meta.proxy || { state: 'none' };
          await applyServerState(m.id, st, { entry: m, announce: busy(st.state) || busy(st.edit?.state) });
          if (!rt.src && m.type === 'video' && !rt.convert) tryOriginal(m.id, m);
          else if (m.type === 'video' && st.state === 'none' && st.edit?.state !== 'ready' && rt.src) checkPlayable(m.id, m);
        }
        await peaks;
      } catch {
        missing.push(m.id);
        mediaRT.set(m.id, { status: 'missing' });
      }
    }));
    changed(null);
    return missing;
  }
  await Promise.all(P.media.map(async (m) => {
    if (mediaRT.has(m.id)) return;
    const rec = await db.getMedia(m.id);
    if (!rec || !rec.blob) { missing.push(m.id); return; }
    const url = objectUrl(rec.blob);
    const rt = { url, src: url, local: url, exportSrc: url, status: 'ready', sprite: rec.sprite, spriteN: rec.spriteN, spriteW: rec.spriteW, spriteH: rec.spriteH, poster: rec.poster, peaks: rec.peaks || null };
    if (m.type === 'image') {
      try { rt.img = await loadImage(url); } catch { rt.status = 'error'; }
    }
    mediaRT.set(m.id, rt);
  }));
  for (const id of missing) mediaRT.set(id, { status: 'missing' });
  changed(null);
  return missing;
}

export async function removeMedia(id) {
  const P = store.P;
  const used = P.clips.some((c) => c.mediaId === id);
  if (used) {
    store.mutate('Hapus media', (p) => { p.clips = p.clips.filter((c) => c.mediaId !== id); });
  }
  const idx = P.media.findIndex((m) => m.id === id);
  if (idx >= 0) P.media.splice(idx, 1);
  const rt = mediaRT.get(id);
  if (rt?.url) setTimeout(() => revokeUrl(rt.url), 2000);
  mediaRT.delete(id);
  if (remote.enabled) {
    // the server keeps it if another project still uses it; then the device copy stays too
    remote.deleteMedia(id, P.id).then((r) => { if (!r?.kept) deviceCache.removeMedia(id); }).catch(() => {});
  } else {
    // Keep the blob if another saved project still references it.
    const projects = await db.listProjects();
    if (!projects.some((p) => p.id !== P.id && p.media?.some((m) => m.id === id))) db.deleteMedia(id);
  }
  changed(id);
  store.touch('media');
}

export async function importFromServerUrl(serverUrl, name, mime) {
  const r = await fetch(serverUrl);
  if (!r.ok) throw new Error(`Gagal mengambil media (${r.status})`);
  const blob = await r.blob();
  const file = new File([blob], name || decodeURIComponent(serverUrl.split('/').pop()), { type: mime || blob.type });
  return importFile(file, { adoptFrom: serverUrl }); // the server already has the file: no re-upload
}

// ---------------------------------------------------------------------------------------------
// Synthesized stock audio (no external assets needed)
function noiseBuffer(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  let seed = 1234567;
  for (let i = 0; i < d.length; i++) {
    seed = (seed * 16807) % 2147483647;
    d[i] = (seed / 2147483647) * 2 - 1;
  }
  return b;
}
function env(g, t, a, peak, d, end = 0.0001) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(end, t + a + d);
}
function tone(ctx, out, { type = 'sine', f0, f1, t, a = 0.005, d = 0.3, peak = 0.5, detune = 0 }) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.detune.value = detune;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + a + d);
  env(g, t, a, peak, d);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + a + d + 0.05);
}
function noise(ctx, out, nb, { t, a = 0.002, d = 0.1, peak = 0.4, type = 'highpass', f = 6000, q = 0.7, f1 }) {
  const s = ctx.createBufferSource();
  s.buffer = nb;
  const flt = ctx.createBiquadFilter();
  flt.type = type;
  flt.frequency.setValueAtTime(f, t);
  if (f1) flt.frequency.exponentialRampToValueAtTime(f1, t + a + d);
  flt.Q.value = q;
  const g = ctx.createGain();
  env(g, t, a, peak, d);
  s.connect(flt).connect(g).connect(out);
  s.start(t, (t * 0.37) % 1);
  s.stop(t + a + d + 0.05);
}
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function buildSfx(id, ctx, out, nb, dur) {
  switch (id) {
    case 'whoosh': noise(ctx, out, nb, { t: 0, a: 0.35, d: 0.5, peak: 0.8, type: 'bandpass', f: 300, f1: 4000, q: 1.2 }); break;
    case 'swipe': noise(ctx, out, nb, { t: 0, a: 0.06, d: 0.25, peak: 0.7, type: 'bandpass', f: 1200, f1: 6000, q: 2 }); break;
    case 'pop': tone(ctx, out, { f0: 900, f1: 180, t: 0, a: 0.004, d: 0.14, peak: 0.9 }); break;
    case 'click': noise(ctx, out, nb, { t: 0, a: 0.001, d: 0.04, peak: 0.8, type: 'highpass', f: 3000 }); tone(ctx, out, { f0: 2200, t: 0, d: 0.03, peak: 0.25 }); break;
    case 'ding':
      tone(ctx, out, { f0: 1318.5, t: 0, a: 0.004, d: 1.3, peak: 0.5 });
      tone(ctx, out, { f0: 2637, t: 0, a: 0.004, d: 0.8, peak: 0.18 });
      tone(ctx, out, { f0: 3951, t: 0, a: 0.004, d: 0.4, peak: 0.08 });
      break;
    case 'notif':
      tone(ctx, out, { f0: 880, t: 0, a: 0.005, d: 0.25, peak: 0.45 });
      tone(ctx, out, { f0: 1318.5, t: 0.14, a: 0.005, d: 0.5, peak: 0.45 });
      break;
    case 'riser':
      tone(ctx, out, { type: 'sawtooth', f0: 110, f1: 1760, t: 0, a: 2.0, d: 0.15, peak: 0.16 });
      noise(ctx, out, nb, { t: 0, a: 2.0, d: 0.15, peak: 0.5, type: 'bandpass', f: 400, f1: 8000, q: 1.5 });
      break;
    case 'impact':
      tone(ctx, out, { f0: 110, f1: 32, t: 0, a: 0.005, d: 1.6, peak: 1 });
      noise(ctx, out, nb, { t: 0, a: 0.003, d: 0.9, peak: 0.6, type: 'lowpass', f: 1800, f1: 120 });
      break;
    case 'lofi': {
      const bpm = 85, beat = 60 / bpm;
      const chords = [[65, 69, 72, 76], [64, 67, 71, 74], [62, 65, 69, 72], [60, 64, 67, 71]];
      const bars = Math.round(dur / (beat * 4));
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.connect(out);
      for (let bar = 0; bar < bars; bar++) {
        const t0 = bar * beat * 4;
        const ch = chords[bar % 4];
        for (const n of ch) tone(ctx, lp, { type: 'triangle', f0: midi(n - 12), t: t0, a: 0.05, d: beat * 3.8, peak: 0.07 });
        tone(ctx, lp, { type: 'sine', f0: midi(ch[0] - 24), t: t0, a: 0.01, d: beat * 1.8, peak: 0.28 });
        tone(ctx, lp, { type: 'sine', f0: midi(ch[0] - 24), t: t0 + beat * 2, a: 0.01, d: beat * 1.8, peak: 0.24 });
        for (const k of [0, 1.5, 2]) tone(ctx, out, { f0: 140, f1: 45, t: t0 + k * beat, a: 0.002, d: 0.25, peak: 0.7 });
        for (const k of [1, 3]) noise(ctx, out, nb, { t: t0 + k * beat, d: 0.18, peak: 0.28, type: 'bandpass', f: 1800, q: 0.8 });
        for (let h = 0; h < 8; h++) noise(ctx, out, nb, { t: t0 + h * beat / 2 + (h % 2 ? 0.03 : 0), d: 0.04, peak: h % 2 ? 0.06 : 0.1 });
      }
      break;
    }
    case 'upbeat': {
      const bpm = 120, beat = 60 / bpm;
      const bassline = [45, 45, 52, 45, 41, 41, 48, 41, 43, 43, 50, 43, 40, 40, 47, 52];
      const prog = [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]];
      const bars = Math.round(dur / (beat * 4));
      for (let bar = 0; bar < bars; bar++) {
        const t0 = bar * beat * 4;
        for (let k = 0; k < 4; k++) {
          tone(ctx, out, { f0: 150, f1: 48, t: t0 + k * beat, a: 0.002, d: 0.22, peak: 0.8 });
          noise(ctx, out, nb, { t: t0 + k * beat + beat / 2, d: 0.05, peak: 0.12 });
        }
        for (const k of [1, 3]) noise(ctx, out, nb, { t: t0 + k * beat, d: 0.14, peak: 0.32, type: 'bandpass', f: 1500, q: 0.6 });
        for (let s = 0; s < 4; s++) tone(ctx, out, { type: 'sawtooth', f0: midi(bassline[(bar % 4) * 4 + s]), t: t0 + s * beat, a: 0.01, d: beat * 0.8, peak: 0.11 });
        const ch = prog[bar % 4];
        for (let s = 0; s < 8; s++) tone(ctx, out, { type: 'square', f0: midi(ch[s % 3] + 12), t: t0 + s * beat / 2, a: 0.005, d: beat * 0.35, peak: 0.035 });
      }
      break;
    }
    case 'ambient': {
      const chords = [[57, 64, 69, 72], [53, 60, 65, 69], [60, 64, 67, 71], [55, 62, 67, 71]];
      const len = dur / 4;
      for (let i = 0; i < 4; i++) {
        for (const n of chords[i]) {
          for (const det of [-7, 7]) {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine';
            o.frequency.value = midi(n);
            o.detune.value = det;
            const t = i * len;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(0.045, t + len * 0.45);
            g.gain.linearRampToValueAtTime(0.0001, t + len * 1.15);
            o.connect(g).connect(out);
            o.start(t);
            o.stop(Math.min(dur, t + len * 1.2));
          }
        }
      }
      break;
    }
    default: break;
  }
}

function encodeWav(buf) {
  const ch = buf.numberOfChannels;
  const len = buf.length * ch * 2 + 44;
  const ab = new ArrayBuffer(len);
  const v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, len - 8, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, len - 44, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < buf.length; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

const sfxCache = new Map();
export async function synthAudio(id) {
  if (sfxCache.has(id)) return sfxCache.get(id);
  const def = SFX.find((s) => s.id === id);
  if (!def) throw new Error(`Audio tidak dikenal: ${id}`);
  const rate = 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(rate * def.dur), rate);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);
  const nb = noiseBuffer(ctx, 2.5);
  buildSfx(id, ctx, master, nb, def.dur);
  const buf = await ctx.startRendering();
  const blob = encodeWav(buf);
  sfxCache.set(id, blob);
  return blob;
}

/** Find a library entry created from a stock sound, or import it. */
export async function ensureStockAudio(id) {
  const def = SFX.find((s) => s.id === id);
  const existing = store.P.media.find((m) => m.stock === id && mediaRT.get(m.id)?.status === 'ready');
  if (existing) return existing;
  const blob = await synthAudio(id);
  const entry = await importFile(new File([blob], `${def.name}.wav`, { type: 'audio/wav' }), { name: def.name });
  entry.stock = id;
  return entry;
}

/** Capture the current preview frame of a clip as an image media (freeze frame). */
export async function importCanvasAsImage(canvas, name) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return importFile(new File([blob], `${name}.png`, { type: 'image/png' }), { name });
}
