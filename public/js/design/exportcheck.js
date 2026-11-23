// (v1.13.2, P0-5) What an export of Najja Desain needs before it draws, so the file is the design on screen:
// every photo (a photo that does not load stops the export, it is never left out silently), every font (a font
// that did not load is said, the user may still go on), and a size the device can draw. No DOM here: Node tests.
import { fontWeightFor } from '../render.js';

/**
 * Canvas area every browser draws: iPadOS/iOS Safari refuses a bigger canvas (4096 × 4096). Desktop browsers
 * draw much bigger ones, so a bigger export is tried there first (canvasFits in draw.js) and only made smaller
 * when the device cannot draw it.
 */
export const SAFE_PIXELS = 4096 * 4096;

/** The photos the pages show: { id, pages: [page numbers, from 1] }, background photos included. */
export function photosOf(pages) {
  const out = new Map();
  pages.forEach((p, i) => {
    const add = (id) => {
      if (!id) return;
      const o = out.get(id) || { id, pages: [] };
      if (!o.pages.includes(i + 1)) o.pages.push(i + 1);
      out.set(id, o);
    };
    add(p.bg?.mediaId);
    for (const e of p.els || []) add(e.mediaId);
  });
  return [...out.values()];
}

/** The fonts the texts of the pages use: { family, spec, text } for document.fonts.load/check (one per font look). */
export function fontsOf(pages) {
  const out = new Map();
  for (const p of pages) {
    for (const e of p.els || []) {
      if (e.type !== 'text' || !e.text?.font) continue;
      const t = e.text;
      const spec = `${t.italic ? 'italic ' : ''}${fontWeightFor(t.font, t.weight || 400)} 40px "${t.font}"`;
      const o = out.get(spec) || { family: t.font, spec, text: '' };
      o.text = [...new Set(o.text + String(t.content || ''))].join('').slice(0, 400); // (the letters used: their subsets)
      out.set(spec, o);
    }
  }
  return [...out.values()];
}

/**
 * The scale to export at: the one asked for when the device draws it, else the largest one at most SAFE_PIXELS.
 * fits(width, height): whether this device can draw a canvas that big (only asked above SAFE_PIXELS).
 */
export function exportScale(w, h, want, fits = () => true) {
  const area = (s) => Math.round(w * s) * Math.round(h * s);
  if (area(want) <= SAFE_PIXELS || fits(Math.round(w * want), Math.round(h * want))) return want;
  let k = Math.floor(Math.sqrt(SAFE_PIXELS / (w * h)) * 1000); // (in thousandths: no float drift)
  while (k > 1 && area(k / 1000) > SAFE_PIXELS) k--; // (rounding of the sides)
  return Math.min(want, Math.max(1, k) / 1000);
}

/** "foto.jpg (hal. 2)", from the design's media list. */
export function photoLabel(design, { id, pages }) {
  const name = design.media?.find((m) => m.id === id)?.name || 'foto';
  return `"${name}"${design.pages?.length > 1 ? ` (hal. ${pages.join(', ')})` : ''}`;
}
