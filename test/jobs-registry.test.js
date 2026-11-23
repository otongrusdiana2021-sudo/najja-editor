// (v1.13.2, P1-2) The editor's job registry (public/js/core/jobs.js). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobs, runJob } from '../public/js/core/jobs.js';

let t = 1000;
let n = 0;
const fresh = () => createJobs({ now: () => t++, newId: () => `job_${++n}`, keep: 3 });

test('a job runs, reports progress and ends done with its result', async () => {
  const jobs = fresh();
  let step;
  const { id, done } = runJob(jobs, 'style', ({ onProgress }) => new Promise((r) => { step = () => { onProgress(0.5, 'Menyusun'); r({ project_id: 'p_1' }); }; }));
  assert.equal(jobs.get(id).state, 'running');
  await Promise.resolve();
  step();
  await done;
  const v = jobs.get(id);
  assert.deepEqual([v.state, v.progress_percent, v.result, v.cancellable], ['done', 100, { project_id: 'p_1' }, false]);
  assert.ok(v.finished_at >= v.started_at);
});

test('cancel stops work that listens to its signal; the job ends cancelled, never done', async () => {
  const jobs = fresh();
  const { id, done } = runJob(jobs, 'transcript', ({ signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('Dibatalkan'))); }));
  assert.equal(jobs.get(id).cancellable, true);
  assert.deepEqual(jobs.cancel(id), { cancelled: true, state: 'cancelling' });
  await done;
  assert.equal(jobs.get(id).state, 'cancelled');
  assert.equal(jobs.cancel(id).cancelled, false, 'a finished job cannot be cancelled again');
});

test('a failing job ends error with the message; unknown ids and jobs without a stop are said, not faked', async () => {
  const jobs = fresh();
  const { id, done } = runJob(jobs, 'style', async () => { throw new Error('model tidak termuat'); });
  await done;
  assert.deepEqual([jobs.get(id).state, jobs.get(id).error], ['error', 'model tidak termuat']);
  assert.match(jobs.cancel('job_nope').reason, /Unknown job_id/);
  const fixed = jobs.create('export', { cancel: null });
  assert.deepEqual(jobs.cancel(fixed), { cancelled: false, state: 'running', reason: 'This job cannot be cancelled; it stops when it is done.' });
  assert.equal(jobs.get(fixed).state, 'running');
});

test('live state (an export\'s progress) is read when asked; only the last finished jobs are kept, running ones never dropped', () => {
  const jobs = fresh();
  let live = 0.25;
  const ex = jobs.create('export', { cancel: () => {}, live: () => ({ progress: live, label: 'Merender' }) });
  assert.deepEqual([jobs.get(ex).progress_percent, jobs.get(ex).label], [25, 'Merender']);
  live = 0.9;
  assert.equal(jobs.get(ex).progress_percent, 90);
  for (let i = 0; i < 5; i++) { const j = jobs.create('style'); jobs.finish(j, { state: 'done' }); }
  assert.ok(jobs.get(ex), 'the running export stays');
  assert.equal(jobs.list().length, 3, 'keep: 3');
  assert.equal(jobs.list()[0].kind, 'style', 'newest first');
});
