// (v1.13.2) Device cache (public/js/devicecache.js): a video copy downloaded to this device must end up usable.
// Found on an iPad (2026-11-23): downloads pause while the preview streams, and a pause that came right after the
// last chunk left every byte on disk but the entry never complete; the next try asked the server for bytes past the
// end (416), gave up, and the iPad kept streaming over Wi-Fi. The browser's file storage (OPFS) is faked in memory.
// Run with: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeFile {
  constructor() { this.kind = 'file'; this.data = new Uint8Array(0); }
  async getFile() { return new Blob([this.data]); }
  async createWritable() {
    const parts = [];
    return {
      write: async (d) => { parts.push(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)); },
      close: async () => { this.data = new Uint8Array(await new Blob(parts).arrayBuffer()); },
    };
  }
}
class FakeDir {
  constructor() { this.kind = 'directory'; this.items = new Map(); }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.items.has(name)) { if (!create) throw new Error('NotFound'); this.items.set(name, new FakeDir()); }
    return this.items.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.items.has(name)) { if (!create) throw new Error('NotFound'); this.items.set(name, new FakeFile()); }
    return this.items.get(name);
  }
  async *entries() { yield* this.items.entries(); }
  async removeEntry(name) { this.items.delete(name); }
}

let opfs;
globalThis.FileSystemFileHandle = FakeFile;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => opfs, persist: async () => true } } });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
opfs = new FakeDir();
const { deviceCache } = await import('../public/js/devicecache.js');

const VIDEO = new Uint8Array(300_000).map((_, i) => i % 251);
/** The server's copy, with Range like the real one; `chunks` splits the body the way a network read would. */
function server(log, chunks = 1) {
  return async (off) => {
    log.push(off);
    if (off >= VIDEO.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${VIDEO.length}` } });
    const body = VIDEO.slice(off);
    const step = Math.ceil(body.length / chunks);
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < body.length; i += step) c.enqueue(body.slice(i, i + step)); c.close(); } });
    const headers = off ? { 'content-range': `bytes ${off}-${VIDEO.length - 1}/${VIDEO.length}`, 'content-length': String(body.length) } : { 'content-length': String(VIDEO.length) };
    return new Response(stream, { status: off ? 206 : 200, headers: { 'content-type': 'video/mp4', ...headers } });
  };
}
const bytesOf = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const entry = async (key) => (await deviceCache.list()).find((e) => e.key === key);
const media = () => opfs.items.get('najja-media'); // (the cache's own folder)
const hooks = (over) => ({ id: 'm_1', name: 'tas.mp4', stillWanted: () => true, protect: new Set(), waitResume: async () => {}, shouldPause: () => false, ...over });

beforeEach(() => { media()?.items.clear(); });

test('a download paused right after its last chunk is complete, and is not asked for again', async () => {
  const log = [];
  let playing = false;
  const url = await deviceCache.download('m_1_e1', hooks({
    fetchFrom: server(log),
    onProgress: (p) => { if (p >= 1) playing = true; }, // the preview started streaming just as the last chunk came in
    shouldPause: () => playing,
    waitResume: async () => { playing = false; },
  }));
  assert.ok(url, 'the copy is ready to play from this device');
  assert.deepEqual(log, [0], 'one download, no request past the end (416)');
  assert.equal((await entry('m_1_e1')).complete, true);
  assert.deepEqual(await bytesOf(url), VIDEO);
});

test('an entry that already holds every byte but was never marked complete is finished without the network', async () => {
  // (devices that met the bug above before the fix: their copy is whole on disk, as two segment files)
  await deviceCache.available();
  const dir = await media().getDirectoryHandle('m_1_e1', { create: true });
  for (const [name, part] of [['000000', VIDEO.slice(0, 200_000)], ['000001', VIDEO.slice(200_000)]]) {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(part);
    await w.close();
  }
  const w = await (await dir.getFileHandle('meta.json', { create: true })).createWritable();
  await w.write(JSON.stringify({ id: 'm_1', name: 'tas.mp4', key: 'm_1_e1', size: VIDEO.length, type: 'video/mp4', complete: false, created: 1, lastUsed: 1 }));
  await w.close();
  assert.deepEqual(await entry('m_1_e1').then((e) => [e.size, e.complete]), [VIDEO.length, false], '(set-up: every byte, not complete)');

  const log = [];
  const url = await deviceCache.download('m_1_e1', hooks({ fetchFrom: server(log) }));
  assert.ok(url);
  assert.deepEqual(log, [], 'nothing asked from the server');
  assert.equal((await entry('m_1_e1')).complete, true);
  assert.deepEqual(await bytesOf(url), VIDEO);
});

test('a download paused in the middle still resumes where it stopped (Range), then completes', async () => {
  const log = [];
  let reads = 0;
  let paused = false;
  const url = await deviceCache.download('m_1_e1', hooks({
    fetchFrom: server(log, 3),
    onProgress: () => { reads++; },
    shouldPause: () => { if (reads === 1 && !paused) { paused = true; return true; } return false; },
  }));
  assert.ok(url);
  assert.deepEqual(log, [0, 100_000], 'resumed from the first chunk with a Range request');
  assert.deepEqual(await bytesOf(url), VIDEO);
});
