// Fast export: renders the timeline frame by frame as fast as the device allows (not in real time) with
// WebCodecs — source video decoded by VideoDecoder, frames composed by the normal renderer, encoded to
// H.264 by VideoEncoder (hardware when available), audio mixed offline and encoded to AAC (or Opus),
// then written into an MP4 file. Anything it cannot handle throws `unsupported`, and the exporter falls
// back to the real-time recorder.
import { store } from './store.js';
import { mediaRT } from './media.js';
import { renderFrame } from './render.js';

export class Unsupported extends Error {}
const unsupported = (why) => new Unsupported(why);

export function fastExportAvailable() {
  return typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function' && typeof VideoFrame === 'function'
    && typeof EncodedVideoChunk === 'function' && typeof OfflineAudioContext === 'function';
}

// ---------------------------------------------------------------------------------------------
// MP4 / MOV demuxer (just enough to feed VideoDecoder: H.264 sample tables)
const fourcc = (dv, p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
function readBoxes(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type: fourcc(dv, p + 4), start: p, data: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const kid = (dv, box, type) => box && readBoxes(dv, box.data, box.end).find((b) => b.type === type);
const hex2 = (n) => n.toString(16).padStart(2, '0');
/** Copy of an ArrayBuffer / view as a standalone Uint8Array. */
const toU8 = (d) => (d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)));

