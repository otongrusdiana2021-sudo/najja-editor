// Server storage: projects, chunked uploads, media library. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createStorage } from '../lib/storage.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-store-'));
const exportDir = path.join(dir, 'exports');
const extFor = (name, mime) => path.extname(name || '') || (mime === 'video/mp4' ? '.mp4' : '.bin');
const st = createStorage(dir, { exportDir, extFor });
const req = (buf) => Readable.from([buf]);

test('projects: save, list, load, delete; rejects bad ids', async () => {
  await st.putProject('p_abc123', { id: 'p_abc123', name: 'Satu', updatedAt: 2, media: [] });
  await st.putProject('p_def456', { id: 'p_def456', name: 'Dua', updatedAt: 5, media: [] });
  const list = await st.listProjects();
  assert.deepEqual(list.map((p) => p.name), ['Dua', 'Satu']);
  assert.equal((await st.getProject('p_abc123')).name, 'Satu');
  await assert.rejects(st.getProject('../../etc/passwd'), /Invalid project id/);
  await assert.rejects(st.putProject('p_abc123', { id: 'p_other1' }), /mismatch/);
  await st.deleteProject('p_def456');
  assert.equal((await st.listProjects()).length, 1);
});

test('chunked upload assembles parts in order and checks the size', async () => {
  const a = Buffer.alloc(1000, 1);
  const b = Buffer.alloc(500, 2);
  await st.putChunk('upload_test_1', 1, req(b));
  await st.putChunk('upload_test_1', 0, req(a));
  const done = await st.finishUpload('upload_test_1', { parts: 2, size: 1500, target: 'media', mediaId: 'm_vid001', filename: 'clip.mp4', mime: 'video/mp4' });
  assert.equal(done.size, 1500);
  const file = await st.mediaFile('m_vid001');
  const data = fs.readFileSync(file);
  assert.equal(data[0], 1);
  assert.equal(data[1499], 2);
  assert.equal((await st.getMeta('m_vid001')).mime, 'video/mp4');
  await st.putChunk('upload_test_2', 0, req(a));
  await assert.rejects(st.finishUpload('upload_test_2', { parts: 2, size: 2000, target: 'media', mediaId: 'm_vid002', filename: 'x.mp4' }), /Missing chunk 1/);
  await assert.rejects(st.putChunk('../evil', 0, req(a)), /Invalid upload id/);
});

test('meta merge keeps file info; delete keeps media used by another project', async () => {
  await st.putMeta('m_vid001', { entry: { id: 'm_vid001', name: 'clip.mp4' }, poster: 'data:x', hasPeaks: false });
  const meta = await st.getMeta('m_vid001');
  assert.equal(meta.file, 'source.mp4');
  assert.equal(meta.poster, 'data:x');
  await st.putProject('p_keep01', { id: 'p_keep01', updatedAt: 1, media: [{ id: 'm_vid001' }] });
  assert.equal((await st.deleteMedia('m_vid001', 'p_abc123')).kept, true);
  assert.ok(fs.existsSync(await st.mediaFile('m_vid001')));
  assert.equal((await st.deleteMedia('m_vid001', 'p_keep01')).kept, false);
  await assert.rejects(st.getMeta('m_vid001'), /not found/);
});

test('export upload lands in the exports folder with a safe name', async () => {
  await st.putChunk('upload_export1', 0, req(Buffer.alloc(10, 7)));
  const done = await st.finishUpload('upload_export1', { parts: 1, size: 10, target: 'export', filename: '../../hasil video.webm' });
  assert.equal(path.dirname(done.path), exportDir);
  assert.equal(done.file, 'hasil_video.webm');
});
