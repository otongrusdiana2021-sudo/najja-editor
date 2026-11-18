// Compiled render plan (v1.7 P2). The preview draws 30–60 frames a second; before, every frame filtered and sorted
// the clips of every track again (and the engine rebuilt its media-element groups on every tick). The plan does that
// work once per project revision (store.rev) and answers "what is on screen at t" with a binary search.
// Pure functions of the project object: no DOM, so they run in tests and in a worker.

const EMPTY = { clips: [], maxEnd: new Float64Array(0) };

/** Clips of one track sorted by start (stable, like sortedClips), with a running max of clip ends. */
function indexTrack(list) {
  list.sort((a, b) => a.start - b.start);
  const maxEnd = new Float64Array(list.length);
  let m = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const end = list[i].start + list[i].duration;
    if (end > m) m = end;
    maxEnd[i] = m;
  }
  return { clips: list, maxEnd };
}

/** Same grouping as Engine.chainKeys: cuts of one continuous stretch of a file share one media element. */
function chainKeysOf(byTrack) {
  const keys = new Map();
  for (const { clips } of byTrack.values()) {
    let prev = null;
    for (const c of clips) {
      if (c.type !== 'video' && c.type !== 'audio') continue;
      const sp = c.speed || 1;
      const joins = !!prev && prev.mediaId === c.mediaId && prev.type === c.type
        && Math.abs((prev.speed || 1) - sp) < 1e-6
        && Math.abs(prev.start + prev.duration - c.start) < 0.002
        && Math.abs(prev.in + prev.duration * sp - c.in) < 0.05
        && !(c.transition?.type && c.transition.type !== 'none');
      keys.set(c.id, joins ? keys.get(prev.id) : c.id);
      prev = c;
    }
  }
  return keys;
}

/**
 * (v1.12.7) The preview's media elements: a few per file, taken in turn. Before, every stretch of a file (a jump cut)
 * had its own element, all kept loaded around the playhead — 30 cuts of one recording were 30 <video> elements of
 * the same file, which an iPad cannot keep decoding: it froze at every cut. Now the stretches of one file share POOL
 * elements in turn: while one plays, the next ones wait already positioned on their first frame. Stretches shown at
 * the same time (a transition, the same file on two tracks) never share one. Map clipId -> element key.
 */
export const POOL = 3;
const PREP = 0.6; // (seconds an element is free before its next stretch: time to seek there)
function elementKeysOf(P, chainKeys, mainClips) {
  // margins: the halves of the transitions around a main clip (both pictures are seen then)
  const pre = new Map();
  const post = new Map();
  const half = (c) => (c?.transition?.type && c.transition.type !== 'none' ? (c.transition.duration || 0.6) / 2 : 0);
  mainClips.forEach((c, i) => { pre.set(c.id, half(c)); post.set(c.id, half(mainClips[i + 1])); });
  const chains = new Map();
  for (const c of P.clips) {
    if (c.type !== 'video' && c.type !== 'audio') continue;
    const k = chainKeys.get(c.id) || c.id;
    const a = c.start - (pre.get(c.id) || 0);
    const b = c.start + c.duration + (post.get(c.id) || 0);
    const ch = chains.get(k);
    if (ch) { ch.start = Math.min(ch.start, a); ch.end = Math.max(ch.end, b); ch.ids.push(c.id); } else chains.set(k, { pool: `${c.mediaId}~${c.type}`, start: a, end: b, ids: [c.id] });
  }
  const byPool = new Map();
  for (const ch of chains.values()) { if (!byPool.has(ch.pool)) byPool.set(ch.pool, []); byPool.get(ch.pool).push(ch); }
  const keys = new Map();
  for (const [pool, list] of byPool) {
    list.sort((a, b) => a.start - b.start);
    const slots = [];
    for (const ch of list) {
      // an element free for a while (the longest), else a new one while the pool has room, else the first one free
      let slot = slots.filter((x) => x.until <= ch.start - PREP).sort((a, b) => a.until - b.until)[0];
      if (!slot && slots.length >= POOL) slot = slots.filter((x) => x.until <= ch.start + 1e-6).sort((a, b) => a.until - b.until)[0];
      if (!slot) { slot = { n: slots.length, until: -Infinity }; slots.push(slot); }
      slot.until = ch.end;
      for (const id of ch.ids) keys.set(id, `${pool}~${slot.n}`);
    }
  }
  return keys;
}

