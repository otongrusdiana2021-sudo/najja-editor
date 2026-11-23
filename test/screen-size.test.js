// (v1.13.2) Akun → Ukuran layar (public/js/core/screen.js): the device suggestion, the presets and the zoom lock,
// the same rules as the ecom app. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCALE_MAX, SCALE_MIN, SCREENS, suggestScreen, zoomLocked, normalizeScreen, clampScale } from '../public/js/core/screen.js';

test('Ukuran layar suggests the device from its screen, touch first', () => {
  const touch = (short, long) => suggestScreen({ touch: true, ios: true, short, long, width: short });
  assert.equal(touch(390, 844), 'phone', 'iPhone');
  assert.equal(touch(744, 1133), 'ipad-mini');
  assert.equal(touch(820, 1180), 'ipad', 'iPad Air 11');
  assert.equal(touch(1032, 1376), 'ipad-pro', 'iPad Pro 13');
  const desk = (width) => suggestScreen({ touch: false, ios: false, short: 900, long: width, width });
  assert.deepEqual([1366, 1470, 1536, 1728, 1920, 2560].map(desk), ['laptop14', 'laptop14', 'laptop15', 'laptop16', 'monitor24', 'monitor27']);
});

test('every preset has a scale inside the slider, and the zoom lock follows the device until the owner picks', () => {
  for (const s of SCREENS) assert.ok(s.scale >= SCALE_MIN && s.scale <= SCALE_MAX && s.scale % 5 === 0, s.id);
  assert.equal(zoomLocked({ lock: null }, { touch: true, ios: false }), true, 'layar sentuh: menyala');
  assert.equal(zoomLocked({ lock: null }, { touch: false, ios: true }), true, 'iPad meminta situs desktop');
  assert.equal(zoomLocked({ lock: null }, { touch: false, ios: false }), false, 'laptop: mati');
  assert.equal(zoomLocked({ lock: false }, { touch: true, ios: true }), false, 'pilihan pemilik menang');
});

test('a stored setting is made whole: unknown presets, broken or out-of-range scales fall back safely', () => {
  assert.deepEqual(normalizeScreen(), { id: 'auto', scale: 100, lock: null });
  assert.deepEqual(normalizeScreen({ id: 'ipad', scale: 92, lock: true }), { id: 'ipad', scale: 90, lock: true });
  assert.deepEqual(normalizeScreen({ id: 'tv-80', scale: 'besar', lock: 'ya' }), { id: 'auto', scale: 100, lock: null });
  assert.deepEqual([10, 74, 76, 131, 500].map(clampScale), [75, 75, 75, 130, 130]);
});
