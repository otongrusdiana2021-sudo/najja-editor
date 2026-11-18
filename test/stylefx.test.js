// Style Konsep finishing (v1.12.4/v1.12.5): no text over a person (the whole person, the face above all), a sound for
// every text and transition; where the people are comes from the models of faces.js. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStyle } from '../public/js/styles.js';
import {
  avoidPeople, faceRectsAt, facesAt, peopleAt, occupancy, itemBox, sfxCues, addStyleSfx, encodeCells, decodeCells, STYLE_SFX,
} from '../public/js/stylefx.js';
import { decodeFaces, nms, mediaWithoutFaces, personCells, gridFor, FACES_VERSION, PEOPLE_VERSION } from '../public/js/faces.js';
import { SFX } from '../public/js/presets.js';
import { VENDOR } from '../lib/vendor.js';

const SAID = [
  'Halo semuanya, hari ini aku mau review travel bag mini.',
  'Tas ini muat lima sampai enam outfit, ringan banget dan anti air.',
  'Kamu butuh lebih dari satu size?',
  'Harganya cuma 149 ribu, seharga tiket bioskop.',
  'Buruan checkout sebelum stok habis ya.',
];
/** A person mask (cols × rows) from rectangles 0–1 of the picture. */
function mask(rects, cols = 18, rows = 32) {
  const cells = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const u = (i + 0.5) / cols;
    const v = (j + 0.5) / rows;
    if (rects.some(([a, b, c, d]) => u >= a && u <= c && v >= b && v <= d)) cells[j * cols + i] = 1;
  }
  return encodeCells(cells);
}
const track = (dur, value) => { const s = []; for (let t = 0; t <= dur + 0.01; t += 0.5) s.push([t, value]); return s; };
/** A person in a media: face box + body box (0–1), the whole time. */
function person(m, face, body, { faces = true, people = true } = {}) {
  const dur = m.duration || 1;
  if (faces) m.faces = { v: 1, fps: 2, samples: track(dur, face ? [face] : []) };
  if (people) m.people = { v: 1, fps: 2, cols: 18, rows: 32, samples: track(dur, mask(face ? [face, body] : [])) };
  return m;
}
/** The test project of styles.test.js; the talking video shows a person (face, body). */
function project(face = [0.3, 0.18, 0.7, 0.45], body = [0.15, 0.4, 0.85, 1], opts = {}) {
  let t = 0.9;
  const words = [];
  for (const s of SAID) { for (const w of s.split(' ')) { words.push({ w, s: +t.toFixed(3), e: +(t + 0.3).toFixed(3) }); t += 0.36; } t += 1.3; }
  const dur = +(t + 1.2).toFixed(3);
  const media = [{ id: 'talk', type: 'video', name: 'ngomong.mp4', duration: dur, width: 1080, height: 1920, hasAudio: true }];
  for (let i = 0; i < 3; i++) media.push({ id: `shot${i}`, type: i === 2 ? 'image' : 'video', name: `produk${i}`, duration: i === 2 ? undefined : 5, width: i ? 1080 : 1920, height: i ? 1920 : 1080, hasAudio: i === 1 });
  if (opts.data !== false) person(media[0], face, body, opts);
  return { id: 'p1', name: 'Tes', aspect: '16:9', width: 1920, height: 1080, fps: 30, background: { mode: 'color', color: '#000' }, magnet: true, tracks: [{ id: 'main', kind: 'main' }], clips: [], media, speech: { talk: { lang: 'id', words }, shot1: { lang: 'id', words: [] } } };
}
const PRODUCT = { name: 'Travel Bag', variant: 'Mini, Medium, Jumbo', size: '28 cm, 35 cm, 45 cm', price: '189rb', price_discount: '149rb' };
const SOUNDS = Object.fromEntries(STYLE_SFX.map((id) => [id, { mediaId: `sfx_${id}`, duration: SFX.find((s) => s.id === id).dur }]));
const rectOf = (P, c) => {
  const b = itemBox(c);
  const cx = P.width / 2 + c.x * P.width;
  const cy = P.height / 2 + c.y * P.height;
  return { x1: cx - b.w / 2, y1: cy - b.h / 2, x2: cx + b.w / 2, y2: cy + b.h / 2 };
};
const ov = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
const ar = (a) => (a.x2 - a.x1) * (a.y2 - a.y1);
const subTrackOf = (P) => new Set(P.tracks.filter((t) => t.subtitle).map((t) => t.id));
/** Texts/stickers that cover a face at some moment: [description]. */
function onFaces(P) {
  const bad = [];
  for (const c of P.clips.filter((x) => x.type === 'text' || x.type === 'sticker')) {
    const r = rectOf(P, c);
    for (let t = c.start; t < c.start + c.duration; t += 0.2) {
      if (faceRectsAt(P, t).some((f) => ov(r, f) > Math.min(ar(f), ar(r)) * 0.04)) { bad.push(`${c.text?.content ?? c.sticker?.emoji} @${t.toFixed(1)}`); break; }
    }
  }
  return bad;
}
/** How much of each text/sticker lies over a person (share of its box, over its time): [{ c, body, upper, face }]. */
const overPeople = (P) => P.clips.filter((x) => x.type === 'text' || x.type === 'sticker').map((c) => ({ c, ...occupancy(P, c.start, c.start + c.duration).cover(rectOf(P, c)) }));
const tracksOverlap = (P) => {
  for (const tr of P.tracks) {
    const cs = P.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < cs.length; i++) if (cs[i].start < cs[i - 1].start + cs[i - 1].duration - 1e-6) return tr.name;
  }
  return null;
};

