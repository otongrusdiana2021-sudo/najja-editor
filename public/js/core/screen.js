// (v1.13.2) Ukuran layar: how big Najja is drawn on this device, set in the account menu, like the ecom app
// (src/lib/theme.js there). Devices differ (iPad mini to a 27" monitor), the design stays the same: only the scale.
// Kept per device (localStorage, public/js/screen.js). No DOM here: Node tests.

export const SCALE_MIN = 75;
export const SCALE_MAX = 130;

export const SCREENS = [
  { id: 'auto', group: 'Otomatis', label: 'Otomatis', sub: 'ukuran asli perangkat ini', scale: 100, kind: 'auto' },
  { id: 'phone', group: 'HP', label: 'HP', sub: 'sampai 6,9 inci', scale: 100, kind: 'phone', touch: true },
  { id: 'ipad-mini', group: 'Tablet', label: 'iPad mini', sub: '8,3 inci', scale: 90, kind: 'tablet', touch: true },
  { id: 'ipad', group: 'Tablet', label: 'iPad / iPad Air 11', sub: '10,9–11 inci', scale: 95, kind: 'tablet', touch: true },
  { id: 'ipad-pro', group: 'Tablet', label: 'iPad Pro / Air 13', sub: '12,9–13 inci', scale: 100, kind: 'tablet', touch: true },
  { id: 'laptop13', group: 'Laptop', label: 'Laptop 13 inci', sub: 'MacBook Air 13 · ±1280–1470 px', scale: 90, kind: 'laptop' },
  { id: 'laptop14', group: 'Laptop', label: 'Laptop 14 inci', sub: '±1366–1512 px', scale: 90, kind: 'laptop' },
  { id: 'laptop15', group: 'Laptop', label: 'Laptop 15–15,6 inci', sub: '±1440–1536 px', scale: 95, kind: 'laptop' },
  { id: 'laptop16', group: 'Laptop', label: 'Laptop 16 inci', sub: 'MacBook Pro 16 · ±1536–1728 px', scale: 100, kind: 'laptop' },
  { id: 'monitor24', group: 'Monitor', label: 'Monitor 21–24 inci', sub: '±1920 px', scale: 100, kind: 'monitor' },
  { id: 'monitor27', group: 'Monitor', label: 'Monitor 27 inci ke atas', sub: '±2560 px', scale: 110, kind: 'monitor' },
];

export const DEFAULT_SCREEN = Object.freeze({ id: 'auto', scale: 100, lock: null }); // lock null: on for touch screens

export const clampScale = (v) => {
  const n = Math.round((Number(v) || 100) / 5) * 5;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
};

/** A stored setting made whole (older or broken values fall back to the defaults). */
export function normalizeScreen(s = {}) {
  const id = SCREENS.some((x) => x.id === s?.id) ? s.id : DEFAULT_SCREEN.id;
  return { id, scale: s?.scale == null ? DEFAULT_SCREEN.scale : clampScale(s.scale), lock: typeof s?.lock === 'boolean' ? s.lock : null };
}

/**
 * The preset this device most likely is. d: { touch, ios, short, long, width } (screen sides in CSS px).
 * Touch screens by their short side; laptops and monitors by the window width.
 */
export function suggestScreen(d) {
  if (d.touch || d.ios) {
    if (d.short < 600) return 'phone';
    if (d.short < 800) return 'ipad-mini';
    if (d.short < 1000) return 'ipad';
    return 'ipad-pro';
  }
  const w = d.width;
  if (w < 1500) return 'laptop14';
  if (w < 1600) return 'laptop15';
  if (w < 1800) return 'laptop16';
  if (w < 2200) return 'monitor24';
  return 'monitor27';
}

/** Whether the zoom lock is on: the owner's choice, or by default on touch screens (phones, tablets). */
export const zoomLocked = (setting, d) => (setting.lock == null ? Boolean(d.touch || d.ios) : setting.lock);
