// HTTPS + HTTP/2 in front of the local editor server on :3399, like production (nginx, HTTP/2): one connection, many
// streams. Media answers come LAT ms later and all of them share RATE bytes per second (one Wi-Fi link). NODL=1: no
// whole-file downloads of media (the preview keeps streaming). Use with run.mjs --base=https://127.0.0.1:3402.
// usage: openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj /CN=127.0.0.1
//        H2_KEY=key.pem H2_CERT=cert.pem NODL=1 LAT=150 RATE=1250000 node bench/p26/h2proxy.mjs
import http2 from 'node:http2';
import http from 'node:http';
import fs from 'node:fs';
const LAT = Number(process.env.LAT || 0);
const RATE = Number(process.env.RATE || 1.25e6);
let nextFree = 0; // when the shared link is free again (ms)
const server = http2.createSecureServer({ key: fs.readFileSync(process.env.H2_KEY), cert: fs.readFileSync(process.env.H2_CERT), allowHTTP1: true });
server.on('request', (req, res) => {
  const media = /^\/api\/media\/[^/]+\/(file|edit|proxy)(\?|$)/.test(req.url);
  if (process.env.NODL && media && req.method === 'GET' && !req.headers.range) { res.statusCode = 503; res.end(); return; }
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith(':')));
  headers.host = 'localhost:3399';
  const go = () => {
    const p = http.request({ host: '127.0.0.1', port: 3399, path: req.url, method: req.method, headers }, (r) => {
      const h = { ...r.headers };
      for (const k of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade']) delete h[k];
      res.writeHead(r.statusCode, h);
      if (!media || !LAT) { r.pipe(res); return; }
      r.on('data', (d) => {
        r.pause();
        const now = Date.now();
        nextFree = Math.max(now, nextFree) + (d.length / RATE) * 1000;
        setTimeout(() => { res.write(d); r.resume(); }, nextFree - now);
      });
      r.on('end', () => { const wait = Math.max(0, nextFree - Date.now()); setTimeout(() => res.end(), wait); });
    });
    p.on('error', () => { try { res.statusCode = 502; res.end(); } catch { /* gone */ } });
    if (req.method === 'GET' || req.method === 'HEAD') p.end(); else req.pipe(p); // (a delayed GET: its request stream has ended already, piping it would never end p)
  };
  if (media && LAT) setTimeout(go, LAT); else go();
});
server.listen(3402, '127.0.0.1');
