// The server's background removal of a video part (lib/ai.js, tool "cutoutvideo") with a stand-in AI service:
// the request's record stays right while its job runs (v1.11: the job's own write dropped the job id, so the request
// read as "failed" until it was done — and the editor stopped waiting). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAi } from '../lib/ai.js';

// A job queue that starts a job at once, before the one who queued it hears back (the order that lost the job id).
function eagerJobs() {
  const handlers = new Map();
  const all = new Map();
  return {
    register(kind, h) { handlers.set(kind, h); },
    async enqueue({ kind, key, data, owner }) {
      const job = { id: `j_${all.size + 1}`, key, kind, data, owner, state: 'running', progress: 0, attempts: 1 };
      all.set(job.id, job);
      job.done = handlers.get(kind).run(job, { signal: new AbortController().signal, progress: (p) => { job.progress = p; } })
        .then(() => { job.state = 'succeeded'; }, (err) => { job.state = 'failed'; job.error = err.message; });
      await sleep(20); // (the job has read the request's record by now)
      return job;
    },
    get: (id) => all.get(id),
    active: (key) => [...all.values()].find((j) => j.key === key && j.state === 'running') || null,
    cancel: async () => {},
    idle: () => Promise.all([...all.values()].map((j) => j.done)),
  };
}

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a video request reads "running" all the time its job runs, then "done" with its masks', { skip: !hasFfmpeg && 'ffmpeg missing' }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-aivideo-'));
  const video = path.join(data, 'v.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x284:r=30:d=1', '-pix_fmt', 'yuv420p', video]);
  // the stand-in AI service: the model is there; a run reports a few frames, writes the masks, says done
  const svc = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, cutoutModel: 'cutout', models: { cutout: { state: 'ready' } } })); return; }
    if (req.url === '/run') {
      let body = '';
      for await (const c of req) body += c;
      const { output } = JSON.parse(body);
      res.setHeader('content-type', 'application/x-ndjson');
      for (let i = 1; i <= 5; i++) { res.write(`${JSON.stringify({ progress: i / 5, stage: `frame ${i}/5 · ${5 - i}` })}\n`); await sleep(60); }
      const out = path.join(data, 'ai', `${output}.bin.gz`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.alloc(10));
      res.end(`${JSON.stringify({ done: { file: path.basename(out), frames: 5, width: 4, height: 8, model: 'cutout', ms: 1 } })}\n`);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => svc.listen(0, '127.0.0.1', r));
  const jobs = eagerJobs();
  const ai = createAi({ dataDir: data, jobs, env: { NAJJA_AI_URL: `http://127.0.0.1:${svc.address().port}` } });
  try {
    const rec = await ai.createVideo({ owner: 'u1', file: video, mediaId: 'm_1', start: 0, end: 1, fps: 12 });
    assert.equal(rec.state === 'failed', false, 'not failed when created');
    assert.equal(rec.video.fps, 12, 'any fps from 4 to 30 is taken as asked (the editor keeps clips within a frame budget)');
    const seen = [];
    let last = null;
    for (let t = Date.now(); Date.now() - t < 30000; await sleep(5)) {
      last = await ai.get(rec.id, () => true);
      seen.push(last.state);
      if (last.state === 'done' || last.state === 'failed') break;
    }
    assert.ok(!seen.includes('failed'), `never "failed" while running (seen: ${[...new Set(seen)].join(', ')})`);
    assert.equal(last.state, 'done');
    assert.equal(last.masks?.n, 5, JSON.stringify(last).slice(0, 600));
    assert.ok(fs.existsSync(path.join(data, 'masks', `${rec.id}.bin.gz`)), 'the masks are kept with the projects');
    const meta = JSON.parse(fs.readFileSync(path.join(data, 'ai', rec.id, 'meta.json'), 'utf8'));
    assert.ok(meta.jobId && meta.video.frames >= 1 && meta.result, 'the record keeps its job id, frame count and result');
    assert.equal(fs.readdirSync(path.join(data, 'ai', rec.id)).filter((f) => f.endsWith('.tmp')).length, 0, 'no leftover temporary files');
  } finally {
    svc.close();
    await jobs.idle();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
