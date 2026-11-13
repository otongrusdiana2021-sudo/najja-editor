// Benchmark reports. Used by bench/run.mjs, and on its own:
//   node bench/report.mjs result.json                      → Markdown of one run
//   node bench/report.mjs before.json after.json           → before/after table of the key numbers
//   node bench/report.mjs --merge out.json a.json b.json … → one result from several runs (later files win per fixture)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const v = (x) => (x == null ? '—' : x);

/** Flat list of the numbers that matter per fixture: [label, value, lowerIsBetter]. */
export function keyNumbers(r) {
  const out = [];
  const add = (k, val, lower = true) => { if (val != null) out.push([k, val, lower]); };
  if (r.import) { add('impor → bisa dipakai p95 (ms)', r.import.import_visible_p95_ms); add('upload (ms)', r.import.upload_ms); add('salinan ringan siap (ms)', r.import.asset_ready_ms); }
  if (r.playback) {
    add('FPS pratinjau', r.playback.fps_rendered, false); add('frame proyek terlewat (%)', r.playback.frames_missed_pct);
    add('gambar frame p50 (ms)', r.playback.frame_draw_p50_ms); add('gambar frame p95 (ms)', r.playback.frame_draw_p95_ms);
    add('long task saat putar', r.playback.long_tasks); add('tunggu buffer', r.playback.buffer_waits);
    add('timeline: main thread per frame (ms)', r.playback.timeline_ms_per_frame); add('frame tersendat > 25 ms', r.playback.frame_hitches_over_25ms);
    add('jarak frame p95 (ms)', r.playback.raf_p95_ms);
  }
  if (r.seek) { add('seek → frame p50 (ms)', r.seek.p50_ms); add('seek → frame p95 (ms)', r.seek.p95_ms); }
  if (r.export) {
    const e = r.export;
    add('ekspor: kecepatan (× real-time)', e.realtime_factor, false); add('ekspor: total (ms)', e.total_ms ?? (e.seconds != null ? Math.round(e.seconds * 1000) : null));
    add('ekspor: komposit (ms)', e.composite_ms); add('ekspor: decode (ms)', e.decode_ms); add('ekspor: encode (ms)', e.encode_ms);
    add('ekspor: RAM renderer puncak (MB)', e.renderer_rss_peak_mb); add('ekspor: JS heap puncak (MB)', e.js_heap_peak_mb);
  }
  for (const k of ['cold_ready_ms', 'cold_first_frame_ms', 'cold_seek_p95_ms', 'cold_media_on_device_ms', 'warm_ready_ms', 'warm_first_frame_ms', 'warm_seek_p95_ms']) add(k, r[k]);
  if (r.users) {
    for (const u of r.users) add(`${u.file}: salinan siap (ms)`, u.asset_ready_ms);
    add('latensi API saat antre p95 (ms)', r.api_latency?.p95_ms);
    for (const [kind, j] of Object.entries(r.server_jobs || {})) { if (j.wait) add(`job ${kind}: tunggu p95 (ms)`, j.wait.p95); }
  }
  return out;
}

export function toMarkdown(results) {
  const m = results.machine || {};
  const md = [`# Benchmark ${results.label} (${results.profile})`, '', `${results.at} · ${m.cpus}× ${m.cpu} · ${m.memGB} GB · Chromium headless`, ''];
  for (const [id, r] of Object.entries(results.runs)) {
    md.push(`## ${id}${r.ok ? '' : ' — GAGAL'}`, '');
    if (!r.ok) { md.push(`\`${r.error}\``, ''); continue; }
    const rows = [];
    const add = (k, val) => rows.push(`| ${k} | ${v(val)} |`);
    if (r.import) for (const [k, val] of Object.entries(r.import)) add(`impor · ${k}`, val);
    if (r.project) add('proyek', `${r.project.clips} klip · ${r.project.duration} dtk`);
    if (r.playback) for (const [k, val] of Object.entries(r.playback)) add(`putar · ${k}`, val);
    if (r.seek) add('seek → frame (p50 / p95 / max ms)', `${v(r.seek.p50_ms)} / ${v(r.seek.p95_ms)} / ${v(r.seek.max_ms)} (n=${r.seek.n})`);
    if (r.export) for (const [k, val] of Object.entries(r.export)) add(`ekspor · ${k}`, typeof val === 'object' && val ? JSON.stringify(val) : val);
    for (const k of ['cold_ready_ms', 'cold_first_frame_ms', 'cold_seek_p95_ms', 'cold_media_on_device_ms', 'warm_ready_ms', 'warm_first_frame_ms', 'warm_seek_p95_ms', 'project_matches']) if (k in r) add(k, r[k]);
    if (r.users) {
      for (const u of r.users) add(`${u.file} (${u.size_mb} MB)`, `upload ${v(u.upload_ms)} ms · salinan siap ${v(u.asset_ready_ms)} ms`);
      add('latensi API saat antre (p50 / p95 ms)', `${r.api_latency.p50_ms} / ${r.api_latency.p95_ms}`);
      add('job server', JSON.stringify(r.server_jobs));
    }
    md.push('| metrik | nilai |', '|---|---|', ...rows, '');
  }
  return md.join('\n');
}

export function compareMarkdown(a, b) {
  const md = [`# Sebelum/sesudah: ${a.label} → ${b.label} (${b.profile})`, '', 'Perubahan ≥ 10% ditandai; ↓ lebih baik untuk waktu/memori, ↑ untuk FPS dan kecepatan ekspor.', ''];
  for (const id of new Set([...Object.keys(a.runs), ...Object.keys(b.runs)])) {
    const ra = a.runs[id];
    const rb = b.runs[id];
    if (!ra?.ok || !rb?.ok) { md.push(`## ${id}`, '', `tidak dibandingkan (${!ra?.ok ? 'sebelum' : 'sesudah'} gagal atau tidak dijalankan)`, ''); continue; }
    const after = new Map(keyNumbers(rb).map(([k, val]) => [k, val]));
    md.push(`## ${id}`, '', '| metrik | sebelum | sesudah | perubahan |', '|---|---|---|---|');
    for (const [k, va, lower] of keyNumbers(ra)) {
      const vb = after.get(k);
      if (vb == null) continue;
      const d = va ? ((vb - va) / Math.abs(va)) * 100 : 0;
      const better = lower ? d < 0 : d > 0;
      const mark = Math.abs(d) >= 10 ? (better ? ' ✅' : ' ⚠️') : '';
      md.push(`| ${k} | ${va} | ${vb} | ${d >= 0 ? '+' : ''}${d.toFixed(0)}%${mark} |`);
    }
    md.push('');
  }
  return md.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  if (args[0] === '--merge') {
    const [out, ...files] = args.slice(1);
    const all = files.map(read);
    const merged = { ...all[0], runs: {} };
    for (const r of all) for (const [id, run] of Object.entries(r.runs)) if (run.ok || !merged.runs[id]?.ok) merged.runs[id] = run;
    merged.merged_from = files.map((f) => f.split('/').pop());
    fs.writeFileSync(out, JSON.stringify(merged, null, 2));
    fs.writeFileSync(out.replace(/\.json$/, '.md'), toMarkdown(merged));
    console.log(`digabung: ${out}`);
  } else if (args.length === 2) console.log(compareMarkdown(read(args[0]), read(args[1])));
  else console.log(toMarkdown(read(args[0])));
}
