// Export reads sources in pieces (v1.7 P4): the moov box is found by walking top-level boxes (also when it is at the
// end of the file), and demuxing only the moov gives exactly the samples of demuxing the whole file.
// Needs ffmpeg (skipped without it). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ByteSource, demuxVideo, demuxAudio } from '../public/js/fastexport.js';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-export-read-'));
const make = (name, extra = []) => {
  const f = path.join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=44100:d=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', ...extra, f]);
  return f;
};
const blobOf = (f) => new Blob([fs.readFileSync(f)]);

test('moov found at the start (faststart) and at the end; same samples as the whole-file demux', { skip: !hasFfmpeg }, async () => {
  for (const f of [make('fast.mp4', ['-movflags', '+faststart']), make('tail.mp4')]) {
    const whole = fs.readFileSync(f);
    const buf = whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength);
    const src = new ByteSource(blobOf(f), 4096); // tiny window: many window loads
    const moov = await src.moov();
    assert.ok(moov.byteLength < whole.length / 4, 'only the moov box is read whole');
    const a = demuxVideo(moov);
    const b = demuxVideo(buf);
    assert.equal(a.codec, b.codec);
    assert.deepEqual([a.width, a.height], [320, 240]);
    assert.equal(a.samples.length, 90);
    assert.deepEqual(a.samples, b.samples);
    assert.ok(a.samples.filter((s) => s.key).length >= 6, 'keyframes every 15 frames');
    // windowed reads return the same bytes as the file
    for (const s of [a.samples[0], a.samples[45], a.samples[89]]) {
      assert.deepEqual(Buffer.from(await src.read(s.offset, s.size)), whole.subarray(s.offset, s.offset + s.size));
    }
    const au = demuxAudio(moov);
    assert.match(au.codec, /^mp4a\.40\.2$/);
    assert.equal(au.sampleRate, 44100);
    assert.equal(au.channels, 1);
    assert.ok(au.description?.length >= 2, 'AudioSpecificConfig');
    assert.deepEqual(demuxAudio(buf).samples, au.samples);
    const last = au.samples.at(-1);
    assert.ok(last.pts > 2.8 && last.pts < 3.1, `audio ends near 3 s (${last.pts})`);
    assert.ok(au.samples[0].pts >= -0.05 && au.samples[0].pts < 0.05, 'priming removed by the edit list');
  }
});

test('files without the track the export needs are reported as unsupported (→ real-time fallback)', { skip: !hasFfmpeg }, async () => {
  const f = path.join(dir, 'silent.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
  const moov = await new ByteSource(blobOf(f)).moov();
  assert.throws(() => demuxAudio(moov), /no audio track/);
  await assert.rejects(new ByteSource(new Blob([new Uint8Array(64)])).moov(), /no moov/);
});
