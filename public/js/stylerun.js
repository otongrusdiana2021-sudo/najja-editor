// Style Konsep in the editor (v1.10): what styles.js needs from the browser — the words of the talking videos
// (Whisper on the Najja server, once per video, kept in the project), a copy of the project for each generated
// edit (the project being worked on is never overwritten), the background music, and one undo step for the edit.
import { store } from './store.js';
import * as actions from './actions.js';
import { cacheProjectMedia, ensureStockAudio } from './media.js';
import { mixForSpeech } from './fastexport.js';
import { wav16, transcribeWav, transcribeStatus } from './captions.js';
import { STYLES, styleById, buildStyle, checkMaterial, speechTimeline } from './styles.js';
import { makeClip } from './store.js';
import { findFaces } from './faces.js';
import { sfxCues } from './stylefx.js';
import { baseSize, preloadFonts } from './render.js';
import { clone, uid } from './util.js';

const GAP = 1; // seconds of silence between videos in one transcription request

/** Videos whose words are not known yet (or all of them, when `force`). */
function untranscribed(P, force = false) {
  return P.media.filter((m) => m.type === 'video' && !m.stock && !m.cover && m.hasAudio !== false && (force || !P.speech?.[m.id]));
}

/**
 * Transcribe the project's videos that are not transcribed yet (one request for all of them) and keep the words in
 * the project (P.speech[mediaId] = { lang, words: [{ w, s, e }] }, times in the video). A video without speech gets
 * an empty word list, so it is known as a shot.
 */
export async function transcribeMaterial({ lang = 'id', onProgress = () => {}, signal, force = false } = {}) {
  const P = store.P;
  const todo = untranscribed(P, force);
  if (!todo.length) return { transcribed: 0 };
  const st = await transcribeStatus();
  if (!st.ok) throw new Error(`Transkripsi belum bisa: ${st.reason}`);
  let t = 0;
  const clips = todo.map((m) => {
    const c = makeClip('video', { mediaId: m.id, trackId: 'main', start: t, duration: Math.max(0.1, m.duration || 0.1), in: 0 });
    t += c.duration + GAP;
    return c;
  });
  onProgress(0.02, 'Menyiapkan suara…');
  await cacheProjectMedia({ ...P, clips }, (p) => onProgress(0.02 + p * 0.1, 'Menyiapkan suara…'));
  const buf = await mixForSpeech(P, clips);
  const speech = { ...(P.speech || {}) };
  let language = lang === 'auto' ? null : lang;
  if (buf) {
    const res = await transcribeWav(wav16(buf), { lang, name: P.name || 'style', onProgress, signal });
    language = res.language || language;
    const all = [];
    for (const seg of res.segments || []) {
      if (seg.words?.length) for (const w of seg.words) all.push({ w: String(w.word || '').trim(), s: w.start, e: w.end });
      else {
        // (no word times: the segment's words spread over it)
        const parts = String(seg.text || '').trim().split(/\s+/).filter(Boolean);
        parts.forEach((p, i) => all.push({ w: p, s: seg.start + ((seg.end - seg.start) * i) / parts.length, e: seg.start + ((seg.end - seg.start) * (i + 1)) / parts.length }));
      }
    }
    for (const c of clips) {
      const words = all.filter((w) => w.w && w.s >= c.start - 0.05 && w.s < c.start + c.duration + GAP / 2)
        .map((w) => ({ w: w.w, s: round(Math.max(0, w.s - c.start)), e: round(Math.min(c.duration, Math.max(w.s, w.e) - c.start)) }));
      speech[c.mediaId] = { lang: language, words };
    }
  } else {
    for (const c of clips) speech[c.mediaId] = { lang: language, words: [] };
  }
  // (kept without an undo step: it describes the material, it does not change the edit)
  store.P.speech = speech;
  store.scheduleSave();
  return { transcribed: clips.length, language };
}
const round = (v) => Math.round(v * 1000) / 1000;

/** The talking videos back to back and their words, transcribing what is missing first. */
export async function getTranscript(opts = {}) {
  await transcribeMaterial(opts);
  return speechTimeline(store.P);
}

