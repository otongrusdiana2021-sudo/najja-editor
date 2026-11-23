// (v1.13.2, P0-6b step 2) The clip edits shared by the UI and MCP (split, delete, duplicate, move, add): what they do
// to the project, recorded from the code as it was BEFORE they moved to public/js/core/commands.js
// (test/fixtures/core-commands-golden.json), so the move is proven to change nothing. Run with: npm test
// Re-record (only when a behaviour change is intended and reviewed): UPDATE_GOLDEN=1 node --test test/core-commands.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { store, makeClip, newProject } from '../public/js/store.js';
import { storage } from '../public/js/storage.js';
import * as actions from '../public/js/actions.js';

const GOLDEN = new URL('./fixtures/core-commands-golden.json', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const golden = UPDATE || !fs.existsSync(GOLDEN) ? {} : JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const recorded = {};

storage.mode = 'browser';
storage.putProject = async () => ({ ok: true }); // (saves go nowhere in this test)
after(() => { if (UPDATE) fs.writeFileSync(GOLDEN, `${JSON.stringify(recorded, null, 2)}\n`); });

/** The same project every time: 3 colour clips on the main track, 3 texts, 1 photo overlay. */
function fixture({ magnet = true } = {}) {
  const P = newProject({ name: 'core' });
  P.id = 'p_core';
  P.createdAt = 0; // (newProject stamps the time: fixed, so runs compare)
  P.magnet = magnet;
  P.media = [{ id: 'm_img', type: 'image', name: 'foto', width: 800, height: 600 }];
  P.tracks = [
    { id: 't_ov', kind: 'overlay', name: 'Overlay', muted: false, hidden: false, locked: false },
    { id: 't_tx', kind: 'text', name: 'Teks', muted: false, hidden: false, locked: false },
    { id: 'main', kind: 'main', name: 'Utama', muted: false, hidden: false, locked: false },
  ];
  const clip = (type, id, trackId, start, duration, props = {}) => Object.assign(makeClip(type, props), { id, trackId, start, duration });
  P.clips = [
    clip('solid', 's1', 'main', 0, 3, { color: '#111111' }),
    clip('solid', 's2', 'main', 3, 4, { color: '#222222' }),
    clip('solid', 's3', 'main', 7, 2, { color: '#333333' }),
    clip('text', 'x1', 't_tx', 0, 2, { text: { content: 'satu' } }),
    clip('text', 'x2', 't_tx', 4, 2, { text: { content: 'dua' } }),
    clip('text', 'x3', 't_tx', 6, 2, { text: { content: 'tiga' } }),
    clip('image', 'o1', 't_ov', 1, 3, { mediaId: 'm_img' }),
  ];
  return P;
}

/** JSON with sorted keys: the same project gives the same text whatever order its fields were set in. */
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    : JSON.stringify(v));

/**
 * Ids made during the edit (random) become new1, new2… and newT1… in the order they appear. Recorded: a summary to
 * read (tracks; clips as [id, track, start, duration]), and a hash of the whole project, every field of every clip.
 */
function normalize(P, extra) {
  const known = new Set(['s1', 's2', 's3', 'x1', 'x2', 'x3', 'o1', 'main', 't_ov', 't_tx']);
  const map = new Map();
  let n = 0;
  let nt = 0;
  for (const t of P.tracks) if (!known.has(t.id) && !map.has(t.id)) map.set(t.id, `newT${++nt}`);
  for (const c of P.clips) if (!known.has(c.id) && !map.has(c.id)) map.set(c.id, `new${++n}`);
  const o = JSON.parse(JSON.stringify({ P: { ...P, updatedAt: undefined }, extra }, (k, v) => (typeof v === 'string' && map.has(v) ? map.get(v) : v)));
  return {
    ...o.extra,
    magnet: o.P.magnet,
    tracks: o.P.tracks.map((t) => `${t.id}:${t.kind}`),
    clips: o.P.clips.map((c) => [c.id, c.trackId, Math.round(c.start * 1e4) / 1e4, Math.round(c.duration * 1e4) / 1e4]),
    sha256: crypto.createHash('sha256').update(stable(o.P)).digest('hex'),
  };
}

