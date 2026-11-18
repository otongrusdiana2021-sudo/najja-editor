// Style Konsep, the finishing touches — after a style is built:
//   1. (v1.12.4 faces, v1.12.5 the whole person) no text over a person: where people are in each video is known per
//      media (faces.js: m.faces boxes, m.people masks); every text / sticker that would cover a person moves to the
//      free background (beside the head, over the table, above), smaller if it must be; texts shown together move
//      together, so their layout stays; subtitles of one shot share one place;
//   2. a sound for every text that appears and every move: a pop when words pop in, a swipe when they slide, a
//      "ka-ching" when the price counts, typing for a typewriter, a bubble for a sticker, a whoosh on a transition, a
//      soft click per subtitle line — on "SFX" audio tracks (a second/third only while a longer sound still plays).
// Pure: the face boxes and person masks come from the project's media, the sounds from media made by the caller.
import { makeClip, kfValue } from './store.js';
import { uid } from './util.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Where the people are

/** A head-and-shoulders guess for a talking video nobody looked at (no model on this device): face, then body. */
export const TALK_FACE_GUESS = [0.3, 0.12, 0.7, 0.48];
export const TALK_BODY_GUESS = [0.14, 0.12, 0.86, 1];

const nearest = (samples, fps, t) => {
  if (!samples?.length) return null;
  const step = 1 / Math.max(0.1, fps || 2);
  let best = null;
  let bd = Infinity;
  for (const s of samples) {
    const d = Math.abs(s[0] - t);
    if (d < bd) { bd = d; best = s; }
  }
  return best && bd <= step * 1.6 ? best[1] : null;
};

/** The faces of a media at source time t: [[x1,y1,x2,y2], …] (0–1 of the picture), or null when not known. */
export const facesAt = (m, t) => nearest(m?.faces?.samples, m?.faces?.fps, t);

/** The cells of a person mask (cols × rows, row by row) ⇄ base64 bits. */
export function encodeCells(cells) {
  const bytes = new Uint8Array(Math.ceil(cells.length / 8));
  for (let i = 0; i < cells.length; i++) if (cells[i]) bytes[i >> 3] |= 1 << (i & 7);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str);
}
export function decodeCells(b64, n) {
  const str = atob(b64);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (str.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return out;
}
const cellCache = new Map();
/** Where a person is in a media at source time t: { cols, rows, cells } (1 = person), or null when not known. */
export function peopleAt(m, t) {
  const p = m?.people;
  const b64 = nearest(p?.samples, p?.fps, t);
  if (b64 == null) return null;
  const key = `${p.cols}x${p.rows}:${b64}`;
  let cells = cellCache.get(key);
  if (!cells) {
    cells = decodeCells(b64, p.cols * p.rows);
    if (cellCache.size > 4000) cellCache.clear();
    cellCache.set(key, cells);
  }
  return { cols: p.cols, rows: p.rows, cells };
}

/** Where a visual clip's picture is on the canvas at timeline time t: { cx, cy, w, h, flip } (canvas pixels). */
function pictureRect(P, c, m, t) {
  const local = t - c.start;
  const v = (p) => (c.keyframes?.length ? kfValue(c, p, local) : c[p]);
  const W = P.width;
  const H = P.height;
  const mw = m?.width || W;
  const mh = m?.height || H;
  const k = Math.min(W / mw, H / mh) * (v('scale') ?? 1);
  return { cx: W / 2 + (v('x') || 0) * W, cy: H / 2 + (v('y') || 0) * H, w: mw * k, h: mh * k, flip: !!c.flipH, opacity: v('opacity') ?? 1 };
}

/** The videos and photos seen at time t, top layer first; below a picture that fills the canvas nothing is seen. */
function picturesAt(P, t) {
  const media = new Map((P.media || []).map((m) => [m.id, m]));
  const order = new Map(P.tracks.map((tr, i) => [tr.id, i]));
  const hidden = new Set(P.tracks.filter((tr) => tr.hidden).map((tr) => tr.id));
  const list = P.clips.filter((c) => (c.type === 'video' || c.type === 'image') && !hidden.has(c.trackId) && t >= c.start - 1e-3 && t <= c.start + c.duration + 1e-3)
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0));
  const out = [];
  for (const c of list) {
    const m = media.get(c.mediaId);
    const r = pictureRect(P, c, m, t);
    out.push({ c, m, r, src: c.type === 'video' ? (c.in || 0) + (t - c.start) * (c.speed || 1) : 0 });
    const opaque = r.opacity >= 0.99 && !c.chroma?.enabled && !c.cutout?.enabled && (!c.blend || c.blend === 'source-over');
    if (opaque && r.cx - r.w / 2 <= 1 && r.cy - r.h / 2 <= 1 && r.cx + r.w / 2 >= P.width - 1 && r.cy + r.h / 2 >= P.height - 1) break;
  }
  return out;
}
const faceRoom = (X1, Y1, X2, Y2) => {
  const fw = X2 - X1;
  const fh = Y2 - Y1;
  return [X1 - fw * 0.12, Y1 - fh * 0.18, X2 + fw * 0.12, Y2 + fh * 0.12];
};
const toCanvas = (r, [a, b, c, d]) => {
  const x1 = r.flip ? 1 - c : a;
  const x2 = r.flip ? 1 - a : c;
  return [r.cx + (x1 - 0.5) * r.w, r.cy + (b - 0.5) * r.h, r.cx + (x2 - 0.5) * r.w, r.cy + (d - 0.5) * r.h];
};

