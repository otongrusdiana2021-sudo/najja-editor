// Media renditions made on the server with ffmpeg, so every device edits smoothly:
//   edit.mp4   light 720p H.264 copy (keyframe every 0.5 s) used for the preview: small to download, cheap to
//              decode and draw, fast to seek. Made for every video that is large, high-bitrate or not browser-safe.
//   proxy.mp4  full-quality 1080p H.264 copy of files a browser may not decode (iPhone HEVC .MOV, AVI, 10-bit,
//              ProRes...). Used for export (and preview when there is no edit copy). Made last, at low priority.
//   sprite.jpg / poster.jpg / peaks.bin   timeline filmstrip, library thumbnail and audio waveform, so phones and
//              tablets never decode a whole file just to draw thumbnails.
// The original file stays untouched. Jobs run one at a time (small VPS): previews and thumbnails first, then the
// full-quality copies. Needs ffmpeg + ffprobe on the server (the Docker image ships them). Without them everything
// still works, but files then only play on devices whose browser can decode them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const FFMPEG = process.env.NAJJA_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.NAJJA_FFPROBE || 'ffprobe';
const DISABLED = process.env.NAJJA_PROXY === '0';
const MAX_SIDE = Math.max(480, Number(process.env.NAJJA_PROXY_MAX) || 1920);
// Two threads keep peak memory around 300 MB for a 1080p clip (ffmpeg would otherwise start one per host core).
const THREADS = String(Math.max(1, Math.min(8, Number(process.env.NAJJA_PROXY_THREADS) || 2)));
// The preview copy is what people wait for: it may use up to 4 cores (720p keeps memory low).
const EDIT_SIDE = Math.max(320, Number(process.env.NAJJA_EDIT_MAX) || 1280);
const EDIT_THREADS = String(Math.max(1, Math.min(4, Number(process.env.NAJJA_EDIT_THREADS) || os.cpus()?.length || 2)));
const EDIT_BITRATE = 8e6; // above this a 720p-or-smaller original still gets a light preview copy

const SAFE_CONTAINERS = ['mov', 'mp4', 'matroska', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac'];
const SAFE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const SAFE_PIX = new Set(['yuv420p', 'yuvj420p']);
const SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);
const HDR_TRANSFER = new Set(['arib-std-b67', 'smpte2084']);

function run(cmd, args, { onStdout, timeoutMs = 0, lowPriority = false, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      // Conversions run in the background: let other apps on the VPS go first.
      if (lowPriority) try { os.setPriority(child.pid, 10); } catch { /* not permitted: keep normal priority */ }
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    const chunks = [];
    let err = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.stdout.on('data', (d) => {
      if (binary) { chunks.push(d); return; }
      out += d;
      if (out.length > 4e6) out = out.slice(-2e6);
      onStdout?.(String(d));
    });
    child.stderr.on('data', (d) => { err += d; if (err.length > 64e3) err = err.slice(-32e3); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(binary ? Buffer.concat(chunks) : out);
      else reject(Object.assign(new Error(err.trim().split('\n').slice(-3).join(' ') || `${cmd} exited with ${code}`), { code }));
    });
  });
}

let capsPromise = null;
/** Which tools are installed. Cached for the life of the process. */
export function capabilities() {
  if (!capsPromise) {
    capsPromise = (async () => {
      if (DISABLED) return { ffmpeg: false, reason: 'disabled' };
      try {
        const filters = await run(FFMPEG, ['-hide_banner', '-filters'], { timeoutMs: 15000 });
        await run(FFPROBE, ['-version'], { timeoutMs: 15000 });
        const encoders = await run(FFMPEG, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
        return { ffmpeg: true, x264: /\blibx264\b/.test(encoders), tonemap: /\bzscale\b/.test(filters) && /\btonemap\b/.test(filters) };
      } catch {
        return { ffmpeg: false, reason: 'missing' };
      }
    })();
  }
  return capsPromise;
}

/** Codec facts that decide which renditions are needed. */
export async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-show_entries',
    'format=format_name,duration,bit_rate:stream=index,codec_type,codec_name,pix_fmt,color_transfer,width,height,bit_rate:stream_side_data=rotation',
    '-of', 'json', file], { timeoutMs: 60000 });
  const j = JSON.parse(out || '{}');
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg' && s.codec_name !== 'png');
  const a = streams.find((s) => s.codec_type === 'audio');
  let width = v?.width || 0;
  let height = v?.height || 0;
  const rot = Math.abs(Number(v?.side_data_list?.find((d) => d.rotation != null)?.rotation || 0)) % 180;
  if (rot === 90) [width, height] = [height, width];
  return {
    container: String(j.format?.format_name || ''),
    duration: Number(j.format?.duration) || 0,
    bitrate: Number(v?.bit_rate) || Number(j.format?.bit_rate) || 0,
    video: v ? { codec: v.codec_name, pix: v.pix_fmt, transfer: v.color_transfer || '' } : null,
    audio: a ? { codec: a.codec_name } : null,
    width,
    height,
  };
}

