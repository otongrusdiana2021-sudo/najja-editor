// Server (VPS) storage client: projects, media library and chunked uploads.
import { metrics } from './metrics.js';
const CHUNK = 8 * 1024 * 1024; // well below common proxy limits (aaPanel nginx defaults to 50 MB per request)

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) {
    location.href = '/login';
    throw new Error('Sesi login habis');
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    let data = null;
    try { data = await r.json(); msg = data.error || msg; } catch { /* ignore */ }
    throw Object.assign(new Error(msg), { status: r.status, data });
  }
  return r;
}
const json = (body) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

function putChunk(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Object.assign(new Error(`Upload gagal (HTTP ${xhr.status})`), { status: xhr.status })));
    xhr.onerror = () => reject(new Error('Koneksi terputus saat upload'));
    xhr.send(blob);
  });
}

export const remote = {
  enabled: false,
  pending: 0,

  async listProjects() { return (await api('/api/projects')).json(); },
  async getProject(id) { return (await api(`/api/projects/${encodeURIComponent(id)}`)).json(); },
  /** baseRev: the revision this save builds on (409 when another device saved since); force: overwrite anyway. */
  async putProject(rec, { baseRev = null, force = false } = {}) {
    const q = baseRev != null ? `?baseRev=${baseRev}${force ? '&force=1' : ''}` : '';
    return (await api(`/api/projects/${encodeURIComponent(rec.id)}${q}`, { method: 'PUT', ...json(rec) })).json();
  },
  async projectRev(id) { return (await api(`/api/projects/${encodeURIComponent(id)}/rev`, { cache: 'no-store' })).json(); },
  async deleteProject(id) { return (await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })).json(); },

  mediaUrl: (id) => `/api/media/${encodeURIComponent(id)}/file`,
  /** H.264 playback copy made by the server for files a browser may not decode (e.g. HEVC). */
  proxyUrl: (id, v) => `/api/media/${encodeURIComponent(id)}/proxy${v ? `?v=${v}` : ''}`,
  /** Light 720p copy the preview plays (made by the server for heavy videos). */
  editUrl: (id, v) => `/api/media/${encodeURIComponent(id)}/edit?v=${v || 0}`,
  /** Filmstrip / poster made by the server. */
  assetUrl: (id, kind, q = '') => `/api/media/${encodeURIComponent(id)}/${kind}${q}`,
  async proxyStatus(id) { return (await api(`/api/media/${encodeURIComponent(id)}/proxy-status`)).json(); },
  async requestProxy(id, force = false) { return (await api(`/api/media/${encodeURIComponent(id)}/proxy`, { method: 'POST', ...json({ force }) })).json(); },
  async getMeta(id) { return (await api(`/api/media/${encodeURIComponent(id)}/meta`)).json(); },
  async putMeta(id, meta) { return (await api(`/api/media/${encodeURIComponent(id)}/meta`, { method: 'PUT', ...json(meta) })).json(); },
  async getPeaks(id) {
    const buf = new Uint8Array(await (await api(`/api/media/${encodeURIComponent(id)}/peaks`)).arrayBuffer());
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 255;
    return out;
  },
  async putPeaks(id, peaks) {
    const q = new Uint8Array(peaks.length);
    for (let i = 0; i < peaks.length; i++) q[i] = Math.round(Math.max(0, Math.min(1, peaks[i])) * 255);
    return (await api(`/api/media/${encodeURIComponent(id)}/peaks`, { method: 'PUT', body: q })).json();
  },
  async adopt(id, source, filename, mime) {
    return (await api(`/api/media/${encodeURIComponent(id)}/adopt`, { method: 'POST', ...json({ source, filename, mime }) })).json();
  },
  async deleteMedia(id, projectId) {
    return (await api(`/api/media/${encodeURIComponent(id)}?project=${encodeURIComponent(projectId || '')}`, { method: 'DELETE' })).json();
  },

  /** Upload a Blob in chunks with retries. target: 'media' (needs mediaId) | 'export'. */
  async upload(blob, { target, mediaId, filename, mime, onProgress } = {}) {
    const id = rid();
    const parts = Math.max(1, Math.ceil(blob.size / CHUNK));
    const loaded = new Float64Array(parts);
    const report = () => onProgress?.(Math.min(1, loaded.reduce((a, b) => a + b, 0) / Math.max(1, blob.size)));
    this.pending++;
    try {
      // Three chunks in flight: much faster to a far-away VPS than one request at a time.
      let next = 0;
      const worker = async () => {
        while (next < parts) {
          const i = next++;
          const chunk = blob.slice(i * CHUNK, Math.min(blob.size, (i + 1) * CHUNK));
          for (let attempt = 1; ; attempt++) {
            try {
              await putChunk(`/api/upload/${id}/${i}`, chunk, (n) => { loaded[i] = n; report(); });
              loaded[i] = chunk.size;
              report();
              break;
            } catch (err) {
              loaded[i] = 0;
              if (err.status === 401) { location.href = '/login'; throw err; }
              if (err.status === 507 || err.status === 413 || attempt >= 5) throw err;
              metrics.count('upload_retry_count');
              await sleep(1000 * 2 ** (attempt - 1));
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, parts) }, worker));
      onProgress?.(1);
      return (await api(`/api/upload/${id}/finish`, { method: 'POST', ...json({ parts, size: blob.size, target, mediaId, filename, mime }) })).json();
    } finally {
      this.pending--;
    }
  },
};
