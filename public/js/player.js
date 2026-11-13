// Preview: canvas sizing, the control row under it (fullscreen · play · keyframe · undo · redo) and on-canvas
// editing of the selected clip (drag to move, corner handles or a two-finger pinch to scale and rotate).
import { store, sortedClips, clipEnd, kfValue, upsertKeyframe, keyframeAt } from './store.js';
import * as actions from './actions.js';
import { ASPECTS } from './presets.js';
import { icon } from './icons.js';
import { clamp } from './util.js';
import { metrics } from './metrics.js';
import { preparingLight } from './media.js';

const PREVIEW_LONG = 1280;

export class Player {
  constructor(root, engine) {
    this.root = root;
    this.engine = engine;
    root.innerHTML = `
      <div class="stage" tabindex="-1">
        <div class="stage-inner">
          <canvas class="preview-canvas"></canvas>
          <div class="prep-pill" hidden></div>
          <div class="overlay"><div class="guide gv"></div><div class="guide gh"></div><div class="sel-box"><i class="h tl"></i><i class="h tr"></i><i class="h bl"></i><i class="h br"></i><i class="h rot">${icon('rotate', 12)}</i></div></div>
        </div>
        <button class="stage-empty" data-act="addMedia">${icon('plus', 30)}<b>Mulai berkreasi</b><span>Ketuk untuk menambah video atau foto — atau minta AI lewat MCP.</span></button>
      </div>
      <div class="ctrlbar">
        <div class="cb-left"><button class="icon-btn" data-act="fullscreen" title="Layar penuh" aria-label="Layar penuh">${icon('fullscreen', 20)}</button></div>
        <div class="cb-mid"><button class="play-btn" data-act="play" title="Putar/Jeda (Spasi)" aria-label="Putar">${icon('play', 26)}</button></div>
        <div class="cb-right">
          <button class="icon-btn kf-main" data-act="kf" title="Tambah/hapus keyframe di playhead" aria-label="Keyframe">${icon('keyframe', 21)}</button>
          <button class="icon-btn" data-act="undo" title="Urungkan (Ctrl+Z)" aria-label="Urungkan">${icon('undo', 21)}</button>
          <button class="icon-btn" data-act="redo" title="Ulangi (Ctrl+Shift+Z)" aria-label="Ulangi">${icon('redo', 21)}</button>
        </div>
      </div>`;
    this.canvas = root.querySelector('.preview-canvas');
    this.stage = root.querySelector('.stage');
    this.inner = root.querySelector('.stage-inner');
    this.overlay = root.querySelector('.overlay');
    this.box = root.querySelector('.sel-box');
    this.prep = root.querySelector('.prep-pill');
    this.gv = root.querySelector('.gv');
    this.gh = root.querySelector('.gh');
    this.playBtn = root.querySelector('[data-act="play"]');
    this.kfBtn = root.querySelector('[data-act="kf"]');
    this.undoBtn = root.querySelector('[data-act="undo"]');
    this.redoBtn = root.querySelector('[data-act="redo"]');
    this.quality = 1;
    this.bind();
    new ResizeObserver(() => this.layout()).observe(this.stage);
    setInterval(() => { this.adapt(); this.updatePrep(); }, 1000);
    store.on('project', () => { this.layout(); this.updateCtrls(); });
    store.on('selection', () => { this.updateBox(); this.updateCtrls(); });
    engine.on((kind) => {
      if (kind === 'time' && !engine.playing) this.updateCtrls();
      if (kind === 'buffer') this.stage.classList.toggle('buffering', engine.buffering);
      if (kind === 'render') this.updateBox();
      if (kind === 'play' || kind === 'pause') this.playBtn.innerHTML = icon(engine.playing ? 'pause' : 'play', 26);
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
    // Preview resolution: screen pixels (at most 2x), never above 1280 on the long side (the preview does not
    // need more), and lower still while a slow device cannot keep up (this.quality, see adapt()).
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let pw = Math.min(P.width, Math.round(cssW * dpr * this.quality));
    pw = Math.min(pw, Math.round((PREVIEW_LONG * P.width) / Math.max(P.width, P.height)));
    pw = Math.max(2, pw);
    const ph = Math.round((pw * P.height) / P.width);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.cssScale = cssW / P.width;
    this.root.classList.toggle('is-empty', !P.clips.length);
    this.engine.requestRender();
  }

  /**
   * Keep playback smooth on slow devices: when drawing a frame takes too long, lower the preview resolution
   * (down to half); raise it again once there is room. Exports always render at full resolution.
   */
  adapt() {
    const E = this.engine;
    if (!E.playing || E.drawMs == null) { this.slowRuns = 0; this.fastRuns = 0; return; }
    if (E.drawMs > 16 && this.quality > 0.5) {
      if (++this.slowRuns >= 2) { this.quality = Math.max(0.5, this.quality * 0.75); this.slowRuns = 0; E.drawMs = null; this.layout(); metrics.count('preview_quality_down'); }
    } else this.slowRuns = 0;
    if (E.drawMs != null && E.drawMs < 6 && this.quality < 1) {
      if (++this.fastRuns >= 4) { this.quality = Math.min(1, this.quality / 0.75); this.fastRuns = 0; E.drawMs = null; this.layout(); }
    } else this.fastRuns = 0;
  }

  /** Undo/redo availability and whether the playhead sits on a keyframe of the selected clip. */
  updateCtrls() {
    this.undoBtn.disabled = !store.past.length;
    this.redoBtn.disabled = !store.future.length;
    const c = store.selected();
    const ok = c && 'x' in c;
    this.kfBtn.disabled = !ok;
    const local = ok ? this.engine.time - c.start : -1;
    this.kfBtn.classList.toggle('on', !!(ok && keyframeAt(c, local)));
  }

  selectedVisual() {
    const c = store.selected();
    if (!c || c.type === 'audio' || c.type === 'effect') return null;
    const t = this.engine.time;
    if (t < c.start || t >= clipEnd(c)) return null;
    return c;
  }

  /** A heavy camera original still plays while its light copy is made: say so (it explains a choppy start). */
  updatePrep() {
    const P = store.P;
    let p = null;
    for (const m of P?.media || []) {
      if (m.type !== 'video') continue;
      const v = preparingLight(m.id);
      if (v != null && P.clips.some((c) => c.mediaId === m.id)) p = Math.max(p ?? 0, v);
    }
    const txt = p == null ? '' : `Menyiapkan versi ringan untuk pratinjau lancar… ${Math.round(p * 100)}%`;
    if (this.prep.textContent !== txt) this.prep.textContent = txt;
    this.prep.hidden = p == null;
  }

  updateBox() {
    const c = this.selectedVisual();
    const b = c && this.engine.boxes.get(c.id);
    if (!b || this.engine.playing) { if (this.box.style.display !== 'none') this.box.style.display = 'none'; return; } // called on every drawn frame
    const k = this.cssScale || 1;
    this.box.style.display = 'block';
    this.box.style.width = `${Math.abs(b.w) * k}px`;
    this.box.style.height = `${Math.abs(b.h) * k}px`;
    this.box.style.transform = `translate(${b.cx * k}px, ${b.cy * k}px) translate(-50%, -50%) rotate(${b.rot}rad)`;
    this.box.classList.toggle('locked', !!store.track(c.trackId)?.locked);
    this.box.classList.toggle('main', c.trackId === 'main');
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
        case 'undo': store.undo(); break;
        case 'redo': store.redo(); break;
        case 'kf': if (actions.toggleKeyframe()) this.updateCtrls(); break;
        case 'addMedia': this.app?.openSheet?.('media', { mode: 'append' }); break;
        case 'fullscreen': {
          const el = this.stage;
          if (document.fullscreenElement) document.exitFullscreen?.();
          else if (el.requestFullscreen) el.requestFullscreen().catch(() => this.root.classList.toggle('pseudo-full'));
          else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
          else this.root.classList.toggle('pseudo-full'); // iPhone Safari: no element fullscreen
          break;
        }
        default: break;
      }
    });
    this.stage.addEventListener('dblclick', (e) => {
      if (e.target.closest('.sel-box')) return;
      if (!e.target.closest('.stage-inner')) this.engine.toggle();
    });

