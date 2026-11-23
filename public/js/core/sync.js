// (v1.13.2, V19) What the editor does with the answer of its revision check (app.js pollRevision, every second),
// as a pure function so it is tested without a page.

/**
 * answer: { rev } from /api/projects/:id/rev, or { error } (error.status from the API).
 * local: { baseRev, dirty, saving } of the open project.
 * Returns:
 *   'gone'   — the server does not have the project any more (404: deleted on another device or tab). Before, this
 *              was ignored and asked again every second, for ever, and the user was never told.
 *   'wait'   — no answer (offline, server busy): ask again next time.
 *   'same'   — the server has nothing newer.
 *   'mine'   — newer on the server while this device has changes: the next save gets a 409 and the user chooses.
 *   'follow' — newer on the server, nothing changed here: load it.
 */
export function revCheck({ rev = null, error = null } = {}, { baseRev = 0, dirty = false, saving = false } = {}) {
  if (error) return error.status === 404 ? 'gone' : 'wait';
  if (rev == null) return 'wait';
  if (rev <= baseRev) return 'same';
  return dirty || saving ? 'mine' : 'follow';
}
