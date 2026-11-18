// Compiled render plan (public/js/plan.js) must give exactly the answers of the per-frame code it replaces.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan, clipsAt, mainStateAt, planFor } from '../public/js/plan.js';
import { mainTrackState } from '../public/js/render.js';
import { sortedClips } from '../public/js/store.js';

// deterministic random
let seed = 12345;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const TR = ['none', 'none', 'fade', 'slideLeft', 'black'];

function randomProject(n) {
  const tracks = [
    { id: 'tx', kind: 'text' }, { id: 'ov2', kind: 'overlay' }, { id: 'ov1', kind: 'overlay', hidden: rnd() < 0.2 },
    { id: 'main', kind: 'main' }, { id: 'fx', kind: 'effect' }, { id: 'au', kind: 'audio' },
  ];
  const clips = [];
  // main: back to back (magnetic), sometimes gaps; split cuts of one file; transitions
  let t = 0;
  let src = 0;
  for (let i = 0; i < n; i++) {
    const d = 0.3 + rnd() * 6;
    const cut = rnd() < 0.4 && i > 0;
    if (!cut) src = rnd() * 100;
    clips.push({ id: `m${i}`, trackId: 'main', type: rnd() < 0.85 ? 'video' : 'image', mediaId: cut ? clips.at(-1).mediaId : `med${i % 7}`, start: t, duration: d, in: src, speed: 1,
      transition: i && !cut ? { type: pick(TR), duration: 0.2 + rnd() * 1.6 } : undefined });
    src += d;
    t += d + (rnd() < 0.1 ? rnd() * 2 : 0);
  }
  for (const id of ['tx', 'ov1', 'ov2', 'fx', 'au']) {
    for (let i = 0; i < n / 2; i++) {
      const s = Math.round(rnd() * t * 10) / 10; // equal starts happen
      clips.push({ id: `${id}${i}`, trackId: id, type: id === 'au' ? 'audio' : id === 'tx' ? 'text' : id === 'fx' ? 'effect' : 'video', mediaId: `x${i % 3}`, start: s, duration: 0.1 + rnd() * 8, in: 0, speed: 1 });
    }
  }
  // project order is not start order
  for (let i = clips.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [clips[i], clips[j]] = [clips[j], clips[i]]; }
  return { tracks, clips, duration: t };
}
const sameState = (a, b) => {
  if (!a || !b) return a === b;
  if (a.clip || b.clip) return a.clip === b.clip;
  return a.A === b.A && a.B === b.B && a.type === b.type && Math.abs(a.p - b.p) < 1e-12;
};

test('clipsAt = filter + sort of every track, at every time (ties keep project order)', () => {
  for (let k = 0; k < 20; k++) {
    const P = randomProject(5 + k * 6);
    const plan = compilePlan(P);
    for (let i = 0; i < 400; i++) {
      const t = rnd() * (P.duration + 2) - 1;
      for (const tr of P.tracks) {
        const want = sortedClips(P, tr.id).filter((c) => t >= c.start && t < c.start + c.duration);
        assert.deepEqual(clipsAt(plan.track(tr.id), t).map((c) => c.id), want.map((c) => c.id), `track ${tr.id} t=${t}`);
      }
    }
    // exact boundaries (a clip ends where the next starts)
    for (const c of P.clips) {
      for (const t of [c.start, c.start + c.duration, c.start - 1e-9, c.start + c.duration - 1e-9]) {
        const want = sortedClips(P, c.trackId).filter((x) => t >= x.start && t < x.start + x.duration);
        assert.deepEqual(clipsAt(plan.track(c.trackId), t).map((x) => x.id), want.map((x) => x.id));
      }
    }
  }
});

test('mainStateAt = mainTrackState (clip or transition pair, same progress)', () => {
  for (let k = 0; k < 20; k++) {
    const P = randomProject(5 + k * 8);
    const plan = compilePlan(P);
    const list = sortedClips(P, 'main');
    const times = [];
    for (let i = 0; i < 600; i++) times.push(rnd() * (P.duration + 2) - 1);
    for (const c of list) times.push(c.start, c.start + c.duration, c.start - 0.3, c.start + 0.3, c.start - 1e-9);
    for (const t of times) assert.ok(sameState(mainStateAt(plan, t), mainTrackState(list, t)), `t=${t}`);
  }
});

test('visual/effect track order, hidden tracks, chain keys and element groups', () => {
  const P = randomProject(30);
  P.tracks.find((t) => t.id === 'ov1').hidden = true;
  const plan = compilePlan(P);
  const want = P.tracks.filter((tr) => tr.kind !== 'audio' && tr.kind !== 'effect' && !tr.hidden).reverse().map((t) => t.id);
  assert.deepEqual(plan.visual.map((v) => v.tr.id), want);
  assert.deepEqual(plan.effects.map((v) => v.tr.id), ['fx']);
  // split cuts of one file share the first cut's key; a transition starts a new element
  const main = sortedClips(P, 'main');
  for (let i = 1; i < main.length; i++) {
    const [a, b] = [main[i - 1], main[i]];
    const joins = a.mediaId === b.mediaId && a.type === b.type && Math.abs(a.start + a.duration - b.start) < 0.002 && Math.abs(a.in + a.duration - b.in) < 0.05 && !(b.transition?.type && b.transition.type !== 'none');
    if (b.type === 'video' && a.type === 'video') assert.equal(plan.chainKeys.get(b.id) === plan.chainKeys.get(a.id), joins, `${a.id}→${b.id}`);
  }
  let n = 0;
  for (const g of plan.groups.values()) n += g.length;
  assert.equal(n, P.clips.filter((c) => c.type === 'video' || c.type === 'audio').length);
});

