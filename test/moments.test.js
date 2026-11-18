// Style Konsep moments (v1.12.6): what the talent says becomes a graphic — colour circles, a ticking timer, "bisa buat"
// chips, claims, reactions. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMoments, planMoments, colorOf } from '../public/js/moments.js';
import { buildStyle } from '../public/js/styles.js';
import { sfxCues, encodeCells } from '../public/js/stylefx.js';

/** Words said one after another (0.36 s each), from t0. */
const say = (str, t0 = 0) => { let t = t0; return str.split(' ').map((w) => { const o = { w, s: +t.toFixed(3), e: +(t + 0.3).toFixed(3) }; t += 0.36; return o; }); };
const kinds = (ms) => ms.map((m) => m.type);

test('colours: each one said, in order, as it is said; everyday words only when talking about colours', () => {
  const [m] = findMoments(say('Ada tiga warna ya, hitam, cream, sama dusty pink.'));
  assert.equal(m.type, 'color');
  assert.deepEqual(m.items.map((x) => x.label), ['Hitam', 'Cream', 'Dusty Pink']);
  assert.deepEqual(m.items.map((x) => x.hex), ['#141414', '#F3E5C8', '#D8A7B1']);
  assert.ok(m.items[0].s < m.items[1].s && m.items[1].s < m.items[2].s, 'each circle when its colour is said');
  assert.ok(m.e - m.s >= 1.8 && m.e - m.s <= 4.5);
  assert.deepEqual(findMoments(say('Cocok buat kamu yang suka cream soup.')), [], '"cream" alone is not a colour');
  assert.deepEqual(findMoments(say('Pilihan warnanya ada cream sama mocca.'))[0].items.map((x) => x.label), ['Cream', 'Mocca'], 'talking about colours: cream is one');
  assert.deepEqual(findMoments(say('Ada yang hitam sama coklat.'))[0].items.map((x) => x.label), ['Hitam', 'Coklat'], 'next to a clear colour: coklat is one');
  // the product's own name is not a colour
  assert.deepEqual(findMoments(say('Olive Bag ini enak dipakai.'), { product: { name: 'Olive Bag' } }), []);
  assert.deepEqual(findMoments(say('Warnanya ada olive sama navy.'), { product: { name: 'Olive Bag' } })[0].items.map((x) => x.label), ['Olive', 'Navy']);
  assert.equal(findMoments(say('Warna biru tua juga ada.'))[0].items[0].label, 'Navy', 'two-word colours');
  assert.deepEqual(colorOf('dusty pink'), { hex: '#D8A7B1', label: 'Dusty Pink' });
  assert.deepEqual(colorOf('#abcdef'), { hex: '#ABCDEF', label: '#ABCDEF' });
  assert.equal(colorOf('kucing'), null);
});

test('time and stock: "tinggal 2 hari", "dua hari lagi", "cuma sehari", "hari ini aja", "sampai besok", "stok tinggal 5"', () => {
  const text = (str) => findMoments(say(str)).map((m) => `${m.type}:${m.text}`);
  assert.deepEqual(text('Promonya tinggal 2 hari lagi guys!'), ['timer:TINGGAL 2 HARI']);
  assert.deepEqual(text('Diskonnya tinggal dua hari.'), ['timer:TINGGAL 2 HARI']);
  assert.deepEqual(text('Pokoknya dua belas jam lagi selesai.'), ['timer:12 JAM LAGI']);
  assert.deepEqual(text('Promonya cuma sehari.'), ['timer:CUMA 1 HARI']);
  assert.deepEqual(text('Harga segini hari ini aja ya.'), ['timer:HARI INI AJA']);
  assert.deepEqual(text('Diskonnya cuma sampai besok ya, buruan checkout.'), ['timer:SAMPAI BESOK']);
  assert.deepEqual(text('Oke sampai jumpa besok.'), [], 'no promo talk: not a timer');
  assert.deepEqual(text('Ada flash sale malam ini.'), ['timer:FLASH SALE']);
  assert.deepEqual(text('Stoknya tinggal lima pcs.'), ['stock:STOK TINGGAL 5']);
  assert.deepEqual(text('Sisa 3 pcs lagi.'), ['stock:SISA 3 PCS']);
  assert.deepEqual(text('Stoknya terbatas banget.'), ['stock:STOK TERBATAS']);
  const [m] = findMoments(say('Promonya tinggal 2 hari lagi guys!'));
  assert.ok(m.e - m.s >= 2.2, 'long enough to read');
});

