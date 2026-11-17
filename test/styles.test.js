// Style Konsep (public/js/styles.js): the automatic plan and the three builds, on a project made here.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STYLES, buildStyle, checkMaterial, autoPlan, speechTimeline, formatPrice, cutMap, silenceCuts, placeWords, variantsOf, cleanWord,
} from '../public/js/styles.js';

const SAID = [
  'Halo semuanya, hari ini aku mau review travel bag mini.',
  'Tas ini muat lima sampai enam outfit, ringan banget dan anti air.',
  'Kamu butuh lebih dari satu size?',
  'Harganya cuma 149 ribu, seharga tiket bioskop.',
  'Buruan checkout sebelum stok habis ya.',
];
function project({ talk = true, shots = 3 } = {}) {
  let t = 0.9;
  const words = [];
  for (const s of SAID) { for (const w of s.split(' ')) { words.push({ w, s: +t.toFixed(3), e: +(t + 0.3).toFixed(3) }); t += 0.36; } t += 1.3; }
  const media = [];
  if (talk) media.push({ id: 'talk', type: 'video', name: 'ngomong.mp4', duration: +(t + 1.2).toFixed(3), width: 1080, height: 1920, hasAudio: true });
  for (let i = 0; i < shots; i++) media.push({ id: `shot${i}`, type: i === 2 ? 'image' : 'video', name: `produk${i}`, duration: i === 2 ? undefined : 5, width: i ? 1080 : 1920, height: i ? 1920 : 1080, hasAudio: i === 1 });
  const speech = {};
  if (talk) speech.talk = { lang: 'id', words };
  if (shots > 1) speech.shot1 = { lang: 'id', words: [] };
  return { id: 'p1', name: 'Tes', aspect: '16:9', width: 1920, height: 1080, fps: 30, background: { mode: 'color', color: '#000' }, magnet: true, tracks: [{ id: 'main', kind: 'main' }], clips: [], media, speech };
}
const PRODUCT = { name: 'Travel Bag', variant: 'Mini, Medium, Jumbo', size: '28 cm, 35 cm, 45 cm', price: '189rb', price_discount: '149rb' };
const MUSIC = { mediaId: 'music', duration: 16 };
const texts = (P) => P.clips.filter((c) => c.type === 'text');
const overlapsInTrack = (P) => {
  for (const tr of P.tracks) {
    const cs = P.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < cs.length; i++) if (cs[i].start < cs[i - 1].start + cs[i - 1].duration - 1e-6) return `${tr.name}: ${cs[i - 1].name} / ${cs[i].name}`;
  }
  return null;
};
function checkCommon(P, sum) {
  const main = P.clips.filter((c) => c.trackId === 'main').sort((a, b) => a.start - b.start);
  assert.ok(main.length > 0);
  let t = 0;
  for (const c of main) { assert.ok(Math.abs(c.start - t) < 1e-6, 'the main track is back to back'); t += c.duration; }
  assert.ok(Math.abs(t - sum.duration) < 0.01, 'the summary duration is the main track');
  for (const c of P.clips) assert.ok(c.start >= 0 && c.start + c.duration <= sum.duration + 0.01, `${c.type} "${c.name}" stays inside the video`);
  assert.equal(overlapsInTrack(P), null);
  assert.deepEqual([P.width, P.height, P.aspect], [1080, 1920, '9:16']);
}

test('prices, words and the cut map', () => {
  assert.equal(formatPrice('149rb'), 'Rp149.000');
  assert.equal(formatPrice(149000), 'Rp149.000');
  assert.equal(formatPrice('Rp 1.250.000'), 'Rp1.250.000');
  assert.equal(formatPrice('2 jt'), 'Rp2.000.000');
  assert.equal(formatPrice('gratis ongkir'), 'gratis ongkir');
  assert.equal(cleanWord('mini.'), 'mini');
  assert.equal(cleanWord('"size?"'), 'size');
  const cm = cutMap(10, [{ start: 2, end: 3 }, { start: 2.5, end: 4 }, { start: 6, end: 6.1 }, { start: 9.9, end: 10 }]);
  assert.deepEqual(cm.keeps.map((k) => [k.start, k.end]), [[0, 2], [4, 6], [6.1, 9.9]]);
  assert.equal(cm.map(1), 1);
  assert.equal(cm.map(3), 2, 'a time in a cut goes to where the cut was');
  assert.equal(cm.map(5), 3);
  assert.ok(Math.abs(cm.duration - 7.8) < 1e-9);
});

test('silence cuts keep a breath around the words and drop fillers', () => {
  const w = [{ w: 'halo', s: 1, e: 1.4, media: 'a' }, { w: 'eee', s: 1.6, e: 2.2, media: 'a' }, { w: 'semua', s: 3, e: 3.4, media: 'a' }];
  const cuts = silenceCuts(w, 6);
  assert.deepEqual(cuts.map((c) => [+c.start.toFixed(2), +c.end.toFixed(2)]), [[0, 0.86], [1.54, 2.86], [3.7, 6]]);
});

