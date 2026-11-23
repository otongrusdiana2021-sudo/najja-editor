// (v1.13.2, P0-2) Saving to the server while the user keeps editing (public/js/store.js). Run with: npm test
// The fake server refuses a stale base revision exactly like lib/storage.js putProject (409 + its revision).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { store, newProject } from '../public/js/store.js';
import { storage } from '../public/js/storage.js';
import { db } from '../public/js/db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(ok, ms = 2000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(2);
  }
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function setup() {
  const srv = { rev: 0, saved: null, calls: [], hold: null, fail: 0, drafts: new Map() };
  srv.putProject = async (rec, { baseRev = null, force = false } = {}) => {
    srv.calls.push({ baseRev, force, name: rec.name });
    if (srv.hold) await srv.hold.promise;
    if (srv.fail > 0) { srv.fail--; throw Object.assign(new Error('network down'), { status: 0 }); }
    if (srv.saved && baseRev != null && !force && Number(baseRev) !== srv.rev) {
      throw Object.assign(new Error('Proyek sudah diubah di perangkat lain.'), { status: 409, data: { conflict: true, rev: srv.rev, updatedAt: 0 } });
    }
    srv.rev += 1;
    srv.saved = JSON.parse(JSON.stringify(rec));
    return { ok: true, rev: srv.rev, updatedAt: rec.updatedAt };
  };
  storage.mode = 'server';
  storage.putProject = srv.putProject;
  db.putDraft = async (d) => { srv.drafts.set(d.id, d); };
  db.deleteDraft = async (id) => { srv.drafts.delete(id); };
  store.thumbProvider = null;
  store.retryMs = 0;
  store.setProject(newProject({ name: 'awal' }), { dirty: true });
  return srv;
}

afterEach(async () => {
  clearTimeout(store.retryTimer);
  await store._saving;
});

test('undo while a save is running: the answer is kept, no false conflict, the undone state reaches the server', async () => {
  const srv = setup();
  store.mutate('nama', (P) => { P.name = 'satu'; });
  await store.save();
  assert.equal(store.baseRev, 1);

  store.mutate('nama', (P) => { P.name = 'dua'; });
  srv.hold = deferred();
  const saving = store.save(); // "dua" on top of rev 1; the server is slow
  await until(() => srv.calls.length === 2);
  assert.equal(store.undo(), true); // back to "satu": undo puts a new project object in place
  srv.hold.resolve();
  srv.hold = null;
  await saving;
  assert.equal(store.baseRev, 2, 'the answer of the save is kept although the project object changed');
  assert.equal(store.dirty, true, 'the undo is not on the server yet');

  await store.save();
  assert.equal(store.conflict, null, 'no "diubah di perangkat lain" on a single device');
  assert.equal(store.saveState, 'saved');
  assert.deepEqual(srv.calls.map((c) => c.baseRev), [0, 1, 2]);
  assert.equal(srv.saved.name, 'satu');
  assert.equal(store.dirty, false);
  assert.equal(srv.drafts.has(store.P.id), false, 'the device draft is dropped once everything is on the server');
});

test('redo while a save is running is saved too', async () => {
  const srv = setup();
  store.mutate('nama', (P) => { P.name = 'satu'; });
  await store.save();
  store.undo();
  srv.hold = deferred();
  const saving = store.save();
  await until(() => srv.calls.length === 2);
  store.redo();
  srv.hold.resolve();
  srv.hold = null;
  await saving;
  await store.save();
  assert.equal(store.conflict, null);
  assert.equal(srv.saved.name, 'satu');
  assert.equal(store.dirty, false);
});

test('a change without touch (media info after an upload) made while saving is not marked saved', async () => {
  const srv = setup();
  store.mutate('nama', (P) => { P.name = 'satu'; });
  srv.hold = deferred();
  const saving = store.save();
  await until(() => srv.calls.length === 1);
  store.P.media.push({ id: 'm1', type: 'image', name: 'foto.jpg' }); // as media.js does, then scheduleSave()
  store.scheduleSave();
  srv.hold.resolve();
  srv.hold = null;
  await saving;
  assert.equal(store.dirty, true);
  await store.save();
  assert.ok(srv.saved.media.some((m) => m.id === 'm1'), 'the media change reaches the server');
  assert.equal(store.dirty, false);
});

test('cancelling a drag while a save is running saves the restored state again', async () => {
  const srv = setup();
  store.mutate('nama', (P) => { P.name = 'satu'; });
  await store.save();
  store.live((P) => { P.name = 'tengah-geser'; });
  srv.hold = deferred();
  store.dirty = true; // an earlier change's save that fires during the drag
  const saving = store.save();
  await until(() => srv.calls.length === 2);
  store.cancelLive();
  srv.hold.resolve();
  srv.hold = null;
  await saving;
  await store.save();
  assert.equal(srv.saved.name, 'satu', 'the server does not keep the half-done drag');
  assert.equal(store.conflict, null);
});

test('opening another project while a save is running: its answer does not touch the new project', async () => {
  const srv = setup();
  store.mutate('nama', (P) => { P.name = 'satu'; });
  srv.hold = deferred();
  const saving = store.save();
  await until(() => srv.calls.length === 1);
  const other = newProject({ name: 'lain' });
  other.rev = 7;
  store.setProject(other);
  srv.hold.resolve();
  srv.hold = null;
  await saving;
  assert.equal(store.P.name, 'lain');
  assert.equal(store.baseRev, 7);
  assert.equal(store.dirty, false);
});

test('a real conflict (another device saved) still stops and asks', async () => {
  const srv = setup();
  store.mutate('nama', (P) => { P.name = 'satu'; });
  await store.save();
  srv.rev = 5; // another device saved twice
  store.mutate('nama', (P) => { P.name = 'dua'; });
  await store.save();
  assert.equal(store.saveState, 'conflict');
  assert.deepEqual(store.conflict, { rev: 5, updatedAt: 0 });
});

test('failed saves wait longer each time (5, 10, 20, 40, 60, 60 s) and start over after one succeeds', async () => {
  const srv = setup();
  srv.fail = 6;
  store.mutate('nama', (P) => { P.name = 'satu'; });
  const waits = [];
  const warn = console.warn;
  console.warn = () => {}; // "save failed" is expected here
  try {
    for (let i = 0; i < 6; i++) {
      await store.save();
      assert.equal(store.saveState, 'error');
      waits.push(store.retryMs);
    }
  } finally { console.warn = warn; }
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(store.dirty, true, 'nothing is lost while the server is unreachable');
  await store.save();
  assert.equal(store.saveState, 'saved');
  assert.equal(store.retryMs, 0);
  assert.equal(srv.saved.name, 'satu');
});
