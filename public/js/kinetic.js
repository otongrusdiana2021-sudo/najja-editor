// Teks kinetik (v1.12): text that moves word by word or letter by letter with spring motion — the look of
// code-made motion graphics (kinetic typography), drawn by Najja's own canvas renderer, so a text stays editable,
// the preview is the export, and it runs on an iPad.
//
// A text clip's animation is clip.text.motion = { type, spring, stagger, speed, color, out }:
//   type     one of KINETIC (below)
//   spring   how a piece moves into place: SPRINGS (smooth / bouncy / snappy / gentle); the preset's when absent
//   stagger  seconds between one piece and the next (shortened when the clip is too short for all of them)
//   speed    0.5–2: faster or slower motion
//   color    the highlight colour of "Sorot per kata" and "Stabilo"
//   out      'none' | 'reverse': at the end the pieces leave one after another the way they came
// Auto subtitles keep their words' times (clip.text.words = [[start, end], …] in seconds from the clip's start), so
// word pieces appear — or light up — exactly when each word is said.
//
// Pure functions except drawKinetic (canvas). Deterministic: the same time always gives the same picture, so the
// preview, a scrub and the export match frame for frame.
import { clamp, ease, hash } from './util.js';
import { nativeFilter } from './gpufx.js';

/** Spring feels: stiffness k and damping c of a unit mass. */
export const SPRINGS = {
  smooth: { k: 120, c: 22, name: 'Halus' },
  bouncy: { k: 190, c: 11, name: 'Memantul' },
  snappy: { k: 380, c: 30, name: 'Tegas' },
  gentle: { k: 60, c: 15.5, name: 'Pelan' },
};

/** A damped spring from 0 to 1 after t seconds (it may overshoot 1 and come back). */
export function spring(t, s = SPRINGS.smooth) {
  if (!(t > 0)) return 0;
  const w0 = Math.sqrt(s.k);
  const z = s.c / (2 * Math.sqrt(s.k));
  if (z < 0.999) {
    const wd = w0 * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
  }
  if (z <= 1.001) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const r = Math.sqrt(z * z - 1);
  const r1 = -w0 * (z - r);
  const r2 = -w0 * (z + r);
  return 1 + (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r1 - r2);
}
/** Seconds until a spring stays within about 1% of its end. */
export function settleTime(s = SPRINGS.smooth) {
  const w0 = Math.sqrt(s.k);
  const z = s.c / (2 * Math.sqrt(s.k));
  // (underdamped: the swing's envelope starts at 1/√(1−ζ²), not 1)
  if (z < 0.999) return Math.min(3, Math.log(100 / Math.sqrt(1 - z * z)) / (z * w0));
  return Math.min(3, 6.6 / (w0 * (z - Math.sqrt(Math.max(0, z * z - 1)))));
}

/**
 * The animations. group: 'in' (pieces come in one after another), 'emph' (through the whole clip), 'loop' (all the
 * time). unit: what moves on its own — a word, a letter or a line.
 */
export const KINETIC = [
  { id: 'none', name: 'Tidak ada', group: 'none' },
  { id: 'wordPop', name: 'Pop per kata', group: 'in', unit: 'word', spring: 'bouncy', stagger: 0.1 },
  { id: 'wordRise', name: 'Naik per kata', group: 'in', unit: 'word', spring: 'smooth', stagger: 0.09 },
  { id: 'wordSlam', name: 'Hentak', group: 'in', unit: 'word', spring: 'snappy', stagger: 0.16 },
  { id: 'wordBlur', name: 'Fokus per kata', group: 'in', unit: 'word', spring: 'gentle', stagger: 0.1 },
  { id: 'wordSwing', name: 'Ayun per kata', group: 'in', unit: 'word', spring: 'bouncy', stagger: 0.1 },
  { id: 'lineReveal', name: 'Tirai per baris', group: 'in', unit: 'line', spring: 'smooth', stagger: 0.14 },
  { id: 'charSlide', name: 'Huruf meluncur', group: 'in', unit: 'char', spring: 'smooth', stagger: 0.035 },
  { id: 'charDrop', name: 'Huruf jatuh', group: 'in', unit: 'char', spring: 'bouncy', stagger: 0.04 },
  { id: 'charWave', name: 'Gelombang', group: 'in', unit: 'char', spring: 'bouncy', stagger: 0.03 },
  { id: 'charFlip', name: 'Huruf berputar', group: 'in', unit: 'char', spring: 'snappy', stagger: 0.04 },
  { id: 'typeCursor', name: 'Ketik + kursor', group: 'in', unit: 'char', stagger: 0.055 },
  { id: 'scramble', name: 'Acak huruf', group: 'in', unit: 'char', stagger: 0.035 },
  { id: 'karaoke', name: 'Sorot per kata', group: 'emph', unit: 'word', spring: 'bouncy', color: '#FFE600' },
  { id: 'highlighter', name: 'Stabilo', group: 'emph', unit: 'line', spring: 'smooth', stagger: 0.25, color: '#FFE600' },
  { id: 'counter', name: 'Angka berjalan', group: 'emph', unit: 'line', sample: 'Rp149.000' },
  { id: 'waveLoop', name: 'Melambai', group: 'loop', unit: 'char' },
  { id: 'glitch', name: 'Glitch', group: 'loop', unit: 'char' },
];
export const KINETIC_GROUPS = [['in', 'Masuk'], ['emph', 'Penekanan'], ['loop', 'Terus-menerus']];
const BY_ID = new Map(KINETIC.map((k) => [k.id, k]));
export const kineticById = (id) => BY_ID.get(id) || null;