/**
 * The faces on the canvas at timeline time t, as canvas rectangles {x1,y1,x2,y2}, from every video or photo seen
 * (main track and overlays), with a little room around each face (hair, chin). talking(m): a talking video without
 * face data is given TALK_FACE_GUESS.
 */
export function faceRectsAt(P, t, { talking = () => false } = {}) {
  const out = [];
  for (const { c, m, r, src } of picturesAt(P, t)) {
    let boxes = facesAt(m, src);
    if (!boxes && c.type === 'video' && !m?.people && talking(m)) boxes = [TALK_FACE_GUESS];
    for (const box of boxes || []) {
      const [X1, Y1, X2, Y2] = faceRoom(...toCanvas(r, box));
      const R = { x1: Math.max(0, X1), y1: Math.max(0, Y1), x2: Math.min(P.width, X2), y2: Math.min(P.height, Y2) };
      if (R.x2 > R.x1 + 2 && R.y2 > R.y1 + 2) out.push(R);
    }
  }
  return out;
}

/**
 * Where people are on the canvas over [start, end]: a grid of nx × ny cells (about 20 px), each the share of the time
 * a person (body) or a face covers it. From the person masks (m.people), else a body guessed from the faces, else
 * (a talking video nobody looked at) TALK_BODY_GUESS.
 */
