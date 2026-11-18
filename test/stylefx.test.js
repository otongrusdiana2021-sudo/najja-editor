// Style Konsep finishing (v1.12.4): no text over a face, a sound for every text and transition; face boxes from the
// face model (faces.js). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStyle } from '../public/js/styles.js';
import { avoidFaces, faceRectsAt, facesAt, itemBox, sfxCues, addStyleSfx, TALK_FACE_GUESS, STYLE_SFX } from '../public/js/stylefx.js';
import { decodeFaces, nms, mediaWithoutFaces, FACES_VERSION } from '../public/js/faces.js';
import { SFX } from '../public/js/presets.js';
import { VENDOR } from '../lib/vendor.js';

const SAID = [
  'Halo semuanya, hari ini aku mau review travel bag mini.',
  'Tas ini muat lima sampai enam outfit, ringan banget dan anti air.',
  'Kamu butuh lebih dari satu size?',
  'Harganya cuma 149 ribu, seharga tiket bioskop.',
  'Buruan checkout sebelum stok habis ya.',
];
const faceTrack = (dur, box) => { const samples = []; for (let t = 0; t <= dur; t += 0.5) samples.push([t, box ? [box] : []]); return { v: 1, fps: 2, samples }; };
/** The test project of styles.test.js, with a face in every video and photo (box: 0–1 of the picture). */
function project(box = [0.3, 0.18, 0.7, 0.45], { faces = true } = {}) {
  let t = 0.9;
  const words = [];
  for (const s of SAID) { for (const w of s.split(' ')) { words.push({ w, s: +t.toFixed(3), e: +(t + 0.3).toFixed(3) }); t += 0.36; } t += 1.3; }
  const dur = +(t + 1.2).toFixed(3);
  const media = [{ id: 'talk', type: 'video', name: 'ngomong.mp4', duration: dur, width: 1080, height: 1920, hasAudio: true }];
  for (let i = 0; i < 3; i++) media.push({ id: `shot${i}`, type: i === 2 ? 'image' : 'video', name: `produk${i}`, duration: i === 2 ? undefined : 5, width: i ? 1080 : 1920, height: i ? 1920 : 1080, hasAudio: i === 1 });
  if (faces) for (const m of media) m.faces = faceTrack(m.duration || 1, box);
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
const tracksOverlap = (P) => {
  for (const tr of P.tracks) {
    const cs = P.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < cs.length; i++) if (cs[i].start < cs[i - 1].start + cs[i - 1].duration - 1e-6) return tr.name;
  }
  return null;
};