test('material check: what fits, and the recommendation', () => {
  const c = checkMaterial(project());
  assert.equal(c.styles.editorial.ok, 'yes');
  assert.equal(c.styles.storypop.ok, 'yes');
  assert.equal(c.recommended, 'storypop');
  const pending = project({ talk: false });
  pending.media[0].hasAudio = true; // a video with sound, not transcribed yet
  const noTalk = checkMaterial(pending);
  assert.equal(noTalk.styles.editorial.ok, 'warn', 'a video not transcribed yet: maybe');
  assert.equal(noTalk.recommended, null);
  const P = pending;
  P.speech.shot0 = { words: [] };
  const c2 = checkMaterial(P);
  assert.equal(c2.styles.editorial.ok, 'no');
  assert.equal(c2.styles.showcase.ok, 'yes');
  assert.equal(c2.recommended, 'showcase');
  assert.equal(checkMaterial(project({ shots: 0 })).recommended, 'editorial');
});

test('automatic plan: keywords from strong words, the price where it is said, a question hook', () => {
  const P = project();
  const sp = speechTimeline(P);
  const plan = autoPlan('editorial', { words: sp.words, duration: sp.duration, product: PRODUCT });
  assert.ok(plan.keywords.length >= 2);
  for (const k of plan.keywords) {
    assert.ok(k.words.length >= 1 && k.words.length <= 3);
    assert.ok(k.words.every((w) => !/\d|ribu/i.test(w)), 'the price is not a keyword');
  }
  const said149 = sp.words.find((w) => w.w === '149');
  assert.equal(plan.price.start, said149.s);
  const sp2 = autoPlan('storypop', { words: sp.words, duration: sp.duration, product: PRODUCT });
  assert.deepEqual(sp2.hook.words, ['Kamu', 'butuh', 'lebih', 'dari', 'satu', 'size']);
  assert.equal(sp2.hook.question, true);
  const pw = placeWords(sp.words, { start: said149.s, words: ['SEHARGA', 'TIKET', 'BIOSKOP'] });
  assert.deepEqual(pw.map((x) => x.text), ['SEHARGA', 'TIKET', 'BIOSKOP']);
  assert.ok(pw[1].s > pw[0].s && pw[2].s > pw[1].s);
});

test('Editorial Review: cuts, stacked keywords, price label, subtitles, outro, music', () => {
  const P = project();
  const sum = buildStyle(P, 'editorial', { product: PRODUCT, music: MUSIC });
  checkCommon(P, sum);
  assert.ok(sum.cut_seconds > 3, `pauses cut (${sum.cut_seconds} s)`);
  assert.ok(sum.keywords >= 1 && sum.price && sum.subtitles >= 2 && sum.music);
  const T = texts(P);
  assert.ok(T.some((c) => c.text.font === 'Anton' && c.text.color === '#F8F8A8'), 'cream Anton keywords');
  assert.ok(T.some((c) => c.text.strike && c.text.content === 'Rp189.000'), 'old price struck through');
  assert.ok(T.some((c) => c.text.content === 'Rp149.000'));
  assert.ok(T.some((c) => c.text.font === 'Instrument Serif' && c.text.content === 'TRAVEL BAG'), 'title');
  const subTrack = P.tracks.find((t) => t.subtitle);
  const subs = P.clips.filter((c) => c.trackId === subTrack.id);
  assert.ok(subs.every((c) => c.text.content === c.text.content.toLowerCase() && c.text.italic), 'small lower-case italic subtitles');
  // one message at a time: no subtitle under a keyword or the price
  const big = T.filter((c) => c.trackId !== subTrack.id && c.text.font === 'Anton');
  for (const s of subs) for (const b of big) assert.ok(!(s.start < b.start + b.duration - 0.3 && s.start + s.duration > b.start + 0.3) || false, `subtitle "${s.text.content}" clear of "${b.text.content}"`);
  const main = P.clips.filter((c) => c.trackId === 'main');
  assert.ok(main.some((c) => c.transition?.type === 'leak'), 'a light leak');
  assert.ok(main.some((c) => c.scale > 1.2), 'punch-ins');
  assert.ok(main.every((c) => c.filter.name === 'warmMatte'));
  assert.ok(P.clips.some((c) => c.trackId !== 'main' && c.type === 'video' && c.muted), 'product shots as muted cutaways');
  const music = P.clips.filter((c) => c.type === 'audio');
  assert.ok(music.length && music.every((c) => c.volume < 0.3), 'music under the voice');
  assert.equal(P.style.id, 'editorial');
});

