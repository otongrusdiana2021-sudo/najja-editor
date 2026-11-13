// Durable media job queue (lib/jobs.js): idempotency, bounded concurrency, retry, timeout, cancel, restart.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJobs, defaultLimits } from '../lib/jobs.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'najja-jobs-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await sleep(10); } };
const fast = { backoff: () => 20 };

test('same key while queued/running → the same job, run once', async () => {
  const q = createJobs({ dir: tmp(), limits: { fast: 1, slow: 1 }, ...fast });
  let runs = 0;
  q.register('edit', { run: async () => { runs++; await sleep(60); } });
  const a = await q.enqueue({ kind: 'edit', data: { mediaId: 'm1' }, owner: 'u1' });
  const b = await q.enqueue({ kind: 'edit', data: { mediaId: 'm1' }, owner: 'u1' });
  assert.equal(a.id, b.id);
  await q.idle();
  assert.equal(runs, 1);
  assert.equal(q.get(a.id).state, 'succeeded');
  assert.equal(q.active('edit:m1'), null);
  const c = await q.enqueue({ kind: 'edit', data: { mediaId: 'm1' } });
  assert.notEqual(c.id, a.id, 'a finished job does not block a new one');
  await q.idle();
});

test('concurrency is bounded per class; fast work is not stuck behind slow work', async () => {
  const q = createJobs({ dir: tmp(), limits: { fast: 2, slow: 1 }, ...fast });
  let now = 0;
  let max = 0;
  const order = [];
  const work = (ms) => async (job) => { now++; max = Math.max(max, now); await sleep(ms); now--; order.push(job.data.mediaId); };
  q.register('edit', { cls: 'fast', run: work(40) });
  q.register('proxy', { cls: 'slow', run: work(300) });
  await q.enqueue({ kind: 'proxy', data: { mediaId: 'big' } });
  for (let i = 0; i < 5; i++) await q.enqueue({ kind: 'edit', data: { mediaId: `m${i}` } });
  await q.idle();
  assert.equal(max, 3, '2 fast + 1 slow at most');
  assert.equal(order.at(-1), 'big', 'the five previews finished while the long job ran');
  const m = q.metrics();
  assert.equal(m.edit.done, 5);
  assert.equal(m.edit.limit, 2);
  assert.equal(m.proxy.limit, 1);
});

test('a job waits for the job it depends on, without taking a slot', async () => {
  const q = createJobs({ dir: tmp(), limits: { fast: 2, slow: 1 }, ...fast });
  const order = [];
  q.register('edit', { run: async (job) => { await sleep(80); order.push(`edit:${job.data.mediaId}`); } });
  q.register('assets', { run: async (job) => { order.push(`assets:${job.data.mediaId}`); } });
  await q.enqueue({ kind: 'edit', data: { mediaId: 'a' } });
  await q.enqueue({ kind: 'assets', data: { mediaId: 'a' }, after: 'edit:a' }); // a slot is free, but it must wait
  await q.enqueue({ kind: 'assets', data: { mediaId: 'b' }, after: 'edit:b' }); // no such job: runs at once
  await q.idle();
  assert.ok(order.indexOf('assets:a') > order.indexOf('edit:a'), order.join(' '));
  assert.equal(order[0], 'assets:b');
});

test('retry with backoff, then fail with the error after maxAttempts', async () => {
  const q = createJobs({ dir: tmp(), limits: { fast: 1, slow: 1 }, ...fast });
  let n = 0;
  q.register('flaky', { maxAttempts: 3, run: async () => { if (++n < 2) throw new Error('disk busy'); } });
  q.register('broken', { maxAttempts: 2, run: async () => ({ state: 'error', error: 'Invalid data found' }) });
  const a = await q.enqueue({ kind: 'flaky', data: { mediaId: 'a' } });
  const b = await q.enqueue({ kind: 'broken', data: { mediaId: 'b' } });
  await until(() => q.get(a.id).state === 'succeeded' && q.get(b.id).state === 'failed');
  assert.equal(q.get(a.id).attempts, 2);
  assert.equal(q.get(b.id).attempts, 2);
  assert.match(q.get(b.id).error, /Invalid data/);
  assert.equal(q.metrics().flaky.retried, 1);
  // retry a failed job on request: a new job with the same key
  q.register('broken', { maxAttempts: 1, run: async () => {} });
  const again = await q.retry(b.id);
  assert.notEqual(again.id, b.id);
  await q.idle();
  assert.equal(q.get(again.id).state, 'succeeded');
});

test('timeout aborts the job (the handler gets the abort signal)', async () => {
  const q = createJobs({ dir: tmp(), limits: { fast: 1, slow: 1 }, ...fast });
  let aborted = 0;
  q.register('hang', { maxAttempts: 1, timeoutMs: () => 50, run: (job, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('killed')); })) });
  const j = await q.enqueue({ kind: 'hang', data: { mediaId: 'x' } });
  await until(() => q.get(j.id).state === 'failed');
  assert.equal(aborted, 1);
  assert.match(q.get(j.id).error, /timeout/);
});

test('cancel: a running job is aborted, a queued job never runs', async () => {
  const q = createJobs({ dir: tmp(), limits: { fast: 1, slow: 1 }, ...fast });
  let started = 0;
  q.register('edit', { run: (job, { signal }) => { started++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('killed')))); } });
  const a = await q.enqueue({ kind: 'edit', data: { mediaId: 'a' } });
  const b = await q.enqueue({ kind: 'edit', data: { mediaId: 'b' } });
  await until(() => q.get(a.id).state === 'running');
  await q.cancel(b.id);
  await q.cancel(a.id);
  await until(() => q.get(a.id).state === 'cancelled');
  await sleep(50);
  assert.equal(q.get(b.id).state, 'cancelled');
  assert.equal(started, 1);
  assert.equal(q.get(a.id).attempts, 1, 'a cancelled job is not retried');
});

