// MCP tool implementations (run inside the editor tab). Names/arguments match mcp/tools.js.
import {
  store, summarizeClip, sortedClips, clipEnd, projectDuration,
} from './store.js';
import { importFromServerUrl, mediaRT } from './media.js';
import {
  ASPECTS, FILTERS, EFFECTS, TRANSITIONS, ANIM_IN, ANIM_OUT, ANIM_LOOP, TEXT_PRESETS, TEXT_TEMPLATES, FONTS, BLEND_MODES, STICKERS, BADGES, RESOLUTIONS,
} from './presets.js';
import * as actions from './actions.js';
import { need, oneOf, color, fontFamily, applyTextStyle, applyVisual, applyAnim, updateClip } from './core/clipedit.js';
import { setAspect } from './player.js';
import { exportState, cancelExport } from './exporter.js';
import { createJobs, runJob } from './core/jobs.js';
import { bridge } from './bridge.js';
import { clamp, deepMerge } from './util.js';
import { STYLES, checkMaterial } from './styles.js';
import { generateStyle, getTranscript } from './stylerun.js';
import { startBgRemove, cancelBgRemove, bgStatus } from './bgremove.js';
import { colorOf } from './moments.js';

const ids = (a) => a.map((x) => x.id);
const r3 = (v) => Math.round(v * 1000) / 1000;

function getClip(id) {
  const c = store.clip(id);
  need(c, `Clip not found: ${id}. Call get_project for valid clip ids.`);
  return c;
}

function projectInfo() {
  const P = store.P;
  const order = new Map(P.tracks.map((t, i) => [t.id, i]));
  return {
    name: P.name,
    aspect_ratio: P.aspect,
    canvas: { width: P.width, height: P.height, note: 'virtual canvas units; the short side is 1080' },
    fps: P.fps,
    duration: r3(projectDuration(P)),
    playhead: r3(actions.app.engine.time),
    background: P.background,
    magnetic_main_track: P.magnet,
    selected_clip: store.selection,
    tracks: P.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, muted: t.muted, hidden: t.hidden, locked: t.locked, subtitle: !!t.subtitle, clips: P.clips.filter((c) => c.trackId === t.id).length })),
    clips: P.clips.slice().sort((a, b) => order.get(a.trackId) - order.get(b.trackId) || a.start - b.start).map((c) => summarizeClip(P, c)),
    media: listMedia(),
  };
}
function listMedia() {
  return store.P.media.map((m) => ({
    id: m.id, name: m.name, type: m.type, duration: m.duration ? r3(m.duration) : undefined, width: m.width || undefined, height: m.height || undefined,
    status: mediaRT.get(m.id)?.convert ? 'converting' : (mediaRT.get(m.id)?.playError ? 'unplayable' : (mediaRT.get(m.id)?.status || 'ready')),
  }));
}

const focus = (clipId) => { if (clipId && store.clip(clipId)) store.select(clipId); };

// (v1.13.2, P1-2) long work as jobs: get_job / list_jobs / cancel_job follow and stop it
export const jobs = createJobs();
let exportJobId = null;
/** The export's status as get_export_status gives it (also the result of a finished export job). */
function exportInfo() {
  const s = exportState;
  return {
    state: s.state,
    phase: s.phase || undefined,
    mode: s.mode || undefined,
    progress_percent: Math.round((s.progress || 0) * 100),
    error: s.error || undefined,
    options: s.options || undefined,
    result: s.result ? { file: s.result.filename, path: s.result.serverPath, url: s.result.serverUrl, size_bytes: s.result.size, width: s.result.width, height: s.result.height, fps: s.result.fps, duration: r3(s.result.duration || 0), mime: s.result.mime, render_seconds: s.result.seconds != null ? r3(s.result.seconds) : undefined } : undefined,
    job_id: exportJobId || undefined,
  };
}
/** Run `work` as a background job that keeps the command line busy until it ends; answer with its job_id. */
function background(kind, work, what) {
  const { id, done } = runJob(jobs, kind, work);
  bridge.hold(done);
  return { data: { started: true, job_id: id, note: `${what} runs in the background. Poll get_job with this job_id (it answers at once); other editing tools wait until it is done. cancel_job stops it.` } };
}

