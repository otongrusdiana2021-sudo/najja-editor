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
