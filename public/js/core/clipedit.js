// (v1.13.2, P0-6b step 3) Changing a clip's properties (update_clip and the add_* tools that share these helpers):
// pure functions of the project P and a clip, changed in place. No store, engine, selection or DOM here. Moved as
// they were from api.js and actions.js (test/update-clip.test.js replays the behaviour recorded from that code).
// Kept as it was: a value refused part-way leaves the values before it applied (finding V20, fixed separately).
import { TEXT_PRESETS, DEFAULT_TEXT, FONTS, BLEND_MODES, ANIM_IN, ANIM_OUT, ANIM_LOOP, FILTERS, TRANSITIONS, EFFECTS } from '../presets.js';
import { clamp, normHex, clone, deepMerge } from '../util.js';
import { KINETIC, SPRINGS, makeMotion } from '../kinetic.js';
import { setSpeed, KF_PROPS } from '../store.js';

const ids = (a) => a.map((x) => x.id);

/** A font by its family or by the name it is shown with ("Scholar" → Libre Baskerville). */
export const fontFamily = (v) => FONTS.find((f) => f.label && f.label.toLowerCase() === String(v).toLowerCase())?.name || v;

export function need(cond, msg) { if (!cond) throw new Error(msg); }
export function oneOf(value, list, what) {
  if (value == null) return value;
  need(list.includes(value), `Unknown ${what} "${value}". Valid: ${list.join(', ')}`);
  return value;
}
export function color(v, what = 'color') {
  const c = normHex(v);
  need(c, `${what} must be a hex color like #ff0055 (got ${v})`);
  return c;
}

/** The text style of a preset (the default text with the preset's look). */
export function presetStyle(id) {
  const p = TEXT_PRESETS.find((x) => x.id === id) || TEXT_PRESETS[0];
  const base = clone(DEFAULT_TEXT);
  deepMerge(base, clone(p.style));
  base.preset = p.id;
  return base;
}

/** Apply text-style arguments (snake_case) onto a text style object. */
export function applyTextStyle(tx, a) {
  if (a.preset) {
    oneOf(a.preset, ids(TEXT_PRESETS), 'preset');
    const content = tx.content;
    const keep = { ...(tx.motion ? { motion: tx.motion } : {}), ...(tx.words ? { words: tx.words } : {}) }; // (the look changes, not the animation or word times)
    const base = presetStyle(a.preset);
    for (const k of Object.keys(tx)) delete tx[k];
    Object.assign(tx, base, { content }, keep);
  }
  if (a.font) { a.font = fontFamily(a.font); oneOf(a.font, FONTS.map((f) => f.name), 'font'); tx.font = a.font; }
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
  // (v1.12) kinetic text
  const kOpts = ['text_motion_spring', 'text_motion_stagger', 'text_motion_speed', 'text_motion_color', 'text_motion_out'].some((k) => a[k] != null);
  if (a.text_motion === 'none') delete tx.motion;
  else if (a.text_motion != null || kOpts) {
    const type = oneOf(a.text_motion ?? tx.motion?.type, ids(KINETIC), 'text_motion');
    need(type, 'text_motion is needed (no kinetic animation on this text yet)');
    const base = tx.motion?.type === type ? tx.motion : { speed: tx.motion?.speed, color: tx.motion?.color, out: tx.motion?.out };
    if (a.text_motion_spring != null) oneOf(a.text_motion_spring, Object.keys(SPRINGS), 'text_motion_spring');
    if (a.text_motion_color != null) color(a.text_motion_color, 'text_motion_color');
    tx.motion = makeMotion(type, {
      spring: a.text_motion_spring ?? base.spring, stagger: a.text_motion_stagger ?? base.stagger, speed: a.text_motion_speed ?? base.speed,
      color: a.text_motion_color != null ? normHex(a.text_motion_color) : base.color, out: a.text_motion_out ?? base.out,
    });
  }
  if (a.gradient_from === 'none' || a.gradient_to === 'none') tx.gradient.enabled = false;
  else if (a.gradient_from || a.gradient_to) {
    if (a.gradient_from) tx.gradient.from = color(a.gradient_from, 'gradient_from');
    if (a.gradient_to) tx.gradient.to = color(a.gradient_to, 'gradient_to');
    tx.gradient.enabled = true;
  }
}

/** Position, size, turn, see-through, mirror, blend and crop (a keyframed clip gets the value on every keyframe). */
export function applyVisual(c, a) {
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
export function applyAnim(c, a) {
  if (!c.animIn) return;
  if (a.animation_in) c.animIn.type = oneOf(a.animation_in, ids(ANIM_IN), 'animation_in');
  if (a.animation_out) c.animOut.type = oneOf(a.animation_out, ids(ANIM_OUT), 'animation_out');
  if (a.animation_loop) c.animLoop.type = oneOf(a.animation_loop, ids(ANIM_LOOP), 'animation_loop');
  if (a.animation_in_duration != null) c.animIn.duration = clamp(Number(a.animation_in_duration), 0.05, 10);
  if (a.animation_out_duration != null) c.animOut.duration = clamp(Number(a.animation_out_duration), 0.05, 10);
}

/**
 * The update_clip edit on clip `id` (arguments as the MCP tool takes them). A start on the main track with magnet is
 * not done here: the caller moves the clip first (actions.moveClip), as before.
 */
export function updateClip(P, id, a) {
  const c = P.clips.find((x) => x.id === id);
  need(c, `Clip not found: ${id}. Call get_project for valid clip ids.`);
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
  return c;
}