/** Reasons a browser may fail to play this file (empty = it should play everywhere). */
export function proxyReasons(info) {
  const why = [];
  if (!SAFE_CONTAINERS.some((c) => info.container.split(',').includes(c))) why.push(`container ${info.container}`);
  if (info.video) {
    if (!SAFE_VIDEO.has(info.video.codec)) why.push(`video ${info.video.codec}`);
    else if (info.video.pix && !SAFE_PIX.has(info.video.pix)) why.push(`pixel format ${info.video.pix}`);
    if (HDR_TRANSFER.has(info.video.transfer)) why.push('HDR');
  }
  if (info.audio && !SAFE_AUDIO.has(info.audio.codec)) why.push(`audio ${info.audio.codec}`);
  return why;
}

/** Reasons to make a light preview copy (empty = the original is already light enough to edit with). */
export function editReasons(info) {
  if (!info.video) return [];
  const why = [];
  if (proxyReasons(info).length) why.push('codec');
  if (Math.max(info.width, info.height) > EDIT_SIDE) why.push('size');
  if (info.bitrate > EDIT_BITRATE) why.push('bitrate');
  return why;
}

function videoFilters(info, caps, side, fast) {
  const filters = [];
  if (HDR_TRANSFER.has(info.video.transfer) && caps.tonemap) {
    filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  }
  filters.push(`scale=w='if(gte(iw,ih),min(iw,${side}),-2)':h='if(gte(iw,ih),-2,min(ih,${side}))'${fast ? ':flags=bilinear' : ''}`, 'format=yuv420p');
  return filters.join(',');
}
const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
const TAIL = (dest) => ['-movflags', '+faststart', '-max_muxing_queue_size', '2048', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', dest];

/** Full-quality browser-safe copy (export). */
function hiArgs(src, dest, info, caps) {
  const args = ['-hide_banner', '-nostdin', '-y', '-threads', THREADS, '-i', src];
  if (info.video) {
    args.push('-map', '0:v:0', '-vf', videoFilters(info, caps, MAX_SIDE, false),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high',
      // A keyframe every second keeps seeking and timeline scrubbing fast in the editor.
      '-force_key_frames', 'expr:gte(t,n_forced*1)', '-threads', THREADS, '-filter_threads', '1', ...COLOR);
  } else {
    args.push('-vn');
  }
  if (info.audio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  return [...args, ...TAIL(dest)];
}

/** Light preview copy: 720p, fast preset, keyframe every 0.5 s (instant seeks), AAC audio copied when possible. */
function editArgs(src, dest, info, caps) {
  const args = ['-hide_banner', '-nostdin', '-y', '-threads', EDIT_THREADS, '-i', src,
    '-map', '0:v:0', '-vf', videoFilters(info, caps, EDIT_SIDE, true),
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '26', '-profile:v', 'main', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*0.5)', '-threads', EDIT_THREADS, '-filter_threads', '1', ...COLOR];
  if (info.audio) {
    if (info.audio.codec === 'aac') args.push('-map', '0:a:0', '-c:a', 'copy');
    else args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  }
  return [...args, ...TAIL(dest)];
}

/** Audio waveform: one peak per 10 ms, scaled to 0..255 (the format the editor uploads too). */
async function computePeaks(src) {
  const pcm = await run(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-threads', '1', '-i', src, '-vn', '-ac', '1', '-ar', '4000', '-f', 's16le', 'pipe:1'],
    { binary: true, lowPriority: true, timeoutMs: 20 * 60000 });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const n = Math.max(1, Math.ceil(samples.length / 40));
  const peaks = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let s = i * 40, e = Math.min(samples.length, s + 40); s < e; s++) { const v = Math.abs(samples[s]); if (v > m) m = v; }
    peaks[i] = m;
    if (m > max) max = m;
  }
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = max > 0 ? Math.round((peaks[i] / max) * 255) : 0;
  return out;
}

/**
 * Rendition manager for the media library. State files per media id (library/<id>/):
 *   proxy.json   full-quality copy: { state, reasons, error, size, updatedAt, probe }
 *   edit.json    preview copy:      { state, reasons, error, size, updatedAt }
 *   assets.json  { sprite: { n, w, h }, poster: true, peaks: true, updatedAt }
 * state: none (not needed) | pending | running | ready | error | unavailable (no ffmpeg)
 */
