// Third-party files the editor runs in the browser (v1.10.3: MediaPipe for "Hapus otomatis", background removal of
// people in videos). Najja has no npm dependencies and the browser loads nothing from a CDN: the server fetches a
// pinned version once (npm registry tarball / model file), checks its sha256, keeps the files in the data folder and
// serves them under /vendor/<name>-<version>/.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const VENDOR = {
  mediapipe: {
    version: '0.10.35',
    license: 'Apache-2.0',
    source: 'https://www.npmjs.com/package/@mediapipe/tasks-vision',
    tarball: 'https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.35.tgz',
    sha256: '84597a25e13d123b5f4cbe768bb72e97a2c28c7a465f0ace287d8cbe5246bff0',
    // served path → path in the tarball
    files: {
      'vision_bundle.mjs': 'package/vision_bundle.mjs',
      'wasm/vision_wasm_internal.js': 'package/wasm/vision_wasm_internal.js',
      'wasm/vision_wasm_internal.wasm': 'package/wasm/vision_wasm_internal.wasm',
      'wasm/vision_wasm_nosimd_internal.js': 'package/wasm/vision_wasm_nosimd_internal.js',
      'wasm/vision_wasm_nosimd_internal.wasm': 'package/wasm/vision_wasm_nosimd_internal.wasm',
    },
    // separate files: the person segmentation model (MediaPipe Selfie Segmentation, Apache-2.0)
    extra: {
      'selfie_segmenter.tflite': {
        url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
        sha256: '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b',
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

export function createVendor({ dir, fetchImpl = (...a) => fetch(...a), log = () => {} }) {
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
        const files = untar(zlib.gunzipSync(await download(spec.tarball, spec.sha256)));
        for (const [served, inTar] of Object.entries(spec.files)) {
          const data = files.get(inTar);
          if (!data) throw new Error(`${inTar} tidak ada di paket ${name} ${spec.version}`);
          await fsp.mkdir(path.dirname(path.join(tmp, served)), { recursive: true });
          await fsp.writeFile(path.join(tmp, served), data);
        }
        for (const [served, x] of Object.entries(spec.extra || {})) await fsp.writeFile(path.join(tmp, served), await download(x.url, x.sha256));
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

  /** "/vendor/mediapipe-0.10.35/wasm/x.wasm" → { name, file } of a known file, or null. */
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
