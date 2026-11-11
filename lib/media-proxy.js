// Playback proxies: browser-safe H.264/AAC copies of media the browser may not decode (iPhone HEVC .MOV,
// AVI, 10-bit video, ProRes...). The original file stays untouched; the editor plays and exports the proxy.
// Needs ffmpeg + ffprobe on the server (the Docker image ships them). Without them everything still works,
// but such files only play on devices whose browser can decode them.
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

const SAFE_CONTAINERS = ['mov', 'mp4', 'matroska', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac'];
const SAFE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const SAFE_PIX = new Set(['yuv420p', 'yuvj420p']);
const SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);
const HDR_TRANSFER = new Set(['arib-std-b67', 'smpte2084']);

function run(cmd, args, { onStdout, timeoutMs = 0, lowPriority = false } = {}) {
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
    let err = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.stdout.on('data', (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); onStdout?.(String(d)); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 64e3) err = err.slice(-32e3); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(out);
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

/** Codec facts that decide whether a proxy is needed. */
export async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-show_entries',
    'format=format_name,duration:stream=index,codec_type,codec_name,pix_fmt,color_transfer,width,height:stream_side_data=rotation',
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

function ffmpegArgs(src, dest, info, caps) {
  const args = ['-hide_banner', '-nostdin', '-y', '-threads', THREADS, '-i', src];
  if (info.video) {
    const filters = [];
    if (HDR_TRANSFER.has(info.video.transfer) && caps.tonemap) {
      filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
    }
    filters.push(`scale=w='if(gte(iw,ih),min(iw,${MAX_SIDE}),-2)':h='if(gte(iw,ih),-2,min(ih,${MAX_SIDE}))'`, 'format=yuv420p');
    args.push('-map', '0:v:0', '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high',
      // A keyframe every second keeps seeking and timeline scrubbing fast in the editor.
      '-force_key_frames', 'expr:gte(t,n_forced*1)', '-threads', THREADS, '-filter_threads', '1',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  } else {
    args.push('-vn');
  }
  if (info.audio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  args.push('-movflags', '+faststart', '-max_muxing_queue_size', '2048', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', dest);
  return args;
}

/**
 * Proxy manager for the media library.
 * State per media id lives in library/<id>/proxy.json: { state, reasons, error, size, updatedAt, probe }.
 * state: none (not needed) | pending | running | ready | error | unavailable (no ffmpeg)
 */
export function createProxyManager({ mediaDir, mediaFile, log = () => {} }) {
  const live = new Map(); // id -> { progress }
  const deciding = new Map(); // id -> promise of the ensure() call in progress
  let queue = Promise.resolve();
  const stateFile = (id) => path.join(mediaDir(id), 'proxy.json');
  const proxyPath = (id) => path.join(mediaDir(id), 'proxy.mp4');

  async function readState(id) {
    try { return JSON.parse(await fsp.readFile(stateFile(id), 'utf8')); } catch { return null; }
  }
  async function writeState(id, st) {
    const dir = mediaDir(id);
    if (!fs.existsSync(dir)) return st; // media was deleted meanwhile
    const file = stateFile(id);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const rec = { ...st, updatedAt: Date.now() };
    await fsp.writeFile(tmp, JSON.stringify(rec));
    await fsp.rename(tmp, file);
    return rec;
  }

  async function convert(id, info) {
    const caps = await capabilities();
    const src = await mediaFile(id);
    const dest = proxyPath(id);
    const tmp = `${dest}.tmp`;
    live.set(id, { progress: 0 });
    await writeState(id, { state: 'running', reasons: proxyReasons(info), probe: info });
    const started = Date.now();
    try {
      const total = info.duration || 0;
      await run(FFMPEG, ffmpegArgs(src, tmp, info, caps), {
        lowPriority: true,
        onStdout: (chunk) => {
          const m = /out_time_us=(\d+)/.exec(chunk.split('\n').reverse().find((l) => l.startsWith('out_time_us=')) || '');
          if (m && total > 0) live.set(id, { progress: Math.min(0.99, Number(m[1]) / 1e6 / total) });
        },
      });
      await fsp.rename(tmp, dest);
      const { size } = await fsp.stat(dest);
      log(`proxy ready for ${id} (${(size / 1048576).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
      return await writeState(id, { state: 'ready', reasons: proxyReasons(info), probe: info, size });
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      log(`proxy failed for ${id}: ${err.message}`);
      return await writeState(id, { state: 'error', reasons: proxyReasons(info), probe: info, error: String(err.message).slice(0, 300) });
    } finally {
      live.delete(id);
    }
  }

  const api = {
    proxyPath,
    capabilities,

    /** Current proxy state, including live progress while converting. */
    async status(id) {
      const st = await readState(id);
      const l = live.get(id);
      if (l) return { ...(st || {}), state: 'running', progress: l.progress };
      if (!st) return api.ensure(id); // media uploaded before proxies existed: decide now
      // A restart interrupted the job (the queue lives in memory): start it again.
      if ((st.state === 'running' || st.state === 'pending') && !api.queued.has(id)) return api.ensure(id, { force: true });
      // ffmpeg was installed after this media was checked.
      if (st.state === 'unavailable' && (await capabilities()).ffmpeg) return api.ensure(id, { recheck: true });
      return st;
    },
    queued: new Set(),

    /**
     * Probe the media and queue a proxy when the browser may not play it (or always with force).
     * Resolves with the state right after deciding (it does not wait for the conversion).
     * Calls for the same id are serialized so two requests can never start two conversions.
     */
    ensure(id, opts = {}) {
      const prev = deciding.get(id);
      const next = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() => decide(id, opts));
      const tracked = next.finally(() => { if (deciding.get(id) === tracked) deciding.delete(id); });
      deciding.set(id, tracked);
      return next;
    },
  };

  async function decide(id, { force = false, recheck = false } = {}) {
    const cur = await readState(id);
    if (!force && !recheck && cur && cur.state !== 'unknown') return cur;
    if (force && cur?.state === 'ready' && fs.existsSync(proxyPath(id))) return cur;
    if (api.queued.has(id)) return { ...(cur || {}), state: live.has(id) ? 'running' : 'pending', progress: live.get(id)?.progress || 0 };
    const caps = await capabilities();
    if (!caps.ffmpeg) return writeState(id, { state: 'unavailable', error: 'ffmpeg is not installed on the server' });
    let file;
    try { file = await mediaFile(id); } catch { return { state: 'unknown' }; }
    let info;
    try {
      info = await probe(file);
    } catch (err) {
      return writeState(id, { state: 'error', error: `ffprobe: ${String(err.message).slice(0, 200)}` });
    }
    const reasons = proxyReasons(info);
    if (!force && !reasons.length) return writeState(id, { state: 'none', reasons, probe: info });
    if (!info.video && !info.audio) return writeState(id, { state: 'error', reasons, probe: info, error: 'No audio or video stream' });
    if (info.video && !caps.x264) return writeState(id, { state: 'unavailable', reasons, probe: info, error: 'ffmpeg has no libx264 encoder' });
    api.queued.add(id);
    const pending = await writeState(id, { state: 'pending', reasons, probe: info });
    queue = queue.then(() => convert(id, info)).catch(() => {}).finally(() => api.queued.delete(id));
    return pending;
  }
  return api;
}
