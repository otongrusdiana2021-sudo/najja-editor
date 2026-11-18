// Style Konsep, the finishing touches (v1.12.4) — after a style is built:
//   1. no text over a face: every text / sticker that would cover a face (detected per media, see faces.js) moves to
//      the free space above or below it (or beside it); a group shown together moves together, so its layout stays;
//   2. a sound for every text that appears and every move: a pop when words pop in, a swipe when they slide, a
//      "ka-ching" when the price counts, typing for a typewriter, a bubble for a sticker, a whoosh on a transition, a
//      soft click per subtitle line — on "SFX" audio tracks (a second/third only while a longer sound still plays).
// Pure: the face boxes come from the project's media (m.faces), the sounds from media made by the caller.
import { makeClip, kfValue } from './store.js';
import { uid } from './util.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Faces

/** A head-and-shoulders guess for a talking video whose faces were not found (no face model on this device). */
export const TALK_FACE_GUESS = [0.3, 0.12, 0.7, 0.48];

/** The faces of a media at source time t: [[x1,y1,x2,y2], …] (0–1 of the picture), or null when not known. */
export function facesAt(m, t) {
  const f = m?.faces;
  if (!f?.samples?.length) return null;
  const step = 1 / Math.max(0.1, f.fps || 2);
  let best = null;
  let bd = Infinity;
  for (const s of f.samples) {
    const d = Math.abs(s[0] - t);
    if (d < bd) { bd = d; best = s; }
  }
  return best && bd <= step * 1.6 ? best[1] : null;
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
  return { cx: W / 2 + (v('x') || 0) * W, cy: H / 2 + (v('y') || 0) * H, w: mw * k, h: mh * k, flip: !!c.flipH };
}

/**
 * The faces on the canvas at timeline time t, as canvas rectangles {x1,y1,x2,y2}, from every visible video or photo
 * (main track and overlays). A little room is added around each face (hair, chin). guess: a talking video without
 * face data is given TALK_FACE_GUESS.
 */
export function faceRectsAt(P, t, { talking = () => false } = {}) {
  const out = [];
  const media = new Map((P.media || []).map((m) => [m.id, m]));
  for (const c of P.clips) {
    if ((c.type !== 'video' && c.type !== 'image') || t < c.start - 1e-3 || t > c.start + c.duration + 1e-3) continue;
    const tr = P.tracks.find((x) => x.id === c.trackId);
    if (tr?.hidden) continue;
    const m = media.get(c.mediaId);
    const src = c.type === 'video' ? (c.in || 0) + (t - c.start) * (c.speed || 1) : 0;
    let boxes = facesAt(m, src);
    if (!boxes && c.type === 'video' && talking(m)) boxes = [TALK_FACE_GUESS];
    if (!boxes?.length) continue;
    const r = pictureRect(P, c, m, t);
    for (const [a, b, cc, d] of boxes) {
      const x1 = r.flip ? 1 - cc : a;
      const x2 = r.flip ? 1 - a : cc;
      let X1 = r.cx + (x1 - 0.5) * r.w;
      let X2 = r.cx + (x2 - 0.5) * r.w;
      let Y1 = r.cy + (b - 0.5) * r.h;
      let Y2 = r.cy + (d - 0.5) * r.h;
      const fw = X2 - X1;
      const fh = Y2 - Y1;
      X1 -= fw * 0.12; X2 += fw * 0.12; Y1 -= fh * 0.18; Y2 += fh * 0.12;
      // (only what is on the canvas)
      const R = { x1: Math.max(0, X1), y1: Math.max(0, Y1), x2: Math.min(P.width, X2), y2: Math.min(P.height, Y2) };
      if (R.x2 > R.x1 + 2 && R.y2 > R.y1 + 2) out.push(R);
    }
  }
  return out;
}

