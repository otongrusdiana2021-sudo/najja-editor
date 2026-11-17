// The editor's Docker image holds only what the Dockerfile copies: the server must start from those files alone.
// (v1.11.0 read ai/models.json at start — a file only the AI service's image has — and the editor container did not
// start on the server.) Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** The files a Dockerfile's COPY lines take from the build context: [[source, destination folder or file]]. */
function copies(dockerfile) {
  const out = [];
  for (const line of fs.readFileSync(path.join(ROOT, dockerfile), 'utf8').split('\n')) {
    const m = /^COPY\s+(?!--from)(.+)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[1].split(/\s+/).filter((x) => !x.startsWith('--'));
    const dest = parts.pop();
    for (const src of parts) out.push([src, dest]);
  }
  return out;
}

test('the editor starts from the files of its Docker image alone', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-image-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'najja-image-data-'));
  const list = copies('Dockerfile');
  assert.ok(list.some(([s]) => s === 'server.js'), 'the Dockerfile copies server.js');
  for (const [src, dest] of list) {
    const to = dest.endsWith('/') ? path.join(app, dest, path.basename(src)) : path.join(app, dest);
    fs.cpSync(path.join(ROOT, src), to, { recursive: true });
  }
  assert.equal(fs.existsSync(path.join(app, 'ai')), false, 'no ai/ folder in the editor image (only in the AI service image)');
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js', '--no-open'], {
    cwd: app,
    env: { ...process.env, NAJJA_NO_OPEN: '1', PORT: String(port), HOST: '127.0.0.1', NAJJA_DATA_DIR: data, NAJJA_TOKEN: 'image-token-0123456789', NAJJA_AI_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errOut = '';
  child.stderr.on('data', (d) => { errOut += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  try {
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(undefined), 100))]);
      if (code !== undefined) assert.fail(`the server stopped (${code}): ${errOut.slice(0, 500)}`);
      try { ok = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { /* starting */ }
    }
    assert.ok(ok, `/healthz answers (${errOut.slice(0, 300)})`);
    const page = await fetch(`http://127.0.0.1:${port}/login`);
    assert.equal(page.status, 200, 'the sign-in page is served');
    assert.match(await page.text(), /<html/i);
  } finally {
    child.kill();
    fs.rmSync(app, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
