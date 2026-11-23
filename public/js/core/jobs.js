// (v1.13.2, P1-2) Long work the AI starts in the editor (export_video, and apply_style / get_transcript with
// background: true) as jobs it can follow (get_job, list_jobs) and stop (cancel_job). No DOM here: Node tests.

const FINAL = new Set(['done', 'error', 'cancelled']);

/**
 * A registry of jobs. kind: 'export' | 'style' | 'transcript'. cancel: a function that stops the work, or null when
 * the work cannot be stopped (cancel_job then says so instead of pretending). live(): extra state read at the time
 * of the question (the export's progress lives in exportState).
 */
export function createJobs({ now = () => Date.now(), keep = 20, newId = () => `job_${Math.random().toString(36).slice(2, 10)}` } = {}) {
  const jobs = new Map();
  const hooks = new Map(); // id → { cancel, live }
  const prune = () => {
    const finished = [...jobs.values()].filter((j) => FINAL.has(j.state)).sort((a, b) => a.finishedAt - b.finishedAt);
    while (jobs.size > keep && finished.length) { const j = finished.shift(); jobs.delete(j.id); hooks.delete(j.id); }
  };
  const view = (j) => {
    if (!j) return null;
    const live = hooks.get(j.id)?.live?.() || {};
    const progress = live.progress ?? j.progress;
    return {
      job_id: j.id, kind: j.kind, state: j.state, progress_percent: Math.round((progress || 0) * 100),
      label: live.label ?? j.label ?? undefined, cancellable: !FINAL.has(j.state) && !!hooks.get(j.id)?.cancel,
      started_at: j.startedAt, finished_at: j.finishedAt ?? undefined,
      result: j.result ?? undefined, error: j.error ?? undefined,
    };
  };
  return {
    create(kind, { cancel = null, live = null } = {}) {
      const j = { id: newId(), kind, state: 'running', progress: 0, label: null, result: null, error: null, startedAt: now(), finishedAt: null };
      jobs.set(j.id, j);
      hooks.set(j.id, { cancel, live });
      prune();
      return j.id;
    },
    progress(id, p, label) { const j = jobs.get(id); if (j && !FINAL.has(j.state)) { j.progress = Math.max(0, Math.min(1, Number(p) || 0)); if (label) j.label = label; } },
    finish(id, { state, result = null, error = null }) {
      const j = jobs.get(id);
      if (!j || FINAL.has(j.state)) return;
      Object.assign(j, { state, result, error, finishedAt: now(), progress: state === 'done' ? 1 : j.progress });
      prune();
    },
    get(id) { return view(jobs.get(id)); },
    list() { return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(view); },
    /** Stop a job: { cancelled, state, reason }. A job that cannot be stopped is never reported as stopped. */
    cancel(id) {
      const j = jobs.get(id);
      if (!j) return { cancelled: false, reason: `Unknown job_id: ${id}. Call list_jobs.` };
      if (FINAL.has(j.state)) return { cancelled: false, state: j.state, reason: `The job is already ${j.state}.` };
      const fn = hooks.get(id)?.cancel;
      if (!fn) return { cancelled: false, state: j.state, reason: 'This job cannot be cancelled; it stops when it is done.' };
      fn();
      j.state = 'cancelling';
      return { cancelled: true, state: j.state };
    },
  };
}

/**
 * Run `work({ signal, onProgress })` as a job; the job ends done / error / cancelled with it. Returns { id, done },
 * done: the work's promise (settled, never rejecting).
 */
export function runJob(jobs, kind, work) {
  const ctrl = new AbortController();
  const id = jobs.create(kind, { cancel: () => ctrl.abort() });
  // The work starts now, not a tick later: a cancel right after the start must reach a work that is listening.
  // (No race with the abort: the job is "cancelled" only once the work has really stopped, never while it still
  // changes the project.)
  let started;
  try { started = Promise.resolve(work({ signal: ctrl.signal, onProgress: (p, label) => jobs.progress(id, p, label) })); } catch (err) { started = Promise.reject(err); }
  const done = started
    .then((result) => jobs.finish(id, { state: 'done', result }),
      (err) => jobs.finish(id, ctrl.signal.aborted ? { state: 'cancelled', error: 'Cancelled.' } : { state: 'error', error: err?.message || String(err) }));
  return { id, done };
}
