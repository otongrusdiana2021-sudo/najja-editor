// Worker for voice clean-up (voicefx.js): the DSP runs here, so the preview never stutters while a block is cleaned.
import { processVoice } from './voicedsp.js';

self.onmessage = (e) => {
  const { id, chans, rate, opts } = e.data;
  try {
    const out = processVoice(chans, rate, opts);
    self.postMessage({ id, chans: out }, out.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
