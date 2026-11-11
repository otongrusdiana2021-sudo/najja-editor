// Preview player: canvas sizing, transport controls, aspect ratio menu, on-canvas transform handles.
import { store, sortedClips, clipEnd, kfValue, upsertKeyframe } from './store.js';
import { ASPECTS } from './presets.js';
import { icon } from './icons.js';
import { fmtTC, clamp } from './util.js';
import { contextMenu } from './ui.js';

export class Player {
  constructor(root, engine) {
    this.root = root;
    this.engine = engine;
    root.innerHTML = `
      <div class="panel-head viewer-head">
        <span class="panel-title">Pemutar</span>
        <div class="viewer-head-right">
          <button class="chip-btn" data-act="ratio" title="Rasio kanvas"><span class="ratio-label">16:9</span>${icon('chevronDown', 14)}</button>
        </div>
      </div>
      <div class="stage" tabindex="-1">
        <div class="stage-inner">
          <canvas class="preview-canvas"></canvas>
          <div class="overlay"><div class="guide gv"></div><div class="guide gh"></div><div class="sel-box"><i class="h tl"></i><i class="h tr"></i><i class="h bl"></i><i class="h br"></i><i class="h rot">${icon('rotate', 12)}</i></div></div>
        </div>
        <div class="stage-empty">${icon('media', 30)}<b>Mulai berkreasi</b><span>Impor video, foto, atau audio dari panel Media — atau minta AI lewat MCP.</span></div>
      </div>
      <div class="transport">
        <div class="tc"><span class="tc-cur">00:00:00:00</span><span class="tc-sep">/</span><span class="tc-dur">00:00:00:00</span></div>
        <div class="transport-mid">
          <button class="icon-btn" data-act="start" title="Ke awal (Home)">${icon('skipBack', 16)}</button>
          <button class="icon-btn" data-act="prev" title="Frame sebelumnya (←)">${icon('stepBack', 18)}</button>
          <button class="play-btn" data-act="play" title="Putar/Jeda (Spasi)">${icon('play', 20)}</button>
          <button class="icon-btn" data-act="next" title="Frame berikutnya (→)">${icon('stepForward', 18)}</button>
          <button class="icon-btn" data-act="end" title="Ke akhir (End)">${icon('skipForward', 16)}</button>
        </div>
        <div class="transport-right">
          <button class="icon-btn toggle" data-act="loop" title="Ulangi putar">${icon('rotate', 16)}</button>
          <button class="icon-btn" data-act="fullscreen" title="Layar penuh">${icon('fullscreen', 16)}</button>
        </div>
      </div>`;
    this.canvas = root.querySelector('.preview-canvas');
    this.stage = root.querySelector('.stage');
    this.inner = root.querySelector('.stage-inner');
    this.overlay = root.querySelector('.overlay');
    this.box = root.querySelector('.sel-box');
    this.gv = root.querySelector('.gv');
    this.gh = root.querySelector('.gh');
    this.playBtn = root.querySelector('[data-act="play"]');
    this.tcCur = root.querySelector('.tc-cur');
    this.tcDur = root.querySelector('.tc-dur');
    this.bind();
    new ResizeObserver(() => this.layout()).observe(this.stage);
    store.on('project', () => { this.layout(); this.updateTC(); });
    store.on('selection', () => this.updateBox());
    engine.on((kind) => {
      if (kind === 'time') this.updateTC();
      if (kind === 'buffer') this.stage.classList.toggle('buffering', engine.buffering);
      if (kind === 'render') this.updateBox();
      if (kind === 'play' || kind === 'pause') this.playBtn.innerHTML = icon(engine.playing ? 'pause' : 'play', 20);
    });
  }

