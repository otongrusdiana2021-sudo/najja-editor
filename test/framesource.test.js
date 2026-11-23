// (v1.14, P2-6) The preview's own video decoding (public/js/framesource.js) and byte reader (public/js/mediabytes.js).
// On an iPad, the <video> elements of the old preview made the timeline wait at cuts (a screen recording: 14 s frozen
// at 00:00 while "playing"). The new preview decodes the frames itself; these tests pin what it must do, with a fake
// VideoDecoder (Node has no WebCodecs) that behaves like the real ones: frames come out a little later, a reset drops
// what is inside, a keyframe is needed after configure and flush, and (Safari) frames may be held until more input.
// Run with: npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FrameSource, VideoFile } from '../public/js/framesource.js';
import { MediaBytes, runsOf } from '../public/js/mediabytes.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000, what = 'condition') {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(2); }
}

// ---- fakes
const live = new Set(); // frames not closed yet
class FakeFrame {
  constructor(ts, dec) { this.timestamp = ts; this.displayWidth = 1280; this.displayHeight = 720; this.dec = dec; live.add(this); if (dec) dec.out++; }
  close() { if (!live.delete(this)) return; if (this.dec) { this.dec.out--; const d = this.dec; setTimeout(() => d.release(), 0); } } // (like a real decoder: output later, never inside close())
}
// hold: frames a decoder keeps until more input (Safari); pool: frames it can have out at once (a hardware decoder's
// output pictures: it gives no more until some are closed)
const opts = { delay: 1, hold: 0, failOn: null, pool: Infinity };
let decoders = [];
class FakeDecoder {
  constructor({ output, error }) { this.output = output; this.error = error; this.state = 'unconfigured'; this.held = []; this.queue = 0; this.gen = 0; this.fed = []; this.out = 0; decoders.push(this); }
  release(all = false) {
    while (this.held.length > (all ? 0 : opts.hold) && this.out < opts.pool && this.state === 'configured') this.output(new FakeFrame(this.held.shift(), this));
  }
  get decodeQueueSize() { return this.queue; }
  configure() { this.state = 'configured'; this.needKey = true; this.gen++; }
  decode(chunk) {
    if (this.state !== 'configured') throw new Error('InvalidStateError: not configured');
    if (this.needKey && chunk.type !== 'key') { this.error(new Error('DataError: a key frame is required')); return; }
    if (opts.failOn != null && chunk.timestamp >= opts.failOn) { this.state = 'closed'; this.error(new Error('EncodingError')); return; }
    this.needKey = false;
    this.fed.push(chunk.timestamp);
    this.queue++;
    const gen = this.gen;
    setTimeout(() => {
      if (gen !== this.gen || this.state !== 'configured') return;
      this.queue--;
      this.held.push(chunk.timestamp);
      this.release();
    }, opts.delay);
  }
  async flush() {
    const gen = this.gen;
    await sleep(opts.delay + 2);
    if (gen !== this.gen) throw new Error('AbortError');
    this.release(true);
    this.needKey = true;
  }
  reset() { this.gen++; this.held = []; this.queue = 0; this.state = 'unconfigured'; }
  close() { this.gen++; this.held = []; this.state = 'closed'; }
}
class FakeChunk { constructor({ type, timestamp, data }) { Object.assign(this, { type, timestamp, byteLength: data.length }); } }
const env = { VideoDecoder: FakeDecoder, EncodedVideoChunk: FakeChunk };

// The light preview copy as the server makes it: 30 fps, a keyframe every 0.5 s, no B-frames (10 s here).
const FPS = 30;
const N = 300;
const samples = Array.from({ length: N }, (_, i) => ({ offset: 48 + i * 1000, size: 1000, key: i % 15 === 0, pts: i / FPS }));
const track = { codec: 'avc1.4d001f', description: new Uint8Array(8), width: 1280, height: 720, samples };
const usOf = (i) => Math.round((i / FPS) * 1e6);
const idxAt = (t) => Math.floor(t * FPS + 1e-6);
const bytes = () => ({ reads: 0, peek(off, len) { this.reads++; return new Uint8Array(len); }, read: async (off, len) => new Uint8Array(len), prefetch() {} });
function source(over = {}) {
  const file = new VideoFile('copy', over.bytes || bytes(), { track, cfg: { codec: track.codec } });
  let frames = 0;
  const D = new FrameSource(file, { env, onFrame: () => { frames++; }, ...over });
  D.events = () => frames;
  return D;
}

