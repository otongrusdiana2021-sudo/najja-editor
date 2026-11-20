// Najja Desain (v1.13): marketplace templates — product photo, promo, variants, features, bundling, flash sale,
// story, banner, thank-you card. Original layouts made for Najja (no third-party templates); every product photo
// is a frame slot: tap it and pick a photo, it fills the frame. A template is a function of the page (any size:
// places are fractions of the page, sizes follow its shorter side), so it fits the design it is used in.
import { textEl, shapeEl, slotEl, iconEl, badgeEl, swatchEl, unit } from './model.js';

// A few Lucide icons (ISC licence, https://lucide.dev — the full set comes from /vendor) the templates draw with.
export const ICON_NODES = {"zap":[["path",{"d":"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"}]],"check":[["path",{"d":"M20 6 9 17l-5-5"}]],"circle-check":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]],"star":[["path",{"d":"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"}]],"truck":[["path",{"d":"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"}],["path",{"d":"M15 18H9"}],["path",{"d":"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"}],["circle",{"cx":"17","cy":"18","r":"2"}],["circle",{"cx":"7","cy":"18","r":"2"}]],"clock":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l4 2"}]],"shield-check":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m9 12 2 2 4-4"}]],"shopping-cart":[["path",{"d":"m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18"}],["path",{"d":"M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25"}],["circle",{"cx":"18","cy":"20","r":"2"}],["circle",{"cx":"8","cy":"20","r":"2"}]],"sparkles":[["path",{"d":"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"}],["path",{"d":"M20 2v4"}],["path",{"d":"M22 4h-4"}],["circle",{"cx":"4","cy":"20","r":"2"}]],"heart":[["path",{"d":"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"}]],"gift":[["path",{"d":"M12 7v14"}],["path",{"d":"M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"}],["path",{"d":"M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5"}],["rect",{"x":"3","y":"7","width":"18","height":"4","rx":"1"}]],"tag":[["path",{"d":"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"}],["circle",{"cx":"7.5","cy":"7.5","r":".5","fill":"currentColor"}]],"timer":[["line",{"x1":"10","x2":"14","y1":"2","y2":"2"}],["line",{"x1":"12","x2":"15","y1":"14","y2":"11"}],["circle",{"cx":"12","cy":"14","r":"8"}]],"badge-percent":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"M9 9h.01"}],["path",{"d":"M15 15h.01"}]],"droplets":[["path",{"d":"M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"}],["path",{"d":"M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"}]],"package":[["path",{"d":"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"}],["path",{"d":"M12 22V12"}],["polyline",{"points":"3.29 7 12 12 20.71 7"}],["path",{"d":"m7.5 4.27 9 5.15"}]],"plus":[["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],"arrow-right":[["path",{"d":"M5 12h14"}],["path",{"d":"m12 5 7 7-7 7"}]],"feather":[["path",{"d":"M14.086 18.412A2 2 0 0112.67 19H5v-7.672a2 2 0 01.586-1.414L11.75 3.75a6 6 0 118.49 8.49z"}],["path",{"d":"M16 8 2 22"}],["path",{"d":"M17.488 15H9"}]]};

/** Page px of a 1080 × 1080 layout → the element's place (fractions of the page from its centre). */
const atB = (bw, bh) => (px, py) => ({ x: Math.round((px / bw - 0.5) * 10000) / 10000, y: Math.round((py / bh - 0.5) * 10000) / 10000 });
const at = atB(1080, 1080);
const icon = (page, name, px, py, look = {}, size = 1, A = at) => iconEl(page, name, ICON_NODES[name], { ...A(px, py), scale: Math.round(unit(page) * size * 100) / 100 }, look);

export const TEMPLATES = [
  {
    id: 'diskon', name: 'Diskon Besar', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#FFF1E6' },
      els: [
        shapeEl(p, 'circle', { ...at(1000, 120), opacity: 0.9 }, { w: 520 * unit(p), h: 520 * unit(p), fill: '#FFD9C2' }),
        slotEl(p, 'rect', 700, 700, { ...at(540, 560), radius: 48, fill: '#FFFFFF' }),
        shapeEl(p, 'burst', { ...at(210, 230), rotation: -12 }, { w: 330 * unit(p), h: 330 * unit(p), fill: '#FFD400' }),
        textEl(p, { content: 'DISKON\n50%', font: 'Anton', weight: 400, size: 92, color: '#E53935', lineHeight: 1 }, { ...at(210, 230), rotation: -12 }),
        badgeEl(p, { text: 'GRATIS ONGKIR', icon: '🚚', bg: '#00A86B', fg: '#FFFFFF' }, { ...at(735, 112), scale: Math.round(unit(p) * 0.82 * 100) / 100 }),
        textEl(p, { content: 'Rp299.000', font: 'Poppins', weight: 600, size: 44, color: '#8A8F98', strike: true, strikeColor: '#E53935' }, at(320, 950)),
        shapeEl(p, 'tag', at(720, 950), { w: 520 * unit(p), h: 150 * unit(p), fill: '#E53935' }),
        textEl(p, { content: 'Rp149.000', font: 'Poppins', weight: 800, size: 76, color: '#FFFFFF' }, at(745, 950)),
      ],
    }),
  },
  {
    id: 'koleksi', name: 'Koleksi Baru', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#F6EFE7' },
      els: [
        textEl(p, { content: 'New Arrival', font: 'Instrument Serif', weight: 400, italic: true, size: 128, color: '#2B2B2B' }, at(540, 130)),
        textEl(p, { content: 'OLIVE BAG SERIES', font: 'Poppins', weight: 600, size: 34, color: '#7A6A58', letterSpacing: 8 }, at(540, 225)),
        slotEl(p, 'rect', 640, 600, { ...at(540, 580), radius: 300, fill: '#EADFD2' }),
        swatchEl(p, '#141414', 'Hitam', at(330, 960)),
        swatchEl(p, '#F3E5C8', 'Cream', at(540, 960)),
        swatchEl(p, '#B2BFA4', 'Sage', at(750, 960)),
      ],
    }),
  },
  {
    id: 'bestseller', name: 'Best Seller', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#141414' },
      els: [
        icon(p, 'star', 300, 120, { color: '#F8D86A', fill: '#F8D86A' }, 0.38),
        textEl(p, { content: 'BEST SELLER', font: 'Anton', weight: 400, size: 104, color: '#F8D86A', letterSpacing: 4 }, at(540, 120)),
        icon(p, 'star', 780, 120, { color: '#F8D86A', fill: '#F8D86A' }, 0.38),
        slotEl(p, 'rect', 720, 640, { ...at(540, 560), radius: 36, fill: '#232323' }),
        textEl(p, { content: '★★★★★  4.9  ·  Terjual 1rb+', font: 'Poppins', weight: 600, size: 40, color: '#FFFFFF' }, at(540, 935)),
        badgeEl(p, { text: 'FAVORIT PEMBELI', icon: '❤️', bg: '#F8D86A', fg: '#141414' }, at(540, 1010)),
      ],
    }),
  },
  {
    id: 'fitur', name: 'Fitur Produk', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#FFFFFF' },
      els: [
        textEl(p, { content: 'Kenapa pilih tas ini?', font: 'Poppins', weight: 800, size: 70, color: '#1B2B3A' }, at(540, 110)),
        slotEl(p, 'rect', 470, 760, { ...at(285, 590), radius: 32 }),
        ...[['droplets', 'Anti air', 360], ['package', 'Muat 5–6 outfit', 560], ['feather', 'Ringan & kuat', 760]].flatMap(([name, label, y]) => [
          shapeEl(p, 'circle', at(615, y), { w: 120 * unit(p), h: 120 * unit(p), fill: '#E3F6F8' }),
          icon(p, name, 615, y, { color: '#1A97A6' }, 0.32),
          textEl(p, { content: label, font: 'Poppins', weight: 700, size: 46, color: '#1B2B3A', align: 'left', width: 300 }, at(850, y)),
        ]),
        shapeEl(p, 'pill', at(780, 960), { w: 420 * unit(p), h: 110 * unit(p), fill: '#1A97A6' }),
        textEl(p, { content: 'Cek keranjang 🛒', font: 'Poppins', weight: 700, size: 40, color: '#FFFFFF' }, at(780, 960)),
      ],
    }),
  },
  {
    id: 'varian', name: 'Varian Warna', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#F4F6F8' },
      els: [
        textEl(p, { content: 'Pilih Warnamu', font: 'Poppins', weight: 800, size: 76, color: '#1B2B3A' }, at(540, 95)),
        ...[[300, 330, '#141414', 'Hitam'], [780, 330, '#F3E5C8', 'Cream'], [300, 770, '#D8A7B1', 'Dusty Pink'], [780, 770, '#B2BFA4', 'Sage']].flatMap(([x, y, hex, label]) => [
          slotEl(p, 'rect', 420, 360, { ...at(x, y - 20), radius: 28, fill: '#FFFFFF' }, label),
          swatchEl(p, hex, label, at(x, y + 200), { weight: 600 }),
        ]),
      ],
    }),
  },
  {
    id: 'bundling', name: 'Bundling Hemat', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#EAF7F1' },
      els: [
        textEl(p, { content: 'PAKET BUNDLING', font: 'Anton', weight: 400, size: 96, color: '#0B5D3B', letterSpacing: 2 }, at(540, 115)),
        slotEl(p, 'rect', 420, 470, { ...at(285, 480), radius: 32, fill: '#FFFFFF' }, 'Produk 1'),
        slotEl(p, 'rect', 420, 470, { ...at(795, 480), radius: 32, fill: '#FFFFFF' }, 'Produk 2'),
        shapeEl(p, 'circle', at(540, 480), { w: 120 * unit(p), h: 120 * unit(p), fill: '#0B5D3B' }),
        icon(p, 'plus', 540, 480, { color: '#FFFFFF', stroke: 3 }, 0.32),
        shapeEl(p, 'burst', { ...at(900, 230), rotation: 10 }, { w: 230 * unit(p), h: 230 * unit(p), fill: '#FFD400' }),
        textEl(p, { content: 'HEMAT\n30%', font: 'Anton', weight: 400, size: 60, color: '#0B5D3B', lineHeight: 1 }, { ...at(900, 230), rotation: 10 }),
        textEl(p, { content: 'Rp258.000', font: 'Poppins', weight: 600, size: 44, color: '#6B7C74', strike: true, strikeColor: '#E53935' }, at(540, 820)),
        textEl(p, { content: 'Rp179.000', font: 'Poppins', weight: 800, size: 96, color: '#0B5D3B' }, at(540, 905)),
      ],
    }),
  },
  {
    id: 'flash', name: 'Flash Sale', for: ['produk', 'feed', 'story'],
    make: (p) => ({
      bg: { color: '#B3122E', color2: '#FF5A36', angle: 135 },
      els: [
        icon(p, 'zap', 190, 130, { color: '#FFE600', fill: '#FFE600' }, 0.55),
        textEl(p, { content: 'FLASH SALE', font: 'Anton', weight: 400, size: 128, color: '#FFFFFF', effect: { type: 'shadow', color: '#5A0010', offset: 40, intensity: 70 } }, at(600, 130)),
        slotEl(p, 'rect', 680, 620, { ...at(540, 545), radius: 40, fill: '#FFFFFF' }),
        shapeEl(p, 'pill', at(540, 925), { w: 560 * unit(p), h: 120 * unit(p), fill: '#FFE600' }),
        icon(p, 'timer', 330, 925, { color: '#B3122E', stroke: 2.5 }, 0.3),
        textEl(p, { content: 'TINGGAL 2 HARI', font: 'Poppins', weight: 800, size: 50, color: '#B3122E' }, at(575, 925)),
      ],
    }),
  },
  {
    id: 'story', name: 'Promo Story', for: ['story'],
    // (laid out on 1080 × 1920)
    make: (p, at = atB(1080, 1920)) => ({
      bg: { color: '#FCE8EE' },
      els: [
        textEl(p, { content: 'Lagi diskon!', font: 'Pacifico', weight: 400, size: 96, color: '#D6336C' }, at(540, 210)),
        textEl(p, { content: 'TAS TRAVEL LIPAT', font: 'Poppins', weight: 800, size: 64, color: '#2B2B2B', letterSpacing: 2 }, at(540, 330)),
        slotEl(p, 'rect', 760, 820, { ...at(540, 860), radius: 60, fill: '#FFFFFF' }),
        textEl(p, { content: 'Rp149.000', font: 'Poppins', weight: 800, size: 100, color: '#D6336C' }, at(540, 1400)),
        badgeEl(p, { text: 'KLIK KERANJANG KUNING', icon: '🛒', bg: '#FFD400', fg: '#111111' }, at(540, 1540)),
      ],
    }),
  },
  {
    id: 'banner', name: 'Banner Payday', for: ['banner', 'lebar'],
    // (laid out on 1920 × 640)
    make: (p, at = atB(1920, 640)) => ({
      bg: { color: '#1B2B3A', color2: '#1A97A6', angle: 0 },
      els: [
        textEl(p, { content: 'PAYDAY\nSALE', font: 'Anton', weight: 400, size: 190, color: '#FFFFFF', lineHeight: 0.95, align: 'left' }, at(420, 270)),
        badgeEl(p, { text: 'DISKON S/D 50%', icon: '🏷️', bg: '#FFD400', fg: '#111111' }, at(420, 520)),
        slotEl(p, 'rect', 880, 880, { ...at(1060, 320), radius: 50, fill: '#FFFFFF' }, 'Produk 1'),
        slotEl(p, 'rect', 880, 880, { ...at(1600, 320), radius: 50, fill: '#F1F5F8' }, 'Produk 2'),
      ],
    }),
  },
  {
    id: 'kartu', name: 'Kartu Terima Kasih', for: ['kartu'],
    // (laid out on 1080 × 1620, a 10 × 15 cm card)
    make: (p, at = atB(1080, 1620)) => ({
      bg: { color: '#FFFDF8' },
      els: [
        shapeEl(p, 'rect', at(540, 810), { w: 0.9 * p.width, h: 0.93 * p.height, fill: 'none', stroke: { enabled: true, color: '#D9C7A7', width: 4 } }),
        icon(p, 'heart', 540, 300, { color: '#D6336C', fill: '#F9D7E2' }, 0.5, at),
        textEl(p, { content: 'Terima kasih!', font: 'Pacifico', weight: 400, size: 120, color: '#2B2B2B' }, at(540, 560)),
        textEl(p, { content: 'Sudah belanja di toko kami. Semoga tasnya menemani setiap perjalananmu.', font: 'Poppins', weight: 400, size: 42, color: '#5B5B5B', width: 800, lineHeight: 1.45 }, at(540, 760)),
        textEl(p, { content: 'Puas? Bantu kami dengan ulasan ★★★★★', font: 'Poppins', weight: 700, size: 40, color: '#2B2B2B', width: 820 }, at(540, 960)),
        shapeEl(p, 'rect', at(540, 1150), { w: 640 * unit(p), h: 150 * unit(p), fill: '#2B2B2B', radius: 24 * unit(p) }),
        textEl(p, { content: 'Kode voucher: NAJJA10', font: 'Poppins', weight: 800, size: 46, color: '#FFFFFF' }, at(540, 1150)),
        textEl(p, { content: 'NAJJA', font: 'Raleway', weight: 500, size: 44, color: '#8A7A60', letterSpacing: 14 }, at(540, 1440)),
      ],
    }),
  },
];
export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || null;
/** Templates for a design: those made for its size first. */
export function templatesFor(sizeId) {
  return [...TEMPLATES].sort((a, b) => (b.for.includes(sizeId) - a.for.includes(sizeId)));
}