test('restart: queued and interrupted jobs continue from the journal; broken files are skipped', async () => {
  const dir = tmp();
  const q1 = createJobs({ dir, limits: { fast: 1, slow: 1 }, ...fast });
  q1.register('edit', { run: () => new Promise(() => {}) }); // the "server" dies while this runs
  const a = await q1.enqueue({ kind: 'edit', data: { mediaId: 'a' }, owner: 'u1' });
  const b = await q1.enqueue({ kind: 'edit', data: { mediaId: 'b' }, owner: 'u2' });
  await until(() => q1.get(a.id).state === 'running');
  fs.writeFileSync(path.join(dir, 'j_broken.json'), '{not json');
  const q2 = createJobs({ dir, limits: { fast: 2, slow: 1 }, ...fast });
  const done = [];
  q2.register('edit', { run: async (job) => { done.push(job.data.mediaId); } });
  await q2.init();
  assert.equal(q2.get(a.id).interrupted, 1);
  await q2.idle();
  assert.deepEqual(done.sort(), ['a', 'b']);
  assert.equal(q2.get(b.id).owner, 'u2');
  assert.ok(!fs.existsSync(path.join(dir, 'j_broken.json')));
  assert.deepEqual(q2.list({ owner: (j) => j.owner === 'u1' }).map((j) => j.mediaId), ['a'], 'jobs are listed per owner');
});

test('short lane: a short job starts next to a long one, never next to another short one', async () => {
  const q = createJobs({ dir: tmp(), limits: { fast: 1 }, ...fast });
  const started = [];
  const gates = {};
  q.register('edit', { cls: 'fast', shortLane: { maxSeconds: 90, extra: 1 }, run: (job) => { started.push(job.data.mediaId); return new Promise((r) => { gates[job.data.mediaId] = r; }); } });
  await q.enqueue({ kind: 'edit', data: { mediaId: 'long', duration: 600 } });
  await until(() => started.includes('long'));
  await q.enqueue({ kind: 'edit', data: { mediaId: 's1', duration: 10 } });
  await q.enqueue({ kind: 'edit', data: { mediaId: 's2', duration: 20 } });
  await q.enqueue({ kind: 'edit', data: { mediaId: 'long2', duration: 300 } });
  await until(() => started.includes('s1'));
  await sleep(50);
  assert.deepEqual(started, ['long', 's1'], 'one extra slot, for a short job only');
  gates.s1();
  await until(() => started.includes('s2'));
  assert.deepEqual(started, ['long', 's1', 's2']);
  gates.s2();
  await sleep(50);
  assert.ok(!started.includes('long2'), 'a long job does not use the short lane');
  gates.long();
  await until(() => started.includes('long2'));
  gates.long2();
  await q.idle();
});

test('default limits follow the machine and the env switches', () => {
  const d = defaultLimits({});
  assert.ok(d.fast >= 1 && d.fast <= 3);
  assert.ok(d.slow >= 1 && d.slow <= 2);
  assert.ok(d.light >= 1 && d.light <= 2);
  assert.deepEqual(defaultLimits({ NAJJA_JOB_LIGHT: '3', NAJJA_JOB_FAST: '4', NAJJA_JOB_SLOW: '2' }), { light: 3, fast: 4, slow: 2 });
  assert.deepEqual(defaultLimits({ NAJJA_JOB_FAST: 'x', NAJJA_JOB_SLOW: '0' }), d);
});

test('shorter media first, with aging (a long job that waited long enough goes first)', async () => {
  let now = 1_000_000;
  const q = createJobs({ dir: tmp(), limits: { fast: 1 }, now: () => now, ...fast });
  const order = [];
  let release;
  q.register('edit', { cls: 'fast', weight: 0.5, run: async (job) => { order.push(job.data.mediaId); if (job.data.mediaId === 'first') await new Promise((r) => { release = r; }); } });
  await q.enqueue({ kind: 'edit', data: { mediaId: 'first', duration: 1 } }); // occupies the only slot
  await until(() => release);
  await q.enqueue({ kind: 'edit', data: { mediaId: 'long', duration: 600 } }); // 10 min: place = t + 300 s
  now += 1000;
  await q.enqueue({ kind: 'edit', data: { mediaId: 'short', duration: 10 } }); // queued 1 s later: place = t + 6 s
  now += 1000;
  await q.enqueue({ kind: 'edit', data: { mediaId: 'old-long', duration: 600 } });
  release();
  await until(() => order.length === 4);
  assert.deepEqual(order, ['first', 'short', 'long', 'old-long']);
  // aging: a long job waiting 400 s is ahead of a short one that just arrived (300 s handicap < 400 s waited)
  order.length = 0;
  release = null;
  await q.enqueue({ kind: 'edit', data: { mediaId: 'first', duration: 1 } });
  await until(() => release);
  await q.enqueue({ kind: 'edit', data: { mediaId: 'waited-long', duration: 600 } });
  now += 400_000;
  await q.enqueue({ kind: 'edit', data: { mediaId: 'new-short', duration: 10 } });
  release();
  await until(() => order.length === 3);
  assert.deepEqual(order, ['first', 'waited-long', 'new-short']);
});
