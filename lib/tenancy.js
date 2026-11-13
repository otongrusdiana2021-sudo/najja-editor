// Data ownership (tenant isolation). Every project, media item, upload, export and download belongs to one owner:
// the id of the user it was created for, taken from the verified session/token on the server, never from the
// request body. Records from before v1.7 have no owner; they belong to the primary owner (the first admin), and
// the migration below writes that down explicitly, after backing up every file it touches.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Owner id used when the server runs without accounts (local mode). */
export const LOCAL_OWNER = 'local';

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
async function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/**
 * @param dataDir      NAJJA_DATA_DIR
 * @param exportDir    folder with exported videos
 * @param primaryOwner () => id of the primary owner (first admin, or LOCAL_OWNER)
 */
export function createTenancy({ dataDir, exportDir, primaryOwner, log = () => {} }) {
  const PROJECTS = path.join(dataDir, 'projects');
  const LIBRARY = path.join(dataDir, 'library');
  const BACKUPS = path.join(dataDir, 'backups');
  const EXPORT_INDEX = path.join(dataDir, 'exports-index.json');
  let exportIndex = null;

  /** Who owns a record: its ownerId, or the primary owner for legacy/local-mode records. */
  function ownerOf(rec) {
    const o = rec?.ownerId;
    return !o || o === LOCAL_OWNER ? primaryOwner() : o;
  }
  const owns = (rec, who) => !!who?.id && ownerOf(rec) === who.id;

  // ---- exports: files live in one folder; an index records whose they are (legacy files: primary owner)
  async function loadExportIndex() {
    if (!exportIndex) exportIndex = (await readJson(EXPORT_INDEX)) || {};
    return exportIndex;
  }
  async function recordExport(file, ownerId) {
    const idx = await loadExportIndex();
    idx[file] = ownerId;
    await writeAtomic(EXPORT_INDEX, JSON.stringify(idx));
  }
  async function exportOwner(file) {
    const idx = await loadExportIndex();
    return idx[file] && idx[file] !== LOCAL_OWNER ? idx[file] : primaryOwner();
  }

  // ---- migration of data from before owners existed
  async function legacyFiles() {
    const projects = [];
    for (const f of await fsp.readdir(PROJECTS).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(PROJECTS, f);
      const p = await readJson(file).catch(() => null);
      if (p?.id && (!p.ownerId || p.ownerId === LOCAL_OWNER)) projects.push(file);
    }
    const media = [];
    for (const d of await fsp.readdir(LIBRARY).catch(() => [])) {
      const file = path.join(LIBRARY, d, 'meta.json');
      const m = await readJson(file).catch(() => null);
      if (m && (!m.ownerId || m.ownerId === LOCAL_OWNER)) media.push(file);
    }
    const idx = await loadExportIndex();
    const exports = [];
    for (const f of await fsp.readdir(exportDir).catch(() => [])) {
      if (f.endsWith('.tmp') || f.startsWith('.')) continue;
      if (!idx[f] || idx[f] === LOCAL_OWNER) exports.push(f);
    }
    return { projects, media, exports };
  }

  /** Copy files into a backup folder, keeping their path relative to the data folder. */
  async function backup(files, label) {
    const dir = path.join(BACKUPS, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const dest = path.join(dir, path.relative(dataDir, file));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(file, dest);
    }
    return dir;
  }

  /**
   * Give every record without an owner to `owner` (the primary owner). Idempotent.
   * dryRun: only report what would change. Otherwise: back up, write, verify, and log to the backup folder.
   */
  async function migrate({ owner = primaryOwner(), dryRun = false, extraBackup = [] } = {}) {
    const todo = await legacyFiles();
    const report = { owner, projects: todo.projects.length, media: todo.media.length, exports: todo.exports.length, backup: null };
    const total = report.projects + report.media + report.exports;
    // Local-mode data stays "local" until accounts exist (it then goes to the first admin).
    if (dryRun || !total || !owner || owner === LOCAL_OWNER) return { ...report, applied: false };
    const files = [...todo.projects, ...todo.media, ...(fs.existsSync(EXPORT_INDEX) ? [EXPORT_INDEX] : []), ...extraBackup];
    report.backup = await backup(files, 'v1.7-owner-migration');
    for (const file of [...todo.projects, ...todo.media]) {
      const rec = await readJson(file);
      if (!rec || (rec.ownerId && rec.ownerId !== LOCAL_OWNER)) continue;
      rec.ownerId = owner;
      await writeAtomic(file, JSON.stringify(rec));
    }
    if (todo.exports.length) {
      const idx = await loadExportIndex();
      for (const f of todo.exports) idx[f] = owner;
      await writeAtomic(EXPORT_INDEX, JSON.stringify(idx));
    }
    // Verify: nothing left without an owner.
    const left = await legacyFiles();
    const remaining = left.projects.length + left.media.length + left.exports.length;
    await writeAtomic(path.join(report.backup, 'migration.json'), JSON.stringify({ ...report, remaining, at: new Date().toISOString() }, null, 2));
    if (remaining) throw new Error(`owner migration incomplete: ${remaining} records left (backup: ${report.backup})`);
    log(`data lama diberikan ke pemilik utama: ${report.projects} proyek, ${report.media} media, ${report.exports} ekspor (backup: ${report.backup})`);
    return { ...report, applied: true };
  }

  /** Explicit admin action (deleting a user): their data goes to another owner. Backed up and logged. */
  async function transfer(fromId, toId) {
    const files = [];
    for (const f of await fsp.readdir(PROJECTS).catch(() => [])) {
      const file = path.join(PROJECTS, f);
      if (f.endsWith('.json') && (await readJson(file).catch(() => null))?.ownerId === fromId) files.push(file);
    }
    for (const d of await fsp.readdir(LIBRARY).catch(() => [])) {
      const file = path.join(LIBRARY, d, 'meta.json');
      if ((await readJson(file).catch(() => null))?.ownerId === fromId) files.push(file);
    }
    const idx = await loadExportIndex();
    const exp = Object.keys(idx).filter((f) => idx[f] === fromId);
    if (!files.length && !exp.length) return { projects: 0, media: 0, exports: 0 };
    const dir = await backup([...files, ...(fs.existsSync(EXPORT_INDEX) ? [EXPORT_INDEX] : [])], `transfer-${fromId}`);
    for (const file of files) {
      const rec = await readJson(file);
      rec.ownerId = toId;
      await writeAtomic(file, JSON.stringify(rec));
    }
    for (const f of exp) idx[f] = toId;
    if (exp.length) await writeAtomic(EXPORT_INDEX, JSON.stringify(idx));
    const out = { projects: files.filter((f) => f.startsWith(PROJECTS)).length, media: files.filter((f) => f.startsWith(LIBRARY)).length, exports: exp.length, backup: dir };
    log(`data ${fromId} dipindah ke ${toId}: ${out.projects} proyek, ${out.media} media, ${out.exports} ekspor (backup: ${dir})`);
    return out;
  }

  return { ownerOf, owns, recordExport, exportOwner, migrate, transfer, backup, legacyFiles };
}