/** A place near the page's centre, in px of a 1080 px page (dx, dy) → fractions of this page. */
const near = (p, dx, dy) => ({ x: Math.round(((dx * unit(p)) / p.width) * 10000) / 10000, y: Math.round(((dy * unit(p)) / p.height) * 10000) / 10000 });
/** Text combinations for marketplace designs (the Teks panel): added together, selected together. */
export const COMBOS = [
  {
    id: 'harga', name: 'Harga coret',
    make: (p) => [
      textEl(p, { content: 'Rp299.000', font: 'Poppins', weight: 600, size: 46, color: '#8A8F98', strike: true, strikeColor: '#E53935' }, near(p, 0, -70)),
      textEl(p, { content: 'Rp149.000', font: 'Poppins', weight: 800, size: 110, color: '#E53935' }, near(p, 0, 20)),
    ],
  },
  {
    id: 'diskon', name: 'Diskon',
    make: (p) => [
      textEl(p, { content: 'DISKON', font: 'Poppins', weight: 800, size: 64, color: '#111111', letterSpacing: 10 }, near(p, 0, -110)),
      textEl(p, { content: '50%', font: 'Anton', weight: 400, size: 230, color: '#E53935', lineHeight: 1 }, near(p, 0, 40)),
    ],
  },
  {
    id: 'baru', name: 'Koleksi baru',
    make: (p) => [
      textEl(p, { content: 'New Arrival', font: 'Instrument Serif', weight: 400, italic: true, size: 130, color: '#2B2B2B' }, near(p, 0, -30)),
      textEl(p, { content: 'KOLEKSI TERBARU', font: 'Poppins', weight: 600, size: 34, color: '#7A6A58', letterSpacing: 9 }, near(p, 0, 70)),
    ],
  },
  {
    id: 'flash', name: 'Flash sale',
    make: (p) => [
      textEl(p, { content: 'FLASH SALE', font: 'Anton', weight: 400, size: 120, color: '#FFD400', bg: { enabled: true, color: '#E53935', opacity: 1, radius: 18, padding: 1 } }, near(p, 0, -40)),
      textEl(p, { content: 'Hari ini saja · 12.00–15.00', font: 'Poppins', weight: 600, size: 40, color: '#111111' }, near(p, 0, 80)),
    ],
  },
  {
    id: 'ongkir', name: 'Gratis ongkir',
    make: (p) => [
      textEl(p, { content: 'GRATIS ONGKIR', font: 'Poppins', weight: 800, size: 74, color: '#FFFFFF', bg: { enabled: true, color: '#00A86B', opacity: 1, radius: 60, padding: 1 } }, near(p, 0, -30)),
      textEl(p, { content: 'ke seluruh Indonesia', font: 'Poppins', weight: 500, size: 38, color: '#1B5E45' }, near(p, 0, 65)),
    ],
  },
  {
    id: 'ulasan', name: 'Ulasan',
    make: (p) => [
      textEl(p, { content: '★★★★★', font: 'Poppins', weight: 700, size: 80, color: '#FFB800', letterSpacing: 6 }, near(p, 0, -60)),
      textEl(p, { content: '4.9 · Terjual 10rb+', font: 'Poppins', weight: 700, size: 52, color: '#111111' }, near(p, 0, 25)),
      textEl(p, { content: '“Bahannya tebal, jahitan rapi!”', font: 'Poppins', weight: 400, italic: true, size: 36, color: '#5B6676' }, near(p, 0, 90)),
    ],
  },
  {
    id: 'judul', name: 'Judul produk',
    make: (p) => [
      textEl(p, { content: 'TAS SELEMPANG', font: 'Bebas Neue', weight: 400, size: 150, color: '#111111', letterSpacing: 4 }, near(p, 0, -40)),
      textEl(p, { content: 'Ringan · Anti air · Muat banyak', font: 'Poppins', weight: 500, size: 40, color: '#5B6676' }, near(p, 0, 55)),
    ],
  },
  {
    id: 'cta', name: 'Ajakan beli',
    make: (p) => [
      textEl(p, { content: 'Checkout sekarang', font: 'Poppins', weight: 800, size: 60, color: '#FFFFFF', bg: { enabled: true, color: '#111111', opacity: 1, radius: 60, padding: 1.2 } }, near(p, 0, 0)),
      textEl(p, { content: 'Stok terbatas!', font: 'Caveat', weight: 700, size: 64, color: '#E53935' }, { ...near(p, 230, -85), rotation: -8 }),
    ],
  },
];