beforeEach(() => { opts.delay = 1; opts.hold = 0; opts.failOn = null; opts.pool = Infinity; decoders = []; for (const f of [...live]) f.close(); });

test('paused: the exact frame at the playhead, decoded from the keyframe before it', async () => {
  const D = source();
  D.want(2.6);
  await until(() => D.final(2.6), 3000, 'the frame at 2.6 s');
  assert.equal(D.frame(2.6).timestamp, usOf(78));
  const fed = decoders[0].fed;
  assert.equal(fed[0], usOf(75), 'starts at the keyframe before (2.5 s)');
  assert.ok(fed.length <= 4 + 2, `only what is needed is decoded (${fed.length} samples)`);
  assert.ok(D.events() >= 1, 'the engine is told to redraw');
  await sleep(20);
  assert.ok(live.size <= 3, `few frames kept while paused (${live.size})`);
  D.close();
  assert.equal(live.size, 0, 'close frees every frame');
});

test('the next cut: its first picture is ready before the playhead gets there, then every frame plays on time', async () => {
  const D = source();
  D.want(4.0, { playing: true, ahead: 3 }); // primed 0.6 s before the cut
  await until(() => D.final(4.0), 3000, 'the first frame of the cut');
  assert.equal(D.frame(4.0).timestamp, usOf(120));
  // play 2 s through it at 4× real time (a tick every 8 ms): the picture for the clock's time is always there
  let late = 0;
  for (let k = 0; k <= 60; k++) {
    const t = 4 + k / FPS + 0.004;
    D.want(t, { playing: true });
    const f = D.frame(t);
    if (!f || f.timestamp !== usOf(idxAt(t))) late++;
    await sleep(8);
  }
  assert.equal(late, 0, 'no late or missing pictures');
  assert.ok(live.size <= 10 + 2, `frames kept stay bounded (${live.size})`);
  D.close();
});

test('a jump back restarts at the keyframe before it; the old picture stands in until the new one is out', async () => {
  const D = source();
  D.want(3.0);
  await until(() => D.final(3.0));
  const before = D.frame(3.0);
  D.want(1.1);
  assert.equal(D.frame(1.1), before, 'the last picture stays on screen meanwhile (no black flash)');
  assert.equal(D.final(1.1), false, '…but it is not the frame for 1.1 s');
  assert.equal(D.lag(1.1), Infinity);
  await until(() => D.final(1.1));
  assert.equal(D.frame(1.1).timestamp, usOf(33));
  assert.equal(D.stats.restarts, 2);
  D.close();
});

test('back inside the decoded stretch, to a frame already passed: restarts instead of waiting forever', async () => {
  const D = source();
  D.want(2.0, { playing: true });
  for (let k = 0; k < 20; k++) { const t = 2 + k / FPS; D.want(t, { playing: true }); D.frame(t); await sleep(4); }
  D.want(2.2); // (a scrub back by a few frames)
  await until(() => D.final(2.2), 3000, 'the frame at 2.2 s');
  assert.equal(D.frame(2.2).timestamp, usOf(66));
  D.close();
});

test('a jump forward past a keyframe starts there, not by decoding everything in between', async () => {
  const D = source();
  D.want(1.0);
  await until(() => D.final(1.0));
  D.want(8.1);
  await until(() => D.final(8.1));
  assert.equal(D.frame(8.1).timestamp, usOf(243));
  assert.ok(D.stats.fed < 20, `fed ${D.stats.fed} samples (not the 240 in between)`);
  D.close();
});