export function occupancy(P, start, end, { talking = () => false, nx = 54 } = {}) {
  const W = P.width;
  const H = P.height;
  const ny = Math.max(8, Math.round((nx * H) / W));
  const cw = W / nx;
  const ch = H / ny;
  const body = new Float32Array(nx * ny);
  const face = new Float32Array(nx * ny);
  const upper = new Float32Array(nx * ny); // (head, shoulders and chest: the part of a person a text must not cover most)
  const n = Math.min(24, Math.max(2, Math.ceil((end - start) / 0.25)));
  const b1 = new Uint8Array(nx * ny);
  const f1 = new Uint8Array(nx * ny);
  const u1 = new Uint8Array(nx * ny);
  const mark = (arr, X1, Y1, X2, Y2) => {
    const i1 = Math.max(0, Math.floor(X1 / cw));
    const i2 = Math.min(nx - 1, Math.ceil(X2 / cw) - 1);
    const j1 = Math.max(0, Math.floor(Y1 / ch));
    const j2 = Math.min(ny - 1, Math.ceil(Y2 / ch) - 1);
    for (let j = j1; j <= j2; j++) for (let i = i1; i <= i2; i++) arr[j * nx + i] = 1;
  };
  let any = false;
  for (let s = 0; s <= n; s++) {
    // (from its first moment to its last, just inside: a shot that starts as the text ends is not seen with it)
    const t = start + 0.01 + (Math.max(0, end - start - 0.02) * s) / n;
    b1.fill(0);
    f1.fill(0);
    u1.fill(0);
    for (const { c, m, r, src } of picturesAt(P, t)) {
      const faces = facesAt(m, src);
      const mask = peopleAt(m, src);
      const guess = !faces && !mask && c.type === 'video' && talking(m);
      for (const [a, b, cc, d] of faces || (guess ? [TALK_FACE_GUESS] : [])) {
        mark(f1, ...faceRoom(...toCanvas(r, [a, b, cc, d])));
        const fw = cc - a;
        const fh = d - b;
        mark(u1, ...toCanvas(r, [Math.max(0, a - fw * 0.9), b, Math.min(1, cc + fw * 0.9), Math.min(1, d + fh * 1.4)]));
      }
      if (mask) {
        // (each canvas cell: the mask cell under its centre)
        const x0 = r.cx - r.w / 2;
        const y0 = r.cy - r.h / 2;
        const i1 = Math.max(0, Math.floor(x0 / cw));
        const i2 = Math.min(nx - 1, Math.ceil((x0 + r.w) / cw));
        const j1 = Math.max(0, Math.floor(y0 / ch));
        const j2 = Math.min(ny - 1, Math.ceil((y0 + r.h) / ch));
        for (let j = j1; j <= j2; j++) {
          const v = ((j + 0.5) * ch - y0) / r.h;
          if (v < 0 || v >= 1) continue;
          const row = Math.floor(v * mask.rows) * mask.cols;
          for (let i = i1; i <= i2; i++) {
            let u = ((i + 0.5) * cw - x0) / r.w;
            if (u < 0 || u >= 1) continue;
            if (r.flip) u = 1 - u - 1e-9;
            if (mask.cells[row + Math.floor(u * mask.cols)]) b1[j * nx + i] = 1;
          }
        }
      } else {
        // (no mask: a body under each face — shoulders about three faces wide — down to the bottom of the picture)
        const boxes = faces || (guess ? [TALK_FACE_GUESS] : []);
        for (const [a, b, cc] of boxes) {
          const fw = cc - a;
          mark(b1, ...toCanvas(r, [Math.max(0, a - fw), b, Math.min(1, cc + fw), 1]));
        }
        if (guess) mark(b1, ...toCanvas(r, TALK_BODY_GUESS));
      }
    }
    for (let i = 0; i < b1.length; i++) {
      if (b1[i] || f1[i]) any = true;
      body[i] += b1[i] || f1[i];
      face[i] += f1[i];
      upper[i] += (b1[i] && u1[i]) || f1[i];
    }
  }
  for (let i = 0; i < body.length; i++) { body[i] /= n + 1; face[i] /= n + 1; upper[i] /= n + 1; }
  const sat = (a) => {
    const S = new Float64Array((nx + 1) * (ny + 1));
    for (let j = 0; j < ny; j++) {
      let row = 0;
      for (let i = 0; i < nx; i++) { row += a[j * nx + i]; S[(j + 1) * (nx + 1) + i + 1] = S[j * (nx + 1) + i + 1] + row; }
    }
    return S;
  };
  const SB = sat(body);
  const SF = sat(face);
  const SU = sat(upper);
  /** The share of a canvas rectangle over a person (body), their head-shoulders-chest (upper) and face, 0–1 each. */
  // (a box edge a sliver into a cell — under a third of it — does not count that cell: the mask itself is coarser)
  const cover = (b) => {
    const tx = cw / 3;
    const ty = ch / 3;
    const i1 = Math.max(0, Math.min(nx, Math.floor((b.x1 + tx) / cw)));
    const i2 = Math.max(i1, Math.min(nx, Math.ceil((b.x2 - tx) / cw)));
    const j1 = Math.max(0, Math.min(ny, Math.floor((b.y1 + ty) / ch)));
    const j2 = Math.max(j1, Math.min(ny, Math.ceil((b.y2 - ty) / ch)));
    const cells = Math.max(1, (i2 - i1) * (j2 - j1));
    const q = (S) => S[j2 * (nx + 1) + i2] - S[j1 * (nx + 1) + i2] - S[j2 * (nx + 1) + i1] + S[j1 * (nx + 1) + i1];
    return { body: q(SB) / cells, upper: q(SU) / cells, face: q(SF) / cells };
  };
  return { any, nx, ny, body, face, upper, cover };
}

