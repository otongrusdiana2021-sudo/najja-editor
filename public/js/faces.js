// Where the people are, so Style Konsep never puts a text over one: the faces (v1.12.4: Ultra-Light-Fast face
// detector RFB-320, Apache-2.0, 1.3 MB) and the whole person (v1.12.5: MediaPipe Selfie Segmentation 256, Apache-2.0,
// 0.46 MB), both from the Najja server's /vendor, on this device with onnxruntime-web's WebAssembly backend — no GPU
// needed. Each video is looked at about twice a second; what is found is kept in the project (m.faces: boxes,
// m.people: a coarse mask), so a video is only looked at once.
import { loadOrt, frameReader } from './bgdevice.js';
import { encodeCells } from './stylefx.js';

export const FACE_MODEL_URL = '/vendor/ultraface-320/model.onnx';
export const PERSON_MODEL_URL = '/vendor/selfie-256/model.onnx';
export const FACES_VERSION = 1;
export const PEOPLE_VERSION = 1;
const PN = 256; // (the person model's input: the picture squeezed to 256×256)
const GRID = 32; // (cells along the long side of the kept mask)
const IW = 320;
const IH = 240;
const THRESHOLD = 0.7;
const IOU = 0.3;
const MAX_SAMPLES = 180;
const r3 = (v) => Math.round(v * 1000) / 1000;

const sessions = new Map();
/** A small model from /vendor, ready on WebAssembly (once). what: its name in a message. */
function loadModel(url, what) {
  if (!sessions.has(url)) {
    sessions.set(url, (async () => {
      const ort = await loadOrt();
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
        throw new Error(`model ${what} tidak bisa diunduh: ${msg}`);
      }
      return ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'] });
    })().catch((err) => { sessions.delete(url); throw err; }));
  }
  return sessions.get(url);
}

/** The person model's answer (alpha, PN × PN, 0–1) → cells (cols × rows) where a person is. */
export function personCells(alpha, n, cols, rows, threshold = 0.3) {
  const cells = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y1 = Math.floor((j * n) / rows);
    const y2 = Math.max(y1 + 1, Math.floor(((j + 1) * n) / rows));
    for (let i = 0; i < cols; i++) {
      const x1 = Math.floor((i * n) / cols);
      const x2 = Math.max(x1 + 1, Math.floor(((i + 1) * n) / cols));
      let sum = 0;
      for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) sum += alpha[y * n + x];
      if (sum / ((y2 - y1) * (x2 - x1)) > threshold) cells[j * cols + i] = 1;
    }
  }
  return cells;
}
export const gridFor = (w, h) => (w >= h ? { cols: GRID, rows: Math.max(8, Math.round((GRID * h) / w)) } : { cols: Math.max(8, Math.round((GRID * w) / h)), rows: GRID });

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

/** The media where the people are not known yet: the videos and photos the project's clips show. */
export function mediaWithoutFaces(P) {
  const used = new Set(P.clips.filter((c) => c.type === 'video' || c.type === 'image').map((c) => c.mediaId));
  return P.media.filter((m) => used.has(m.id) && (m.type === 'video' || m.type === 'image') && !m.stock && !m.cover && (m.faces?.v !== FACES_VERSION || m.people?.v !== PEOPLE_VERSION));
}

/**
 * Look for the people in the project's videos and photos that were not looked at yet: the faces (m.faces = { v, fps,
 * samples: [[t, [[x1,y1,x2,y2], …]], …] }, boxes 0–1 of the picture) and where the whole person is (m.people = { v,
 * fps, cols, rows, samples: [[t, cells as base64 bits]] }); t in the media.
 * Resolves { looked, failed, reason }: a device that cannot load a model keeps what the other finds (no model at all:
 * the media stay as they are and the styles guess).
 */
export async function findPeople(P, { onProgress = () => {}, signal } = {}) {
  const todo = mediaWithoutFaces(P);
  if (!todo.length) return { looked: 0, failed: 0 };
  let ort;
  let faceSess = null;
  let personSess = null;
  const reasons = [];
  try { ort = await loadOrt(); } catch (err) { return { looked: 0, failed: todo.length, reason: err.message }; }
  try { faceSess = await loadModel(FACE_MODEL_URL, 'wajah'); } catch (err) { reasons.push(err.message); }
  try { personSess = await loadModel(PERSON_MODEL_URL, 'orang'); } catch (err) { reasons.push(err.message); }
  if (!faceSess && !personSess) return { looked: 0, failed: todo.length, reason: reasons.join('; ') };
  const cv = document.createElement('canvas');
  cv.width = IW;
  cv.height = IH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const pc = document.createElement('canvas');
  pc.width = PN;
  pc.height = PN;
  const pctx = pc.getContext('2d', { willReadFrequently: true });
  const input = new Float32Array(3 * IW * IH);
  const pin = new Float32Array(3 * PN * PN);
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
      const grid = gridFor(w, h);
      const faces = [];
      const people = [];
      for (let i = 0; i < n; i++) {
        if (signal?.aborted) throw Object.assign(new Error('Dibatalkan'), { abort: true });
        const t = m.type === 'video' ? Math.min(Math.max(0, (m.duration || 0) - 0.05), (i + 0.5) / fps) : 0;
        const frame = await reader.at(t);
        if (faceSess) {
          ctx.fillStyle = 'rgb(127,127,127)';
          ctx.fillRect(0, 0, IW, IH);
          ctx.drawImage(frame, ox, oy, dw, dh);
          const px = ctx.getImageData(0, 0, IW, IH).data;
          for (let p = 0, q = 0; p < IW * IH; p++, q += 4) {
            input[p] = (px[q] - 127) / 128;
            input[IW * IH + p] = (px[q + 1] - 127) / 128;
            input[2 * IW * IH + p] = (px[q + 2] - 127) / 128;
          }
          const res = await faceSess.run({ [faceSess.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, IH, IW]) });
          const scores = res.scores ?? res[faceSess.outputNames[0]];
          const boxes = res.boxes ?? res[faceSess.outputNames[1]];
          faces.push([r3(t), decodeFaces(scores.data, boxes.data, { ox, oy, dw, dh })]);
          scores.dispose?.();
          boxes.dispose?.();
        }
        if (personSess) {
          pctx.drawImage(frame, 0, 0, PN, PN);
          const px = pctx.getImageData(0, 0, PN, PN).data;
          for (let p = 0, q = 0; p < PN * PN; p++, q += 4) {
            pin[p] = px[q] / 255;
            pin[PN * PN + p] = px[q + 1] / 255;
            pin[2 * PN * PN + p] = px[q + 2] / 255;
          }
          const res = await personSess.run({ [personSess.inputNames[0]]: new ort.Tensor('float32', pin, [1, 3, PN, PN]) });
          const a = res[personSess.outputNames[0]];
          people.push([r3(t), encodeCells(personCells(a.data, PN, grid.cols, grid.rows))]);
          a.dispose?.();
        }
        done++;
        onProgress(done / total);
      }
      if (faceSess) m.faces = { v: FACES_VERSION, fps: r3(fps), samples: faces };
      if (personSess) m.people = { v: PEOPLE_VERSION, fps: r3(fps), cols: grid.cols, rows: grid.rows, samples: people };
      looked++;
    } catch (err) {
      if (err.abort) throw err;
      failed++;
      reasons.push(err.message);
    } finally {
      reader?.close();
    }
  }
  return { looked, failed, reason: reasons.length ? [...new Set(reasons)].join('; ') : undefined, partial: !faceSess || !personSess };
}
