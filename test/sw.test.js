// (P0-4) The service worker (public/sw.js), run in a sandbox with stand-in caches and fetch. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function load() {
  const listeners = {};
  const store = new Map([['najja-shell-v34', 'shell'], ['najja-models-birefnet-512', 'model'], ['someone-else', 'x']]);
  const fetched = [];
  const ctx = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, location: { origin: 'https://editor.example' }, skipWaiting() {}, clients: { claim: async () => {} } },
    caches: { keys: async () => [...store.keys()], delete: async (k) => store.delete(k), match: async () => undefined, open: async () => ({ put: async () => {} }) },
    fetch: async (r) => { fetched.push(r.url); return { ok: true, type: 'basic', redirected: false, clone() { return this; } }; },
    URL,
    Response: class {},
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const fire = (path, { mode = 'navigate', method = 'GET' } = {}) => {
    const waits = [];
    let responded = null;
    listeners.fetch({
      request: { url: `https://editor.example${path}`, mode, method, headers: { has: () => false } },
      waitUntil: (p) => waits.push(p),
      respondWith: (p) => { responded = p; },
    });
    return { waits, responded: () => responded };
  };
  return { store, fire };
}

for (const path of ['/logout', '/login', '/login?next=%2F']) {
  test(`opening ${path} removes the cached app shell, keeps the AI models, and loads the page from the network`, async () => {
    const { store, fire } = load();
    const ev = fire(path);
    assert.equal(ev.responded(), null, 'the service worker does not answer it: the network does, as before');
    await Promise.all(ev.waits);
    assert.deepEqual([...store.keys()].sort(), ['najja-models-birefnet-512', 'someone-else']);
  });
}

test('other pages and requests do not touch the caches', async () => {
  const { store, fire } = load();
  const pages = [fire('/'), fire('/?p=p_abc'), fire('/design'), fire('/logout', { mode: 'cors' }), fire('/api/logout', { mode: 'cors' })];
  await Promise.all(pages.flatMap((e) => e.waits));
  assert.equal(store.size, 3);
  assert.ok(pages[0].responded(), 'the editor itself is still served network-first');
});
