// Style Konsep (v1.10): three ready-made ways of editing a product video, taken from three sample videos.
//
//   showcase   Showcase Clean     product shots only, music, one part per variant, zoom punches, size line
//   editorial  Editorial Review   you talk about the product; jump cuts, punch-ins, big stacked keywords, price label
//   storypop   Story Pop          you tell a story; a hook in single words, B-roll, stickers, a pop price
//
// The AI is the director, Najja the craftsman: an edit plan says WHAT happens (which words become big text, where
// the price is said, what is cut, which shot goes where), the style builds HOW it looks (fonts, timing, colours,
// transitions) the same way every time. The plan comes from the AI (MCP apply_style) or, without an AI, from
// autoPlan() below. Everything here is pure (no browser): stylerun.js does the transcription, the copy of the project
// and the music, then calls buildStyle() inside one store.mutate, so one undo takes the whole edit back.
//
// Times in a plan are "speech times": the talking videos back to back, in project order, before any cut — the times
// get_transcript returns.
import { makeClip, MIN_CLIP } from './store.js';
import { TEXT_PRESETS, DEFAULT_TEXT } from './presets.js';
import { clone, deepMerge, uid } from './util.js';

export const STYLES = [
  {
    id: 'showcase', name: 'Showcase Clean', short: 'Pamer varian produk',
    about: 'Tanpa ngomong, cuma musik. Satu bagian per varian, zoom punch, nama dan ukuran produk, garis ukuran.',
    needs: 'Klip produk (boleh tanpa suara)', filter: 'vividWarm', music: 'upbeat', speech: false,
  },
  {
    id: 'editorial', name: 'Editorial Review', short: 'Review produk gaya majalah',
    about: 'Kamu ngomong di kamera. Jeda dipotong, punch-in, kata kunci besar menumpuk, subtitle kecil, label harga, outro merek.',
    needs: 'Video kamu ngomong', filter: 'warmMatte', music: 'lofi', speech: true,
  },
  {
    id: 'storypop', name: 'Story Pop', short: 'Bercerita dengan B-roll',
    about: 'Hook kata per kata, B-roll sesuai kalimat, stiker, harga turun yang meletup, subtitle tebal.',
    needs: 'Video kamu ngomong + B-roll / klip produk', filter: 'cleanNatural', music: 'upbeat', speech: true,
  },
];
export const styleById = (id) => STYLES.find((s) => s.id === id) || null;

// ---------------------------------------------------------------------------------------------
// Material: which media are talking (speech) and which are shots, and how well each style fits them.
const visualMedia = (P) => P.media.filter((m) => !m.stock && !m.cover && (m.type === 'video' || m.type === 'image'));
const speechOf = (P, id) => P.speech?.[id] || null;
/** A media talks when its transcript has a few words that cover a good part of it. */
export function isTalking(P, m) {
  const sp = speechOf(P, m.id);
  if (!sp?.words?.length) return false;
  const said = sp.words.reduce((a, w) => a + Math.max(0, w.e - w.s), 0);
  return sp.words.length >= 4 && said >= Math.min(3, (m.duration || 0) * 0.25);
}
/** The project's material: talking videos, shots, and whether a transcript is still missing for some video. */
export function material(P) {
  const vis = visualMedia(P);
  const talks = [];
  const shots = [];
  let unknown = 0;
  for (const m of vis) {
    if (m.type === 'video' && m.hasAudio !== false && !speechOf(P, m.id)) unknown++;
    if (m.type === 'video' && isTalking(P, m)) talks.push(m); else shots.push(m);
  }
  const talkSec = talks.reduce((a, m) => a + (m.duration || 0), 0);
  return { talks, shots, talkSec, unknown, total: vis.length };
}
/** ✓ / ⚠ / ✗ for each style on this material, and the style that fits best. */
export function checkMaterial(P) {
  const M = material(P);
  const pending = M.unknown > 0;
  const n = M.shots.length;
  const out = {};
  out.showcase = M.total === 0 ? { ok: 'no', note: 'Belum ada video atau foto.' }
    : n + M.talks.length >= 2 ? { ok: 'yes', note: `${n + M.talks.length} klip untuk dipamerkan${M.talks.length ? ' (suara orang diganti musik)' : ''}.` }
      : { ok: 'warn', note: 'Hanya 1 klip: tambah klip produk lain supaya ada pergantian.' };
  const talkNote = pending ? 'Bahan belum diperiksa: suara akan ditranskrip dulu.' : 'Butuh video kamu ngomong (belum ada suara orang).';
  out.editorial = M.talkSec >= 5 ? { ok: 'yes', note: `${Math.round(M.talkSec)} dtk kamu ngomong${n ? `, ${n} klip produk untuk sisipan` : ''}.` }
    : { ok: pending ? 'warn' : 'no', note: talkNote };
  out.storypop = M.talkSec >= 5 ? (n >= 2 ? { ok: 'yes', note: `${Math.round(M.talkSec)} dtk ngomong + ${n} B-roll.` } : { ok: 'warn', note: 'Belum ada B-roll: bagian B-roll memakai potongan videomu sendiri.' })
    : { ok: pending ? 'warn' : 'no', note: talkNote };
  let recommended = 'showcase';
  if (M.talkSec >= 5) recommended = n >= 3 ? 'storypop' : 'editorial';
  else if (pending) recommended = null;
  return { styles: out, recommended, talks: M.talks.map((m) => m.id), shots: M.shots.map((m) => m.id), talkSec: M.talkSec, pending };
}

