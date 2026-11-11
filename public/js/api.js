// MCP tool implementations (run inside the editor tab). Names/arguments match mcp/tools.js.
import {
  store, summarizeClip, sortedClips, setSpeed, clipEnd, KF_PROPS, projectDuration,
} from './store.js';
import { importFromServerUrl, mediaRT } from './media.js';
import {
  ASPECTS, FILTERS, EFFECTS, TRANSITIONS, ANIM_IN, ANIM_OUT, ANIM_LOOP, TEXT_PRESETS, TEXT_TEMPLATES, FONTS, BLEND_MODES, STICKERS, BADGES, RESOLUTIONS,
} from './presets.js';
import * as actions from './actions.js';
import { setAspect } from './player.js';
import { exportState } from './exporter.js';
import { clamp, normHex, deepMerge } from './util.js';

const ids = (a) => a.map((x) => x.id);
const r3 = (v) => Math.round(v * 1000) / 1000;

function need(cond, msg) { if (!cond) throw new Error(msg); }
function oneOf(value, list, what) {
  if (value == null) return value;
  need(list.includes(value), `Unknown ${what} "${value}". Valid: ${list.join(', ')}`);
  return value;
}
function color(v, what = 'color') {
  const c = normHex(v);
  need(c, `${what} must be a hex color like #ff0055 (got ${v})`);
  return c;
}
function getClip(id) {
  const c = store.clip(id);
  need(c, `Clip not found: ${id}. Call get_project for valid clip ids.`);
  return c;
}

/** Apply text-style arguments (snake_case) onto a text style object. */
function applyTextStyle(tx, a) {
  if (a.preset) {
    oneOf(a.preset, ids(TEXT_PRESETS), 'preset');
    const content = tx.content;
    const base = actions.presetStyle(a.preset);
    for (const k of Object.keys(tx)) delete tx[k];
    Object.assign(tx, base, { content });
  }
  if (a.font) { oneOf(a.font, FONTS.map((f) => f.name), 'font'); tx.font = a.font; }
  if (a.size != null) tx.size = clamp(Number(a.size), 8, 600);
  if (a.color) tx.color = color(a.color);
  if (a.bold != null) tx.weight = a.bold ? Math.max(700, tx.weight) : 400;
  if (a.italic != null) tx.italic = !!a.italic;
  if (a.align) tx.align = oneOf(a.align, ['left', 'center', 'right'], 'align');
  if (a.letter_spacing != null) tx.letterSpacing = Number(a.letter_spacing);
  if (a.line_height != null) tx.lineHeight = clamp(Number(a.line_height), 0.5, 4);
  if (a.stroke_color) { tx.stroke.color = color(a.stroke_color, 'stroke_color'); tx.stroke.enabled = true; }
  if (a.stroke_width != null) { tx.stroke.width = Math.max(0, Number(a.stroke_width)); tx.stroke.enabled = tx.stroke.width > 0; }
  if (a.background_color) {
    if (a.background_color === 'none') tx.bg.enabled = false;
    else { tx.bg.color = color(a.background_color, 'background_color'); tx.bg.enabled = true; }
  }
  if (a.background_opacity != null) tx.bg.opacity = clamp(Number(a.background_opacity), 0, 1);
  if (a.shadow != null) tx.shadow.enabled = !!a.shadow;
  if (a.gradient_from === 'none' || a.gradient_to === 'none') tx.gradient.enabled = false;
  else if (a.gradient_from || a.gradient_to) {
    if (a.gradient_from) tx.gradient.from = color(a.gradient_from, 'gradient_from');
    if (a.gradient_to) tx.gradient.to = color(a.gradient_to, 'gradient_to');
    tx.gradient.enabled = true;
  }
}

