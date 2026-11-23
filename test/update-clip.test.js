// (v1.13.2, P0-6b step 3) What update_clip (and the add_* tools that share its helpers) do to the project, recorded
// from public/js/api.js BEFORE the edit moved to public/js/core/ (test/fixtures/update-clip-golden.json). The move
// must change nothing. Run with: npm test
// Re-record (only when a behaviour change is intended and reviewed): UPDATE_GOLDEN=1 node --test test/update-clip.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { store, newProject } from '../public/js/store.js';
import { storage } from '../public/js/storage.js';
import * as actions from '../public/js/actions.js';
import { tools } from '../public/js/api.js';

const GOLDEN = new URL('./fixtures/update-clip-golden.json', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const golden = UPDATE || !fs.existsSync(GOLDEN) ? {} : JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const recorded = {};

storage.mode = 'browser';
storage.putProject = async () => ({ ok: true });
actions.app.engine = { time: 0 };
after(() => { if (UPDATE) fs.writeFileSync(GOLDEN, `${JSON.stringify(recorded, null, 2)}\n`); });

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    : JSON.stringify(v));
const hash = (v) => crypto.createHash('sha256').update(stable(v)).digest('hex');

/** A project with one clip of each kind, made the way the editor makes them; returns their ids by role. */
function fixture({ magnet = true } = {}) {
  const P = newProject({ name: 'upd' });
  Object.assign(P, { id: 'p_upd', createdAt: 0, magnet });
  P.media = [
    { id: 'm_vid', type: 'video', name: 'video', duration: 10, width: 1920, height: 1080 },
    { id: 'm_img', type: 'image', name: 'foto', width: 800, height: 600 },
  ];
  store.setProject(P);
  const r = {
    vid: actions.addMediaClip('m_vid').id,
    img: actions.addMediaClip('m_img', { track: 'overlay', start: 1 }).id,
    txt: actions.addText({ text: 'Halo dunia', start: 0, duration: 3 }).id,
    sol: actions.addSolid({ color: '#123456', duration: 2 }).id,
    eff: actions.addEffect({ effect: 'shake', start: 0, duration: 2 }).id,
    badge: actions.addSticker({ badge: 'sale', start: 0, duration: 2 }).id,
  };
  const img = store.clip(r.img);
  img.keyframes = [{ t: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, { t: 1, x: 0.2, y: 0.1, scale: 1.2, rotation: 5, opacity: 0.8 }];
  store.past = [];
  return r;
}

/** Random ids → role names, then the whole project hashed; plus what the tool answered. */
function record(roles, result, error) {
  const names = new Map(Object.entries(roles).map(([k, v]) => [v, k]));
  let n = 0;
  for (const c of store.P.clips) if (!names.has(c.id)) names.set(c.id, `new${++n}`);
  let t = 0;
  for (const tr of store.P.tracks) if (tr.id !== 'main' && !names.has(tr.id)) names.set(tr.id, `track${++t}`);
  const swap = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (typeof x === 'string' && names.has(x) ? names.get(x) : x)));
  const P = swap({ ...store.P, updatedAt: undefined });
  return {
    error: error || null,
    result: swap(result),
    selection: swap(store.selection),
    history: store.past.length,
    clips: P.clips.map((c) => [c.id, c.trackId, Math.round(c.start * 1e4) / 1e4, Math.round(c.duration * 1e4) / 1e4]),
    sha256: hash(P),
  };
}

function scenario(name, opts, run) {
  test(`update_clip: ${name}`, async () => {
    const roles = fixture(opts);
    let result = null;
    let error = null;
    try { result = await run(roles); } catch (err) { error = err.message; }
    const got = record(roles, result?.data ?? result, error);
    recorded[name] = got;
    if (!UPDATE) {
      assert.ok(golden[name], `recorded behaviour for "${name}" (UPDATE_GOLDEN=1 once, on the code before the change)`);
      assert.deepEqual(got, golden[name]);
    }
  });
}
const up = (args) => tools.update_clip(args);