// ---------------------------------------------------------------------------------------------
// The talking videos back to back ("speech time"), their words, and sentences.
export function speechTimeline(P) {
  const { talks } = material(P);
  const sources = [];
  const words = [];
  let t = 0;
  for (const m of talks) {
    const sp = speechOf(P, m.id);
    const d = m.duration || Math.max(0, ...sp.words.map((w) => w.e));
    sources.push({ media_id: m.id, name: m.name, start: r3(t), duration: r3(d) });
    for (const w of sp.words) words.push({ i: words.length, w: w.w, s: r3(t + w.s), e: r3(t + w.e), media: m.id });
    t += d;
  }
  return { sources, words, duration: r3(t), sentences: sentencesOf(words), language: talks.map((m) => speechOf(P, m.id)?.lang).find(Boolean) || null };
}
const r3 = (v) => Math.round(v * 1000) / 1000;
export function sentencesOf(words) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0].s, end: cur.at(-1).e, text: cur.map((w) => w.w).join(' ').replace(/\s+([,.!?…])/g, '$1').trim(), words: [cur[0].i, cur.at(-1).i] }); cur = []; };
  for (const w of words) {
    if (cur.length && (w.s - cur.at(-1).e > 0.7 || w.media !== cur.at(-1).media)) flush();
    cur.push(w);
    if (/[.!?…]$/.test(w.w.trim())) flush();
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Automatic plan (no AI): silences out, the strongest words of a sentence big, the price where it is said.
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
const STOP = new Set(('yang dan di ke dari ini itu aku saya gue gw kamu lo lu kita kami mereka dia ada untuk buat dengan jadi juga udah sudah aja saja nih kan ya sih lagi bisa karena tapi kalau kalo gitu gini tuh deh dong kok pun para oleh pada atau agar supaya sama per tau tahu mau akan masih belum lebih paling sangat the a an and to of is it in on for this that you i so oke ok nah terus trus')
  .split(' '));
const FILLER = new Set(['eh', 'em', 'emm', 'eee', 'ee', 'hmm', 'hm', 'anu', 'uh', 'um', 'ehm', 'mmm']);
const EMPHASIS = new Set(('murah diskon promo gratis hemat best seller terlaris original asli premium awet kuat tahan anti air muat ringan baru cuma hanya limited spesial harga kualitas bagus keren lucu cantik mewah elegan praktis nyaman lega besar kecil jumbo mini medium ukuran size travel tas bag murmer worth sale flash hari ini sekarang buruan stok habis viral favorit')
  .split(' '));
const isNum = (w) => /\d/.test(w);
/** A word as shown: no punctuation around it (inner dots/commas of numbers stay). */
export const cleanWord = (w) => String(w || '').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, '');
const PRICE_WORD = /^(rp|ribu|rb|k|jt|juta|rupiah|rebu)$/;

function wordScore(w, nameWords) {
  const n = norm(w.w);
  if (!n || FILLER.has(n)) return -9;
  if (STOP.has(n)) return -4;
  let s = 0;
  if (isNum(n)) s += 3;
  if (PRICE_WORD.test(n)) s += 2;
  if (EMPHASIS.has(n)) s += 2;
  if (nameWords.has(n)) s += 3;
  if (n.length >= 6) s += 1;
  return s;
}

/** Ranges to cut: pauses longer than `gap` (keeping a breath at each side), filler words, the silence before/after. */
export function silenceCuts(words, total, { gap = 0.5, keep = 0.14 } = {}) {
  const cuts = [];
  const talk = words.filter((w) => !FILLER.has(norm(w.w)));
  if (!talk.length) return cuts;
  if (talk[0].s > keep + 0.05) cuts.push({ start: 0, end: talk[0].s - keep });
  for (let i = 1; i < talk.length; i++) {
    const a = talk[i - 1].e;
    const b = talk[i].s;
    const sameSource = talk[i - 1].media === talk[i].media;
    if (b - a > gap) cuts.push({ start: a + keep, end: b - keep });
    else if (!sameSource && b - a > keep * 2) cuts.push({ start: a + keep, end: b - keep });
  }
  const last = talk.at(-1).e;
  if (total - last > 0.45) cuts.push({ start: last + 0.3, end: total });
  return cuts;
}

const fmtThousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
/** "149000" / 149000 / "149rb" / "149 ribu" / "Rp 149.000" → "Rp149.000"; other text as it is. */
export function formatPrice(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  const m = /^(?:rp\.?\s*)?(\d[\d.,]*)\s*(rb|ribu|k|jt|juta)?$/i.exec(s);
  if (!m) return s;
  let n = Number(m[1].replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return s;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'rb' || unit === 'ribu' || unit === 'k') n *= 1000;
  if (unit === 'jt' || unit === 'juta') n *= 1e6;
  return `Rp${fmtThousands(n)}`;
}

/** Where the price is said: the first number next to a price word ("149 ribu", "Rp149.000", "harga… 149"). */
export function findPriceMention(words) {
  for (let i = 0; i < words.length; i++) {
    const n = norm(words[i].w);
    if (!isNum(n)) continue;
    const near = words.slice(Math.max(0, i - 3), i + 3).map((w) => norm(w.w));
    if (near.some((x) => PRICE_WORD.test(x) || /^(harga|harganya|cuma|hanya|diskon|promo)$/.test(x)) || /^rp/.test(n) || n.replace(/\D/g, '').length >= 4) return { start: words[i].s, index: i };
  }
  return null;
}

/**
 * The automatic plan of a style. words: speech-time words; product: { name, variant, price, price_discount, brand }.
 * Keyword groups: per sentence the best run of 1–3 words (numbers, price words, product words, strong words), at most
 * one group every `every` seconds.
 */
