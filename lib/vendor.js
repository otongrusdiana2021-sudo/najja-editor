// Third-party files the editor runs in the browser (v1.11: onnxruntime-web and the BiRefNet model for "Hapus latar
// otomatis" on the device's GPU). Najja has no npm dependencies and the browser loads nothing from a CDN: the server
// fetches a pinned version once (npm registry tarball / model file — or takes the AI service's copy), checks its
// sha256, keeps the files in the data folder and serves them under /vendor/<name>-<version>/.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

// The AI service's own "cutout" model: same file, same pinned version as ai/models.json (test/vendor.test.js checks
// they match). Written out here, not read from ai/: the editor's Docker image has no ai/ folder (only the AI
// service's image has it) — v1.11.0 read that file at start and the editor container did not start.
const CUTOUT_MODEL = {
  file: 'birefnet-lite-512.onnx',
  url: 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/962e67969ec6acec9c19fab76acee4f5e22e990c/onnx/model.onnx',
  sha256: '1cb0fb360dadd15af77c639085d77a9df67db0c64315560c3de005f676345ac2',
  size: 191877254,
  license: 'MIT',
  source: 'https://huggingface.co/studioludens/birefnet-lite-512 (BiRefNet, Zheng Peng et al.)',
};

export const VENDOR = {
  // v1.11 "Hapus latar otomatis" on the device's GPU (bgdevice.js): onnxruntime-web, WebGPU build
  onnxruntime: {
    version: '1.29.0',
    license: 'MIT',
    source: 'https://www.npmjs.com/package/onnxruntime-web',
    tarball: 'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.29.0.tgz',
    sha256: '7a934b7811c3b050ecfb7619722e2b4de771ce6da20520e17a2018a440316ef3',
    files: {
      'ort.webgpu.min.mjs': 'package/dist/ort.webgpu.min.mjs',
      'ort-wasm-simd-threaded.asyncify.mjs': 'package/dist/ort-wasm-simd-threaded.asyncify.mjs',
      'ort-wasm-simd-threaded.asyncify.wasm': 'package/dist/ort-wasm-simd-threaded.asyncify.wasm',
    },
  },
  // BiRefNet lite 512 (MIT): taken from the AI service's models folder when it has it (Docker: the shared volume),
  // else downloaded from its pinned source
  birefnet: {
    version: '512',
    license: CUTOUT_MODEL.license,
    source: CUTOUT_MODEL.source,
    files: {},
    extra: {
      'model.onnx': { url: CUTOUT_MODEL.url, sha256: CUTOUT_MODEL.sha256, size: CUTOUT_MODEL.size, local: ['models', CUTOUT_MODEL.file] },
    },
  },
  // v1.12.4 Style Konsep keeps texts off faces (faces.js): Ultra-Light-Fast face detector RFB-320 (Apache-2.0, 1.3 MB),
  // run on the device with onnxruntime-web's WebAssembly backend (no GPU needed)
  ultraface: {
    version: '320',
    license: 'Apache-2.0',
    source: 'https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB (ONNX Model Zoo: version-RFB-320)',
    files: {},
    extra: {
      'model.onnx': {
        url: 'https://huggingface.co/onnxmodelzoo/version-RFB-320/resolve/6fd293d22b523ec88959f104b8eef5395e3adfbc/version-RFB-320.onnx',
        sha256: '34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017',
        size: 1270727,
      },
    },
  },
  // v1.12.5 Style Konsep keeps texts off the whole person (faces.js): MediaPipe Selfie Segmentation, general 256×256
  // (Apache-2.0, 0.46 MB), on the device with WebAssembly — where in the picture a person is
  selfie: {
    version: '256',
    license: 'Apache-2.0',
    source: 'https://huggingface.co/onnx-community/mediapipe_selfie_segmentation (MediaPipe Selfie Segmentation, Google)',
    files: {},
    extra: {
      'model.onnx': {
        url: 'https://huggingface.co/onnx-community/mediapipe_selfie_segmentation/resolve/be49485c8e027524be38591817fc5cd31bd9d00e/onnx/model.onnx',
        sha256: '3241ac4ad8aa35bdaf33946776db29f7c283a413aa0b0dacb9483594b4531aad',
        size: 462352,
      },
    },
  },
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const cstr = (b, at, len) => { const s = b.subarray(at, at + len); const z = s.indexOf(0); return s.subarray(0, z < 0 ? len : z).toString('utf8'); };

/** The regular files of a tar archive: Map(name → Buffer). (ustar; pax/GNU long-name records are skipped.) */
export function untar(buf) {
  const out = new Map();
  let o = 0;
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const name = cstr(h, 0, 100);
    const prefix = cstr(h, 345, 155);
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    o += 512;
    if (type === '0' || type === '\0' || h[156] === 0) out.set(prefix ? `${prefix}/${name}` : name, buf.subarray(o, o + size));
    o += Math.ceil(size / 512) * 512;
  }
  return out;
}