test('nothing is decoded far past the end of the stretch', async () => {
  const D = source();
  D.want(2.9, { playing: true, end: 3.0 });
  await until(() => D.final(2.9));
  await sleep(40);
  const last = Math.max(...decoders[0].fed) / 1e6;
  assert.ok(last <= 3.0 + 4 / FPS + 1e-6, `last sample fed at ${last.toFixed(3)} s`);
  D.close();
});

test('a decoder that keeps frames back until more input (Safari) still gives the exact frame and plays on time', async () => {
  opts.hold = 3;
  const D = source();
  D.want(5.2);
  await until(() => D.final(5.2), 3000, 'the paused frame');
  assert.equal(D.frame(5.2).timestamp, usOf(156));
  let late = 0;
  for (let k = 0; k <= 45; k++) {
    const t = 5.2 + k / FPS + 0.004;
    D.want(t, { playing: true });
    const f = D.frame(t);
    if (!f || f.timestamp !== usOf(idxAt(t))) late++;
    await sleep(8);
  }
  assert.ok(late <= 1, `${late} late pictures (one at most, right after play)`);
  D.close();
});

test('a hardware decoder with few output pictures that also keeps frames back (Safari): no stall, no failure', async (t) => {
  // (seen in Safari: keeping more decoded frames than the decoder's pool made it stop, "holds frames until a flush")
  opts.hold = 5; // (more than the 3 samples fed past a stretch's end anyway)
  opts.pool = 8;
  const D = source();
  t.after(() => D.close());
  let late = 0;
  let lateEnd = 0; // the last pictures of a stretch (the decoder keeps them until more input comes)
  for (let cut = 0; cut < 6; cut++) {
    const t0 = 1 + ((cut * 3.7) % 8); // a stretch elsewhere in the 10 s file each time, forward and back (jump cuts)
    D.want(t0, { playing: true, ahead: 3 });
    await until(() => D.final(t0), 3000, `cut ${cut} (queue ${D.queue.length}, pending ${D.pending.size}, out ${decoders[0].out}, held ${decoders[0].held.length}, extra ${D.extra}, failed ${D.failed?.message})`);
    for (let k = 0; k <= 13; k++) {
      const t = t0 + k / FPS + 0.004;
      D.want(t, { playing: true, end: t0 + 14 / FPS });
      const f = D.frame(t);
      if (!f || f.timestamp !== usOf(idxAt(t))) { late++; if (k >= 10) lateEnd++; }
      await sleep(8);
    }
  }
  assert.equal(D.failed, null);
  assert.ok(late <= 6, `${late} late pictures in 6 cuts`);
  assert.equal(lateEnd, 0, 'the end of every stretch plays on time (Safari froze the last ~100 ms before each cut)');
  assert.ok(decoders[0].out <= 8);
  D.close();
});

test('a decoder that gives frames only on a flush: the paused frame still comes (flush, then from a keyframe again)', async () => {
  opts.hold = 1e9;
  const D = source();
  D.want(1.0);
  await until(() => D.final(1.0), 5000, 'the frame after a flush');
  assert.equal(D.frame(1.0).timestamp, usOf(30));
  assert.ok(D.stats.flushes >= 1);
  D.close();
});

test('a decoder error marks the source failed (the engine then uses the video element) and frees its frames', async () => {
  opts.failOn = usOf(20);
  const D = source();
  D.want(0.5, { playing: true });
  await until(() => !!D.failed, 3000, 'the failure');
  assert.ok(D.events() >= 1, 'the engine hears about it');
  assert.equal(D.frame(0.5), null);
  assert.equal(live.size, 0);
});

test('bytes not here yet (streaming): the source says it waits for the network', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { peek: () => null, read: async (o, n) => { await gate; return new Uint8Array(n); }, prefetch() {} };
  const D = source({ bytes: slow });
  D.want(1.0);
  await until(() => D.waitingBytes, 1000, 'a read');
  assert.equal(D.final(1.0), false);
  release();
  await until(() => D.final(1.0), 3000);
  assert.equal(D.waitingBytes, false);
  D.close();
});