test('Editorial Review follows the AI plan', () => {
  const P = project();
  const sp = speechTimeline(P);
  const at = sp.words.find((w) => w.w === 'muat').s;
  const sum = buildStyle(P, 'editorial', { product: { ...PRODUCT, brand: '' }, music: null, plan: {
    keywords: [{ start: at, words: ['MUAT', 'LIMA', 'OUTFIT'] }], price: { start: sp.words.find((w) => w.w === 'Harganya').s, normal: '200000', discount: '150000' },
    broll: [{ start: at + 2, duration: 1.5, media_id: 'shot2' }], cuts: [{ start: 0, end: 4 }], outro: false, title: { text: 'Tas Travel', subtitle: '' },
  } });
  checkCommon(P, sum);
  const words = texts(P).filter((c) => c.text.font === 'Anton' && c.text.color === '#F8F8A8').map((c) => c.text.content);
  assert.deepEqual(words, ['MUAT', 'LIMA', 'OUTFIT']);
  assert.ok(texts(P).some((c) => c.text.content === 'Rp150.000'));
  assert.ok(texts(P).some((c) => c.text.content === 'Rp200.000' && c.text.strike));
  const broll = P.clips.filter((c) => c.mediaId === 'shot2' && c.trackId !== 'main');
  assert.equal(broll.length, 1);
  assert.equal(sum.outro, false);
  assert.equal(sum.music, false);
  assert.ok(!texts(P).some((c) => c.text.content === 'bye'));
});

test('Showcase Clean: one part per variant, zoom punches, size lines, the ending with the price', () => {
  const P = project();
  const sum = buildStyle(P, 'showcase', { product: { ...PRODUCT, note: 'Fits 5-6 Outfits' }, music: MUSIC });
  checkCommon(P, sum);
  assert.deepEqual(sum.variants, ['Mini', 'Medium', 'Jumbo']);
  assert.equal(sum.sections, 4);
  const main = P.clips.filter((c) => c.trackId === 'main');
  assert.equal(main.filter((c) => c.transition?.type === 'punch').length, 3);
  assert.ok(main.every((c) => c.type !== 'video' || (c.muted && c.volume === 0)), 'music only');
  const T = texts(P).map((c) => c.text.content);
  assert.ok(T.includes('Mini Fits 5-6 Outfits') && T.includes('←   35 cm   →') && T.includes('Mini · Medium · Jumbo'));
  assert.ok(T.includes('Rp149.000'));
  assert.ok(P.clips.filter((c) => c.type === 'audio').every((c) => c.volume > 0.5));
  assert.deepEqual(variantsOf({}, { variants: ['A', { name: 'B', size: '1 m' }] }), [{ name: 'A' }, { name: 'B', note: '', size: '1 m' }]);
});

test('Story Pop: the hook word by word, keywords that pop, "turun HARGA!!", B-roll, the brand sting', () => {
  const P = project();
  const sum = buildStyle(P, 'storypop', { product: PRODUCT, music: MUSIC });
  checkCommon(P, sum);
  assert.ok(sum.hook >= 4 && sum.price && sum.broll >= 1);
  const T = texts(P);
  const hook = T.filter((c) => c.animIn.type === 'converge');
  assert.equal(hook.length, 1, 'the last hook word comes together');
  assert.equal(hook[0].text.content, 'size');
  assert.ok(P.clips.some((c) => c.type === 'sticker' && c.sticker.emoji === '🤔'), 'a question: 🤔');
  assert.ok(T.some((c) => c.text.content === 'HARGA!!' && c.animIn.type === 'typewriter'));
  assert.ok(P.clips.filter((c) => c.trackId === 'main').every((c) => c.filter.name === 'cleanNatural'));
  // (v1.12) kinetic text: captions light up word by word on the said words, keywords pop word by word, the price counts
  const subTrack = P.tracks.find((t) => t.subtitle);
  const subs = T.filter((c) => c.trackId === subTrack?.id);
  assert.ok(subs.length && subs.every((c) => c.text.motion?.type === 'karaoke' && c.text.motion.color === '#FFE600'), 'karaoke captions');
  const timed = subs.filter((c) => Array.isArray(c.text.words));
  assert.ok(timed.length >= subs.length * 0.8, `most captions carry their words' times (${timed.length}/${subs.length})`);
  for (const c of timed) {
    assert.equal(c.text.words.length, c.text.content.split(/\s+/).filter(Boolean).length);
    assert.ok(c.text.words.every(([a, b]) => a >= -0.05 && a <= c.duration + 0.05 && b >= a), 'word times inside the caption');
  }
  assert.ok(T.some((c) => c.text.motion?.type === 'wordPop'), 'keywords pop word by word');
  assert.ok(T.some((c) => c.text.motion?.type === 'counter' && /^Rp/.test(c.text.content)), 'the price counts up');
});

test('Story Pop without B-roll uses punch-ins instead; Editorial without speech says what is missing', () => {
  const P = project({ shots: 0 });
  const sum = buildStyle(P, 'storypop', { product: PRODUCT, music: null });
  checkCommon(P, sum);
  assert.equal(sum.broll, 0);
  assert.ok(P.clips.some((c) => c.trackId === 'main' && c.scale >= 1.39), 'closer picture where B-roll would be');
  const Q = project({ talk: false });
  assert.throws(() => buildStyle(Q, 'editorial', { product: PRODUCT }), /butuh video kamu ngomong/);
  assert.equal(STYLES.length, 3);
});
