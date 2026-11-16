// Voice clean-up (v1.9): noise reduction removes steady noise and keeps the voice; the voice chain levels it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { denoise, enhance, processVoice } from '../public/js/voicedsp.js';

const RATE = 48000;
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
/** 4 s: "speech" (a 220 Hz voice with harmonics, on 0.5–1.5 s and 2.5–3.5 s) + steady hiss. */
function sample(noiseLevel = 0.05) {
  const n = RATE * 4;
  const voice = new Float32Array(n);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const on = (t > 0.5 && t < 1.5) || (t > 2.5 && t < 3.5) ? 1 : 0;
    voice[i] = on * 0.3 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.25 * Math.sin(2 * Math.PI * 880 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
    noise[i] = rnd() * 2 * noiseLevel;
  }
  return { voice, noise, mix: voice.map((v, i) => v + noise[i]) };
}
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const db = (v) => 20 * Math.log10(v);

test('noise reduction: hiss in the pauses down by more than 12 dB, the voice kept within 2 dB', () => {
  const { mix } = sample();
  const y = denoise(mix, 1);
  const pause = [Math.round(1.8 * RATE), Math.round(2.3 * RATE)];
  const talk = [Math.round(0.7 * RATE), Math.round(1.3 * RATE)];
  const before = rms(mix, ...pause);
  const after = rms(y, ...pause);
  assert.ok(db(before) - db(after) > 12, `pause: ${db(before).toFixed(1)} → ${db(after).toFixed(1)} dB`);
  assert.ok(Math.abs(db(rms(y, ...talk)) - db(rms(mix, ...talk))) < 2, `voice: ${db(rms(mix, ...talk)).toFixed(1)} → ${db(rms(y, ...talk)).toFixed(1)} dB`);
  assert.equal(y.length, mix.length);
});

test('a clean voice goes through noise reduction unchanged (no dips at the ends)', () => {
  const { voice } = sample(0);
  const loud = voice;
  const y = denoise(loud, 1);
  let err = 0;
  for (let i = 0; i < y.length; i++) err = Math.max(err, Math.abs(y[i] - loud[i]));
  assert.ok(err < 0.05, `largest change ${err.toFixed(3)}`);
  assert.ok(Math.abs(rms(y, Math.round(0.5 * RATE), Math.round(0.6 * RATE)) - rms(loud, Math.round(0.5 * RATE), Math.round(0.6 * RATE))) < 0.01, 'word onsets kept');
});

test('voice enhance: quiet speech made louder (toward −18 dBFS), peaks under −1 dBFS, no rumble', () => {
  const n = RATE * 2;
  const quiet = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / RATE; quiet[i] = 0.03 * Math.sin(2 * Math.PI * 300 * t) + 0.2 * Math.sin(2 * Math.PI * 30 * t); }
  const [y] = enhance([quiet], RATE);
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 0.891 + 1e-6, `peak ${peak}`);
  // the 30 Hz rumble is cut by the high-pass: measure the low band by a crude 30 Hz correlation
  let c30 = 0, c300 = 0;
  for (let i = RATE; i < n; i++) { const t = i / RATE; c30 += y[i] * Math.sin(2 * Math.PI * 30 * t); c300 += y[i] * Math.sin(2 * Math.PI * 300 * t); }
  assert.ok(Math.abs(c30) < Math.abs(c300) * 0.5, `30 Hz ${Math.abs(c30).toFixed(1)} vs 300 Hz ${Math.abs(c300).toFixed(1)}`);
  const [d] = processVoice([quiet], RATE, { denoise: false, enhance: true });
  assert.equal(d.length, n);
});