const CHAR_W = { Anton: 0.46, 'Bebas Neue': 0.42, Oswald: 0.48, 'Instrument Serif': 0.47, 'Playfair Display': 0.55 };
/** A text's or sticker's size on the canvas (measure: a real measurement { w, h } when the caller has one). */
export function itemBox(c, measure = null) {
  let w;
  let h;
  const m = measure?.(c);
  if (m) ({ w, h } = m);
  else if (c.type === 'sticker' && c.sticker?.swatch) {
    // (render.js swatchLayout: a 170 px circle, its name under it)
    const sw = c.sticker.swatch;
    w = Math.max(186, String(sw.label || '').length * 42 * 0.56 + 24);
    h = 178 + (sw.label ? 61 : 0);
  } else if (c.type === 'sticker' && c.sticker?.badge) {
    // (render.js badgeLayout: 64 px text, an icon, a pill 112 px tall)
    const b = c.sticker.badge;
    w = String(b.text || '').length * 64 * 0.66 + (b.icon ? 74 : 0) + 70;
    h = 112;
  } else if (c.type === 'sticker') { w = 220; h = 220; }
  else {
    const t = c.text || {};
    const lines = String(t.content ?? '').split('\n');
    const size = t.size || 60;
    const cw = (CHAR_W[t.font] ?? 0.58) * (t.weight >= 800 ? 1.05 : 1);
    w = Math.max(...lines.map((l) => [...l].length)) * size * cw + (t.letterSpacing || 0) * Math.max(...lines.map((l) => l.length));
    h = lines.length * size * (t.lineHeight || 1.2);
    const pad = t.bg?.enabled ? size * 0.38 * (t.bg.padding ?? 1) * 2 : 0;
    w += pad + (t.stroke?.enabled ? t.stroke.width * 2 : 0);
    h += pad;
  }
  const s = Math.abs(c.scale ?? 1);
  return { w: w * s, h: h * s };
}
function itemRect(P, c, measure) {
  const { w, h } = itemBox(c, measure);
  const cx = P.width / 2 + (c.x || 0) * P.width;
  const cy = P.height / 2 + (c.y || 0) * P.height;
  return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
}
const overlapArea = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
const area = (a) => Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
const union = (rs) => rs.reduce((u, r) => ({ x1: Math.min(u.x1, r.x1), y1: Math.min(u.y1, r.y1), x2: Math.max(u.x2, r.x2), y2: Math.max(u.y2, r.y2) }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });

/**
 * Move a group: its box `from` becomes `to` (canvas pixels; a smaller box scales the group, members keep their
 * places in it). Keyframed positions move the same way.
 */
function moveGroup(P, group, from, to) {
  const k = (to.x2 - to.x1) / Math.max(1, from.x2 - from.x1);
  const fx = (from.x1 + from.x2) / 2;
  const fy = (from.y1 + from.y2) / 2;
  const tx = (to.x1 + to.x2) / 2;
  const ty = (to.y1 + to.y2) / 2;
  const mapX = (x) => (tx + ((P.width / 2 + x * P.width) - fx) * k - P.width / 2) / P.width;
  const mapY = (y) => (ty + ((P.height / 2 + y * P.height) - fy) * k - P.height / 2) / P.height;
  for (const c of group) {
    c.x = r3(mapX(c.x || 0));
    c.y = r3(mapY(c.y || 0));
    if (Math.abs(k - 1) > 1e-3) c.scale = r3((c.scale ?? 1) * k);
    for (const kf of c.keyframes || []) {
      if ('x' in kf) kf.x = r3(mapX(kf.x));
      if ('y' in kf) kf.y = r3(mapY(kf.y));
      if (Math.abs(k - 1) > 1e-3 && 'scale' in kf) kf.scale = r3(kf.scale * k);
    }
  }
}

