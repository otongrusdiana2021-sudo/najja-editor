// Najja Desain (v1.13): marketplace templates — product photo, promo, variants, features, bundling, flash sale,
// story, banner, thank-you card. Original layouts made for Najja (no third-party templates); every product photo
// is a frame slot: tap it and pick a photo, it fills the frame. A template is a function of the page (any size:
// places are fractions of the page, sizes follow its shorter side), so it fits the design it is used in.
import { textEl, shapeEl, slotEl, iconEl, badgeEl, swatchEl, unit } from './model.js';

// A few Lucide icons (ISC licence, https://lucide.dev — the full set comes from /vendor) the templates draw with.
export const ICON_NODES = {"zap":[["path",{"d":"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"}]],"check":[["path",{"d":"M20 6 9 17l-5-5"}]],"circle-check":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]],"star":[["path",{"d":"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"}]],"truck":[["path",{"d":"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"}],["path",{"d":"M15 18H9"}],["path",{"d":"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"}],["circle",{"cx":"17","cy":"18","r":"2"}],["circle",{"cx":"7","cy":"18","r":"2"}]],"clock":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 6v6l4 2"}]],"shield-check":[["path",{"d":"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"}],["path",{"d":"m9 12 2 2 4-4"}]],"shopping-cart":[["path",{"d":"m2.05 2.05 1.099-.028a1 1 0 0 1 1.008.815l2.69 14.347A1 1 0 0 0 7.83 18H18"}],["path",{"d":"M4.563 5h16.435a1 1 0 0 1 .981 1.204l-1.026 6.226A2 2 0 0 1 18.962 14H6.25"}],["circle",{"cx":"18","cy":"20","r":"2"}],["circle",{"cx":"8","cy":"20","r":"2"}]],"sparkles":[["path",{"d":"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"}],["path",{"d":"M20 2v4"}],["path",{"d":"M22 4h-4"}],["circle",{"cx":"4","cy":"20","r":"2"}]],"heart":[["path",{"d":"M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"}]],"gift":[["path",{"d":"M12 7v14"}],["path",{"d":"M20 11v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"}],["path",{"d":"M7.5 7a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5 1 1 0 0 1 0 5"}],["rect",{"x":"3","y":"7","width":"18","height":"4","rx":"1"}]],"tag":[["path",{"d":"M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"}],["circle",{"cx":"7.5","cy":"7.5","r":".5","fill":"currentColor"}]],"timer":[["line",{"x1":"10","x2":"14","y1":"2","y2":"2"}],["line",{"x1":"12","x2":"15","y1":"14","y2":"11"}],["circle",{"cx":"12","cy":"14","r":"8"}]],"badge-percent":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"M9 9h.01"}],["path",{"d":"M15 15h.01"}]],"droplets":[["path",{"d":"M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"}],["path",{"d":"M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"}]],"package":[["path",{"d":"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"}],["path",{"d":"M12 22V12"}],["polyline",{"points":"3.29 7 12 12 20.71 7"}],["path",{"d":"m7.5 4.27 9 5.15"}]],"plus":[["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]],"arrow-right":[["path",{"d":"M5 12h14"}],["path",{"d":"m12 5 7 7-7 7"}]],"feather":[["path",{"d":"M14.086 18.412A2 2 0 0112.67 19H5v-7.672a2 2 0 01.586-1.414L11.75 3.75a6 6 0 118.49 8.49z"}],["path",{"d":"M16 8 2 22"}],["path",{"d":"M17.488 15H9"}]],"moon":[["path",{"d":"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"}]],"ruler":[["path",{"d":"M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"}],["path",{"d":"m14.5 12.5 2-2"}],["path",{"d":"m11.5 9.5 2-2"}],["path",{"d":"m8.5 6.5 2-2"}],["path",{"d":"m17.5 15.5 2-2"}]],"ticket":[["path",{"d":"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"}],["path",{"d":"M13 5v2"}],["path",{"d":"M13 17v2"}],["path",{"d":"M13 11v2"}]],"calendar-days":[["path",{"d":"M8 2v3"}],["path",{"d":"M16 2v3"}],["rect",{"x":"3","y":"3","width":"18","height":"18","rx":"2"}],["path",{"d":"M3 9h18"}],["path",{"d":"M8 13h.01"}],["path",{"d":"M12 13h.01"}],["path",{"d":"M16 13h.01"}],["path",{"d":"M8 17h.01"}],["path",{"d":"M12 17h.01"}],["path",{"d":"M16 17h.01"}]],"quote":[["path",{"d":"M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"}],["path",{"d":"M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"}]],"thumbs-up":[["path",{"d":"M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"}],["path",{"d":"M7 10v12"}]],"wallet":[["path",{"d":"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"}],["path",{"d":"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"}]],"package-check":[["path",{"d":"M12 22V12"}],["path",{"d":"m16 17 2 2 4-4"}],["path",{"d":"M21 11.127V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.729l7 4a2 2 0 0 0 2 .001l1.32-.753"}],["path",{"d":"M3.29 7 12 12l8.71-5"}],["path",{"d":"m7.5 4.27 8.997 5.148"}]],"megaphone":[["path",{"d":"M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"}],["path",{"d":"M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"}],["path",{"d":"M8 6v8"}]],"crown":[["path",{"d":"M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"}],["path",{"d":"M5 21h14"}]],"badge-check":[["path",{"d":"M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"}],["path",{"d":"m16 9-5.5 5.5L8 12"}]],"refresh-cw":[["path",{"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}],["path",{"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}],["path",{"d":"M8 16H3v5"}]],"hourglass":[["path",{"d":"M5 22h14"}],["path",{"d":"M5 2h14"}],["path",{"d":"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"}],["path",{"d":"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"}]],"award":[["path",{"d":"m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"}],["circle",{"cx":"12","cy":"8","r":"6"}]],"users":[["path",{"d":"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"}],["path",{"d":"M16 3.128a4 4 0 0 1 0 7.744"}],["path",{"d":"M22 21v-2a4 4 0 0 0-3-3.87"}],["circle",{"cx":"9","cy":"7","r":"4"}]],"message-circle":[["path",{"d":"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"}]],"shopping-bag":[["path",{"d":"M16 10a4 4 0 0 1-8 0"}],["path",{"d":"M3.103 6.034h17.794"}],["path",{"d":"M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z"}]],"percent":[["line",{"x1":"19","x2":"5","y1":"5","y2":"19"}],["circle",{"cx":"6.5","cy":"6.5","r":"2.5"}],["circle",{"cx":"17.5","cy":"17.5","r":"2.5"}]],"sun":[["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 2v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"m17.66 17.66 1.41 1.41"}],["path",{"d":"M2 12h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"m6.34 17.66-1.41 1.41"}],["path",{"d":"m19.07 4.93-1.41 1.41"}]],"scissors":[["circle",{"cx":"6","cy":"6","r":"3"}],["path",{"d":"M8.12 8.12 12 12"}],["path",{"d":"M20 4 8.12 15.88"}],["circle",{"cx":"6","cy":"18","r":"3"}],["path",{"d":"M14.8 14.8 20 20"}]],"shirt":[["path",{"d":"M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"}]],"weight":[["circle",{"cx":"12","cy":"5","r":"3"}],["path",{"d":"M6.5 8a2 2 0 0 0-1.905 1.46L2.1 18.5A2 2 0 0 0 4 21h16a2 2 0 0 0 1.925-2.54L19.4 9.5A2 2 0 0 0 17.48 8Z"}]],"box":[["path",{"d":"M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"}],["path",{"d":"m3.3 7 8.7 5 8.7-5"}],["path",{"d":"M12 22V12"}]],"flame":[["path",{"d":"M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"}]],"heart-handshake":[["path",{"d":"M19.414 14.414C21 12.828 22 11.5 22 9.5a5.5 5.5 0 0 0-9.591-3.676.6.6 0 0 1-.818.001A5.5 5.5 0 0 0 2 9.5c0 2.3 1.5 4 3 5.5l5.535 5.362a2 2 0 0 0 2.879.052 2.12 2.12 0 0 0-.004-3 2.124 2.124 0 1 0 3-3 2.124 2.124 0 0 0 3.004 0 2 2 0 0 0 0-2.828l-1.881-1.882a2.41 2.41 0 0 0-3.409 0l-1.71 1.71a2 2 0 0 1-2.828 0 2 2 0 0 1 0-2.828l2.823-2.762"}]],"circle-x":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"m15 9-6 6"}],["path",{"d":"m9 9 6 6"}]],"circle-plus":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M8 12h8"}],["path",{"d":"M12 8v8"}]],"move-horizontal":[["path",{"d":"m18 8 4 4-4 4"}],["path",{"d":"M2 12h20"}],["path",{"d":"m6 8-4 4 4 4"}]]};

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
// ---------------------------------------------------------------------------------------------
// v1.13.1: more marketplace templates (original layouts made for Najja)
const A1920x640 = atB(1920, 640);
const A1920x1080 = atB(1920, 1080);
const A1080x1920 = atB(1080, 1920);
const pillBtn = (p, A, px, py, w, h, fill, text, color, size = 40) => [
  shapeEl(p, 'pill', A(px, py), { w: w * unit(p), h: h * unit(p), fill }),
  textEl(p, { content: text, font: 'Poppins', weight: 700, size, color }, A(px, py)),
];
const MORE = [
  {
    id: 'testimoni', name: 'Testimoni', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#FFF8EE' },
      els: [
        shapeEl(p, 'blob', { ...at(900, 150), opacity: 0.9 }, { w: 420 * unit(p), h: 360 * unit(p), fill: '#FFE1C4' }),
        shapeEl(p, 'blob', { ...at(140, 980), opacity: 0.8, rotation: 30 }, { w: 360 * unit(p), h: 300 * unit(p), fill: '#FFE1C4' }),
        textEl(p, { content: 'Kata Pembeli', font: 'Instrument Serif', weight: 400, italic: true, size: 112, color: '#2B2B2B' }, at(540, 140)),
        textEl(p, { content: 'ULASAN ASLI DARI MARKETPLACE', font: 'Poppins', weight: 600, size: 28, color: '#A0673A', letterSpacing: 6 }, at(540, 235)),
        slotEl(p, 'circle', 420, 420, { ...at(300, 570), fill: '#F1E4D3' }, 'Foto pembeli'),
        icon(p, 'quote', 640, 380, { color: '#E8833A', fill: '#E8833A' }, 0.42),
        textEl(p, { content: 'Tasnya ringan, jahitannya rapi, muat laptop 14 inci. Pengiriman juga cepat!', font: 'Poppins', weight: 500, size: 38, color: '#3A3F47', width: 440, align: 'left', lineHeight: 1.45 }, at(790, 570)),
        textEl(p, { content: '★★★★★', font: 'Poppins', weight: 700, size: 54, color: '#FFB800', letterSpacing: 4 }, at(700, 770)),
        textEl(p, { content: '— Rina, Bandung', font: 'Poppins', weight: 600, size: 34, color: '#2B2B2B' }, at(710, 840)),
        badgeEl(p, { text: 'TERJUAL 10RB+', icon: '🔥', bg: '#2B2B2B', fg: '#FFFFFF' }, { ...at(540, 985), scale: Math.round(unit(p) * 0.8 * 100) / 100 }),
      ],
    }),
  },
  {
    id: 'sebelumsesudah', name: 'Sebelum & Sesudah', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#F4F6F8' },
      els: [
        textEl(p, { content: 'Lihat Bedanya', font: 'Poppins', weight: 800, size: 84, color: '#1F2A44' }, at(540, 130)),
        textEl(p, { content: 'Sebelum & sesudah pakai', font: 'Poppins', weight: 500, size: 36, color: '#5B6676' }, at(540, 215)),
        slotEl(p, 'rect', 440, 560, { ...at(290, 590), radius: 36, fill: '#E3E8EE' }, 'Sebelum'),
        slotEl(p, 'rect', 440, 560, { ...at(790, 590), radius: 36, fill: '#E3E8EE' }, 'Sesudah'),
        shapeEl(p, 'circle', at(540, 590), { w: 110 * unit(p), h: 110 * unit(p), fill: '#FFFFFF', shadow: { enabled: true, color: '#1F2A44', opacity: 0.18, blur: 24, x: 0, y: 8 } }),
        icon(p, 'arrow-right', 540, 590, { color: '#129AA9', stroke: 2.6 }, 0.38),
        badgeEl(p, { text: 'SEBELUM', icon: '', bg: '#5B6676', fg: '#FFFFFF' }, { ...at(290, 925), scale: Math.round(unit(p) * 0.75 * 100) / 100 }),
        badgeEl(p, { text: 'SESUDAH', icon: '✨', bg: '#129AA9', fg: '#FFFFFF' }, { ...at(790, 925), scale: Math.round(unit(p) * 0.75 * 100) / 100 }),
        textEl(p, { content: 'Hasil nyata, tanpa filter', font: 'Poppins', weight: 500, size: 34, color: '#5B6676' }, at(540, 1020)),
      ],
    }),
  },
  {
    id: 'ukuran', name: 'Ukuran Produk', for: ['produk', 'feed'],
    make: (p) => {
      const rows = [['ruler', 'Panjang', '30 cm'], ['move-horizontal', 'Lebar', '12 cm'], ['box', 'Tinggi', '22 cm'], ['weight', 'Berat', '450 gr']];
      return {
        bg: { color: '#FFFFFF' },
        els: [
          shapeEl(p, 'rect', at(330, 540), { w: 600 * unit(p), h: 1080 * unit(p), fill: '#F3EEE7' }),
          slotEl(p, 'rect', 480, 640, { ...at(330, 540), radius: 28, fill: '#E6DED3' }),
          textEl(p, { content: 'Ukuran\nProduk', font: 'Poppins', weight: 800, size: 70, color: '#1B2430', lineHeight: 1.05 }, at(860, 200)),
          ...rows.flatMap(([ic, label, value], i) => {
            const y = 400 + i * 135;
            return [
              icon(p, ic, 715, y, { color: '#129AA9', stroke: 2.2 }, 0.3),
              textEl(p, { content: label, font: 'Poppins', weight: 500, size: 28, color: '#5B6676' }, at(880, y - 22)),
              textEl(p, { content: value, font: 'Poppins', weight: 800, size: 42, color: '#1B2430' }, at(880, y + 22)),
            ];
          }),
          badgeEl(p, { text: 'MUAT LAPTOP 14"', icon: '💻', bg: '#129AA9', fg: '#FFFFFF' }, { ...at(860, 960), scale: Math.round(unit(p) * 0.62 * 100) / 100 }),
        ],
      };
    },
  },
  {
    id: 'carapakai', name: 'Cara Pakai', for: ['produk', 'feed'],
    make: (p) => {
      const steps = ['Buka resleting', 'Masukkan barang', 'Siap dibawa'];
      return {
        bg: { color: '#EEF7F6' },
        els: [
          textEl(p, { content: 'Cara Pakai', font: 'Poppins', weight: 800, size: 88, color: '#0D5F68' }, at(540, 130)),
          ...steps.flatMap((s, i) => {
            const x = 200 + i * 340;
            return [
              slotEl(p, 'rect', 280, 340, { ...at(x, 470), radius: 28, fill: '#D5ECEA' }, `Langkah ${i + 1}`),
              shapeEl(p, 'circle', at(x - 115, 310), { w: 86 * unit(p), h: 86 * unit(p), fill: '#129AA9' }),
              textEl(p, { content: String(i + 1), font: 'Poppins', weight: 800, size: 48, color: '#FFFFFF' }, at(x - 115, 310)),
              textEl(p, { content: s, font: 'Poppins', weight: 600, size: 34, color: '#1B2430', width: 300 }, at(x, 720)),
            ];
          }),
          textEl(p, { content: 'Mudah, cepat, rapi ✨', font: 'Poppins', weight: 500, size: 36, color: '#3A6D72' }, at(540, 880)),
          ...pillBtn(p, at, 540, 990, 520, 96, '#129AA9', 'Cek keranjang kuning', '#FFFFFF', 38),
        ],
      };
    },
  },
  {
    id: 'voucher', name: 'Voucher', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#FF6B5B', color2: '#FFB547', angle: 135 },
      els: [
        textEl(p, { content: 'KHUSUS FOLLOWER', font: 'Poppins', weight: 700, size: 34, color: '#FFFFFF', letterSpacing: 8 }, at(540, 150)),
        shapeEl(p, 'ticket', at(540, 520), { w: 880 * unit(p), h: 500 * unit(p), fill: '#FFFFFF', shadow: { enabled: true, color: '#7A1E0F', opacity: 0.25, blur: 40, x: 0, y: 16 } }),
        shapeEl(p, 'rect', at(760, 520), { w: 4 * unit(p), h: 380 * unit(p), fill: '#FFD0C4' }),
        icon(p, 'ticket', 200, 380, { color: '#E53935', stroke: 2.2 }, 0.32),
        textEl(p, { content: 'VOUCHER DISKON', font: 'Poppins', weight: 800, size: 38, color: '#E53935', letterSpacing: 3 }, at(450, 380)),
        textEl(p, { content: 'Rp20RB', font: 'Anton', weight: 400, size: 170, color: '#1B2430' }, at(430, 520)),
        textEl(p, { content: 'Min. belanja Rp100.000', font: 'Poppins', weight: 500, size: 32, color: '#5B6676' }, at(430, 655)),
        textEl(p, { content: 'KODE', font: 'Poppins', weight: 600, size: 24, color: '#5B6676', letterSpacing: 4 }, at(848, 355)),
        textEl(p, { content: 'NAJJA20', font: 'Poppins', weight: 800, size: 30, color: '#E53935' }, at(848, 400)),
        icon(p, 'scissors', 848, 660, { color: '#B0B7C0' }, 0.24),
        textEl(p, { content: 'Berlaku sampai 30 November', font: 'Poppins', weight: 600, size: 34, color: '#FFFFFF' }, at(540, 870)),
        ...pillBtn(p, at, 540, 980, 460, 92, '#1B2430', 'Klaim sekarang', '#FFFFFF', 36),
      ],
    }),
  },
  {
    id: 'preorder', name: 'Pre-order', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#1F2A44' },
      els: [
        textEl(p, { content: 'PRE-ORDER', font: 'Anton', weight: 400, size: 150, color: '#FFD400', letterSpacing: 4 }, at(540, 150)),
        textEl(p, { content: 'Koleksi terbaru · kuota terbatas', font: 'Poppins', weight: 500, size: 36, color: '#C9D3E3' }, at(540, 255)),
        slotEl(p, 'circle', 520, 520, { ...at(540, 600), fill: '#2C3A57' }),
        shapeEl(p, 'burst', { ...at(830, 410), rotation: 10 }, { w: 230 * unit(p), h: 230 * unit(p), fill: '#FF6B5B' }),
        textEl(p, { content: 'HEMAT\n15%', font: 'Anton', weight: 400, size: 52, color: '#FFFFFF', lineHeight: 1 }, { ...at(830, 410), rotation: 10 }),
        icon(p, 'calendar-days', 300, 960, { color: '#FFD400', stroke: 2.2 }, 0.32),
        textEl(p, { content: 'Dikirim mulai 1 Desember', font: 'Poppins', weight: 600, size: 40, color: '#FFFFFF' }, at(590, 960)),
      ],
    }),
  },
  {
    id: 'restock', name: 'Restock', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#E8F5E9' },
      els: [
        textEl(p, { content: 'READY STOCK\nLAGI!', font: 'Anton', weight: 400, size: 120, color: '#1B5E20', lineHeight: 1 }, at(540, 190)),
        icon(p, 'package-check', 150, 410, { color: '#2E7D32', stroke: 2 }, 0.5),
        slotEl(p, 'arch', 500, 560, { ...at(540, 610), fill: '#D3EBD5' }),
        textEl(p, { content: 'Sebelum habis lagi!', font: 'Caveat', weight: 700, size: 62, color: '#2E7D32' }, { ...at(850, 420), rotation: -8 }),
        swatchEl(p, '#141414', 'Hitam', at(360, 975)),
        swatchEl(p, '#8B5A2B', 'Cokelat', at(540, 975)),
        swatchEl(p, '#E8D8C3', 'Krem', at(720, 975)),
      ],
    }),
  },
  {
    id: 'giveaway', name: 'Giveaway', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#7C3AED', color2: '#EC4899', angle: 135 },
      els: [
        icon(p, 'gift', 140, 150, { color: '#FFFFFF', stroke: 2 }, 0.45),
        icon(p, 'sparkles', 940, 150, { color: '#FFD400', stroke: 2 }, 0.42),
        textEl(p, { content: 'GIVEAWAY', font: 'Anton', weight: 400, size: 150, color: '#FFFFFF', letterSpacing: 2 }, at(540, 150)),
        slotEl(p, 'rect', 560, 420, { ...at(540, 470), radius: 40, fill: '#F3E8FF' }, 'Hadiah'),
        textEl(p, { content: 'Cara ikut:\n1. Follow akun kami\n2. Like postingan ini\n3. Tag 3 teman', font: 'Poppins', weight: 600, size: 38, color: '#FFFFFF', align: 'left', lineHeight: 1.5, width: 560 }, at(540, 810)),
        ...pillBtn(p, at, 540, 1000, 600, 90, '#FFFFFF', 'Pemenang diumumkan 30 Nov', '#7C3AED', 34),
      ],
    }),
  },
  {
    id: 'katalog', name: 'Katalog', for: ['produk', 'feed'],
    make: (p) => {
      const items = [['Tas Selempang', 'Rp149.000'], ['Tote Bag', 'Rp179.000'], ['Ransel Mini', 'Rp199.000'], ['Dompet Kulit', 'Rp99.000']];
      return {
        bg: { color: '#FAFAF7' },
        els: [
          textEl(p, { content: 'Katalog Terbaru', font: 'Poppins', weight: 800, size: 70, color: '#1B2430' }, at(540, 105)),
          ...items.flatMap(([name, price], i) => {
            const x = i % 2 ? 790 : 290;
            const y = i < 2 ? 335 : 765;
            return [
              slotEl(p, 'rect', 420, 300, { ...at(x, y), radius: 24, fill: '#ECEAE4' }),
              textEl(p, { content: name, font: 'Poppins', weight: 600, size: 32, color: '#3A3F47' }, at(x, y + 182)),
              textEl(p, { content: price, font: 'Poppins', weight: 800, size: 36, color: '#E53935' }, at(x, y + 228)),
            ];
          }),
        ],
      };
    },
  },
  {
    id: 'tanggalkembar', name: 'Tanggal Kembar', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#E53935', color2: '#FF7A1A', angle: 135 },
      els: [
        textEl(p, { content: '11.11', font: 'Anton', weight: 400, size: 250, color: '#FFFFFF' }, at(540, 190)),
        textEl(p, { content: 'BIG SALE', font: 'Poppins', weight: 800, size: 70, color: '#FFD400', letterSpacing: 10 }, at(540, 355)),
        slotEl(p, 'rect', 560, 440, { ...at(540, 650), radius: 40, fill: '#FFE3D6' }),
        badgeEl(p, { text: 'DISKON S/D 70%', icon: '🏷️', bg: '#FFD400', fg: '#111111' }, { ...at(290, 965), scale: Math.round(unit(p) * 0.66 * 100) / 100 }),
        badgeEl(p, { text: 'GRATIS ONGKIR', icon: '🚚', bg: '#FFFFFF', fg: '#E53935' }, { ...at(790, 965), scale: Math.round(unit(p) * 0.66 * 100) / 100 }),
      ],
    }),
  },
  {
    id: 'gajian', name: 'Promo Gajian', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#0F766E', color2: '#14B8A6', angle: 160 },
      els: [
        textEl(p, { content: 'PROMO GAJIAN', font: 'Poppins', weight: 800, size: 92, color: '#FFFFFF' }, at(540, 145)),
        textEl(p, { content: 'Tanggal 25–31', font: 'Poppins', weight: 600, size: 44, color: '#CCFBF1' }, at(540, 245)),
        slotEl(p, 'circle', 500, 500, { ...at(540, 590), fill: '#0B5E57' }),
        shapeEl(p, 'burst', { ...at(820, 420), rotation: -8 }, { w: 250 * unit(p), h: 250 * unit(p), fill: '#FFD400' }),
        textEl(p, { content: 'CASH\nBACK\n10%', font: 'Anton', weight: 400, size: 46, color: '#0F766E', lineHeight: 0.95 }, { ...at(820, 420), rotation: -8 }),
        icon(p, 'wallet', 250, 410, { color: '#CCFBF1', stroke: 2 }, 0.4),
        ...pillBtn(p, at, 540, 960, 600, 100, '#FFFFFF', 'Belanja sekarang', '#0F766E', 40),
      ],
    }),
  },
  {
    id: 'ramadhan', name: 'Ramadhan Sale', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#0E3B3C' },
      els: [
        icon(p, 'moon', 540, 120, { color: '#E9C46A', fill: '#E9C46A' }, 0.45),
        textEl(p, { content: 'Ramadhan Sale', font: 'Instrument Serif', weight: 400, italic: true, size: 120, color: '#E9C46A' }, at(540, 255)),
        textEl(p, { content: 'BERKAH BELANJA', font: 'Poppins', weight: 600, size: 30, color: '#BFD8D2', letterSpacing: 10 }, at(540, 345)),
        slotEl(p, 'arch', 480, 520, { ...at(540, 670), fill: '#174F50' }),
        icon(p, 'sparkles', 860, 520, { color: '#E9C46A' }, 0.4),
        icon(p, 'star', 220, 760, { color: '#E9C46A', fill: '#E9C46A' }, 0.25),
        textEl(p, { content: 'Diskon spesial s/d 40%', font: 'Poppins', weight: 700, size: 40, color: '#FFFFFF' }, at(540, 1000)),
      ],
    }),
  },
  {
    id: 'b1g1', name: 'Beli 1 Gratis 1', for: ['produk', 'feed'],
    make: (p) => ({
      bg: { color: '#FFF4D6' },
      els: [
        textEl(p, { content: 'BELI 1\nGRATIS 1', font: 'Anton', weight: 400, size: 140, color: '#D9480F', lineHeight: 1 }, at(540, 210)),
        slotEl(p, 'rect', 380, 420, { ...at(290, 640), radius: 30, fill: '#FFE8A3' }, 'Produk 1'),
        slotEl(p, 'rect', 380, 420, { ...at(790, 640), radius: 30, fill: '#FFE8A3' }, 'Produk 2'),
        shapeEl(p, 'circle', at(540, 640), { w: 120 * unit(p), h: 120 * unit(p), fill: '#D9480F' }),
        icon(p, 'plus', 540, 640, { color: '#FFFFFF', stroke: 3 }, 0.34),
        textEl(p, { content: 'Rp149.000', font: 'Poppins', weight: 800, size: 64, color: '#1B2430' }, at(540, 945)),
        textEl(p, { content: 'untuk 2 tas', font: 'Poppins', weight: 500, size: 34, color: '#5B6676' }, at(540, 1015)),
      ],
    }),
  },
  {
    id: 'storytesti', name: 'Story Ulasan', for: ['story'],
    make: (p, A = A1080x1920) => ({
      bg: { color: '#F7F1EA' },
      els: [
        textEl(p, { content: 'Ulasan Pembeli', font: 'Instrument Serif', weight: 400, italic: true, size: 120, color: '#2B2B2B' }, A(540, 220)),
        slotEl(p, 'rect', 860, 880, { ...A(540, 790), radius: 48, fill: '#E9DFD3' }),
        shapeEl(p, 'bubble2', A(560, 1440), { w: 920 * unit(p), h: 440 * unit(p), fill: '#FFFFFF', shadow: { enabled: true, color: '#2B2B2B', opacity: 0.12, blur: 30, x: 0, y: 10 } }),
        textEl(p, { content: '★★★★★ 4.9', font: 'Poppins', weight: 700, size: 52, color: '#FFB800' }, A(560, 1320)),
        textEl(p, { content: 'Bahannya tebal, warnanya sama persis seperti di foto. Bakal beli lagi!', font: 'Poppins', weight: 500, size: 40, color: '#3A3F47', width: 740, lineHeight: 1.4 }, A(560, 1435)),
        textEl(p, { content: '— Dina, Surabaya', font: 'Poppins', weight: 600, size: 36, color: '#7A6A58' }, A(560, 1560)),
        ...pillBtn(p, A, 540, 1785, 660, 112, '#2B2B2B', 'Cek keranjang kuning', '#FFFFFF', 42),
      ],
    }),
  },
  {
    id: 'storynew', name: 'Story Koleksi Baru', for: ['story'],
    make: (p, A = A1080x1920) => ({
      bg: { color: '#EDE6DD' },
      els: [
        textEl(p, { content: 'New Arrival', font: 'Instrument Serif', weight: 400, italic: true, size: 150, color: '#2B2B2B' }, A(540, 230)),
        textEl(p, { content: 'OLIVE BAG SERIES', font: 'Poppins', weight: 600, size: 36, color: '#7A6A58', letterSpacing: 10 }, A(540, 345)),
        slotEl(p, 'arch', 760, 980, { ...A(540, 910), fill: '#E2D6C8' }),
        swatchEl(p, '#141414', 'Hitam', A(360, 1555)),
        swatchEl(p, '#6B7B3A', 'Olive', A(540, 1555)),
        swatchEl(p, '#E8D8C3', 'Krem', A(720, 1555)),
        ...pillBtn(p, A, 540, 1790, 640, 112, '#7A6A58', 'Belanja sekarang', '#FFFFFF', 42),
      ],
    }),
  },
  {
    id: 'bannerflash', name: 'Banner Flash Sale', for: ['banner'],
    make: (p, A = A1920x640) => {
      const u = unit(p);
      const blocks = ['02', '15', '30'];
      return {
        bg: { color: '#E53935', color2: '#FF7A1A', angle: 0 },
        els: [
          icon(p, 'zap', 150, 320, { color: '#FFD400', fill: '#FFD400' }, 1, A),
          textEl(p, { content: 'FLASH SALE', font: 'Anton', weight: 400, size: 190, color: '#FFFFFF' }, A(600, 205)),
          textEl(p, { content: 'Diskon s/d 70% · hari ini saja', font: 'Poppins', weight: 600, size: 50, color: '#FFE3D6' }, A(600, 330)),
          ...blocks.flatMap((b, i) => {
            const x = 410 + i * 190;
            return [
              shapeEl(p, 'rect', A(x, 480), { w: 150 * u, h: 130 * u, fill: '#1B2430', radius: 22 * u }),
              textEl(p, { content: b, font: 'Poppins', weight: 800, size: 80, color: '#FFD400' }, A(x, 480)),
              ...(i < 2 ? [textEl(p, { content: ':', font: 'Poppins', weight: 800, size: 70, color: '#FFFFFF' }, A(x + 95, 474))] : []),
            ];
          }),
          slotEl(p, 'rect', 420, 420, { ...A(1310, 300), radius: 40, fill: '#FFE3D6' }, 'Produk 1'),
          slotEl(p, 'rect', 420, 420, { ...A(1640, 300), radius: 40, fill: '#FFE3D6' }, 'Produk 2'),
          badgeEl(p, { text: 'GRATIS ONGKIR', icon: '🚚', bg: '#FFD400', fg: '#111111' }, { ...A(1475, 560), scale: Math.round(u * 0.8 * 100) / 100 }),
        ],
      };
    },
  },
  {
    id: 'bannerkoleksi', name: 'Banner Koleksi', for: ['lebar'],
    make: (p, A = A1920x1080) => ({
      bg: { color: '#F6EFE7' },
      els: [
        icon(p, 'sparkles', 860, 210, { color: '#C9A27C' }, 0.4, A),
        textEl(p, { content: 'Koleksi\nMusim Ini', font: 'Instrument Serif', weight: 400, italic: true, size: 150, color: '#2B2B2B', lineHeight: 1.05, align: 'left', width: 700 }, A(470, 360)),
        textEl(p, { content: 'Tas kulit sintetis premium · ringan · anti air', font: 'Poppins', weight: 500, size: 38, color: '#7A6A58', width: 700, align: 'left' }, A(470, 600)),
        ...pillBtn(p, A, 345, 760, 420, 110, '#2B2B2B', 'Lihat koleksi', '#FFFFFF', 42),
        slotEl(p, 'arch', 420, 660, { ...A(1160, 560), fill: '#E8DCCD' }),
        slotEl(p, 'arch', 420, 660, { ...A(1620, 560), fill: '#E8DCCD' }),
      ],
    }),
  },
];
TEMPLATES.push(...MORE);

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