const CHAR_W = { Anton: 0.46, 'Bebas Neue': 0.42, Oswald: 0.48, 'Instrument Serif': 0.47, 'Playfair Display': 0.55 };
/** A text's or sticker's size on the canvas (measure: a real measurement { w, h } when the caller has one). */
export function itemBox(c, measure = null) {
  let w;
  let h;
  const m = measure?.(c);
  if (m) ({ w, h } = m);
  else if (c.type === 'sticker') { w = c.sticker?.badge ? 380 : 220; h = c.sticker?.badge ? 130 : 220; }
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

/**
 * Keep texts and stickers off faces. Texts shown together and near each other (a title and the line under it, a
 * price and its old price) form a group and move together, keeping their layout; each subtitle line is its own
 * group. A group on a face goes to the nearest free place above or below it (smaller when the room is short, beside
 * the face as a last resort), never onto another text shown at the same time.
 * Returns { checked, moved, scaled, partly, left } (partly: moved where it covers the least of a face that fills the
 * picture; left: no better place, it stays).
 */
export function avoidFaces(P, { measure = null, talking = () => false } = {}) {
  const W = P.width;
  const H = P.height;
  const subtitleTracks = new Set(P.tracks.filter((t) => t.subtitle).map((t) => t.id));
  const hiddenTracks = new Set(P.tracks.filter((t) => t.hidden).map((t) => t.id));
  const items = P.clips.filter((c) => (c.type === 'text' || c.type === 'sticker') && !hiddenTracks.has(c.trackId));
  const rectOf = new Map(items.map((c) => [c, itemRect(P, c, measure)]));
  // groups: near each other (less than 4% of the height apart) and shown together; subtitles alone
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = H * 0.04;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (subtitleTracks.has(a.trackId)) continue;
    const ra = rectOf.get(a);
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (subtitleTracks.has(b.trackId)) continue;
      if (!timeOverlap({ start: a.start, end: a.start + a.duration }, { start: b.start, end: b.start + b.duration })) continue;
      const rb = rectOf.get(b);
      const gx = Math.max(0, Math.max(ra.x1, rb.x1) - Math.min(ra.x2, rb.x2));
      const gy = Math.max(0, Math.max(ra.y1, rb.y1) - Math.min(ra.y2, rb.y2));
      if (gx < near * 2 && gy < near) parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map();
  items.forEach((c, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(c); });
  const groups = [...byRoot.values()].map((clips) => ({
    clips,
    sub: subtitleTracks.has(clips[0].trackId),
    start: Math.min(...clips.map((c) => c.start)),
    end: Math.max(...clips.map((c) => c.start + c.duration)),
    box: union(clips.map((c) => rectOf.get(c))),
  })).sort((a, b) => a.sub - b.sub || a.start - b.start);
  const res = { checked: 0, moved: 0, scaled: 0, partly: 0, left: 0 };
  const gap = H * 0.015;
  const top = H * 0.05;
  const facesIn = (start, end) => {
    const out = [];
    const n = Math.min(40, Math.max(2, Math.ceil((end - start) / 0.2)));
    for (let i = 0; i <= n; i++) out.push(...faceRectsAt(P, start + ((end - start) * i) / n, { talking }));
    return out;
  };
  const scaled = (b, f) => {
    const cx = (b.x1 + b.x2) / 2;
    const cy = (b.y1 + b.y2) / 2;
    const w = (b.x2 - b.x1) * f;
    const h = (b.y2 - b.y1) * f;
    return { x1: cx - w / 2, x2: cx + w / 2, y1: cy - h / 2, y2: cy + h / 2 };
  };
  /** A free place for these groups together (their layout kept, smaller if it must be): the box, or null. */
  const solve = (members, sizes, side = false) => {
    const box = union(members.map((m) => m.box));
    const start = Math.min(...members.map((m) => m.start));
    const end = Math.max(...members.map((m) => m.end));
    const sub = members[0].sub;
    // (subtitles low, or high on a close-up; other texts anywhere but the bottom fifth: the app's buttons and the
    // platform's caption are there)
    const bottom = H * (sub ? 0.9 : 0.8);
    const faces = facesIn(start, end);
    const others = groups.filter((o) => !members.includes(o) && members.some((m) => timeOverlap(o, m))).map((o) => o.box);
    // (a new place touches no face at all; the faces already have room around them)
    const onFace = (b) => faces.some((f) => overlapArea(b, f) > area(b) * 0.005);
    const onText = (b) => others.some((o) => overlapArea(b, o) > Math.min(area(o), area(b)) * 0.05);
    const free = (b) => b.x1 >= -1 && b.x2 <= W + 1 && b.y1 >= top - 1 && b.y2 <= bottom + 1 && !onFace(b) && !onText(b);
    for (const f of sizes) {
      const b = f === 1 ? box : scaled(box, f);
      const h = b.y2 - b.y1;
      const ys = [];
      for (const r of [...faces, ...others]) if (r.x2 > b.x1 && r.x1 < b.x2) ys.push(r.y1 - gap - h, r.y2 + gap);
      ys.push(top, bottom - h);
      const cand = ys.map((y) => y - b.y1);
      // (the shortest move; a subtitle rather down than up)
      cand.sort((p, q) => (sub ? (q > 0) - (p > 0) : 0) || Math.abs(p) - Math.abs(q));
      for (const dy of cand) {
        const to = { ...b, y1: b.y1 + dy, y2: b.y2 + dy };
        if (free(to)) return { box, to };
      }
    }
    if (side) {
      // beside the faces: the wider side, as small as it must be (not under 45%)
      const fu = union(faces);
      const left = fu.x1 - gap - W * 0.03;
      const right = W * 0.97 - (fu.x2 + gap);
      const f = Math.min(1, Math.max(left, right) / (box.x2 - box.x1));
      if (f >= 0.45) {
        const b = scaled(box, f);
        const w = b.x2 - b.x1;
        const x1 = right >= left ? fu.x2 + gap : fu.x1 - gap - w;
        const to = { ...b, x1, x2: x1 + w };
        if (free(to)) return { box, to };
      }
    }
    return null;
  };
  /** Last resort (a face fills the picture): the place that covers the least of it, smaller, if clearly better. */
  const leastBad = (g) => {
    const faces = facesIn(g.start, g.end);
    const others = groups.filter((o) => o !== g && timeOverlap(o, g)).map((o) => o.box);
    const covered = (b) => faces.reduce((a, f) => a + overlapArea(b, f), 0) / Math.max(1, area(b));
    const now = covered(g.box);
    let best = null;
    for (const f of [0.75, 0.6, 0.5]) {
      const b = scaled(g.box, f);
      const h = b.y2 - b.y1;
      for (let y = top; y + h <= H * 0.9; y += H * 0.01) {
        const to = { ...b, y1: y, y2: y + h };
        if (others.some((o) => overlapArea(to, o) > Math.min(area(o), area(to)) * 0.05)) continue;
        const c = covered(to) + f * 0.02; // (the bigger size wins a tie)
        if (!best || c < best.c - 1e-6) best = { c, to };
      }
    }
    return best && best.c < now * 0.5 ? { box: g.box, to: best.to } : null;
  };
  for (const g of groups) {
    const faces = facesIn(g.start, g.end);
    if (!faces.length) continue;
    res.checked++;
    // (on a face: one of its texts covers more than a touch of it)
    if (!g.clips.some((c) => { const r = rectOf.get(c); return faces.some((f) => overlapArea(r, f) > Math.min(area(f), area(r)) * 0.04); })) continue;
    let members = [g];
    let sol = solve(members, [1, 0.85, 0.72, 0.6, 0.5]);
    if (!sol && !g.sub) {
      // no room for it alone: with the other texts of the moment, as one smaller block
      const together = [g, ...groups.filter((o) => o !== g && !o.sub && timeOverlap(o, g))];
      if (together.length > 1) { sol = solve(together, [1, 0.85, 0.72, 0.6, 0.5]); if (sol) members = together; }
    }
    if (!sol && !g.sub) sol = solve(members, [], true);
    let partly = false;
    if (!sol) { sol = leastBad(g); partly = !!sol; }
    if (!sol) { res.left++; continue; }
    if (partly) res.partly++;
    const { box, to } = sol;
    const k = (to.x2 - to.x1) / Math.max(1, box.x2 - box.x1);
    const map = (r) => {
      const fx = (box.x1 + box.x2) / 2;
      const fy = (box.y1 + box.y2) / 2;
      const tx = (to.x1 + to.x2) / 2;
      const ty = (to.y1 + to.y2) / 2;
      return { x1: tx + (r.x1 - fx) * k, x2: tx + (r.x2 - fx) * k, y1: ty + (r.y1 - fy) * k, y2: ty + (r.y2 - fy) * k };
    };
    for (const m of members) {
      moveGroup(P, m.clips, box, to);
      m.box = map(m.box);
    }
    if (Math.abs(k - 1) > 1e-3) res.scaled++;
    res.moved++;
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Sounds

/** The sounds the styles use (made by the caller: media.js ensureStockAudio). */
export const STYLE_SFX = ['pop', 'swipe', 'whoosh', 'cash', 'typing', 'click', 'bubble', 'glitchfx', 'ding'];
const VOL = { pop: 0.5, swipe: 0.42, whoosh: 0.38, cash: 0.6, typing: 0.45, click: 0.22, bubble: 0.45, glitchfx: 0.32, ding: 0.5 };
const PRIO = { cash: 9, ding: 8, typing: 7, pop: 6, glitchfx: 5, swipe: 4, bubble: 4, whoosh: 3, click: 1 };
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
  const add = (t, id, vol = VOL[id], prio = PRIO[id]) => { if (t >= 0) cues.push({ t: r3(t), id, vol, prio }); };
  for (const c of P.clips) {
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