export function autoPlan(styleId, { words = [], duration = 0, product = {} } = {}) {
  const nameWords = new Set(`${product.name || ''} ${product.variant || ''}`.split(/\s+/).map(norm).filter((x) => x.length > 2));
  const plan = { style: styleId, cuts: [], keywords: [], auto_cut_silence: true, subtitles: true };
  if (!words.length) return plan;
  const every = styleId === 'storypop' ? 3.8 : 4.5;
  let lastAt = -Infinity;
  for (const sent of sentencesOf(words)) {
    const ws = words.slice(sent.words[0], sent.words[1] + 1);
    const runs = [];
    for (let i = 0; i < ws.length; i++) {
      for (let len = 1; len <= 3 && i + len <= ws.length; len++) {
        const run = ws.slice(i, i + len);
        const sc = run.map((w) => wordScore(w, nameWords));
        if (sc.some((x) => x < 0) && len > 1) break;
        // (the price itself is shown by the price label, not as keywords)
        if (run.some((w) => isNum(norm(w.w)) || PRICE_WORD.test(norm(w.w)))) continue;
        const score = sc.reduce((a, b) => a + b, 0) + (len - 1) * 0.6;
        if (sc[0] > 0 && score >= 3) runs.push({ score, run });
      }
    }
    // the strongest run of the sentence that is not too close to the previous keyword
    const best = runs.sort((a, b) => b.score - a.score).find((r) => r.run[0].s - lastAt >= every);
    if (!best) continue;
    plan.keywords.push({ start: best.run[0].s, words: best.run.map((w) => cleanWord(w.w).toUpperCase()) });
    lastAt = best.run[0].s;
  }
  const pm = findPriceMention(words);
  if (pm || product.price || product.price_discount) {
    plan.price = { start: pm ? pm.start : r3(duration * 0.55), normal: product.price || '', discount: product.price_discount || '' };
  }
  if (styleId === 'storypop') {
    // the hook: an early question ("butuh lebih dari satu size?"), else the start of the first sentence; ≤ 6 words
    const ss = sentencesOf(words);
    const q = ss.slice(0, 3).find((x) => /\?$/.test(x.text));
    const pick = q || ss[0];
    if (pick) {
      const ws = words.slice(pick.words[0], pick.words[1] + 1);
      const run = q ? ws.slice(-6) : ws.slice(0, 5);
      plan.hook = { start: run[0].s, words: run.map((w) => cleanWord(w.w)).filter(Boolean), question: !!q };
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Building: cuts → main track; then the layers of the style.
function mergeRanges(list, total) {
  const rs = list.map((c) => ({ start: Math.max(0, +c.start || 0), end: Math.min(total, +c.end || 0) })).filter((c) => c.end - c.start > 0.02).sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of rs) { const last = out.at(-1); if (last && r.start <= last.end + 0.05) last.end = Math.max(last.end, r.end); else out.push({ ...r }); }
  return out;
}
/** Kept ranges and a map from speech time to edited time. Kept pieces under 0.25 s go too (a blink of picture). */
export function cutMap(total, cuts) {
  const C = mergeRanges(cuts, total);
  let keeps = [];
  let t = 0;
  for (const c of C) { if (c.start > t) keeps.push({ start: t, end: c.start }); t = Math.max(t, c.end); }
  if (t < total) keeps.push({ start: t, end: total });
  keeps = keeps.filter((k) => k.end - k.start >= 0.25);
  let acc = 0;
  for (const k of keeps) { k.out = acc; acc += k.end - k.start; }
  const map = (a) => {
    for (const k of keeps) {
      if (a < k.start) return k.out;
      if (a <= k.end) return k.out + (a - k.start);
    }
    return acc;
  };
  return { keeps, map, duration: acc };
}

function textStyle(preset, over = {}) {
  const p = TEXT_PRESETS.find((x) => x.id === preset) || TEXT_PRESETS[0];
  const base = clone(DEFAULT_TEXT);
  deepMerge(base, clone(p.style));
  base.preset = p.id;
  return deepMerge(base, over);
}
const noTr = (c) => !c.transition || c.transition.type === 'none';
const coverScale = (m, P) => (m?.width && m?.height ? Math.max(P.width / m.width, P.height / m.height) / Math.min(P.width / m.width, P.height / m.height) : 1);

/** Where the words of a keyword group are said: each word found in order near `start` (else 0.3 s after the last). */
export function placeWords(words, group) {
  const out = [];
  let i = Math.max(0, words.findIndex((w) => w.e >= (group.start ?? 0) - 0.6));
  let t = group.start ?? words[i]?.s ?? 0;
  for (const raw of group.words || []) {
    const want = norm(raw);
    let found = -1;
    for (let j = i; j < Math.min(words.length, i + 14); j++) { if (want && norm(words[j].w) === want) { found = j; break; } }
    if (found >= 0) { t = words[found].s; out.push({ text: raw, s: t, e: words[found].e }); i = found + 1; } else { out.push({ text: raw, s: t, e: t + 0.3 }); t += 0.3; }
  }
  return out;
}

/** Subtitle lines from words: up to maxChars, split at pauses and sentence ends. */
export function lines(words, maxChars = 28) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0].s, end: cur.at(-1).e, text: cur.map((w) => w.w.trim()).join(' ').replace(/\s+([,.!?…])/g, '$1') }); cur = []; };
  for (const w of words) {
    if (FILLER.has(norm(w.w))) continue;
    const text = [...cur, w].map((x) => x.w.trim()).join(' ');
    if (cur.length && (text.length > maxChars || w.s - cur.at(-1).e > 0.6)) flush();
    cur.push(w);
    if (/[.!?…]$/.test(w.w.trim())) flush();
  }
  flush();
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    out[i].end = Math.min(next ? next.start : Infinity, Math.max(out[i].end + 0.25, out[i].start + 0.6));
  }
  return out;
}

/**
 * Build a style's edit into project P (a copy of the user's project: its clips are replaced). opts:
 *   plan        the edit plan (AI or autoPlan); product { name, variant, price, price_discount, brand }
 *   music       { mediaId, duration } of the background music, or null
 * Returns a summary { style, duration, cuts, keywords, ... }.
 */
export function buildStyle(P, styleId, opts = {}) {
  const st = styleById(styleId);
  if (!st) throw new Error(`Style tidak dikenal: ${styleId}`);
  const product = opts.product || {};
  // a vertical video (the samples are 9:16)
  Object.assign(P, { aspect: '9:16', width: 1080, height: 1920 });
  P.background = { ...(P.background || {}), mode: 'color', color: '#000000' };
  P.magnet = true;
  P.clips = [];
  P.tracks = [{ id: 'main', kind: 'main', name: 'Utama', muted: false, hidden: false, locked: false }];
  P.style = { id: styleId, at: Date.now() };
  if (styleId === 'editorial') return buildEditorial(P, st, product, opts);
  if (styleId === 'showcase') return buildShowcase(P, st, product, opts);
  return buildStoryPop(P, st, product, opts);
}

