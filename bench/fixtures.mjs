// Benchmark fixtures B0–B3 (blueprint 9.2), made with ffmpeg so every run uses the same files.
// usage: node bench/fixtures.mjs [outDir=bench/.fixtures] [--long-minutes=10]
// B4 (device switch) and B5 (concurrent imports) reuse these files (see bench/run.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'bench', '.fixtures'));
const longMin = Number((args.find((a) => a.startsWith('--long-minutes=')) || '').split('=')[1] || 10);
fs.mkdirSync(out, { recursive: true });

const ff = (name, inputs, codec) => {
  const dest = path.join(out, name);
  if (fs.existsSync(dest)) { console.log(`ada   ${name}`); return dest; }
  const t = Date.now();
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, ...codec, `${dest}.tmp.${path.extname(name).slice(1)}`]);
  fs.renameSync(`${dest}.tmp.${path.extname(name).slice(1)}`, dest);
  console.log(`buat  ${name} (${(fs.statSync(dest).size / 1048576).toFixed(1)} MB, ${((Date.now() - t) / 1000).toFixed(1)} dtk)`);
  return dest;
};
// Camera-like H.264: High profile, 1 s GOP, constant ~bitrate (filler keeps the file size realistic).
const h264 = (mbps, fps = 30) => ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', String(fps), '-b:v', `${mbps}M`, '-maxrate', `${mbps}M`, '-bufsize', `${mbps * 2}M`, '-x264-params', 'nal-hrd=cbr', '-movflags', '+faststart'];
const aac = ['-c:a', 'aac', '-b:a', '128k'];
const video = (w, h, secs, hue = 0, fps = 30) => ['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=${fps}:d=${secs},hue=h=${hue}`];
const tone = (secs, f = 440) => ['-f', 'lavfi', '-i', `sine=f=${f}:sample_rate=48000:d=${secs}`];

const files = {};
// B0 — single clip: 1 video 1080p 30 fps 60 s with audio + 1 music track.
files.b0 = ff('b0-1080p30-60s.mp4', [...video(1920, 1080, 60), ...tone(60)], [...h264(12), ...aac, '-shortest']);
files.music = ff('music-60s.m4a', tone(60, 330), aac);
// B1 — social short 9:16: 6 clips of 5–9 s (+ text, music, filter added by the runner).
files.b1 = [5, 7, 6, 9, 5, 8].map((d, i) => ff(`b1-clip${i + 1}-1080x1920.mp4`, [...video(1080, 1920, d, i * 50), ...tone(d, 300 + i * 40)], [...h264(10), ...aac, '-shortest']));
// B2 — layered: 3 main clips 1080p + 2 overlay clips 720p.
files.b2 = [12, 10, 12].map((d, i) => ff(`b2-main${i + 1}-1080p.mp4`, [...video(1920, 1080, d, 120 + i * 60), ...tone(d, 500 + i * 30)], [...h264(12), ...aac, '-shortest']));
files.b2o = [8, 8].map((d, i) => ff(`b2-overlay${i + 1}-720p.mp4`, video(1280, 720, d, 200 + i * 70), h264(6)));
// B3 — long form: one long 1080p recording + 2 audio tracks of the same length.
files.b3 = ff(`b3-long-${longMin}m-1080p.mp4`, [...video(1920, 1080, longMin * 60, 30), ...tone(longMin * 60, 220)], [...h264(6), ...aac, '-shortest']);
files.b3a = [ff(`b3-audio1-${longMin}m.m4a`, tone(longMin * 60, 262), aac), ff(`b3-audio2-${longMin}m.m4a`, tone(longMin * 60, 392), aac)];
// B7 — a heavy camera original (4K 60 fps): decoding it can be slower than real time on a tablet.
files.b7 = ff('b7-4k60-20s.mp4', [...video(3840, 2160, 20, 90, 60), ...tone(20, 350)], [...h264(40, 60), ...aac, '-shortest']);
fs.writeFileSync(path.join(out, 'fixtures.json'), JSON.stringify({ longMinutes: longMin, files }, null, 2));
console.log(`fixture siap di ${out}`);