test('planFor caches per project object and revision', () => {
  const P = randomProject(10);
  const a = planFor(P, 1);
  assert.equal(planFor(P, 1), a);
  assert.notEqual(planFor(P, 2), a);
  assert.notEqual(planFor({ ...P }, 2), a);
});

// v1.10.1: effects take part in the layer order ("Lapisan"): an effect changes the layers under it only.
test('layers: effects among the pictures, bottom to top; an old project keeps its effects on top', async () => {
  const { findOrCreateTrack } = await import('../public/js/store.js');
  const old = randomProject(12); // (the effect track is under the main track here: still applied over everything)
  const plan = compilePlan(old);
  const want = [...old.tracks.filter((tr) => tr.kind !== 'audio' && tr.kind !== 'effect' && !tr.hidden).reverse().map((t) => t.id), 'fx'];
  assert.deepEqual(plan.layers.map((l) => l.tr.id), want);
  assert.deepEqual(plan.layers.filter((l) => l.effect).map((l) => l.tr.id), ['fx']);
  assert.equal(plan.layers.at(-1).tr.id, 'fx', 'an old project: the effect is still the last layer (over everything)');
  // a saved project before v1.10.1: effects first in P.tracks (normalize put them there) → still the last layer
  const saved = { ...old, tracks: [{ id: 'fx', kind: 'effect' }, { id: 'tx', kind: 'text' }, { id: 'ov2', kind: 'overlay' }, { id: 'main', kind: 'main' }, { id: 'au', kind: 'audio' }] };
  assert.deepEqual(compilePlan(saved).layers.map((l) => l.tr.id), ['main', 'ov2', 'tx', 'fx']);
  // an effect moved under the text: the text is drawn after it
  const P = { ...old, tracks: [{ id: 'tx', kind: 'text' }, { id: 'fx', kind: 'effect' }, { id: 'ov2', kind: 'overlay' }, { id: 'main', kind: 'main' }, { id: 'au', kind: 'audio' }] };
  const L = compilePlan(P).layers.map((l) => l.tr.id);
  assert.deepEqual(L, ['main', 'ov2', 'fx', 'tx']);
  // a new effect is not put on that lowered effect track: it goes over everything
  const Q = { tracks: [{ id: 'tx', kind: 'text', name: 'Teks' }, { id: 'fxLow', kind: 'effect' }, { id: 'main', kind: 'main' }], clips: [] };
  const tr = findOrCreateTrack(Q, 'effect', 0, 3);
  assert.notEqual(tr.id, 'fxLow');
  assert.equal(Q.tracks.indexOf(tr), 0, 'on top');
  const R = { tracks: [{ id: 'fxTop', kind: 'effect' }, { id: 'tx', kind: 'text' }, { id: 'main', kind: 'main' }], clips: [] };
  assert.equal(findOrCreateTrack(R, 'effect', 0, 3).id, 'fxTop', 'the effect track on top is used as before');
});

test('(v1.12.7) preview elements: the stretches of one file share a few elements in turn; never two at once', async () => {
  const { compilePlan, POOL } = await import('../public/js/plan.js');
  const v = (id, start, dur, inPt, extra = {}) => ({ id, type: 'video', mediaId: 'm', trackId: 'main', start, duration: dur, in: inPt, speed: 1, ...extra });
  // 30 jump cuts of one recording: POOL elements, in turn
  const cuts = Array.from({ length: 30 }, (_, i) => v(`c${i}`, i * 0.45, 0.45, i * 1.1));
  const p1 = compilePlan({ clips: cuts, tracks: [{ id: 'main', kind: 'main' }] });
  const keys = cuts.map((c) => p1.elKeys.get(c.id));
  assert.equal(new Set(keys).size, POOL, `${POOL} elements for 30 cuts`);
  for (let i = 1; i < keys.length; i++) assert.notEqual(keys[i], keys[i - 1], 'the next cut is on another element (already waiting there)');
  assert.equal(p1.groups.size, POOL);
  for (const g of p1.groups.values()) for (let i = 1; i < g.length; i++) assert.ok(g[i].start >= g[i - 1].start + g[i - 1].duration, 'one stretch at a time per element, in time order');
  // a split clip (one continuous stretch) stays on one element; a transition keeps both pictures on two
  const split = [v('a', 0, 2, 5), v('b', 2, 2, 7), v('c', 4, 2, 20, { transition: { type: 'blur', duration: 0.6 } })];
  const p2 = compilePlan({ clips: split, tracks: [{ id: 'main', kind: 'main' }] });
  assert.equal(p2.elKeys.get('a'), p2.elKeys.get('b'));
  assert.notEqual(p2.elKeys.get('b'), p2.elKeys.get('c'));
  // the same file on two tracks at once: two elements; another file: its own
  const two = [v('m1', 0, 4, 0), { ...v('o1', 1, 2, 10), trackId: 'ov' }, { ...v('x', 4, 2, 0), mediaId: 'other' }];
  const p3 = compilePlan({ clips: two, tracks: [{ id: 'ov', kind: 'overlay' }, { id: 'main', kind: 'main' }] });
  assert.notEqual(p3.elKeys.get('m1'), p3.elKeys.get('o1'));
  assert.ok(p3.elKeys.get('x').startsWith('other~'));
  // the export still groups by continuous stretch (fastexport decodes one stretch per source)
  assert.equal(p1.chainKeys.get('c1'), 'c1');
});
