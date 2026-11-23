// (v1.13.2, P0-5) What a Najja Desain export checks before drawing (public/js/design/exportcheck.js, assets.js).
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photosOf, fontsOf, exportScale, photoLabel, SAFE_PIXELS } from '../public/js/design/exportcheck.js';
import { Assets } from '../public/js/design/assets.js';

const text = (font, { weight = 400, italic = false, content = 'Halo' } = {}) => ({ type: 'text', text: { font, weight, italic, content } });
const pages = [
  { bg: { color: '#fff', mediaId: 'm_bg' }, els: [{ type: 'image', mediaId: 'm_a' }, text('Poppins', { weight: 650 }), { type: 'shape' }] },
  { bg: { color: '#000' }, els: [{ type: 'image', mediaId: 'm_a' }, { type: 'image', mediaId: 'm_b' }, text('Bangers', { content: 'DISKON 50%' }), text('Poppins', { weight: 650, content: 'Rp' })] },
];

test('photosOf: every photo of the pages once, background photos too, with the pages it is on', () => {
  assert.deepEqual(photosOf(pages), [
    { id: 'm_bg', pages: [1] },
    { id: 'm_a', pages: [1, 2] },
    { id: 'm_b', pages: [2] },
  ]);
  assert.deepEqual(photosOf([{ bg: { color: '#fff' }, els: [{ type: 'shape' }] }]), []);
});

test('fontsOf: one entry per font look, with the weight the font really has and the letters used', () => {
  const f = fontsOf(pages);
  assert.deepEqual(f.map((x) => x.spec), ['600 40px "Poppins"', '400 40px "Bangers"']); // 650 → nearest Poppins weight 600 (fontWeightFor)
  assert.equal(f[0].family, 'Poppins');
  for (const ch of 'HaloRp') assert.ok(f[0].text.includes(ch), `letters of both Poppins texts: ${ch}`);
  assert.equal(fontsOf([{ els: [text('Poppins', { italic: true })] }])[0].spec, 'italic 400 40px "Poppins"');
  assert.deepEqual(fontsOf([{ els: [{ type: 'text', text: { content: 'no font' } }, { type: 'image', mediaId: 'x' }] }]), []);
});

test('exportScale: the size asked for when the device draws it; above every device limit, asked to the device', () => {
  assert.equal(exportScale(1080, 1080, 1), 1);
  assert.equal(exportScale(1080, 1080, 2), 2, '2160 × 2160 is under the limit of every device');
  let asked = 0;
  assert.equal(exportScale(1080, 1080, 2, () => { asked++; return false; }), 2);
  assert.equal(asked, 0, 'the device is only asked about sizes above the safe limit');
  assert.equal(exportScale(8000, 8000, 1, () => true), 1, 'a desktop that draws 64 MP keeps the full size');
});

test('exportScale: a size the device cannot draw gets the largest one under the safe limit, never bigger than asked', () => {
  assert.equal(exportScale(8000, 2000, 1, () => false), 1, '16 MP is under the safe limit: kept');
  for (const [w, h, want] of [[8000, 8000, 1], [8000, 2200, 1], [3000, 3000, 2], [4097, 4096, 1], [7999, 5333, 1]]) {
    const s = exportScale(w, h, want, () => false);
    const area = Math.round(w * s) * Math.round(h * s);
    assert.ok(s < want, `${w}×${h}: smaller`);
    assert.ok(area <= SAFE_PIXELS, `${w}×${h}@${s}: ${area} fits`);
    const next = s + 0.001;
    assert.ok(Math.round(w * next) * Math.round(h * next) > SAFE_PIXELS || next > want, `${w}×${h}: ${s} is the largest step that fits`);
  }
  assert.equal(exportScale(8000, 8000, 1, () => false), 0.512); // 4096 × 4096
});

test('photoLabel names the photo (and its pages when there are several)', () => {
  const d = { media: [{ id: 'm_a', name: 'kaos-merah' }], pages: [{}, {}] };
  assert.equal(photoLabel(d, { id: 'm_a', pages: [1, 2] }), '"kaos-merah" (hal. 1, 2)');
  assert.equal(photoLabel({ media: [], pages: [{}] }, { id: 'x', pages: [1] }), '"foto"');
});

test('exportSources: a photo that does not load is listed with its error, never left out silently', async () => {
  const fake = {
    async original(id) {
      if (id === 'm_b') throw new Error('foto tidak bisa dimuat (HTTP 404)');
      if (id === 'm_bg') return undefined; // (decoded to nothing)
      return { w: 10, h: 10, id };
    },
  };
  const out = await Assets.prototype.exportSources.call(fake, pages);
  assert.ok(out instanceof Map, 'still a Map of sources for drawing');
  assert.deepEqual([...out.keys()], ['m_a']);
  assert.deepEqual(out.failed, [
    { id: 'm_bg', pages: [1], error: 'foto tidak ada' },
    { id: 'm_b', pages: [2], error: 'foto tidak bisa dimuat (HTTP 404)' },
  ]);
  const ok = await Assets.prototype.exportSources.call({ original: async (id) => ({ id }) }, pages);
  assert.deepEqual(ok.failed, []);
});