/** A complete motion object from a type and options (the preset's defaults filled in), or null for none/unknown. */
export function makeMotion(type, opts = {}) {
  const k = kineticById(type);
  if (!k || k.id === 'none') return null;
  const m = { type: k.id };
  if (k.spring) m.spring = SPRINGS[opts.spring] ? opts.spring : k.spring;
  if (k.stagger != null) m.stagger = clamp(Number(opts.stagger ?? k.stagger) || k.stagger, 0.005, 1);
  m.speed = clamp(Number(opts.speed ?? 1) || 1, 0.25, 3);
  if (k.color) m.color = /^#[0-9a-f]{3,8}$/i.test(String(opts.color || '')) ? opts.color : k.color;
  if (k.group === 'in') m.out = opts.out === 'reverse' ? 'reverse' : 'none';
  return m;
}

// ---------------------------------------------------------------------------------------------
// Pieces: where each word / letter / line of a text is (measured once per text and font)

const layouts = new Map();
const isSpace = (ch) => /\s/.test(ch);
/**
 * The pieces of a laid-out text (layoutText's result L, ctx.font already set to L.font): [{ text, x, w, y, line,
 * word, ci, wi }] — x is the piece's left edge, y its line's middle, word its word number in the whole text, ci the
 * number of its first letter in the whole text (spaces not counted), wi its letter number inside its word.
 */
export function pieces(ctx, L, tx, unit, epoch = 0) {
  const align = tx.align || 'center';
  const key = `${unit}|${epoch}|${L.font}|${tx.letterSpacing || 0}|${align}|${L.lines.join('\n')}`;
  const hit = layouts.get(key);
  if (hit) return hit;
  const out = [];
  const measure = (s) => (s ? ctx.measureText(s).width : 0);
  let word = 0;
  let ci = 0;
  L.lines.forEach((line, li) => {
    const lw = L.widths[li];
    const x0 = align === 'left' ? -L.w / 2 : align === 'right' ? L.w / 2 - lw : -lw / 2;
    const y = -L.h / 2 + li * L.lineH + L.lineH / 2;
    if (unit === 'line') {
      const letters = [...line].filter((ch) => !isSpace(ch)).length;
      if (letters) out.push({ text: line, x: x0, w: lw, y, line: li, word, ci, wi: 0 });
      word += (line.match(/\S+/g) || []).length;
      ci += letters;
      return;
    }
    const re = /\S+/g;
    let m;
    while ((m = re.exec(line))) {
      if (unit === 'word') {
        out.push({ text: m[0], x: x0 + measure(line.slice(0, m.index)), w: measure(m[0]), y, line: li, word, ci, wi: 0 });
        ci += [...m[0]].length;
      } else {
        let idx = m.index;
        let wi = 0;
        for (const ch of m[0]) {
          out.push({ text: ch, x: x0 + measure(line.slice(0, idx)), w: measure(ch), y, line: li, word, ci, wi });
          idx += ch.length;
          ci++;
          wi++;
        }
      }
      word++;
    }
  });
  layouts.set(key, out);
  if (layouts.size > 96) layouts.delete(layouts.keys().next().value);
  return out;
}

/** The number of words of a text (as pieces() counts them). */
export const wordCount = (content) => (String(content ?? '').match(/\S+/g) || []).length;

/**
 * When each piece starts (seconds from the clip's start). Word times (auto subtitles) when they match the words;
 * else one after another, `stagger` apart, all of them in within 70% of the clip.
 */