    // Select / move / scale / rotate on the canvas. One finger or the mouse moves (corner handles scale,
    // the round handle rotates); a second finger turns the gesture into a pinch that scales and rotates.
    this.touches = new Map();
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2 && this.gesture) { this.startPinch(); return; }
      if (this.gesture) return;
      const rect = this.inner.getBoundingClientRect();
      const k = this.cssScale || 1;
      const toP = (ev) => ({ x: (ev.clientX - rect.left) / k, y: (ev.clientY - rect.top) / k });
      const p0 = toP(e);
      const handle = e.target.closest('.h');
      let c = this.selectedVisual();
      if (!handle) {
        const hit = this.hitTest(p0.x, p0.y);
        if (hit && hit.id !== c?.id) { store.select(hit.id); c = hit; }
        if (!hit) { store.select(null); this.touches.delete(e.pointerId); return; }
      }
      if (!c || store.track(c.trackId)?.locked) return;
      this.engine.pause();
      const P = store.P;
      const b = this.engine.boxes.get(c.id);
      if (!b) return;
      const local = this.engine.time - c.start;
      const hasKf = !!c.keyframes?.length;
      const start = { x: kfValue(c, 'x', local), y: kfValue(c, 'y', local), scale: kfValue(c, 'scale', local), rotation: kfValue(c, 'rotation', local) };
      const setProp = (key, v) => { if (hasKf) upsertKeyframe(c, local, { [key]: v }); else c[key] = v; };
      const d0 = Math.hypot(p0.x - b.cx, p0.y - b.cy) || 1;
      const a0 = Math.atan2(p0.y - b.cy, p0.x - b.cx);
      const mode = handle ? (handle.classList.contains('rot') ? 'rotate' : 'scale') : 'move';
      e.preventDefault();
      const g = { c, b, start, setProp, moved: false, pinch: null, pointerId: e.pointerId };
      this.gesture = g;
      const snapRot = (deg) => {
        deg = ((deg + 540) % 360) - 180;
        for (const sn of [-180, -90, 0, 90, 180]) if (Math.abs(deg - sn) < 4) deg = sn;
        return Math.round(deg * 10) / 10;
      };
      const move = (ev) => {
        if (this.touches.has(ev.pointerId)) this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (g.pinch) {
          const [t1, t2] = [...this.touches.values()];
          if (!t2) return;
          const d = Math.hypot(t2.x - t1.x, t2.y - t1.y) || 1;
          const ang = Math.atan2(t2.y - t1.y, t2.x - t1.x);
          g.moved = true;
          store.live(() => {
            setProp('scale', clamp(g.pinch.scale * (d / g.pinch.d), 0.02, 20));
            setProp('rotation', snapRot(g.pinch.rotation + ((ang - g.pinch.a) * 180) / Math.PI));
          }, 'transform');
          this.engine.requestRender();
          return;
        }
        if (ev.pointerId !== g.pointerId) return;
        const p = toP(ev);
        g.moved = true;
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
            setProp('rotation', snapRot(start.rotation + ((Math.atan2(p.y - b.cy, p.x - b.cx) - a0) * 180) / Math.PI));
          }
        }, 'transform');
        this.engine.requestRender();
      };
      const up = (ev) => {
        this.touches.delete(ev.pointerId);
        if (g.pinch && this.touches.size) return; // one finger still down: keep pinching until both lift
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        this.touches.clear();
        this.gesture = null;
        this.gv.style.display = 'none';
        this.gh.style.display = 'none';
        if (g.moved) store.commitLive('Transformasi');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    this.overlay.addEventListener('dblclick', (e) => {
      if (store.selected()?.type === 'text') this.app?.openSheet?.('text', { tab: 'style', focus: true });
      e.stopPropagation();
    });
  }

  /** Second finger down during a gesture on the selected clip: from now on, scale and rotate with two fingers. */
  startPinch() {
    const g = this.gesture;
    const [t1, t2] = [...this.touches.values()];
    if (!g || !t2) return;
    const local = this.engine.time - g.c.start;
    g.pinch = {
      d: Math.hypot(t2.x - t1.x, t2.y - t1.y) || 1,
      a: Math.atan2(t2.y - t1.y, t2.x - t1.x),
      scale: kfValue(g.c, 'scale', local),
      rotation: kfValue(g.c, 'rotation', local),
    };
    this.gv.style.display = 'none';
    this.gh.style.display = 'none';
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