test('scrubbing faster than the network brings bytes: the picture still follows the finger', async () => {
  // (iPad, light copy still streamed from the server: a scrub moving faster than 1 MB windows arrive restarted the
  // decoder at every position, so no picture was ever decoded until the finger stopped — the preview stood still)
  const N2 = 1800; // 60 s at 30 fps, ~8 KB a frame like the 720p light copy: a 1 MB window holds ~4 s
  const long = { ...track, samples: Array.from({ length: N2 }, (_, i) => ({ offset: 48 + i * 8000, size: 8000, key: i % 15 === 0, pts: i / FPS })) };
  const WIN = 1 << 20;
  const loaded = new Set();
  const inflight = new Map();
  const net = {
    peek(off, len) { return loaded.has(Math.floor(off / WIN)) && loaded.has(Math.floor((off + len - 1) / WIN)) ? new Uint8Array(len) : null; },
    read(off, len) {
      const ws = [Math.floor(off / WIN), Math.floor((off + len - 1) / WIN)];
      return Promise.all(ws.map((w) => {
        if (loaded.has(w)) return null;
        if (!inflight.has(w)) inflight.set(w, sleep(250).then(() => { loaded.add(w); inflight.delete(w); })); // 250 ms a window (Wi-Fi)
        return inflight.get(w);
      })).then(() => new Uint8Array(len));
    },
    prefetch() {},
  };
  for (const dir of [1, -1]) {
    loaded.clear();
    const file = new VideoFile('copy', net, { track: long, cfg: { codec: track.codec } });
    const D = new FrameSource(file, { env });
    const a = dir > 0 ? 2 : 50;
    D.want(a);
    await until(() => D.final(a), 3000);
    const first = D.frame(a).timestamp;
    const shown = new Set(); // different pictures on screen while the finger moves (the first one not counted)
    for (let k = 1; k <= 90; k++) { // 1.5 s of a fast scrub: 0.5 s of video every 16 ms (45 s in all)
      const t = a + dir * k * 0.5;
      D.want(t);
      const f = D.frame(t);
      if (f && f.timestamp !== first) shown.add(f.timestamp);
      await sleep(16);
    }
    assert.ok(shown.size >= 4, `${dir > 0 ? 'forward' : 'back'}: only ${shown.size} new pictures in 1.5 s of scrubbing`);
    const end = a + dir * 45;
    await until(() => D.final(end), 4000, 'the exact frame once the finger stops');
    assert.equal(D.frame(end).timestamp, usOf(Math.round(end * FPS)));
    D.close();
  }
});

