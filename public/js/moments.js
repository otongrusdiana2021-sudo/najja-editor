// Style Konsep "moments" (v1.12.6): what the talent says becomes a graphic at that moment, like an editor would do it.
//   color    "ada warna hitam, cream, sama pink"   → a coloured circle pops in for each colour as it is said
//   timer    "promonya tinggal 2 hari"              → ⏰ shaking + "TINGGAL 2 HARI", a ticking timer sound
//   stock    "stoknya tinggal 5 pcs"                → 🔥 + "SISA 5 PCS"
//   uses     "bisa buat baju basah, minuman"        → "BISA BUAT:" and a chip per thing, with its emoji
//   claim    "anti bocor", "best seller", "gratis ongkir", "diskon 50 persen" → a badge
//   reaction "oops", "wow", "waduh"                 → a big word with a cartoon sound (Story Pop)
// Pure: words in, moments out ({ type, s, e, … }, speech times). The styles turn them into clips.

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}%]+/gu, '');

// ---------------------------------------------------------------------------------------------
// Colours. strict: also an everyday word (cream, gold, coklat…) — a colour only when the sentence talks about colours
// (warna, varian, pilihan…) or names another colour.
export const COLORS = [
  { k: ['hitam', 'black'], hex: '#141414', label: 'Hitam' },
  { k: ['putih', 'white'], hex: '#FFFFFF', label: 'Putih' },
  { k: ['broken white', 'off white', 'offwhite', 'brokenwhite'], hex: '#F4EFE6', label: 'Broken White' },
  { k: ['abu tua', 'charcoal'], hex: '#4A4A4A', label: 'Abu Tua' },
  { k: ['abu muda'], hex: '#C7C7C7', label: 'Abu Muda' },
  { k: ['abu', 'abuabu', 'grey', 'gray'], hex: '#9E9E9E', label: 'Abu' },
  { k: ['silver', 'perak'], hex: '#C9CCD1', label: 'Silver', strict: true },
  { k: ['merah muda', 'baby pink', 'babypink'], hex: '#F8C8DC', label: 'Baby Pink' },
  { k: ['dusty pink', 'dustypink'], hex: '#D8A7B1', label: 'Dusty Pink' },
  { k: ['maroon', 'marun'], hex: '#7B1E2B', label: 'Maroon' },
  { k: ['merah', 'red'], hex: '#E53935', label: 'Merah' },
  { k: ['pink', 'pinky'], hex: '#F48FB1', label: 'Pink' },
  { k: ['fuchsia', 'fuschia', 'fuksia', 'magenta'], hex: '#D81B60', label: 'Fuchsia' },
  { k: ['salem', 'salmon'], hex: '#F4A28C', label: 'Salem' },
  { k: ['peach'], hex: '#FFCBA4', label: 'Peach', strict: true },
  { k: ['oren', 'orange', 'oranye', 'jingga'], hex: '#FB8C00', label: 'Oranye' },
  { k: ['kuning', 'yellow'], hex: '#FDD835', label: 'Kuning' },
  { k: ['mustard'], hex: '#D4A017', label: 'Mustard' },
  { k: ['gold', 'emas'], hex: '#D4AF37', label: 'Gold', strict: true },
  { k: ['cream', 'krem', 'creme'], hex: '#F3E5C8', label: 'Cream', strict: true },
  { k: ['beige', 'beje', 'bej'], hex: '#E8D9C0', label: 'Beige' },
  { k: ['nude'], hex: '#E3BC9A', label: 'Nude', strict: true },
  { k: ['mocca', 'moka', 'mocha', 'mokka'], hex: '#9C7A5B', label: 'Mocca', strict: true },
  { k: ['coklat', 'cokelat', 'brown'], hex: '#6D4C41', label: 'Coklat', strict: true },
  { k: ['khaki'], hex: '#C3B091', label: 'Khaki' },
  { k: ['camel'], hex: '#C19A6B', label: 'Camel', strict: true },
  { k: ['hijau army', 'army'], hex: '#4B5320', label: 'Army' },
  { k: ['olive', 'zaitun'], hex: '#708238', label: 'Olive', strict: true },
  { k: ['hijau botol'], hex: '#0B5D3B', label: 'Hijau Botol' },
  { k: ['hijau', 'green'], hex: '#43A047', label: 'Hijau' },
  { k: ['sage'], hex: '#B2BFA4', label: 'Sage' },
  { k: ['mint'], hex: '#98E2C6', label: 'Mint', strict: true },
  { k: ['tosca', 'toska', 'tosqa'], hex: '#1ABC9C', label: 'Tosca' },
  { k: ['teal'], hex: '#00897B', label: 'Teal' },
  { k: ['biru muda', 'baby blue', 'babyblue', 'light blue'], hex: '#9CC9F5', label: 'Biru Muda' },
  { k: ['navy', 'dongker', 'donker', 'biru dongker', 'biru donker', 'biru tua'], hex: '#1F2A44', label: 'Navy' },
  { k: ['biru', 'blue'], hex: '#1E63D6', label: 'Biru' },
  { k: ['denim'], hex: '#4F6D9A', label: 'Denim', strict: true },
  { k: ['ungu', 'purple'], hex: '#8E44AD', label: 'Ungu' },
  { k: ['lilac', 'lilak'], hex: '#C8A2C8', label: 'Lilac' },
  { k: ['lavender', 'lavendel'], hex: '#B57EDC', label: 'Lavender' },
];
const COLOR_TALK = new Set(['warna', 'warnanya', 'warnaa', 'color', 'colour', 'colors', 'varian', 'variannya', 'variant', 'pilihan', 'pilihannya', 'tersedia', 'motif', 'corak']);
const colorKeys = new Map();
for (const c of COLORS) for (const k of c.k) colorKeys.set(k, c);
/** A colour name (or a hex) → { hex, label }, or null. */
export function colorOf(name) {
  const s = String(name || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return { hex: s.toUpperCase(), label: s.toUpperCase() };
  const c = colorKeys.get(s.toLowerCase().replace(/\s+/g, ' ')) || colorKeys.get(norm(s));
  return c ? { hex: c.hex, label: c.label } : null;
}

// ---------------------------------------------------------------------------------------------
// Numbers, time, stock
const NUMS = { satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10, sebelas: 11, seratus: 100 };
const TIME_UNITS = { hari: 'HARI', jam: 'JAM', menit: 'MENIT', minggu: 'MINGGU', bulan: 'BULAN', detik: 'DETIK' };
const SE_TIME = { sehari: ['1', 'HARI'], sejam: ['1', 'JAM'], seminggu: ['1', 'MINGGU'], sebulan: ['1', 'BULAN'] };
const STOCK_UNITS = { pcs: 'PCS', pc: 'PCS', biji: 'PCS', buah: 'PCS', unit: 'UNIT', item: 'ITEM', potong: 'PCS', lembar: 'LEMBAR', set: 'SET' };
/** The number at token i: { n, len } (digits, "dua", "dua belas", "2-3"), or null. */
function numberAt(t, i) {
  const w = t[i];
  if (!w) return null;
  if (/^\d+$/.test(w)) return { n: w, len: 1 };
  if (w in NUMS) {
    if (t[i + 1] === 'belas') return { n: String(NUMS[w] + 10), len: 2 };
    if (t[i + 1] === 'puluh') return { n: String(NUMS[w] * 10), len: 2 };
    return { n: String(NUMS[w]), len: 1 };
  }
  return null;
}
const PROMO_TALK = new Set(['promo', 'promonya', 'diskon', 'diskonnya', 'sale', 'flash', 'harga', 'harganya', 'stok', 'stoknya', 'checkout', 'beli', 'order', 'buruan', 'gratis', 'cashback', 'voucher', 'potongan']);

// ---------------------------------------------------------------------------------------------
// Things it is used for
const ITEMS = {
  baju: '👕', kaos: '👕', kemeja: '👔', outfit: '👗', pakaian: '👕', dress: '👗', gamis: '👗', celana: '👖', jeans: '👖', rok: '👗',
  sepatu: '👟', sneakers: '👟', sandal: '🩴', sendal: '🩴', hijab: '🧕', jilbab: '🧕', kerudung: '🧕', mukena: '🧕', sajadah: '🕌', jaket: '🧥',
  topi: '🧢', kacamata: '🕶️', minuman: '🥤', minum: '🥤', tumbler: '🥤', botol: '🥤', makanan: '🍱', bekal: '🍱', makan: '🍱', snack: '🍪',
  cemilan: '🍪', camilan: '🍪', laptop: '💻', tablet: '📱', ipad: '📱', hp: '📱', handphone: '📱', charger: '🔌', powerbank: '🔋', kabel: '🔌',
  kosmetik: '💄', makeup: '💄', skincare: '🧴', parfum: '🧴', sabun: '🧼', buku: '📚', dokumen: '📄', berkas: '📄', payung: '☂️', dompet: '👛',
  kunci: '🔑', popok: '🍼', susu: '🍼', mainan: '🧸', obat: '💊', uang: '💵', kartu: '💳', handuk: '🧺', alat: '🧰', perlengkapan: '🧳',
};
const QUALIFY = new Set(['basah', 'kotor', 'bersih', 'kering', 'ganti', 'kerja', 'sekolah', 'bayi', 'anak', 'kantor', 'mandi', 'olahraga', 'gym', 'renang', 'dalam', 'sholat', 'salat', 'kuliah', 'travel']);
const USE_VERBS = new Set(['buat', 'untuk', 'dipake', 'dipakai', 'bawa', 'naruh', 'nyimpen', 'nyimpan', 'simpan', 'menyimpan', 'masukin', 'dimasukin', 'diisi', 'isi', 'nampung', 'menampung']);
const USE_LEAD = new Set(['bisa', 'cocok', 'pas', 'enak', 'muat', 'praktis', 'aman']);

// ---------------------------------------------------------------------------------------------
// Claims and reactions (multi-word phrases are matched on the joined tokens)
const CLAIMS = [
  { re: /^(waterproof|antiair|antibocor|tahanair|gakbocor|gabocor|nggakbocor|enggakbocor|tidakbocor|nggabocor|gaktembus|nggaktembus|tidaktembus)/, text: 'ANTI BOCOR', icon: '💧', bg: '#1E88E5', fg: '#FFFFFF', sound: 'success' },
  { re: /^(bestseller|terlaris|palinglaris|palinglaku|larismanis|bestsellerkita)/, text: 'BEST SELLER', icon: '⭐', bg: '#FFC107', fg: '#111111', sound: 'ding' },
  { re: /^(gratisongkir|freeongkir|ongkirgratis|bebasongkir)/, text: 'GRATIS ONGKIR', icon: '🚚', bg: '#00A86B', fg: '#FFFFFF', sound: 'cash' },
  { re: /^(original|100persenori|100ori|dijaminori|barangori|produkori|dijaminoriginal)/, text: 'ORIGINAL', icon: '✅', bg: '#2E7D32', fg: '#FFFFFF', sound: 'success' },
  { re: /^(garansi|bergaransi)/, text: 'BERGARANSI', icon: '🛡️', bg: '#5E35B1', fg: '#FFFFFF', sound: 'success' },
  { re: /^(cod|bisacod|bayarditempat|bayardirumah)/, text: 'BISA COD', icon: '💵', bg: '#00897B', fg: '#FFFFFF', sound: 'cash' },
  { re: /^(tahanlama|awetbanget|awet)/, text: 'AWET', icon: '💪', bg: '#F4511E', fg: '#FFFFFF', sound: 'success' },
  { re: /^(premium|kualitaspremium|bahanpremium)/, text: 'PREMIUM', icon: '✨', bg: '#111111', fg: '#F8E08E', sound: 'ding' },
];
const REACTIONS = [
  { re: /^(oops+|ups+|upps+|uups+)$/, text: 'OOPS!', sound: 'boing' },
  { re: /^(wow+|woow+|wih+|wiih+|waw+)$/, text: 'WOW!', sound: 'success' },
  { re: /^(waduh+|aduh+|astaga|astagfirullah|astaghfirullah)$/, text: 'WADUH!', sound: 'boing' },
];

const PRIO = { timer: 6, color: 5, stock: 5, uses: 4, claim: 3, reaction: 2 };
const sentencesOf = (words) => {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  for (const w of words) {
    if (cur.length && (w.s - cur.at(-1).e > 0.7 || w.media !== cur.at(-1).media)) flush();
    cur.push(w);
    if (/[.!?…]$/.test(String(w.w).trim())) flush();
  }
  flush();
  return out;
};

/**
 * The moments in what is said. words: [{ w, s, e, media? }] (speech times); product: { name, brand } (its words are
 * not colours: "Olive Bag" is not an olive moment); kinds: which types to look for (default all).
 * Returns [{ type, s, e, … }] in time order, never two at once (the stronger stays).
 */
export function findMoments(words, { product = {}, kinds = ['color', 'timer', 'stock', 'uses', 'claim', 'reaction'] } = {}) {
  const want = new Set(kinds);
  // (the product's own name is not a colour moment: "Olive Bag" is not olive, unless the sentence is about colours)
  const names = [product.name, product.brand].map((x) => String(x || '').split(/\s+/).map(norm).filter(Boolean)).filter((x) => x.length);
  const ownAt = (t, i, talk) => names.some((n) => (n.length > 1 ? n.every((x, k) => t[i + k] === x) : n[0] === t[i] && !talk));
  const found = [];
  const claimed = new Set();
  let reactions = 0;
  let lastReaction = -Infinity;
  for (const sw of sentencesOf(words)) {
    const t = sw.map((w) => norm(w.w));
    const sEnd = sw.at(-1).e;
    const at = (i) => sw[Math.min(i, sw.length - 1)];
    // colours
    if (want.has('color')) {
      const talk = t.some((x) => COLOR_TALK.has(x));
      const hits = [];
      for (let i = 0; i < t.length; i++) {
        if (ownAt(t, i, talk)) continue;
        const two = i + 1 < t.length ? colorKeys.get(`${t[i]} ${t[i + 1]}`) : null;
        const c = two || colorKeys.get(t[i]);
        if (!c) continue;
        hits.push({ c, i, s: sw[i].s, e: sw[two ? i + 1 : i].e });
        if (two) i++;
      }
      const loose = hits.some((h) => !h.c.strict);
      const items = [];
      for (const h of hits) {
        if (h.c.strict && !talk && !(loose && hits.length > 1)) continue;
        if (items.some((x) => x.label === h.c.label)) continue;
        items.push({ s: h.s, label: h.c.label, hex: h.c.hex });
      }
      if (items.length) {
        const s = items[0].s;
        found.push({ type: 'color', s, e: Math.min(s + 4.5, Math.max(s + 1.8, Math.max(sEnd, items.at(-1).s + 0.6) + 0.6)), items: items.slice(0, 5) });
      }
    }
    for (let i = 0; i < t.length; i++) {
      const w = t[i];
      const next = t[i + 1];
      // time: "tinggal 2 hari", "2 hari lagi", "cuma sehari", "hari ini aja", "sampai besok", "flash sale"
      if (want.has('timer')) {
        let text = null;
        let end = i;
        if (['tinggal', 'sisa', 'tersisa', 'cuma', 'hanya', 'kurang'].includes(w)) {
          const num = numberAt(t, i + 1);
          if (num && TIME_UNITS[t[i + 1 + num.len]]) { text = `${w === 'tersisa' ? 'SISA' : w.toUpperCase()} ${num.n} ${TIME_UNITS[t[i + 1 + num.len]]}`; end = i + 1 + num.len; }
          else if (SE_TIME[next]) { text = `${w === 'tersisa' ? 'SISA' : w.toUpperCase()} ${SE_TIME[next][0]} ${SE_TIME[next][1]}`; end = i + 1; }
        }
        if (!text) {
          const num = numberAt(t, i);
          if (num && TIME_UNITS[t[i + num.len]] && t[i + num.len + 1] === 'lagi') { text = `${num.n} ${TIME_UNITS[t[i + num.len]]} LAGI`; end = i + num.len + 1; }
        }
        if (!text && (w === 'hari' || w === 'malam') && next === 'ini' && ['aja', 'saja', 'doang', 'terakhir'].includes(t[i + 2])) { text = `${w.toUpperCase()} INI ${t[i + 2] === 'terakhir' ? 'TERAKHIR' : 'AJA'}`; end = i + 2; }
        if (!text && w === 'hari' && next === 'terakhir') { text = 'HARI TERAKHIR'; end = i + 1; }
        if (!text && ['sampai', 'sampe', 'hingga'].includes(w) && ['besok', 'lusa', 'nanti', 'malam'].includes(next) && t.some((x) => PROMO_TALK.has(x))) { text = `SAMPAI ${next === 'nanti' || next === 'malam' ? 'NANTI MALAM' : next.toUpperCase()}`; end = i + 1; }
        if (!text && w === 'flash' && next === 'sale') { text = 'FLASH SALE'; end = i + 1; }
        if (!text && ['waktu', 'promo', 'penawaran'].includes(w) && next === 'terbatas') { text = 'WAKTU TERBATAS'; end = i + 1; }
        if (text) { found.push({ type: 'timer', s: sw[i].s, e: Math.max(sw[i].s + 2.2, at(end).e + 1), text }); i = end; continue; }
      }
      // stock: "stoknya tinggal 5", "sisa 3 pcs", "stok terbatas", "hampir habis"
      if (want.has('stock')) {
        let text = null;
        let end = i;
        if (/^stok(nya)?$|^stock$/.test(w)) {
          const j = ['tinggal', 'sisa', 'cuma', 'tersisa'].includes(next) ? i + 2 : -1;
          const num = j > 0 ? numberAt(t, j) : null;
          if (num) { text = `STOK TINGGAL ${num.n}`; end = j + num.len - 1; }
          else if (['terbatas', 'menipis', 'tipis', 'limited', 'sedikit'].includes(next)) { text = 'STOK TERBATAS'; end = i + 1; }
        }
        if (!text && ['tinggal', 'sisa', 'tersisa'].includes(w)) {
          const num = numberAt(t, i + 1);
          if (num && STOCK_UNITS[t[i + 1 + num.len]]) { text = `SISA ${num.n} ${STOCK_UNITS[t[i + 1 + num.len]]}`; end = i + 1 + num.len; }
        }
        if (!text && ['hampir', 'mau', 'udah', 'keburu', 'cepet', 'cepat'].includes(w) && next === 'habis' && t.some((x) => PROMO_TALK.has(x) || x === 'stok' || x === 'stoknya')) { text = 'HAMPIR HABIS'; end = i + 1; }
        if (text) { found.push({ type: 'stock', s: sw[i].s, e: Math.max(sw[i].s + 2.2, at(end).e + 1), text }); i = end; continue; }
      }
      // uses: "bisa buat baju basah, minuman", "muat laptop sama charger"
      if (want.has('uses') && (USE_LEAD.has(w) && (USE_VERBS.has(next) || w === 'muat'))) {
        const from = w === 'muat' ? i + 1 : i + 2;
        const items = [];
        for (let j = from; j < t.length && items.length < 4; j++) {
          const em = ITEMS[t[j]];
          if (!em) continue;
          const q = QUALIFY.has(t[j + 1]) ? ` ${t[j + 1]}` : '';
          // (a number before it stays with it: "5–6 outfit", "2 laptop")
          const raw = (k) => String(sw[k]?.w || '').replace(/[^\p{L}\p{N}-]+/gu, '').toLowerCase();
          const num = (k) => (k >= from && /^\d+(-\d+)?$/.test(raw(k)) ? raw(k).replace('-', '–') : k >= from && raw(k) in NUMS ? String(NUMS[raw(k)]) : '');
          let pre = num(j - 1);
          if (pre && ['sampai', 'sampe', 'hingga'].includes(t[j - 2]) && num(j - 3)) pre = `${num(j - 3)}–${pre}`;
          const label = `${pre ? `${pre} ` : ''}${t[j]}${q}`;
          if (!items.some((x) => x.label === label)) items.push({ s: sw[j].s, label, emoji: em });
          if (q) j++;
        }
        if (items.length) {
          found.push({ type: 'uses', s: sw[i].s, e: Math.min(sw[i].s + 5, Math.max(sw[i].s + 2.2, Math.max(sEnd, items.at(-1).s + 0.8) + 0.7)), header: w === 'muat' ? 'MUAT:' : 'BISA BUAT:', items });
          i = from;
          continue;
        }
      }
      // claims: once each in a video; "diskon 50 persen" / "50%"
      if (want.has('claim')) {
        let hit = null;
        const joined = t.slice(i, i + 3).join('');
        for (const c of CLAIMS) if (c.re.test(joined) && !(c.text === 'ORIGINAL' && w === 'ori' && !['barang', 'produk', 'dijamin', '100'].includes(t[i - 1]))) { hit = c; break; }
        if (!hit && ['diskon', 'disc', 'discount', 'potongan', 'off'].includes(w)) {
          const num = numberAt(t, i + 1) || (/^\d+%$/.test(next || '') ? { n: next.replace('%', ''), len: 1 } : null);
          if (num && (/%$/.test(t[i + 1] || '') || ['persen', '%'].includes(t[i + 1 + num.len]))) hit = { text: `DISKON ${num.n}%`, icon: '🏷️', bg: '#FF3B30', fg: '#FFFFFF', sound: 'cash' };
        }
        if (!hit && /^\d+%$/.test(w) && ['off', 'diskon'].includes(next)) hit = { text: `DISKON ${w}`, icon: '🏷️', bg: '#FF3B30', fg: '#FFFFFF', sound: 'cash' };
        if (hit && !claimed.has(hit.text)) {
          claimed.add(hit.text);
          found.push({ type: 'claim', s: sw[i].s, e: sw[i].s + 2.2, text: hit.text, icon: hit.icon, bg: hit.bg, fg: hit.fg, sound: hit.sound });
          i += 1;
          continue;
        }
      }
      // reactions: a few, far apart
      if (want.has('reaction') && reactions < 3 && sw[i].s - lastReaction > 8) {
        const r = REACTIONS.find((x) => x.re.test(w));
        if (r) { found.push({ type: 'reaction', s: sw[i].s, e: sw[i].s + 1.1, text: r.text, sound: r.sound }); reactions++; lastReaction = sw[i].s; }
      }
    }
  }
  // never two at once: the stronger one stays (at the same strength, the first)
  found.sort((a, b) => a.s - b.s || PRIO[b.type] - PRIO[a.type]);
  const out = [];
  for (const m of found) {
    const prev = out.at(-1);
    if (prev && m.s < prev.e + 0.15) {
      // (a weaker one right after waits its turn, when that is soon — "best seller, gratis ongkir", "muat 5–6 outfit,
      // anti air"); a reaction does not wait: it belongs to its moment
      if (m.type !== 'reaction' && PRIO[m.type] <= PRIO[prev.type] && prev.e + 0.1 - m.s < 1.6) {
        const d = m.e - m.s;
        m.s = prev.e + 0.1;
        m.e = m.s + d;
        out.push(m);
        continue;
      }
      if (PRIO[m.type] > PRIO[prev.type]) {
        // (the stronger one takes over; the weaker keeps only its time before)
        if (m.s - prev.s >= 1.2) { prev.e = m.s - 0.15; out.push(m); } else out[out.length - 1] = m;
      }
      continue;
    }
    out.push(m);
  }
  return out.map((m) => ({ ...m, s: Math.round(m.s * 1000) / 1000, e: Math.round(m.e * 1000) / 1000 }));
}

/** An AI's moments (MCP plan.moments) → the same shape: colours by name or hex, chips with emoji. */
export function planMoments(list = []) {
  const out = [];
  for (const m of list) {
    const s = Number(m.start);
    if (!Number.isFinite(s)) continue;
    const d = Number(m.duration) > 0 ? Number(m.duration) : null;
    if (m.type === 'color') {
      const items = (m.colors || []).map((c, i) => {
        const v = typeof c === 'string' ? colorOf(c) || { hex: '#888888', label: c } : { hex: colorOf(c.hex || c.color)?.hex || '#888888', label: c.label || c.name || colorOf(c.hex || c.color)?.label || '' };
        return { s: Number(c.start ?? s + i * 0.35), label: v.label, hex: v.hex };
      }).filter((x) => x.hex);
      if (items.length) out.push({ type: 'color', s, e: s + (d || Math.max(1.8, items.length * 0.6 + 1.2)), items: items.slice(0, 6) });
    } else if (m.type === 'timer' || m.type === 'stock') {
      out.push({ type: m.type, s, e: s + (d || 2.4), text: String(m.text || (m.type === 'timer' ? 'WAKTU TERBATAS' : 'STOK TERBATAS')).toUpperCase().slice(0, 28) });
    } else if (m.type === 'uses') {
      const items = (m.items || []).map((x, i) => (typeof x === 'string' ? { label: x, emoji: ITEMS[norm(x.split(' ')[0])] || '✔️' } : { label: x.text || x.label, emoji: x.emoji || ITEMS[norm(String(x.text || '').split(' ')[0])] || '✔️', start: x.start })).filter((x) => x.label)
        .map((x, i) => ({ s: Number(x.start ?? s + 0.3 + i * 0.45), label: String(x.label).slice(0, 24), emoji: x.emoji }));
      if (items.length) out.push({ type: 'uses', s, e: s + (d || Math.max(2.4, items.length * 0.5 + 1.6)), header: String(m.text || 'BISA BUAT:').toUpperCase().slice(0, 20), items: items.slice(0, 5) });
    } else if (m.type === 'claim') {
      out.push({ type: 'claim', s, e: s + (d || 2.2), text: String(m.text || '').toUpperCase().slice(0, 22), icon: m.emoji || '✅', bg: m.color || '#FF3B30', fg: '#FFFFFF', sound: 'success' });
    } else if (m.type === 'reaction') {
      out.push({ type: 'reaction', s, e: s + (d || 1.1), text: String(m.text || 'WOW!').toUpperCase().slice(0, 12), sound: m.sound || 'boing' });
    } else if (m.type === 'emoji' && m.emoji) {
      out.push({ type: 'emoji', s, e: s + (d || 1.4), emoji: m.emoji, sound: m.sound || 'bubble' });
    }
  }
  return out.filter((m) => m.type !== 'claim' || m.text).sort((a, b) => a.s - b.s);
}
