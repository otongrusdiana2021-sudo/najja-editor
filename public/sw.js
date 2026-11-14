// Najja Editor service worker: makes the app installable and keeps the shell available offline.
// Network-first for the app (updates always apply), cache-first for Google Fonts.
// API, MCP, login, media and exports are never cached — project data lives on the server.
const CACHE = 'najja-shell-v8'; // v1.7.4
const BYPASS = /^\/(api|mcp|bridge|login|logout|exports|media-cache)(\/|$)/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') e.respondWith(cacheFirst(req));
    return;
  }
  if (BYPASS.test(url.pathname) || req.headers.has('range')) return;
  e.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') (await caches.open(CACHE)).put(req, res.clone());
  return res;
}
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic' && !res.redirected) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Poppins,sans-serif;background:#0b0b0d;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>Najja Editor offline</h2><p>Periksa koneksi internet lalu muat ulang.</p></div>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    throw err;
  }
}