/** First H.264 video track of an MP4/MOV file: decoder config + samples in decode order with presentation times. */
export function demuxVideo(buf) {
  const dv = new DataView(buf);
  const moov = readBoxes(dv, 0, buf.byteLength).find((b) => b.type === 'moov');
  if (!moov) throw unsupported('no moov box');
  const mvhd = kid(dv, moov, 'mvhd');
  const movieScale = mvhd ? (dv.getUint8(mvhd.data) ? dv.getUint32(mvhd.data + 20) : dv.getUint32(mvhd.data + 12)) : 1000;
  for (const trak of readBoxes(dv, moov.data, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = kid(dv, trak, 'mdia');
    const hdlr = kid(dv, mdia, 'hdlr');
    if (!hdlr || fourcc(dv, hdlr.data + 8) !== 'vide') continue;
    const tkhd = kid(dv, trak, 'tkhd');
    const m0 = tkhd.data + (dv.getUint8(tkhd.data) ? 52 : 40);
    const ident = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
    if (ident.some((v, i) => dv.getInt32(m0 + i * 4) !== v)) throw unsupported('rotated video');
    const mdhd = kid(dv, mdia, 'mdhd');
    const scale = dv.getUint8(mdhd.data) ? dv.getUint32(mdhd.data + 20) : dv.getUint32(mdhd.data + 12);
    const stbl = kid(dv, kid(dv, mdia, 'minf'), 'stbl');
    const stsd = kid(dv, stbl, 'stsd');
    const entry = readBoxes(dv, stsd.data + 8, stsd.end)[0];
    if (!entry || (entry.type !== 'avc1' && entry.type !== 'avc3')) throw unsupported(`video codec ${entry?.type}`);
    const avcC = readBoxes(dv, entry.data + 78, entry.end).find((b) => b.type === 'avcC');
    if (!avcC) throw unsupported('no avcC');
    const description = new Uint8Array(buf.slice(avcC.data, avcC.end));
    const codec = `avc1.${hex2(description[1])}${hex2(description[2])}${hex2(description[3])}`;
    const width = dv.getUint16(entry.data + 24);
    const height = dv.getUint16(entry.data + 26);

    // sample sizes
    const stsz = kid(dv, stbl, 'stsz');
    const fixed = dv.getUint32(stsz.data + 4);
    const n = dv.getUint32(stsz.data + 8);
    const sizes = new Uint32Array(n);
    for (let i = 0; i < n; i++) sizes[i] = fixed || dv.getUint32(stsz.data + 12 + i * 4);
    // decode times
    const dts = new Float64Array(n);
    const stts = kid(dv, stbl, 'stts');
    let t = 0;
    let k = 0;
    for (let e = 0, ec = dv.getUint32(stts.data + 4); e < ec; e++) {
      const count = dv.getUint32(stts.data + 8 + e * 8);
      const delta = dv.getUint32(stts.data + 12 + e * 8);
      for (let j = 0; j < count && k < n; j++, k++) { dts[k] = t; t += delta; }
    }
    // composition offsets
    const cto = new Float64Array(n);
    const ctts = kid(dv, stbl, 'ctts');
    if (ctts) {
      const v1 = dv.getUint8(ctts.data) === 1;
      k = 0;
      for (let e = 0, ec = dv.getUint32(ctts.data + 4); e < ec; e++) {
        const count = dv.getUint32(ctts.data + 8 + e * 8);
        const off = v1 ? dv.getInt32(ctts.data + 12 + e * 8) : dv.getUint32(ctts.data + 12 + e * 8);
        for (let j = 0; j < count && k < n; j++, k++) cto[k] = off;
      }
    }
    // keyframes
    const stss = kid(dv, stbl, 'stss');
    const key = new Uint8Array(n).fill(stss ? 0 : 1);
    if (stss) for (let e = 0, ec = dv.getUint32(stss.data + 4); e < ec; e++) key[dv.getUint32(stss.data + 8 + e * 4) - 1] = 1;
    // sample offsets (chunk offsets + samples per chunk)
    const stco = kid(dv, stbl, 'stco');
    const co64 = kid(dv, stbl, 'co64');
    const chunks = [];
    if (stco) for (let e = 0, ec = dv.getUint32(stco.data + 4); e < ec; e++) chunks.push(dv.getUint32(stco.data + 8 + e * 4));
    else if (co64) for (let e = 0, ec = dv.getUint32(co64.data + 4); e < ec; e++) chunks.push(Number(dv.getBigUint64(co64.data + 8 + e * 8)));
    const stsc = kid(dv, stbl, 'stsc');
    const runs = [];
    for (let e = 0, ec = dv.getUint32(stsc.data + 4); e < ec; e++) runs.push([dv.getUint32(stsc.data + 8 + e * 12), dv.getUint32(stsc.data + 12 + e * 12)]);
    const offsets = new Float64Array(n);
    k = 0;
    for (let c = 0; c < chunks.length && k < n; c++) {
      let per = 0;
      for (const [first, spc] of runs) if (first - 1 <= c) per = spc;
      let off = chunks[c];
      for (let j = 0; j < per && k < n; j++, k++) { offsets[k] = off; off += sizes[k]; }
    }
    // edit list: initial delay and the media time the presentation starts at (B-frame delay)
    let shift = 0;
    let delay = 0;
    const elst = kid(dv, kid(dv, trak, 'edts'), 'elst');
    if (elst) {
      const v1 = dv.getUint8(elst.data) === 1;
      const sz = v1 ? 20 : 12;
      for (let e = 0, ec = dv.getUint32(elst.data + 4); e < ec; e++) {
        const p = elst.data + 8 + e * sz;
        const dur = v1 ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
        const mt = v1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
        if (mt === -1) delay += dur / movieScale;
        else { shift = mt; break; }
      }
    }
    const samples = new Array(n);
    for (let i = 0; i < n; i++) samples[i] = { offset: offsets[i], size: sizes[i], key: !!key[i], pts: (dts[i] + cto[i] - shift) / scale + delay };
    return { codec, description, width, height, samples };
  }
  throw unsupported('no video track');
}

// ---------------------------------------------------------------------------------------------
/** Sequential frame access for one clip (or a chain of split clips): the frame shown at a source time. */
class VideoSource {
  constructor(buf, track) {
    this.buf = buf;
    this.track = track;
    this.queue = [];
    this.cur = null;
    this.wake = null;
    this.error = null;
    this.dec = new VideoDecoder({
      output: (f) => { this.queue.push(f); this.wake?.(); },
      error: (e) => { this.error = e; this.wake?.(); },
    });
    this.dec.addEventListener?.('dequeue', () => this.wake?.());
  }
  static async open(buf, track) {
    const cfg = { codec: track.codec, description: track.description, codedWidth: track.width, codedHeight: track.height };
    const ok = await VideoDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (!ok.supported) throw unsupported(`decoder ${track.codec}`);
    const s = new VideoSource(buf, track);
    s.cfg = cfg;
    return s;
  }
  restart(t) {
    for (const f of this.queue) f.close();
    this.queue = [];
    this.cur?.close();
    this.cur = null;
    if (this.dec.state === 'configured') this.dec.reset();
    this.dec.configure(this.cfg);
    const S = this.track.samples;
    let k = 0;
    for (let i = 0; i < S.length; i++) if (S[i].key && S[i].pts <= t + 1e-6) k = i;
    this.next = k;
    this.ended = false;
  }
  feed(s) {
    this.dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.pts * 1e6), data: new Uint8Array(this.buf, s.offset, s.size) }));
  }
  tick() { return new Promise((r) => { this.wake = r; setTimeout(r, 40); }); }
  /** The decoded frame shown at source time t (seconds). Times must mostly move forward. */
  async frameAt(t) {
    const us = Math.round(t * 1e6);
    if (this.lastUs == null || us < this.lastUs - 1000) this.restart(t);
    this.lastUs = us;
    const S = this.track.samples;
    for (;;) {
      if (this.error) throw this.error;
      while (this.queue.length && this.queue[0].timestamp <= us + 1000) { this.cur?.close(); this.cur = this.queue.shift(); }
      // like a <video> element: before the first frame's time, the first frame is shown
      if (this.queue.length || this.ended) return this.cur || this.queue[0] || null;
      if (this.next < S.length) {
        while (this.next < S.length && this.dec.decodeQueueSize < 6) this.feed(S[this.next++]);
        await this.tick();
      } else {
        await this.dec.flush();
        this.ended = true;
      }
    }
  }
  close() {
    for (const f of this.queue) f.close();
    this.queue = [];
    this.cur?.close();
    this.cur = null;
    try { this.dec.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Audio: mix every audible clip offline, like the live mixer does (volume, fades, track/clip mute)
const audioCache = new Map(); // media id -> AudioBuffer | null
async function audioBufferFor(id, bytes) {
  if (audioCache.has(id)) return audioCache.get(id);
  let buf = null;
  try {
    const ctx = new OfflineAudioContext(2, 1, 48000);
    buf = await ctx.decodeAudioData((await bytes(id)).slice(0));
  } catch { buf = null; }
  audioCache.set(id, buf);
  return buf;
}

async function mixAudio(P, r0, r1, bytes) {
  const clips = P.clips.filter((c) => (c.type === 'audio' || c.type === 'video') && !c.muted && !store.track(c.trackId)?.muted
    && (c.volume ?? 1) > 0 && c.start < r1 && c.start + c.duration > r0 && store.media(c.mediaId)?.hasAudio !== false);
  if (!clips.length) return null;
  // The live mixer keeps pitch when a clip is sped up; offline playbackRate would not, so leave those to real time.
  if (clips.some((c) => Math.abs((c.speed || 1) - 1) > 1e-6)) throw unsupported('sped-up clip with sound');
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil((r1 - r0) * rate)), rate);
  let any = false;
  for (const c of clips) {
    const buf = await audioBufferFor(c.mediaId, bytes);
    if (!buf) continue;
    any = true;
    const from = Math.max(c.start, r0);
    const to = Math.min(c.start + c.duration, r1);
    const vol = c.volume ?? 1;
    const gainAt = (lt) => {
      let g = vol;
      if (c.fadeIn > 0) g *= Math.min(1, Math.max(0, lt / c.fadeIn));
      if (c.fadeOut > 0) g *= Math.min(1, Math.max(0, (c.duration - lt) / c.fadeOut));
      return g;
    };
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    // gain envelope at the fade corners, in context time
    const pts = new Set([from - c.start, to - c.start]);
    if (c.fadeIn > 0) pts.add(c.fadeIn);
    if (c.fadeOut > 0) pts.add(c.duration - c.fadeOut);
    const corners = [...pts].filter((lt) => lt >= from - c.start && lt <= to - c.start).sort((a, b) => a - b);
    g.gain.setValueAtTime(gainAt(corners[0]), from - r0);
    for (const lt of corners.slice(1)) g.gain.linearRampToValueAtTime(gainAt(lt), c.start + lt - r0);
    src.connect(g).connect(ctx.destination);
    src.start(from - r0, c.in + (from - c.start), to - from);
  }
  return any ? ctx.startRendering() : null;
}

