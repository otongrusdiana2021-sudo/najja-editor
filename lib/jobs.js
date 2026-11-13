// Durable media job queue (v1.7 P5). Replaces the in-memory, one-at-a-time queue of v1.6:
//   - every job is a small JSON file in data/jobs/ (written atomically), so a restart resumes queued and interrupted
//     work instead of forgetting it;
//   - idempotent: enqueueing the same key (e.g. "edit:m_123") while it is queued or running returns that job;
//   - states queued → running → succeeded | failed | cancelled, with progress, heartbeat, attempts and the error;
//   - retry with exponential backoff, a timeout per job, and cancel (the running ffmpeg is killed);
//   - bounded concurrency per class: "light" (thumbnails, waveform), "fast" (preview copies) and "slow" (full-quality
//     copies), sized from the CPU cores and RAM of the VPS unless NAJJA_JOB_LIGHT / _FAST / _SLOW say otherwise;
//   - within a class, shorter media first with aging: a job's place is its queue time plus `weight` × media duration,
//     so a 10-minute conversion of one account does not hold up a 10-second clip of another, and still runs;
//   - short lane: a short job (≤ shortLane.maxSeconds) may take `extra` slots more while every running job of its
//     class is a long one — it does not wait minutes behind a long conversion that already started.
// Handlers are registered by kind; the journal stores only data (kind, media id, owner), never code.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const KEEP_MS = 7 * 86400_000; // finished jobs are kept a week (status, errors), then removed
const KEEP_MAX = 2000;

export function defaultLimits(env = process.env) {
  const cores = os.cpus().length || 1;
  const memGB = os.totalmem() / 1e9;
  // ffmpeg uses several threads per job: one fast job per 4 cores (at least 1, at most 3); one slow job, two on big
  // machines. RAM: a 1080p transcode needs ~0.5–1 GB.
  const fast = Math.max(1, Math.min(3, Math.floor(cores / 4), Math.floor(memGB / 2)));
  const slow = cores >= 8 && memGB >= 8 ? 2 : 1;
  const light = cores >= 8 ? 2 : 1; // thumbnails/waveform: short, low priority, from the light copy
  const num = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { light: num(env.NAJJA_JOB_LIGHT, light), fast: num(env.NAJJA_JOB_FAST, fast), slow: num(env.NAJJA_JOB_SLOW, slow) };
}

/**
 * @param dir     folder for the journal (data/jobs)
 * @param limits  { fast, slow } concurrent jobs per class
 * @param log     logger
 */
