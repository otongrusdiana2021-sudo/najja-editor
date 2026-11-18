// Where the faces are (v1.12.4), so Style Konsep never puts a text over one: Ultra-Light-Fast face detector RFB-320
// (Apache-2.0, 1.3 MB, from the Najja server's /vendor) on this device with onnxruntime-web's WebAssembly backend —
// no GPU needed. Each video is looked at about twice a second; the boxes are kept in the project (m.faces), so a
// video is only looked at once.
import { loadOrt, frameReader } from './bgdevice.js';

export const FACE_MODEL_URL = '/vendor/ultraface-320/model.onnx';
export const FACES_VERSION = 1;
const IW = 320;
const IH = 240;
const THRESHOLD = 0.7;
const IOU = 0.3;
const MAX_SAMPLES = 180;
const r3 = (v) => Math.round(v * 1000) / 1000;

let session = null;
let loading = null;
function loadModel() {
  if (session) return Promise.resolve(session);
  if (!loading) {
    loading = (async () => {
      const ort = await loadOrt();
      const r = await fetch(FACE_MODEL_URL, { credentials: 'same-origin' });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
        throw new Error(`model wajah tidak bisa diunduh: ${msg}`);
      }
      session = await ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'] });
      return session;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

/** Boxes that overlap a stronger one by more than `iou` are dropped. boxes: [[x1,y1,x2,y2,score], …] */
export function nms(boxes, iou = IOU) {
  const sorted = [...boxes].sort((a, b) => b[4] - a[4]);
  const out = [];
  const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  for (const b of sorted) {
    if (out.some((o) => {
      const iw = Math.max(0, Math.min(o[2], b[2]) - Math.max(o[0], b[0]));
      const ih = Math.max(0, Math.min(o[3], b[3]) - Math.max(o[1], b[1]));
      const inter = iw * ih;
      return inter / (area(o) + area(b) - inter + 1e-9) > iou;
    })) continue;
    out.push(b);
  }
  return out;
}

/**
 * The model's answer → faces in the picture (0–1 of its width/height). scores [n×2], boxes [n×4] (0–1 of the 320×240
 * input); the picture was letterboxed into it: { ox, oy, dw, dh } in input pixels.
 */
export function decodeFaces(scores, boxes, { ox, oy, dw, dh }, { threshold = THRESHOLD, minSize = 0.03, max = 6 } = {}) {
  const found = [];
  const n = scores.length / 2;
  const cl = (v) => Math.min(1, Math.max(0, v));
  for (let i = 0; i < n; i++) {
    const s = scores[2 * i + 1];
    if (s < threshold) continue;
    const x1 = cl((boxes[4 * i] * IW - ox) / dw);
    const y1 = cl((boxes[4 * i + 1] * IH - oy) / dh);
    const x2 = cl((boxes[4 * i + 2] * IW - ox) / dw);
    const y2 = cl((boxes[4 * i + 3] * IH - oy) / dh);
    if (x2 - x1 < minSize || y2 - y1 < minSize) continue;
    found.push([x1, y1, x2, y2, s]);
  }
  return nms(found).slice(0, max).map((b) => b.slice(0, 4).map(r3));
}

/** The media whose faces are not known yet: the videos and photos the project's clips show. */
export function mediaWithoutFaces(P) {
  const used = new Set(P.clips.filter((c) => c.type === 'video' || c.type === 'image').map((c) => c.mediaId));
  return P.media.filter((m) => used.has(m.id) && (m.type === 'video' || m.type === 'image') && !m.stock && !m.cover && m.faces?.v !== FACES_VERSION);
}

/**
 * Look for faces in the project's videos and photos that were not looked at yet; kept in each media (m.faces =
 * { v, fps, samples: [[t, [[x1,y1,x2,y2], …]], …] }, t in the media, boxes 0–1 of the picture).
 * Resolves { looked, failed, reason }: a device that cannot do it leaves the media as they are (the styles then guess).
 */
export async function findFaces(P, { onProgress = () => {}, signal } = {}) {
  const todo = mediaWithoutFaces(P);
  if (!todo.length) return { looked: 0, failed: 0 };
  let sess;
  let ort;
  try {
    ort = await loadOrt();
    sess = await loadModel();
  } catch (err) {
    return { looked: 0, failed: todo.length, reason: err.message };
  }
  const cv = document.createElement('canvas');
  cv.width = IW;
  cv.height = IH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const input = new Float32Array(3 * IW * IH);
  const plan = todo.map((m) => {
    const dur = m.type === 'video' ? Math.max(0.1, m.duration || 0.1) : 0;
    const fps = dur ? Math.min(2, MAX_SAMPLES / dur) : 1;
    const n = dur ? Math.max(1, Math.floor(dur * fps)) : 1;
    return { m, fps, n };
  });
  const total = plan.reduce((a, x) => a + x.n, 0);
  let done = 0;
  let looked = 0;
  let failed = 0;
  let reason = '';
  for (const { m, fps, n } of plan) {
    let reader = null;
    try {
      reader = await frameReader(m.id);
      const { w, h } = reader.size;
      const k = Math.min(IW / w, IH / h);
      const dw = w * k;
      const dh = h * k;
      const ox = (IW - dw) / 2;
      const oy = (IH - dh) / 2;
      const samples = [];
      for (let i = 0; i < n; i++) {
        if (signal?.aborted) throw Object.assign(new Error('Dibatalkan'), { abort: true });
        const t = m.type === 'video' ? Math.min(Math.max(0, (m.duration || 0) - 0.05), (i + 0.5) / fps) : 0;
        const frame = await reader.at(t);
        ctx.fillStyle = 'rgb(127,127,127)';
        ctx.fillRect(0, 0, IW, IH);
        ctx.drawImage(frame, ox, oy, dw, dh);
        const px = ctx.getImageData(0, 0, IW, IH).data;
        for (let p = 0, q = 0; p < IW * IH; p++, q += 4) {
          input[p] = (px[q] - 127) / 128;
          input[IW * IH + p] = (px[q + 1] - 127) / 128;
          input[2 * IW * IH + p] = (px[q + 2] - 127) / 128;
        }
        const res = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, IH, IW]) });
        const scores = res.scores ?? res[sess.outputNames[0]];
        const boxes = res.boxes ?? res[sess.outputNames[1]];
        samples.push([r3(t), decodeFaces(scores.data, boxes.data, { ox, oy, dw, dh })]);
        scores.dispose?.();
        boxes.dispose?.();
        done++;
        onProgress(done / total);
      }
      m.faces = { v: FACES_VERSION, fps: r3(fps), samples };
      looked++;
    } catch (err) {
      if (err.abort) throw err;
      failed++;
      reason = err.message;
    } finally {
      reader?.close();
    }
  }
  return { looked, failed, reason: reason || undefined };
}
