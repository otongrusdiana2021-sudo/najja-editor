// Server-side storage: projects (JSON), media library (original files + thumbnails/waveforms), chunked uploads.
// Everything lives under NAJJA_DATA_DIR on the server (the VPS) — nothing is kept in the browser.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const ID_PROJECT = /^p_[a-z0-9]{4,40}$/;
const ID_MEDIA = /^m_[a-z0-9]{4,40}$/;
const ID_UPLOAD = /^[A-Za-z0-9_-]{8,64}$/;
export const CHUNK_LIMIT = 16 * 1024 * 1024;

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
async function freeBytes(dir) {
  try {
    const s = await fsp.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

export function createStorage(dataDir, { exportDir, extFor }) {
  const PROJECTS = path.join(dataDir, 'projects');
  const LIBRARY = path.join(dataDir, 'library');
  const UPLOADS = path.join(dataDir, 'uploads');
  const ready = Promise.all([PROJECTS, LIBRARY, UPLOADS, exportDir].map((d) => fsp.mkdir(d, { recursive: true })));

  const projectFile = (id) => {
    if (!ID_PROJECT.test(id)) throw httpError(400, 'Invalid project id');
    return path.join(PROJECTS, `${id}.json`);
  };
  const mediaDir = (id) => {
    if (!ID_MEDIA.test(id)) throw httpError(400, 'Invalid media id');
    return path.join(LIBRARY, id);
  };
  const uploadDir = (id) => {
    if (!ID_UPLOAD.test(id)) throw httpError(400, 'Invalid upload id');
    return path.join(UPLOADS, id);
  };

  async function ensureSpace(bytes) {
    const free = await freeBytes(dataDir);
    if (free < bytes + 512 * 1024 * 1024) throw httpError(507, 'Disk VPS hampir penuh. Hapus media atau hasil ekspor lama dulu.');
  }

  return {
    ready,
    dirs: { PROJECTS, LIBRARY, UPLOADS },
    mediaDir,

    // ---- projects
    async listProjects() {
      await ready;
      const out = [];
      for (const f of await fsp.readdir(PROJECTS)) {
        if (!f.endsWith('.json')) continue;
        const p = await readJson(path.join(PROJECTS, f)).catch(() => null);
        if (!p?.id) continue;
        out.push({ id: p.id, name: p.name, aspect: p.aspect, width: p.width, height: p.height, duration: p.duration || 0, updatedAt: p.updatedAt || 0, createdAt: p.createdAt || 0, thumb: p.thumb, clips: p.clips?.length || 0, media: p.media?.length || 0 });
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async getProject(id) {
      await ready;
      const p = await readJson(projectFile(id));
      if (!p) throw httpError(404, 'Project not found');
      return p;
    },
    async putProject(id, project) {
      await ready;
      if (!project || project.id !== id) throw httpError(400, 'Project id mismatch');
      await writeAtomic(projectFile(id), JSON.stringify(project));
      return { ok: true, updatedAt: project.updatedAt };
    },
    async deleteProject(id) {
      await ready;
      await fsp.rm(projectFile(id), { force: true });
      return { ok: true };
    },

    // ---- media library
    async getMeta(id) {
      const m = await readJson(path.join(mediaDir(id), 'meta.json'));
      if (!m) throw httpError(404, 'Media not found');
      return m;
    },
    async putMeta(id, meta) {
      const dir = mediaDir(id);
      await fsp.mkdir(dir, { recursive: true });
      const existing = (await readJson(path.join(dir, 'meta.json'))) || {};
      const merged = { ...meta, file: existing.file || meta.file, mime: existing.mime || meta.mime, size: existing.size || meta.size };
      await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(merged));
      return { ok: true };
    },
    peaksPath: (id) => path.join(mediaDir(id), 'peaks.bin'),
    async putPeaks(id, buf) {
      const dir = mediaDir(id);
      await fsp.mkdir(dir, { recursive: true });
      await writeAtomic(path.join(dir, 'peaks.bin'), buf);
      return { ok: true };
    },
    async mediaFile(id) {
      const m = await this.getMeta(id).catch(() => null);
      const dir = mediaDir(id);
      const name = m?.file || (await fsp.readdir(dir).catch(() => [])).find((f) => f.startsWith('source'));
      if (!name) throw httpError(404, 'Media file not found');
      return path.join(dir, path.basename(name));
    },
    /** Delete a media item unless another project (other than `exceptProject`) still uses it. */
    async deleteMedia(id, exceptProject) {
      const dir = mediaDir(id);
      for (const f of await fsp.readdir(PROJECTS)) {
        if (!f.endsWith('.json') || f === `${exceptProject}.json`) continue;
        const p = await readJson(path.join(PROJECTS, f)).catch(() => null);
        if (p?.media?.some((m) => m.id === id)) return { ok: true, kept: true };
      }
      await fsp.rm(dir, { recursive: true, force: true });
      return { ok: true, kept: false };
    },
    /** Place a server-side file (download cache / local path) into the library without re-uploading. */
    async adoptFile(id, src, { filename, mime, move }) {
      const dir = mediaDir(id);
      await fsp.mkdir(dir, { recursive: true });
      const ext = extFor(filename, mime);
      const dest = path.join(dir, `source${ext}`);
      if (move) {
        try { await fsp.rename(src, dest); } catch { await fsp.copyFile(src, dest); await fsp.rm(src, { force: true }); }
      } else await fsp.copyFile(src, dest);
      const stat = await fsp.stat(dest);
      await writeAtomic(path.join(dir, 'meta.json'), JSON.stringify({ ...((await readJson(path.join(dir, 'meta.json'))) || {}), file: path.basename(dest), mime, size: stat.size }));
      return { ok: true, size: stat.size };
    },

    // ---- chunked uploads (each request stays far below proxy body limits such as aaPanel's 50 MB)
    async putChunk(uploadId, index, req) {
      await ready;
      if (!Number.isInteger(index) || index < 0 || index > 100000) throw httpError(400, 'Invalid chunk index');
      const dir = uploadDir(uploadId);
      await fsp.mkdir(dir, { recursive: true });
      await ensureSpace(CHUNK_LIMIT);
      const tmp = path.join(dir, `${index}.part.tmp`);
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > CHUNK_LIMIT) req.destroy(httpError(413, 'Chunk too large'));
      });
      await pipeline(req, fs.createWriteStream(tmp));
      await fsp.rename(tmp, path.join(dir, `${index}.part`));
      return { ok: true, size };
    },
    async finishUpload(uploadId, { parts, size, target, mediaId, filename, mime }) {
      const dir = uploadDir(uploadId);
      if (!Number.isInteger(parts) || parts < 1) throw httpError(400, 'Invalid parts');
      let dest;
      if (target === 'media') {
        const mdir = mediaDir(mediaId);
        await fsp.mkdir(mdir, { recursive: true });
        dest = path.join(mdir, `source${extFor(filename, mime)}`);
      } else if (target === 'export') {
        const safe = String(filename || `najja-${Date.now()}.mp4`).normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').replace(/^\.+/, '').slice(0, 120) || `najja-${Date.now()}.mp4`;
        const ext = path.extname(safe) || '.mp4';
        let file = safe.endsWith(ext) ? safe : `${safe}${ext}`;
        if (fs.existsSync(path.join(exportDir, file))) file = `${path.basename(file, ext)}-${Date.now().toString(36)}${ext}`;
        dest = path.join(exportDir, file);
      } else throw httpError(400, 'Invalid upload target');
      await ensureSpace(size || 0);
      const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      const out = fs.createWriteStream(tmp);
      out.setMaxListeners(parts + 16); // one pipeline per chunk reuses this stream
      try {
        for (let i = 0; i < parts; i++) {
          const part = path.join(dir, `${i}.part`);
          if (!fs.existsSync(part)) throw httpError(400, `Missing chunk ${i}`);
          await pipeline(fs.createReadStream(part), out, { end: false });
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
        const stat = await fsp.stat(tmp);
        if (size != null && stat.size !== size) throw httpError(400, `Size mismatch (${stat.size} != ${size})`);
        await fsp.rename(tmp, dest);
      } catch (err) {
        out.destroy();
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      await fsp.rm(dir, { recursive: true, force: true });
      const stat = await fsp.stat(dest);
      if (target === 'media') {
        const mdir = path.dirname(dest);
        const meta = (await readJson(path.join(mdir, 'meta.json'))) || {};
        await writeAtomic(path.join(mdir, 'meta.json'), JSON.stringify({ ...meta, file: path.basename(dest), mime, size: stat.size }));
      }
      return { ok: true, path: dest, file: path.basename(dest), size: stat.size };
    },
    async cleanupUploads(maxAgeMs = 24 * 3600 * 1000) {
      await ready;
      for (const d of await fsp.readdir(UPLOADS).catch(() => [])) {
        const full = path.join(UPLOADS, d);
        const st = await fsp.stat(full).catch(() => null);
        if (st && Date.now() - st.mtimeMs > maxAgeMs) await fsp.rm(full, { recursive: true, force: true });
      }
    },
  };
}