// ---- byte reader
const FILE = Uint8Array.from({ length: 3 * (1 << 20) + 500 }, (_, i) => (i * 7) % 251);
function server(log, { range = true } = {}) {
  return async (url, init) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range || '');
    log.push(m ? [Number(m[1]), Number(m[2])] : 'whole');
    if (!range || !m) return new Response(FILE.slice(), { status: 200 });
    const a = Number(m[1]);
    const z = Math.min(FILE.length - 1, Number(m[2]));
    return new Response(FILE.slice(a, z + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${z}/${FILE.length}` } });
  };
}

test('server copy: a lone read fetches a little ahead (64 KB), and that serves the reads next to it', async () => {
  const log = [];
  const b = MediaBytes.fromUrl('/m/1/edit?v=1', { fetch: server(log) });
  assert.deepEqual(await b.read(100, 50), FILE.slice(100, 150));
  assert.deepEqual(await b.read(5000, 10), FILE.slice(5000, 5010));
  assert.equal(log.length, 1, 'one request');
  assert.equal(b.size, FILE.length, 'size from Content-Range');
  const off = (1 << 20) - 10;
  assert.deepEqual(await b.read(off, 30), FILE.slice(off, off + 30), 'a read across two windows');
  assert.equal(log.length, 2);
  assert.deepEqual(b.peek(150, 10), FILE.slice(150, 160), 'in memory: no wait');
  assert.equal(b.remote(3 << 20, 10), true, 'not here yet');
});

test('a range announced is fetched exactly, in one request — not the whole window around it', async () => {
  // (a cut needs ~150 KB; the first version fetched 1 MB windows: 6× too much on a timeline of jump cuts)
  const log = [];
  const b = MediaBytes.fromUrl('/m/1/edit?v=1', { fetch: server(log) });
  b.prefetch(1_000_000, 150_000, { high: true });
  await b.ensure(1_000_000, 1_150_000);
  assert.deepEqual(log, [[1_000_000, 1_149_999]], 'one request for exactly that range');
  for (let off = 1_000_000; off < 1_150_000; off += 8000) assert.deepEqual(b.peek(off, 100), FILE.slice(off, off + 100));
  assert.equal(b.stats.bytes, 150_000);
  // a second range overlapping it: only the missing part is asked for (a short one with the 64 KB read-ahead)
  await b.ensure(1_100_000, 1_200_000);
  assert.equal(log[1][0], 1_150_000);
  assert.ok(log[1][1] < 1_150_000 + 65_536, `ends at ${log[1][1]}`);
});

test('the sound\'s own bytes: its runs between the video\'s are fetched without the video around them', async () => {
  const log = [];
  const b = MediaBytes.fromUrl('/m/1/edit?v=1', { fetch: server(log) });
  // audio samples in runs of 4 × 2000 bytes, every 100 000 bytes (the video's runs in between)
  const audio = [];
  for (let r = 0; r < 8; r++) for (let k = 0; k < 4; k++) audio.push({ offset: 50_000 + r * 100_000 + k * 2000, size: 2000 });
  const runs = runsOf(audio);
  assert.equal(runs.length, 8);
  await Promise.all(runs.map((x) => b.ensure(x.a, x.z, { exact: true })));
  assert.equal(b.stats.bytes, 8 * 8000, 'only the sound: 64 KB, not the 750 KB of video between');
  for (const x of audio) assert.deepEqual(await b.read(x.offset, x.size), FILE.slice(x.offset, x.offset + x.size));
  assert.equal(log.length, 8);
});

test('the device copy arrives: the same reader reads it from then on, without the network', async () => {
  const log = [];
  const b = MediaBytes.fromUrl('/m/1/edit?v=1', { fetch: server(log) });
  await b.read(0, 10);
  b.useBlob(new Blob([FILE]));
  assert.deepEqual(await b.read(2 << 20, 100), FILE.slice(2 << 20, (2 << 20) + 100));
  assert.equal(log.length, 1);
  assert.equal(b.remote(2 << 20, 10), false);
});

test('a server that ignores Range (200): the whole file is kept once and read like a device copy', async () => {
  const log = [];
  const b = MediaBytes.fromUrl('/m/1/file', { fetch: server(log, { range: false }) });
  assert.deepEqual(await b.read(10, 10), FILE.slice(10, 20));
  assert.deepEqual(await b.read(3 << 20, 100), FILE.slice(3 << 20, (3 << 20) + 100));
  assert.equal(log.length, 1);
});

test('moov is found by walking the top-level boxes, also after the media data', async () => {
  const box = (type, n) => { const u = new Uint8Array(n); new DataView(u.buffer).setUint32(0, n); u.set([...type].map((c) => c.charCodeAt(0)), 4); return u; };
  const parts = [box('ftyp', 24), box('mdat', 2_500_000), box('moov', 300)];
  const file = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { file.set(p, o); o += p.length; }
  const b = MediaBytes.fromBlob(new Blob([file]));
  const moov = new Uint8Array(await b.moov());
  assert.equal(moov.length, 300);
  assert.equal(String.fromCharCode(...moov.slice(4, 8)), 'moov');
});