export function startTimes(list, motion, k, D, words = null) {
  const n = list.length;
  const sp = clamp(motion.speed || 1, 0.25, 3);
  const S = (k.spring ? settleTime(SPRINGS[motion.spring] || SPRINGS[k.spring]) : 0.3) / sp;
  let st = (motion.stagger ?? k.stagger ?? 0.08) / sp;
  if (n > 1 && (n - 1) * st + S > 0.7 * D) st = Math.max(0.008, (0.7 * D - S) / (n - 1));
  const nWords = list.length ? list[list.length - 1].word + 1 : 0;
  const timed = Array.isArray(words) && words.length === nWords && nWords > 0 && k.unit !== 'line'
    && words.every((w) => Array.isArray(w) && Number.isFinite(w[0]));
  if (timed) return list.map((p) => Math.max(0, words[p.word][0]) + (k.unit === 'char' ? p.wi * Math.min(st, 0.03) : 0));
  return list.map((p, i) => i * st);
}

/**
 * How a piece of an entrance looks at spring value s (0 → 1, may overshoot) and linear progress lp (0 → 1):
 * { dx, dy (em), sc, sx, sy, rot (degrees), alpha, blur (em), pivot (em below the middle) }.
 */
export function entrancePose(id, s, lp) {
  const r = { dx: 0, dy: 0, sc: 1, sx: 1, sy: 1, rot: 0, alpha: 1, blur: 0, pivot: 0 };
  const inv = 1 - s;
  switch (id) {
    case 'wordPop': r.sc = Math.max(0.01, 0.2 + 0.8 * s); r.alpha = clamp(lp * 3, 0, 1); break;
    case 'wordRise': r.dy = inv * 0.7; r.alpha = clamp(lp * 2, 0, 1); break;
    case 'wordSlam': r.sc = Math.max(0.01, 1 + inv * 1.6); r.alpha = clamp(lp * 4, 0, 1); break;
    case 'wordBlur': r.blur = Math.max(0, inv) * 0.22; r.sc = 1 + inv * 0.25; r.alpha = clamp(lp * 1.4, 0, 1); break;
    case 'wordSwing': r.rot = inv * -38; r.pivot = 0.42; r.alpha = clamp(lp * 3, 0, 1); break;
    case 'lineReveal': r.dy = inv * 1.25; break;
    case 'charSlide': r.dx = inv * 1.1; r.alpha = clamp(lp * 1.6, 0, 1); break;
    case 'charDrop': r.dy = -inv * 1.4; r.alpha = clamp(lp * 4, 0, 1); break;
    case 'charWave': r.dy = inv * 0.8; r.rot = inv * 28; r.alpha = clamp(lp * 3, 0, 1); break;
    case 'charFlip': r.sy = Math.max(0.01, s); r.alpha = clamp(lp * 4, 0, 1); break;
    default: break;
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Numbers that count (Angka berjalan)

/** The text with every number at `p` (0 → 1) of its value, written the same way (Rp149.000 → Rp74.500). */
export function countText(content, p) {
  return String(content ?? '').replace(/\d[\d.,]*\d|\d/g, (tok) => {
    // a decimal part: a comma (or a dot) with 1–2 digits at the end
    const dec = /([.,])(\d{1,2})$/.exec(tok);
    const intPart = dec && !/[.,]\d{3}$/.test(tok) ? tok.slice(0, dec.index) : tok;
    const tail = intPart === tok ? '' : tok.slice(intPart.length);
    const sep = (/\d([.,])\d{3}(?!\d)/.exec(intPart) || [])[1] || '';
    const digits = intPart.replace(/[.,]/g, '');
    const v = Math.round(Number(digits) * clamp(p, 0, 1));
    let s = String(v);
    if (sep) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    return s + (p >= 1 ? tail : tail.replace(/\d/g, '0'));
  });
}

// ---------------------------------------------------------------------------------------------
// Drawing

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@$';
const glyphFor = (ch, n) => {
  const g = GLYPHS[Math.floor(hash(n) * GLYPHS.length)];
  return ch === ch.toLowerCase() && ch !== ch.toUpperCase() ? g.toLowerCase() : g;
};

/**
 * Draw a text clip's kinetic animation. ctx: at the clip's centre, the clip's transform applied, textBaseline middle.
 * o: { local (seconds into the clip), D (its length), L (layoutText), tx (the text), paint(ctx, str, x, y, fill),
 * fillAt(y, moved) (the text's fill for a piece on line middle y; moved: the context is translated to that piece, so a
 * gradient keeps its place on the letters), reveal (0–1, the clip's own typewriter), pxScale, epoch }.
 * Returns false when the text has no kinetic animation (the caller draws it as usual).
 */
export function drawKinetic(ctx, o) {
  const { tx, L, local, D } = o;
  const motion = tx.motion;
  const k = kineticById(motion?.type);
  if (!k || k.id === 'none') return false;
  const size = tx.size || 60;
  const sp = clamp(motion.speed || 1, 0.25, 3);
  const S = SPRINGS[motion.spring] || SPRINGS[k.spring] || SPRINGS.smooth;
  const list = pieces(ctx, L, tx, k.unit, o.epoch);
  if (!list.length) return true;
  const totalLetters = list.length ? list[list.length - 1].ci + [...list[list.length - 1].text].filter((ch) => !isSpace(ch)).length : 0;
  const budget = o.reveal >= 1 ? Infinity : Math.floor(totalLetters * o.reveal);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const lineAlpha = new Map();
  const seenLine = (li, a) => lineAlpha.set(li, Math.min(lineAlpha.has(li) ? lineAlpha.get(li) : 1, a));

  // ---- through the whole clip ----
  if (k.id === 'counter') {
    const p = ease.outCubic(clamp((local * sp) / 1.2, 0, 1));
    const lines = countText(L.lines.join('\n'), p).split('\n');
    lines.forEach((line, li) => {
      if (!line) return;
      const w = ctx.measureText(line).width;
      const align = tx.align || 'center';
      const x = align === 'left' ? -L.w / 2 : align === 'right' ? L.w / 2 - w : -w / 2;
      const y = -L.h / 2 + li * L.lineH + L.lineH / 2;
      o.paint(ctx, line, x, y, o.fillAt(y));
    });
    return true;
  }
  if (k.id === 'highlighter') {
    const starts = startTimes(list, motion, k, D);
    list.forEach((pc, i) => {
      if (pc.ci >= budget) return;
      const wp = clamp(spring((local - 0.15 - starts[i]) * sp, S), 0, 1.04);
      if (wp > 0.001) {
        ctx.save();
        ctx.fillStyle = motion.color || k.color;
        ctx.globalAlpha *= 0.92;
        // (a marker block behind the whole line, a little wider than the words)
        const padX = size * 0.14;
        const h = size * 0.98;
        const w = (pc.w + padX * 2) * wp;
        const x = pc.x - padX;
        const y = pc.y + size * 0.04 - h / 2;
        ctx.beginPath();
        const r = Math.min(size * 0.08, h / 2, w / 2);
        ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
        ctx.fill();
        ctx.restore();
      }
      o.paint(ctx, pc.text, pc.x, pc.y, o.fillAt(pc.y));
    });
    return true;
  }
  if (k.id === 'karaoke') {
    const words = Array.isArray(tx.words) && tx.words.length === list.length ? tx.words : null;
    const step = (D * 0.95) / list.length;
    let active = -1;
    for (let i = 0; i < list.length; i++) if (local >= (words ? words[i][0] : i * step)) active = i;
    list.forEach((pc, i) => {
      if (pc.ci >= budget) return;
      const on = i === active;
      const u = (local - (words ? words[i][0] : i * step)) * sp;
      const sc = on ? 1 + 0.12 * spring(u, S) : 1;
      ctx.save();
      ctx.translate(pc.x + pc.w / 2, pc.y);
      ctx.scale(sc, sc);
      o.paint(ctx, pc.text, -pc.w / 2, 0, on ? motion.color || k.color : o.fillAt(pc.y, true));
      ctx.restore();
    });
    return true;
  }
  if (k.id === 'waveLoop' || k.id === 'glitch') {
    list.forEach((pc, i) => {
      if (pc.ci >= budget) return;
      let dx = 0;
      let dy = 0;
      if (k.id === 'waveLoop') dy = -0.14 * Math.sin(Math.PI * 2 * (local * 1.1 * sp - i * 0.09));
      const burst = k.id === 'glitch' && hash(Math.floor(local * 8 * sp) + 7) > 0.55;
      if (burst && hash(i * 31 + Math.floor(local * 24 * sp)) > 0.62) {
        dx = (hash(i * 7 + Math.floor(local * 30)) - 0.5) * 0.16;
        dy = (hash(i * 13 + Math.floor(local * 30)) - 0.5) * 0.08;
      }
      const x = pc.x + dx * size;
      const y = pc.y + dy * size;
      if (burst) {
        ctx.save();
        ctx.globalAlpha *= 0.75;
        ctx.fillStyle = '#ff2a6d';
        ctx.fillText(pc.text, x - size * 0.045, y);
        ctx.fillStyle = '#05d9e8';
        ctx.fillText(pc.text, x + size * 0.045, y);
        ctx.restore();
      }
      o.paint(ctx, pc.text, x, y, o.fillAt(pc.y));
    });
    return true;
  }

  // ---- entrances ----
  const starts = startTimes(list, motion, k, D, tx.words);
  const n = list.length;
  const reverse = motion.out === 'reverse';
  const outTotal = Math.min(0.6, D * 0.25);
  const outStagger = n > 1 ? Math.min(motion.stagger ?? k.stagger ?? 0.06, (outTotal * 0.5) / (n - 1)) : 0;
  let lastShown = -1;
  list.forEach((pc, i) => {
    if (pc.ci >= budget) return;
    const u = (local - starts[i]) * sp;
    if (k.id === 'typeCursor') {
      if (u < 0) return;
      lastShown = i;
      o.paint(ctx, pc.text, pc.x, pc.y, o.fillAt(pc.y));
      return;
    }
    if (k.id === 'scramble') {
      const settled = u >= 0.28;
      const ch = settled ? pc.text : glyphFor(pc.text, i * 977 + Math.floor(local * 22));
      ctx.save();
      if (!settled) ctx.globalAlpha *= u < 0 ? 0.45 : 0.85;
      const w = settled ? pc.w : ctx.measureText(ch).width;
      o.paint(ctx, ch, pc.x + (pc.w - w) / 2, pc.y, o.fillAt(pc.y));
      ctx.restore();
      seenLine(pc.line, 1);
      return;
    }
    if (u <= 0) { seenLine(pc.line, 0); return; }
    let r = entrancePose(k.id, spring(u, S), clamp(u / 0.35, 0, 1));
    if (reverse) {
      const q = clamp((local - (D - outTotal) - i * outStagger) / (outTotal * 0.5), 0, 1);
      if (q > 0) {
        const back = entrancePose(k.id, 1 - ease.inCubic(q), 1);
        r = { ...back, alpha: back.alpha * (1 - q) };
      }
    }
    if (r.alpha <= 0.002) { seenLine(pc.line, 0); return; }
    seenLine(pc.line, r.alpha);
    ctx.save();
    ctx.globalAlpha *= r.alpha;
    if (k.id === 'lineReveal') {
      const pad = (tx.stroke?.enabled ? tx.stroke.width : 0) + size * 0.05;
      ctx.beginPath();
      ctx.rect(pc.x - pad, pc.y - L.lineH / 2 - pad, pc.w + pad * 2, L.lineH + pad * 2);
      ctx.clip();
    }
    const cx = pc.x + pc.w / 2;
    ctx.translate(cx + r.dx * size, pc.y + (r.dy + r.pivot) * size);
    if (r.rot) ctx.rotate((r.rot * Math.PI) / 180);
    ctx.scale(r.sc * r.sx, r.sc * r.sy);
    if (r.pivot) ctx.translate(0, -r.pivot * size);
    const fill = o.fillAt(pc.y, true);
    const blurPx = r.blur * size * (o.pxScale || 1);
    if (blurPx > 0.3) {
      if (nativeFilter()) {
        ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
        o.paint(ctx, pc.text, -pc.w / 2, 0, fill);
        ctx.filter = 'none';
      } else {
        // (no canvas filter here, e.g. Safari: a soft look from a few faint copies around it)
        const d = r.blur * size * 0.6;
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * 0.3;
        for (const [ox, oy] of [[-d, 0], [d, 0], [0, -d], [0, d]]) o.paint(ctx, pc.text, -pc.w / 2 + ox, oy, fill);
        ctx.globalAlpha = a * clamp(1 - r.blur * 3, 0.35, 1);
        o.paint(ctx, pc.text, -pc.w / 2, 0, fill);
      }
    } else o.paint(ctx, pc.text, -pc.w / 2, 0, fill);
    ctx.restore();
  });
  if (k.id === 'typeCursor') {
    const typing = lastShown < n - 1;
    const done = lastShown >= 0 ? starts[lastShown] : 0;
    if (typing || Math.floor((local - done) * 2.2) % 2 === 0) {
      const pc = lastShown >= 0 ? list[lastShown] : list[0];
      const x = lastShown >= 0 ? pc.x + pc.w + size * 0.04 : pc.x;
      ctx.save();
      const f = o.fillAt(pc.y);
      ctx.fillStyle = typeof f === 'string' ? f : tx.color || '#ffffff';
      ctx.fillRect(x, pc.y - size * 0.45, Math.max(2, size * 0.07), size * 0.9);
      ctx.restore();
    }
  }
  o.lineAlpha = lineAlpha;
  return true;
}

/** Forget measured layouts (fonts finished loading: the widths change). */
export function resetKineticLayouts() { layouts.clear(); }