const timeOverlap = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.05;

/** A line of words broken into n lines as even as the words allow ("TRAVEL BAG MINI", 2 → "TRAVEL BAG\nMINI"), or null. */
export function wrapWords(text, n) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (n < 2 || words.length < n) return null;
  let best = null;
  const len = (a, b) => words.slice(a, b).join(' ').length;
  const tryCuts = (cuts) => {
    const at = [0, ...cuts, words.length];
    const widest = Math.max(...at.slice(1).map((e, i) => len(at[i], e)));
    if (!best || widest < best.widest) best = { widest, at };
  };
  if (n === 2) for (let i = 1; i < words.length; i++) tryCuts([i]);
  else for (let i = 1; i < words.length - 1; i++) for (let j = i + 1; j < words.length; j++) tryCuts([i, j]);
  return best.at.slice(1).map((e, i) => words.slice(best.at[i], e).join(' ')).join('\n');
}

/**
 * Keep texts and stickers off the people in the picture (their faces above all). Texts shown together and near each
 * other (a title and the line under it, a price and its old price) form a group and move together, keeping their
 * layout; the subtitle lines of one shot form one group, so they stay in one place. A group over a person goes to
 * the free background nearest to where the style put it — beside the head, over the table, above — broken into 2–3
 * lines or smaller if it must be, never onto another text shown at the same time. When a person fills the picture, it goes
 * where it covers the least of them, faces last.
 * Returns { checked, moved, scaled, wrapped, partly, left } (checked: groups shown while someone is in the picture;
 * wrapped: a title broken into lines to fit; partly: still over a little of the body; left: no better place, it stays).
 */