test('the face model: pinned file, decoded boxes in the picture, overlapping boxes merged', () => {
  const x = VENDOR.ultraface.extra['model.onnx'];
  assert.match(x.url, /^https:\/\/huggingface\.co\/onnxmodelzoo\/version-RFB-320\/resolve\/[0-9a-f]{40}\//);
  assert.equal(x.sha256.length, 64);
  assert.equal(VENDOR.ultraface.license, 'Apache-2.0');
  // a 1080×1920 picture letterboxed into 320×240: 135 px wide, centred
  const lb = { dw: 135, dh: 240, ox: 92.5, oy: 0 };
  const scores = new Float32Array([0.1, 0.9, 0.2, 0.8, 0.95, 0.05, 0.1, 0.9]);
  const px = (x1, y1, x2, y2) => [x1 / 320, y1 / 240, x2 / 320, y2 / 240];
  const boxes = new Float32Array([...px(130, 40, 190, 110), ...px(132, 42, 192, 112), ...px(0, 0, 10, 10), ...px(93, 200, 95, 202)]);
  const f = decodeFaces(scores, boxes, lb);
  assert.equal(f.length, 1, 'the same face twice is one face; the low score and the tiny box are not faces');
  assert.deepEqual(f[0], [0.278, 0.167, 0.722, 0.458]);
  assert.equal(nms([[0, 0, 1, 1, 0.5], [0, 0, 1, 1, 0.9], [2, 2, 3, 3, 0.4]]).length, 2);
  const P = project();
  assert.equal(mediaWithoutFaces(P).length, 0, 'already looked at');
  P.clips.push({ type: 'video', mediaId: 'talk' });
  P.media[0].faces = { v: FACES_VERSION - 1 };
  assert.deepEqual(mediaWithoutFaces(P).map((m) => m.id), ['talk'], 'an older look is done again; unused media are not looked at');
});

test('face boxes follow the clip: fit, punch-in, position, mirror; the nearest look in time', () => {
  const m = { id: 'v', width: 1080, height: 1920, faces: { v: 1, fps: 2, samples: [[0, [[0.1, 0.1, 0.3, 0.3]]], [0.5, [[0.6, 0.1, 0.8, 0.3]]]] } };
  assert.deepEqual(facesAt(m, 0.4), [[0.6, 0.1, 0.8, 0.3]]);
  assert.equal(facesAt(m, 9), null, 'too far from any look: not known');
  const P = { width: 1080, height: 1920, tracks: [{ id: 'main' }], media: [m], clips: [{ id: 'c', type: 'video', mediaId: 'v', trackId: 'main', start: 0, duration: 1, in: 0, x: 0, y: 0, scale: 1 }] };
  const [a] = faceRectsAt(P, 0);
  assert.ok(Math.abs(a.x1 - (108 - 216 * 0.12)) < 1e-6 && Math.abs(a.y1 - (192 - 384 * 0.18)) < 1e-6, 'with room around the face');
  P.clips[0].scale = 2;
  P.clips[0].flipH = true;
  const [b] = faceRectsAt(P, 0);
  assert.ok(b.x1 > 540, 'mirrored: the face on the left is on the right');
  P.clips[0].flipH = false;
  P.clips[0].x = 0.25;
  assert.equal(faceRectsAt(P, 0)[0].x1, 0, 'cut at the canvas edge');
  // a talking video nobody looked at: a guess
  delete m.faces;
  assert.equal(faceRectsAt(P, 0).length, 0);
  assert.equal(faceRectsAt(P, 0, { talking: () => true }).length, 1);
  assert.deepEqual(TALK_FACE_GUESS.length, 4);
});

test('a text on a face moves off it; texts shown together move together and keep their layout', () => {
  const P = { width: 1080, height: 1920, tracks: [{ id: 'main' }, { id: 'tx' }, { id: 'sub', subtitle: true }], media: [{ id: 'v', width: 1080, height: 1920, faces: faceTrack(6, [0.3, 0.2, 0.7, 0.45]) }], clips: [] };
  P.clips.push({ id: 'v1', type: 'video', mediaId: 'v', trackId: 'main', start: 0, duration: 6, in: 0, x: 0, y: 0, scale: 1 });
  const text = (id, content, y, start = 0.5, size = 120) => ({ id, type: 'text', trackId: 'tx', start, duration: 2, x: 0, y, scale: 1, text: { content, size, font: 'Anton', lineHeight: 1.1 } });
  P.clips.push(text('t1', 'DISKON', -0.22), text('t2', '50%', -0.15));
  P.clips.push({ ...text('s1', 'ini subtitle di wajah', -0.1, 3, 60), trackId: 'sub' });
  P.clips.push(text('far', 'AMAN', 0.38, 3.2));
  const before = P.clips.find((c) => c.id === 't2').y - P.clips.find((c) => c.id === 't1').y;
  const r = avoidFaces(P);
  assert.equal(r.moved, 2, JSON.stringify(r));
  assert.deepEqual(onFaces(P), []);
  const t1 = P.clips.find((c) => c.id === 't1');
  const t2 = P.clips.find((c) => c.id === 't2');
  assert.ok(Math.abs((t2.y - t1.y) - before) < 0.002, 'the pair keeps its spacing');
  assert.equal(P.clips.find((c) => c.id === 'far').y, 0.38, 'a text away from the face stays');
  assert.ok(P.clips.find((c) => c.id === 's1').y > 0, 'a subtitle goes below the face');
  // keyframed positions move too
  const Q = { ...P, clips: [P.clips[0], { ...text('k', 'GERAK', -0.2), keyframes: [{ t: 0, x: 0, y: -0.2 }, { t: 1, x: 0, y: -0.18 }] }] };
  avoidFaces(Q);
  const k = Q.clips[1];
  assert.ok(Math.abs(k.y + 0.2) > 0.05 && Math.abs(k.keyframes[0].y - k.y) < 0.002 && Math.abs((k.keyframes[1].y - k.keyframes[0].y) - 0.02) < 0.002, 'keyframes moved with it');
});

for (const [name, box] of [['a usual talking head', [0.3, 0.18, 0.7, 0.45]], ['a face low in the picture', [0.2, 0.3, 0.8, 0.6]], ['a face to one side', [0.05, 0.2, 0.4, 0.45]], ['a face at the top', [0.35, 0.05, 0.65, 0.3]]]) {
  test(`every style keeps every text off the faces: ${name}`, () => {
    for (const st of ['editorial', 'showcase', 'storypop']) {
      const P = project(box);
      const s = buildStyle(P, st, { product: PRODUCT, music: null, sfx: SOUNDS });
      assert.deepEqual(onFaces(P), [], `${st}: ${JSON.stringify(s.faces)}`);
      assert.equal(tracksOverlap(P), null);
      for (const c of P.clips.filter((x) => x.type === 'text' || x.type === 'sticker')) {
        const r = rectOf(P, c);
        assert.ok(r.y1 > -2 && r.y2 < P.height + 2, `${st}: "${c.text?.content ?? c.sticker?.emoji}" stays on the canvas`);
      }
    }
  });
}

test('without face data a talking video is given a head-and-shoulders guess; a face filling the picture is covered the least', () => {
  const P = project(null, { faces: false });
  const s = buildStyle(P, 'storypop', { product: PRODUCT, music: null });
  assert.ok(s.faces.checked > 0 && s.faces.moved > 0, JSON.stringify(s.faces));
  const big = project([0.1, 0.1, 0.9, 0.7]);
  const b = buildStyle(big, 'editorial', { product: PRODUCT, music: null });
  assert.ok(b.faces.moved > 0 && b.faces.partly > 0, JSON.stringify(b.faces));
  assert.equal(tracksOverlap(big), null);
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