test('uses: "bisa buat baju basah, minuman", "muat 5–6 outfit": a chip per thing with its emoji, a number kept', () => {
  const [u] = findMoments(say('Ini bisa buat baju basah, minuman, sama laptop kerja.'));
  assert.equal(u.header, 'BISA BUAT:');
  assert.deepEqual(u.items.map((x) => `${x.emoji} ${x.label}`), ['👕 baju basah', '🥤 minuman', '💻 laptop kerja']);
  assert.deepEqual(findMoments(say('Tas ini muat lima sampai enam outfit.'))[0].items.map((x) => x.label), ['5–6 outfit']);
  assert.deepEqual(findMoments(say('Bisa muat 5-6 outfit loh.'))[0].items.map((x) => x.label), ['5–6 outfit']);
  assert.equal(findMoments(say('Muat laptop sama charger.'))[0].header, 'MUAT:');
  assert.deepEqual(findMoments(say('Bisa buat kamu yang suka jalan.')), [], 'nothing to show: no chips');
});

test('claims (once each), a weaker moment waits its turn, reactions far apart, never two at once', () => {
  const ms = findMoments(say('Olive Bag ini best seller banget, gratis ongkir lagi.'), { product: { name: 'Olive Bag' } });
  assert.deepEqual(ms.map((m) => m.text), ['BEST SELLER', 'GRATIS ONGKIR'], 'both, one after the other');
  assert.ok(ms[1].s >= ms[0].e);
  assert.deepEqual(findMoments(say('Tasnya waterproof, nggak bocor sama sekali.')).map((m) => m.text), ['ANTI BOCOR'], 'the same claim twice in a sentence: once');
  assert.deepEqual(findMoments(say('Diskon 50 persen cuma hari ini aja!')).map((m) => `${m.type}:${m.text}`), ['claim:DISKON 50%', 'timer:HARI INI AJA']);
  const mixed = findMoments(say('Tas ini muat lima sampai enam outfit, ringan banget dan anti air.'));
  assert.deepEqual(kinds(mixed), ['uses', 'claim']);
  assert.ok(mixed[1].s >= mixed[0].e, 'the claim after the chips');
  assert.deepEqual(findMoments(say('Oops, ketumpahan deh.')).map((m) => `${m.text}/${m.sound}`), ['OOPS!/boing']);
  const many = findMoments([...say('Wow keren.'), ...say('Wow lagi.', 3), ...say('Wow terus.', 12)]);
  assert.equal(many.length, 2, 'reactions at least 8 s apart');
  const all = findMoments(say('Warnanya hitam sama putih, promonya tinggal 2 hari, stoknya tinggal 3 pcs, bisa buat baju basah, best seller.'));
  for (let i = 1; i < all.length; i++) assert.ok(all[i].s >= all[i - 1].e, `${all[i - 1].type} then ${all[i].type}: one at a time`);
  assert.ok(all.some((m) => m.type === 'timer'), 'the timer is kept');
});

test('the AI\'s moments (plan.moments): colours by name or hex, chips, a timer', () => {
  const ms = planMoments([
    { type: 'color', start: 3, colors: ['hitam', '#F3E5C8', { hex: '#D8A7B1', label: 'Dusty Pink' }] },
    { type: 'timer', start: 9, text: 'tinggal 2 hari' },
    { type: 'uses', start: 12, items: ['baju basah', { text: 'laptop', emoji: '💻' }] },
    { type: 'claim', start: 15, text: 'anti bocor', emoji: '💧' },
    { type: 'nothing', start: 1 },
  ]);
  assert.deepEqual(ms.map((m) => m.type), ['color', 'timer', 'uses', 'claim']);
  assert.deepEqual(ms[0].items.map((x) => x.hex), ['#141414', '#F3E5C8', '#D8A7B1']);
  assert.equal(ms[1].text, 'TINGGAL 2 HARI');
  assert.deepEqual(ms[2].items.map((x) => `${x.emoji} ${x.label}`), ['👕 baju basah', '💻 laptop']);
});

