// Frame compositor: draws the project at time t onto a 2D canvas. Pure drawing — media elements come from env.
import { FILTERS, FONTS } from './presets.js';
import { clamp, ease, hash, rand2, rgba, hexToRgb } from './util.js';
import { drawFiltered } from './gpufx.js';
import { kfValue } from './store.js';
import { compilePlan, clipsAt, mainStateAt } from './plan.js';
import { cutoutMask } from './segment.js';
import { drawKinetic } from './kinetic.js';

const FILTER_MAP = Object.fromEntries(FILTERS.map((f) => [f.id, f]));
const NEUTRAL = { brightness: 1, contrast: 1, saturate: 1, sepia: 0, grayscale: 0, invert: 0, 'hue-rotate': 0, sharpen: 0 };
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

// ---------------------------------------------------------------------------------------------
// Fonts: make sure canvas text uses loaded web fonts
const fontRequests = new Set();
let fontListener = null;
let fontEpoch = 0; // (counts finished font loads: measured text layouts made before are stale)
export function onFontsLoaded(fn) { fontListener = fn; }
function ensureFont(family, weight, italic) {
  const key = `${italic ? 'italic ' : ''}${weight} ${family}`;
  if (fontRequests.has(key) || typeof document === 'undefined' || !document.fonts) return;
  fontRequests.add(key);
  document.fonts.load(`${italic ? 'italic ' : ''}${weight} 40px "${family}"`).then(() => { fontEpoch++; fontListener?.(); }).catch(() => {});
}
export function fontWeightFor(family, weight) {
  const f = FONTS.find((x) => x.name === family);
  if (!f) return weight;
  return f.weights.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), f.weights[0]);
}
export async function preloadFonts(P) {
  if (!document.fonts) return;
  const loads = [];
  for (const c of P.clips) {
    if (c.type !== 'text') continue;
    const w = fontWeightFor(c.text.font, c.text.weight);
    loads.push(document.fonts.load(`${c.text.italic ? 'italic ' : ''}${w} 40px "${c.text.font}"`).catch(() => {}));
  }
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 2500))]);
}

