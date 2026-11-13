// Metrics collector (public/js/metrics.js): percentiles, bounded memory, counters. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metrics } from '../public/js/metrics.js';

test('stats: p50/p95/max/avg over the samples', () => {
  metrics.reset();
  for (let i = 1; i <= 100; i++) metrics.sample('x', i);
  const s = metrics.stats('x');
  assert.deepEqual([s.n, s.p50, s.p95, s.max, s.avg], [100, 51, 96, 100, 50.5]);
  assert.equal(metrics.stats('nothing'), null);
  metrics.sample('x', NaN);
  metrics.sample('x', Infinity);
  assert.equal(metrics.stats('x').n, 100, 'non-finite values are ignored');
});

test('ring buffer: memory stays bounded, stats use the latest samples', () => {
  metrics.reset();
  for (let i = 0; i < 5000; i++) metrics.sample('y', i < 4400 ? 1000 : 1);
  const s = metrics.stats('y');
  assert.equal(s.n, 5000, 'n counts every sample');
  assert.equal(s.max, 1, 'only the last 600 are kept');
});

test('counters, events, timer, snapshot', async () => {
  metrics.reset();
  metrics.count('a');
  metrics.count('a', 4);
  for (let i = 0; i < 50; i++) metrics.event('export', { i });
  const stop = metrics.timer('t');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(stop() >= 15);
  const snap = await metrics.snapshot({ extra: 1 });
  assert.equal(snap.counters.a, 5);
  assert.equal(snap.events.length, 40, 'event log is bounded');
  assert.equal(snap.events.at(-1).i, 49);
  assert.ok(snap.series.t.p50 >= 15);
  assert.equal(snap.extra, 1);
  assert.doesNotThrow(() => JSON.stringify(snap));
});