function applyVisual(c, a) {
  const set = (k, v) => {
    c[k] = v;
    if (c.keyframes?.length && KF_PROPS.includes(k)) for (const kf of c.keyframes) kf[k] = v;
  };
  if (a.x != null) set('x', Number(a.x));
  if (a.y != null) set('y', Number(a.y));
  if (a.scale != null) set('scale', clamp(Number(a.scale), 0.01, 20));
  if (a.rotation != null) set('rotation', Number(a.rotation));
  if (a.opacity != null) set('opacity', clamp(Number(a.opacity), 0, 1));
  if (a.flip_h != null) c.flipH = !!a.flip_h;
  if (a.flip_v != null) c.flipV = !!a.flip_v;
  if (a.blend_mode) c.blend = oneOf(a.blend_mode, ids(BLEND_MODES), 'blend_mode');
  for (const [k, ck] of [['crop_left', 'l'], ['crop_right', 'r'], ['crop_top', 't'], ['crop_bottom', 'b']]) {
    if (a[k] != null && c.crop) c.crop[ck] = clamp(Number(a[k]), 0, 0.9);
  }
}
function applyAnim(c, a) {
  if (!c.animIn) return;
  if (a.animation_in) c.animIn.type = oneOf(a.animation_in, ids(ANIM_IN), 'animation_in');
  if (a.animation_out) c.animOut.type = oneOf(a.animation_out, ids(ANIM_OUT), 'animation_out');
  if (a.animation_loop) c.animLoop.type = oneOf(a.animation_loop, ids(ANIM_LOOP), 'animation_loop');
  if (a.animation_in_duration != null) c.animIn.duration = clamp(Number(a.animation_in_duration), 0.05, 10);
  if (a.animation_out_duration != null) c.animOut.duration = clamp(Number(a.animation_out_duration), 0.05, 10);
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
    if (a.font) oneOf(a.font, FONTS.map((f) => f.name), 'font');
    const created = actions.addSubtitles(a.items, {
      preset: a.preset || 'subtitle', y: a.y ?? 0.36, size: a.size, font: a.font, color: a.color ? color(a.color) : undefined,
      animIn: a.animation_in || 'fade', replace: !!a.replace_existing,
    });
    return { data: { created: created.length, clip_ids: created, track: store.P.tracks.find((t) => t.subtitle)?.id } };
  },

  async add_sticker(a) {
    need(a.emoji || a.badge_text, 'Provide emoji or badge_text');
    const badge = a.badge_text ? { text: String(a.badge_text).toUpperCase(), bg: a.badge_color ? color(a.badge_color) : '#ff0033', fg: a.badge_text_color ? color(a.badge_text_color) : '#ffffff', icon: '' } : null;
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
    const c = actions.addEffect({ effect: a.effect, start: a.start, duration: a.duration || 3, intensity: a.intensity ?? 0.7 });
    focus(c.id);
    return { data: summarizeClip(store.P, c) };
  },

  async update_clip(a) {
    const c = getClip(a.clip_id);
    if (a.start != null && c.trackId === 'main' && store.P.magnet) actions.moveClip(c.id, { start: Number(a.start) });
    store.mutate('AI: ubah klip', (P) => {
      if (a.start != null && !(c.trackId === 'main' && P.magnet)) c.start = Math.max(0, Number(a.start));
      if (a.source_in != null && 'in' in c) c.in = Math.max(0, Number(a.source_in));
      if (a.speed != null && c.type !== 'text') setSpeed(P, c, a.speed);
      if (a.duration != null) c.duration = Math.max(0.1, Number(a.duration));
      if (a.volume != null && 'volume' in c) c.volume = clamp(Number(a.volume), 0, 2);
      if (a.muted != null && 'muted' in c) c.muted = !!a.muted;
      if (a.fade_in != null && 'fadeIn' in c) c.fadeIn = Math.max(0, Number(a.fade_in));
      if (a.fade_out != null && 'fadeOut' in c) c.fadeOut = Math.max(0, Number(a.fade_out));
      if ('x' in c) applyVisual(c, a);
      if (c.type === 'text') {
        if (a.text != null) { c.text.content = String(a.text); c.name = c.text.content.split('\n')[0].slice(0, 40); }
        applyTextStyle(c.text, a);
      }
      if (a.filter && c.filter) c.filter.name = oneOf(a.filter, ids(FILTERS), 'filter');
      if (a.filter_intensity != null && c.filter) c.filter.intensity = clamp(Number(a.filter_intensity), 0, 1);
      if (a.adjust && c.adjust) for (const [k, v] of Object.entries(a.adjust)) if (k in c.adjust) c.adjust[k] = Number(v);
      applyAnim(c, a);
      if (a.transition && c.transition) c.transition.type = oneOf(a.transition, ids(TRANSITIONS), 'transition');
      if (a.transition_duration != null && c.transition) c.transition.duration = clamp(Number(a.transition_duration), 0.1, 5);
      if (c.type === 'effect') {
        if (a.effect) { c.effect.type = oneOf(a.effect, ids(EFFECTS), 'effect'); c.name = EFFECTS.find((e) => e.id === a.effect).name; }
        if (a.intensity != null) c.effect.intensity = clamp(Number(a.intensity), 0, 1);
      }
      if (c.type === 'solid') {
        if (a.color) c.solid.color = color(a.color);
        if (a.color2 === 'none') c.solid.color2 = null;
        else if (a.color2) c.solid.color2 = color(a.color2, 'color2');
      }
      if (c.type === 'sticker' && c.sticker.badge) {
        if (a.color) c.sticker.badge.bg = color(a.color);
        if (a.text) c.sticker.badge.text = String(a.text);
      }
      if (a.name) c.name = String(a.name).slice(0, 60);
    });
    focus(c.id);
    return { data: summarizeClip(store.P, store.clip(c.id)) };
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
    return { data: { time: r3(t), width: canvas.width, height: canvas.height, visible_clips: visible }, image: { data: url.split(',')[1], mimeType: fmt } };
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
    actions.app.runExport(opts, { saveToServer: true, download: false, fromAI: true });
    await new Promise((r) => setTimeout(r, 300));
    return { data: { started: true, estimated_seconds: Math.ceil(store.duration()) + 2, options: exportState.options, note: 'Rendering in real time. Poll get_export_status.' } };
  },

  async get_export_status() {
    const s = exportState;
    return {
      data: {
        state: s.state,
        phase: s.phase || undefined,
        progress_percent: Math.round((s.progress || 0) * 100),
        error: s.error || undefined,
        options: s.options || undefined,
        result: s.result ? { file: s.result.filename, path: s.result.serverPath, url: s.result.serverUrl, size_bytes: s.result.size, width: s.result.width, height: s.result.height, fps: s.result.fps, duration: r3(s.result.duration || 0), mime: s.result.mime } : undefined,
      },
    };
  },
};

export { sortedClips, deepMerge };
