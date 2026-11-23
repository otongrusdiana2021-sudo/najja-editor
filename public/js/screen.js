// (v1.13.2) Ukuran layar on this device: applies the scale and the zoom lock chosen in Akun → Ukuran layar (rules in
// core/screen.js, the same as the ecom app). Kept in this browser (prefs = localStorage), so each device has its own.
// Imported first by the editor (app.js) and Najja Desain (design/app.js) so the page is drawn at its scale at once.
//
// Unlike the ecom app, Najja maps the pointer onto a timeline and a canvas, so the way the page is scaled matters:
//  - touch screens (iPad, phones): the viewport scale, the browser's own page scale. One coordinate space, no change.
//  - Chrome / Edge / Firefox on a computer: CSS zoom on <html>. Pointer positions and getBoundingClientRect are then on
//    screen while styles, scroll offsets and sizes are in the page's own px: code that mixes them converts with toCss()
//    (core/screen.js).
//  - other browsers (Safari on a Mac keeps the older CSS zoom rules, where boxes are reported in their own px and the
//    pointer would drift): no CSS zoom; the dialog points to the browser's own zoom (⌘ + / ⌘ −).
import { prefs } from './db.js';
import { normalizeScreen, zoomLocked, clampScale, suggestScreen, viewportContent, scaleMedia, setUiZoom, uiZoom } from './core/screen.js';

export { uiZoom, toCss } from './core/screen.js';

/** What this device is: touch, iPad/iPhone (also an iPad asking for the desktop site), screen sides, window width. */
export function deviceInfo() {
  const s = window.screen || { width: innerWidth, height: innerHeight };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const touch = matchMedia?.('(pointer: coarse)').matches || false;
  return { touch, ios, short: Math.min(s.width, s.height), long: Math.max(s.width, s.height), width: innerWidth };
}

let standardZoom = null;
/** Whether CSS zoom follows the standard here: a box with zoom 2 is reported twice as wide (Chrome 128+, Firefox 126+). */
function zoomIsStandard() {
  if (standardZoom == null) {
    const width = (z) => {
      const p = document.createElement('div');
      p.style.cssText = `position:absolute;left:0;top:0;width:100px;height:1px;visibility:hidden;pointer-events:none;zoom:${z}`;
      document.documentElement.appendChild(p);
      const w = p.getBoundingClientRect().width;
      p.remove();
      return w;
    };
    standardZoom = Math.abs(width(2) / width(1) - 2) < 0.05;
  }
  return standardZoom;
}

/** How this device draws Najja at another size: 'viewport' (touch), 'zoom' (CSS zoom) or 'browser' (⌘ + / ⌘ −). */
export function scaleMode(d = deviceInfo()) {
  if (d.touch || d.ios) return 'viewport';
  return zoomIsStandard() ? 'zoom' : 'browser';
}

export const loadScreen = () => normalizeScreen(prefs.get('screen') || {});
export function saveScreen(setting) {
  const s = normalizeScreen(setting);
  prefs.set('screen', s);
  applyScreen(s);
  // panels that measure themselves on resize (timeline, preview, canvas) measure again at the new size
  window.dispatchEvent(new Event('resize'));
  return s;
}
export const suggestedScreen = () => suggestScreen(deviceInfo());

/**
 * Draws Najja at the chosen scale and sets the zoom lock. CSS zoom: on <html>, and --ui-zoom keeps the full-height
 * editor exactly one screen high. Viewport: initial-scale in the viewport meta. The lock pins the scale in the
 * viewport meta (no zoom when a field gets focus) and sets data-zoom-lock (touch-action: manipulation in CSS: no
 * double-tap zoom); a pinch is stopped by the listeners below.
 */
export function applyScreen(setting = loadScreen()) {
  const root = document.documentElement;
  const d = deviceInfo();
  const mode = scaleMode(d);
  const z = mode === 'browser' ? 1 : clampScale(setting.scale) / 100;
  setUiZoom(mode === 'zoom' ? z : 1);
  if (uiZoom() === 1) { root.style.removeProperty('zoom'); root.style.removeProperty('--ui-zoom'); }
  else { root.style.zoom = String(z); root.style.setProperty('--ui-zoom', String(z)); }
  scaleMediaRules(uiZoom());
  const lock = zoomLocked(setting, d);
  root.toggleAttribute('data-zoom-lock', lock);
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp) vp.setAttribute('content', viewportContent(vp.getAttribute('content'), mode === 'viewport' ? z : 1, lock));
}

const mediaText = new WeakMap(); // each media rule's own text, as written in the CSS
/** Our layout breakpoints (@media max-width …) follow the page's size under CSS zoom, not the window's (scaleMedia). */
function scaleMediaRules(z) {
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; } // (fonts from another site: not ours, not readable)
    for (const rule of rules || []) {
      if (!rule.media || !/(width|height)/.test(rule.media.mediaText)) continue;
      if (!mediaText.has(rule)) mediaText.set(rule, rule.media.mediaText);
      const want = z === 1 ? mediaText.get(rule) : scaleMedia(mediaText.get(rule), z);
      if (rule.media.mediaText !== want) rule.media.mediaText = want;
    }
  }
}

// Safari ignores user-scalable=no: while the zoom lock is on, a pinch is stopped here (gesture* events are Safari's).
for (const type of ['gesturestart', 'gesturechange']) {
  document.addEventListener(type, (e) => { if (document.documentElement.hasAttribute('data-zoom-lock') && e.cancelable) e.preventDefault(); }, { passive: false });
}

applyScreen();
// (a stylesheet still loading has its breakpoints scaled once it is there)
if (document.readyState !== 'complete') window.addEventListener('load', () => scaleMediaRules(uiZoom()), { once: true });