scenario('text: content, preset, font by its shown name, size, colour, bold, italic, align, spacing', {}, (r) => up({
  clip_id: r.txt, text: 'Baris satu\nbaris dua', preset: 'neon', font: 'Scholar', size: 9999, color: '#ff0055', bold: true, italic: true, align: 'left', letter_spacing: 2, line_height: 9,
}));
scenario('text: stroke, background, shadow, gradient', {}, (r) => up({
  clip_id: r.txt, stroke_color: '#000000', stroke_width: 6, background_color: '#ffffff', background_opacity: 3, shadow: true, gradient_from: '#ff0000', gradient_to: '#0000ff',
}));
scenario('text: background none, gradient none, stroke width 0', {}, async (r) => {
  await up({ clip_id: r.txt, background_color: '#ffffff', gradient_from: '#ff0000', stroke_width: 4 });
  return up({ clip_id: r.txt, background_color: 'none', gradient_to: 'none', stroke_width: 0 });
});
scenario('text: kinetic motion with options, then off', {}, async (r) => {
  await up({ clip_id: r.txt, text_motion: 'wordPop', text_motion_spring: 'bouncy', text_motion_stagger: 0.05, text_motion_speed: 1.5, text_motion_color: '#00ff00' });
  const mid = store.clip(r.txt).text.motion;
  await up({ clip_id: r.txt, text_motion_speed: 2 });
  const opts = store.clip(r.txt).text.motion;
  await up({ clip_id: r.txt, text_motion: 'none' });
  return { mid, opts, after: store.clip(r.txt).text.motion ?? null };
});
scenario('text: a new preset changes the look and keeps the kinetic motion and word times', {}, async (r) => {
  await up({ clip_id: r.txt, text_motion: 'wordPop', text_motion_speed: 1.5 });
  store.clip(r.txt).text.words = [[0, 0.5], [0.5, 1]];
  await up({ clip_id: r.txt, preset: 'yellow' });
  const tx = store.clip(r.txt).text;
  return { preset: tx.preset, motion: tx.motion ?? null, words: tx.words ?? null, content: tx.content };
});
scenario('text: kinetic options without a motion is refused', {}, (r) => up({ clip_id: r.txt, text_motion_speed: 2 }));
scenario('text: an unknown preset is refused', {}, (r) => up({ clip_id: r.txt, preset: 'nope' }));
scenario('visual: position, scale and opacity clamped, rotation, flips, blend, crop', {}, (r) => up({
  clip_id: r.vid, x: 0.25, y: -0.5, scale: 99, rotation: 45, opacity: -1, flip_h: true, flip_v: 1, blend_mode: 'screen', crop_left: 0.95, crop_top: 0.1,
}));
scenario('visual: a keyframed clip gets the value on every keyframe', {}, (r) => up({ clip_id: r.img, x: 0.4, opacity: 0.5 }));
scenario('video: source in, speed, duration, volume, mute, fades, filter, adjust, transition, animations', {}, (r) => up({
  clip_id: r.vid, source_in: 1, speed: 2, duration: 3, volume: 5, muted: true, fade_in: 0.5, fade_out: -1, filter: 'vivid', filter_intensity: 2,
  adjust: { brightness: 0.2, nope: 1 }, transition: 'fade', transition_duration: 9, animation_in: 'fade', animation_out: 'fade', animation_loop: 'pulse', animation_in_duration: 99, animation_out_duration: 0,
}));
scenario('start on the main track with magnet moves the clip there', {}, (r) => up({ clip_id: r.sol, start: 0 }));
scenario('start without magnet sets the time', { magnet: false }, (r) => up({ clip_id: r.sol, start: 20 }));
scenario('start on another track sets the time', {}, (r) => up({ clip_id: r.img, start: 4 }));
scenario('effect: type and intensity', {}, (r) => up({ clip_id: r.eff, effect: 'glitch', intensity: 5 }));
scenario('colour clip: colours, then second colour none', {}, async (r) => {
  await up({ clip_id: r.sol, color: '#abcdef', color2: '#fedcba' });
  return up({ clip_id: r.sol, color2: 'none' });
});
scenario('badge sticker: colour and text', {}, (r) => up({ clip_id: r.badge, color: '#00aa00', text: 'PROMO' }));
scenario('name', {}, (r) => up({ clip_id: r.vid, name: 'x'.repeat(80) }));
scenario('a bad value after a good one: refused, and what came before it stays (no undo step)', {}, async (r) => {
  // (behaviour kept as it was, recorded as it is: the x of 0.3 lands although the call is refused — finding V20)
  try { await up({ clip_id: r.vid, x: 0.3, filter: 'nope' }); } catch (err) { return { refused: err.message, xAfter: store.clip(r.vid).x, undoSteps: store.past.length }; }
  return { refused: null };
});
scenario('a bad colour is refused', {}, (r) => up({ clip_id: r.sol, color: 'merah' }));
scenario('an unknown clip is refused', {}, () => up({ clip_id: 'c_nope', x: 1 }));
scenario('add_text with style, position and animation (shared helpers)', {}, () => tools.add_text({ text: 'Diskon', preset: 'outline', font: 'Scholar', size: 140, color: '#ffcc00', x: 0.1, y: -0.3, animation_in: 'fade', start: 1, duration: 2 }));
scenario('add_sticker with position and loop (shared helpers)', {}, () => tools.add_sticker({ emoji: '🔥', x: -0.2, scale: 1.5, animation_loop: 'pulse', start: 0, duration: 2 }));

test('core/clipedit.js uses only the project and clip it is given (no store, page or engine)', () => {
  const src = fs.readFileSync(new URL('../public/js/core/clipedit.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\bstore\.(?!js')|\bdocument\b|\bwindow\b|\bengine\b|\btoast\(|\bactions\./);
});