function scenario(name, { magnet = true, select = null, time = 0 } = {}, run) {
  test(`core edit: ${name}`, () => {
    store.setProject(fixture({ magnet }));
    if (select) store.select(select);
    actions.app.engine = { time };
    let result;
    try { result = run(); } catch (err) { result = { error: err.message }; }
    const got = normalize(store.P, { result: result?.id ? { id: result.id } : result, selection: store.selection });
    recorded[name] = got;
    if (!UPDATE) {
      assert.ok(golden[name], `recorded behaviour for "${name}" (run with UPDATE_GOLDEN=1 once, on the code before the change)`);
      assert.deepEqual(got, golden[name]);
    }
  });
}

scenario('split one clip at a time', {}, () => actions.splitAt(5, 's2'));
scenario('split every clip under the playhead (nothing selected)', { time: 1 }, () => actions.splitAt());
scenario('split only the selected clip', { select: 'x2' }, () => actions.splitAt(5));
scenario('split on a clip edge does nothing', {}, () => actions.splitAt(3, 's2'));
scenario('delete a main clip (magnet closes the gap)', {}, () => actions.deleteClips(['s2']));
scenario('delete the selected clip and an unknown id', { select: 'x1' }, () => actions.deleteClips(['x1', 'nope']));
scenario('duplicate a main clip (magnet: right after it)', {}, () => actions.duplicateClip('s2'));
scenario('duplicate a main clip to a time (magnet)', {}, () => actions.duplicateClip('s2', 0.5));
scenario('duplicate a main clip without magnet (the clips after it move along)', { magnet: false }, () => actions.duplicateClip('s1'));
scenario('duplicate a text with free space after it', {}, () => actions.duplicateClip('x1'));
scenario('duplicate a text with the space after it taken (a new track)', {}, () => actions.duplicateClip('x2'));
scenario('duplicate an overlay to a time', {}, () => actions.duplicateClip('o1', 10));
scenario('duplicate an unknown clip', {}, () => actions.duplicateClip('nope'));
scenario('move a main clip to the start (magnet reorders)', {}, () => actions.moveClip('s3', { start: 0 }));
scenario('move a text on its track to a free time', {}, () => actions.moveClip('x1', { start: 2 }));
scenario('move a text on its track where it overlaps another (a new track)', {}, () => actions.moveClip('x1', { start: 2.5 }));
scenario('move a text on its track onto another text (a new track)', {}, () => actions.moveClip('x1', { start: 4.5 }));
scenario('move an overlay photo to the main track', {}, () => actions.moveClip('o1', { start: 3, track: 'main' }));
scenario('move a text to the main track is refused', {}, () => actions.moveClip('x1', { track: 'main' }));
scenario('add a photo on the overlay at a time', { time: 2 }, () => actions.addMediaClip('m_img', { track: 'overlay', start: 2 }));
scenario('add a photo to the main track (appended)', {}, () => actions.addMediaClip('m_img'));

test('core commands run on a bare project: no store, no editor, no page', async () => {
  const cmd = await import('../public/js/core/commands.js');
  const before = store.P;
  const P = fixture();
  assert.deepEqual(cmd.splitClips(P, cmd.splitTargets(P, 5, { clipId: 's2' }).map((c) => c.id), 5).length, 1);
  assert.equal(P.clips.length, 8);
  const copy = cmd.duplicateClip(P, 'x1', undefined, 'c_fixed');
  assert.deepEqual([copy.id, copy.trackId, copy.start], ['c_fixed', 't_tx', 2]);
  assert.throws(() => cmd.moveClip(P, 'x1', { track: 'main' }), /Track utama hanya/);
  assert.throws(() => cmd.duplicateClip(P, 'nope'), /Klip tidak ditemukan: nope/);
  cmd.deleteClips(P, ['c_fixed']);
  assert.ok(!P.clips.some((c) => c.id === 'c_fixed'));
  const m = cmd.mediaClip({ id: 'm_v', type: 'video', name: 'v', duration: 10 }, { sourceIn: 4, props: { speed: 2 } });
  assert.deepEqual([m.in, m.duration, m.mediaId], [4, 3, 'm_v']);
  assert.equal(store.P, before, 'the store was not touched');
  const src = fs.readFileSync(new URL('../public/js/core/commands.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\bstore\.(?!js')|\bdocument\b|\bwindow\b|\bengine\b|\btoast\(/, 'core/commands.js uses only the project it is given');
});