// ---- shared pieces ---------------------------------------------------------------------------
function newTrack(P, kind, name, extra = {}) {
  const tr = { id: uid('t'), kind, name, muted: false, hidden: false, locked: false, ...extra };
  const firstVisual = P.tracks.findIndex((t) => t.kind !== 'effect');
  if (kind === 'audio') P.tracks.push(tr);
  else if (kind === 'effect') P.tracks.unshift(tr);
  else P.tracks.splice(Math.max(0, firstVisual), 0, tr);
  return tr;
}
/** A text layer that never overlaps itself: a new track when the time is taken. */
function lane(P, kind, name) {
  const lanes = [];
  return (clip) => {
    let tr = lanes.find((l) => !P.clips.some((c) => c.trackId === l.id && c.start < clip.start + clip.duration - 1e-3 && c.start + c.duration > clip.start + 1e-3));
    if (!tr) { tr = newTrack(P, kind, name); lanes.push(tr); }
    clip.trackId = tr.id;
    P.clips.push(clip);
    return clip;
  };
}
function text(content, style, props) {
  const { preset = 'default', ...over } = style;
  const tx = textStyle(preset, over);
  tx.content = content;
  return makeClip('text', { text: tx, name: String(content).split('\n')[0].slice(0, 40), ...props });
}
function addMusic(P, music, total, volume) {
  if (!music?.mediaId || !(music.duration > 1) || total < 1) return 0;
  const tr = newTrack(P, 'audio', 'Musik');
  let t = 0;
  let n = 0;
  while (t < total - 0.05 && n < 60) {
    const d = Math.min(music.duration, total - t);
    P.clips.push(makeClip('audio', { mediaId: music.mediaId, trackId: tr.id, start: r3(t), duration: r3(d), in: 0, volume, fadeIn: n ? 0 : 0.6, fadeOut: t + d >= total - 0.05 ? Math.min(1.2, d / 2) : 0, name: 'Musik' }));
    t += d;
    n++;
  }
  return n;
}
function addSubtitleTrack(P, cues, style, { avoid = [], y = 0.34, anim = 'fade', upper = false, lower = false } = {}) {
  const tr = newTrack(P, 'text', 'Subtitle', { subtitle: true });
  let n = 0;
  for (const c of cues) {
    const d = c.end - c.start;
    if (d < 0.15) continue;
    // (no subtitle under a big keyword or the price: one message at a time)
    if (avoid.some((a) => Math.min(a.end, c.end) - Math.max(a.start, c.start) > d * 0.5)) continue;
    const clip = text(upper ? c.text.toUpperCase() : lower ? c.text.toLowerCase() : c.text, style, { start: r3(c.start), duration: r3(Math.max(MIN_CLIP, d)), y, animIn: { type: anim, duration: 0.15 } });
    clip.trackId = tr.id;
    P.clips.push(clip);
    n++;
  }
  return n;
}
/** The main track from kept speech ranges: one clip per piece (split at media ends and at `marks`), punch-ins. */
function mainFromKeeps(P, src, keeps, { marks = [], punch = 1.12, emphasis = [], emphasisScale = 1.3, filter } = {}) {
  const media = new Map(P.media.map((m) => [m.id, m]));
  const pieces = [];
  for (const k of keeps) {
    const cuts = [k.start, ...marks.filter((x) => x > k.start + 0.2 && x < k.end - 0.2), ...src.map((s) => s.start).filter((x) => x > k.start + 0.05 && x < k.end - 0.05), k.end].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (b - a < 0.08) continue;
      const s = src.find((x) => a >= x.start - 1e-6 && a < x.start + x.duration);
      if (!s) continue;
      pieces.push({ a, b: Math.min(b, s.start + s.duration), s, jump: i === 0 });
    }
  }
  let out = 0;
  let alt = 0;
  for (const pc of pieces) {
    if (pc.jump) alt++;
    const m = media.get(pc.s.media_id);
    const d = pc.b - pc.a;
    const emph = emphasis.some((e) => Math.min(pc.b, e.end) - Math.max(pc.a, e.start) > (pc.b - pc.a) * 0.5);
    const sc = coverScale(m, P) * (emph ? emphasisScale : alt % 2 === 0 ? punch : 1);
    P.clips.push(makeClip('video', {
      mediaId: m.id, trackId: 'main', start: r3(out), duration: r3(d), in: r3(pc.a - pc.s.start), name: m.name, scale: r3(sc),
      filter: { name: filter || 'none', intensity: 1 },
    }));
    out += d;
  }
  return out;
}
/** The main track's picture from t to the end, blurred (the outro): the clip there is split, its end blurred in. */
function blurTail(P, t) {
  const main = P.clips.filter((c) => c.trackId === 'main').sort((a, b) => a.start - b.start);
  const c = main.find((x) => t >= x.start - 1e-6 && t < x.start + x.duration - 0.05);
  if (!c) return null;
  let tail = c;
  if (t > c.start + 0.05) {
    const d = t - c.start;
    tail = clone(c);
    tail.id = uid('c');
    tail.start = r3(t);
    tail.in = r3(c.in + d * (c.speed || 1));
    tail.duration = r3(c.duration - d);
    c.duration = r3(d);
    P.clips.splice(P.clips.indexOf(c) + 1, 0, tail);
  }
  tail.transition = { type: 'blur', duration: 0.5 };
  for (const x of main.filter((x) => x.start >= t - 1e-6)) x.adjust = { ...(x.adjust || {}), blur: 70, brightness: -12 };
  tail.adjust = { ...(tail.adjust || {}), blur: 70, brightness: -12 };
  return tail;
}

/** Product shots as cutaways over the talking (muted), avoiding `busy` ranges. */
function cutaways(P, shots, total, { track, busy = [], first = 2.5, len = 1.6, gap = 6, filter, plan = [] } = {}) {
  const media = new Map(P.media.map((m) => [m.id, m]));
  const tr = track || newTrack(P, 'overlay', 'B-roll');
  const placed = [];
  const put = (m, start, dur, srcIn = 0) => {
    if (!m) return;
    const d = Math.min(dur, m.type === 'video' ? Math.max(0.4, (m.duration || dur) - srcIn) : dur);
    const c = makeClip(m.type, { mediaId: m.id, trackId: tr.id, start: r3(start), duration: r3(d), in: m.type === 'video' ? r3(srcIn) : 0, name: m.name, scale: r3(coverScale(m, P)), filter: { name: filter || 'none', intensity: 1 } });
    if (m.type === 'video') Object.assign(c, { volume: 0, muted: true });
    P.clips.push(c);
    placed.push({ start, end: start + d });
  };
  if (plan.length) {
    for (const b of plan) put(media.get(b.media), b.start, b.duration || len, b.in || 0);
    return placed;
  }
  if (!shots.length) return placed;
  let t = first;
  let i = 0;
  while (t + len < total - 2 && i < 40) {
    const clash = busy.find((b) => t < b.end + 0.3 && t + len > b.start - 0.3);
    if (clash) { t = clash.end + 0.4; continue; }
    const m = media.get(shots[i % shots.length]);
    const srcIn = m?.type === 'video' && m.duration > len * 2 ? Math.min(m.duration - len, (Math.floor(i / shots.length) * len * 1.3) % Math.max(0.1, m.duration - len)) : 0;
    put(m, t, len, srcIn);
    i++;
    t += len + gap;
  }
  return placed;
}

