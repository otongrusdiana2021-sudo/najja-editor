// Teks kinetik (v1.12): springs, piece layout, timing and counting numbers (public/js/kinetic.js). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spring, settleTime, SPRINGS, KINETIC, makeMotion, pieces, startTimes, countText, entrancePose, kineticById, wordCount } from '../public/js/kinetic.js';

test('springs start at 0, end at 1, the bouncy one overshoots, each settles in its time', () => {
  for (const [name, s] of Object.entries(SPRINGS)) {
    assert.equal(spring(0, s), 0, name);
    assert.equal(spring(-1, s), 0, name);
    const T = settleTime(s);
    assert.ok(T > 0.1 && T < 3, `${name}: settles in ${T}`);
    for (let t = T; t < T + 1; t += 0.05) assert.ok(Math.abs(spring(t, s) - 1) < 0.012, `${name} at ${t.toFixed(2)}: ${spring(t, s)}`);
  }
  let peak = 0;
  for (let t = 0; t < 1; t += 0.005) peak = Math.max(peak, spring(t, SPRINGS.bouncy));
  assert.ok(peak > 1.15, `bouncy overshoots (${peak.toFixed(3)})`);
  let over = 0;
  for (let t = 0; t < 2; t += 0.005) over = Math.max(over, spring(t, SPRINGS.smooth));
  assert.ok(over <= 1.0005, `smooth does not overshoot (${over})`);
  assert.ok(settleTime(SPRINGS.snappy) < settleTime(SPRINGS.gentle), 'snappy settles before gentle');
});

test('presets: unique ids, every group known; makeMotion fills defaults and keeps values in range', () => {
  const ids = KINETIC.map((k) => k.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const k of KINETIC) assert.ok(['none', 'in', 'emph', 'loop'].includes(k.group), k.id);
  assert.equal(makeMotion('none'), null);
  assert.equal(makeMotion('nope'), null);
  assert.deepEqual(makeMotion('wordPop'), { type: 'wordPop', spring: 'bouncy', stagger: 0.1, speed: 1, out: 'none' });
  assert.deepEqual(makeMotion('karaoke', { color: '#00ff88', speed: 9 }), { type: 'karaoke', spring: 'bouncy', speed: 3, color: '#00ff88' });
  assert.equal(makeMotion('karaoke', { color: 'red; x' }).color, '#FFE600', 'a colour that is not hex is not taken');
  assert.equal(makeMotion('charDrop', { spring: 'snappy', out: 'reverse', stagger: 5 }).stagger, 1);
  assert.equal(makeMotion('charDrop', { out: 'reverse' }).out, 'reverse');
});

// a canvas stand-in: every character 10 px wide (spaces too)
const fakeCtx = { measureText: (s) => ({ width: [...s].length * 10 }) };
const layout = (lines, align = 'center') => {
  const widths = lines.map((l) => [...l].length * 10);
  const w = Math.max(...widths);
  return { L: { font: `t-${lines.join('|')}`, lines, widths, lineH: 50, w, h: lines.length * 50 }, tx: { align, letterSpacing: 0 } };
};

test('pieces: words, letters and lines in their places (centre, left, right)', () => {
  const { L, tx } = layout(['Tas ini', 'keren']);
  const w = pieces(fakeCtx, L, tx, 'word');
  assert.deepEqual(w.map((p) => [p.text, p.x, p.w, p.y, p.line, p.word]), [['Tas', -35, 30, -25, 0, 0], ['ini', 5, 30, -25, 0, 1], ['keren', -25, 50, 25, 1, 2]]);
  const c = pieces(fakeCtx, L, tx, 'char');
  assert.equal(c.length, 11, 'letters without spaces');
  assert.deepEqual(c.slice(3, 6).map((p) => [p.text, p.x, p.word, p.wi, p.ci]), [['i', 5, 1, 0, 3], ['n', 15, 1, 1, 4], ['i', 25, 1, 2, 5]]);
  const left = layout(['Tas ini', 'keren'], 'left');
  assert.equal(pieces(fakeCtx, left.L, left.tx, 'word')[2].x, -35, 'left: lines start at the left edge');
  const right = layout(['Tas ini', 'keren'], 'right');
  assert.equal(pieces(fakeCtx, right.L, right.tx, 'word')[2].x, -15, 'right: lines end at the right edge');
  const lines = pieces(fakeCtx, L, tx, 'line');
  assert.deepEqual(lines.map((p) => [p.text, p.x, p.word, p.ci]), [['Tas ini', -35, 0, 0], ['keren', -25, 2, 6]]);
  assert.equal(wordCount('Tas ini\nkeren'), 3);
});