test('the models: pinned files; decoded face boxes; a person mask kept as a few bits per frame', () => {
  for (const [name, mb] of [['ultraface', 1.3], ['selfie', 0.5]]) {
    const x = VENDOR[name].extra['model.onnx'];
    assert.match(x.url, /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//);
    assert.equal(x.sha256.length, 64);
    assert.ok(x.size < mb * 1.1e6, `${name} is small (${x.size} bytes)`);
    assert.equal(VENDOR[name].license, 'Apache-2.0');
  }
  // a 1080×1920 picture letterboxed into 320×240: 135 px wide, centred
  const lb = { dw: 135, dh: 240, ox: 92.5, oy: 0 };
  const scores = new Float32Array([0.1, 0.9, 0.2, 0.8, 0.95, 0.05, 0.1, 0.9]);
  const px = (x1, y1, x2, y2) => [x1 / 320, y1 / 240, x2 / 320, y2 / 240];
  const boxes = new Float32Array([...px(130, 40, 190, 110), ...px(132, 42, 192, 112), ...px(0, 0, 10, 10), ...px(93, 200, 95, 202)]);
  const f = decodeFaces(scores, boxes, lb);
  assert.equal(f.length, 1, 'the same face twice is one face; the low score and the tiny box are not faces');
  assert.deepEqual(f[0], [0.278, 0.167, 0.722, 0.458]);
  assert.equal(nms([[0, 0, 1, 1, 0.5], [0, 0, 1, 1, 0.9], [2, 2, 3, 3, 0.4]]).length, 2);
  // the person model's 256×256 answer → a grid along the picture (9:16: 18 × 32)
  assert.deepEqual(gridFor(1080, 1920), { cols: 18, rows: 32 });
  assert.deepEqual(gridFor(1920, 1080), { cols: 32, rows: 18 });
  const alpha = new Float32Array(256 * 256);
  for (let y = 128; y < 256; y++) for (let x = 0; x < 128; x++) alpha[y * 256 + x] = 0.95; // (lower left quarter)
  const cells = personCells(alpha, 256, 18, 32);
  assert.equal(cells.reduce((a, b) => a + b, 0), 9 * 16);
  assert.equal(cells[31 * 18], 1);
  assert.equal(cells[17], 0);
  const b64 = encodeCells(cells);
  assert.ok(b64.length <= 96, `small: ${b64.length} characters a frame`);
  assert.deepEqual(decodeCells(b64, cells.length), cells);
  const P = project();
  assert.equal(mediaWithoutFaces(P).length, 0, 'already looked at');
  P.clips.push({ type: 'video', mediaId: 'talk' });
  delete P.media[0].people;
  assert.deepEqual(mediaWithoutFaces(P).map((m) => m.id), ['talk'], 'faces but no person mask yet: looked at again');
  P.media[0].people = { v: PEOPLE_VERSION };
  P.media[0].faces = { v: FACES_VERSION - 1 };
  assert.deepEqual(mediaWithoutFaces(P).map((m) => m.id), ['talk'], 'an older look is done again; unused media are not looked at');
});

test('where the person is on the canvas follows the clip: fit, punch-in, position, mirror, covered by a full-screen shot', () => {
  const m = person({ id: 'v', width: 1080, height: 1920, duration: 2 }, [0.1, 0.1, 0.3, 0.25], [0, 0.25, 0.4, 1]);
  assert.deepEqual(facesAt(m, 0.4), [[0.1, 0.1, 0.3, 0.25]]);
  assert.equal(facesAt(m, 9), null, 'too far from any look: not known');
  assert.equal(peopleAt(m, 1).cells.length, 18 * 32);
  const P = { width: 1080, height: 1920, tracks: [{ id: 'top' }, { id: 'main' }], media: [m, { id: 'shot', width: 1080, height: 1920 }], clips: [{ id: 'c', type: 'video', mediaId: 'v', trackId: 'main', start: 0, duration: 2, in: 0, x: 0, y: 0, scale: 1 }] };
  const at = (P2, x, y) => occupancy(P2, 0.5, 0.6).cover({ x1: x * 1080 - 30, y1: y * 1920 - 30, x2: x * 1080 + 30, y2: y * 1920 + 30 });
  assert.ok(at(P, 0.15, 0.6).body > 0.9 && at(P, 0.8, 0.6).body === 0, 'the person on the left, the right free');
  assert.ok(at(P, 0.2, 0.17).face > 0.9);
  P.clips[0].flipH = true;
  assert.ok(at(P, 0.85, 0.6).body > 0.9 && at(P, 0.15, 0.6).body === 0, 'mirrored: on the right');
  P.clips[0].flipH = false;
  P.clips[0].x = 0.3;
  assert.ok(at(P, 0.45, 0.6).body > 0.9 && at(P, 0.15, 0.6).body === 0, 'moved right');
  P.clips[0].x = 0;
  P.clips.push({ id: 'b', type: 'image', mediaId: 'shot', trackId: 'top', start: 0, duration: 2, x: 0, y: 0, scale: 1, opacity: 1 });
  assert.equal(at(P, 0.15, 0.6).body, 0, 'a full-screen shot on top hides the person');
  P.clips[1].scale = 0.5;
  assert.ok(at(P, 0.15, 0.6).body > 0.9, 'a small picture-in-picture does not');
  // a talking video nobody looked at: a guess; faces without a mask: a body under each face
  P.clips.pop();
  delete m.people;
  assert.ok(at(P, 0.2, 0.8).body > 0.9 && at(P, 0.9, 0.8).body === 0, 'a body under the face');
  delete m.faces;
  assert.ok(!occupancy(P, 0, 1).any);
  assert.ok(occupancy(P, 0, 1, { talking: () => true }).any);
  assert.equal(faceRectsAt(P, 0, { talking: () => true }).length, 1);
});

test('a text over a person moves to the free background; texts shown together move together; one place for the subtitles of a shot', () => {
  // the person on the left half, the right half free (like the sample videos)
  const m = person({ id: 'v', width: 1080, height: 1920, duration: 8 }, [0.15, 0.15, 0.45, 0.32], [0, 0.3, 0.55, 1]);
  const P = { width: 1080, height: 1920, tracks: [{ id: 'tx' }, { id: 'sub', subtitle: true }, { id: 'main' }], media: [m], clips: [] };
  P.clips.push({ id: 'v1', type: 'video', mediaId: 'v', trackId: 'main', start: 0, duration: 8, in: 0, x: 0, y: 0, scale: 1 });
  const text = (id, content, x, y, start = 0.5, size = 110) => ({ id, type: 'text', trackId: 'tx', start, duration: 2, x, y, scale: 1, text: { content, size, font: 'Anton', lineHeight: 1.1 } });
  P.clips.push(text('t1', 'DISKON', -0.2, -0.1), text('t2', '50%', -0.2, -0.04));
  P.clips.push(text('far', 'AMAN', 0.3, -0.38, 3.2, 80));
  for (let i = 0; i < 3; i++) P.clips.push({ ...text(`s${i}`, 'ini baris subtitle', 0, 0.3, 3 + i * 1.5, 54), trackId: 'sub', duration: 1.5 });
  const before = P.clips.find((c) => c.id === 't2').y - P.clips.find((c) => c.id === 't1').y;
  const r = avoidPeople(P);
  assert.ok(r.moved >= 2, JSON.stringify(r));
  for (const x of overPeople(P)) assert.ok(x.body < 0.05 && x.face === 0, `"${x.c.text.content}" off the person (${x.body.toFixed(2)})`);
  const t1 = P.clips.find((c) => c.id === 't1');
  const t2 = P.clips.find((c) => c.id === 't2');
  assert.ok(t1.x > 0.05, 'to the free right side');
  assert.ok(Math.abs((t2.y - t1.y) - before * t1.scale) < 0.003 && t2.x === t1.x, 'the pair keeps its layout');
  assert.equal(P.clips.find((c) => c.id === 'far').y, -0.38, 'a text already on the background stays');
  const subs = P.clips.filter((c) => c.trackId === 'sub');
  assert.ok(subs.every((c) => c.x === subs[0].x && c.y === subs[0].y && c.scale >= 0.75), 'the subtitles of the shot: one place, still readable');
  // keyframed positions move too
  const Q = { ...P, clips: [P.clips[0], { ...text('k', 'GERAK', -0.2, 0), keyframes: [{ t: 0, x: -0.2, y: 0 }, { t: 1, x: -0.2, y: 0.02 }] }] };
  avoidPeople(Q);
  const k = Q.clips[1];
  assert.ok(k.x > 0 && Math.abs(k.keyframes[0].x - k.x) < 0.002 && Math.abs((k.keyframes[1].y - k.keyframes[0].y) - 0.02 * k.scale) < 0.002, 'keyframes moved with it');
});

for (const [name, face, body] of [
  ['a person on the left', [0.2, 0.15, 0.45, 0.32], [0.02, 0.28, 0.6, 1]],
  ['a person on the right', [0.55, 0.15, 0.8, 0.32], [0.4, 0.28, 0.98, 1]],
  ['a small person in the middle', [0.4, 0.3, 0.6, 0.42], [0.3, 0.4, 0.7, 0.9]],
]) {
  test(`every style keeps every text off the person: ${name}`, () => {
    for (const st of ['editorial', 'showcase', 'storypop']) {
      const P = project(face, body);
      const s = buildStyle(P, st, { product: PRODUCT, music: null, sfx: SOUNDS });
      assert.deepEqual(onFaces(P), [], `${st}: ${JSON.stringify(s.faces)}`);
      const subs = subTrackOf(P);
      for (const x of overPeople(P)) {
        if (subs.has(x.c.trackId)) assert.ok(x.upper < 0.05, `${st}: subtitle "${x.c.text.content}" not over head or chest`);
        else assert.ok(x.body < 0.05, `${st}: "${x.c.text?.content ?? x.c.sticker?.emoji}" off the person (${x.body.toFixed(2)}) ${JSON.stringify(s.faces)}`);
      }
      assert.equal(tracksOverlap(P), null);
      for (const c of P.clips.filter((x) => x.type === 'text' || x.type === 'sticker')) {
        const r = rectOf(P, c);
        assert.ok(r.y1 > -2 && r.y2 < P.height + 2 && r.x1 > -2 && r.x2 < P.width + 2, `${st}: "${c.text?.content ?? c.sticker?.emoji}" stays on the canvas`);
      }
    }
  });
}

test('a person filling the picture: never the face; the head and chest spared where possible; no data: a guess', () => {
  for (const st of ['editorial', 'showcase', 'storypop']) {
    const P = project([0.35, 0.12, 0.65, 0.3], [0.15, 0.26, 0.85, 1]);
    const s = buildStyle(P, st, { product: PRODUCT, music: null });
    assert.deepEqual(onFaces(P), [], st);
    assert.ok(s.faces.partly > 0, `${st}: reported as partly over the person ${JSON.stringify(s.faces)}`);
    const upper = overPeople(P).filter((x) => x.upper > 0.2);
    assert.ok(upper.length <= 1, `${st}: over the lap or legs rather than the chest (${upper.map((x) => x.c.text?.content).join(', ')})`);
  }
  const G = project(null, null, { data: false });
  const g = buildStyle(G, 'storypop', { product: PRODUCT, music: null });
  assert.ok(g.faces.checked > 0 && g.faces.moved > 0, JSON.stringify(g.faces));
  assert.equal(tracksOverlap(G), null);
});

test('a sound for every text and every move: pop, swipe, typing, ka-ching, bubble, whoosh, soft subtitle clicks', () => {
  const P = project();
  const s = buildStyle(P, 'storypop', { product: PRODUCT, music: null, sfx: SOUNDS });
  const sfx = P.clips.filter((c) => c.type === 'audio' && /^SFX /.test(c.name));
  assert.equal(s.sfx, sfx.length);
  const ids = new Set(sfx.map((c) => c.name.slice(4)));
  for (const id of ['pop', 'typing', 'cash', 'bubble', 'click']) assert.ok(ids.has(id), `${id} in Story Pop (${[...ids]})`);
  assert.equal(tracksOverlap(P), null, 'the sounds never overlap on a track');
  assert.ok(P.tracks.filter((t) => /^SFX/.test(t.name)).length <= 3);
  for (const c of sfx) assert.ok(c.start >= 0 && c.start + c.duration <= s.duration + 0.01 && c.volume > 0 && c.volume <= 0.6);
  // every text that comes in has a sound right then (or one within a tenth of a second)
  const subTrack = P.tracks.find((t) => t.subtitle)?.id;
  for (const c of P.clips.filter((x) => (x.type === 'text' || x.type === 'sticker') && x.start < s.duration - 0.1)) {
    assert.ok(sfx.some((a) => Math.abs(a.start - c.start) < 0.16), `a sound when "${c.text?.content ?? c.sticker?.emoji}" comes in${c.trackId === subTrack ? ' (subtitle)' : ''}`);
  }
  // the price counts up and lands with a ka-ching
  const price = P.clips.find((c) => c.text?.motion?.type === 'counter');
  const cash = sfx.find((c) => c.name === 'SFX cash');
  assert.ok(cash.start > price.start && cash.start < price.start + price.duration);
  // transitions
  const E = project();
  buildStyle(E, 'editorial', { product: PRODUCT, music: null, sfx: SOUNDS });
  const cut = E.clips.find((c) => c.trackId === 'main' && c.start > 0 && c.transition?.type === 'leak');
  assert.ok(E.clips.some((c) => c.name === 'SFX whoosh' && c.start <= cut.start && c.start > cut.start - 0.4), 'a whoosh into the light leak');
  const S = project();
  buildStyle(S, 'showcase', { product: PRODUCT, music: null, sfx: SOUNDS });
  const punch = S.clips.filter((c) => c.trackId === 'main' && c.start > 0 && c.transition?.type === 'punch');
  assert.ok(punch.every((p) => S.clips.some((c) => c.name === 'SFX swipe' && Math.abs(c.start - (p.start - 0.15)) < 0.01)), 'a swipe into every zoom punch');
});

test('sounds: one at a time, per-word pops on the said words, levels', () => {
  const P = { width: 1080, height: 1920, tracks: [{ id: 'main' }, { id: 'tx' }, { id: 'sub', subtitle: true }], media: [], clips: [] };
  const t = (id, start, content, extra = {}) => ({ id, type: 'text', trackId: 'tx', start, duration: 2, x: 0, y: 0, scale: 1, animIn: { type: 'none' }, text: { content, size: 80 }, ...extra });
  P.clips.push(t('a', 1, 'SATU DUA TIGA', { text: { content: 'SATU DUA TIGA', size: 80, motion: { type: 'wordPop', stagger: 0.1 }, words: [[0, 0.3], [0.5, 0.8], [1.1, 1.4]] } }));
  P.clips.push(t('b', 1, 'judul diam'));
  P.clips.push(t('c', 4, 'mengetik', { animIn: { type: 'typewriter' } }));
  P.clips.push({ ...t('s', 6, 'sub'), trackId: 'sub' });
  const q = sfxCues(P);
  assert.deepEqual(q.filter((x) => x.id === 'pop' && x.prio > 2).map((x) => x.t), [1, 1.5, 2.1], 'a pop as each word is said');
  assert.ok(!q.some((x) => x.t === 1 && x.prio === 2), 'the still title at the same moment: the word pop is heard instead');
  assert.ok(q.some((x) => x.id === 'typing' && x.t === 4));
  assert.ok(q.some((x) => x.id === 'click' && x.t === 6));
  assert.ok(!sfxCues(P, { level: 'graphics' }).some((x) => x.id === 'click'), 'graphics: no subtitle clicks');
  assert.deepEqual(sfxCues(P, { level: 'none' }), []);
  // missing sounds are skipped; nothing past the end
  const n = addStyleSfx(P, { pop: { mediaId: 'p', duration: 0.25 } }, { total: 2 });
  assert.equal(n, 2, 'the pops before the end; typing (not made) and the word at 2.1 s (past the end) left out');
  assert.ok(P.clips.filter((c) => c.type === 'audio').every((c) => c.start + c.duration <= 2 + 1e-9));
  // plan.sfx through the style
  const N = project();
  assert.equal(buildStyle(N, 'storypop', { product: PRODUCT, music: null, sfx: SOUNDS, plan: { sfx: 'none' } }).sfx, 0);
  const G = project();
  buildStyle(G, 'storypop', { product: PRODUCT, music: null, sfx: SOUNDS, plan: { sfx: 'graphics' } });
  assert.ok(!G.clips.some((c) => c.name === 'SFX click'));
  assert.ok(G.clips.some((c) => c.name === 'SFX pop'));
});