export function avoidPeople(P, { measure = null, talking = () => false } = {}) {
  const W = P.width;
  const H = P.height;
  const subtitleTracks = new Set(P.tracks.filter((t) => t.subtitle).map((t) => t.id));
  const hiddenTracks = new Set(P.tracks.filter((t) => t.hidden).map((t) => t.id));
  const items = P.clips.filter((c) => (c.type === 'text' || c.type === 'sticker') && !hiddenTracks.has(c.trackId));
  const rectOf = new Map(items.map((c) => [c, itemRect(P, c, measure)]));
  const isSub = (c) => subtitleTracks.has(c.trackId);
  // groups: near each other (less than 4% of the height apart) and shown together
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = H * 0.04;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (isSub(a)) continue;
    const ra = rectOf.get(a);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (isSub(b) || !timeOverlap({ start: a.start, end: a.start + a.duration }, { start: b.start, end: b.start + b.duration })) continue;
      const rb = rectOf.get(b);
      const gx = Math.max(0, Math.max(ra.x1, rb.x1) - Math.min(ra.x2, rb.x2));
      const gy = Math.max(0, Math.max(ra.y1, rb.y1) - Math.min(ra.y2, rb.y2));
      if (gx < near * 2 && gy < near) parent[find(i)] = find(j);
    }
  }
  // the subtitle lines of one shot (the main clip under their start): one group
  const main = P.clips.filter((c) => c.trackId === 'main');
  const shotOf = (c) => main.find((m) => c.start >= m.start - 1e-3 && c.start < m.start + m.duration)?.id || '';
  const subRoot = new Map();
  items.forEach((c, i) => {
    if (!isSub(c)) return;
    const key = `${c.trackId}|${shotOf(c)}`;
    if (subRoot.has(key)) parent[i] = subRoot.get(key); else subRoot.set(key, i);
  });
  const byRoot = new Map();
  items.forEach((c, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(c); });
  const groups = [...byRoot.values()].map((clips) => ({
    clips,
    sub: isSub(clips[0]),
    start: Math.min(...clips.map((c) => c.start)),
    end: Math.max(...clips.map((c) => c.start + c.duration)),
    box: union(clips.map((c) => rectOf.get(c))),
  })).sort((a, b) => a.sub - b.sub || a.start - b.start);
  const res = { checked: 0, moved: 0, scaled: 0, wrapped: 0, partly: 0, left: 0 };
  const top = H * 0.05;
  const left = W * 0.03;
  const right = W * 0.97;
  for (const g of groups) {
    // (a subtitle stays readable: not under 75%; a title or a word may go down to 45%)
    const SIZES = g.sub ? [1, 0.9, 0.8, 0.75] : [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45];
    const occ = occupancy(P, g.start, g.end, { talking });
    if (!occ.any) continue;
    res.checked++;
    // (subtitles may sit lower: the app's buttons and the platform's caption are in the bottom fifth)
    const bottom = H * (g.sub ? 0.9 : 0.8);
    // (a little air between a text and the person: ~12 px)
    const pad = W * 0.011;
    const cost = (b, k) => {
      const cv = occ.cover({ x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad });
      const cy = (b.y1 + b.y2) / 2;
      const dx = Math.abs((b.x1 + b.x2) / 2 - (g.box.x1 + g.box.x2) / 2) / W;
      const dy = Math.abs(cy - (g.box.y1 + g.box.y2) / 2) / H;
      // faces count most, then head-shoulders-chest, then the rest of the body (a person filling the picture: the
      // text goes over the lap or the legs); then how far it moves and how much smaller it gets (subtitles rather low)
      return { c: 40 * cv.face + 8 * cv.upper + 4 * cv.body + 0.35 * dx + 0.5 * dy + (1 - k) + (g.sub ? 0.4 * Math.max(0, 0.6 - cy / H) : 0), cv };
    };
    const now = occ.cover(g.box);
    if (now.face < 0.005 && now.body < 0.04) continue;
    const others = groups.filter((o) => o !== g && timeOverlap(o, g)).map((o) => o.box);
    const onText = (b) => others.some((o) => overlapArea(b, o) > Math.min(area(o), area(b)) * 0.03);
    const here = cost(g.box, 1);
    // a title alone (with its stickers) may also be broken into 2 or 3 lines, to stay big in a narrow free column
    const variants = [{ lines: 1, box: g.box }];
    const tx = g.clips.filter((c) => c.type === 'text');
    if (!g.sub && tx.length === 1 && !String(tx[0].text?.content).includes('\n') && tx[0].text?.motion?.type !== 'counter') {
      for (const n of [2, 3]) {
        const content = wrapWords(tx[0].text.content, n);
        if (!content) continue;
        const wrapped = { ...tx[0], text: { ...tx[0].text, content } };
        variants.push({ lines: n, content, box: union(g.clips.map((c) => (c === tx[0] ? itemRect(P, wrapped, measure) : rectOf.get(c)))) });
      }
    }
    let best = null;
    for (const v of variants) {
      const bw = v.box.x2 - v.box.x1;
      const bh = v.box.y2 - v.box.y1;
      for (const k of SIZES) {
        const w = bw * k;
        const h = bh * k;
        if (w > right - left || h > bottom - top) continue;
        const xs = [];
        for (let x = left; x + w <= right + 0.5; x += W * 0.025) xs.push(x);
        xs.push(right - w, Math.min(right - w, Math.max(left, (g.box.x1 + g.box.x2) / 2 - w / 2)));
        const ys = [];
        for (let y = top; y + h <= bottom + 0.5; y += H * 0.01) ys.push(y);
        ys.push(bottom - h, Math.min(bottom - h, Math.max(top, (g.box.y1 + g.box.y2) / 2 - h / 2)));
        const extra = 0.12 * (v.lines - 1);
        for (const x of xs) {
          for (const y of ys) {
            const b = { x1: x, y1: y, x2: x + w, y2: y + h };
            const q = cost(b, k);
            q.c += extra;
            if (best && q.c >= best.c) continue;
            if (onText(b)) continue;
            best = { ...q, b, k, v };
          }
        }
      }
    }
    if (!best || best.c > here.c - 0.05) { res.left++; continue; }
    const to = best.b;
    if (best.v.content) { tx[0].text.content = best.v.content; res.wrapped++; }
    moveGroup(P, g.clips, best.v.box, to);
    g.box = to;
    res.moved++;
    if (best.k < 0.999) res.scaled++;
    if (best.cv.face >= 0.005 || best.cv.body >= 0.04) res.partly++;
  }
  return res;
}
/** (v1.12.4 name) */
export const avoidFaces = avoidPeople;