async function encodeAudio(buf, onTick) {
  const base = { sampleRate: buf.sampleRate, numberOfChannels: 2, bitrate: 192000 };
  let cfg = null;
  for (const codec of ['mp4a.40.2', 'opus']) {
    const c = { ...base, codec };
    if ((await AudioEncoder.isConfigSupported(c).catch(() => ({ supported: false }))).supported) { cfg = c; break; }
  }
  if (!cfg) throw unsupported('no AAC/Opus encoder');
  const chunks = [];
  let description = null;
  let error = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description) description = toU8(meta.decoderConfig.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, ts: chunk.timestamp, dur: chunk.duration });
    },
    error: (e) => { error = e; },
  });
  enc.configure(cfg);
  const L = buf.length;
  const block = 4800;
  const left = buf.getChannelData(0);
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
  for (let i = 0; i < L; i += block) {
    if (error) throw error;
    const n = Math.min(block, L - i);
    const data = new Float32Array(n * 2);
    data.set(left.subarray(i, i + n), 0);
    data.set(right.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: buf.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i * 1e6) / buf.sampleRate), data });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    onTick?.(i / L);
  }
  await enc.flush();
  enc.close();
  if (error) throw error;
  return { codec: cfg.codec, sampleRate: buf.sampleRate, channels: 2, chunks, description };
}