test('timing: one after another, squeezed into a short clip, or at the said words', () => {
  const { L, tx } = layout(['satu dua tiga empat']);
  const list = pieces(fakeCtx, L, tx, 'word');
  const k = kineticById('wordPop');
  assert.deepEqual(startTimes(list, makeMotion('wordPop'), k, 5).map((t) => +t.toFixed(3)), [0, 0.1, 0.2, 0.3]);
  // 0.9 s clip: every word must be in (and settled) within 70% of it
  const short = startTimes(list, makeMotion('wordPop'), k, 0.9);
  assert.ok(short[3] + settleTime(SPRINGS.bouncy) <= 0.7 * 0.9 + 1e-9 || short[3] - short[2] <= 0.0081, `squeezed: ${short}`);
  // faster speed: shorter gaps
  assert.ok(startTimes(list, makeMotion('wordPop', { speed: 2 }), k, 5)[1] < 0.06);
  // auto subtitles: each word when it is said
  const said = [[0.05, 0.3], [0.4, 0.6], [0.9, 1.2], [1.3, 1.5]];
  assert.deepEqual(startTimes(list, makeMotion('wordPop'), k, 2, said), [0.05, 0.4, 0.9, 1.3]);
  // letters: their word's time, a little apart inside the word
  const letters = pieces(fakeCtx, L, tx, 'char');
  const lt = startTimes(letters, makeMotion('charDrop'), kineticById('charDrop'), 2, said);
  assert.equal(lt[0], 0.05);
  assert.equal(+lt[4].toFixed(3), 0.4, 'first letter of "dua"');
  assert.ok(lt[5] > lt[4]);
  // times that do not match the words (the text was edited): spread evenly instead
  assert.deepEqual(startTimes(list, makeMotion('wordPop'), k, 5, [[0, 1]]).map((t) => +t.toFixed(3)), [0, 0.1, 0.2, 0.3]);
});

test('entrance poses: start away, end in place', () => {
  for (const k of KINETIC.filter((x) => x.group === 'in' && x.spring)) {
    const end = entrancePose(k.id, 1, 1);
    const z = (v) => +v.toFixed(6) + 0; // (-0 is 0 here)
    assert.deepEqual([end.dx, end.dy, end.sc, end.sx, end.sy, end.rot, end.alpha, end.blur].map(z), [0, 0, 1, 1, 1, 0, 1, 0], `${k.id} ends in place`);
    const start = entrancePose(k.id, 0, 0);
    const moved = start.dx || start.dy || start.sc !== 1 || start.sy !== 1 || start.rot || start.blur;
    assert.ok(moved, `${k.id} starts away from its place`);
  }
});

test('counting numbers keep their writing', () => {
  assert.equal(countText('Rp149.000', 1), 'Rp149.000');
  assert.equal(countText('Rp149.000', 0.5), 'Rp74.500');
  assert.equal(countText('Rp149.000', 0), 'Rp0');
  assert.equal(countText('Diskon 50%', 0.5), 'Diskon 25%');
  assert.equal(countText('$1,250', 0.5), '$625');
  assert.equal(countText('4,5 juta', 1), '4,5 juta');
  assert.equal(countText('Rp1.250.000 jadi Rp999.000', 1), 'Rp1.250.000 jadi Rp999.000');
  assert.equal(countText('tanpa angka', 0.3), 'tanpa angka');
});
