// P2-6 in Safari (WebKit, the engine of every iPad browser) without automation: open
//   http://127.0.0.1:3401/__harness?p=<project id>&runs=2&sources=asis&arms=auto,element[&clear=1]
// in Safari. This script serves that page on the same origin as the editor (it passes every other request to the
// local editor server on :3399), logs in, opens the project in an iframe, plays it with each preview engine and runs
// paused seeks (measure.js), and appends every result to the file given as the first argument (JSON lines).
// usage: NAJJA_BENCH_EMAIL=… NAJJA_BENCH_PASSWORD=… [LAT=80 RATE=2500000 NODL=1] node bench/p26/webkit.mjs results.jsonl
//   LAT/RATE: media answers LAT ms later, at most RATE bytes/s (an iPad on Wi-Fi); NODL=1: no whole-file downloads of
//   media, so the preview keeps streaming from the server (the device copy never arrives); clear=1: remove this
//   browser's device copies first. Safari plays without a tap here, so clips are muted and the wall clock is used.
import http from 'node:http';
import fs from 'node:fs';

const [out] = process.argv.slice(2);
const LAT = Number(process.env.LAT || 0);
const RATE = Number(process.env.RATE || 2.5e6);
const measure = fs.readFileSync(new URL('./measure.js', import.meta.url), 'utf8');
const HEAD = "<!doctype html><meta charset=\"utf-8\"><title>P2-6 WebKit</title>\n<style>html,body{margin:0;height:100%;background:#111;color:#ccc;font:12px system-ui}iframe{width:1280px;height:800px;border:0}#log{position:fixed;top:0;right:0;width:420px;max-height:100%;overflow:auto;background:#000c;white-space:pre-wrap}</style>\n<div id=\"log\">harness</div><iframe id=\"f\"></iframe>\n<script type=\"module\">";
const JS = "\nconst log = (m) => { document.getElementById('log').textContent += '\\n' + m; };\nconst send = (o) => fetch('/__r', { method: 'POST', body: JSON.stringify(o) }).catch(() => {});\nconst q = new URLSearchParams(location.search);\nconst project = q.get('p'); const runs = Number(q.get('runs') || 2);\ntry {\n  await fetch('/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString() });\n  if (q.get('clear')) { try { await (await navigator.storage.getDirectory()).removeEntry('najja-media', { recursive: true }); log('device copies cleared'); } catch (e) { log('clear: ' + e); } }\n  const f = document.getElementById('f');\n  f.src = '/?debug&p=' + project;\n  await new Promise((r) => { f.onload = r; });\n  const W = () => f.contentWindow;\n  for (let i = 0; i < 600 && !(W().document.body?.classList.contains('ready') && W().najja?.engine); i++) await new Promise((r) => setTimeout(r, 100));\n  W().eval(MEASURE);\n  const ok = await W().eval(`(async () => { const { mediaRT } = await import('/js/media.js'); const { store } = await import('/js/store.js'); for (let i = 0; i < 300; i++) { const m = store.P?.media?.[0]; if (m && mediaRT.get(m.id)?.status === 'ready') return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`);\n  log('editor ready ' + ok + ' \u00b7 ' + navigator.userAgent);\n  await W().eval(`(async () => { const { store } = await import('/js/store.js'); store.mutate('mute', (P) => { for (const c of P.clips) c.muted = true; }); window.najja.engine.audioMode = 'element'; })()`);\n  send({ kind: 'start', ua: navigator.userAgent, webcodecs: typeof W().VideoDecoder });\n  for (const source of (q.get('sources') || 'device,server').split(',')) {\n    if (source === 'server') await W().eval(`(async () => { const { mediaRT } = await import('/js/media.js'); const { store } = await import('/js/store.js'); const { remote } = await import('/js/remote.js'); const id = store.P.media[0].id; const rt = mediaRT.get(id); const u = remote.mediaUrl(id) + '?net=' + Date.now(); Object.assign(rt, { url: u, src: u, cacheKey: null, remoteUrl: null, local: null }); window.najja.engine.audio.reset(); store.emit('media', id); })()`);\n    for (let i = 0; i < runs; i++) for (const arm of (q.get('arms') || 'auto,element').split(',')) {\n      W().najja.engine.setFrameMode(arm);\n      await new Promise((r) => setTimeout(r, 600));\n      if (q.get('only') === 'scrub') { for (const secs of [3, 1.2]) { const sc = await W().__scrub(arm + ' ' + source + ' scrub ' + secs + 's #' + (i + 1), { secs }); log(JSON.stringify(sc)); await send({ kind: 'scrub', ...sc }); } continue; }\n      const r = await W().__measure(14.6, arm + ' ' + source + ' #' + (i + 1));\n      r.source = source;\n      r.bytes = await W().eval(`(async () => { const { mediaBytes } = await import('/js/mediabytes.js'); const { mediaRT } = await import('/js/media.js'); const { store } = await import('/js/store.js'); const b = mediaBytes(mediaRT.get(store.P.media[0].id)); return b ? { device: !!b.blob, url: String(b.url || ''), ...b.stats } : null; })()`);\n      log(JSON.stringify({ l: r.label, wrong: r.wrong_frames, cutsWrong: r.cuts_wrong_first_picture, freezes: r.freezes_over_100ms, buffers: r.buffers, ready: r.cut_picture_ready }));\n      await send({ kind: 'run', ...r });\n      if (q.get('scrub')) for (const secs of [3, 1.2]) { const sc = await W().__scrub(arm + ' ' + source + ' scrub ' + secs + 's #' + (i + 1), { secs }); log(JSON.stringify(sc)); await send({ kind: 'scrub', ...sc }); }\n      if (q.get('only') === 'scrub') continue;\n      const sk = await W().__seeks(20, arm + ' ' + source + ' seeks #' + (i + 1));\n      log(JSON.stringify(sk));\n      await send({ kind: 'seeks', ...sk });\n    }\n  }\n  send({ kind: 'done', info: W().najja.engine.decoderInfo() });\n  log('done');\n} catch (e) { log('ERROR ' + (e?.stack || e)); send({ kind: 'error', msg: String(e?.stack || e) }); }\n";
const harnessPage = () => `${HEAD}${JS.replace('MEASURE', JSON.stringify(measure)).replace('EMAIL', JSON.stringify(process.env.NAJJA_BENCH_EMAIL || '')).replace('PASSWORD', JSON.stringify(process.env.NAJJA_BENCH_PASSWORD || ''))}</script>`;
http.createServer((req, res) => {
  if (req.url === '/__r' && req.method === 'POST') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => { fs.appendFileSync(out, `${b}\n`); res.end('ok'); });
    return;
  }
  if (req.url.startsWith('/__harness')) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(harnessPage()); return; }
  // media over a slow network (an iPad on Wi-Fi): LAT ms before each answer, then at most RATE bytes per second
  // NODL: no whole-file downloads of media (the device copy never arrives: the preview keeps streaming, like an
  // iPad whose copy is still downloading)
  if (process.env.NODL && /^\/api\/media\/[^/]+\/(file|edit|proxy)(\?|$)/.test(req.url) && req.method === 'GET' && !req.headers.range) { res.statusCode = 503; res.end(); return; }
  const slow = req.url.startsWith('/api/media/') && LAT > 0;
  const go = () => {
    const p = http.request({ host: '127.0.0.1', port: 3399, path: req.url, method: req.method, headers: { ...req.headers, host: 'localhost:3399' } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      if (!slow) { r.pipe(res); return; }
      r.on('data', (d) => { r.pause(); res.write(d); setTimeout(() => r.resume(), Math.ceil((d.length / RATE) * 1000)); });
      r.on('end', () => res.end());
    });
    p.on('error', () => { res.statusCode = 502; res.end(); });
    if (req.method === 'GET' || req.method === 'HEAD') p.end(); else req.pipe(p); // (a delayed GET: its request stream has ended already, piping it would never end p)
  };
  if (slow) setTimeout(go, LAT); else go();
  return;
}).listen(3401, '127.0.0.1');