// ---- Editorial Review ------------------------------------------------------------------------
const CREAM = '#F8F8A8';
function buildEditorial(P, st, product, opts) {
  const sp = speechTimeline(P);
  if (!sp.words.length) throw new Error('Editorial Review butuh video kamu ngomong. Belum ada suara orang di bahan ini (atau belum ditranskrip).');
  const plan = { ...autoPlan('editorial', { words: sp.words, duration: sp.duration, product }), ...(opts.plan || {}) };
  const cuts = [...(plan.cuts || []), ...(plan.auto_cut_silence === false ? [] : silenceCuts(sp.words, sp.duration))];
  const cm = cutMap(sp.duration, cuts);
  const T = cm.map;
  // keyword groups (speech time) and the price moment
  const title = (plan.title?.text ?? product.name ?? '').trim();
  const sub = (plan.title?.subtitle ?? product.variant ?? '').trim();
  const titleWords = new Set(`${title} ${sub}`.split(/\s+/).map(norm).filter(Boolean));
  let groups = (plan.keywords || []).map((g) => ({ words: placeWords(sp.words, g) })).filter((g) => g.words.length);
  for (const g of groups) { g.start = g.words[0].s; g.end = g.words.at(-1).e + 0.55; }
  // (a group that only repeats the title, early on, goes: the title already says it)
  if (title) groups = groups.filter((g) => !(g.start < 8 && g.words.every((w) => titleWords.has(norm(w.text)))));
  let price = plan.price && (plan.price.discount || plan.price.normal || product.price) ? { ...plan.price, start: plan.price.start ?? sp.duration * 0.55 } : null;
  if (price) {
    // the label waits for a keyword group that is on screen when the price is said
    const clash = groups.find((g) => g.start < price.start + 3 && g.end > price.start - 0.2);
    if (clash) price.start = clash.end + 0.05;
  }
  const emphasis = groups.map((g) => ({ start: g.start - 0.04, end: g.end }));
  const marks = emphasis.flatMap((e) => [e.start, e.end]);
  const total = mainFromKeeps(P, sp.sources, cm.keeps, { marks, emphasis, punch: 1.12, emphasisScale: 1.28, filter: st.filter });
  const main = P.clips.filter((c) => c.trackId === 'main');
  const busy = [];
  // (track order: B-roll right above the main video, every text above it)
  const brollTrack = newTrack(P, 'overlay', 'B-roll');
  const big = lane(P, 'text', 'Teks');
  const outroAt = plan.outro !== false && total > 6 ? total - 1.5 : total;
  // title (Instrument Serif), over the first seconds
  const firstKw = groups.length ? T(groups[0].start) : Infinity;
  const titleEnd = Math.min(3, firstKw - 0.1, total);
  if (title && titleEnd > 1) {
    big(text(title.toUpperCase(), { font: 'Instrument Serif', weight: 400, size: Math.min(150, 1700 / Math.max(6, title.length)), color: '#ffffff', letterSpacing: 2, shadow: { enabled: true, color: '#000000', opacity: 0.45, blur: 18, x: 0, y: 4 } },
      { start: 0.15, duration: r3(titleEnd - 0.15), y: -0.3, animIn: { type: 'blur', duration: 0.45 }, animOut: { type: 'fade', duration: 0.3 } }));
    if (sub) big(text(sub, { font: 'Instrument Serif', weight: 400, italic: true, size: 86, color: CREAM, shadow: { enabled: true, color: '#000000', opacity: 0.4, blur: 14, x: 0, y: 3 } },
      { start: 0.45, duration: r3(Math.max(0.5, titleEnd - 0.45)), y: -0.235, animIn: { type: 'blur', duration: 0.45 }, animOut: { type: 'fade', duration: 0.3 } }));
    busy.push({ start: 0, end: titleEnd });
  }
  // the price's place first (it matters most): a keyword group that cannot make way for it goes
  let outroStart = outroAt;
  let slot = null;
  if (price) {
    const s = Math.min(Math.max(0.5, T(price.start)), Math.max(0.5, total - 2.4));
    // (the price matters more than the outro: when both do not fit, the outro goes)
    if (outroStart - s - 0.1 < 1.4) outroStart = total;
    const d = Math.min(3.2, outroStart - s - 0.1);
    if (d > 1) slot = { s, d };
  }
  if (slot) groups = groups.filter((g) => !(T(g.start) < slot.s + slot.d && Math.min(total, T(g.end)) > slot.s));
  // big stacked keywords: each word appears when it is said, the group stays until a breath after the last
  let kwCount = 0;
  for (const g of groups) {
    const n = g.words.length;
    const gEnd = Math.min(total, T(g.end));
    for (let i = 0; i < n; i++) {
      const w = g.words[i];
      const s = T(w.s);
      if (gEnd - s < 0.2) continue;
      const word = cleanWord(w.text).toUpperCase();
      if (!word) continue;
      const size = Math.round(Math.min(215, 940 / (0.47 * Math.max(3, word.length))));
      big(text(word, { font: 'Anton', weight: 400, size, color: CREAM, letterSpacing: -1, lineHeight: 1, shadow: { enabled: true, color: '#000000', opacity: 0.35, blur: 0, x: 0, y: 6 } },
        { start: r3(s), duration: r3(gEnd - s), y: r3(-0.06 + (i - (n - 1) / 2) * 0.108), animIn: { type: 'zoomOut', duration: 0.16 }, animOut: { type: 'fade', duration: 0.14 } }));
    }
    busy.push({ start: T(g.start), end: gEnd });
    kwCount++;
  }
  // the price label: old price struck through, the new one on a cream card, "!!"
  let priceAt = null;
  if (slot) {
    const { s, d } = slot;
    {
      priceAt = s;
      const now = formatPrice(price.discount || price.normal || product.price);
      const was = price.discount ? formatPrice(price.normal || product.price) : '';
      if (was && was !== now) big(text(was, { font: 'Poppins', weight: 600, size: 72, color: '#ffffff', strike: true, strikeColor: '#ff4d4d', shadow: { enabled: true, color: '#000000', opacity: 0.45, blur: 10, x: 0, y: 3 } }, { start: r3(s), duration: r3(d), y: -0.04, animIn: { type: 'fade', duration: 0.2 }, animOut: { type: 'fade', duration: 0.2 } }));
      big(text(now, { font: 'Anton', weight: 400, size: 150, color: '#1b1b1b', bg: { enabled: true, color: CREAM, opacity: 1, radius: 22, padding: 0.75 } }, { start: r3(s + 0.25), duration: r3(d - 0.25), y: 0.06, rotation: -3, animIn: { type: 'pop', duration: 0.32 }, animOut: { type: 'fade', duration: 0.2 } }));
      big(text('!!', { font: 'Anton', weight: 400, size: 170, color: '#ff3b30', shadow: { enabled: true, color: '#000000', opacity: 0.3, blur: 0, x: 4, y: 6 } }, { start: r3(s + 0.5), duration: r3(d - 0.5), x: 0.33, y: -0.02, rotation: 12, animIn: { type: 'pop', duration: 0.28 }, animLoop: { type: 'pulse', speed: 1 } }));
      busy.push({ start: s, end: s + d });
      // leaving the price: pixelate on the next cut
      const next = main.find((c) => c.start >= s + d - 0.3 && c.start > 0 && c.start < outroStart - 0.3);
      if (next) next.transition = { type: 'pixelate', duration: 0.5 };
    }
  }
  // a light leak where the review starts (the first cut after the title) and before the price
  const leakAt = main.find((c) => c.start >= Math.max(1.5, titleEnd - 0.2) && noTr(c));
  if (leakAt && leakAt.start > 0) leakAt.transition = { type: 'leak', duration: 0.6 };
  if (priceAt != null) {
    const before = main.filter((c) => c.start > 1 && c.start <= priceAt + 0.05 && noTr(c)).at(-1);
    if (before && Math.abs(before.start - (leakAt?.start ?? -9)) > 2) before.transition = { type: 'leak', duration: 0.6 };
  }
  // product shots as cutaways (the AI's choice, or spread between the busy moments)
  const shots = checkMaterial(P).shots;
  const bplan = (plan.broll || []).map((b) => ({ media: b.media_id || b.media, start: T(b.start), duration: b.duration, in: b.in }));
  const placed = cutaways(P, shots, outroStart, { track: brollTrack, busy, first: Math.max(2.5, titleEnd + 0.5), filter: st.filter, plan: bplan });
  // small italic subtitles, lower case, cream
  let subs = 0;
  if (plan.subtitles !== false) {
    const cues = lines(sp.words.filter((w) => T(w.s) < total && cm.keeps.some((k) => w.s >= k.start - 0.05 && w.s <= k.end)).map((w) => ({ ...w, s: T(w.s), e: T(w.e) })), 30);
    subs = addSubtitleTrack(P, cues, { font: 'Poppins', weight: 500, italic: true, size: 54, color: '#F6EFD2', shadow: { enabled: true, color: '#000000', opacity: 0.55, blur: 10, x: 0, y: 3 } }, { avoid: busy, lower: true, y: 0.33 });
  }
  // outro: the last picture blurred, "bye" and the brand typed
  const brand = (product.brand ?? 'NAJJA').trim();
  let outro = false;
  if (outroStart < total) {
    const s = outroStart;
    blurTail(P, s);
    big(text(plan.outro?.text || 'bye', { font: 'Instrument Serif', weight: 400, italic: true, size: 150, color: '#ffffff' }, { start: r3(s + 0.1), duration: 1.4, y: -0.05, animIn: { type: 'fade', duration: 0.35 } }));
    if (brand) big(text(brand.toUpperCase(), { font: 'Poppins', weight: 300, size: 64, color: '#ffffff', letterSpacing: 22 }, { start: r3(s + 0.4), duration: 1.1, y: 0.05, animIn: { type: 'typewriter', duration: 0.6 } }));
    outro = true;
  }
  const musicClips = plan.music === 'none' ? 0 : addMusic(P, opts.music, total, 0.22);
  return { style: st.id, name: st.name, duration: r3(total), source_duration: sp.duration, cut_seconds: r3(sp.duration - total), cuts: cm.keeps.length - 1, keywords: kwCount, price: priceAt != null, cutaways: placed.length, subtitles: subs, outro, music: musicClips > 0 };
}

