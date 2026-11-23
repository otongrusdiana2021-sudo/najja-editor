// (v1.13.2) One thing at a time. The editor has one project, one playhead and one preview, so tool calls that
// change the project or move the playhead must not overlap: three get_frame calls arriving together used to seek
// the shared engine one after another and then all draw the last time (three identical pictures), and two edits at
// once could interleave. No DOM here, so it runs in Node tests too.

/**
 * Tools that only read state: they neither change the project nor move the playhead, so they may run while
 * another tool is busy (a get_project during a long apply_style still answers at once).
 * get_frame is not one of them: it pauses playback and seeks.
 */
export const PURE_READS = new Set(['get_project', 'list_assets', 'list_media', 'list_styles', 'get_export_status']);

/**
 * A FIFO queue: each task starts after every task queued before it has finished (resolved or failed).
 * With a deadline (a time of `now()`), a task still waiting at its deadline does not start and rejects with
 * code 'EXPIRED' (the caller has given up on it, so its edit would only surprise the user).
 */
export function createQueue({ now = () => Date.now() } = {}) {
  let tail = Promise.resolve();
  let waiting = 0;
  let running = false;
  return {
    /** Tasks queued and not started yet. */
    get waiting() { return waiting; },
    /** A task is running right now. */
    get busy() { return running; },
    run(task, { deadline = null, onStart } = {}) {
      waiting++;
      const result = tail.then(async () => {
        waiting--;
        if (deadline != null && now() >= deadline) {
          throw Object.assign(new Error('Not run: it waited too long for the tool before it to finish. Call it again.'), { code: 'EXPIRED' });
        }
        running = true;
        try {
          onStart?.();
          return await task();
        } finally {
          running = false;
        }
      });
      tail = result.then(() => {}, () => {}); // a failed task never blocks the next one
      return result;
    },
  };
}