// ---------------------------------------------------------------------------------------------
// Sounds

/** The sounds the styles use (made by the caller: media.js ensureStockAudio). */
export const STYLE_SFX = ['pop', 'swipe', 'whoosh', 'cash', 'typing', 'click', 'bubble', 'glitchfx', 'ding', 'tick', 'notif', 'success', 'boing'];
const VOL = { pop: 0.5, swipe: 0.42, whoosh: 0.38, cash: 0.6, typing: 0.45, click: 0.22, bubble: 0.45, glitchfx: 0.32, ding: 0.5, tick: 0.55, notif: 0.45, success: 0.45, boing: 0.45 };
const PRIO = { tick: 10, cash: 9, ding: 8, success: 8, notif: 8, typing: 7, boing: 7, pop: 6, glitchfx: 5, swipe: 4, bubble: 4, whoosh: 3, click: 1 };
const ENTRANCE = {
  wordPop: 'pop', wordSlam: 'pop', wordRise: 'swipe', wordBlur: 'whoosh', wordSwing: 'swipe', lineReveal: 'swipe',
  charSlide: 'swipe', charDrop: 'pop', charWave: 'swipe', charFlip: 'pop', typeCursor: 'typing', scramble: 'glitchfx',
  highlighter: 'swipe', glitch: 'glitchfx', waveLoop: 'pop',
};
const ANIM_IN = {
  pop: 'pop', bounce: 'pop', zoomIn: 'pop', zoomOut: 'pop', spin: 'whoosh', converge: 'whoosh', typewriter: 'typing',
  slideLeft: 'swipe', slideRight: 'swipe', slideUp: 'swipe', slideDown: 'swipe', rise: 'swipe', blur: 'whoosh', fade: 'swipe',
};
// (a text that just appears or fades in: a softer sound, and a moving one at the same moment is heard instead)
const SOFT_IN = new Set(['none', 'fade', 'blur']);
const TRANSITION = { punch: 'swipe', leak: 'whoosh', pixelate: 'glitchfx', glitch: 'glitchfx', blur: 'whoosh' };