// ---- Showcase Clean --------------------------------------------------------------------------
const splitList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]+/)).map((x) => String(x).trim()).filter(Boolean);
/** The variants of a product: plan.variants [{ name, note, size }] or the product's comma lists. */
export function variantsOf(product = {}, plan = {}) {
  if (Array.isArray(plan.variants) && plan.variants.length) return plan.variants.map((v) => (typeof v === 'string' ? { name: v } : { name: String(v.name || ''), note: v.note || '', size: v.size || '' })).filter((v) => v.name);
  const names = splitList(product.variant);
  const sizes = splitList(product.size);
  const notes = splitList(product.note);
  return names.map((name, i) => ({ name, size: sizes[i] || '', note: notes[i] || '' }));
}
const HARD = { enabled: true, color: '#000000', opacity: 0.85, blur: 0, x: 5, y: 6 };
function buildShowcase(P, st, product, opts) {
  const plan = { ...(opts.plan || {}) };
  const media = (plan.order || []).map((id) => P.media.find((m) => m.id === id)).filter(Boolean);
  const vis = media.length ? media : visualMedia(P);
  if (!vis.length) throw new Error('Showcase Clean butuh video atau foto produk.');
  let variants = variantsOf(product, plan);
  if (!variants.length) variants = [{ name: '' }];
  const V = variants.length;
  const M = vis.length;
  const L = Math.max(2.5, Math.min(8, Number(plan.section_seconds) || 4.5));
  // media per variant: in order (Mini's clips first...), or the clips again when there are more variants than clips
  const per = variants.map((_, j) => (V <= M ? vis.filter((__, i) => Math.floor((i * V) / M) === j) : [vis[j % M]]));
  const usedIn = new Map();
  const T0 = (m) => (m.type === 'video' ? Math.min((m.duration || 0) * 0.15, 1) : 0);
  let t = 0;
  const sections = [];
  for (let j = 0; j < V; j++) {
    const list = per[j];
    const n = Math.max(1, Math.min(list.length, Math.floor(L / 1.2)));
    const piece = L / n;
    const start = t;
    for (let k = 0; k < n; k++) {
      const m = list[k];
      const from = usedIn.get(m.id) ?? T0(m);
      const d = m.type === 'video' ? Math.min(piece, Math.max(0.6, (m.duration || piece) - from)) : piece;
      const c = makeClip(m.type, { mediaId: m.id, trackId: 'main', start: r3(t), duration: r3(d), in: m.type === 'video' ? r3(from) : 0, name: m.name, scale: r3(coverScale(m, P)), filter: { name: st.filter, intensity: 1 } });
      if (m.type === 'video') Object.assign(c, { volume: 0, muted: true });
      if (k === 0 && j > 0) c.transition = { type: 'punch', duration: 0.3 };
      P.clips.push(c);
      usedIn.set(m.id, m.type === 'video' && from + d + piece < (m.duration || 0) ? from + d : T0(m));
      t += d;
    }
    sections.push({ start, end: t, v: variants[j] });
  }
  // the ending: every variant together (on the first clip again) and the price
  const names = variants.map((v) => v.name).filter(Boolean);
  const fin = (names.length > 1 || product.price || product.price_discount) && plan.ending !== false;
  if (fin) {
    const m = vis[0];
    const d = 2.8;
    const c = makeClip(m.type, { mediaId: m.id, trackId: 'main', start: r3(t), duration: d, in: m.type === 'video' ? r3(T0(m)) : 0, name: m.name, scale: r3(coverScale(m, P) * 1.06), filter: { name: st.filter, intensity: 1 }, transition: { type: 'punch', duration: 0.3 } });
    if (m.type === 'video') Object.assign(c, { volume: 0, muted: true, duration: r3(Math.min(d, Math.max(1, (m.duration || d) - T0(m)))) });
    P.clips.push(c);
    sections.push({ start: t, end: t + c.duration, fin: true });
    t += c.duration;
  }
  const total = t;
  const txt = lane(P, 'text', 'Teks');
  const name = (plan.title?.text ?? product.name ?? '').trim();
  for (const sec of sections) {
    const s = Math.max(0, sec.start - 0.07);
    const e = Math.min(total, sec.end - 0.07 > s + 0.3 ? sec.end - 0.07 : sec.end);
    if (name) txt(text(name, { font: 'Roboto', weight: 500, italic: true, size: 74, color: '#ffffff', shadow: { enabled: true, color: '#000000', opacity: 0.5, blur: 16, x: 0, y: 4 } }, { start: r3(s), duration: r3(e - s), y: -0.33 }));
    const line2 = sec.fin ? names.join(' · ') : [sec.v.name, sec.v.note].filter(Boolean).join(' ');
    if (line2) txt(text(line2, { font: 'Poppins', weight: 800, size: Math.min(104, 1500 / Math.max(8, line2.length)), color: '#ffffff', shadow: HARD }, { start: r3(s), duration: r3(e - s), y: -0.255 }));
    if (!sec.fin && sec.v.size) {
      // the size line: thin arrows and the measure, in softly after the cut
      txt(text(`←   ${sec.v.size}   →`, { font: 'Poppins', weight: 400, size: 58, color: '#ffffff', letterSpacing: 3, shadow: { enabled: true, color: '#000000', opacity: 0.45, blur: 10, x: 0, y: 2 } },
        { start: r3(sec.start + 0.3), duration: r3(Math.max(0.4, sec.end - sec.start - 0.35)), y: 0.2, animIn: { type: 'fade', duration: 0.4 } }));
    }
    if (sec.fin && (product.price || product.price_discount)) {
      const now = formatPrice(product.price_discount || product.price);
      const was = product.price_discount ? formatPrice(product.price) : '';
      if (was && was !== now) txt(text(was, { font: 'Poppins', weight: 600, size: 64, color: '#ffffff', strike: true, strikeColor: '#ff4d4d', shadow: HARD }, { start: r3(sec.start + 0.2), duration: r3(sec.end - sec.start - 0.2), y: 0.14, animIn: { type: 'fade', duration: 0.2 } }));
      txt(text(now, { font: 'Poppins', weight: 800, size: 120, color: '#ffffff', shadow: HARD }, { start: r3(sec.start + 0.35), duration: r3(sec.end - sec.start - 0.35), y: 0.22, animIn: { type: 'pop', duration: 0.3 } }));
    }
  }
  const musicClips = plan.music === 'none' ? 0 : addMusic(P, opts.music, total, 0.85);
  return { style: st.id, name: st.name, duration: r3(total), sections: sections.length, variants: names, ending: !!fin, music: musicClips > 0, clips: P.clips.filter((c) => c.trackId === 'main').length };
}

