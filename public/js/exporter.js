// Real-time export: render the timeline into an offscreen canvas and record it (video + mixed audio) with MediaRecorder.
import { store } from './store.js';
import { RESOLUTIONS } from './presets.js';
import { preloadFonts } from './render.js';

const MP4_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
const WEBM_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function supportedFormats() {
  const ok = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t);
  return { mp4: MP4_TYPES.find(ok) || null, webm: WEBM_TYPES.find(ok) || null };
}

export function exportSize(P, resolution) {
  const short = RESOLUTIONS[resolution] || 1080;
  const k = short / Math.min(P.width, P.height);
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(P.width * k), height: even(P.height * k) };
}

// MediaRecorder writes WebM without a Duration header (players can't seek / show length).
// Insert/patch Segment > Info > Duration (EBML) so the file is a normal, seekable WebM.
export async function fixWebmDuration(blob, durationMs) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const vlen = (b) => { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 0; };
  const readId = (p) => { const l = vlen(buf[p]); let v = 0; for (let i = 0; i < l; i++) v = v * 256 + buf[p + i]; return { id: v, len: l }; };
  const readSize = (p) => {
    const l = vlen(buf[p]);
    let v = buf[p] & (0xff >> l);
    let unknown = v === (0xff >> l);
    for (let i = 1; i < l; i++) { v = v * 256 + buf[p + i]; if (buf[p + i] !== 0xff) unknown = false; }
    return { size: v, len: l, unknown };
  };
  const writeSize = (p, len, value) => {
    for (let i = len - 1; i >= 0; i--) { buf[p + i] = value % 256; value = Math.floor(value / 256); }
    buf[p] |= 0x80 >> (len - 1);
  };
  try {
    let p = 0;
    const ebml = readId(p);
    if (ebml.id !== 0x1a45dfa3) return blob;
    const es = readSize(p + ebml.len);
    p += ebml.len + es.len + es.size;
    const seg = readId(p);
    if (seg.id !== 0x18538067) return blob;
    const segSizePos = p + seg.len;
    const ss = readSize(segSizePos);
    p = segSizePos + ss.len;
    const end = Math.min(buf.length, p + 4096);
    while (p < end) {
      const el = readId(p);
      const sz = readSize(p + el.len);
      const body = p + el.len + sz.len;
      if (el.id === 0x1549a966) {
        let q = body;
        let scale = 1e6;
        while (q < body + sz.size) {
          const c = readId(q);
          const cs = readSize(q + c.len);
          const cb = q + c.len + cs.len;
          if (c.id === 0x2ad7b1) { scale = 0; for (let i = 0; i < cs.size; i++) scale = scale * 256 + buf[cb + i]; }
          if (c.id === 0x4489) {
            const dv = new DataView(buf.buffer, cb, cs.size);
            if (cs.size === 8) dv.setFloat64(0, (durationMs * 1e6) / scale); else dv.setFloat32(0, (durationMs * 1e6) / scale);
            return new Blob([buf], { type: blob.type });
          }
          q = cb + cs.size;
        }
        const newSize = sz.size + 11;
        if (newSize >= 2 ** (7 * sz.len) - 1) return blob;
        const dur = new Uint8Array(11);
        dur.set([0x44, 0x89, 0x88]);
        new DataView(dur.buffer).setFloat64(3, (durationMs * 1e6) / scale);
        const insertAt = body + sz.size;
        writeSize(p + el.len, sz.len, newSize);
        if (!ss.unknown) writeSize(segSizePos, ss.len, ss.size + 11);
        return new Blob([buf.subarray(0, insertAt), dur, buf.subarray(insertAt)], { type: blob.type });
      }
      if (sz.unknown) break;
      p = body + sz.size;
    }
  } catch { /* leave the file untouched */ }
  return blob;
}

export const exportState = { state: 'idle', progress: 0, error: null, result: null, startedAt: 0, options: null };

let cancelFlag = null;
export function cancelExport() { if (cancelFlag) cancelFlag.cancelled = true; }