export const tools = {
  async get_project() { return { data: projectInfo() }; },

  async list_assets() {
    return {
      data: {
        aspect_ratios: Object.fromEntries(Object.entries(ASPECTS).map(([k, a]) => [k, `${a.w}x${a.h} (${a.hint})`])),
        export_resolutions: Object.keys(RESOLUTIONS),
        filters: FILTERS.map((f) => ({ id: f.id, name: f.name })),
        effects: EFFECTS.map((f) => ({ id: f.id, name: f.name, category: f.cat })),
        transitions: TRANSITIONS.map((t) => ({ id: t.id, name: t.name })),
        animations: { in: ids(ANIM_IN), out: ids(ANIM_OUT), loop: ids(ANIM_LOOP) },
        text_presets: TEXT_PRESETS.map((p) => ({ id: p.id, name: p.name })),
        text_templates: TEXT_TEMPLATES.map((t) => ({ id: t.id, name: t.name, sample: t.text })),
        fonts: FONTS.map((f) => f.name),
        blend_modes: ids(BLEND_MODES),
        sticker_emojis: STICKERS.join(' '),
        badges: BADGES.map((b) => ({ id: b.id, text: b.text })),
      },
    };
  },

  async new_project({ name, aspect_ratio }) {
    if (aspect_ratio) oneOf(aspect_ratio, Object.keys(ASPECTS), 'aspect_ratio');
    await actions.app.newProject({ name: name || 'Proyek AI', aspect: aspect_ratio || '16:9' });
    return { data: projectInfo() };
  },

  async set_project(a) {
    if (a.aspect_ratio) setAspect(oneOf(a.aspect_ratio, Object.keys(ASPECTS), 'aspect_ratio'));
    store.mutate('Pengaturan proyek', (P) => {
      if (a.name) P.name = String(a.name).slice(0, 80);
      if (a.fps) P.fps = Number(oneOf(Number(a.fps), [24, 25, 30, 50, 60], 'fps'));
      if (a.background_mode) P.background.mode = oneOf(a.background_mode, ['color', 'blur'], 'background_mode');
      if (a.background_color) P.background.color = color(a.background_color, 'background_color');
      if (a.background_blur != null) P.background.blur = clamp(Number(a.background_blur), 0, 100);
    });
    if (a.name) store.emit('rename');
    return { data: projectInfo() };
  },

  async import_media(a) {
    need(a.server_url, 'Server did not provide the file.');
    const m = await importFromServerUrl(a.server_url, a.name, a.mime);
    const out = { media_id: m.id, name: m.name, type: m.type, duration: m.duration ? r3(m.duration) : undefined, width: m.width || undefined, height: m.height || undefined };
    if (a.add_to_timeline) {
      const c = actions.addMediaClip(m.id, { start: a.start });
      out.clip = summarizeClip(store.P, c);
      focus(c.id);
    }
    return { data: out };
  },

  async list_media() { return { data: listMedia() }; },

  async add_media_clip(a) {
    const m = store.media(a.media_id);
    need(m, `Media not found: ${a.media_id}. Call list_media.`);
    const props = {};
    if (a.speed) props.speed = clamp(Number(a.speed), 0.1, 10);
    if (a.volume != null && m.type !== 'image') props.volume = clamp(Number(a.volume), 0, 2);
    const c = actions.addMediaClip(a.media_id, { track: a.track || 'auto', start: a.start, sourceIn: a.source_in || 0, duration: a.duration, props });
    store.mutate('AI: properti klip', () => {
      if (m.type !== 'audio') { applyVisual(c, a); applyAnim(c, a); }
      if (a.filter) c.filter = { name: oneOf(a.filter, ids(FILTERS), 'filter'), intensity: 1 };
    });
    if (a.transition && a.transition !== 'none' && c.trackId === 'main') {
      try { actions.applyTransition(c.id, a.transition); } catch { /* first clip has no previous */ }
    }
    focus(c.id);
    return { data: summarizeClip(store.P, store.clip(c.id)) };
  },

  async add_text(a) {
    need(a.text != null && String(a.text).length, 'text is required');
    if (a.template) oneOf(a.template, ids(TEXT_TEMPLATES), 'template');
    const c = actions.addText({ text: String(a.text), template: a.template, preset: a.preset || 'default', start: a.start, duration: a.duration || 3, track: a.track || 'auto' });
    store.mutate('AI: gaya teks', () => {
      const style = { ...a };
      if (a.template && !a.preset) delete style.preset;
      applyTextStyle(c.text, style);
      applyVisual(c, a);
      applyAnim(c, a);
    });
    focus(c.id);
    return { data: summarizeClip(store.P, store.clip(c.id)) };
  },

  async add_subtitles(a) {
    need(Array.isArray(a.items) && a.items.length, 'items must be a non-empty array of {start, end, text}');
    if (a.preset) oneOf(a.preset, ids(TEXT_PRESETS), 'preset');
    if (a.font) { a.font = fontFamily(a.font); oneOf(a.font, FONTS.map((f) => f.name), 'font'); }
    const created = actions.addSubtitles(a.items, {
      preset: a.preset || 'subtitle', y: a.y ?? 0.36, size: a.size, font: a.font, color: a.color ? color(a.color) : undefined,
      animIn: a.animation_in || 'fade', replace: !!a.replace_existing,
    });
    // (v1.12) kinetic captions: every line the same (they are linked)
    if (a.text_motion && a.text_motion !== 'none') {
      const k = { text_motion: a.text_motion, text_motion_spring: a.text_motion_spring, text_motion_speed: a.text_motion_speed, text_motion_color: a.text_motion_color };
      store.mutate('AI: subtitle kinetik', () => { for (const id of created) { const c = store.clip(id); if (c?.text) applyTextStyle(c.text, k); } });
    }
    const timed = created.filter((id) => Array.isArray(store.clip(id)?.text?.words)).length;
    return { data: { created: created.length, clip_ids: created, track: store.P.tracks.find((t) => t.subtitle)?.id, ...(a.text_motion ? { text_motion: a.text_motion, lines_timed_to_speech: timed } : {}) } };
  },

  async add_sticker(a) {
    need(a.emoji || a.badge_text || a.color_circle, 'Provide emoji, badge_text or color_circle');
    if (a.color_circle) {
      // (v1.12.6) a colour circle with its name under it
      const col = colorOf(a.color_circle);
      need(col, `Unknown colour "${a.color_circle}". Use a hex colour (#RRGGBB) or a name such as hitam, putih, cream, pink, navy, sage.`);
      const c = actions.addSticker({ emoji: '', start: a.start, duration: a.duration || 3 });
      store.mutate('AI: bulatan warna', () => {
        const x = store.clip(c.id);
        x.sticker = { emoji: '', badge: null, swatch: { color: col.hex, label: a.label ?? (/^#/.test(a.color_circle) ? '' : col.label), font: 'Poppins', weight: 700, italic: false, labelColor: '#ffffff' } };
        x.name = `Warna ${x.sticker.swatch.label || col.hex}`;
        x.scale = 1;
        if (!a.animation_in) x.animIn = { type: 'pop', duration: 0.3 };
        applyVisual(x, a);
        applyAnim(x, a);
      });
      focus(c.id);
      return { data: summarizeClip(store.P, store.clip(c.id)) };
    }
    const badge = a.badge_text ? { text: String(a.badge_text).toUpperCase(), bg: a.badge_color ? color(a.badge_color) : '#ff0033', fg: a.badge_text_color ? color(a.badge_text_color) : '#ffffff', icon: a.emoji || '' } : null;
    const c = actions.addSticker({ emoji: a.emoji, badge, start: a.start, duration: a.duration || 3 });
    store.mutate('AI: stiker', () => { applyVisual(c, a); applyAnim(c, a); });
    focus(c.id);
    return { data: summarizeClip(store.P, store.clip(c.id)) };
  },

  async add_solid(a) {
    const c = actions.addSolid({ color: color(a.color), color2: a.color2 ? color(a.color2, 'color2') : null, angle: a.angle ?? 135, start: a.start, duration: a.duration || 3, track: a.track || 'main' });
    focus(c.id);
    return { data: summarizeClip(store.P, c) };
  },

  async add_effect(a) {
    oneOf(a.effect, ids(EFFECTS), 'effect');
    if (a.clip_id) {
      // (v1.10.2) on the footage itself: only that clip, and it moves with the clip
      const target = getClip(a.clip_id);
      const list = (target.fx || []).filter((f) => f.type !== a.effect);
      actions.setClipEffects(target.id, [...list, { type: a.effect, intensity: a.intensity ?? 0.8 }]);
      focus(target.id);
      return { data: summarizeClip(store.P, store.clip(target.id)) };
    }
    const c = actions.addEffect({ effect: a.effect, start: a.start, duration: a.duration || 3, intensity: a.intensity ?? 0.7 });
    focus(c.id);
    return { data: summarizeClip(store.P, c) };
  },

  async update_clip(a) {
    const c = getClip(a.clip_id);
    let note = null;
    // (v1.13.2, V20) everything is checked before anything changes, so a refused call leaves the project exactly as
    // it was (before, the values ahead of a refused one were already in, without an undo step, and a magnet move
    // had already happened): the edit runs on a copy first, then the background and effect checks
    updateClip(JSON.parse(store.snapshot()), c.id, { ...a });
    if (a.remove_background != null) need(c.type === 'video' || c.type === 'image', 'remove_background is for video and photo clips');
    if (Array.isArray(a.clip_effects)) actions.checkClipEffects(c.id, a.clip_effects.map((f) => ({ type: f.effect || f.type, intensity: f.intensity })));
    if (a.start != null && c.trackId === 'main' && store.P.magnet) actions.moveClip(c.id, { start: Number(a.start) });
    // (v1.13.2, P0-6b) the edit itself is core/clipedit.js updateClip (pure, the same code the tests replay)
    store.mutate('AI: ubah klip', (P) => { updateClip(P, c.id, a); });
    if (a.remove_background != null) {
      need(c.type === 'video' || c.type === 'image', 'remove_background is for video and photo clips');
      // (v1.11) one way: the background goes, every object in front stays; the clip is analysed once (device GPU or
      // server) — the analysis runs on, get_project shows remove_background.analysing / ready
      if (a.remove_background && a.remove_background !== 'off') {
        const p = startBgRemove(c.id);
        // (the analysis can take a while: wait a little for an early error, then answer)
        const early = await Promise.race([p.then(() => null, (err) => err), new Promise((r) => setTimeout(() => r(null), 1500))]);
        if (early) throw early;
        p.catch(() => {});
      } else {
        if (bgStatus(store.clip(c.id))?.state === 'running') await cancelBgRemove(c.id);
        store.mutate('AI: latar kembali', () => { const x = store.clip(c.id); x.cutout = { ...(x.cutout || {}), enabled: false }; });
      }
      if (a.remove_background_threshold != null) store.mutate('AI: ketelitian latar', () => { const x = store.clip(c.id); x.cutout = { ...(x.cutout || {}), threshold: clamp(Number(a.remove_background_threshold), 0.1, 0.9) }; });
    }
    if (Array.isArray(a.clip_effects)) actions.setClipEffects(c.id, a.clip_effects.map((f) => ({ type: f.effect || f.type, intensity: f.intensity })));
    focus(c.id);
    return { data: { ...summarizeClip(store.P, store.clip(c.id)), ...(note ? { note } : {}) } };
  },

  async apply_filter(a) {
    oneOf(a.filter, ids(FILTERS), 'filter');
    if (a.clip_id !== 'all') getClip(a.clip_id);
    const changed = actions.applyFilter(a.clip_id, a.filter, a.intensity ?? 1);
    return { data: { filter: a.filter, clip_ids: changed } };
  },

  async apply_transition(a) {
    oneOf(a.transition, ids(TRANSITIONS), 'transition');
    const changed = actions.applyTransition(a.clip_id, a.transition, a.duration ?? 0.6);
    return { data: { transition: a.transition, clip_ids: changed } };
  },

  async split_clip(a) {
    const t = a.time ?? actions.app.engine.time;
    if (a.clip_id) {
      const c = getClip(a.clip_id);
      need(t > c.start + 0.05 && t < clipEnd(c) - 0.05, `time ${t} is not inside clip ${c.id} (${r3(c.start)}–${r3(clipEnd(c))})`);
    }
    const pairs = actions.splitAt(t, a.clip_id);
    need(pairs.length, `Nothing to split at ${t}s`);
    return { data: { time: t, splits: pairs.map(([left, right]) => ({ left, right })) } };
  },

  async delete_clip(a) {
    const list = a.clip_ids || (a.clip_id ? [a.clip_id] : []);
    need(list.length, 'Provide clip_id or clip_ids');
    for (const id of list) getClip(id);
    const n = actions.deleteClips(list);
    return { data: { deleted: n, duration: r3(store.duration()) } };
  },

  async move_clip(a) {
    getClip(a.clip_id);
    const c = actions.moveClip(a.clip_id, { start: a.start, track: a.track });
    focus(c.id);
    return { data: summarizeClip(store.P, store.clip(a.clip_id)) };
  },

  async duplicate_clip(a) {
    getClip(a.clip_id);
    const c = actions.duplicateClip(a.clip_id, a.start);
    return { data: summarizeClip(store.P, c) };
  },

  async playback(a) {
    const E = actions.app.engine;
    switch (oneOf(a.action, ['play', 'pause', 'stop', 'seek'], 'action')) {
      case 'play': E.play(); break;
      case 'pause': E.pause(); break;
      case 'stop': E.pause(); E.seek(0); break;
      case 'seek': need(a.time != null, 'time is required for seek'); E.seek(Number(a.time)); break;
      default: break;
    }
    return { data: { playing: E.playing, playhead: r3(E.time), duration: r3(store.duration()) } };
  },

  async get_frame(a) {
    const E = actions.app.engine;
    const t = a.time != null ? clamp(Number(a.time), 0, Math.max(0, store.duration() - 0.001)) : E.time;
    const canvas = await E.capture(t, clamp(Number(a.max_width || 960), 64, 3840));
    const fmt = a.format === 'png' ? 'image/png' : 'image/jpeg';
    const url = canvas.toDataURL(fmt, 0.86);
    const visible = store.P.clips.filter((c) => t >= c.start && t < clipEnd(c)).map((c) => `${c.id} (${c.type})`);
    const data = { time: r3(t), width: canvas.width, height: canvas.height, visible_clips: visible };
    if (canvas.staleClips?.length) {
      data.stale_video = canvas.staleClips;
      data.note = 'These video clips were still loading, so their picture may be from another moment. Call get_frame again for an exact frame.';
    }
    return { data, image: { data: url.split(',')[1], mimeType: fmt } };
  },

  async history(a) {
    const steps = clamp(Number(a.steps || 1), 1, 50);
    let done = 0;
    for (let i = 0; i < steps; i++) if (a.action === 'redo' ? store.redo() : store.undo()) done++;
    return { data: { action: a.action, steps: done, can_undo: store.past.length > 0, can_redo: store.future.length > 0 } };
  },

  async export_video(a) {
    need(store.duration() > 0, 'The timeline is empty; add clips before exporting.');
    need(exportState.state !== 'running', 'An export is already running. Poll get_export_status.');
    if (a.resolution) oneOf(a.resolution, Object.keys(RESOLUTIONS), 'resolution');
    const opts = { resolution: a.resolution || '1080p', fps: Number(a.fps) || store.P.fps, format: a.format || 'mp4', quality: a.quality || 'recommended', filename: a.filename || store.P.name };
    // (v1.13.2) the export is a job too: get_job follows it, cancel_job stops it (its temporary file is removed)
    const id = jobs.create('export', { cancel: () => cancelExport(), live: () => ({ progress: exportState.progress, label: exportState.phase || undefined }) });
    exportJobId = id;
    const settle = () => {
      const st = exportState.state;
      if (st === 'done') jobs.finish(id, { state: 'done', result: exportInfo() });
      else if (st === 'cancelled') jobs.finish(id, { state: 'cancelled', error: 'Cancelled.' });
      else jobs.finish(id, { state: 'error', error: exportState.error || 'The export did not finish.' });
    };
    Promise.resolve(actions.app.runExport(opts, { saveToServer: true, download: false, fromAI: true })).then(settle, settle);
    await new Promise((r) => setTimeout(r, 300));
    return { data: { started: true, job_id: id, estimated_seconds: Math.ceil(store.duration()) + 2, options: exportState.options, note: 'Rendering: fast (WebCodecs) when this browser supports it, otherwise in real time. Poll get_export_status or get_job; cancel_job stops it.' } };
  },

  async get_export_status() {
    return { data: exportInfo() };
  },

  // ---- Style Konsep (v1.10) -------------------------------------------------------------------
  async list_styles() {
    const c = checkMaterial(store.P);
    return {
      data: {
        styles: STYLES.map((st) => ({ id: st.id, name: st.name, about: st.about, needs: st.needs, needs_speech: st.speech, fits_material: c.styles[st.id].ok, note: c.styles[st.id].note, color_filter: st.filter, default_music: st.music })),
        recommended: c.recommended,
        material: { talking_videos: c.talks, other_clips: c.shots, talking_seconds: r3(c.talkSec), transcript_pending: c.pending },
        how: 'Call get_transcript for the words and times (speech styles), write a plan, then apply_style. apply_style also works without a plan (automatic choices).',
      },
    };
  },

  async get_transcript(a) {
    const run = async ({ signal, onProgress } = {}) => {
      const sp = await getTranscript({ lang: a.language || 'id', force: !!a.refresh, signal, onProgress });
      need(sp.words.length, 'No speech found in the project videos (no one talks, or there is no video yet). Showcase Clean needs no speech.');
      return transcriptData(sp);
    };
    if (a.background) return background('transcript', run, 'The transcript');
    return { data: await run() };
  },

  async apply_style(a) {
    oneOf(a.style, STYLES.map((x) => x.id), 'style');
    const p = a.product || {};
    const product = {
      name: p.name, variant: p.variant ?? p.variants, size: p.size ?? p.sizes, note: p.note ?? p.notes, price: p.price, price_discount: p.price_discount, brand: p.brand,
    };
    for (const k of Object.keys(product)) if (product[k] == null) delete product[k];
    const run = async ({ signal, onProgress } = {}) => {
      const res = await generateStyle(a.style, { product, plan: a.plan || null, target: a.target === 'current' ? 'current' : 'new', lang: a.language || 'id', signal, onProgress });
      return { ...res, next: 'The edit is in the editor now. Check it with get_frame at a few times (title, a keyword, the price, the end) and adjust with update_clip or another apply_style.' };
    };
    if (a.background) return background('style', run, 'The style edit');
    return { data: await run() };
  },

  // ---- jobs (v1.13.2, P1-2) ---------------------------------------------------------------------
  async get_job(a) {
    const v = jobs.get(a.job_id);
    need(v, `Unknown job_id: ${a.job_id}. Call list_jobs.`);
    return { data: v };
  },
  async list_jobs() { return { data: { jobs: jobs.list() } }; },
  async cancel_job(a) { return { data: jobs.cancel(a.job_id) }; },
};

/** The answer of get_transcript (also the result of its background job). */
function transcriptData(sp) {
  return {
    language: sp.language, duration: sp.duration, sources: sp.sources,
    sentences: sp.sentences,
    words: sp.words.map((w) => ({ i: w.i, w: w.w, s: w.s, e: w.e })),
    note: 'Times are speech times: the talking videos back to back in project order, before cuts. Use them in the plan of apply_style (cuts, keywords, price, hook, broll, stickers).',
  };
}


export { sortedClips, deepMerge };
