// Linked subtitles (public/js/store.js): a change to the look of one line of a subtitle track is made to every line.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClip, linkedLook, spreadLook, subtitlesMatch, isLinkedSubtitle, subtitleTrackOf } from '../public/js/store.js';

function project(n = 4, linked) {
  const tracks = [{ id: 'sub', kind: 'text', subtitle: true, ...(linked === undefined ? {} : { linked }) }, { id: 'tx', kind: 'text' }, { id: 'main', kind: 'main' }];
  const clips = [];
  for (let i = 0; i < n; i++) clips.push(makeClip('text', { id: `s${i}`, trackId: 'sub', start: i, duration: 0.9, y: 0.36, text: { content: `baris ${i}` } }));
  clips.push(makeClip('text', { id: 'title', trackId: 'tx', start: 0, duration: 3, text: { content: 'Judul' } }));
  return { tracks, clips, media: [] };
}

test('subtitle lines are linked by default; other text is not', () => {
  const P = project();
  assert.equal(isLinkedSubtitle(P, P.clips[0]), true);
  assert.equal(isLinkedSubtitle(P, P.clips.at(-1)), false);
  assert.equal(subtitleTrackOf(P, P.clips.at(-1)), null);
  assert.equal(isLinkedSubtitle(project(2, false), project(2, false).clips[0]), false);
});

test('a change to one line goes to the others: only what changed, never the words', () => {
  const P = project();
  const [a, b, c] = P.clips;
  c.text.color = '#ff0000'; // a line's own tweak to something else
  const before = linkedLook(b);
  b.scale = 1.8;
  b.y = 0.2;
  b.text.size = 90;
  b.text.content = 'baru';
  assert.equal(spreadLook(P, b, before), 3);
  for (const x of P.clips.slice(0, 4)) assert.deepEqual([x.scale, x.y, x.text.size], [1.8, 0.2, 90]);
  assert.equal(a.text.content, 'baris 0');
  assert.equal(c.text.color, '#ff0000', 'what did not change is not copied');
  const title = P.clips.at(-1);
  assert.equal(title.scale, 1, 'text on other tracks is left alone');
});

test('nested and replaced styles: outline on/off, a whole new style object, animations', () => {
  const P = project(3);
  const [, b, c] = P.clips;
  let before = linkedLook(b);
  b.text = { ...structuredClone(b.text), stroke: { enabled: true, color: '#000000', width: 9 }, font: 'Bangers' };
  b.animIn = { type: 'pop', duration: 0.3 };
  spreadLook(P, b, before);
  assert.deepEqual(c.text.stroke, { enabled: true, color: '#000000', width: 9 });
  assert.equal(c.text.font, 'Bangers');
  assert.deepEqual(c.animIn, { type: 'pop', duration: 0.3 });
  assert.notEqual(c.text.stroke, b.text.stroke, 'each line gets its own copy');
  before = linkedLook(b);
  delete b.text.shadow;
  spreadLook(P, b, before);
  assert.equal(c.text.shadow, undefined);
});

test('nothing changed → nothing copied; subtitlesMatch and copying a whole look', () => {
  const P = project(3);
  const [a, b] = P.clips;
  assert.equal(spreadLook(P, b, linkedLook(b)), 0);
  assert.equal(subtitlesMatch(P, b), true);
  a.scale = 2;
  assert.equal(subtitlesMatch(P, b), false);
  spreadLook(P, b); // empty "before": the whole look
  assert.equal(a.scale, 1);
  assert.equal(subtitlesMatch(P, b), true);
  assert.equal(a.text.content, 'baris 0');
});