export function compilePlan(P) {
  const lists = new Map();
  for (const c of P.clips) {
    let l = lists.get(c.trackId);
    if (!l) lists.set(c.trackId, (l = []));
    l.push(c);
  }
  const byTrack = new Map();
  for (const [id, l] of lists) byTrack.set(id, indexTrack(l));
  const track = (id) => byTrack.get(id) || EMPTY;
  const main = track('main');
  // widest half-transition on the main track: bounds the search window of mainStateAt
  let maxHalf = 0;
  for (const c of main.clips) if (c.transition?.type && c.transition.type !== 'none') maxHalf = Math.max(maxHalf, (c.transition.duration || 0.6) / 2);
  const chainKeys = chainKeysOf(byTrack);
  const elKeys = elementKeysOf(P, chainKeys, main.clips);
  // media elements: clips (video/audio) grouped by element key, in time order (the engine finds the one on screen,
  // else the next to come)
  const groups = new Map();
  for (const c of P.clips) {
    if (c.type !== 'video' && c.type !== 'audio') continue;
    const k = elKeys.get(c.id) || c.id;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(c);
  }
  for (const g of groups.values()) g.sort((a, b) => a.start - b.start);
  return {
    project: P,
    track,
    main,
    mainIndex: new Map(main.clips.map((c, i) => [c.id, i])),
    maxHalf: maxHalf + 0.02,
    visual: P.tracks.filter((tr) => tr.kind !== 'audio' && tr.kind !== 'effect' && !tr.hidden).reverse().map((tr) => ({ tr, idx: track(tr.id) })),
    effects: P.tracks.filter((tr) => tr.kind === 'effect' && !tr.hidden).reverse().map((tr) => ({ tr, idx: track(tr.id) })),
    layers: layersOf(P, track),
    mainHidden: !!P.tracks.find((tr) => tr.kind === 'main')?.hidden,
    chainKeys,
    elKeys,
    groups,
  };
}

/**
 * (v1.10.1) Every layer bottom to top, effects among the pictures: an effect changes what is drawn under it only.
 * An effect track under the main track (never after normalize; old data) acts as it always did: over everything.
 */
function layersOf(P, track) {
  const mainAt = P.tracks.findIndex((tr) => tr.kind === 'main');
  const list = P.tracks.map((tr, i) => ({ tr, i })).filter(({ tr }) => tr.kind !== 'audio' && !tr.hidden);
  const low = list.filter(({ tr, i }) => tr.kind === 'effect' && mainAt >= 0 && i > mainAt);
  const rest = list.filter((x) => !low.includes(x));
  return [...rest.reverse(), ...low.reverse()].map(({ tr }) => ({ tr, idx: track(tr.id), effect: tr.kind === 'effect' }));
}

/** First index whose start is > t (upper bound). */
function upper(clips, t) {
  let lo = 0;
  let hi = clips.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clips[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Clips of an indexed track on screen at t (start <= t < end), in start order: O(log n + clips found). */
export function clipsAt(idx, t) {
  const { clips, maxEnd } = idx;
  const out = [];
  for (let i = upper(clips, t) - 1; i >= 0 && maxEnd[i] > t; i--) {
    const c = clips[i];
    if (t < c.start + c.duration) out.push(c);
  }
  return out.reverse();
}

/**
 * Exactly what render.js mainTrackState(list, t) returns (the clip on screen, or the two clips of a transition),
 * but it only looks at the few clips near t instead of scanning the whole main track.
 */
export function mainStateAt(plan, t) {
  const { clips, maxEnd } = plan.main;
  const h = plan.maxHalf;
  // skip clips that end (plus the widest half-transition) before t: they cannot match
  let lo = 0;
  let hi = clips.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (maxEnd[mid] + h <= t) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < clips.length; i++) {
    const c = clips[i];
    if (c.start - h > t) break; // later clips start after t (beyond any transition window)
    const next = clips[i + 1];
    const prev = clips[i - 1];
    if (next && next.transition?.type && next.transition.type !== 'none' && Math.abs(next.start - (c.start + c.duration)) < 0.01) {
      const d = Math.min(next.transition.duration || 0.6, c.duration, next.duration);
      if (t >= next.start - d / 2 && t < next.start + d / 2) return { A: c, B: next, p: (t - (next.start - d / 2)) / d, type: next.transition.type };
    }
    if (t >= c.start && t < c.start + c.duration) {
      if (prev && c.transition?.type && c.transition.type !== 'none' && Math.abs(c.start - (prev.start + prev.duration)) < 0.01) {
        const d = Math.min(c.transition.duration || 0.6, c.duration, prev.duration);
        if (t < c.start + d / 2) return { A: prev, B: c, p: (t - (c.start - d / 2)) / d, type: c.transition.type };
      }
      return { clip: c };
    }
  }
  return null;
}

// Plan cache: one plan per (project object, revision). Callers without a revision (export, thumbnails) compile once
// per project object and pass it along themselves.
let cache = { P: null, rev: -1, plan: null };
export function planFor(P, rev) {
  if (cache.P !== P || cache.rev !== rev || rev == null) cache = { P, rev, plan: compilePlan(P) };
  return cache.plan;
}