/** A copy of the current project under a new name, opened in the editor. The original stays as it is. */
async function forkProject(name) {
  const { engine } = actions.app;
  engine?.pause();
  await store.save();
  const copy = clone(store.P);
  // (a style of a style's project is still a style of the original: same material, same name)
  copy.styleSource = store.P.styleSource || { id: store.P.id, name: store.P.name || 'Proyek' };
  copy.id = uid('p');
  delete copy.rev;
  delete copy.ownerId;
  copy.name = name.slice(0, 80);
  copy.createdAt = copy.updatedAt = Date.now();
  store.setProject(copy, { dirty: true });
  await store.save();
  return copy;
}

/**
 * Generate a style's edit. product: { name, variant, size, note, price, price_discount, brand }; plan: an edit plan
 * (AI) or none (automatic); target: 'new' (a copy of the project, default) or 'current'.
 * Resolves the build summary plus { project_id, project_name }.
 */
export async function generateStyle(styleId, { product = {}, plan = null, target = 'new', lang = 'id', onProgress = () => {}, signal } = {}) {
  const st = styleById(styleId);
  if (!st) throw new Error(`Style tidak dikenal: ${styleId}. Pilihan: ${STYLES.map((s) => s.id).join(', ')}`);
  if (st.speech) await transcribeMaterial({ lang, onProgress: (p, l) => onProgress(p * 0.8, l), signal });
  if (signal?.aborted) throw new Error('Dibatalkan');
  const check = checkMaterial(store.P);
  if (check.styles[styleId].ok === 'no') throw new Error(check.styles[styleId].note);
  // (v1.12.4) where the faces are, so no text covers one: each video once, kept in the project
  onProgress(0.8, 'Mencari wajah…');
  const faces = await findFaces(store.P, { onProgress: (p) => onProgress(0.8 + p * 0.04, 'Mencari wajah…'), signal });
  if (faces.looked) store.scheduleSave();
  if (signal?.aborted) throw new Error('Dibatalkan');
  onProgress(0.84, 'Menyusun edit…');
  // (the product is remembered in the original project, to fill the form next time)
  store.P.styleProduct = { ...product };
  store.scheduleSave();
  if (target !== 'current') await forkProject(`${store.P.styleSource?.name || store.P.name || 'Proyek'} · ${st.name}`);
  const musicId = plan?.music ?? st.music;
  let music = null;
  if (musicId && musicId !== 'none') {
    try {
      const m = await ensureStockAudio(musicId);
      music = { mediaId: m.id, duration: m.duration };
    } catch { /* no music: the edit is still made */ }
  }
  // a first build on a copy says which sounds and fonts the edit uses: those sounds are made, the fonts loaded (so
  // the texts are measured in their own font when they are kept off the faces)
  onProgress(0.9, 'Menyiapkan efek suara…');
  const level = ['full', 'graphics', 'none'].includes(plan?.sfx) ? plan.sfx : 'full';
  const dry = clone(store.P);
  buildStyle(dry, styleId, { product, plan, music });
  const sfx = {};
  for (const id of new Set(sfxCues(dry, { level }).map((q) => q.id))) {
    try {
      const m = await ensureStockAudio(id);
      sfx[id] = { mediaId: m.id, duration: m.duration };
    } catch { /* that sound is left out */ }
  }
  await preloadFonts(dry);
  const ctx = document.createElement('canvas').getContext('2d');
  onProgress(0.95, 'Menyusun edit…');
  const summary = store.mutate(`Style: ${st.name}`, (P) => {
    const measure = (c) => baseSize(c, { project: P }, ctx);
    const s = buildStyle(P, styleId, { product, plan, music, sfx, measure });
    P.style.product = { ...product };
    return s;
  });
  if (!faces.looked && faces.failed) summary.faces = { ...summary.faces, detection: `tidak jalan di perangkat ini (${faces.reason}); posisi wajah ditebak` };
  const { engine, timeline } = actions.app;
  store.select(null);
  engine?.seek(0);
  timeline?.fit?.();
  onProgress(1, 'Selesai');
  return { ...summary, project_id: store.P.id, project_name: store.P.name };
}

export { STYLES, styleById, checkMaterial };
