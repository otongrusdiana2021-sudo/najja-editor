// Live previews of transitions and animations (v1.9). Each tile plays the real thing — the same renderer the preview
// and the export use (renderFrame on a tiny project) — instead of a CSS imitation, so what you see in the tab is what
// the clip will do. Only tiles on screen are drawn, about 30 times a second, while their panel is open.
import { makeClip } from './store.js';
import { compilePlan } from './plan.js';
import { renderFrame } from './render.js';
import { kineticById, makeMotion } from './kinetic.js';

const PW = 320;
const PH = 200;
const LOOP = { tr: 2.2, in: 1.8, out: 1.8, loop: 2.4, kin: 2.6 };

/** Two sample pictures (A before the cut, B after it), made once. */
let scenes = null;
function sampleScenes() {
  if (scenes) return scenes;
  const make = (c1, c2, label, shape) => {
    const c = document.createElement('canvas');
    c.width = PW;
    c.height = PH;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, PW, PH);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    x.fillStyle = g;
    x.fillRect(0, 0, PW, PH);
    x.fillStyle = 'rgba(255,255,255,0.85)';
    x.beginPath();
    if (shape === 'sun') x.arc(PW * 0.7, PH * 0.38, PH * 0.17, 0, Math.PI * 2);
    else { x.moveTo(PW * 0.2, PH * 0.8); x.lineTo(PW * 0.42, PH * 0.3); x.lineTo(PW * 0.64, PH * 0.8); }
    x.fill();
    x.fillStyle = 'rgba(0,0,0,0.28)';
    x.fillRect(0, PH * 0.8, PW, PH * 0.2);
    x.font = '700 64px Poppins, sans-serif';
    x.fillStyle = '#fff';
    x.textAlign = 'left';
    x.textBaseline = 'middle';
    x.fillText(label, PW * 0.06, PH * 0.28);
    return c;
  };
  scenes = { A: make('#ff7a45', '#ffd166', 'A', 'sun'), B: make('#3a7bd5', '#00d2c6', 'B', 'peak') };
  return scenes;
}

const project = (clips) => ({
  id: 'preview', width: PW, height: PH, fps: 30, background: { mode: 'color', color: '#16171b', blur: 40 }, magnet: true,
  // (top layer first, as in a project: text over the overlay over the main track)
  tracks: [{ id: 'tx', kind: 'text' }, { id: 'ov', kind: 'overlay' }, { id: 'main', kind: 'main' }], clips, media: [],
});

/** The tiny project and loop length of a preview: "tr:fade", "in:pop", "out:fade", "loop:pulse" (target: text/visual). */
function setup(spec, target) {
  const [kind, id] = spec.split(':');
  if (kind === 'tr') {
    const A = makeClip('image', { id: 'A', trackId: 'main', start: 0, duration: 1.4, mediaId: 'A' });
    const B = makeClip('image', { id: 'B', trackId: 'main', start: 1.4, duration: 1.4, mediaId: 'B', transition: { type: id, duration: 0.8 } });
    const P = project([A, B]);
    // 0.4 s of A, the transition, 0.4 s of B, a short pause on A again
    return { P, plan: compilePlan(P), time: (u) => 0.6 + u * (LOOP.tr - 0.2) * (1.6 / 2.0) };
  }
  if (kind === 'kin') {
    // (v1.12) kinetic text: a short sample text doing it, then a pause
    const k = kineticById(id);
    const [content, size] = k?.sample ? [k.sample, 50] : k?.id === 'karaoke' ? ['Kata per kata', 40] : k?.id === 'highlighter' ? ['Stabilo ini', 46]
      : k?.unit === 'line' ? ['Satu baris\nlagi baris', 40] : k?.unit === 'char' ? ['Halo!', 72] : ['Halo dunia', 48];
    const T = makeClip('text', { id: 'T', trackId: 'tx', start: 0, duration: 2.4, text: { content, size, font: 'Poppins', weight: 800, color: '#ffffff', align: 'center', lineHeight: 1.15, stroke: { enabled: true, color: '#000000', width: 5 }, ...(makeMotion(id) ? { motion: makeMotion(id) } : {}) } });
    const bg = makeClip('image', { id: 'B', trackId: 'main', start: 0, duration: 2.4, mediaId: 'B' });
    const P = project([bg, T]);
    return { P, plan: compilePlan(P), time: (u) => Math.min(2.39, u * LOOP.kin) };
  }
  const anim = kind === 'in' ? { animIn: { type: id, duration: 0.7 } } : kind === 'out' ? { animOut: { type: id, duration: 0.7 } } : { animLoop: { type: id, speed: 1 } };
  const clip = target === 'text'
    ? makeClip('text', { id: 'T', trackId: 'tx', start: 0, duration: 1.6, ...anim, text: { content: 'Aa', size: 110, font: 'Poppins', weight: 800, color: '#ffffff', stroke: { enabled: true, color: '#000000', width: 6 } } })
    : makeClip('image', { id: 'A', trackId: 'ov', start: 0, duration: 1.6, mediaId: 'A', scale: 0.62, ...anim });
  const bg = target === 'text' ? [makeClip('image', { id: 'B', trackId: 'main', start: 0, duration: 1.6, mediaId: 'B' })] : [];
  const P = project([...bg, clip]);
  const D = 1.6;
  // in: play the entrance, hold; out: hold, play the exit; loop: the clip's middle, over and over
  const time = kind === 'in' ? (u) => Math.min(D - 0.01, u * LOOP.in * 0.95)
    : kind === 'out' ? (u) => Math.min(D - 0.01, Math.max(0, u * LOOP.out - 0.2))
      : (u) => 0.1 + u * (D - 0.2);
  return { P, plan: compilePlan(P), time };
}

const live = new Set(); // canvases being animated
let raf = 0;
let observer = null;
let last = 0;
function frame(now) {
  raf = 0;
  for (const cv of [...live]) if (!cv.isConnected) { live.delete(cv); observer?.unobserve(cv); }
  if (!live.size) return;
  raf = requestAnimationFrame(frame);
  if (now - last < 30) return; // ±30 fps is plenty for a thumbnail
  last = now;
  const S = sampleScenes();
  for (const cv of live) {
    if (!cv.dataset.visible) continue;
    let st = cv._prev;
    if (!st || st.spec !== cv.dataset.prev) {
      st = cv._prev = { spec: cv.dataset.prev, ...setup(cv.dataset.prev, cv.dataset.target || 'visual'), t0: now };
    }
    const kind = st.spec.split(':')[0];
    const u = (((now - st.t0) / 1000) % LOOP[kind]) / LOOP[kind];
    const ctx = cv.getContext('2d');
    const env = {
      project: st.P,
      plan: st.plan,
      s: cv.width / PW,
      boxes: null,
      mediaMeta: () => ({ width: PW, height: PH }),
      source: (clip) => { const el = S[clip.mediaId]; return el ? { el, w: PW, h: PH } : null; },
    };
    try { renderFrame(ctx, st.time(u), env); } catch { live.delete(cv); }
  }
}

/** Start the previews of the canvases [data-prev] inside root (call after each render of the panel). */
export function startPreviews(root) {
  if (!root) return;
  if (!observer && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) { if (e.isIntersecting) e.target.dataset.visible = '1'; else delete e.target.dataset.visible; }
    });
  }
  for (const cv of root.querySelectorAll('canvas[data-prev]')) {
    if (live.has(cv)) continue;
    live.add(cv);
    if (observer) observer.observe(cv); else cv.dataset.visible = '1';
  }
  if (!raf && live.size) raf = requestAnimationFrame(frame);
}
