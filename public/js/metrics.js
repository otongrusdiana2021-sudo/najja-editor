// Performance metrics (blueprint 9.1): a small in-memory collector, no network, no third party.
// Samples are kept in fixed-size rings (memory stays flat however long the editor is open).
// Menu ⋯ → Diagnostik shows a summary and copies the JSON for bug reports and benchmarks;
// bench/run.mjs reads window.najjaMetrics.snapshot().

const RING = 600;
const rings = new Map(); // name -> { buf: Float64Array, n }
const counters = new Map();
const gauges = new Map();
const events = []; // last notable runs (exports, imports): { kind, at, ...data }
const t0 = performance.now();

function ring(name) {
  let r = rings.get(name);
  if (!r) { r = { buf: new Float64Array(RING), n: 0 }; rings.set(name, r); }
  return r;
}
function pct(sorted, f) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] : null; }
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

export const metrics = {
  /** Record one value (ms, fps, …). */
  sample(name, v) {
    if (!Number.isFinite(v)) return;
    const r = ring(name);
    r.buf[r.n % RING] = v;
    r.n++;
  },
  count(name, n = 1) { counters.set(name, (counters.get(name) || 0) + n); },
  gauge(name, v) { gauges.set(name, v); },
  event(kind, data = {}) {
    events.push({ kind, at: Math.round(performance.now() - t0), ...data });
    if (events.length > 40) events.shift();
  },
  /** Returns stop(): records the time since start(). */
  timer(name) { const s = performance.now(); return () => { const ms = performance.now() - s; this.sample(name, ms); return ms; }; },
  /** Time from `since` (performance.now() / event.timeStamp) until the next frame is painted. */
  afterPaint(name, since) {
    requestAnimationFrame(() => setTimeout(() => this.sample(name, performance.now() - since), 0));
  },
  stats(name) {
    const r = rings.get(name);
    if (!r || !r.n) return null;
    const vals = Array.from(r.buf.subarray(0, Math.min(r.n, RING))).sort((a, b) => a - b);
    const sum = vals.reduce((a, b) => a + b, 0);
    return { n: r.n, avg: r1(sum / vals.length), p50: r1(pct(vals, 0.5)), p95: r1(pct(vals, 0.95)), max: r1(vals[vals.length - 1]) };
  },
  reset() { rings.clear(); counters.clear(); events.length = 0; },

  /** Everything, plus device and memory facts, as plain JSON. */
  async snapshot(extra = {}) {
    const series = {};
    for (const name of [...rings.keys()].sort()) series[name] = this.stats(name);
    const mem = performance.memory ? { jsHeapUsedMB: r1(performance.memory.usedJSHeapSize / 1048576), jsHeapLimitMB: r1(performance.memory.jsHeapSizeLimit / 1048576) } : {};
    let storage = null;
    try { const e = await navigator.storage?.estimate?.(); if (e) storage = { usageMB: r1(e.usage / 1048576), quotaMB: r1(e.quota / 1048576) }; } catch { /* not available */ }
    return {
      at: new Date().toISOString(),
      uptimeS: Math.round((performance.now() - t0) / 1000),
      device: await deviceInfo(),
      memory: { ...mem, storage },
      series,
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      events: [...events],
      ...extra,
    };
  },
};

let devCache = null;
/** What this device can do (codecs, storage, GPU): needed to compare numbers between devices. */
export async function deviceInfo() {
  if (devCache) return devCache;
  if (typeof document === 'undefined') return {}; // tests (Node)
  const codec = async (c) => {
    try { return !!(await window.VideoDecoder?.isConfigSupported({ codec: c, codedWidth: 1920, codedHeight: 1080 }))?.supported; } catch { return false; }
  };
  let gpu = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = { webgl2: !!document.createElement('canvas').getContext('webgl2'), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? 'tersembunyi' : null) };
  } catch { /* no webgl */ }
  devCache = {
    ua: navigator.userAgent,
    platform: navigator.userAgentData?.platform || navigator.platform || null,
    cores: navigator.hardwareConcurrency || null,
    deviceMemoryGB: navigator.deviceMemory || null,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio || 1}x`,
    touch: navigator.maxTouchPoints > 0,
    webcodecs: { decoder: !!window.VideoDecoder, encoder: !!window.VideoEncoder, h264: await codec('avc1.640028'), hevc: await codec('hvc1.1.6.L120.90') },
    opfs: !!navigator.storage?.getDirectory,
    rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' && !!window.crossOriginIsolated,
    gpu,
    connection: navigator.connection ? { type: navigator.connection.effectiveType, downlinkMbps: navigator.connection.downlink, rttMs: navigator.connection.rtt } : null,
  };
  return devCache;
}

// ---- UI responsiveness: long tasks and slow interactions (where the browser reports them)
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      metrics.count('long_tasks_over_50ms');
      metrics.count('main_thread_blocked_ms', Math.round(e.duration - 50));
      metrics.sample('long_task_ms', e.duration);
    }
  }).observe({ type: 'longtask', buffered: true });
} catch { /* Safari/Firefox: no long task API */ }
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.interactionId) metrics.sample('interaction_ms', e.duration);
  }).observe({ type: 'event', durationThreshold: 40, buffered: true });
} catch { /* no Event Timing API */ }

// Event-loop lag (works in Safari, which has no long-task API): how late a 250 ms timer fires.
if (typeof window !== 'undefined') {
  let expect = performance.now() + 250;
  setInterval(() => {
    const now = performance.now();
    const lag = now - expect;
    expect = now + 250;
    if (document.visibilityState === 'visible') { metrics.sample('event_loop_lag_ms', Math.max(0, lag)); if (lag > 100) metrics.count('event_loop_stalls_over_100ms'); }
  }, 250);
  window.najjaMetrics = metrics;
}
