// CSS-style canvas filters on the GPU (v1.9): for browsers whose 2D canvas ignores ctx.filter.
//
// Safari (iPad) did not ship CanvasRenderingContext2D.filter for years, and where it has it, canvases that are not in
// the page keep "none" (WebKit bugs 198416, 276135). Najja draws through such canvases, so on an iPad every filter
// preset, adjustment, and the Black & White / Blur / Rainbow / Dreamy effects did nothing. This module applies the
// same filter functions — brightness, contrast, saturate, grayscale, sepia, hue-rotate, invert, opacity (the colour
// matrices of the Filter Effects spec, clamped after each one like the browser does) and blur (a separable Gaussian;
// large radii are blurred at a lower resolution) — in WebGL, plus a sharpen used by the Crystal Clear / 4K filters.
//
// drawFiltered(ctx, filter, img, sx, sy, sw, sh, dx, dy, dw, dh) draws like ctx.drawImage with ctx.filter = filter:
// natively where the canvas filter works, else on the GPU, else unfiltered (never an error).

const pool = {};
function scratch(name, w, h) {
  let c = pool[name];
  if (!c) c = pool[name] = document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}

let native = null; // does ctx.filter work on a canvas that is not in the page?
let forceGpu = false;
/** Tests and A/B: { gpuFilters: true } uses the GPU even where the canvas filter works. */
export function setFilterOptions(o = {}) { if ('gpuFilters' in o) forceGpu = !!o.gpuFilters; }
export function nativeFilter() {
  if (forceGpu) return false;
  if (native !== null) return native;
  native = false;
  try {
    const a = document.createElement('canvas');
    a.width = 2; a.height = 1;
    const ac = a.getContext('2d');
    ac.fillStyle = '#ff0000';
    ac.fillRect(0, 0, 2, 1);
    const b = document.createElement('canvas');
    b.width = 2; b.height = 1;
    const bc = b.getContext('2d', { willReadFrequently: true });
    bc.filter = 'grayscale(1)';
    if (bc.filter !== 'grayscale(1)') return false;
    bc.drawImage(a, 0, 0);
    const d = bc.getImageData(0, 0, 1, 1).data;
    native = Math.abs(d[0] - d[1]) < 8 && Math.abs(d[1] - d[2]) < 8 && d[3] > 200;
  } catch { native = false; }
  return native;
}

// ---- filter string → operations --------------------------------------------------------------------
const num = (v, pct = true) => {
  const s = String(v).trim();
  if (s.endsWith('%')) return parseFloat(s) / 100;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : (pct ? 1 : 0);
};
/** 3×3 matrix (row-major) and offset for one colour function; null for unknown ones. */
function colorOp(name, a) {
  switch (name) {
    case 'brightness': return { m: [a, 0, 0, 0, a, 0, 0, 0, a], o: [0, 0, 0] };
    case 'contrast': return { m: [a, 0, 0, 0, a, 0, 0, 0, a], o: [0.5 - 0.5 * a, 0.5 - 0.5 * a, 0.5 - 0.5 * a] };
    case 'invert': return { m: [1 - 2 * a, 0, 0, 0, 1 - 2 * a, 0, 0, 0, 1 - 2 * a], o: [a, a, a] };
    case 'saturate': return { m: [0.213 + 0.787 * a, 0.715 - 0.715 * a, 0.072 - 0.072 * a, 0.213 - 0.213 * a, 0.715 + 0.285 * a, 0.072 - 0.072 * a, 0.213 - 0.213 * a, 0.715 - 0.715 * a, 0.072 + 0.928 * a], o: [0, 0, 0] };
    case 'grayscale': {
      const g = 1 - Math.min(1, a);
      return { m: [0.2126 + 0.7874 * g, 0.7152 - 0.7152 * g, 0.0722 - 0.0722 * g, 0.2126 - 0.2126 * g, 0.7152 + 0.2848 * g, 0.0722 - 0.0722 * g, 0.2126 - 0.2126 * g, 0.7152 - 0.7152 * g, 0.0722 + 0.9278 * g], o: [0, 0, 0] };
    }
    case 'sepia': {
      const g = 1 - Math.min(1, a);
      return { m: [0.393 + 0.607 * g, 0.769 - 0.769 * g, 0.189 - 0.189 * g, 0.349 - 0.349 * g, 0.686 + 0.314 * g, 0.168 - 0.168 * g, 0.272 - 0.272 * g, 0.534 - 0.534 * g, 0.131 + 0.869 * g], o: [0, 0, 0] };
    }
    case 'hue-rotate': {
      const c = Math.cos(a);
      const s = Math.sin(a);
      return {
        m: [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
          0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
          0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
        o: [0, 0, 0],
      };
    }
    default: return null;
  }
}
/** { blur: px, ops: [{m, o}], opacity, sharpen } from a CSS filter string (plus the Najja-only sharpen(amount)). */
export function parseFilter(str) {
  const out = { blur: 0, ops: [], opacity: 1, sharpen: 0 };
  if (!str || str === 'none') return out;
  for (const [, name, arg] of String(str).matchAll(/([a-z-]+)\(([^)]*)\)/g)) {
    if (name === 'blur') out.blur += Math.max(0, parseFloat(arg) || 0);
    else if (name === 'opacity') out.opacity *= Math.max(0, Math.min(1, num(arg)));
    else if (name === 'sharpen') out.sharpen += Math.max(0, num(arg, false));
    else if (name === 'hue-rotate') {
      const s = String(arg).trim();
      const deg = s.endsWith('rad') ? (parseFloat(s) * 180) / Math.PI : s.endsWith('turn') ? parseFloat(s) * 360 : parseFloat(s) || 0;
      out.ops.push(colorOp(name, (deg * Math.PI) / 180));
    } else {
      const op = colorOp(name, Math.max(0, num(arg)));
      if (op) out.ops.push(op);
    }
  }
  return out;
}
/** The filter without sharpen() (what a native canvas filter understands). */
const cssOnly = (str) => String(str || 'none').replace(/sharpen\([^)]*\)/g, '').trim() || 'none';