/**
 * opts: { resolution, fps, format: 'mp4'|'webm', quality: 'low'|'recommended'|'high', filename, range?: [start,end] }
 * onProgress(p 0..1)
 */
export async function exportVideo(engine, opts, onProgress = () => {}) {
  if (exportState.state === 'running') throw new Error('Ekspor lain sedang berjalan');
  const P = store.P;
  const duration = store.duration();
  if (duration <= 0) throw new Error('Timeline masih kosong');
  const fmts = supportedFormats();
  const format = opts.format === 'webm' ? 'webm' : (fmts.mp4 ? 'mp4' : 'webm');
  const mimeType = format === 'mp4' ? fmts.mp4 : fmts.webm;
  if (!mimeType) throw new Error('Browser ini tidak mendukung perekaman video (MediaRecorder). Gunakan Chrome/Edge terbaru.');
  const fps = Number(opts.fps) || P.fps || 30;
  const { width, height } = exportSize(P, opts.resolution || '1080p');
  const bpp = { low: 0.06, recommended: 0.1, high: 0.16 }[opts.quality || 'recommended'] || 0.1;
  const videoBitsPerSecond = Math.round(Math.min(60e6, Math.max(1.5e6, width * height * fps * bpp)));
  const [r0, r1] = opts.range || [0, duration];

  Object.assign(exportState, { state: 'running', progress: 0, error: null, result: null, startedAt: Date.now(), options: { ...opts, format, fps, width, height } });
  const flag = { cancelled: false };
  cancelFlag = flag;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const vStream = canvas.captureStream(0);
  const vTrack = vStream.getVideoTracks()[0];
  const ac = engine.ensureAudio();
  const tracks = [vTrack];
  let dest = null;
  if (ac) {
    dest = ac.createMediaStreamDestination();
    engine.master.connect(dest);
    tracks.push(...dest.stream.getAudioTracks());
    engine.monitor.gain.value = 0; // silent while exporting
  }
  const stream = new MediaStream(tracks);
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond, audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });

  const wasLoop = engine.loop;
  engine.loop = false;
  engine.pause();
  engine.seek(r0);
  await preloadFonts(P);
  await engine.settle(6000);

  try {
    await new Promise((resolve, reject) => {
      engine.exportTarget = {
        canvas, ctx, fps, track: vTrack, lastT: -1,
        onFrame: (t) => {
          const p = Math.min(1, (t - r0) / Math.max(0.001, r1 - r0));
          exportState.progress = p;
          onProgress(p);
          if (flag.cancelled) { engine.pause(); reject(new Error('Ekspor dibatalkan')); }
          else if (t >= r1 - 0.0005) { engine.pause(); resolve(); }
        },
      };
      const off = engine.on((kind) => {
        if (kind === 'ended') { off(); resolve(); }
      });
      rec.start(250);
      engine.play();
    });
    // flush the final frame
    vTrack.requestFrame?.();
    await new Promise((r) => setTimeout(r, 150));
    rec.stop();
    await stopped;
  } catch (err) {
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    Object.assign(exportState, { state: flag.cancelled ? 'cancelled' : 'error', error: err.message });
    throw err;
  } finally {
    engine.exportTarget = null;
    engine.loop = wasLoop;
    if (dest) { try { engine.master.disconnect(dest); } catch { /* ignore */ } }
    if (engine.monitor) engine.monitor.gain.value = 1;
    vTrack.stop();
    cancelFlag = null;
  }

  let blob = new Blob(chunks, { type: mimeType.split(';')[0] });
  if (format === 'webm') blob = await fixWebmDuration(blob, (r1 - r0) * 1000);
  const ext = format === 'mp4' ? 'mp4' : 'webm';
  const base = (opts.filename || P.name || 'najja-video').replace(/[\\/:*?"<>|]+/g, '').trim() || 'najja-video';
  const result = { blob, mime: blob.type, ext, filename: `${base}.${ext}`, width, height, fps, size: blob.size, duration: r1 - r0 };
  Object.assign(exportState, { state: 'done', progress: 1, result: { ...result, blob: undefined } });
  onProgress(1);
  return result;
}
