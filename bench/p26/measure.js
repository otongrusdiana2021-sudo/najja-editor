// Injected into the editor page: plays the project and reads the picture actually drawn (the white bar's position
// gives the source frame number mod 30), against the frame the timeline asks for.
window.__measure = async function (secs, label = '') {
  const E = window.najja.engine;
  const { store } = await import('/js/store.js');
  const { metrics } = await import('/js/metrics.js');
  E.pause(); E.seek(0);
  await E.settle(5000);
  await new Promise((r) => setTimeout(r, 400));
  metrics.reset();
  const cv = E.canvas; const ctx = E.ctx;
  const main = store.P.clips.filter((c) => c.trackId === 'main').sort((a, b) => a.start - b.start);
  const st = { renders: 0, wrong: 0, wrongBig: 0, freezes: [], fat: [], cutsWrong: 0, cuts: 0, lastObs: null, lastChange: null, lastClip: null, started: null };
  const render = E.render.bind(E);
  E.render = function () {
    render();
    if (!E.playing) return;
    const t = E.time; const now = performance.now();
    if (st.started == null) { if (t <= 0.001) return; st.started = now; } // (the playhead waits for the first sound)
    const c = main.find((x) => t >= x.start && t < x.start + x.duration); if (!c) return;
    const y = Math.round(cv.height * (640 / 720)); const row = ctx.getImageData(0, y, cv.width, 1).data;
    let sx = 0; let n = 0;
    for (let x = 0; x < cv.width; x++) { const i = x * 4; if (row[i] > 220 && row[i + 1] > 220 && row[i + 2] > 220) { sx += x; n++; } }
    st.renders++;
    const obs = n ? Math.floor((sx / n) / (cv.width / 30)) : -1;
    const exp = Math.floor((c.in + (t - c.start)) * 30 + 1e-6) % 30;
    let d = obs < 0 ? 99 : ((obs - exp) % 30 + 30) % 30; if (d > 15) d -= 30;
    if (d === 1 && Math.round((c.in + (t - c.start)) * 30) % 30 === obs) d = 0; // (the nearest frame: what an export renders)
    if (Math.abs(d) > 1) st.wrong++;
    if (Math.abs(d) > 3) st.wrongBig++;
    if (c.id !== st.lastClip) { st.cuts++; if (Math.abs(d) > 1) st.cutsWrong++; st.lastClip = c.id; }
    if (obs !== st.lastObs) {
      if (st.lastChange != null && now - st.lastChange > 100) { st.freezes.push(Math.round(now - st.lastChange)); st.fat.push(+t.toFixed(2)); }
      st.lastObs = obs; st.lastChange = now;
    }
  };
  const t0 = performance.now();
  E.play();
  await new Promise((r) => setTimeout(r, secs * 1000));
  E.pause();
  E.render = render;
  const snap = await metrics.snapshot({});
  const c = snap.counters; const s = snap.series;
  const pick = (k) => (s[k] ? { p50: s[k].p50, p95: s[k].p95, max: s[k].max, n: s[k].n } : null);
  return {
    label, engine: E.frameMode, renders: st.renders, wrong_frames: st.wrong, wrong_by_more_than_3: st.wrongBig, cuts_seen: st.cuts, cuts_wrong_first_picture: st.cutsWrong,
    freezes_over_100ms: st.freezes.length, freeze_total_ms: st.freezes.reduce((a, b) => a + b, 0), freeze_max_ms: Math.max(0, ...st.freezes), freeze_at_timeline_s: st.fat,
    timeline_reached_s: +E.time.toFixed(2), wall_s: +((performance.now() - t0) / 1000).toFixed(2),
    buffers: (c.buffer_at_clip_start || 0) + (c.buffer_mid_clip || 0), buffer_wait_ms: pick('buffer_wait_ms'),
    cut_picture_ready: c.cut_picture_ready || 0, cut_picture_late: c.cut_picture_late || 0, cut_held_previous_picture: c.cut_held_previous_picture || 0,
    decoder_first_frame_ms: pick('decoder_first_frame_ms'), decoder_late_frames_pct: pick('decoder_late_frames_pct'), clip_start_latency_ms: pick('clip_start_latency_ms'),
    fps_rendered: pick('fps_rendered'), video_presented_fps: pick('video_presented_fps'), playback_speed_pct: pick('playback_speed_pct'), audio_start_wait_ms: pick('audio_start_wait_ms'),
    audio_mode: snap.gauges?.audio_mode, preview_engine: snap.gauges?.preview_engine, decoders: E.decs.size, elements: E.els.size,
    decoder_error: c.decoder_error || 0, decoder_fallback: c.decoder_fallback || 0, audio_underrun: c.audio_underrun || 0, events: snap.events.filter((e) => /decoder|audio_problem/.test(e.kind)).slice(-5),
  };
};
// Paused seeks (a scrub, a click on the timeline): time until the exact frame is drawn, and is it the right one.
window.__seeks = async function (n = 20, label = '') {
  const E = window.najja.engine;
  const { store } = await import('/js/store.js');
  const { metrics } = await import('/js/metrics.js');
  E.pause();
  metrics.reset();
  const main = store.P.clips.filter((c) => c.trackId === 'main').sort((a, b) => a.start - b.start);
  const dur = store.duration();
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const out = { n: 0, wrong: 0, timeouts: 0, ms: [] };
  for (let i = 0; i < n; i++) {
    const t = Math.round(rnd() * (dur - 0.1) * 30) / 30 + 0.004;
    const t0 = performance.now();
    E.seek(t);
    while (E.seekAt && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 5));
    if (E.seekAt) { out.timeouts++; continue; }
    out.ms.push(Math.round(performance.now() - t0));
    E.render();
    const c = main.find((x) => t >= x.start && t < x.start + x.duration);
    const cv = E.canvas; const row = E.ctx.getImageData(0, Math.round(cv.height * (640 / 720)), cv.width, 1).data;
    let sx = 0; let k = 0;
    for (let x = 0; x < cv.width; x++) { const j = x * 4; if (row[j] > 220 && row[j + 1] > 220 && row[j + 2] > 220) { sx += x; k++; } }
    const obs = k ? Math.floor((sx / k) / (cv.width / 30)) : -1;
    // the frame at the playhead: the one shown at that time (floor) or the nearest one (what an export renders)
    const lt = E.localTime(c, t);
    const ok = [Math.floor(lt * 30 + 1e-6) % 30, Math.round(lt * 30) % 30];
    out.n++;
    if (!ok.includes(obs)) out.wrong++;
    await new Promise((r) => setTimeout(r, 120));
  }
  out.ms.sort((a, b) => a - b);
  const m = (await metrics.snapshot({})).series.seek_to_frame_ms;
  return { label, engine: E.frameMode, engine_seek_to_frame_ms: m ? { p50: m.p50, p95: m.p95 } : null, seeks: out.n, wrong_frame: out.wrong, timeouts: out.timeouts, p50_ms: out.ms[Math.floor(out.ms.length / 2)], p95_ms: out.ms[Math.floor(out.ms.length * 0.95)], max_ms: out.ms[out.ms.length - 1] };
};