/** The sound cues of a built edit: [{ t, id, vol, prio }]. level: 'full' | 'graphics' (no subtitle clicks) | 'none'. */
export function sfxCues(P, { level = 'full' } = {}) {
  if (level === 'none') return [];
  const subtitleTracks = new Set(P.tracks.filter((t) => t.subtitle).map((t) => t.id));
  const cues = [];
  const add = (t, id, vol = VOL[id] ?? 0.45, prio = PRIO[id] ?? 5) => { if (t >= 0) cues.push({ t: r3(t), id, vol, prio }); };
  for (const c of P.clips) {
    // (a clip that says its own sound — the style's moments: a timer ticks, a colour circle bubbles — or none: null)
    if ((c.type === 'text' || c.type === 'sticker') && 'sound' in c) { if (c.sound) add(c.start, c.sound); continue; }
    if (c.type === 'text') {
      if (subtitleTracks.has(c.trackId)) { if (level === 'full') add(c.start, 'click', VOL.click * 0.8, PRIO.click); continue; }
      const m = c.text?.motion;
      if (m?.type === 'counter') { add(c.start, 'pop'); add(c.start + Math.min(c.duration * 0.7, 1.2 / (m.speed || 1)), 'cash'); continue; }
      if (m?.type === 'karaoke') { add(c.start, 'pop'); continue; }
      const kin = m?.type && ENTRANCE[m.type];
      if (kin && m.type.startsWith('word')) {
        // (one per word as it comes in — said: at its word time — up to four, at least 0.15 s apart)
        const n = String(c.text.content || '').split(/\s+/).filter(Boolean).length;
        const timed = Array.isArray(c.text.words) && c.text.words.length === n;
        let st = (m.stagger ?? 0.1) / (m.speed || 1);
        if (n > 1 && (n - 1) * st > 0.6 * c.duration) st = (0.6 * c.duration) / (n - 1);
        let last = -1;
        let made = 0;
        for (let i = 0; i < n && made < 4; i++) {
          const at = timed ? Math.max(0, c.text.words[i][0]) : i * st;
          if (at > c.duration - 0.1 || (last >= 0 && at - last < 0.15)) continue;
          add(c.start + at, kin);
          last = at;
          made++;
        }
        continue;
      }
      if (kin) { add(c.start, kin); continue; }
      const a = c.animIn?.type || 'none';
      const id = ANIM_IN[a] || 'pop';
      if (SOFT_IN.has(a)) add(c.start, id, VOL[id] * 0.7, 2); else add(c.start, id);
      continue;
    }
    if (c.type === 'sticker') { add(c.start, c.sticker?.badge ? 'ding' : 'bubble'); continue; }
    if (c.trackId === 'main') {
      // (a transition is centred on the cut: the sound starts as it begins; the first clip has none)
      if (c.start > 0.05 && c.transition?.type && c.transition.type !== 'none') add(Math.max(0, c.start - Math.min(0.2, (c.transition.duration || 0.4) / 2)), TRANSITION[c.transition.type] || 'whoosh');
      continue;
    }
    // a shot coming in over the talking (B-roll)
    if ((c.type === 'video' || c.type === 'image') && c.trackId !== 'main' && level === 'full' && c.start > 0.3) add(c.start, 'swipe', VOL.swipe * 0.7, PRIO.swipe - 1);
  }
  // not two sounds at once: the same sound within 0.15 s, or two sounds within 0.06 s — the stronger one stays
  cues.sort((a, b) => a.t - b.t || b.prio - a.prio);
  const out = [];
  for (const q of cues) {
    const clash = out.findLast((o) => q.t - o.t < (o.id === q.id ? 0.15 : 0.06));
    if (clash) { if (q.prio > clash.prio) out[out.indexOf(clash)] = q; continue; }
    out.push(q);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Put the sounds on "SFX" audio tracks (a second or third one only while a longer sound still plays, so none is cut).
 * sounds: id → { mediaId, duration } (made by the caller; a missing one is skipped). total: the edit's length.
 * Returns how many were placed.
 */
export function addStyleSfx(P, sounds, { level = 'full', total = Infinity } = {}) {
  const cues = sfxCues(P, { level }).filter((q) => sounds?.[q.id] && q.t < total - 0.05);
  const lanes = [];
  let placed = 0;
  for (const q of cues) {
    const s = sounds[q.id];
    const d = r3(Math.max(0.1, Math.min(s.duration || 0.5, total - q.t)));
    let lane = lanes.find((l) => l.end <= q.t + 1e-3);
    if (!lane) {
      if (lanes.length >= 3) continue; // (three sounds at once already: this one would only blur them)
      lane = { tr: { id: uid('t'), kind: 'audio', name: lanes.length ? `SFX ${lanes.length + 1}` : 'SFX', muted: false, hidden: false, locked: false }, end: -1 };
      lanes.push(lane);
      P.tracks.push(lane.tr);
    }
    lane.end = q.t + d;
    P.clips.push(makeClip('audio', { mediaId: s.mediaId, trackId: lane.tr.id, start: q.t, duration: d, in: 0, volume: q.vol, name: `SFX ${q.id}` }));
    placed++;
  }
  return placed;
}