// ---------------------------------------------------------------------------------------------
// MP4 muxer (one video + optional audio track; moov before mdat so it plays while downloading)
const u8 = (...v) => Uint8Array.from(v);
const be16 = (v) => u8((v >>> 8) & 255, v & 255);
const be32 = (v) => u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const str = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
function cat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const box = (type, ...parts) => { const body = cat(parts); return cat([be32(body.length + 8), str(type), body]); };
const full = (type, version, flags, ...parts) => box(type, u8(version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255), ...parts);
const MATRIX = cat([be32(0x10000), be32(0), be32(0), be32(0), be32(0x10000), be32(0), be32(0), be32(0), be32(0x40000000)]);

function sttsOf(durs) {
  const runs = [];
  for (const d of durs) { const last = runs[runs.length - 1]; if (last && last[1] === d) last[0]++; else runs.push([1, d]); }
  return full('stts', 0, 0, be32(runs.length), ...runs.map(([c, d]) => cat([be32(c), be32(d)])));
}
function stblOf(stsd, durs, sizes, offset, { keys, ctts } = {}) {
  const parts = [stsd, sttsOf(durs)];
  if (ctts) {
    const runs = [];
    for (const v of ctts) { const last = runs[runs.length - 1]; if (last && last[1] === v) last[0]++; else runs.push([1, v]); }
    parts.push(full('ctts', 0, 0, be32(runs.length), ...runs.map(([c, v]) => cat([be32(c), be32(v)]))));
  }
  if (keys) parts.push(full('stss', 0, 0, be32(keys.length), ...keys.map((k) => be32(k))));
  parts.push(full('stsc', 0, 0, be32(1), be32(1), be32(sizes.length), be32(1)));
  parts.push(full('stsz', 0, 0, be32(0), be32(sizes.length), ...sizes.map((s) => be32(s))));
  parts.push(full('stco', 0, 0, be32(1), be32(offset)));
  return box('stbl', ...parts);
}
function trakOf({ id, kind, timescale, duration, movieDuration, width = 0, height = 0, stsd, durs, sizes, offset, keys, ctts, mediaStart = 0 }) {
  const tkhd = full('tkhd', 0, 3, be32(0), be32(0), be32(id), be32(0), be32(movieDuration), be32(0), be32(0), be16(0), be16(0),
    be16(kind === 'soun' ? 0x0100 : 0), be16(0), MATRIX, be32(width * 65536), be32(height * 65536));
  const edts = mediaStart ? box('edts', full('elst', 0, 0, be32(1), be32(movieDuration), be32(mediaStart), be32(0x10000))) : u8();
  const mdhd = full('mdhd', 0, 0, be32(0), be32(0), be32(timescale), be32(duration), be16(0x55c4), be16(0));
  const hdlr = full('hdlr', 0, 0, be32(0), str(kind), be32(0), be32(0), be32(0), str(kind === 'vide' ? 'VideoHandler\0' : 'SoundHandler\0'));
  const mhd = kind === 'vide' ? full('vmhd', 0, 1, be16(0), be16(0), be16(0), be16(0)) : full('smhd', 0, 0, be16(0), be16(0));
  const dinf = box('dinf', full('dref', 0, 0, be32(1), full('url ', 0, 1)));
  return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, box('minf', mhd, dinf, stblOf(stsd, durs, sizes, offset, { keys, ctts }))));
}
function colrOf(cs) {
  if (!cs) return u8();
  const P = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9 }[cs.primaries];
  const T = { bt709: 1, smpte170m: 6, 'iec61966-2-1': 13, linear: 8 }[cs.transfer];
  const M = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 }[cs.matrix];
  if (P == null || T == null || M == null) return u8();
  return box('colr', str('nclx'), be16(P), be16(T), be16(M), u8(cs.fullRange ? 0x80 : 0));
}
function videoStsd(v) {
  const entry = box('avc1', u8(0, 0, 0, 0, 0, 0), be16(1), new Uint8Array(16), be16(v.width), be16(v.height), be32(0x480000), be32(0x480000),
    be32(0), be16(1), new Uint8Array(32), be16(0x18), be16(0xffff), box('avcC', v.description), colrOf(v.colorSpace));
  return full('stsd', 0, 0, be32(1), entry);
}
function audioStsd(a) {
  const head = [u8(0, 0, 0, 0, 0, 0), be16(1), be32(0), be32(0), be16(a.channels), be16(16), be16(0), be16(0), be32(a.sampleRate * 65536)];
  if (a.codec === 'opus') {
    let preSkip = 312;
    const d = a.description;
    if (d && d.length >= 12 && String.fromCharCode(...d.subarray(0, 8)) === 'OpusHead') preSkip = d[10] | (d[11] << 8);
    const dOps = box('dOps', u8(0, a.channels), be16(preSkip), be32(a.sampleRate), be16(0), u8(0));
    return full('stsd', 0, 0, be32(1), box('Opus', ...head, dOps));
  }
  const asc = a.description?.length ? a.description : u8(0x11, 0x90); // AAC-LC, 48 kHz, stereo
  const desc = (tag, body) => cat([u8(tag, body.length), body]);
  const dsi = desc(0x05, asc);
  const dcd = desc(0x04, cat([u8(0x40, 0x15), u8(0, 0, 0), be32(192000), be32(192000), dsi]));
  const esd = desc(0x03, cat([be16(1), u8(0), dcd, desc(0x06, u8(0x02))]));
  return full('stsd', 0, 0, be32(1), box('mp4a', ...head, full('esds', 0, 0, esd)));
}