// ---- in the styles --------------------------------------------------------------------------
const SAID = [
  'Halo semuanya, hari ini aku mau review travel bag mini.',
  'Warnanya ada tiga, hitam, cream, sama dusty pink.',
  'Bisa buat baju basah, minuman, sama laptop.',
  'Harganya cuma 149 ribu, seharga tiket bioskop.',
  'Promonya tinggal 2 hari lagi ya, buruan checkout.',
];
function project({ variant = 'Mini, Medium, Jumbo', person = true } = {}) {
  let t = 0.9;
  const words = [];
  for (const s of SAID) { for (const w of s.split(' ')) { words.push({ w, s: +t.toFixed(3), e: +(t + 0.3).toFixed(3) }); t += 0.36; } t += 1.3; }
  const dur = +(t + 1.2).toFixed(3);
  const media = [{ id: 'talk', type: 'video', name: 'ngomong.mp4', duration: dur, width: 1080, height: 1920, hasAudio: true }];
  for (let i = 0; i < 3; i++) media.push({ id: `shot${i}`, type: 'video', name: `produk${i}`, duration: 5, width: 1080, height: 1920, hasAudio: false });
  if (person) {
    // the person on the left, the right free
    const cells = new Uint8Array(18 * 32);
    for (let j = 0; j < 32; j++) for (let i = 0; i < 18; i++) if ((i + 0.5) / 18 < 0.55 && (j + 0.5) / 32 > 0.15) cells[j * 18 + i] = 1;
    const samples = [];
    const faces = [];
    for (let x = 0; x <= dur; x += 0.5) { samples.push([x, encodeCells(cells)]); faces.push([x, [[0.15, 0.15, 0.42, 0.32]]]); }
    Object.assign(media[0], { people: { v: 1, fps: 2, cols: 18, rows: 32, samples }, faces: { v: 1, fps: 2, samples: faces } });
  }
  return { id: 'p', name: 'Tes', width: 1080, height: 1920, fps: 30, tracks: [{ id: 'main', kind: 'main' }], clips: [], media, speech: { talk: { lang: 'id', words }, shot0: { lang: 'id', words: [] }, shot1: { lang: 'id', words: [] }, shot2: { lang: 'id', words: [] } }, _variant: variant };
}
const PRODUCT = { name: 'Travel Bag', variant: 'Mini, Medium, Jumbo', price: '189rb', price_discount: '149rb' };
const SOUNDS = Object.fromEntries(['pop', 'swipe', 'whoosh', 'cash', 'typing', 'click', 'bubble', 'glitchfx', 'ding', 'tick', 'notif', 'success', 'boing'].map((id) => [id, { mediaId: `sfx_${id}`, duration: id === 'tick' ? 1.7 : 0.4 }]));
const overlaps = (P) => {
  for (const tr of P.tracks) {
    const cs = P.clips.filter((c) => c.trackId === tr.id).sort((a, b) => a.start - b.start);
    for (let i = 1; i < cs.length; i++) if (cs[i].start < cs[i - 1].start + cs[i - 1].duration - 1e-6) return tr.name;
  }
  return null;
};

test('Story Pop: a circle per colour as it is said, a shaking ⏰ with a ticking sound, "BISA BUAT:" chips; all with their sounds', () => {
  const P = project();
  const s = buildStyle(P, 'storypop', { product: PRODUCT, music: null, sfx: SOUNDS });
  assert.deepEqual(s.moments, { color: 1, uses: 1, timer: 1 });
  const circles = P.clips.filter((c) => c.sticker?.swatch);
  assert.deepEqual(circles.map((c) => c.sticker.swatch.label), ['Hitam', 'Cream', 'Dusty Pink']);
  assert.ok(circles[0].start < circles[1].start && circles[1].start < circles[2].start, 'one by one');
  assert.ok(circles.every((c) => c.animIn.type === 'pop' && c.animLoop.type === 'float'));
  const end = circles[0].start + circles[0].duration;
  assert.ok(circles.every((c) => Math.abs(c.start + c.duration - end) < 0.01), 'they leave together');
  const clock = P.clips.find((c) => c.sticker?.emoji === '⏰');
  assert.ok(clock && clock.animLoop.type === 'shake' && clock.sound === 'tick');
  assert.ok(P.clips.some((c) => c.text?.content.replace(/\s+/g, ' ') === 'TINGGAL 2 HARI' && c.text.motion?.type === 'wordSlam'), 'the words (maybe on two lines, to fit beside the person)');
  const chips = P.clips.filter((c) => c.sticker?.badge && ['baju basah', 'minuman', 'laptop'].includes(c.sticker.badge.text));
  assert.deepEqual(chips.map((c) => c.sticker.badge.icon), ['👕', '🥤', '💻']);
  assert.ok(P.clips.some((c) => c.text?.content === 'BISA BUAT:'));
  // the sounds: a bubble per circle, the clock ticks, a pop per chip
  const sfx = P.clips.filter((c) => /^SFX /.test(c.name));
  const at = (id, t) => sfx.some((c) => c.name === `SFX ${id}` && Math.abs(c.start - t) < 0.01);
  for (const c of circles) assert.ok(at('bubble', c.start), `bubble when ${c.sticker.swatch.label} pops`);
  assert.ok(at('tick', clock.start), 'tick tock');
  for (const c of chips) assert.ok(at('pop', c.start), `pop for ${c.sticker.badge.text}`);
  assert.equal(overlaps(P), null);
  for (const c of P.clips) assert.ok(c.start >= 0 && c.start + c.duration <= s.duration + 0.01);
  // off the person: everything moved to the free right side
  assert.ok(circles.every((c) => c.x > 0.05), 'the circles on the free side');
});

