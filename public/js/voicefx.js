// Voice clean-up of clips (v1.9): "Kurangi kebisingan" (noise reduction) and "Sempurnakan suara" (voice enhance) in the
// Volume panel. The decoded sound of a clip is processed (voicedsp.js, in a worker) before it is scheduled in the
// preview or mixed in the export, so both sound the same. A clip asks for it with clip.voice = { denoise, enhance }.

/** '' when the clip asks for nothing, else a key of what it asks for (cache key of the processed sound). */
export const voiceKey = (c) => (c?.voice && (c.voice.denoise || c.voice.enhance) ? `${c.voice.denoise ? 'd' : ''}${c.voice.enhance ? 'e' : ''}` : '');
export const voiceOpts = (key) => ({ denoise: key.includes('d'), enhance: key.includes('e') });

let worker = null;
let failed = false;
let seq = 0;
const waiting = new Map();
function getWorker() {
  if (worker || failed) return worker;
  try {
    worker = new Worker(new URL('./voicefx-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (!w) return; waiting.delete(e.data.id); if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data.chans); };
    worker.onerror = () => { failed = true; worker = null; for (const w of waiting.values()) w.reject(new Error('worker')); waiting.clear(); };
  } catch { failed = true; worker = null; }
  return worker;
}

/** The channels of `buf` processed as `key` asks, as a new AudioBuffer (worker; the main thread where it is missing). */
export async function processBuffer(buf, key) {
  const opts = voiceOpts(key);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(new Float32Array(buf.getChannelData(c)));
  let out;
  const w = getWorker();
  if (w) {
    try {
      out = await new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, chans, rate: buf.sampleRate, opts }, chans.map((x) => x.buffer));
      });
    } catch { out = null; }
  }
  if (!out) {
    const { processVoice } = await import('./voicedsp.js');
    const fresh = [];
    for (let c = 0; c < buf.numberOfChannels; c++) fresh.push(new Float32Array(buf.getChannelData(c)));
    out = processVoice(fresh, buf.sampleRate, opts);
  }
  const res = new AudioBuffer({ numberOfChannels: out.length, length: out[0].length, sampleRate: buf.sampleRate });
  out.forEach((ch, i) => res.copyToChannel(ch, i));
  return res;
}

/** Cache of processed sounds per decoded buffer: buffer → key → Promise<AudioBuffer>. */
const cache = new WeakMap();
export function processedFor(buf, key) {
  let m = cache.get(buf);
  if (!m) cache.set(buf, (m = new Map()));
  if (!m.has(key)) m.set(key, processBuffer(buf, key));
  return m.get(key);
}
