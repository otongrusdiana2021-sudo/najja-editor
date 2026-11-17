// "Hapus latar otomatis" on this device (v1.11): BiRefNet lite 512 (MIT) — the same model as the server's photo
// cutout, keeping every object in front (people, products, bags, animals), not only people — runs on this device's
// GPU through onnxruntime-web (WebGPU). The library and the model come from the Najja server (/vendor: a pinned
// version, sha256-checked); the model (±190 MB) is kept in this browser's storage after the first time.
// The clip's frames are read with WebCodecs (the export's decoder), or by seeking a video element when that cannot
// read the file; each frame becomes an 8-bit mask, a little of the previous one blended in so the edge stays calm.
import { ByteSource, demuxVideo, VideoSource, guard } from './fastexport.js';
import { mediaRT } from './media.js';

export const ORT_VERSION = '1.29.0';
const ORT = `/vendor/onnxruntime-${ORT_VERSION}`;
export const MODEL_URL = '/vendor/birefnet-512/model.onnx';
export const MODEL_NAME = 'birefnet-lite-512';
const MODEL_CACHE = 'najja-models-v1';
const N = 512;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const KEEP_PREV = 0.25; // (temporal smoothing: this much of the previous frame's mask)

let support = null;
/** Whether this device can do it: { ok, reason }. (WebGPU for the model, a 2D canvas for the frames.) */
export async function deviceSupport() {
  if (support) return support;
  let reason = '';
  if (typeof navigator === 'undefined' || !navigator.gpu) reason = 'browser ini belum mendukung WebGPU';
  else {
    try { if (!(await navigator.gpu.requestAdapter())) reason = 'GPU perangkat ini tidak tersedia untuk browser'; } catch (err) { reason = err.message; }
  }
  support = { ok: !reason, reason };
  return support;
}

/** The model's bytes: from this browser's storage, or downloaded (with progress) and kept. */
async function modelBytes(onProgress) {
  let cache = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(MODEL_URL);
    if (hit) return await hit.arrayBuffer();
  } catch { /* no Cache Storage (private mode): download every time */ }
  const r = await fetch(MODEL_URL, { credentials: 'same-origin' });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(`model AI tidak bisa diunduh: ${msg}`);
  }
  const total = Number(r.headers.get('content-length')) || 0;
  const reader = r.body.getReader();
  // (straight into one buffer of the right size: a phone or tablet has no room for several copies of 190 MB)
  let buf = new Uint8Array(total || 64 * 1024 * 1024);
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (got + value.length > buf.length) { const bigger = new Uint8Array(Math.max(buf.length * 2, got + value.length)); bigger.set(buf.subarray(0, got)); buf = bigger; }
    buf.set(value, got);
    got += value.length;
    if (total) onProgress(got / total);
  }
  if (total && got !== total) throw new Error(`model AI tidak bisa diunduh: terputus (${Math.round(got / 1e6)} dari ${Math.round(total / 1e6)} MB)`);
  if (got !== buf.length) buf = buf.slice(0, got);
  try { await cache?.put(MODEL_URL, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* storage full: next time again */ }
  return buf;
}

let ort = null;
let session = null;
let loading = null;
/** The model ready on the GPU (once). onProgress(p, stage): 'model' while downloading, 'init' while it is set up. */
export function loadDeviceModel(onProgress = () => {}) {
  if (session) return Promise.resolve(session);
  if (loading) return loading;
  loading = (async () => {
    try { ort = await import(`${ORT}/ort.webgpu.min.mjs`); } catch {
      let msg = 'pustaka AI tidak bisa dimuat dari server';
      try { const r = await fetch(`${ORT}/ort.webgpu.min.mjs`, { credentials: 'same-origin' }); if (!r.ok) msg = (await r.json()).error || msg; } catch { /* offline */ }
      throw new Error(msg);
    }
    ort.env.wasm.wasmPaths = `${location.origin}${ORT}/`;
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    const bytes = await modelBytes((p) => onProgress(p, 'model'));
    onProgress(1, 'init');
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
    } catch (err) {
      // (a kept copy that does not load is not kept: downloaded again next time)
      try { await (await caches.open(MODEL_CACHE)).delete(MODEL_URL); } catch { /* no Cache Storage */ }
      throw new Error(`model AI tidak bisa dijalankan di GPU perangkat ini (${String(err.message || err).slice(0, 120)})`);
    }
    return session;
  })().catch((err) => { loading = null; throw err; });
  return loading;
}