test('Editorial: the same moments, quietly styled (no reactions); Showcase: a circle for a colour-named variant', () => {
  const P = project();
  const s = buildStyle(P, 'editorial', { product: PRODUCT, music: null, sfx: SOUNDS });
  assert.equal(s.moments.color, 1);
  const circles = P.clips.filter((c) => c.sticker?.swatch);
  assert.ok(circles.length === 3 && circles.every((c) => c.sticker.swatch.font === 'Instrument Serif' && c.sticker.swatch.italic));
  const sub = P.tracks.find((t) => t.subtitle)?.id;
  const cEnd = circles[0].start + circles[0].duration;
  const subsDuring = P.clips.filter((c) => c.trackId === sub && Math.min(cEnd, c.start + c.duration) - Math.max(circles[0].start, c.start) > c.duration * 0.5);
  assert.equal(subsDuring.length, 0, 'one message at a time: no subtitle line under the colours');
  const R = project();
  R.speech.talk.words = say('Oops, ketumpahan. Tas ini enak banget dipakai sehari hari ya. Wow keren banget kan, cocok buat jalan jalan.', 1);
  assert.ok(!('reaction' in (buildStyle(R, 'editorial', { product: PRODUCT, music: null }).moments || {})));
  const S = project();
  const ss = buildStyle(S, 'showcase', { product: { ...PRODUCT, variant: 'Hitam, Cream, Dusty Pink' }, music: null });
  const sw = S.clips.filter((c) => c.sticker?.swatch);
  assert.equal(ss.moments.color, sw.length);
  assert.deepEqual([...new Set(sw.map((c) => c.sticker.swatch.color))], ['#141414', '#F3E5C8', '#D8A7B1']);
  assert.ok(sw.filter((c) => c.sticker.swatch.label).length === 3, 'the ending names them');
  const N = project();
  assert.equal(buildStyle(N, 'showcase', { product: PRODUCT, music: null }).moments.color, undefined, 'Mini / Medium / Jumbo: no circles');
});

test('plan.moments: the AI decides ([] none, its own list); the AI\'s keywords win over automatic moments', () => {
  const P = project();
  assert.deepEqual(buildStyle(P, 'storypop', { product: PRODUCT, music: null, plan: { moments: [] } }).moments, {});
  assert.ok(!P.clips.some((c) => c.sticker?.swatch));
  const Q = project();
  const wt = (w) => Q.speech.talk.words.find((x) => x.w === w).s;
  const s = buildStyle(Q, 'storypop', { product: PRODUCT, music: null, plan: { moments: [{ type: 'color', start: wt('Warnanya'), colors: ['sage', 'navy'] }, { type: 'reaction', start: wt('minuman,'), text: 'oops!' }] } });
  assert.deepEqual(s.moments, { color: 1, reaction: 1 });
  assert.deepEqual(Q.clips.filter((c) => c.sticker?.swatch).map((c) => c.sticker.swatch.label), ['Sage', 'Navy']);
  assert.ok(Q.clips.some((c) => c.text?.content === 'OOPS!' && c.sound === 'boing'));
  // the AI's keyword where a colour is said: the keyword stays, no circles there
  const words = project().speech.talk.words;
  const at = words.find((w) => w.w === 'hitam,').s;
  const K = project();
  buildStyle(K, 'storypop', { product: PRODUCT, music: null, plan: { keywords: [{ start: at, words: ['hitam'] }] } });
  const kwc = K.clips.find((c) => c.text?.content === 'HITAM');
  assert.ok(kwc, 'the keyword');
  assert.ok(!K.clips.some((c) => c.sticker?.swatch && c.start < kwc.start + kwc.duration && c.start + c.duration > kwc.start), 'no circles while it is on screen (they wait for it)');
  // the sound of a moment clip comes from the clip (null: silent)
  const cues = sfxCues({ tracks: [{ id: 'x' }], clips: [{ type: 'text', trackId: 'x', start: 1, duration: 1, sound: null, text: { content: 'A', motion: { type: 'wordPop' } } }, { type: 'sticker', trackId: 'x', start: 2, duration: 1, sound: 'tick', sticker: { emoji: '⏰' } }] });
  assert.deepEqual(cues.map((q) => `${q.id}@${q.t}`), ['tick@2']);
});