// ---- WebGL ------------------------------------------------------------------------------------------
const MAX_OPS = 8;
const VS = 'attribute vec2 p; varying vec2 uv; void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }';
// (render-to-texture passes keep the texture's orientation: v not flipped)
const VS_FBO = 'attribute vec2 p; varying vec2 uv; void main() { uv = (p + 1.0) * 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
const FS_COLOR = `precision highp float;
varying vec2 uv;
uniform sampler2D tex;
uniform int count;
uniform mat3 m[${MAX_OPS}];
uniform vec3 o[${MAX_OPS}];
uniform float opacity;
uniform float sharpen;
uniform vec2 texel;
uniform bool premul;
vec4 fetch(vec2 p) {
  vec4 c = texture2D(tex, p);
  if (premul && c.a > 0.0) c.rgb /= c.a;
  return c;
}
void main() {
  vec4 c = fetch(uv);
  vec3 rgb = c.rgb;
  if (sharpen > 0.0) {
    // unsharp mask on a 3×3 neighbourhood (clarity for "Crystal Clear" / "4K")
    vec3 blur = (fetch(uv + vec2(texel.x, 0.0)).rgb + fetch(uv - vec2(texel.x, 0.0)).rgb + fetch(uv + vec2(0.0, texel.y)).rgb + fetch(uv - vec2(0.0, texel.y)).rgb) * 0.25;
    rgb = clamp(rgb + (rgb - blur) * sharpen, 0.0, 1.0);
  }
  for (int i = 0; i < ${MAX_OPS}; i++) {
    if (i >= count) break;
    rgb = clamp(m[i] * rgb + o[i], 0.0, 1.0);
  }
  float a = c.a * opacity;
  gl_FragColor = vec4(rgb * a, a);
}`;
// one direction of a separable Gaussian (17 taps), on premultiplied colour
const FS_BLUR = `precision highp float;
varying vec2 uv;
uniform sampler2D tex;
uniform vec2 dir;
uniform float sigma;
void main() {
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -8; i <= 8; i++) {
    float x = float(i) * max(1.0, sigma * 3.0 / 8.0);
    float w = exp(-0.5 * x * x / max(0.0001, sigma * sigma));
    sum += texture2D(tex, uv + dir * x) * w;
    wsum += w;
  }
  gl_FragColor = sum / wsum;
}`;

let G = null; // null: not tried; false: not available
function setup() {
  if (G !== null) return G || null;
  G = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false, alpha: true });
    if (!gl) return null;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const program = (vs, fs) => {
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'p');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
      return p;
    };
    const color = program(VS, FS_COLOR);
    const blur = program(VS_FBO, FS_BLUR);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const texture = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const fbo = () => ({ fb: gl.createFramebuffer(), tex: texture(), w: 0, h: 0 });
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); G = false; });
    G = { canvas, gl, color, blur, src: texture(), a: fbo(), b: fbo() };
  } catch (err) {
    console.warn('[najja] GPU filters not available:', err?.message || err);
    G = false;
  }
  return G || null;
}
function sizeFbo(gl, f, w, h) {
  if (f.w === w && f.h === h) return;
  gl.bindTexture(gl.TEXTURE_2D, f.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
  f.w = w;
  f.h = h;
}
function colorUniforms(gl, prog, F, w, h, premul) {
  gl.uniform1i(gl.getUniformLocation(prog, 'count'), Math.min(MAX_OPS, F.ops.length));
  F.ops.slice(0, MAX_OPS).forEach((op, i) => {
    // GLSL mat3 is column-major
    const m = op.m;
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, `m[${i}]`), false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
    gl.uniform3fv(gl.getUniformLocation(prog, `o[${i}]`), op.o);
  });
  gl.uniform1f(gl.getUniformLocation(prog, 'opacity'), F.opacity);
  gl.uniform1f(gl.getUniformLocation(prog, 'sharpen'), F.sharpen);
  gl.uniform2f(gl.getUniformLocation(prog, 'texel'), 1 / w, 1 / h);
  gl.uniform1i(gl.getUniformLocation(prog, 'premul'), premul ? 1 : 0);
}

