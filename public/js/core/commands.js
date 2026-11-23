// (v1.13.2, P0-6b step 2) The clip edits the UI and MCP share (actions.js calls these inside store.mutate): pure
// functions of the project P, changed in place. No store, engine, selection or DOM here, so they run in Node, and
// later on the server too (P1-5). They do exactly what actions.js did before (test/core-commands.test.js replays
// the behaviour recorded from that code).
// The model helpers they use (makeClip, placeClip, splitClip…) are still in store.js; moving them here is a later step.
import { makeClip, placeClip, splitClip, sortedClips, insertIntoMain, findFreeStart, MIN_CLIP, clipEnd } from '../store.js';
import { clone, uid } from '../util.js';

const clipOf = (P, id) => P.clips.find((c) => c.id === id);
const trackOf = (P, id) => P.tracks.find((t) => t.id === id);

/** A new clip for a media item m: duration from the file (photos 3 s), never past its end at this speed. */
export function mediaClip(m, { sourceIn = 0, duration, props = {} } = {}) {
  const type = m.type;
  const speed = props.speed || 1;
  const inPt = Math.max(0, Math.min(sourceIn || 0, Math.max(0, (m.duration || 0) - MIN_CLIP)));
  let dur = duration;
  if (!dur) dur = type === 'image' ? 3 : Math.max(MIN_CLIP, ((m.duration || 3) - inPt) / speed);
  if (type !== 'image' && m.duration) dur = Math.min(dur, (m.duration - inPt) / speed);
  return makeClip(type, { mediaId: m.id, in: inPt, duration: dur, name: m.name, ...props });
}

/** Put a new clip on the timeline. track: auto | main | overlay | text | audio | new | a track id; at: the playhead. */
export function addClip(P, clip, { track = 'auto', start, at = 0 } = {}) {
  const target = clip.type === 'audio' && track === 'auto' ? 'audio' : track;
  placeClip(P, clip, target, start ?? (target === 'auto' || target === 'main' ? undefined : at));
  return clip;
}

/**
 * The clips a split at t cuts: clipId, else the selected clip when t is inside it, else every clip under t on a
 * track that is not locked; never closer than half the shortest clip to an edge.
 */
export function splitTargets(P, t, { clipId, selectedId } = {}) {
  let targets;
  if (clipId) targets = [clipOf(P, clipId)].filter(Boolean);
  else {
    const sel = selectedId ? clipOf(P, selectedId) : null;
    targets = sel && t > sel.start && t < clipEnd(sel) ? [sel] : P.clips.filter((c) => t > c.start && t < clipEnd(c) && !trackOf(P, c.trackId)?.locked);
  }
  return targets.filter((c) => t > c.start + MIN_CLIP / 2 && t < clipEnd(c) - MIN_CLIP / 2);
}

/** Split these clips at t: [[left id, right id], …]. */
export function splitClips(P, ids, t) {
  return ids.map((id) => { const c = clipOf(P, id); return [c.id, splitClip(P, c, t)?.id]; });
}

/** Remove these clips. */
export function deleteClips(P, ids) {
  P.clips = P.clips.filter((c) => !ids.includes(c.id));
}

/**
 * A copy of clip `id`: at `start` when given, else right after it (main track with magnet: inserted after it; main
 * without magnet: the clips after it move along; other tracks: on a track above when the space after it is taken).
 */
export function duplicateClip(P, id, start, newId = uid('c')) {
  const src = clipOf(P, id);
  if (!src) throw new Error(`Klip tidak ditemukan: ${id}`);
  const copy = clone(src);
  copy.id = newId;
  if (src.trackId === 'main' && P.magnet) {
    insertIntoMain(P, copy, start ?? clipEnd(src) - 0.001);
    // insert right after the source
    const list = sortedClips(P, 'main').filter((c) => c.id !== copy.id);
    const idx = start != null ? undefined : list.indexOf(src) + 1;
    if (idx !== undefined) {
      list.splice(idx, 0, copy);
      let t = 0;
      for (const c of list) { c.start = t; t += c.duration; }
    }
  } else if (start != null) {
    P.clips.push(copy);
    copy.start = findFreeStart(P, copy.trackId, start, copy.duration, copy.id);
    if (copy.start !== start) placeClip(P, copy, 'new', start);
  } else {
    // Right after the source (v1.9: it went to the next free place on the track, often the very end):
    // - on the main track without magnet, the clips after it move along by the copy's length;
    // - on other tracks, when the space right after it is taken, on a track above at that time.
    P.clips.push(copy);
    const s = clipEnd(src);
    const free = findFreeStart(P, copy.trackId, s, copy.duration, copy.id) === s;
    if (free) copy.start = s;
    else if (src.trackId === 'main') {
      for (const c of P.clips) if (c.trackId === 'main' && c.id !== copy.id && c.start >= s - 1e-4) c.start += copy.duration;
      copy.start = s;
    } else placeClip(P, copy, 'new', s);
  }
  return copy;
}

/** Move clip `id` to `start` and/or `track` (the main track takes only video, photo and colour clips). */
export function moveClip(P, id, { start, track } = {}) {
  const c = clipOf(P, id);
  if (!c) throw new Error(`Klip tidak ditemukan: ${id}`);
  const tgt = track || c.trackId;
  const s = start ?? c.start;
  const curTrack = trackOf(P, c.trackId);
  if ((tgt === 'main' || trackOf(P, tgt)?.kind === 'main')) {
    if (!['video', 'image', 'solid'].includes(c.type)) throw new Error('Track utama hanya untuk video, foto, dan latar warna.');
    insertIntoMain(P, c, s);
  } else if (tgt === c.trackId && curTrack?.kind !== 'main') {
    if (P.clips.some((o) => o.trackId === c.trackId && o.id !== c.id && o.start < s + c.duration - 1e-4 && o.start + o.duration > s + 1e-4)) placeClip(P, c, 'new', s);
    else c.start = Math.max(0, s);
  } else {
    placeClip(P, c, tgt === c.trackId ? 'auto' : tgt, s);
    if (c.trackId === 'main') insertIntoMain(P, c, s);
  }
  return c;
}