/** Frames of a media at the given times, one after another: WebCodecs, or seeking a video element. */
async function frameReader(mediaId) {
  const rt = mediaRT.get(mediaId);
  if (rt?.img) return { size: { w: rt.img.naturalWidth || rt.img.width, h: rt.img.naturalHeight || rt.img.height }, at: async () => rt.img, close() {} };
  const url = rt?.exportUrl || rt?.url;
  if (!url) throw new Error('video belum dimuat di perangkat ini');
  try {
    if (typeof VideoDecoder === 'undefined') throw new Error('no WebCodecs');
    const bs = await guard(ByteSource.open(url), 30000, 'membaca video');
    const track = demuxVideo(await guard(bs.moov(), 30000, 'membaca video'));
    const vs = await VideoSource.open(new ByteSource(bs.blob), track, {}, 'prefer-software');
    return { size: { w: track.width, h: track.height }, at: (t) => guard(vs.frameAt(t), 20000, 'video decoder'), close: () => vs.close() };
  } catch {
    // (a rotated or unusual file: the browser's own player reads it)
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error('video tidak bisa dibaca')); });
    return {
      size: { w: v.videoWidth, h: v.videoHeight },
      at: (t) => new Promise((ok) => {
        const done = () => { if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => ok(v)); else ok(v); };
        if (Math.abs(v.currentTime - t) < 1e-3) { ok(v); return; }
        v.addEventListener('seeked', done, { once: true });
        v.currentTime = t;
      }),
      close: () => { v.removeAttribute('src'); v.load(); },
    };
  }
}

/**
 * The masks of a media's part [start, end] at `fps` frames a second: { data (n × w × h bytes), n, w, h }.
 * onProgress({ stage: 'model'|'init'|'frames', p, frame, frames, eta }); signal stops it.
 */
export async function analyzeOnDevice({ mediaId, start, end, fps, maskLong = 384, onProgress = () => {}, signal }) {
  const sess = await loadDeviceModel((p, stage) => onProgress({ stage, p }));
  onProgress({ stage: 'frames', p: 0, frame: 0, frames: Math.max(1, Math.round((end - start) * fps)) });
  const reader = await frameReader(mediaId);
  try {
    const n = Math.max(1, Math.round((end - start) * fps));
    const { w: W, h: H } = reader.size;
    const k = maskLong / Math.max(W, H);
    const mw = Math.max(1, Math.round(W * k));
    const mh = Math.max(1, Math.round(H * k));
    const cv = document.createElement('canvas');
    cv.width = N;
    cv.height = N;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const input = new Float32Array(3 * N * N);
    const out = new Uint8Array(n * mw * mh);
    const prob = new Float32Array(N * N);
    // bilinear map from the 512×512 output to the mask's size (the picture was squeezed to a square: undo that)
    const xs = new Float32Array(mw);
    const ys = new Float32Array(mh);
    for (let x = 0; x < mw; x++) xs[x] = Math.min(N - 1, ((x + 0.5) * N) / mw - 0.5);
    for (let y = 0; y < mh; y++) ys[y] = Math.min(N - 1, ((y + 0.5) * N) / mh - 0.5);
    const inName = sess.inputNames[0];
    const outName = sess.outputNames[0];
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new Error('Dibatalkan');
      const frame = await reader.at(Math.min(end - 1e-3, start + i / fps));
      ctx.drawImage(frame, 0, 0, N, N);
      const px = ctx.getImageData(0, 0, N, N).data;
      for (let p = 0, q = 0; p < N * N; p++, q += 4) {
        input[p] = (px[q] / 255 - MEAN[0]) / STD[0];
        input[N * N + p] = (px[q + 1] / 255 - MEAN[1]) / STD[1];
        input[2 * N * N + p] = (px[q + 2] / 255 - MEAN[2]) / STD[2];
      }
      const res = await sess.run({ [inName]: new ort.Tensor('float32', input, [1, 3, N, N]) });
      const y = res[outName];
      const v = y.data;
      for (let p = 0; p < N * N; p++) prob[p] = 1 / (1 + Math.exp(-v[p]));
      y.dispose?.();
      const o = i * mw * mh;
      const prev = i ? o - mw * mh : -1;
      for (let yy = 0; yy < mh; yy++) {
        const fy = ys[yy];
        const y0 = Math.max(0, Math.floor(fy));
        const y1 = Math.min(N - 1, y0 + 1);
        const wy = Math.max(0, fy - y0);
        for (let xx = 0; xx < mw; xx++) {
          const fx = xs[xx];
          const x0 = Math.max(0, Math.floor(fx));
          const x1 = Math.min(N - 1, x0 + 1);
          const wx = Math.max(0, fx - x0);
          const a = prob[y0 * N + x0] * (1 - wx) + prob[y0 * N + x1] * wx;
          const b = prob[y1 * N + x0] * (1 - wx) + prob[y1 * N + x1] * wx;
          let val = (a * (1 - wy) + b * wy) * 255;
          const j = yy * mw + xx;
          if (prev >= 0) val = val * (1 - KEEP_PREV) + out[prev + j] * KEEP_PREV;
          out[o + j] = val + 0.5;
        }
      }
      const done = i + 1;
      const left = ((performance.now() - t0) / done) * (n - done) / 1000;
      onProgress({ stage: 'frames', p: done / n, frame: done, frames: n, eta: Math.round(left) });
    }
    return { data: out, n, w: mw, h: mh };
  } finally {
    reader.close();
  }
}

/** gzip of the masks (CompressionStream), for the upload. */
export async function gzipMasks(data) {
  if (typeof CompressionStream === 'undefined') return { body: data, gzip: false };
  const body = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  return { body, gzip: true };
}
