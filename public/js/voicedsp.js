// Voice clean-up DSP (v1.9), pure functions on Float32Array channels — used in a worker (voicefx.js) for the preview
// and the export alike, so both sound the same.
//
//   denoise: spectral gating. STFT (1024-point Hann, hop 256); the noise floor of each frequency is its mean power in
//            the quietest quarter of the frames (the pauses); each bin is turned down by how much of it is noise
//            (Wiener-style gain with a floor, smoothed over time and frequency so it does not "bubble"). Steady noise
//            — hum, hiss, fan, AC, traffic rumble — goes; the voice stays.
//   enhance: a voice chain: rumble cut (high-pass 80 Hz, 24 dB/octave), less mud (−2.5 dB at 250 Hz), presence (+3.5 dB at 3.2 kHz),
//            air (+2 dB above 9 kHz), a gentle compressor (3:1 from −24 dBFS) and make-up gain to a steady level,
//            peaks kept under −1 dBFS.

// ---- FFT (radix-2, in place) -------------------------------------------------------------------------------------
function fftTables(n) {
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  return { n, rev, cos, sin };
}
function fft(T, re, im, inverse = false) {
  const { n, rev, cos, sin } = T;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = inverse ? -sin[k * step] : sin[k * step];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const N = 1024;
const HOP = 256;
let T = null;
let WIN = null;

/** Spectral-gating noise reduction of one channel. strength 0..1. */
export function denoise(x, strength = 1) {
  if (!T) {
    T = fftTables(N);
    WIN = new Float64Array(N);
    for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  }
  const len = x.length;
  const pad = N;
  const total = len + 2 * pad;
  const frames = Math.max(1, Math.ceil((total - N) / HOP) + 1);
  const bins = N / 2 + 1;
  // analysis: magnitude and phase of every frame (the signal padded with its own reflection: no dip at the ends)
  const at = (i) => { const j = i - pad; if (j < 0) return x[Math.min(len - 1, -j)] || 0; if (j >= len) return x[Math.max(0, 2 * len - j - 2)] || 0; return x[j]; };
  const mag = new Float32Array(frames * bins);
  const reS = new Float32Array(frames * bins);
  const imS = new Float32Array(frames * bins);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < N; i++) { re[i] = at(o + i) * WIN[i]; im[i] = 0; }
    fft(T, re, im);
    for (let k = 0; k < bins; k++) { const q = f * bins + k; reS[q] = re[k]; imS[q] = im[k]; mag[q] = Math.hypot(re[k], im[k]); }
  }
  // noise floor per bin: its mean power in the quietest 25% of the frames (the pauses between words)
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let e = 0; for (let k = 0; k < bins; k++) e += mag[f * bins + k] ** 2; energy[f] = e; }
  const cut = Float32Array.from(energy).sort()[Math.floor((frames - 1) * 0.25)];
  const noise = new Float32Array(bins); // (as a magnitude: √ mean power)
  let quiet = 0;
  for (let f = 0; f < frames; f++) {
    if (energy[f] > cut) continue;
    quiet++;
    for (let k = 0; k < bins; k++) noise[k] += mag[f * bins + k] ** 2;
  }
  for (let k = 0; k < bins; k++) noise[k] = Math.sqrt(noise[k] / Math.max(1, quiet));
  // gains: Wiener-style, floor, smoothed across frequency (3 bins) and time (fast up, slow down)
  const alpha = 1.2 + 1.3 * strength;
  const floor = 0.18 - 0.1 * strength;
  const gPrev = new Float32Array(bins).fill(1);
  const g = new Float32Array(bins);
  const out = new Float64Array(total);
  const norm = new Float64Array(total);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < bins; k++) {
      const p = mag[f * bins + k] ** 2;
      const nn = alpha * noise[k] ** 2;
      g[k] = p > 1e-12 ? Math.max(floor, Math.min(1, (p - nn) / p)) : floor;
    }
    for (let k = 0; k < bins; k++) {
      const sm = (g[Math.max(0, k - 1)] + 2 * g[k] + g[Math.min(bins - 1, k + 1)]) / 4;
      const v = sm > gPrev[k] ? sm : gPrev[k] * 0.7 + sm * 0.3; // opens at once, closes over a few frames
      gPrev[k] = v;
    }
    for (let k = 0; k < bins; k++) { const q = f * bins + k; re[k] = reS[q] * gPrev[k]; im[k] = imS[q] * gPrev[k]; }
    for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    fft(T, re, im, true);
    const o = f * HOP;
    for (let i = 0; i < N; i++) { out[o + i] += re[i] * WIN[i]; norm[o + i] += WIN[i] * WIN[i]; }
  }
  const y = new Float32Array(len);
  for (let i = 0; i < len; i++) { const j = i + pad; y[i] = norm[j] > 1e-6 ? out[j] / norm[j] : 0; }
  return y;
}

// ---- voice enhance ----------------------------------------------------------------------------------------------
/** RBJ biquad coefficients. */
function biquad(type, f0, rate, q, gainDb = 0) {
  const A = 10 ** (gainDb / 40);
  const w = (2 * Math.PI * f0) / rate;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; }
  else if (type === 'peak') { b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; }
  else { // highshelf
    const s = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
    a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function filter(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Voice EQ + compressor + level on several channels (linked, so the stereo image stays). */
export function enhance(chans, rate) {
  // (two high-pass sections: 24 dB/octave below 80 Hz — rumble and handling noise)
  const eq = [biquad('highpass', 80, rate, 0.541), biquad('highpass', 80, rate, 1.307), biquad('peak', 250, rate, 1.0, -2.5), biquad('peak', 3200, rate, 0.9, 3.5), biquad('highshelf', 9000, rate, 0.7, 2)];
  let cs = chans.map((c) => eq.reduce((acc, co) => filter(acc, co), c));
  // compressor: RMS envelope (10 ms attack, 150 ms release), 3:1 above −24 dBFS
  const n = cs[0].length;
  const att = Math.exp(-1 / (0.01 * rate));
  const rel = Math.exp(-1 / (0.15 * rate));
  const thr = 10 ** (-24 / 20);
  let env = 0;
  const gain = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of cs) p = Math.max(p, Math.abs(c[i]));
    env = p > env ? att * env + (1 - att) * p : rel * env + (1 - rel) * p;
    gain[i] = env > thr ? (thr * (env / thr) ** (1 / 3)) / env : 1;
  }
  cs = cs.map((c) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = c[i] * gain[i]; return y; });
  // make-up: speech level to about −18 dBFS RMS (loud parts only), at most +12 dB; peaks under −1 dBFS
  let sq = 0, cnt = 0, peak = 0;
  for (const c of cs) for (let i = 0; i < n; i++) { const a = Math.abs(c[i]); if (a > 0.003) { sq += a * a; cnt++; } if (a > peak) peak = a; }
  const rms = cnt ? Math.sqrt(sq / cnt) : 0;
  let k = rms > 1e-4 ? Math.min(4, 10 ** (-18 / 20) / rms) : 1;
  if (peak * k > 0.891) k = Math.max(1, 0.891 / peak) > k ? k : 0.891 / peak;
  return cs.map((c) => { const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = Math.max(-0.95, Math.min(0.95, c[i] * k)); return y; });
}

/** Both, as asked: { denoise, enhance } on channel arrays at `rate`. Returns new channel arrays. */
export function processVoice(chans, rate, opts) {
  let cs = chans;
  if (opts.denoise) cs = cs.map((c) => denoise(c, opts.strength ?? 1));
  if (opts.enhance) cs = enhance(cs, rate);
  return cs;
}
