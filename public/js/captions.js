// Auto subtitles (v1.9): the speech of the video (or of the voice-overs) → Whisper on the Najja server → subtitle
// lines on the timeline, timed by the words. Like a phone editor's "Hasilkan keterangan otomatis": choose the sound to
// listen to, the language it is in (any of Whisper's 99, or detect it), a caption style, and go.
import { store } from './store.js';
import { mixForSpeech } from './fastexport.js';
import { cacheProjectMedia } from './media.js';

// Whisper's languages; the ones people here use most first, with Indonesian names.
const COMMON = [
  ['id', 'Bahasa Indonesia'], ['en', 'Inggris'], ['jw', 'Jawa'], ['su', 'Sunda'], ['ms', 'Melayu'], ['ar', 'Arab'],
  ['zh', 'Mandarin'], ['yue', 'Kanton'], ['ja', 'Jepang'], ['ko', 'Korea'], ['hi', 'Hindi'], ['th', 'Thai'], ['vi', 'Vietnam'],
  ['tl', 'Tagalog'], ['es', 'Spanyol'], ['fr', 'Prancis'], ['de', 'Jerman'], ['pt', 'Portugis'], ['ru', 'Rusia'], ['it', 'Italia'],
  ['nl', 'Belanda'], ['tr', 'Turki'], ['ur', 'Urdu'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['fa', 'Persia'],
];
const OTHER = [
  ['af', 'Afrikaans'], ['am', 'Amharik'], ['as', 'Assam'], ['az', 'Azerbaijan'], ['ba', 'Bashkir'], ['be', 'Belarus'], ['bg', 'Bulgaria'],
  ['bo', 'Tibet'], ['br', 'Breton'], ['bs', 'Bosnia'], ['ca', 'Katalan'], ['cs', 'Ceko'], ['cy', 'Wales'], ['da', 'Denmark'], ['el', 'Yunani'],
  ['et', 'Estonia'], ['eu', 'Basque'], ['fi', 'Finlandia'], ['fo', 'Faroe'], ['gl', 'Galisia'], ['gu', 'Gujarati'], ['ha', 'Hausa'],
  ['haw', 'Hawaii'], ['he', 'Ibrani'], ['hr', 'Kroasia'], ['ht', 'Kreol Haiti'], ['hu', 'Hungaria'], ['hy', 'Armenia'], ['is', 'Islandia'],
  ['ka', 'Georgia'], ['kk', 'Kazakh'], ['km', 'Khmer'], ['kn', 'Kannada'], ['la', 'Latin'], ['lb', 'Luksemburg'], ['ln', 'Lingala'],
  ['lo', 'Laos'], ['lt', 'Lituania'], ['lv', 'Latvia'], ['mg', 'Malagasi'], ['mi', 'Maori'], ['mk', 'Makedonia'], ['ml', 'Malayalam'],
  ['mn', 'Mongolia'], ['mr', 'Marathi'], ['mt', 'Malta'], ['my', 'Myanmar'], ['ne', 'Nepal'], ['nn', 'Nynorsk'], ['no', 'Norwegia'],
  ['oc', 'Oksitan'], ['pa', 'Punjabi'], ['pl', 'Polandia'], ['ps', 'Pashto'], ['ro', 'Rumania'], ['sa', 'Sanskerta'], ['sd', 'Sindhi'],
  ['si', 'Sinhala'], ['sk', 'Slowakia'], ['sl', 'Slovenia'], ['sn', 'Shona'], ['so', 'Somali'], ['sq', 'Albania'], ['sr', 'Serbia'],
  ['sv', 'Swedia'], ['sw', 'Swahili'], ['te', 'Telugu'], ['tg', 'Tajik'], ['tk', 'Turkmen'], ['tt', 'Tatar'], ['uk', 'Ukraina'],
  ['uz', 'Uzbek'], ['yi', 'Yiddish'], ['yo', 'Yoruba'],
];
export const LANGUAGES = [['auto', 'Deteksi otomatis'], ...COMMON, ...OTHER];
export const langName = (code) => LANGUAGES.find(([c]) => c === code)?.[1] || code;

export const SOURCES = [['video', 'Video'], ['voice', 'Pengisi suara'], ['all', 'Semua audio']];
export const LINE_LENGTH = { short: 18, medium: 30, long: 44 };

/** The clips whose speech is transcribed. */
export function speechClips(P, from) {
  const isVoice = (c) => c.type === 'audio' && !store.media(c.mediaId)?.stock;
  return P.clips.filter((c) => (from === 'video' ? c.type === 'video' : from === 'voice' ? isVoice(c) : c.type === 'video' || isVoice(c)));
}

/** 16-bit PCM WAV of a mono AudioBuffer. */
export function wav16(buf) {
  const d = buf.getChannelData(0);
  const ab = new ArrayBuffer(44 + d.length * 2);
  const v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + d.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, d.length * 2, true);
  // a little louder when quiet (peak to −1 dBFS): whisper hears soft voices better
  let peak = 0;
  for (const x of d) if (Math.abs(x) > peak) peak = Math.abs(x);
  const g = peak > 0.01 ? Math.min(8, 0.89 / peak) : 1;
  for (let i = 0; i < d.length; i++) { const s = Math.max(-1, Math.min(1, d[i] * g)); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([ab], { type: 'audio/wav' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether the server can transcribe now: { ok, reason, state, model }. */
export async function transcribeStatus() {
  try {
    const st = await (await fetch('/api/ai', { cache: 'no-store', credentials: 'same-origin' })).json();
    const t = st.tools?.transcribe;
    if (!st.available) return { ok: false, reason: st.reason || 'Layanan AI di server belum siap.' };
    if (!t?.available) return { ok: false, reason: t?.reason || 'Transkripsi belum terpasang di server.' };
    return { ok: true, state: t.state, progress: t.progress, model: t.model };
  } catch { return { ok: false, reason: 'Server tidak bisa dihubungi.' }; }
}

/**
 * Transcribe the project's speech. from: 'video' | 'voice' | 'all'; lang: 'auto' or a Whisper code.
 * Resolves { language, segments: [{ start, end, text, words }] } with timeline times.
 */
export async function transcribeProject({ from = 'video', lang = 'id', onProgress = () => {}, signal } = {}) {
  const P = store.P;
  const clips = speechClips(P, from);
  if (!clips.length) throw new Error(from === 'voice' ? 'Belum ada pengisi suara / audio di timeline.' : 'Belum ada video di timeline.');
  onProgress(0.02, 'Menyiapkan suara…');
  await cacheProjectMedia({ ...P, clips }, (p) => onProgress(0.02 + p * 0.1, 'Menyiapkan suara…'));
  const buf = await mixForSpeech(P, clips);
  if (!buf) throw new Error('Klip yang dipilih tidak punya suara.');
  return transcribeWav(wav16(buf), { lang, name: P.name || 'subtitle', onProgress, signal });
}

/** A WAV (16 kHz mono) → Whisper on the server → { language, segments }. Shared by auto subtitles and Style Konsep. */
export async function transcribeWav(body, { lang = 'id', name = 'suara', onProgress = () => {}, signal } = {}) {
  onProgress(0.15, 'Mengirim suara ke server…');
  const r = await fetch(`/api/ai/transcribe?${new URLSearchParams({ lang, name: String(name).slice(0, 60) })}`, { method: 'POST', body, headers: { 'content-type': 'audio/wav' }, credentials: 'same-origin', signal });
  let x = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(x.error || `HTTP ${r.status}`);
  const id = x.id;
  try {
    while (!['done', 'failed', 'cancelled'].includes(x.state)) {
      if (signal?.aborted) throw new Error('Dibatalkan');
      onProgress(0.2 + (x.progress || 0) * 0.75, x.stage === 'download' ? 'Mengunduh model suara ke server (sekali saja)…' : x.state === 'queued' ? 'Menunggu giliran di server…' : 'Mendengarkan dan menulis…');
      await sleep(800);
      const rr = await fetch(`/api/ai/${id}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!rr.ok) throw new Error('Permintaan tidak ditemukan');
      x = await rr.json();
    }
  } catch (err) {
    fetch(`/api/ai/${id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    throw err;
  }
  if (x.state !== 'done') throw new Error(x.error || 'Transkripsi gagal');
  onProgress(0.97, 'Membuat subtitle…');
  const res = await (await fetch(x.resultUrl, { credentials: 'same-origin' })).json();
  return res;
}

/**
 * Subtitle lines from the transcript: words grouped into short lines (maxChars), split at pauses and sentence ends,
 * each line shown from its first word to its last (and a little longer when nothing follows soon).
 */
export function cuesFromSegments(segments, { maxChars = LINE_LENGTH.medium, upper = false } = {}) {
  const cues = [];
  const push = (words, fallback) => {
    const text = (fallback ?? words.map((w) => w.word).join('')).replace(/\s+/g, ' ').trim();
    if (!text) return;
    // (v1.12) each word's time, for kinetic text that pops or lights up as the word is said
    const said = fallback == null ? words.filter((w) => w.word.trim()).map((w) => [w.start, w.end]) : null;
    cues.push({ start: words[0].start, end: words[words.length - 1].end, text: upper ? text.toUpperCase() : text, ...(said ? { words: said } : {}) });
  };
  for (const s of segments || []) {
    const words = (s.words || []).filter((w) => w.word && w.end > w.start - 1e-3);
    if (!words.length) {
      // no word times: the segment's text spread over its time by length
      const parts = String(s.text || '').trim().split(/\s+/);
      let line = [];
      const lines = [];
      for (const p of parts) { if (line.join(' ').length + p.length + 1 > maxChars && line.length) { lines.push(line.join(' ')); line = []; } line.push(p); }
      if (line.length) lines.push(line.join(' '));
      const tot = lines.reduce((a, l) => a + l.length, 0) || 1;
      let t = s.start;
      for (const l of lines) { const d = ((s.end - s.start) * l.length) / tot; cues.push({ start: t, end: t + d, text: upper ? l.toUpperCase() : l }); t += d; }
      continue;
    }
    let cur = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const text = cur.map((x) => x.word).join('') + w.word;
      const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
      if (cur.length && (text.trim().length > maxChars || gap > 0.6)) { push(cur); cur = []; }
      cur.push(w);
      if (/[.!?…]$/.test(w.word.trim()) && cur.map((x) => x.word).join('').trim().length >= maxChars * 0.4) { push(cur); cur = []; }
    }
    if (cur.length) push(cur);
  }
  // timing: never overlapping, at least 0.5 s on screen, held up to 0.4 s longer into a silence
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    const limit = next ? next.start : Infinity;
    c.end = Math.min(limit, Math.max(c.end + Math.min(0.4, (limit - c.end) / 2), c.start + 0.5));
    if (c.end <= c.start) c.end = c.start + 0.3;
  }
  return cues;
}