async function sha256File(p) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(p)) h.update(chunk);
  return h.digest('hex');
}

/** dataDir: where a local copy of a file may already be (extra[].local is relative to it). */
export function createVendor({ dir, dataDir = path.dirname(dir), modelDirs = [], fetchImpl = (...a) => fetch(...a), log = () => {} }) {
  const pending = new Map();
  const failed = new Map(); // name → { at, message }: a failed download is retried after a minute, not on every request

  async function download(url, want) {
    const r = await fetchImpl(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${new URL(url).host} menjawab HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = sha256(buf);
    if (got !== want) throw new Error(`file dari ${new URL(url).host} tidak cocok (sha256 ${got.slice(0, 12)}…)`);
    return buf;
  }

  /** A big file straight to disk while its sha256 is computed (no 190 MB in memory). */
  async function downloadTo(url, want, file) {
    const r = await fetchImpl(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${new URL(url).host} menjawab HTTP ${r.status}`);
    const h = crypto.createHash('sha256');
    const out = fs.createWriteStream(file);
    try {
      if (r.body?.getReader) {
        const reader = r.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          h.update(value);
          if (!out.write(value)) await new Promise((ok) => out.once('drain', ok));
        }
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        h.update(buf);
        out.write(buf);
      }
    } finally {
      await new Promise((ok) => out.end(ok));
    }
    const got = h.digest('hex');
    if (got !== want) throw new Error(`file dari ${new URL(url).host} tidak cocok (sha256 ${got.slice(0, 12)}…)`);
  }

  /** The folder with the files of `name`, fetched and checked the first time. */
  function ensure(name) {
    const spec = VENDOR[name];
    if (!spec) return Promise.reject(new Error(`unknown vendor package ${name}`));
    const base = path.join(dir, `${name}-${spec.version}`);
    if (fs.existsSync(path.join(base, '.ok'))) return Promise.resolve(base);
    const f = failed.get(name);
    if (f && Date.now() - f.at < 60_000) return Promise.reject(new Error(f.message));
    if (pending.has(name)) return pending.get(name);
    const p = (async () => {
      log(`Mengunduh ${name} ${spec.version} (sekali saja)…`);
      const tmp = `${base}.tmp-${process.pid}-${Date.now()}`;
      await fsp.mkdir(tmp, { recursive: true });
      try {
        const files = spec.tarball ? untar(zlib.gunzipSync(await download(spec.tarball, spec.sha256))) : new Map();
        for (const [served, inTar] of Object.entries(spec.files)) {
          const data = files.get(inTar);
          if (!data) throw new Error(`${inTar} tidak ada di paket ${name} ${spec.version}`);
          await fsp.mkdir(path.dirname(path.join(tmp, served)), { recursive: true });
          await fsp.writeFile(path.join(tmp, served), data);
        }
        for (const [served, x] of Object.entries(spec.extra || {})) {
          // a copy already on this server (the AI service's model), when it is the same file
          const candidates = x.local ? [path.join(dataDir, ...x.local), ...modelDirs.filter(Boolean).map((d) => path.join(d, x.local.at(-1)))] : [];
          let found = null;
          for (const local of candidates) {
            if (fs.existsSync(local) && (!x.size || fs.statSync(local).size === x.size) && (await sha256File(local)) === x.sha256) { found = local; break; }
          }
          if (found) {
            try { await fsp.link(found, path.join(tmp, served)); } catch { await fsp.copyFile(found, path.join(tmp, served)); }
            continue;
          }
          await downloadTo(x.url, x.sha256, path.join(tmp, served));
        }
        await fsp.writeFile(path.join(tmp, '.ok'), JSON.stringify({ version: spec.version, at: new Date().toISOString(), license: spec.license }));
        await fsp.rm(base, { recursive: true, force: true });
        await fsp.rename(tmp, base);
        log(`${name} ${spec.version} siap.`);
        failed.delete(name);
        return base;
      } catch (err) {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        failed.set(name, { at: Date.now(), message: err.message });
        throw err;
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, p);
    return p;
  }

  /** "/vendor/onnxruntime-1.29.0/ort.webgpu.min.mjs" → { name, file } of a known file, or null. */
  function resolve(urlPath) {
    const m = /^\/vendor\/([a-z]+)-([\w.]+)\/(.+)$/.exec(urlPath);
    if (!m) return null;
    const spec = VENDOR[m[1]];
    if (!spec || spec.version !== m[2]) return null;
    const file = m[3];
    if (!(file in spec.files) && !(file in (spec.extra || {}))) return null;
    return { name: m[1], file };
  }

  return { ensure, resolve, status: (name) => ({ ready: fs.existsSync(path.join(dir, `${name}-${VENDOR[name]?.version}`, '.ok')), error: failed.get(name)?.message || null }) };
}