/** Build the MP4 file from encoded video (+ audio) chunks. */
export function muxMp4(video, audio) {
  const vScale = video.fps * 1000;
  const n = video.chunks.length;
  const vDurs = new Array(n).fill(1000);
  // decode order = output order; presentation time from the chunk timestamp (handles B-frames via ctts)
  const pts = video.chunks.map((c) => Math.round((c.ts * vScale) / 1e6));
  let shift = 0;
  for (let i = 0; i < n; i++) shift = Math.max(shift, i * 1000 - pts[i]);
  const ctts = pts.map((p, i) => p + shift - i * 1000);
  const hasCtts = ctts.some((v) => v !== 0);
  const keys = [];
  video.chunks.forEach((c, i) => { if (c.key) keys.push(i + 1); });
  const vSizes = video.chunks.map((c) => c.data.length);
  const vBytes = vSizes.reduce((a, b) => a + b, 0);
  const vDur = n * 1000;
  const movieDur = Math.round((vDur / vScale) * 1000);

  let aDurs = [];
  let aSizes = [];
  let aBytes = 0;
  if (audio?.chunks.length) {
    const A = audio.chunks;
    aDurs = A.map((c, i) => {
      const d = c.dur || (A[i + 1] ? A[i + 1].ts - c.ts : (A[i - 1] ? c.ts - A[i - 1].ts : 21333));
      return Math.max(1, Math.round((d * audio.sampleRate) / 1e6));
    });
    aSizes = A.map((c) => c.data.length);
    aBytes = aSizes.reduce((a, b) => a + b, 0);
  }
  const ftyp = box('ftyp', str('isom'), be32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const build = (vOff, aOff) => {
    const mvhd = full('mvhd', 0, 0, be32(0), be32(0), be32(1000), be32(movieDur), be32(0x10000), be16(0x0100), be16(0), be32(0), be32(0), MATRIX,
      new Uint8Array(24), be32(audio?.chunks.length ? 3 : 2));
    const tracks = [trakOf({ id: 1, kind: 'vide', timescale: vScale, duration: vDur, movieDuration: movieDur, width: video.width, height: video.height,
      stsd: videoStsd(video), durs: vDurs, sizes: vSizes, offset: vOff, keys: keys.length === n ? null : keys, ctts: hasCtts ? ctts : null, mediaStart: hasCtts ? shift : 0 })];
    if (audio?.chunks.length) {
      const aDur = aDurs.reduce((x, y) => x + y, 0);
      tracks.push(trakOf({ id: 2, kind: 'soun', timescale: audio.sampleRate, duration: aDur, movieDuration: Math.round((aDur / audio.sampleRate) * 1000),
        stsd: audioStsd(audio), durs: aDurs, sizes: aSizes, offset: aOff }));
    }
    return box('moov', mvhd, ...tracks);
  };
  const moovLen = build(0, 0).length;
  const vOff = ftyp.length + moovLen + 8;
  const moov = build(vOff, vOff + vBytes);
  const mdatHead = cat([be32(8 + vBytes + aBytes), str('mdat')]);
  return new Blob([ftyp, moov, mdatHead, ...video.chunks.map((c) => c.data), ...(audio?.chunks || []).map((c) => c.data)], { type: 'video/mp4' });
}

// ---------------------------------------------------------------------------------------------
/** H.264 level for a frame size and rate (MaxFS and MaxMBPS limits). */
function avcLevel(w, h, fps) {
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbps = fs * fps;
  const levels = [[0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
  for (const [lv, maxFs, maxMbps] of levels) if (fs <= maxFs && mbps <= maxMbps) return lv;
  return 0x34;
}

/**
 * Render [r0, r1] of the project to an MP4 Blob as fast as possible.
 * engine: the live Engine (chain keys, image sources); flag.cancelled stops it; onProgress(0..1).
 * stats (optional object) receives the time spent per stage in ms (blueprint 9.1 "Export").
 */
export async function fastExport({ engine, P, width, height, fps, bitrate, r0, r1, flag, onProgress, stats = {} }) {
  const tPrep = performance.now();
  stats.stage = 'prepare';
  if (!fastExportAvailable()) throw unsupported('WebCodecs not available');
  const lv = avcLevel(width, height, fps);
  let cfg = null;
  for (const prof of ['64', '4d', '42']) {
    const c = { codec: `avc1.${prof}00${hex2(lv)}`, width, height, bitrate, framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(c).catch(() => ({ supported: false }))).supported) { cfg = c; break; }
  }
  if (!cfg) throw unsupported('no H.264 encoder');

  // Source files: every video clip must be an H.264 MP4/MOV this device can decode.
  const bytesCache = new Map();
  const bytes = async (id) => {
    if (!bytesCache.has(id)) {
      const rt = mediaRT.get(id);
      const url = rt?.exportUrl || rt?.url; // full-quality copy on this device (exporter prepares it)
      if (!url) throw unsupported('media not loaded');
      bytesCache.set(id, fetch(url).then((r) => r.arrayBuffer()));
    }
    return bytesCache.get(id);
  };
  const vClips = P.clips.filter((c) => c.type === 'video' && c.start < r1 && c.start + c.duration > r0);
  const tracks = new Map();
  for (const c of vClips) if (!tracks.has(c.mediaId)) tracks.set(c.mediaId, demuxVideo(await bytes(c.mediaId)));

  // Audio first (fast): a failure here falls back before any video work.
  const mixed = await mixAudio(P, r0, r1, bytes);
  const audio = mixed ? await encodeAudio(mixed) : null;

  const keys = engine.chainKeys(P);
  const groups = new Map();
  for (const c of vClips) { const k = keys.get(c.id) || c.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const sources = new Map(); // key -> VideoSource
  const shown = new Map(); // key -> current VideoFrame
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const env = {
    project: P,
    s: width / P.width,
    boxes: null,
    mediaMeta: (id) => store.media(id),
    source: (clip) => {
      if (clip.type !== 'video') return engine.sourceFor(clip);
      const f = shown.get(keys.get(clip.id) || clip.id);
      return f ? { el: f, w: f.displayWidth, h: f.displayHeight } : null;
    },
  };

  const chunks = [];
  let vDesc = null;
  let colorSpace = null;
  let encError = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !vDesc) {
        vDesc = toU8(meta.decoderConfig.description);
        colorSpace = meta.decoderConfig.colorSpace || null;
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, ts: chunk.timestamp, key: chunk.type === 'key' });
    },
    error: (e) => { encError = e; },
  });
  enc.configure(cfg);
  const total = Math.max(1, Math.round((r1 - r0) * fps));
  const prof = { decode: 0, render: 0, frame: 0, encodeWait: 0 }; // ms per stage (shown in the console)
  const tStart = performance.now();
  stats.prepare_ms = Math.round(tStart - tPrep);
  stats.encoder = cfg.codec;
  stats.encoder_queue_max = 0;
  stats.stage = 'render';
  try {
    for (let i = 0; i < total; i++) {
      if (flag?.cancelled) throw new Error('Ekspor dibatalkan');
      if (encError) throw encError;
      const t = r0 + i / fps;
      let m = performance.now();
      // the frame each video on (or next to, for transitions) the playhead shows at t
      for (const [k, list] of groups) {
        const clip = list.find((c) => t >= c.start && t < c.start + c.duration)
          || list.find((c) => t >= c.start - 1 && t < c.start + c.duration + 1);
        if (!clip) {
          // finished for good: free the decoder and its frames
          if (sources.has(k) && list.every((c) => t >= c.start + c.duration + 1)) { sources.get(k).close(); sources.delete(k); shown.delete(k); }
          continue;
        }
        if (!sources.has(k)) sources.set(k, await VideoSource.open(await bytes(clip.mediaId), tracks.get(clip.mediaId)));
        shown.set(k, await sources.get(k).frameAt(engine.localTime(clip, t)));
      }
      prof.decode += performance.now() - m; m = performance.now();
      renderFrame(ctx, t, env);
      prof.render += performance.now() - m; m = performance.now();
      const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      prof.frame += performance.now() - m; m = performance.now();
      if (enc.encodeQueueSize > stats.encoder_queue_max) stats.encoder_queue_max = enc.encodeQueueSize;
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      prof.encodeWait += performance.now() - m;
      if (i % 5 === 0) onProgress?.(i / total);
    }
    stats.stage = 'encode';
    const tFlush = performance.now();
    await enc.flush();
    if (encError) throw encError;
    Object.assign(stats, {
      frames: total,
      decode_ms: Math.round(prof.decode),
      composite_ms: Math.round(prof.render),
      encode_ms: Math.round(prof.frame + prof.encodeWait + (performance.now() - tFlush)),
    });
    const secs = (performance.now() - tStart) / 1000;
    console.info(`[najja] fast export: ${total} frames in ${secs.toFixed(1)} s (${(total / secs).toFixed(1)} fps) · ${cfg.codec} ·`,
      Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, `${(v / total).toFixed(1)} ms/frame`])));
  } finally {
    try { enc.close(); } catch { /* closed */ }
    for (const s of sources.values()) s.close();
  }
  if (!vDesc) throw unsupported('encoder gave no avcC');
  onProgress?.(1);
  stats.stage = 'mux';
  const tMux = performance.now();
  const out = muxMp4({ fps, width, height, description: vDesc, colorSpace, chunks }, audio);
  stats.mux_ms = Math.round(performance.now() - tMux);
  stats.stage = 'done';
  return out;
}
