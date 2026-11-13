// P2 micro-benchmark: JavaScript cost per preview frame of "what is on screen at t" (renderFrame's clip lookup
// + Engine.sync's element grouping), v1.6 per-frame code vs the compiled plan. Pure JS, no canvas: it isolates the
// hot path that P2 changes. usage: node bench/plan-micro.mjs
import { performance } from 'node:perf_hooks';
import { compilePlan, clipsAt, mainStateAt } from '../public/js/plan.js';
import { mainTrackState } from '../public/js/render.js';
import { sortedClips } from '../public/js/store.js';

let seed = 99;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
function project(n) {
  const tracks = [{ id: 'tx', kind: 'text' }, { id: 'ov', kind: 'overlay' }, { id: 'main', kind: 'main' }, { id: 'fx', kind: 'effect' }, { id: 'au', kind: 'audio' }];
  const clips = [];
  let t = 0;
  for (let i = 0; i < n * 0.6; i++) { const d = 0.5 + rnd() * 5; clips.push({ id: `m${i}`, trackId: 'main', type: 'video', mediaId: `v${i % 9}`, start: t, duration: d, in: rnd() * 50, speed: 1, transition: rnd() < 0.2 ? { type: 'fade', duration: 0.6 } : undefined }); t += d; }
  for (const id of ['tx', 'ov', 'fx', 'au']) for (let i = 0; i < n * 0.1; i++) clips.push({ id: `${id}${i}`, trackId: id, type: id === 'au' ? 'audio' : id === 'tx' ? 'text' : id === 'fx' ? 'effect' : 'video', mediaId: `a${i}`, start: rnd() * t, duration: 1 + rnd() * 6, in: 0, speed: 1 });
  return { tracks, clips, duration: t };
}

// v1.6: what renderFrame + Engine.sync computed on every frame/tick
function chainKeysOld(P) {
  const keys = new Map();
  const byTrack = new Map();
  for (const c of P.clips) { if (c.type !== 'video' && c.type !== 'audio') continue; if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []); byTrack.get(c.trackId).push(c); }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    let prev = null;
    for (const c of list) { const joins = !!prev && prev.mediaId === c.mediaId && Math.abs(prev.start + prev.duration - c.start) < 0.002; keys.set(c.id, joins ? keys.get(prev.id) : c.id); prev = c; }
  }
  return keys;
}
function frameOld(P, t) {
  let n = 0;
  const visual = P.tracks.filter((tr) => tr.kind !== 'audio' && tr.kind !== 'effect' && !tr.hidden).reverse();
  const mainList = sortedClips(P, 'main');
  for (const tr of visual) {
    if (tr.kind === 'main') { if (mainTrackState(mainList, t)) n++; } else for (const c of sortedClips(P, tr.id)) if (t >= c.start && t < c.start + c.duration) n++;
  }
  for (const tr of P.tracks.filter((x) => x.kind === 'effect' && !x.hidden).reverse()) for (const c of sortedClips(P, tr.id)) if (t >= c.start && t < c.start + c.duration) n++;
  // Engine.sync (every tick while playing): chain keys, main list, groups, margins via indexOf
  const keys = chainKeysOld(P);
  const main = sortedClips(P, 'main');
  const groups = new Map();
  for (const c of P.clips) { if (c.type !== 'video' && c.type !== 'audio') continue; const k = keys.get(c.id) || c.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  for (const g of groups.values()) for (const c of g) if (c.trackId === 'main') n += main.indexOf(c) & 0;
  return n;
}
function frameNew(plan, t) {
  let n = 0;
  for (const { tr, idx } of plan.visual) {
    if (tr.kind === 'main') { if (mainStateAt(plan, t)) n++; } else n += clipsAt(idx, t).length;
  }
  for (const { idx } of plan.effects) n += clipsAt(idx, t).length;
  for (const g of plan.groups.values()) for (const c of g) if (c.trackId === 'main') n += plan.mainIndex.get(c.id) & 0;
  return n;
}

const rows = [];
for (const n of [50, 200, 1000, 3000]) {
  const P = project(n);
  const frames = 600;
  const times = Array.from({ length: frames }, (_, i) => (i / frames) * P.duration);
  const bench = (fn) => { for (let i = 0; i < 60; i++) fn(times[i]); const t0 = performance.now(); for (const t of times) fn(t); return (performance.now() - t0) / frames; };
  const old = bench((t) => frameOld(P, t));
  const plan = compilePlan(P);
  const neu = bench((t) => frameNew(plan, t));
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) compilePlan(P);
  const compile = (performance.now() - t0) / 20;
  rows.push({ clips: P.clips.length, v16_ms_per_frame: +old.toFixed(4), plan_ms_per_frame: +neu.toFixed(4), speedup: +(old / neu).toFixed(1), compile_ms_once_per_edit: +compile.toFixed(3) });
}
console.table(rows);
console.log(JSON.stringify(rows));