// ---- Story Pop -------------------------------------------------------------------------------
const EMOJI = [
  [/^(harga|harganya|murah|hemat|diskon|promo|sale|murmer)$/, '💸'], [/^(baju|outfit|pakaian|kaos|celana)$/, '👕'], [/^(skincare|makeup|serum|krim)$/, '🧴'],
  [/^(travel|mudik|liburan|pesawat|bandara|jalan|trip)$/, '✈️'], [/^(tas|bag|koper|ransel)$/, '👜'], [/^(rumah|hospital|lahiran|bayi)$/, '🏥'],
  [/^(suka|cinta|love|sayang)$/, '😍'], [/^(keren|wow|mantap|gila|bagus)$/, '🤩'], [/^(cepat|buruan|sekarang|habis)$/, '⏰'], [/^(gratis|bonus|hadiah)$/, '🎁'],
  [/^(muat|lega|besar|jumbo|banyak)$/, '📦'], [/^(ringan|enteng)$/, '🪶'], [/^(air|hujan|antiair)$/, '💧'],
];
export function emojiFor(word) { const n = norm(word); for (const [re, e] of EMOJI) if (re.test(n)) return e; return null; }
const POP = { enabled: true, color: '#000000', opacity: 0.9, blur: 0, x: 0, y: 7 };
function buildStoryPop(P, st, product, opts) {
  const sp = speechTimeline(P);
  if (!sp.words.length) throw new Error('Story Pop butuh video kamu ngomong. Belum ada suara orang di bahan ini (atau belum ditranskrip).');
  const plan = { ...autoPlan('storypop', { words: sp.words, duration: sp.duration, product }), ...(opts.plan || {}) };
  const cuts = [...(plan.cuts || []), ...(plan.auto_cut_silence === false ? [] : silenceCuts(sp.words, sp.duration))];
  const cm = cutMap(sp.duration, cuts);
  const T = cm.map;
  const sents = sentencesOf(sp.words);
  const { shots } = checkMaterial(P);
  // B-roll: the AI's picks, else every other sentence after the hook gets the next shot
  let broll = (plan.broll || []).map((b) => ({ media: b.media_id || b.media, start: b.start, duration: b.duration || 2, in: b.in || 0 }));
  if (!plan.broll && shots.length) broll = sents.slice(1).filter((_, i) => i % 2 === 0).map((x, i) => ({ media: shots[i % shots.length], start: x.start, duration: Math.min(2.2, Math.max(1.2, x.end - x.start)) }));
  // without shots, those sentences get a strong punch-in instead (the "B-roll" is your own picture, closer)
  const emphasis = !shots.length && !plan.broll ? sents.slice(1).filter((_, i) => i % 2 === 0).map((x) => ({ start: x.start - 0.04, end: Math.min(x.end, x.start + 2.2) })) : [];
  const hook = (plan.hook?.words || []).length ? placeWords(sp.words, { start: plan.hook.start ?? sents[0]?.start ?? 0, words: plan.hook.words }) : [];
  const question = plan.hook?.question ?? /\?$/.test(String(sents[0]?.text || '').trim());
  const marks = emphasis.flatMap((e) => [e.start, e.end]);
  const total = mainFromKeeps(P, sp.sources, cm.keeps, { marks, emphasis, punch: 1.1, emphasisScale: 1.4, filter: st.filter });
  const main = P.clips.filter((c) => c.trackId === 'main');
  const brollTrack = newTrack(P, 'overlay', 'B-roll');
  const txt = lane(P, 'text', 'Teks');
  const busy = [];
  // hook: single words left and right, the last one coming together, a 🤔 when it is a question
  if (hook.length) {
    for (let i = 0; i < hook.length; i++) {
      const s = T(hook[i].s);
      const last = i === hook.length - 1;
      const e = last ? T(hook[i].e) + 0.9 : Math.max(s + 0.25, T(hook[i + 1].s));
      const word = cleanWord(hook[i].text);
      if (!word || e - s < 0.15) continue;
      txt(text(last ? word : word.toLowerCase(), { font: 'Inter', weight: 800, size: last ? Math.min(170, 1300 / Math.max(4, word.length)) : 120, color: '#ffffff', shadow: POP },
        { start: r3(s), duration: r3(e - s), x: last ? 0 : i % 2 ? 0.17 : -0.17, y: last ? -0.12 : -0.2, animIn: { type: last ? 'converge' : 'pop', duration: last ? 0.45 : 0.18 } }));
      if (last && question) txt(makeSticker('🤔', s + 0.35, e - s - 0.35, 0.3, -0.24));
    }
    busy.push({ start: Math.max(0, T(hook[0].s) - 0.1), end: T(hook.at(-1).e) + 0.9 });
  }
  // the price's place first; keywords keep out of it
  const price = plan.price && (plan.price.discount || plan.price.normal || product.price) ? { ...plan.price, start: plan.price.start ?? sp.duration * 0.6 } : null;
  let slot = null;
  if (price) {
    const s = Math.max(0.5, Math.min(Math.max(T(price.start), busy.length ? busy[0].end + 0.05 : 0), total - 2.6));
    const d = Math.min(3.2, total - s - 0.1);
    if (d > 1.2) slot = { s, d };
  }
  // keywords: one line that pops, a sticker when a word has one
  let kw = 0;
  let lastSticker = -Infinity;
  for (const g of plan.keywords || []) {
    const ws = placeWords(sp.words, g);
    if (!ws.length) continue;
    const s = T(ws[0].s);
    const e = Math.min(total, T(ws.at(-1).e) + 0.7);
    if (busy.some((b) => s < b.end && e > b.start)) continue;
    if (slot && s < slot.s + slot.d && e > slot.s) continue;
    const line = ws.map((w) => cleanWord(w.text).toUpperCase()).filter(Boolean).join(' ');
    if (!line || e - s < 0.3) continue;
    txt(text(line, { font: 'Inter', weight: 800, size: Math.min(130, 1500 / Math.max(6, line.length)), color: '#ffffff', shadow: POP }, { start: r3(s), duration: r3(e - s), y: -0.2, animIn: { type: 'pop', duration: 0.22 }, animOut: { type: 'fade', duration: 0.12 } }));
    const em = (g.emoji) || ws.map((w) => emojiFor(w.text)).find(Boolean);
    if (em && s - lastSticker > 3) { txt(makeSticker(em, s + 0.15, Math.max(0.5, e - s - 0.15), kw % 2 ? -0.3 : 0.3, -0.29)); lastSticker = s; }
    busy.push({ start: s, end: e });
    kw++;
  }
  for (const x of plan.stickers || []) { const s = T(x.start); if (x.emoji && s < total - 0.5) txt(makeSticker(x.emoji, s, x.duration || 1.4, x.x ?? 0.28, x.y ?? -0.28)); }
  // price: "turun HARGA!!" letter by letter, the old price struck through, the new one on a red label
  let priceAt = null;
  if (slot) {
    const { s, d } = slot;
    {
      priceAt = s;
      txt(text('turun', { font: 'Inter', weight: 700, italic: true, size: 80, color: '#ffffff', shadow: POP }, { start: r3(s), duration: r3(d), y: -0.25, animIn: { type: 'pop', duration: 0.2 } }));
      txt(text('HARGA!!', { font: 'Inter', weight: 900, size: 170, color: '#FFE600', shadow: POP, stroke: { enabled: true, color: '#111111', width: 5 } }, { start: r3(s + 0.15), duration: r3(d - 0.15), y: -0.15, animIn: { type: 'typewriter', duration: 0.45 } }));
      const now = formatPrice(price.discount || price.normal || product.price);
      const was = price.discount ? formatPrice(price.normal || product.price) : '';
      if (was && was !== now) txt(text(was, { font: 'Inter', weight: 700, size: 72, color: '#ffffff', strike: true, strikeColor: '#ff3b30', shadow: POP }, { start: r3(s + 0.5), duration: r3(d - 0.5), y: 0.03, animIn: { type: 'fade', duration: 0.2 } }));
      txt(text(now, { font: 'Inter', weight: 900, size: 120, color: '#ffffff', bg: { enabled: true, color: '#ff3b30', opacity: 1, radius: 18, padding: 0.7 } }, { start: r3(s + 0.85), duration: r3(d - 0.85), y: 0.12, rotation: -4, animIn: { type: 'pop', duration: 0.3 }, animLoop: { type: 'pulse', speed: 1 } }));
      busy.push({ start: s, end: s + d });
    }
  }
  // B-roll over the sentences (not over the hook or the price)
  const bplan = broll.map((b) => ({ ...b, start: T(b.start) })).filter((b) => !busy.some((x) => b.start < x.end && b.start + b.duration > x.start && (x.start < 0.5 || x.start === priceAt)));
  const placed = cutaways(P, shots, total, { track: brollTrack, filter: st.filter, plan: bplan });
  // the brand sting in the middle: a blur cut and the brand pops
  const brand = (product.brand ?? 'NAJJA').trim();
  let sting = false;
  if (brand && plan.sting !== false && total > 12) {
    const mid = main.find((c) => c.start > total * 0.45 && noTr(c) && !busy.some((b) => c.start > b.start - 0.5 && c.start < b.end + 0.5));
    if (mid) {
      mid.transition = { type: 'blur', duration: 0.6 };
      txt(text(brand.toUpperCase(), { font: 'Inter', weight: 900, size: 120, color: '#ffffff', letterSpacing: 10, shadow: POP }, { start: r3(mid.start - 0.3), duration: 0.9, animIn: { type: 'pop', duration: 0.25 }, animOut: { type: 'blur', duration: 0.25 } }));
      sting = true;
    }
  }
  if (plan.live) txt(makeSticker(null, 0, total, -0.33, -0.42, { text: 'LIVE', bg: '#ff2d55', fg: '#ffffff', icon: '●' }));
  // subtitles: bold white with a hard shadow
  let subs = 0;
  if (plan.subtitles !== false) {
    const cues = lines(sp.words.filter((w) => cm.keeps.some((k) => w.s >= k.start - 0.05 && w.s <= k.end)).map((w) => ({ ...w, s: T(w.s), e: T(w.e) })), 24);
    subs = addSubtitleTrack(P, cues, { font: 'Inter', weight: 800, size: 60, color: '#ffffff', shadow: { ...POP, y: 5 } }, { avoid: busy, y: 0.3, anim: 'pop' });
  }
  const musicClips = plan.music === 'none' ? 0 : addMusic(P, opts.music, total, 0.18);
  return { style: st.id, name: st.name, duration: r3(total), source_duration: sp.duration, cut_seconds: r3(sp.duration - total), hook: hook.length, keywords: kw, price: priceAt != null, broll: placed.length, sting, subtitles: subs, music: musicClips > 0 };
}
function makeSticker(emoji, start, duration, x, y, badge = null) {
  return makeClip('sticker', { sticker: { emoji: emoji || '', badge }, start: r3(start), duration: r3(Math.max(0.3, duration)), x, y, scale: badge ? 0.7 : 0.75, name: badge ? badge.text : emoji, animIn: { type: 'pop', duration: 0.25 }, animOut: { type: 'pop', duration: 0.2 } });
}