export function createJobs({ dir, limits = defaultLimits(), log = () => {}, now = () => Date.now(), backoff = (attempt) => 5000 * 4 ** (attempt - 1) } = {}) {
  const handlers = new Map(); // kind -> { cls, weight, shortLane, timeoutMs(job), maxAttempts, run(job, ctx) }
  const jobs = new Map(); // id -> job record
  const byKey = new Map(); // idempotency key -> id of the active (queued/running) job
  const running = new Map(); // id -> { abort: AbortController, cls }
  const listeners = new Set();
  const stats = {}; // kind -> { wait: [], run: [], succeeded, failed, cancelled, retried }
  let timer = null;
  let ready = null;
  let loaded = false;

  const file = (id) => path.join(dir, `${id}.json`);
  async function save(job) {
    const tmp = `${file(job.id)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(job));
    await fsp.rename(tmp, file(job.id));
  }
  const persist = (job) => save(job).catch((err) => log(`job journal write failed (${job.id}): ${err.message}`));
  const emit = (job) => { for (const fn of listeners) { try { fn(job); } catch { /* listener error */ } } };
  const statOf = (kind) => (stats[kind] ||= { wait: [], run: [], succeeded: 0, failed: 0, cancelled: 0, retried: 0 });
  const keep = (arr, v) => { arr.push(v); if (arr.length > 200) arr.shift(); };

  /** Load the journal: queued jobs wait again, jobs that were running when the server stopped are queued again. */
  function init() {
    if (ready) return ready;
    ready = (async () => {
      await fsp.mkdir(dir, { recursive: true });
      const cutoff = now() - KEEP_MS;
      for (const f of await fsp.readdir(dir)) {
        if (f.endsWith('.tmp')) { await fsp.rm(path.join(dir, f), { force: true }); continue; }
        if (!f.endsWith('.json')) continue;
        let job;
        try { job = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')); } catch { await fsp.rm(path.join(dir, f), { force: true }); continue; } // unreadable: skipped (the media status makes it again)
        if (TERMINAL.has(job.state) && (job.finishedAt || 0) < cutoff) { await fsp.rm(path.join(dir, f), { force: true }); continue; }
        if (job.state === 'running') {
          job.state = 'queued';
          job.interrupted = (job.interrupted || 0) + 1;
          job.notBefore = 0;
          await save(job);
        }
        jobs.set(job.id, job);
        if (!TERMINAL.has(job.state)) byKey.set(job.key, job.id);
      }
      const n = [...jobs.values()].filter((j) => j.state === 'queued').length;
      if (n) log(`antrean job dilanjutkan: ${n} job`);
      loaded = true;
      schedule(0);
    })();
    return ready;
  }

  function register(kind, { cls = 'fast', weight = 0, shortLane = null, timeoutMs = () => 60 * 60_000, maxAttempts = 3, run }) {
    handlers.set(kind, { cls, weight, shortLane, timeoutMs, maxAttempts, run });
    schedule(0);
  }

  /**
   * Add a job, or return the queued/running one with the same key.
   * after: key of a job that must finish first (e.g. thumbnails after the preview copy they are made from).
   */
  async function enqueue({ kind, key = null, data = {}, owner = null, priority = 0, after = null }) {
    await init();
    key = key || `${kind}:${data.mediaId || ''}`;
    const active = byKey.get(key);
    if (active && jobs.has(active) && !TERMINAL.has(jobs.get(active).state)) return jobs.get(active);
    const h = handlers.get(kind);
    const job = {
      id: `j_${crypto.randomBytes(8).toString('hex')}`, key, kind, cls: h?.cls || 'fast', data, owner, priority, after,
      state: 'queued', progress: 0, attempts: 0, maxAttempts: h?.maxAttempts || 3, error: null,
      createdAt: now(), queuedAt: now(), startedAt: null, finishedAt: null, heartbeatAt: null, notBefore: 0,
    };
    jobs.set(job.id, job);
    byKey.set(key, job.id);
    await save(job);
    emit(job);
    schedule(0);
    return job;
  }

  function schedule(ms) {
    if (timer) return;
    timer = setTimeout(() => { timer = null; pump(); }, ms);
    timer.unref?.();
  }
  const count = (cls) => [...running.values()].filter((r) => r.cls === cls).length;
  const dur = (j) => j?.data?.duration || 0;
  /** May this job start now? Within the class limit, or in the short lane next to long jobs only. */
  function mayStart(job) {
    const lim = limits[job.cls] || 1;
    const busy = count(job.cls);
    if (busy < lim) return true;
    const lane = handlers.get(job.kind)?.shortLane;
    if (!lane || dur(job) > lane.maxSeconds || busy >= lim + (lane.extra || 1)) return false;
    return [...running.entries()].filter(([, r]) => r.cls === job.cls).every(([id]) => dur(jobs.get(id)) > lane.maxSeconds);
  }

  function pump() {
    if (!loaded) { init(); return; } // init() schedules the first pump once the journal is loaded
    const t = now();
    let nextWake = Infinity;
    // shorter media first, with aging (see header)
    const place = (j) => j.queuedAt + (handlers.get(j.kind)?.weight || 0) * (j.data.duration || 0) * 1000;
    const waiting = [...jobs.values()].filter((j) => j.state === 'queued' && handlers.has(j.kind))
      .sort((a, b) => b.priority - a.priority || place(a) - place(b));
    for (const job of waiting) {
      if (job.notBefore > t) { nextWake = Math.min(nextWake, job.notBefore - t); continue; }
      if (job.after && byKey.has(job.after)) continue; // waits for that job (pump runs again when it ends)
      if (!mayStart(job)) continue;
      start(job);
    }
    if (nextWake < Infinity) schedule(Math.max(50, nextWake));
  }

  async function start(job) {
    const h = handlers.get(job.kind);
    const abort = new AbortController();
    running.set(job.id, { abort, cls: job.cls });
    const st = statOf(job.kind);
    keep(st.wait, now() - job.queuedAt);
    Object.assign(job, { state: 'running', attempts: job.attempts + 1, startedAt: now(), heartbeatAt: now(), progress: 0, error: null });
    await persist(job);
    emit(job);
    const limit = h.timeoutMs(job);
    const timeout = limit ? setTimeout(() => abort.abort(new Error(`timeout after ${Math.round(limit / 1000)} s`)), limit) : null;
    timeout?.unref?.();
    let lastBeat = 0;
    const ctx = {
      signal: abort.signal,
      /** Report progress 0..1 (kept in memory; the journal gets a heartbeat at most every 5 s). */
      progress(p) {
        job.progress = Math.max(0, Math.min(1, p));
        if (now() - lastBeat > 5000) { lastBeat = now(); job.heartbeatAt = now(); persist(job); }
      },
    };
    const t0 = now();
    let outcome;
    try {
      const result = await h.run(job, ctx);
      if (abort.signal.aborted) throw abort.signal.reason || new Error('aborted');
      // handlers that record their own error (state file) return { failed: true } or { state: 'error' }
      if (result?.failed || result?.state === 'error') throw Object.assign(new Error(result.error || 'failed'), { recorded: true });
      outcome = { state: 'succeeded', progress: 1 };
    } catch (err) {
      const cancelled = abort.signal.aborted && job.cancelRequested;
      const msg = String((abort.signal.aborted && abort.signal.reason?.message) || err.message || err).slice(0, 500);
      if (cancelled) outcome = { state: 'cancelled', error: 'dibatalkan' };
      else if (job.attempts < job.maxAttempts && !err.permanent) {
        // exponential backoff: 5 s, 20 s, 80 s …
        outcome = { state: 'queued', error: msg, notBefore: now() + backoff(job.attempts), queuedAt: now() };
        statOf(job.kind).retried++;
      } else outcome = { state: 'failed', error: msg };
    } finally {
      if (timeout) clearTimeout(timeout);
      running.delete(job.id);
    }
    keep(st.run, now() - t0);
    Object.assign(job, outcome, TERMINAL.has(outcome.state) ? { finishedAt: now() } : {});
    if (TERMINAL.has(job.state)) {
      st[job.state]++;
      if (byKey.get(job.key) === job.id) byKey.delete(job.key);
      if (job.state === 'failed') log(`job ${job.kind} ${job.data.mediaId || ''} gagal: ${job.error}`);
    }
    await persist(job);
    emit(job);
    prune();
    schedule(0);
  }

  function prune() {
    const done = [...jobs.values()].filter((j) => TERMINAL.has(j.state)).sort((a, b) => a.finishedAt - b.finishedAt);
    for (const j of done.slice(0, Math.max(0, done.length - KEEP_MAX))) { jobs.delete(j.id); fsp.rm(file(j.id), { force: true }).catch(() => {}); }
  }

  /** Cancel a queued or running job. Returns the job (or null). */
  async function cancel(id) {
    const job = jobs.get(id);
    if (!job || TERMINAL.has(job.state)) return job || null;
    job.cancelRequested = true;
    const r = running.get(id);
    if (r) { r.abort.abort(new Error('dibatalkan')); return job; }
    Object.assign(job, { state: 'cancelled', error: 'dibatalkan', finishedAt: now() });
    if (byKey.get(job.key) === job.id) byKey.delete(job.key);
    statOf(job.kind).cancelled++;
    await persist(job);
    emit(job);
    return job;
  }
  /** Run a finished (failed/cancelled) job again as a new job with the same key. */
  async function retry(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (!TERMINAL.has(job.state)) return job;
    return enqueue({ kind: job.kind, key: job.key, data: job.data, owner: job.owner, priority: job.priority + 1, after: job.after });
  }

  const pct = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return { n: s.length, p50: s[Math.floor(s.length * 0.5)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
  };
  const publicJob = (j) => ({
    id: j.id, kind: j.kind, mediaId: j.data.mediaId || null, state: j.state, progress: Math.round(j.progress * 1000) / 1000,
    attempts: j.attempts, maxAttempts: j.maxAttempts, error: j.error, createdAt: j.createdAt, startedAt: j.startedAt,
    finishedAt: j.finishedAt, heartbeatAt: j.heartbeatAt, retryAt: j.state === 'queued' && j.notBefore > now() ? j.notBefore : null,
  });

  return {
    init,
    register,
    enqueue,
    cancel,
    retry,
    get: (id) => jobs.get(id) || null,
    /** The queued or running job for a key (e.g. "edit:m_123"), or null. */
    active(key) { const id = byKey.get(key); const j = id && jobs.get(id); return j && !TERMINAL.has(j.state) ? j : null; },
    list({ owner, filter } = {}) {
      return [...jobs.values()].filter((j) => (owner == null || owner(j)) && (!filter || filter(j))).sort((a, b) => b.createdAt - a.createdAt).map(publicJob);
    },
    publicJob,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    limits,
    metrics() {
      const out = {};
      for (const kind of new Set([...handlers.keys(), ...Object.keys(stats)])) {
        const st = statOf(kind);
        const cls = handlers.get(kind)?.cls || 'fast';
        const active = [...jobs.values()].filter((j) => j.kind === kind);
        out[kind] = {
          class: cls, limit: limits[cls] || 1, done: st.succeeded, failed: st.failed, cancelled: st.cancelled, retried: st.retried,
          running: active.filter((j) => j.state === 'running').length, queued: active.filter((j) => j.state === 'queued').length,
          wait: pct(st.wait), run: pct(st.run),
        };
      }
      return out;
    },
    /** For tests and shutdown: resolves when nothing is running or due. */
    async idle(timeoutMs = 60_000) {
      const end = now() + timeoutMs;
      while (running.size || [...jobs.values()].some((j) => j.state === 'queued' && j.notBefore <= now() && handlers.has(j.kind) && !(j.after && byKey.has(j.after)))) {
        if (now() > end) throw new Error('jobs not idle');
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}