/**
 * The image `src` (any drawImage source already at w×h: a canvas) filtered with F on the GPU. Returns the GL canvas
 * (valid until the next call) or null.
 */
function gpuFilter(src, w, h, F) {
  const S = setup();
  if (!S) return null;
  const { gl, canvas } = S;
  try {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.bindTexture(gl.TEXTURE_2D, S.src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); // blur averages premultiplied colour
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    let tex = S.src;
    let tw = w;
    let th = h;
    if (F.blur > 0.3) {
      // big radii at a lower resolution: the kernel stays within its 17 taps (σ ≤ ±6 px after scaling)
      const f = Math.max(1, Math.ceil(F.blur / 6));
      tw = Math.max(1, Math.round(w / f));
      th = Math.max(1, Math.round(h / f));
      const sigma = F.blur / f;
      sizeFbo(gl, S.a, tw, th);
      sizeFbo(gl, S.b, tw, th);
      gl.useProgram(S.blur);
      gl.viewport(0, 0, tw, th);
      // horizontal: src → a (the texture's rows are in upload order; VS_FBO keeps them)
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.a.fb);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform2f(gl.getUniformLocation(S.blur, 'dir'), 1 / w * (w / tw), 0);
      gl.uniform1f(gl.getUniformLocation(S.blur, 'sigma'), sigma);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // vertical: a → b
      gl.bindFramebuffer(gl.FRAMEBUFFER, S.b.fb);
      gl.bindTexture(gl.TEXTURE_2D, S.a.tex);
      gl.uniform2f(gl.getUniformLocation(S.blur, 'dir'), 0, 1 / th);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      tex = S.b.tex;
    }
    // colour (and sharpen) into the canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(S.color);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    colorUniforms(gl, S.color, F, tw, th, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.isContextLost()) return null;
    return canvas;
  } catch (err) {
    console.warn('[najja] GPU filter failed:', err?.message || err);
    G = false;
    return null;
  }
}

const sizeOf = (img) => [img.displayWidth || img.videoWidth || img.naturalWidth || img.width || 1, img.displayHeight || img.videoHeight || img.naturalHeight || img.height || 1];

/**
 * ctx.drawImage(img, …) with ctx.filter = filter, on every browser. Args: (dx, dy[, dw, dh]) or (sx, sy, sw, sh, dx,
 * dy, dw, dh), as for drawImage. sharpen(amount) (Najja's own) works only on the GPU path; the native path gets the
 * CSS part plus the GPU sharpen when it is asked for.
 */
export function drawFiltered(ctx, filter, img, ...args) {
  let [sx, sy, sw, sh, dx, dy, dw, dh] = args;
  if (args.length <= 4) {
    const [iw, ih] = sizeOf(img);
    [sx, sy, sw, sh] = [0, 0, iw, ih];
    [dx, dy] = args;
    dw = args.length === 4 ? args[2] : iw;
    dh = args.length === 4 ? args[3] : ih;
  }
  const F = parseFilter(filter);
  const plain = !F.ops.length && F.blur <= 0 && F.opacity === 1 && !F.sharpen;
  if (plain) { ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh); return; }
  if (nativeFilter() && !F.sharpen) {
    const prev = ctx.filter;
    ctx.filter = cssOnly(filter);
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.filter = prev;
    return;
  }
  // GPU: the source crop at its size on the canvas (blur radii are canvas pixels), filtered, then drawn
  const t = ctx.getTransform ? ctx.getTransform() : { a: 1, b: 0, c: 0, d: 1 };
  const sxScale = Math.hypot(t.a, t.b) || 1;
  const syScale = Math.hypot(t.c, t.d) || 1;
  const w = Math.max(1, Math.min(4096, Math.round(Math.abs(dw) * sxScale)));
  const h = Math.max(1, Math.min(4096, Math.round(Math.abs(dh) * syScale)));
  const stage = scratch('gpufx-in', w, h);
  const sc = stage.getContext('2d');
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.globalCompositeOperation = 'copy';
  sc.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  sc.globalCompositeOperation = 'source-over';
  const out = gpuFilter(stage, w, h, F);
  ctx.drawImage(out || stage, 0, 0, w, h, dx, dy, dw, dh);
}

/** Whole-canvas filter (effects): ctx's own pixels, filtered, drawn back with the current composite settings. */
export function filterCanvas(ctx, filter, copy) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawFiltered(ctx, filter, copy, 0, 0, W, H, 0, 0, W, H);
  ctx.restore();
}
