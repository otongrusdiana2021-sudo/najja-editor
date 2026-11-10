// Media import, thumbnails (filmstrip sprites), waveforms, persistence and synthesized stock audio.
import { uid, waitEvent, clamp } from './util.js';
import { db } from './db.js';
import { store } from './store.js';
import { SFX } from './presets.js';

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

async function seekTo(v, t) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return;
  v.currentTime = t;
  await waitEvent(v, 'seeked', 4000);
}

async function makeSprite(v, duration) {
  const N = clamp(Math.ceil(duration / 1.5), 4, 48);
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
  const poster = document.createElement('canvas');
  const pw = 320;
  poster.width = pw;
  poster.height = Math.round((pw * v.videoHeight) / v.videoWidth);
  await seekTo(v, Math.min(duration * 0.1, 1));
  try { poster.getContext('2d').drawImage(v, 0, 0, poster.width, poster.height); } catch { /* ignore */ }
  return { sprite: c.toDataURL('image/jpeg', 0.72), spriteN: N, spriteW: w, spriteH: h, poster: poster.toDataURL('image/jpeg', 0.8) };
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
async function computePeaks(blob) {
  if (blob.size > 400 * 1024 * 1024) return null;
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

/** Import a File/Blob into the project's media library. Returns the media entry. */
export async function importFile(file, { name, silent = false } = {}) {
  const type = detectType(file);
  if (!type) throw new Error(`Jenis file tidak didukung: ${file.name || file.type}`);
  const id = uid('m');
  const url = URL.createObjectURL(file);
  const entry = { id, name: name || file.name || `${type}-${id}`, type, duration: 0, width: 0, height: 0, size: file.size, hasAudio: type !== 'image', createdAt: Date.now() };
  const rt = { url, status: 'processing' };
  mediaRT.set(id, rt);
  try {
    if (type === 'video') {
      const v = await probeVideo(url);
      entry.duration = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
      entry.width = v.videoWidth;
      entry.height = v.videoHeight;
      store.P.media.push(entry);
      changed(id);
      Object.assign(rt, await makeSprite(v, entry.duration));
      v.removeAttribute('src');
      v.load();
      rt.peaks = await computePeaks(file);
      entry.hasAudio = !!rt.peaks;
    } else if (type === 'image') {
      const img = await loadImage(url);
      entry.width = img.naturalWidth;
      entry.height = img.naturalHeight;
      rt.img = img;
      rt.poster = imagePoster(img);
      store.P.media.push(entry);
    } else {
      entry.duration = await probeAudio(url);
      store.P.media.push(entry);
      changed(id);
      rt.peaks = await computePeaks(file);
    }
    rt.status = 'ready';
  } catch (err) {
    mediaRT.delete(id);
    URL.revokeObjectURL(url);
    const idx = store.P.media.findIndex((m) => m.id === id);
    if (idx >= 0) store.P.media.splice(idx, 1);
    changed(id);
    throw err;
  }
  changed(id);
  db.putMedia({ id, blob: file, meta: entry, sprite: rt.sprite, spriteN: rt.spriteN, spriteW: rt.spriteW, spriteH: rt.spriteH, poster: rt.poster, peaks: rt.peaks || null });
  if (!silent) store.scheduleSave();
  return entry;
}

/** Restore runtime data for media listed in the project from IndexedDB. */
export async function restoreMedia(P) {
  const missing = [];
  await Promise.all(P.media.map(async (m) => {
    if (mediaRT.has(m.id)) return;
    const rec = await db.getMedia(m.id);
    if (!rec || !rec.blob) { missing.push(m.id); return; }
    const url = URL.createObjectURL(rec.blob);
    const rt = { url, status: 'ready', sprite: rec.sprite, spriteN: rec.spriteN, spriteW: rec.spriteW, spriteH: rec.spriteH, poster: rec.poster, peaks: rec.peaks || null };
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
  if (rt?.url) setTimeout(() => URL.revokeObjectURL(rt.url), 2000);
  mediaRT.delete(id);
  // Keep the blob if another saved project still references it.
  const projects = await db.listProjects();
  if (!projects.some((p) => p.id !== P.id && p.media?.some((m) => m.id === id))) db.deleteMedia(id);
  changed(id);
  store.touch('media');
}

export async function importFromServerUrl(serverUrl, name, mime) {
  const r = await fetch(serverUrl);
  if (!r.ok) throw new Error(`Gagal mengambil media (${r.status})`);
  const blob = await r.blob();
  const file = new File([blob], name || serverUrl.split('/').pop(), { type: mime || blob.type });
  return importFile(file);
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