  layout() {
    const P = store.P;
    const pad = 16;
    const sw = this.stage.clientWidth - pad * 2;
    const sh = this.stage.clientHeight - pad * 2;
    if (sw <= 0 || sh <= 0) return;
    const k = Math.min(sw / P.width, sh / P.height);
    const cssW = Math.max(1, Math.floor(P.width * k));
    const cssH = Math.max(1, Math.floor(P.height * k));
    this.inner.style.width = `${cssW}px`;
    this.inner.style.height = `${cssH}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.min(P.width, Math.round(cssW * dpr));
    const ph = Math.round((pw * P.height) / P.width);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.cssScale = cssW / P.width;
    this.root.querySelector('.ratio-label').textContent = P.aspect;
    this.root.classList.toggle('is-empty', !P.clips.length);
    this.engine.requestRender();
  }

  updateTC() {
    const fps = store.P.fps || 30;
    this.tcCur.textContent = fmtTC(this.engine.time, fps);
    this.tcDur.textContent = fmtTC(store.duration(), fps);
  }

  selectedVisual() {
    const c = store.selected();
    if (!c || c.type === 'audio' || c.type === 'effect') return null;
    const t = this.engine.time;
    if (t < c.start || t >= clipEnd(c)) return null;
    return c;
  }

  updateBox() {
    const c = this.selectedVisual();
    const b = c && this.engine.boxes.get(c.id);
    if (!b || this.engine.playing) { this.box.style.display = 'none'; return; }
    const k = this.cssScale || 1;
    this.box.style.display = 'block';
    this.box.style.width = `${Math.abs(b.w) * k}px`;
    this.box.style.height = `${Math.abs(b.h) * k}px`;
    this.box.style.transform = `translate(${b.cx * k}px, ${b.cy * k}px) translate(-50%, -50%) rotate(${b.rot}rad)`;
    this.box.classList.toggle('locked', !!store.track(c.trackId)?.locked);
  }

  /** Topmost visual clip under a point (project units). */
  hitTest(px, py) {
    const P = store.P;
    const t = this.engine.time;
    const visual = P.tracks.filter((tr) => !['audio', 'effect'].includes(tr.kind) && !tr.hidden);
    for (const tr of visual) {
      const list = sortedClips(P, tr.id).filter((c) => t >= c.start && t < clipEnd(c)).reverse();
      for (const c of list) {
        const b = this.engine.boxes.get(c.id);
        if (!b) continue;
        const dx = px - b.cx;
        const dy = py - b.cy;
        const cos = Math.cos(-b.rot);
        const sin = Math.sin(-b.rot);
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        if (Math.abs(lx) <= Math.abs(b.w) / 2 && Math.abs(ly) <= Math.abs(b.h) / 2) return c;
      }
    }
    return null;
  }

  bind() {
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const E = this.engine;
      switch (b.dataset.act) {
        case 'play': E.toggle(); break;
        case 'prev': E.step(-1); break;
        case 'next': E.step(1); break;
        case 'start': E.pause(); E.seek(0); break;
        case 'end': E.pause(); E.seek(store.duration()); break;
        case 'loop': E.loop = !E.loop; b.classList.toggle('on', E.loop); break;
        case 'fullscreen': this.stage.requestFullscreen?.().catch(() => {}); break;
        case 'ratio': {
          const r = b.getBoundingClientRect();
          contextMenu(r.left, r.bottom + 6, Object.entries(ASPECTS).map(([k, a]) => ({
            label: `${k}  ·  ${a.hint}`, icon: store.P.aspect === k ? 'check' : null, run: () => setAspect(k),
          })));
          break;
        }
        default: break;
      }
    });
    this.stage.addEventListener('dblclick', (e) => {
      if (e.target.closest('.sel-box')) return;
      if (!e.target.closest('.stage-inner')) this.engine.toggle();
    });

    // Select / move / scale / rotate on the canvas
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = this.inner.getBoundingClientRect();
      const k = this.cssScale || 1;
      const toP = (ev) => ({ x: (ev.clientX - rect.left) / k, y: (ev.clientY - rect.top) / k });
      const p0 = toP(e);
      const handle = e.target.closest('.h');
      let c = this.selectedVisual();
      if (!handle) {
        const hit = this.hitTest(p0.x, p0.y);
        if (hit && hit.id !== c?.id) { store.select(hit.id); c = hit; }
        if (!hit) { store.select(null); return; }
      }
      if (!c || store.track(c.trackId)?.locked) return;
      this.engine.pause();
      const P = store.P;
      const b = this.engine.boxes.get(c.id);
      if (!b) return;
      const local = this.engine.time - c.start;
      const hasKf = !!c.keyframes?.length;
      const start = { x: kfValue(c, 'x', local), y: kfValue(c, 'y', local), scale: kfValue(c, 'scale', local), rotation: kfValue(c, 'rotation', local) };
      const setProp = (k, v) => { if (hasKf) upsertKeyframe(c, local, { [k]: v }); else c[k] = v; };
      const d0 = Math.hypot(p0.x - b.cx, p0.y - b.cy) || 1;
      const a0 = Math.atan2(p0.y - b.cy, p0.x - b.cx);
      const mode = handle ? (handle.classList.contains('rot') ? 'rotate' : 'scale') : 'move';
      let moved = false;
      e.preventDefault();
      const move = (ev) => {
        const p = toP(ev);
        moved = true;
        store.live(() => {
          if (mode === 'move') {
            let nx = start.x + (p.x - p0.x) / P.width;
            let ny = start.y + (p.y - p0.y) / P.height;
            const snapX = Math.abs(nx) < 0.012;
            const snapY = Math.abs(ny) < 0.012;
            if (snapX) nx = 0;
            if (snapY) ny = 0;
            this.gv.style.display = snapX ? 'block' : 'none';
            this.gh.style.display = snapY ? 'block' : 'none';
            setProp('x', nx);
            setProp('y', ny);
          } else if (mode === 'scale') {
            const d = Math.hypot(p.x - b.cx, p.y - b.cy);
            setProp('scale', clamp(start.scale * (d / d0), 0.02, 20));
          } else {
            let deg = start.rotation + ((Math.atan2(p.y - b.cy, p.x - b.cx) - a0) * 180) / Math.PI;
            deg = ((deg + 540) % 360) - 180;
            for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(deg - snap) < 4) deg = snap;
            setProp('rotation', Math.round(deg * 10) / 10);
          }
        }, 'transform');
        this.engine.requestRender();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.gv.style.display = 'none';
        this.gh.style.display = 'none';
        if (moved) store.commitLive('Transformasi');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.overlay.addEventListener('dblclick', (e) => {
      if (store.selected()?.type === 'text') this.app?.inspector?.focusPrimary();
      e.stopPropagation();
    });
  }
}

export function setAspect(aspect) {
  const a = ASPECTS[aspect];
  if (!a) throw new Error(`Rasio tidak dikenal: ${aspect}`);
  store.mutate('Rasio', (P) => {
    P.aspect = aspect;
    P.width = a.w;
    P.height = a.h;
  });
}