export function createProxyManager({ mediaDir, mediaFile, log = () => {} }) {
  const live = new Map(); // `${kind}:${id}` -> progress 0..1
  const deciding = new Map(); // id -> promise of the ensure() call in progress
  const queued = new Set(); // `${kind}:${id}` waiting or running
  const fastQ = [];
  const slowQ = [];
  let pumping = false;
  let current = null; // key of the job running now
  // Metrics per job kind (edit copy, thumbnails/waveform, full-quality copy): queue wait and run time.
  const jobStats = {};
  const statOf = (kind) => (jobStats[kind] ||= { done: 0, failed: 0, wait: [], run: [] });
  const keep = (arr, v) => { arr.push(v); if (arr.length > 200) arr.shift(); };
  const file = (id, name) => path.join(mediaDir(id), name);
  const proxyPath = (id) => file(id, 'proxy.mp4');
  const editPath = (id) => file(id, 'edit.mp4');
  const assetPath = (id, name) => file(id, name);

  async function readJsonFile(f) {
    try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return null; }
  }
  async function writeJsonFile(id, name, st) {
    const dir = mediaDir(id);
    if (!fs.existsSync(dir)) return st; // media was deleted meanwhile
    const f = path.join(dir, name);
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    const rec = { ...st, updatedAt: Date.now() };
    await fsp.writeFile(tmp, JSON.stringify(rec));
    await fsp.rename(tmp, f);
    return rec;
  }
  const readState = (id) => readJsonFile(file(id, 'proxy.json'));
  const writeState = (id, st) => writeJsonFile(id, 'proxy.json', st);
  const readEdit = (id) => readJsonFile(file(id, 'edit.json'));
  const writeEdit = (id, st) => writeJsonFile(id, 'edit.json', st);
  const readAssets = (id) => readJsonFile(file(id, 'assets.json'));

  /** One job at a time: previews and thumbnails before full-quality copies. */
  function schedule(kind, id, fn, { slow = false } = {}) {
    const key = `${kind}:${id}`;
    if (queued.has(key)) return;
    queued.add(key);
    (slow ? slowQ : fastQ).push({ key, fn, at: Date.now() });
    pump();
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (fastQ.length || slowQ.length) {
        const job = (fastQ.length ? fastQ : slowQ).shift();
        const st = statOf(job.key.split(':')[0]);
        const t = Date.now();
        keep(st.wait, t - job.at);
        current = job.key;
        try {
          const out = await job.fn();
          if (out?.state === 'error') st.failed++; // conversions record their error in the state file
          else st.done++;
        } catch (err) { st.failed++; log(`job ${job.key} failed: ${err.message}`); } finally {
          keep(st.run, Date.now() - t);
          current = null;
          queued.delete(job.key);
        }
      }
    } finally {
      pumping = false;
    }
  }

  async function encode(kind, id, info, args, dest) {
    const tmp = `${dest}.tmp`;
    const key = `${kind}:${id}`;
    live.set(key, 0);
    const started = Date.now();
    try {
      const total = info.duration || 0;
      await run(FFMPEG, args(tmp), {
        lowPriority: kind !== 'edit',
        onStdout: (chunk) => {
          const m = /out_time_us=(\d+)/.exec(chunk.split('\n').reverse().find((l) => l.startsWith('out_time_us=')) || '');
          if (m && total > 0) live.set(key, Math.min(0.99, Number(m[1]) / 1e6 / total));
        },
      });
      await fsp.rename(tmp, dest);
      const { size } = await fsp.stat(dest);
      log(`${kind} copy ready for ${id} (${(size / 1048576).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
      return size;
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    } finally {
      live.delete(key);
    }
  }

  async function convertHi(id, info) {
    const caps = await capabilities();
    const src = await mediaFile(id);
    await writeState(id, { state: 'running', reasons: proxyReasons(info), probe: info });
    try {
      const size = await encode('proxy', id, info, (tmp) => hiArgs(src, tmp, info, caps), proxyPath(id));
      return await writeState(id, { state: 'ready', reasons: proxyReasons(info), probe: info, size });
    } catch (err) {
      log(`proxy failed for ${id}: ${err.message}`);
      return writeState(id, { state: 'error', reasons: proxyReasons(info), probe: info, error: String(err.message).slice(0, 300) });
    }
  }

  async function convertEdit(id, info) {
    const caps = await capabilities();
    const src = await mediaFile(id);
    await writeEdit(id, { state: 'running', reasons: editReasons(info) });
    try {
      const size = await encode('edit', id, info, (tmp) => editArgs(src, tmp, info, caps), editPath(id));
      return await writeEdit(id, { state: 'ready', reasons: editReasons(info), size });
    } catch (err) {
      log(`preview copy failed for ${id}: ${err.message}`);
      return writeEdit(id, { state: 'error', reasons: editReasons(info), error: String(err.message).slice(0, 300) });
    }
  }

  /** Filmstrip, poster and waveform, from the light copy when there is one (much faster to decode). */
  async function makeAssets(id, info) {
    const have = (await readAssets(id)) || {};
    const orig = await mediaFile(id);
    const src = fs.existsSync(editPath(id)) ? editPath(id) : orig;
    const out = { ...have };
    const dur = info.duration || 0;
    if (info.video && dur > 0 && info.width && info.height) {
      if (!have.sprite) {
        const n = Math.max(4, Math.min(48, Math.ceil(dur / 1.5)));
        const h = 72;
        const w = Math.max(24, Math.round((info.width / info.height) * h));
        const tmp = `${assetPath(id, 'sprite.jpg')}.tmp.jpg`;
        try {
          await run(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-threads', '2', '-i', src,
            // A rate slightly above n/duration so the last cell is filled too (tile pads missing frames with black).
            '-vf', `fps=${n}/${(dur * (1 - 0.5 / n)).toFixed(3)},scale=${w}:${h},tile=${n}x1`, '-frames:v', '1', '-q:v', '5', tmp], { lowPriority: true, timeoutMs: 10 * 60000 });
          await fsp.rename(tmp, assetPath(id, 'sprite.jpg'));
          out.sprite = { n, w, h };
        } catch (err) { await fsp.rm(tmp, { force: true }).catch(() => {}); log(`sprite failed for ${id}: ${err.message}`); }
      }
      if (!have.poster) {
        const tmp = `${assetPath(id, 'poster.jpg')}.tmp.jpg`;
        try {
          await run(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', String(Math.min(1, dur * 0.1).toFixed(3)), '-i', src,
            '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', tmp], { lowPriority: true, timeoutMs: 120000 });
          await fsp.rename(tmp, assetPath(id, 'poster.jpg'));
          out.poster = true;
        } catch (err) { await fsp.rm(tmp, { force: true }).catch(() => {}); log(`poster failed for ${id}: ${err.message}`); }
      }
    }
    if (info.audio && !fs.existsSync(assetPath(id, 'peaks.bin'))) {
      try {
        await fsp.writeFile(assetPath(id, 'peaks.bin'), await computePeaks(src));
        out.peaks = true;
      } catch (err) { log(`waveform failed for ${id}: ${err.message}`); }
    } else if (fs.existsSync(assetPath(id, 'peaks.bin'))) out.peaks = true;
    return writeJsonFile(id, 'assets.json', out);
  }

  /** The probe stored with the media (probing again would read the file again). */
  async function probeOf(id) {
    const st = await readState(id);
    if (st?.probe && st.probe.bitrate != null) return st.probe;
    return probe(await mediaFile(id));
  }

  async function fullStatus(id) {
    const [st, ed, as] = await Promise.all([readState(id), readEdit(id), readAssets(id)]);
    const hiLive = live.get(`proxy:${id}`);
    const edLive = live.get(`edit:${id}`);
    const out = { ...(st || { state: 'unknown' }) };
    if (hiLive != null) Object.assign(out, { state: 'running', progress: hiLive });
    out.edit = ed ? { ...ed, ...(edLive != null ? { state: 'running', progress: edLive } : {}) } : null;
    out.assets = as;
    return out;
  }

  const api = {
    proxyPath,
    editPath,
    assetPath,
    capabilities,

    /** Current state of all renditions, including live progress. Old media get their renditions planned now. */
    async status(id) {
      const [st, ed, as] = await Promise.all([readState(id), readEdit(id), readAssets(id)]);
      if (!st) return api.ensure(id); // media uploaded before proxies existed: decide now
      const interrupted = (s, kind) => s && (s.state === 'running' || s.state === 'pending') && !queued.has(`${kind}:${id}`);
      // A restart interrupted a job (the queue lives in memory), or this media predates preview copies.
      if (interrupted(st, 'proxy') || interrupted(ed, 'edit') || ((!ed || !as) && !['unavailable', 'unknown'].includes(st.state))) {
        return api.ensure(id, { resume: true });
      }
      // ffmpeg was installed after this media was checked.
      if (st.state === 'unavailable' && (await capabilities()).ffmpeg) return api.ensure(id, { recheck: true });
      return fullStatus(id);
    },
    get queued() { return new Set([...queued].map((k) => k.split(':')[1])); },
    /** Queue wait and run time per job kind (blueprint 9.1 "Backend"). */
    metrics() {
      const pct = (arr) => {
        if (!arr.length) return null;
        const s = [...arr].sort((a, b) => a - b);
        return { n: s.length, p50: s[Math.floor(s.length * 0.5)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
      };
      const out = {};
      for (const kind of new Set([...Object.keys(jobStats), 'edit', 'assets', 'proxy'])) {
        const st = statOf(kind);
        out[kind] = {
          done: st.done, failed: st.failed, wait: pct(st.wait), run: pct(st.run), limit: 1,
          running: current?.startsWith(`${kind}:`) ? 1 : 0,
          queued: [...fastQ, ...slowQ].filter((j) => j.key.startsWith(`${kind}:`)).length,
        };
      }
      return out;
    },

    /**
     * Probe the media and plan its renditions: preview copy + thumbnails now, full-quality copy (only for files a
     * browser may not decode, or always with force) afterwards. Resolves right after deciding (it does not wait).
     * Calls for the same id are serialized so two requests can never start the same job twice.
     */
    ensure(id, opts = {}) {
      const prev = deciding.get(id);
      const next = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() => decide(id, opts));
      const tracked = next.finally(() => { if (deciding.get(id) === tracked) deciding.delete(id); });
      deciding.set(id, tracked);
      return next;
    },
  };

  async function decide(id, { force = false, recheck = false, resume = false } = {}) {
    const caps = await capabilities();
    if (!caps.ffmpeg) {
      const cur = await readState(id);
      if (cur?.state !== 'unavailable') await writeState(id, { state: 'unavailable', error: 'ffmpeg is not installed on the server' });
      return fullStatus(id);
    }
    try { await mediaFile(id); } catch { return { state: 'unknown' }; }
    let info;
    try {
      info = recheck ? await probe(await mediaFile(id)) : await probeOf(id);
    } catch (err) {
      await writeState(id, { state: 'error', error: `ffprobe: ${String(err.message).slice(0, 200)}` });
      return fullStatus(id);
    }
    if (!info.video && !info.audio) {
      await writeState(id, { state: 'error', reasons: proxyReasons(info), probe: info, error: 'No audio or video stream' });
      return fullStatus(id);
    }

    // Preview copy (fast queue).
    const ed = await readEdit(id);
    const needEdit = editReasons(info).length > 0 && caps.x264;
    if (!needEdit) { if (!ed || ed.state !== 'none') await writeEdit(id, { state: 'none', reasons: [] }); }
    else if (!(ed?.state === 'ready' && fs.existsSync(editPath(id))) && !(ed?.state === 'error' && !resume && !recheck)) {
      if (!queued.has(`edit:${id}`)) {
        await writeEdit(id, { state: 'pending', reasons: editReasons(info) });
        schedule('edit', id, () => convertEdit(id, info));
      }
    }

    // Thumbnails + waveform (fast queue, after the preview copy so they can be made from it).
    const as = await readAssets(id);
    if ((!as || (info.video && (!as.sprite || !as.poster)) || (info.audio && !as.peaks)) && !queued.has(`assets:${id}`)) {
      schedule('assets', id, () => makeAssets(id, info));
    }

    // Full-quality copy (slow queue).
    const cur = await readState(id);
    const reasons = proxyReasons(info);
    // Once asked for (force), a copy stays wanted: a later plain check must not cancel it.
    const needHi = force || reasons.length > 0 || ['ready', 'pending', 'running'].includes(cur?.state);
    if (!needHi) {
      if (!cur || cur.state !== 'none' || !cur.probe?.bitrate) await writeState(id, { state: 'none', reasons, probe: info });
    } else if (cur?.state === 'ready' && fs.existsSync(proxyPath(id))) {
      if (!cur.probe || cur.probe.bitrate == null) await writeState(id, { ...cur, probe: info });
    } else if (info.video && !caps.x264) {
      await writeState(id, { state: 'unavailable', reasons, probe: info, error: 'ffmpeg has no libx264 encoder' });
    } else if (!queued.has(`proxy:${id}`) && !(cur?.state === 'error' && !force && !resume && !recheck)) {
      await writeState(id, { state: 'pending', reasons, probe: info });
      schedule('proxy', id, () => convertHi(id, info), { slow: true });
    }
    return fullStatus(id);
  }
  return api;
}