// ---------------------------------------------------------------------------------------------
// Animations
export function computeAnim(clip, local) {
  const r = { dx: 0, dy: 0, scale: 1, rot: 0, alpha: 1, blur: 0, reveal: 1, spread: 0 };
  const D = clip.duration;
  const ai = clip.animIn;
  const ao = clip.animOut;
  if (ai && ai.type !== 'none') {
    const d = Math.min(ai.duration || 0.5, D);
    if (local < d) applyIn(ai.type, clamp(local / d, 0, 1), r);
  }
  if (ao && ao.type !== 'none') {
    const d = Math.min(ao.duration || 0.5, D);
    if (local > D - d) applyOut(ao.type, clamp((local - (D - d)) / d, 0, 1), r);
  }
  const al = clip.animLoop;
  if (al && al.type !== 'none') applyLoop(al.type, local, al.speed || 1, r);
  return r;
}
function applyIn(type, p, r) {
  const e = ease.outCubic(p);
  switch (type) {
    case 'fade': r.alpha *= p; break;
    case 'zoomIn': r.scale *= 0.3 + 0.7 * e; r.alpha *= Math.min(1, p * 2); break;
    case 'zoomOut': r.scale *= 1.6 - 0.6 * e; r.alpha *= Math.min(1, p * 1.5); break;
    case 'slideLeft': r.dx += (1 - e) * 0.5; r.alpha *= Math.min(1, p * 1.5); break;
    case 'slideRight': r.dx -= (1 - e) * 0.5; r.alpha *= Math.min(1, p * 1.5); break;
    case 'slideUp': r.dy += (1 - e) * 0.35; r.alpha *= Math.min(1, p * 1.5); break;
    case 'slideDown': r.dy -= (1 - e) * 0.35; r.alpha *= Math.min(1, p * 1.5); break;
    case 'spin': r.rot -= (1 - e) * 180; r.scale *= 0.2 + 0.8 * e; r.alpha *= p; break;
    case 'pop': r.scale *= Math.max(0.01, ease.outBack(p)); r.alpha *= Math.min(1, p * 3); break;
    case 'bounce': r.dy -= (1 - ease.outBounce(p)) * 0.45; r.alpha *= Math.min(1, p * 4); break;
    case 'blur': r.blur += (1 - e) * 30; r.alpha *= p; break;
    case 'rise': r.dy += (1 - e) * 0.06; r.alpha *= p; break;
    case 'typewriter': r.reveal = p; break;
    case 'converge': r.spread = (1 - e) * 0.9; r.alpha *= Math.min(1, p * 2.5); break; // (extra letter spacing, em)
    default: break;
  }
}
function applyOut(type, q, r) {
  const e = ease.inCubic(q);
  switch (type) {
    case 'fade': r.alpha *= 1 - q; break;
    case 'zoomOut': r.scale *= 1 - 0.7 * e; r.alpha *= 1 - e; break;
    case 'zoomIn': r.scale *= 1 + 0.6 * e; r.alpha *= 1 - q; break;
    case 'slideLeft': r.dx -= e * 0.5; r.alpha *= 1 - e; break;
    case 'slideRight': r.dx += e * 0.5; r.alpha *= 1 - e; break;
    case 'slideUp': r.dy -= e * 0.35; r.alpha *= 1 - e; break;
    case 'slideDown': r.dy += e * 0.35; r.alpha *= 1 - e; break;
    case 'spin': r.rot += e * 180; r.scale *= Math.max(0.01, 1 - 0.8 * e); r.alpha *= 1 - q; break;
    case 'pop': r.scale *= Math.max(0.01, 1 - ease.inBack(q)); r.alpha *= 1 - Math.max(0, q - 0.6) / 0.4; break;
    case 'blur': r.blur += e * 30; r.alpha *= 1 - q; break;
    case 'sink': r.dy += e * 0.06; r.alpha *= 1 - q; break;
    case 'typewriter': r.reveal = Math.min(r.reveal, 1 - q); break;
    default: break;
  }
}
function applyLoop(type, t, speed, r) {
  const TAU = Math.PI * 2;
  switch (type) {
    case 'pulse': r.scale *= 1 + 0.06 * Math.sin(TAU * t * 1.5 * speed); break;
    case 'float': r.dy += 0.012 * Math.sin(TAU * t * 0.7 * speed); break;
    case 'swing': r.rot += 7 * Math.sin(TAU * t * 0.9 * speed); break;
    case 'shake': r.dx += 0.006 * (hash(Math.floor(t * 24 * speed)) - 0.5); r.dy += 0.006 * (hash(Math.floor(t * 24 * speed) + 99) - 0.5); break;
    case 'flicker': r.alpha *= hash(Math.floor(t * 14 * speed)) > 0.22 ? 1 : 0.35; break;
    case 'heartbeat': { const ph = (t * speed) % 1; r.scale *= 1 + 0.12 * Math.max(0, Math.sin(ph * TAU * 2)) * (ph < 0.5 ? 1 : 0); break; }
    case 'spin': r.rot += (t * 90 * speed) % 360; break;
    case 'wobble': r.rot += 4 * Math.sin(TAU * t * 2.2 * speed); r.dx += 0.01 * Math.sin(TAU * t * 1.1 * speed); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------------------------
// Color pipeline
export function cssFilterFor(clip, extraBlurPx = 0, pxPerUnit = 1) {
  const parts = [];
  const f = FILTER_MAP[clip.filter?.name];
  const k = clamp(clip.filter?.intensity ?? 1, 0, 1);
  if (f) {
    for (const [fn, val] of f.css) {
      const n = NEUTRAL[fn];
      const v = n + (val - n) * k;
      parts.push(fn === 'hue-rotate' ? `hue-rotate(${v.toFixed(1)}deg)` : `${fn}(${v.toFixed(3)})`);
    }
  }
  const a = clip.adjust || {};
  if (a.brightness) parts.push(`brightness(${(1 + a.brightness / 200).toFixed(3)})`);
  if (a.exposure) parts.push(`brightness(${(2 ** (a.exposure / 100)).toFixed(3)})`);
  if (a.contrast) parts.push(`contrast(${(1 + a.contrast / 100).toFixed(3)})`);
  if (a.saturation) parts.push(`saturate(${Math.max(0, 1 + a.saturation / 100).toFixed(3)})`);
  if (a.hue) parts.push(`hue-rotate(${a.hue}deg)`);
  if (a.fade) parts.push(`contrast(${(1 - a.fade / 250).toFixed(3)}) brightness(${(1 + a.fade / 500).toFixed(3)})`);
  const blur = (a.blur ? (a.blur / 100) * 24 : 0) + extraBlurPx;
  if (blur > 0.05) parts.push(`blur(${(blur * pxPerUnit).toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}
function overlaysFor(clip) {
  const out = [];
  const f = FILTER_MAP[clip.filter?.name];
  const k = clamp(clip.filter?.intensity ?? 1, 0, 1);
  if (f?.overlay && k > 0) out.push({ ...f.overlay, alpha: f.overlay.alpha * k });
  const a = clip.adjust || {};
  if (a.temperature) out.push({ color: a.temperature > 0 ? '#ff9d3d' : '#3d8cff', mode: 'soft-light', alpha: (Math.abs(a.temperature) / 100) * 0.55 });
  if (a.tint) out.push({ color: a.tint > 0 ? '#ff3dc8' : '#3dff6a', mode: 'soft-light', alpha: (Math.abs(a.tint) / 100) * 0.45 });
  if (a.vignette) out.push({ vignette: true, alpha: (a.vignette / 100) * 0.85 });
  return out;
}

// Chroma key: remove pixels close to the key color (distance in CbCr space).
// On the GPU (WebGL) where possible (v1.8.3): the CPU version reads the layer back (getImageData), loops over every
// pixel in JavaScript and writes it back — ±80 ms per 1080×1920 frame, which made a green-screen overlay stutter in
// the preview and in exports. The GPU does the same math per pixel in a fragment shader in about a millisecond.
const CHROMA_VS = 'attribute vec2 p; varying vec2 uv; void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }';
const CHROMA_FS = `precision highp float;
varying vec2 uv;
uniform sampler2D tex;
uniform vec2 key;
uniform float sim;
uniform float smooth_;
uniform float spill;
void main() {
  vec4 c = texture2D(tex, uv);
  vec3 rgb = c.rgb;
  float cb = -0.168736 * rgb.r - 0.331264 * rgb.g + 0.5 * rgb.b;
  float cr = 0.5 * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b;
  float dist = distance(vec2(cb, cr), key);
  float a = c.a;
  if (dist < sim) a = 0.0;
  else if (dist < sim + smooth_) {
    a *= (dist - sim) / smooth_;
    if (spill > 0.5) rgb.g = min(rgb.g, max(rgb.r, rgb.b));
  }
  gl_FragColor = vec4(rgb * a, a);
}`;
let chromaGL = null; // null: not tried yet; false: not available here
let gpuChroma = true;
/** Render options (tests and A/B): { gpuChroma: false } keys on the CPU as before v1.8.3. */
export function setRenderOptions(o = {}) { if ('gpuChroma' in o) gpuChroma = !!o.gpuChroma; }
function chromaContext() {
  if (chromaGL !== null) return chromaGL || null;
  chromaGL = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false, alpha: true });
    if (!gl) return null;
    const sh = (type, src) => {
      const o = gl.createShader(type);
      gl.shaderSource(o, src);
      gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) || 'shader');
      return o;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, CHROMA_VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, CHROMA_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const u = (n) => gl.getUniformLocation(prog, n);
    // a lost context (GPU reset, too many contexts) falls back to the CPU until the page is reloaded
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); chromaGL = false; });
    chromaGL = { canvas, gl, key: u('key'), sim: u('sim'), smooth: u('smooth_'), spill: u('spill') };
  } catch (err) {
    console.warn('[najja] GPU chroma key not available, using the CPU:', err?.message || err);
    chromaGL = false;
  }
  return chromaGL || null;
}
/** Key the layer canvas `L` (w×h) on the GPU and copy the result back into it. false: not possible here. */
function chromaKeyGPU(L, lc, w, h, ck) {
  const G = gpuChroma && chromaContext();
  if (!G) return false;
  const { gl, canvas } = G;
  try {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, L);
    const [kr, kg, kb] = hexToRgb(ck.color || '#00ff00').map((v) => v / 255);
    gl.uniform2f(G.key, -0.168736 * kr - 0.331264 * kg + 0.5 * kb, 0.5 * kr - 0.418688 * kg - 0.081312 * kb);
    gl.uniform1f(G.sim, ((ck.similarity ?? 0.4) * 140) / 255);
    gl.uniform1f(G.smooth, Math.max(1, (ck.smoothness ?? 0.08) * 140) / 255);
    gl.uniform1f(G.spill, kg >= kr && kg >= kb ? 1 : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.isContextLost()) return false;
    lc.save();
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalAlpha = 1;
    lc.globalCompositeOperation = 'copy';
    lc.drawImage(canvas, 0, 0, w, h);
    lc.restore();
    return true;
  } catch (err) {
    console.warn('[najja] GPU chroma key failed, using the CPU:', err?.message || err);
    chromaGL = false;
    return false;
  }
}
function chromaKey(lc, w, h, ck) {
  let img;
  try { img = lc.getImageData(0, 0, w, h); } catch { return; }
  const d = img.data;
  const [kr, kg, kb] = hexToRgb(ck.color || '#00ff00');
  const kcb = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
  const kcr = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
  const sim = (ck.similarity ?? 0.4) * 140;
  const smooth = Math.max(1, (ck.smoothness ?? 0.08) * 140);
  // compared squared (no square root per pixel): same result, several times faster than Math.hypot
  const sim2 = sim * sim;
  const outer2 = (sim + smooth) * (sim + smooth);
  const spill = kg >= kr && kg >= kb;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const x = -0.168736 * r - 0.331264 * g + 0.5 * b - kcb;
    const y = 0.5 * r - 0.418688 * g - 0.081312 * b - kcr;
    const dd = x * x + y * y;
    if (dd >= outer2) continue;
    if (dd < sim2) { d[i + 3] = 0; continue; }
    d[i + 3] = d[i + 3] * ((Math.sqrt(dd) - sim) / smooth);
    // spill suppression toward the key color channel
    if (spill) d[i + 1] = Math.min(g, Math.max(r, b));
  }
  lc.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------------------------
// Geometry
export function baseSize(clip, env, ctx) {
  const P = env.project;
  switch (clip.type) {
    case 'video':
    case 'image': {
      const m = env.mediaMeta(clip.mediaId);
      const cr = clip.crop || { l: 0, t: 0, r: 0, b: 0 };
      const sw = Math.max(1, (m?.width || P.width) * (1 - cr.l - cr.r));
      const sh = Math.max(1, (m?.height || P.height) * (1 - cr.t - cr.b));
      const k = Math.min(P.width / sw, P.height / sh);
      return { w: sw * k, h: sh * k };
    }
    case 'solid':
      return { w: P.width, h: P.height };
    case 'text': {
      const L = layoutText(ctx, clip.text);
      return { w: L.boxW, h: L.boxH };
    }
    case 'sticker': {
      if (clip.sticker?.badge) {
        const L = badgeLayout(ctx, clip.sticker.badge);
        return { w: L.w, h: L.h };
      }
      return { w: 220, h: 220 };
    }
    default:
      return { w: 0, h: 0 };
  }
}

export function layoutText(ctx, tx) {
  const weight = fontWeightFor(tx.font, tx.weight);
  ensureFont(tx.font, weight, tx.italic);
  const font = `${tx.italic ? 'italic ' : ''}${weight} ${tx.size}px "${tx.font}", Poppins, sans-serif`;
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${tx.letterSpacing || 0}px`;
  const lines = String(tx.content ?? '').split('\n');
  const widths = lines.map((l) => ctx.measureText(l || ' ').width);
  const lineH = tx.size * (tx.lineHeight || 1.2);
  const w = Math.max(1, ...widths);
  const h = Math.max(lineH, lines.length * lineH);
  const pad = tx.bg?.enabled ? tx.size * 0.38 * (tx.bg.padding ?? 1) : 0;
  const strokePad = tx.stroke?.enabled ? tx.stroke.width : 0;
  return { font, lines, widths, lineH, w, h, pad, boxW: w + pad * 2 + strokePad * 2, boxH: h + pad * 2 + strokePad };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** One run of text in the text's look: shadow, outline, then the fill (ctx.textAlign decides what x is). */
function paintText(ctx, tx, str, x, y, fill, s) {
  ctx.save();
  if (tx.shadow?.enabled) {
    ctx.shadowColor = rgba(tx.shadow.color, tx.shadow.opacity ?? 0.6);
    ctx.shadowBlur = (tx.shadow.blur || 0) * s;
    ctx.shadowOffsetX = (tx.shadow.x || 0) * s;
    ctx.shadowOffsetY = (tx.shadow.y || 0) * s;
  }
  if (tx.stroke?.enabled && tx.stroke.width > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = tx.stroke.width * 2;
    ctx.strokeStyle = tx.stroke.color;
    ctx.strokeText(str, x, y);
    ctx.shadowColor = 'transparent';
  }
  ctx.fillStyle = fill;
  ctx.fillText(str, x, y);
  ctx.restore();
}

function drawText(ctx, clip, reveal, pxScale, spread = 0, local = 0) {
  const tx = spread ? { ...clip.text, letterSpacing: (clip.text.letterSpacing || 0) + spread * clip.text.size } : clip.text;
  const L = layoutText(ctx, tx);
  if (tx.bg?.enabled) {
    ctx.save();
    ctx.fillStyle = rgba(tx.bg.color, tx.bg.opacity ?? 1);
    roundRect(ctx, -L.boxW / 2, -L.boxH / 2, L.boxW, L.boxH, tx.bg.radius ?? 12);
    ctx.fill();
    ctx.restore();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = tx.align || 'center';
  const x = tx.align === 'left' ? -L.w / 2 : tx.align === 'right' ? L.w / 2 : 0;
  const total = L.lines.reduce((a, l) => a + l.length, 0);
  let budget = reveal >= 1 ? Infinity : Math.floor(total * reveal);
  // the fill: the text colour, or its gradient from the top of the text to the bottom (fillAt: for a piece of a
  // kinetic text, whose context may be moved to that piece)
  const grad = (dy) => {
    const g = ctx.createLinearGradient(0, -L.h / 2 + dy, 0, L.h / 2 + dy);
    g.addColorStop(0, tx.gradient.from);
    g.addColorStop(1, tx.gradient.to);
    return g;
  };
  const fill = tx.gradient?.enabled ? grad(0) : tx.color || '#fff';
  const fillAt = (y, moved = false) => (tx.gradient?.enabled ? (moved ? grad(-y) : fill) : fill);
  const s = Math.abs(pxScale) || 1;
  // (v1.12) Teks kinetik: words / letters that move on their own (kinetic.js)
  if (tx.motion?.type && tx.motion.type !== 'none') {
    const o = { local, D: clip.duration, L, tx, reveal, pxScale, epoch: fontEpoch, fillAt, paint: (c, str, px, py, f) => paintText(c, tx, str, px, py, f, s) };
    if (drawKinetic(ctx, o)) {
      if (tx.strike) {
        L.lines.forEach((line, i) => {
          const a = o.lineAlpha ? (o.lineAlpha.has(i) ? o.lineAlpha.get(i) : 1) : 1;
          if (!line || a <= 0.01) return;
          const w = ctx.measureText(line).width;
          const x0 = tx.align === 'left' ? -L.w / 2 : tx.align === 'right' ? L.w / 2 - w : -w / 2;
          const y = -L.h / 2 + i * L.lineH + L.lineH / 2;
          const th = Math.max(2, tx.size * 0.075);
          ctx.save();
          ctx.globalAlpha *= a;
          ctx.fillStyle = tx.strikeColor || (typeof fill === 'string' ? fill : tx.color || '#fff');
          ctx.fillRect(x0 - tx.size * 0.06, y - th / 2 + tx.size * 0.03, w + tx.size * 0.12, th);
          ctx.restore();
        });
      }
      return;
    }
  }
  L.lines.forEach((line, i) => {
    if (budget <= 0) return;
    const shown = budget === Infinity ? line : line.slice(0, budget);
    if (budget !== Infinity) budget -= line.length;
    const y = -L.h / 2 + i * L.lineH + L.lineH / 2;
    ctx.save();
    paintText(ctx, tx, shown, x, y, fill, s);
    if (tx.strike && shown) {
      // (v1.10) struck-through text, e.g. the old price on a price label
      const w = ctx.measureText(shown).width;
      const x0 = tx.align === 'left' ? x : tx.align === 'right' ? x - w : x - w / 2;
      const th = Math.max(2, tx.size * 0.075);
      // (the strike line gets the shadow when the text has no outline, as before)
      if (tx.shadow?.enabled && !(tx.stroke?.enabled && tx.stroke.width > 0)) {
        ctx.shadowColor = rgba(tx.shadow.color, tx.shadow.opacity ?? 0.6);
        ctx.shadowBlur = (tx.shadow.blur || 0) * s;
        ctx.shadowOffsetX = (tx.shadow.x || 0) * s;
        ctx.shadowOffsetY = (tx.shadow.y || 0) * s;
      }
      ctx.fillStyle = tx.strikeColor || fill;
      ctx.fillRect(x0 - tx.size * 0.06, y - th / 2 + tx.size * 0.03, w + tx.size * 0.12, th);
    }
    ctx.restore();
  });
}

function badgeLayout(ctx, b) {
  const size = 64;
  ctx.font = `800 ${size}px Poppins, sans-serif`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
  const tw = ctx.measureText(b.text || '').width;
  const iconW = b.icon ? size * 1.15 : 0;
  return { size, tw, iconW, w: tw + iconW + size * 1.1, h: size * 1.75 };
}
function drawSticker(ctx, clip) {
  const st = clip.sticker || {};
  if (st.badge) {
    const b = st.badge;
    const L = badgeLayout(ctx, b);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = b.bg || '#ff0033';
    roundRect(ctx, -L.w / 2, -L.h / 2, L.w, L.h, L.h / 2);
    ctx.fill();
    ctx.restore();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let x = -L.w / 2 + L.size * 0.55;
    if (b.icon) {
      ctx.font = `${L.size * 0.85}px ${EMOJI_FONT}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.fillStyle = b.fg || '#fff';
      ctx.fillText(b.icon, x, 2);
      x += L.iconW;
    }
    ctx.font = `800 ${L.size}px Poppins, sans-serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
    ctx.fillStyle = b.fg || '#fff';
    ctx.fillText(b.text || '', x, 3);
    return;
  }
  ctx.font = `200px ${EMOJI_FONT}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(st.emoji || '⭐', 0, 12);
}

function solidFill(ctx, solid, w, h) {
  if (solid?.color2) {
    const a = ((solid.angle ?? 135) * Math.PI) / 180;
    const dx = (Math.cos(a) * w) / 2;
    const dy = (Math.sin(a) * h) / 2;
    const g = ctx.createLinearGradient(-dx, -dy, dx, dy);
    g.addColorStop(0, solid.color);
    g.addColorStop(1, solid.color2);
    return g;
  }
  return solid?.color || '#000';
}

// ---------------------------------------------------------------------------------------------
// Layer canvases (for tint overlays / effects)
/**
 * Vignette mask (transparent centre → black edges). It has no detail, so it is drawn once at a small
 * size per aspect ratio and scaled up, instead of rasterising a full-size radial gradient every frame.
 */
const vignettes = new Map();
function vignetteMask(w, h) {
  const k = 512 / Math.max(w, h, 1);
  const vw = Math.max(2, Math.round(w * k));
  const vh = Math.max(2, Math.round(h * k));
  const key = `${vw}x${vh}`;
  let c = vignettes.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = vw;
    c.height = vh;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.25, vw / 2, vh / 2, Math.hypot(vw, vh) / 2);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = gr;
    g.fillRect(0, 0, vw, vh);
    if (vignettes.size > 16) vignettes.clear();
    vignettes.set(key, c);
  }
  return c;
}

const pool = {};
function scratch(name, w, h) {
  let c = pool[name];
  if (!c) c = pool[name] = document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}

/**
 * Draw one visual clip. env: { project, s (canvas px per project unit), source(clip) -> {el,w,h} | null, mediaMeta(id), boxes? }
 * extra: { dx, dy, scale, rot, alpha, blur, clip(ctx) }
 */
export function drawVisualClip(ctx, clip, t, env, extra = {}) {
  // (v1.10.2) effects on the clip itself: only this clip gets them, and they move with it
  if (clip.fx?.length && !extra.noFx && typeof document !== 'undefined') { drawWithClipFx(ctx, clip, t, env, extra); return; }
  const P = env.project;
  const local = clamp(t - clip.start, 0, clip.duration);
  const an = computeAnim(clip, local);
  const kf = clip.keyframes?.length ? (p) => kfValue(clip, p, local) : (p) => clip[p];
  const alpha = clamp((kf('opacity') ?? 1) * an.alpha * (extra.alpha ?? 1), 0, 1);
  if (alpha <= 0.002) return;
  const cx = P.width / 2 + ((kf('x') || 0) + an.dx + (extra.dx || 0)) * P.width;
  const cy = P.height / 2 + ((kf('y') || 0) + an.dy + (extra.dy || 0)) * P.height;
  const sc = (kf('scale') ?? 1) * an.scale * (extra.scale ?? 1);
  const rot = (((kf('rotation') || 0) + an.rot + (extra.rot || 0)) * Math.PI) / 180;
  if (Math.abs(sc) < 0.0005) return;

  let src = null;
  if (clip.type === 'video' || clip.type === 'image') {
    src = env.source(clip);
    if (!src) return;
  }
  const size = baseSize(clip, env, ctx);
  if (env.boxes && !extra.noBox) env.boxes.set(clip.id, { cx, cy, w: size.w * sc, h: size.h * sc, rot });

  ctx.save();
  if (extra.clip) extra.clip(ctx);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = extra.plainBlend ? 'source-over' : clip.blend || 'source-over';
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(sc * (clip.flipH ? -1 : 1), sc * (clip.flipV ? -1 : 1));
  const pxPerUnit = env.s * Math.abs(sc);
  const blurUnits = an.blur + (extra.blur || 0);

  if (src) {
    const cr = clip.crop || { l: 0, t: 0, r: 0, b: 0 };
    const sx = src.w * cr.l;
    const sy = src.h * cr.t;
    const sw = Math.max(1, src.w * (1 - cr.l - cr.r));
    const sh = Math.max(1, src.h * (1 - cr.t - cr.b));
    const filter = cssFilterFor(clip, blurUnits, pxPerUnit);
    const overlays = overlaysFor(clip);
    const chroma = clip.chroma?.enabled;
    // (v1.11) "Hapus latar otomatis": every object in front stays, the background goes (segment.js masks)
    const cutout = clip.cutout?.enabled && !!clip.cutout.masks && typeof document !== 'undefined';
    // An opaque video drawn normally covers its whole rectangle, so colour overlays and the vignette can go
    // straight onto the frame — same result as the separate layer, without a full-size extra copy.
    const direct = overlays.length && !chroma && !cutout && clip.type === 'video' && alpha >= 0.999
      && (clip.blend || 'source-over') === 'source-over' && !/blur\(/.test(filter);
    if (direct) {
      drawFiltered(ctx, filter, src.el, sx, sy, sw, sh, -size.w / 2, -size.h / 2, size.w, size.h);
      for (const ov of overlays) {
        ctx.globalAlpha = clamp(ov.alpha, 0, 1);
        if (ov.vignette) {
          ctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(vignetteMask(size.w, size.h), -size.w / 2, -size.h / 2, size.w, size.h);
        } else {
          ctx.globalCompositeOperation = ov.mode || 'soft-light';
          ctx.fillStyle = ov.color;
          ctx.fillRect(-size.w / 2, -size.h / 2, size.w, size.h);
        }
      }
    } else if (overlays.length || chroma || cutout) {
      let lw = clamp(Math.round(size.w * pxPerUnit), 2, 4096);
      let lh = clamp(Math.round(size.h * pxPerUnit), 2, 4096);
      if (chroma && lw * lh > 1920 * 1080 && !(gpuChroma && chromaContext())) { const r = Math.sqrt((1920 * 1080) / (lw * lh)); lw = Math.round(lw * r); lh = Math.round(lh * r); }
      const L = scratch('layer', lw, lh);
      const lc = L.getContext('2d');
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.globalAlpha = 1;
      lc.globalCompositeOperation = 'source-over';
      lc.clearRect(0, 0, lw, lh);
      drawFiltered(lc, filter, src.el, sx, sy, sw, sh, 0, 0, lw, lh);
      // the mask of this frame (applied last, after the colour overlays)
      const mask = cutout ? cutoutMask(clip, clip.type === 'video' ? Math.round(((clip.in || 0) + local * (clip.speed || 1)) * 1000) / 1000 : 0) : null;
      if (chroma && !chromaKeyGPU(L, lc, lw, lh, clip.chroma)) chromaKey(lc, lw, lh, clip.chroma);
      for (const ov of overlays) {
        lc.globalAlpha = clamp(ov.alpha, 0, 1);
        if (ov.vignette) {
          lc.globalCompositeOperation = 'source-atop';
          lc.drawImage(vignetteMask(lw, lh), 0, 0, lw, lh);
        } else {
          lc.globalCompositeOperation = ov.mode || 'soft-light';
          lc.fillStyle = ov.color;
          lc.fillRect(0, 0, lw, lh);
        }
      }
      if (clip.type === 'image' && !chroma) {
        lc.globalAlpha = 1;
        lc.globalCompositeOperation = 'destination-in';
        lc.drawImage(src.el, sx, sy, sw, sh, 0, 0, lw, lh);
      }
      if (mask) {
        lc.globalAlpha = 1;
        lc.globalCompositeOperation = 'destination-in';
        lc.imageSmoothingEnabled = true;
        lc.imageSmoothingQuality = 'high';
        lc.drawImage(mask, 0, 0, lw, lh);
      }
      ctx.drawImage(L, -size.w / 2, -size.h / 2, size.w, size.h);
    } else {
      drawFiltered(ctx, filter, src.el, sx, sy, sw, sh, -size.w / 2, -size.h / 2, size.w, size.h);
    }
  } else {
    if (blurUnits > 0.05) ctx.filter = `blur(${(blurUnits * pxPerUnit).toFixed(2)}px)`;
    if (clip.type === 'solid') {
      const f = cssFilterFor(clip, blurUnits, pxPerUnit);
      if (f !== 'none') ctx.filter = f;
      ctx.fillStyle = solidFill(ctx, clip.solid, size.w, size.h);
      ctx.fillRect(-size.w / 2, -size.h / 2, size.w, size.h);
    } else if (clip.type === 'text') {
      drawText(ctx, clip, an.reveal, pxPerUnit, an.spread, local);
    } else if (clip.type === 'sticker') {
      drawSticker(ctx, clip);
    }
    ctx.filter = 'none';
  }
  ctx.restore();
}

/**
 * A clip with its own effects (clip.fx, v1.10.2): the clip is drawn alone on a layer as big as the frame, its effects
 * are applied to that layer, the result is kept inside the clip's shape (a flash or snow does not spill over the
 * rest of the frame), and the layer goes onto the frame with the clip's blend mode.
 */
function drawWithClipFx(ctx, clip, t, env, extra) {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const L = scratch('clipfx', cw, ch);
  const lc = L.getContext('2d');
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalAlpha = 1;
  lc.globalCompositeOperation = 'source-over';
  lc.filter = 'none';
  lc.clearRect(0, 0, cw, ch);
  lc.setTransform(ctx.getTransform());
  drawVisualClip(lc, clip, t, env, { ...extra, noFx: true, plainBlend: true });
  const M = scratch('clipfxshape', cw, ch);
  const mc = M.getContext('2d');
  mc.setTransform(1, 0, 0, 1, 0, 0);
  mc.globalCompositeOperation = 'copy';
  mc.drawImage(L, 0, 0);
  const local = clamp(t - clip.start, 0, clip.duration);
  for (const fx of clip.fx.slice(0, 4)) if (fx?.type) applyEffect(lc, fx, t, local, clip.duration);
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalAlpha = 1;
  lc.globalCompositeOperation = 'destination-in';
  lc.drawImage(M, 0, 0);
  lc.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = clip.blend || 'source-over';
  ctx.filter = 'none';
  ctx.drawImage(L, 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Transitions on the main track (between prev clip A and next clip B)
function drawTransition(ctx, A, B, t, p, type, env) {
  const P = env.project;
  const W = P.width;
  const H = P.height;
  const e = ease.inOutCubic(p);
  switch (type) {
    case 'fade':
      drawVisualClip(ctx, A, t, env, { noBox: true });
      drawVisualClip(ctx, B, t, env, { alpha: e });
      break;
    case 'black':
    case 'white': {
      const col = type === 'black' ? '#000' : '#fff';
      if (p < 0.5) drawVisualClip(ctx, A, t, env);
      else drawVisualClip(ctx, B, t, env);
      ctx.save();
      ctx.globalAlpha = 1 - Math.abs(p - 0.5) * 2;
      ctx.fillStyle = col;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      break;
    }
    case 'slideLeft': drawVisualClip(ctx, A, t, env, { dx: -e, noBox: true }); drawVisualClip(ctx, B, t, env, { dx: 1 - e }); break;
    case 'slideRight': drawVisualClip(ctx, A, t, env, { dx: e, noBox: true }); drawVisualClip(ctx, B, t, env, { dx: e - 1 }); break;
    case 'slideUp': drawVisualClip(ctx, A, t, env, { dy: -e, noBox: true }); drawVisualClip(ctx, B, t, env, { dy: 1 - e }); break;
    case 'slideDown': drawVisualClip(ctx, A, t, env, { dy: e, noBox: true }); drawVisualClip(ctx, B, t, env, { dy: e - 1 }); break;
    case 'zoomIn':
      drawVisualClip(ctx, A, t, env, { scale: 1 + e * 0.6, alpha: 1 - e, noBox: true });
      drawVisualClip(ctx, B, t, env, { scale: 0.75 + 0.25 * e, alpha: e });
      break;
    case 'zoomOut':
      drawVisualClip(ctx, A, t, env, { scale: 1 - 0.5 * e, alpha: 1 - e, noBox: true });
      drawVisualClip(ctx, B, t, env, { scale: 1.4 - 0.4 * e, alpha: e });
      break;
    case 'wipeLeft':
    case 'wipeRight':
    case 'wipeUp':
    case 'wipeDown': {
      drawVisualClip(ctx, A, t, env, { noBox: true });
      const clipFn = (c) => {
        c.beginPath();
        if (type === 'wipeLeft') c.rect(W * (1 - e), 0, W * e + 1, H);
        else if (type === 'wipeRight') c.rect(0, 0, W * e, H);
        else if (type === 'wipeUp') c.rect(0, H * (1 - e), W, H * e + 1);
        else c.rect(0, 0, W, H * e);
        c.clip();
      };
      drawVisualClip(ctx, B, t, env, { clip: clipFn });
      break;
    }
    case 'circle':
      drawVisualClip(ctx, A, t, env, { noBox: true });
      drawVisualClip(ctx, B, t, env, { clip: (c) => { c.beginPath(); c.arc(W / 2, H / 2, (Math.hypot(W, H) / 2) * e, 0, Math.PI * 2); c.clip(); } });
      break;
    case 'blur':
      if (p < 0.5) drawVisualClip(ctx, A, t, env, { blur: e * 40, noBox: true });
      else drawVisualClip(ctx, B, t, env, { blur: (1 - e) * 40 });
      break;
    case 'spin':
      if (p < 0.5) drawVisualClip(ctx, A, t, env, { rot: e * 180, scale: 1 - e, noBox: true });
      else drawVisualClip(ctx, B, t, env, { rot: (e - 1) * 180, scale: e });
      break;
    case 'glitch': {
      const pick = hash(Math.floor(t * 30)) > p ? A : B;
      const off = (hash(Math.floor(t * 30) + 7) - 0.5) * 0.08 * Math.sin(p * Math.PI);
      drawVisualClip(ctx, pick, t, env, { dx: off });
      break;
    }
    // v1.10 (Style Konsep)
    case 'punch': {
      // zoom punch: the shot rushes in, blurred by the motion, and the next one lands from the same zoom
      if (p < 0.5) { const q = p * 2; drawVisualClip(ctx, A, t, env, { scale: 1 + 0.35 * q * q, blur: 16 * q, noBox: true }); }
      else { const q = (p - 0.5) * 2; drawVisualClip(ctx, B, t, env, { scale: 1.35 - 0.35 * (1 - (1 - q) ** 2), blur: 16 * (1 - q) }); }
      break;
    }
    case 'leak': {
      // light leak: a warm glow sweeps over the cut
      drawVisualClip(ctx, p < 0.5 ? A : B, t, env, p < 0.5 ? { noBox: true } : {});
      const k = Math.sin(Math.PI * p);
      const R = Math.max(W, H);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const x1 = W * (0.1 + 0.8 * p);
      const y1 = H * (0.3 + 0.12 * Math.sin(p * 3));
      let g = ctx.createRadialGradient(x1, y1, 0, x1, y1, R * 0.75);
      g.addColorStop(0, `rgba(255,178,92,${(0.95 * k).toFixed(3)})`);
      g.addColorStop(0.45, `rgba(255,96,58,${(0.5 * k).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,70,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      const x2 = W * (0.95 - 0.7 * p);
      g = ctx.createRadialGradient(x2, H * 0.78, 0, x2, H * 0.78, R * 0.5);
      g.addColorStop(0, `rgba(255,128,170,${(0.6 * k).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,128,170,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      break;
    }
    case 'pixelate': {
      drawVisualClip(ctx, p < 0.5 ? A : B, t, env, p < 0.5 ? { noBox: true } : {});
      const cw = ctx.canvas.width;
      const ch = ctx.canvas.height;
      const block = Math.round(Math.sin(Math.PI * p) * (Math.min(cw, ch) / 16));
      if (block > 1) {
        const sw = Math.max(1, Math.round(cw / block));
        const sh = Math.max(1, Math.round(ch / block));
        const s = scratch('pixelate', sw, sh);
        const sc = s.getContext('2d');
        sc.imageSmoothingEnabled = true;
        sc.drawImage(ctx.canvas, 0, 0, sw, sh);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(s, 0, 0, cw, ch);
        ctx.restore();
      }
      break;
    }
    default:
      drawVisualClip(ctx, p < 0.5 ? A : B, t, env);
  }
}

/** Which main-track clips are visible at time t (handles transition overlap windows). */
/** v1.6 reference: what is on the main track at t (linear scan). The renderer uses plan.js mainStateAt; tests compare the two. */
export function mainTrackState(list, t) {
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const next = list[i + 1];
    const prev = list[i - 1];
    if (next && next.transition?.type && next.transition.type !== 'none' && Math.abs(next.start - (c.start + c.duration)) < 0.01) {
      const d = Math.min(next.transition.duration || 0.6, c.duration, next.duration);
      if (t >= next.start - d / 2 && t < next.start + d / 2) return { A: c, B: next, p: (t - (next.start - d / 2)) / d, type: next.transition.type };
    }
    if (t >= c.start && t < c.start + c.duration) {
      if (prev && c.transition?.type && c.transition.type !== 'none' && Math.abs(c.start - (prev.start + prev.duration)) < 0.01) {
        const d = Math.min(c.transition.duration || 0.6, c.duration, prev.duration);
        if (t < c.start + d / 2) return { A: prev, B: c, p: (t - (c.start - d / 2)) / d, type: c.transition.type };
      }
      return { clip: c };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Full-frame effects (operate in canvas pixel space)
let noiseTile = null;
function getNoise() {
  if (noiseTile) return noiseTile;
  noiseTile = document.createElement('canvas');
  noiseTile.width = noiseTile.height = 256;
  const c = noiseTile.getContext('2d');
  const img = c.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(hash(i * 7 + 13) * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return noiseTile;
}
function copyFrame(ctx) {
  const c = scratch('fxcopy', ctx.canvas.width, ctx.canvas.height);
  const cc = c.getContext('2d');
  cc.globalCompositeOperation = 'copy';
  cc.drawImage(ctx.canvas, 0, 0);
  cc.globalCompositeOperation = 'source-over';
  return c;
}
function rgbSplit(ctx, amount) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const src = copyFrame(ctx);
  const r = scratch('fxR', W, H);
  const rc = r.getContext('2d');
  rc.globalCompositeOperation = 'copy';
  rc.drawImage(src, 0, 0);
  rc.globalCompositeOperation = 'multiply';
  rc.fillStyle = '#ff0000';
  rc.fillRect(0, 0, W, H);
  const g = scratch('fxG', W, H);
  const gc = g.getContext('2d');
  gc.globalCompositeOperation = 'copy';
  gc.drawImage(src, 0, 0);
  gc.globalCompositeOperation = 'multiply';
  gc.fillStyle = '#00ffff';
  gc.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(r, -amount, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(g, amount, 0);
  ctx.restore();
}
function particles(ctx, kind, t, k) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const m = Math.min(W, H);
  const N = Math.round((kind === 'confetti' ? 90 : kind === 'sparkle' ? 40 : 70) * (0.4 + k));
  ctx.save();
  for (let i = 0; i < N; i++) {
    const r1 = rand2(i, 1);
    const r2 = rand2(i, 2);
    const r3 = rand2(i, 3);
    const speed = 0.05 + r2 * 0.12;
    switch (kind) {
      case 'snow': {
        const y = ((r3 + t * speed) % 1.1) - 0.05;
        const x = r1 + Math.sin(t * (0.5 + r2) + i) * 0.02;
        ctx.globalAlpha = 0.6 + 0.4 * r2;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x * W, y * H, m * (0.003 + r2 * 0.006), 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'hearts':
      case 'bubbles': {
        const y = 1.05 - ((r3 + t * speed * 0.8) % 1.15);
        const x = r1 + Math.sin(t * 1.3 + i) * 0.03;
        const size = m * (0.02 + r2 * 0.03);
        ctx.globalAlpha = Math.min(1, (1.05 - y) * 2) * 0.9;
        if (kind === 'hearts') {
          ctx.font = `${size}px ${EMOJI_FONT}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(['❤️', '💖', '💕'][i % 3], x * W, y * H);
        } else {
          ctx.strokeStyle = 'rgba(200,240,255,0.85)';
          ctx.lineWidth = Math.max(1, size * 0.08);
          ctx.beginPath();
          ctx.arc(x * W, y * H, size * 0.6, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'confetti': {
        const y = ((r3 + t * (speed + 0.08)) % 1.1) - 0.05;
        const x = r1 + Math.sin(t * 2 + i) * 0.015;
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = ['#ffd43b', '#ff6b6b', '#4dabf7', '#69db7c', '#da77f2', '#ffa94d'][i % 6];
        ctx.save();
        ctx.translate(x * W, y * H);
        ctx.rotate(t * (2 + r2 * 4) + i);
        ctx.fillRect(-m * 0.006, -m * 0.012, m * 0.012, m * 0.024);
        ctx.restore();
        break;
      }
      case 'sparkle': {
        const ph = (t * (0.6 + r2) + r3) % 1;
        const a = Math.sin(ph * Math.PI);
        const size = m * (0.01 + r2 * 0.025) * a;
        ctx.globalAlpha = a;
        ctx.fillStyle = '#fff6c2';
        ctx.save();
        ctx.translate(r1 * W, rand2(i, 4) * H);
        ctx.beginPath();
        for (let j = 0; j < 8; j++) {
          const rr = j % 2 ? size * 0.25 : size;
          const ang = (j * Math.PI) / 4;
          ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      default: break;
    }
  }
  ctx.restore();
}

/** Filter / adjustment layer: recolours everything drawn so far (the whole frame). */
export function applyAdjustLayer(ctx, clip, pxPerUnit = 1) {
  const k = clamp(clip.effect?.intensity ?? 1, 0, 1);
  if (k <= 0) return;
  const filter = cssFilterFor(clip, 0, pxPerUnit);
  const overlays = overlaysFor(clip);
  if (filter === 'none' && !overlays.length) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (filter !== 'none') {
    const src = copyFrame(ctx);
    ctx.globalAlpha = k;
    drawFiltered(ctx, filter, src, 0, 0);
  }
  for (const ov of overlays) {
    ctx.globalAlpha = clamp(ov.alpha * k, 0, 1);
    if (ov.vignette) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(vignetteMask(W, H), 0, 0, W, H);
    } else {
      ctx.globalCompositeOperation = ov.mode || 'soft-light';
      ctx.fillStyle = ov.color;
      ctx.fillRect(0, 0, W, H);
    }
  }
  ctx.restore();
}

export function applyEffect(ctx, fx, t, local, dur) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const k = clamp(fx.intensity ?? 0.7, 0, 1);
  const frame = Math.floor(t * 30);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  switch (fx.type) {
    case 'shake': {
      const src = copyFrame(ctx);
      const a = 0.025 * k;
      const dx = (hash(frame) - 0.5) * a * W;
      const dy = (hash(frame + 31) - 0.5) * a * H;
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(src, -W * a * 0.5 + dx, -H * a * 0.5 + dy, W * (1 + a), H * (1 + a));
      break;
    }
    case 'zoomPulse': {
      const src = copyFrame(ctx);
      const z = 1 + 0.1 * k * Math.abs(Math.sin(local * Math.PI * 2)) ** 2;
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(src, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z);
      break;
    }
    case 'flash': {
      const ph = (local * 1.25) % 1;
      ctx.globalAlpha = k * Math.max(0, 1 - ph * 4);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'strobe':
      if (Math.floor(local * 8) % 2) {
        const src = copyFrame(ctx);
        ctx.globalCompositeOperation = 'copy';
        drawFiltered(ctx, `invert(${k}) grayscale(1)`, src, 0, 0);
      }
      break;
    case 'rainbow': {
      const src = copyFrame(ctx);
      ctx.globalCompositeOperation = 'copy';
      drawFiltered(ctx, `hue-rotate(${(local * 180 * (0.5 + k)) % 360}deg) saturate(${1 + k * 0.6})`, src, 0, 0);
      break;
    }
    case 'glitch': {
      if (hash(frame * 3 + 1) < 0.25 + k * 0.5) {
        rgbSplit(ctx, W * (0.006 + hash(frame) * 0.02) * k);
        const src = copyFrame(ctx);
        const bands = 2 + Math.floor(hash(frame + 5) * 5);
        for (let i = 0; i < bands; i++) {
          const y = hash(frame * 13 + i) * H;
          const h = (0.02 + hash(frame * 7 + i) * 0.08) * H;
          const off = (hash(frame * 11 + i) - 0.5) * W * 0.12 * k;
          ctx.drawImage(src, 0, y, W, h, off, y, W, h);
        }
      }
      break;
    }
    case 'rgbSplit':
      rgbSplit(ctx, W * 0.012 * k * (0.7 + 0.3 * Math.sin(local * 6)));
      break;
    case 'vhs': {
      rgbSplit(ctx, W * 0.004 * (0.5 + k));
      ctx.globalAlpha = 0.18 * (0.5 + k);
      ctx.fillStyle = '#000';
      const step = Math.max(2, Math.round(H / 270));
      for (let y = 0; y < H; y += step * 2) ctx.fillRect(0, y, W, step);
      ctx.globalAlpha = 0.12 * k;
      const by = ((local * 0.35) % 1.2) * H - H * 0.1;
      ctx.drawImage(getNoise(), 0, (frame * 37) % 200, 256, 40, 0, by, W, H * 0.06);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.round(H * 0.045)}px "Courier New", monospace`;
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = 4;
      ctx.fillText('PLAY ►', W * 0.05, H * 0.06);
      ctx.fillText(`SP ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`, W * 0.05, H * 0.88);
      break;
    }
    case 'grain': {
      ctx.globalAlpha = 0.22 * k;
      ctx.globalCompositeOperation = 'overlay';
      const n = getNoise();
      const ox = Math.floor(hash(frame) * 256);
      const oy = Math.floor(hash(frame + 1) * 256);
      const tile = Math.max(128, Math.round(Math.min(W, H) / 4));
      for (let y = -oy % tile - tile; y < H; y += tile) for (let x = -ox % tile - tile; x < W; x += tile) ctx.drawImage(n, x, y, tile, tile);
      break;
    }
    case 'bw': {
      // (v1.9: through drawFiltered — on an iPad the canvas filter did nothing, so this effect did nothing)
      const src = copyFrame(ctx);
      ctx.globalCompositeOperation = 'copy';
      drawFiltered(ctx, `grayscale(${0.35 + 0.65 * k}) contrast(${1 + 0.2 * k})`, src, 0, 0);
      break;
    }
    case 'vignette': {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${0.9 * k})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case 'blur': {
      // drawn over the sharp frame (not 'copy'): the blurred picture fades out at the borders, and the frame under
      // it keeps the borders from going dark. Stronger than v1.8 (1.2% of the short side at most): 1–4%.
      const src = copyFrame(ctx);
      drawFiltered(ctx, `blur(${(Math.min(W, H) * (0.01 + 0.03 * k)).toFixed(1)}px)`, src, 0, 0);
      break;
    }
    case 'dreamy': {
      const src = copyFrame(ctx);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.55 * k;
      drawFiltered(ctx, `blur(${(Math.min(W, H) * 0.02).toFixed(1)}px) brightness(1.1)`, src, 0, 0);
      break;
    }
    case 'letterbox': {
      const target = W / 2.39;
      const bar = Math.max(0, (H - target) / 2) * Math.min(1, local / 0.4) * Math.min(1, (dur - local) / 0.4) * (0.5 + k / 2);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
      break;
    }
    case 'mirror': {
      const src = copyFrame(ctx);
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(src, 0, 0, W / 2, H, 0, 0, W / 2, H);
      break;
    }
    case 'snow':
    case 'hearts':
    case 'confetti':
    case 'sparkle':
    case 'bubbles':
      particles(ctx, fx.type, local, k);
      break;
    default: break;
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
/** Compose the whole frame. env: { project, s, source, mediaMeta, boxes } */
export function renderFrame(ctx, t, env) {
  const P = env.project;
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.fillStyle = P.background?.color || '#000';
  ctx.fillRect(0, 0, cw, ch);
  ctx.setTransform(env.s, 0, 0, env.s, 0, 0);
  env.boxes?.clear();
  // Tracks, clip order and the clip index come from the compiled plan (built once per project change), so a frame
  // only looks at the clips near t. Callers without a plan (rare) get one compiled here.
  const plan = env.plan?.project === P ? env.plan : compilePlan(P);

  if (P.background?.mode === 'blur' && !plan.mainHidden) {
    const st = mainStateAt(plan, t);
    const c = st?.clip || st?.B;
    if (c && (c.type === 'video' || c.type === 'image')) {
      const src = env.source(c);
      if (src) {
        const k = Math.max(P.width / src.w, P.height / src.h) * 1.08;
        ctx.save();
        drawFiltered(ctx, `blur(${(((P.background.blur ?? 40) / 100) * 60 * env.s).toFixed(1)}px) brightness(0.85)`, src.el, (P.width - src.w * k) / 2, (P.height - src.h * k) / 2, src.w * k, src.h * k);
        ctx.restore();
      }
    }
  }

  // Layers bottom to top. An effect (or a filter/adjust layer) changes what is drawn so far — the layers under it;
  // the layers above it stay as they are (v1.10.1 "Lapisan" for effects; effects on top change everything, as before).
  for (const { tr, idx, effect } of plan.layers || [...plan.visual, ...plan.effects.map((e) => ({ ...e, effect: true }))]) {
    if (effect) {
      for (const c of clipsAt(idx, t)) {
        if (c.effect?.type === 'adjust') applyAdjustLayer(ctx, c, env.s);
        else applyEffect(ctx, c.effect, t, t - c.start, c.duration);
      }
    } else if (tr.kind === 'main') {
      const st = mainStateAt(plan, t);
      if (!st) continue;
      if (st.clip) drawVisualClip(ctx, st.clip, t, env);
      else drawTransition(ctx, st.A, st.B, t, clamp(st.p, 0, 1), st.type, env);
    } else {
      for (const c of clipsAt(idx, t)) drawVisualClip(ctx, c, t, env);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
