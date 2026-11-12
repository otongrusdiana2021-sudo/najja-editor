// Najja Editor — preset data (pure data, no DOM). Shared by the browser app and the MCP server.

export const ASPECTS = {
  '16:9': { w: 1920, h: 1080, hint: 'YouTube' },
  '9:16': { w: 1080, h: 1920, hint: 'TikTok / Reels' },
  '1:1': { w: 1080, h: 1080, hint: 'Instagram' },
  '4:5': { w: 1080, h: 1350, hint: 'Feed IG' },
  '4:3': { w: 1440, h: 1080, hint: 'Klasik' },
  '3:4': { w: 1080, h: 1440, hint: 'Potret' },
  '21:9': { w: 2520, h: 1080, hint: 'Sinematik' },
  '2:1': { w: 2160, h: 1080, hint: 'Lebar' },
};

export const RESOLUTIONS = { '480p': 480, '720p': 720, '1080p': 1080, '2k': 1440, '4k': 2160 };
export const FPS_OPTIONS = [24, 25, 30, 50, 60];

export const FONTS = [
  { name: 'Poppins', weights: [300, 400, 500, 600, 700, 800, 900], italic: true, cat: 'Dasar' },
  { name: 'Inter', weights: [400, 500, 600, 700, 800, 900], cat: 'Dasar' },
  { name: 'Roboto', weights: [400, 500, 700, 900], italic: true, cat: 'Dasar' },
  { name: 'Montserrat', weights: [400, 700, 900], italic: true, cat: 'Dasar' },
  { name: 'Bebas Neue', weights: [400], cat: 'Tebal' },
  { name: 'Anton', weights: [400], cat: 'Tebal' },
  { name: 'Oswald', weights: [400, 700], cat: 'Tebal' },
  { name: 'Archivo Black', weights: [400], cat: 'Tebal' },
  { name: 'Righteous', weights: [400], cat: 'Tebal' },
  { name: 'Space Grotesk', weights: [400, 700], cat: 'Tebal' },
  { name: 'Playfair Display', weights: [400, 700], italic: true, cat: 'Serif' },
  { name: 'Instrument Serif', weights: [400], italic: true, cat: 'Serif' },
  { name: 'DM Serif Display', weights: [400], italic: true, cat: 'Serif' },
  { name: 'Pacifico', weights: [400], cat: 'Tulisan tangan' },
  { name: 'Lobster', weights: [400], cat: 'Tulisan tangan' },
  { name: 'Caveat', weights: [400, 700], cat: 'Tulisan tangan' },
  { name: 'Dancing Script', weights: [700], cat: 'Tulisan tangan' },
  { name: 'Permanent Marker', weights: [400], cat: 'Tulisan tangan' },
  { name: 'Satisfy', weights: [400], cat: 'Tulisan tangan' },
];

export const FILTERS = [
  { id: 'none', name: 'Asli', css: [], cat: 'Dasar' },
  { id: 'clear', name: 'Jernih', css: [['contrast', 1.08], ['saturate', 1.15], ['brightness', 1.04]], cat: 'Dasar' },
  { id: 'vivid', name: 'Vivid', css: [['saturate', 1.55], ['contrast', 1.12]], cat: 'Dasar' },
  { id: 'warm', name: 'Hangat', css: [['saturate', 1.15], ['sepia', 0.12]], overlay: { color: '#ff8a3d', mode: 'soft-light', alpha: 0.32 }, cat: 'Dasar' },
  { id: 'cool', name: 'Sejuk', css: [['saturate', 1.05], ['hue-rotate', -6]], overlay: { color: '#3d7dff', mode: 'soft-light', alpha: 0.32 }, cat: 'Dasar' },
  { id: 'bw', name: 'Hitam Putih', css: [['grayscale', 1], ['contrast', 1.15]], cat: 'Klasik' },
  { id: 'noir', name: 'Noir', css: [['grayscale', 1], ['contrast', 1.55], ['brightness', 0.9]], cat: 'Klasik' },
  { id: 'vintage', name: 'Vintage', css: [['sepia', 0.45], ['contrast', 0.95], ['saturate', 0.85], ['brightness', 1.05]], overlay: { color: '#f3c98b', mode: 'multiply', alpha: 0.18 }, cat: 'Klasik' },
  { id: 'retro', name: 'Retro', css: [['sepia', 0.28], ['hue-rotate', -12], ['saturate', 1.35], ['contrast', 1.08]], cat: 'Klasik' },
  { id: 'kodak', name: 'Kodak', css: [['contrast', 1.1], ['saturate', 1.25], ['sepia', 0.08]], overlay: { color: '#ffc95c', mode: 'soft-light', alpha: 0.22 }, cat: 'Klasik' },
  { id: 'cinematic', name: 'Sinematik', css: [['contrast', 1.18], ['saturate', 0.92]], overlay: { color: '#0f6d78', mode: 'soft-light', alpha: 0.38 }, cat: 'Film' },
  { id: 'moody', name: 'Moody', css: [['brightness', 0.88], ['contrast', 1.18], ['saturate', 0.72]], overlay: { color: '#1d2c4a', mode: 'soft-light', alpha: 0.42 }, cat: 'Film' },
  { id: 'faded', name: 'Pudar', css: [['contrast', 0.82], ['brightness', 1.1], ['saturate', 0.78]], cat: 'Film' },
  { id: 'drama', name: 'Drama', css: [['contrast', 1.42], ['saturate', 1.2], ['brightness', 0.95]], cat: 'Film' },
  { id: 'sunset', name: 'Senja', css: [['saturate', 1.2]], overlay: { color: '#ff5a36', mode: 'soft-light', alpha: 0.4 }, cat: 'Suasana' },
  { id: 'pink', name: 'Pink', css: [['saturate', 1.1]], overlay: { color: '#ff5fa8', mode: 'soft-light', alpha: 0.34 }, cat: 'Suasana' },
  { id: 'mint', name: 'Mint', css: [['hue-rotate', 8], ['saturate', 1.08]], overlay: { color: '#3dffc2', mode: 'soft-light', alpha: 0.22 }, cat: 'Suasana' },
  { id: 'dream', name: 'Mimpi', css: [['brightness', 1.12], ['contrast', 0.9], ['saturate', 1.2]], overlay: { color: '#c79bff', mode: 'soft-light', alpha: 0.3 }, cat: 'Suasana' },
];

export const ADJUSTMENTS = [
  { id: 'brightness', name: 'Kecerahan', min: -100, max: 100 },
  { id: 'contrast', name: 'Kontras', min: -100, max: 100 },
  { id: 'saturation', name: 'Saturasi', min: -100, max: 100 },
  { id: 'exposure', name: 'Eksposur', min: -100, max: 100 },
  { id: 'temperature', name: 'Suhu', min: -100, max: 100 },
  { id: 'tint', name: 'Rona', min: -100, max: 100 },
  { id: 'hue', name: 'Hue', min: -180, max: 180 },
  { id: 'fade', name: 'Pudar', min: 0, max: 100 },
  { id: 'vignette', name: 'Vinyet', min: 0, max: 100 },
  { id: 'blur', name: 'Kabur', min: 0, max: 100 },
];

export const BLEND_MODES = [
  { id: 'source-over', name: 'Normal' },
  { id: 'screen', name: 'Layar' },
  { id: 'multiply', name: 'Perkalian' },
  { id: 'overlay', name: 'Overlay' },
  { id: 'lighten', name: 'Terangkan' },
  { id: 'darken', name: 'Gelapkan' },
  { id: 'soft-light', name: 'Cahaya lembut' },
  { id: 'hard-light', name: 'Cahaya keras' },
  { id: 'color-dodge', name: 'Color dodge' },
  { id: 'difference', name: 'Selisih' },
];

export const EFFECTS = [
  { id: 'shake', name: 'Getar', cat: 'Dinamis', icon: '〰', colors: ['#ff6b6b', '#ffa94d'] },
  { id: 'zoomPulse', name: 'Denyut Zoom', cat: 'Dinamis', icon: '◎', colors: ['#845ef7', '#5c7cfa'] },
  { id: 'flash', name: 'Kilat', cat: 'Dinamis', icon: '⚡', colors: ['#fcc419', '#ffffff'] },
  { id: 'strobe', name: 'Strobo', cat: 'Dinamis', icon: '◐', colors: ['#212529', '#f8f9fa'] },
  { id: 'rainbow', name: 'Pelangi', cat: 'Dinamis', icon: '🌈', colors: ['#ff6b6b', '#4dabf7'] },
  { id: 'glitch', name: 'Glitch', cat: 'Retro', icon: '▚', colors: ['#f03e3e', '#15aabf'] },
  { id: 'rgbSplit', name: 'Pisah RGB', cat: 'Retro', icon: '◫', colors: ['#e64980', '#22b8cf'] },
  { id: 'vhs', name: 'VHS', cat: 'Retro', icon: '▶', colors: ['#495057', '#be4bdb'] },
  { id: 'grain', name: 'Butiran Film', cat: 'Retro', icon: '░', colors: ['#868e96', '#343a40'] },
  { id: 'bw', name: 'Hitam Putih', cat: 'Dasar', icon: '◑', colors: ['#000000', '#dee2e6'] },
  { id: 'vignette', name: 'Vinyet', cat: 'Dasar', icon: '◉', colors: ['#000000', '#5c5f66'] },
  { id: 'blur', name: 'Kabur', cat: 'Dasar', icon: '◌', colors: ['#74c0fc', '#d0bfff'] },
  { id: 'dreamy', name: 'Mimpi', cat: 'Dasar', icon: '✧', colors: ['#f783ac', '#b197fc'] },
  { id: 'letterbox', name: 'Sinematik', cat: 'Dasar', icon: '▭', colors: ['#0b7285', '#000000'] },
  { id: 'mirror', name: 'Cermin', cat: 'Dasar', icon: '⧉', colors: ['#3bc9db', '#4263eb'] },
  { id: 'snow', name: 'Salju', cat: 'Partikel', icon: '❄', colors: ['#a5d8ff', '#e7f5ff'] },
  { id: 'hearts', name: 'Cinta', cat: 'Partikel', icon: '❤', colors: ['#ff8787', '#f06595'] },
  { id: 'confetti', name: 'Konfeti', cat: 'Partikel', icon: '🎉', colors: ['#ffd43b', '#da77f2'] },
  { id: 'sparkle', name: 'Kilau', cat: 'Partikel', icon: '✦', colors: ['#ffe066', '#fab005'] },
  { id: 'bubbles', name: 'Gelembung', cat: 'Partikel', icon: '◯', colors: ['#66d9e8', '#3bc9db'] },
];

export const TRANSITIONS = [
  { id: 'none', name: 'Tidak ada', icon: '⊘' },
  { id: 'fade', name: 'Larut', icon: '◐' },
  { id: 'black', name: 'Hitam', icon: '●' },
  { id: 'white', name: 'Kilat Putih', icon: '○' },
  { id: 'slideLeft', name: 'Geser Kiri', icon: '⇠' },
  { id: 'slideRight', name: 'Geser Kanan', icon: '⇢' },
  { id: 'slideUp', name: 'Geser Atas', icon: '⇡' },
  { id: 'slideDown', name: 'Geser Bawah', icon: '⇣' },
  { id: 'zoomIn', name: 'Perbesar', icon: '⊕' },
  { id: 'zoomOut', name: 'Perkecil', icon: '⊖' },
  { id: 'wipeLeft', name: 'Sapu Kiri', icon: '◧' },
  { id: 'wipeRight', name: 'Sapu Kanan', icon: '◨' },
  { id: 'wipeUp', name: 'Sapu Atas', icon: '⬒' },
  { id: 'wipeDown', name: 'Sapu Bawah', icon: '⬓' },
  { id: 'circle', name: 'Lingkaran', icon: '◯' },
  { id: 'blur', name: 'Kabur', icon: '◌' },
  { id: 'spin', name: 'Putar', icon: '↻' },
  { id: 'glitch', name: 'Glitch', icon: '▚' },
];

export const ANIM_IN = [
  { id: 'none', name: 'Tidak ada' },
  { id: 'fade', name: 'Muncul' },
  { id: 'zoomIn', name: 'Perbesar' },
  { id: 'zoomOut', name: 'Perkecil' },
  { id: 'slideLeft', name: 'Geser Kiri' },
  { id: 'slideRight', name: 'Geser Kanan' },
  { id: 'slideUp', name: 'Geser Atas' },
  { id: 'slideDown', name: 'Geser Bawah' },
  { id: 'spin', name: 'Putar' },
  { id: 'pop', name: 'Pop' },
  { id: 'bounce', name: 'Pantul' },
  { id: 'blur', name: 'Kabur' },
  { id: 'rise', name: 'Naik' },
  { id: 'typewriter', name: 'Mesin Ketik' },
];

export const ANIM_OUT = [
  { id: 'none', name: 'Tidak ada' },
  { id: 'fade', name: 'Menghilang' },
  { id: 'zoomOut', name: 'Mengecil' },
  { id: 'zoomIn', name: 'Membesar' },
  { id: 'slideLeft', name: 'Geser Kiri' },
  { id: 'slideRight', name: 'Geser Kanan' },
  { id: 'slideUp', name: 'Geser Atas' },
  { id: 'slideDown', name: 'Geser Bawah' },
  { id: 'spin', name: 'Putar' },
  { id: 'pop', name: 'Pop' },
  { id: 'blur', name: 'Kabur' },
  { id: 'sink', name: 'Turun' },
  { id: 'typewriter', name: 'Hapus Ketik' },
];

export const ANIM_LOOP = [
  { id: 'none', name: 'Tidak ada' },
  { id: 'pulse', name: 'Denyut' },
  { id: 'float', name: 'Melayang' },
  { id: 'swing', name: 'Ayun' },
  { id: 'shake', name: 'Getar' },
  { id: 'flicker', name: 'Kedip' },
  { id: 'heartbeat', name: 'Detak' },
  { id: 'spin', name: 'Rotasi' },
  { id: 'wobble', name: 'Goyang' },
];

export const DEFAULT_TEXT = {
  content: 'Teks',
  font: 'Poppins',
  size: 96,
  weight: 700,
  italic: false,
  color: '#ffffff',
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.2,
  stroke: { enabled: false, color: '#000000', width: 6 },
  bg: { enabled: false, color: '#000000', opacity: 0.75, radius: 14, padding: 1 },
  shadow: { enabled: false, color: '#000000', opacity: 0.6, blur: 14, x: 0, y: 5 },
  gradient: { enabled: false, from: '#ff5fa8', to: '#ffb84d' },
  preset: 'default',
};

export const TEXT_PRESETS = [
  { id: 'default', name: 'Dasar', style: {} },
  { id: 'outline', name: 'Garis Tepi', style: { stroke: { enabled: true, color: '#000000', width: 8 } } },
  { id: 'yellow', name: 'Kuning Tebal', style: { font: 'Montserrat', weight: 900, color: '#ffe600', stroke: { enabled: true, color: '#000000', width: 10 } } },
  { id: 'boxBlack', name: 'Kotak Hitam', style: { bg: { enabled: true, color: '#000000', opacity: 0.85, radius: 12, padding: 1 } } },
  { id: 'boxWhite', name: 'Kotak Putih', style: { color: '#111111', bg: { enabled: true, color: '#ffffff', opacity: 1, radius: 12, padding: 1 } } },
  { id: 'subtitle', name: 'Subtitle', style: { size: 64, weight: 600, bg: { enabled: true, color: '#000000', opacity: 0.55, radius: 10, padding: 0.8 } } },
  { id: 'neon', name: 'Neon', style: { color: '#3df5ff', shadow: { enabled: true, color: '#3df5ff', opacity: 1, blur: 30, x: 0, y: 0 } } },
  { id: 'gradient', name: 'Gradasi', style: { font: 'Montserrat', weight: 900, gradient: { enabled: true, from: '#ff5fa8', to: '#ffb84d' } } },
  { id: 'shadow', name: 'Bayangan', style: { shadow: { enabled: true, color: '#000000', opacity: 0.75, blur: 18, x: 0, y: 8 } } },
  { id: 'redBold', name: 'Merah Tegas', style: { font: 'Anton', weight: 400, color: '#ff2d55', letterSpacing: 2, stroke: { enabled: true, color: '#ffffff', width: 6 } } },
  { id: 'elegant', name: 'Elegan', style: { font: 'Playfair Display', weight: 700, italic: true } },
  { id: 'marker', name: 'Spidol', style: { font: 'Permanent Marker', weight: 400, color: '#ffd84d', stroke: { enabled: true, color: '#111111', width: 6 } } },
  { id: 'retro', name: 'Retro', style: { font: 'Pacifico', weight: 400, color: '#ff7ac6', shadow: { enabled: true, color: '#3b1f6b', opacity: 1, blur: 0, x: 6, y: 6 } } },
  { id: 'minimal', name: 'Minimalis', style: { font: 'Montserrat', weight: 400, size: 72, letterSpacing: 14 } },
  { id: 'bebas', name: 'Poster', style: { font: 'Bebas Neue', weight: 400, size: 150, letterSpacing: 4 } },
  { id: 'handwritten', name: 'Tulisan Tangan', style: { font: 'Caveat', weight: 700, size: 110 } },
  { id: 'lobster', name: 'Manis', style: { font: 'Lobster', weight: 400, color: '#fff2a8', stroke: { enabled: true, color: '#7a2e00', width: 4 } } },
  { id: 'news', name: 'Berita', style: { font: 'Oswald', weight: 700, color: '#ffffff', bg: { enabled: true, color: '#d90429', opacity: 1, radius: 4, padding: 1 } } },
];

export const TEXT_TEMPLATES = [
  { id: 'bigTitle', name: 'Judul Besar', text: 'JUDUL VIDEO', preset: 'yellow', size: 150, animIn: 'pop', animOut: 'zoomOut' },
  { id: 'subscribe', name: 'Ajak Subscribe', text: 'JANGAN LUPA SUBSCRIBE!', preset: 'redBold', size: 90, animIn: 'slideUp', animLoop: 'pulse', y: 0.3 },
  { id: 'lowerThird', name: 'Lower Third', text: 'Nama Kamu\nJabatan / Info', preset: 'news', size: 52, align: 'left', x: -0.26, y: 0.3, animIn: 'slideRight', animOut: 'slideLeft' },
  { id: 'promo', name: 'Promo', text: 'DISKON 50%', preset: 'gradient', size: 170, animIn: 'bounce', animLoop: 'heartbeat' },
  { id: 'quote', name: 'Kutipan', text: '"Mulai saja dulu."', preset: 'elegant', size: 96, animIn: 'typewriter', animOut: 'fade' },
  { id: 'neonNight', name: 'Neon Malam', text: 'MALAM INI', preset: 'neon', size: 130, animIn: 'fade', animLoop: 'flicker' },
  { id: 'vlog', name: 'Vlog', text: 'Day 1 ✨', preset: 'handwritten', size: 130, animIn: 'rise', animLoop: 'float' },
  { id: 'breaking', name: 'Breaking News', text: 'BREAKING NEWS', preset: 'news', size: 80, animIn: 'slideLeft', animOut: 'slideRight', y: 0.34 },
  { id: 'chapter', name: 'Bab Sinematik', text: 'C H A P T E R   I', preset: 'minimal', size: 64, animIn: 'fade', animOut: 'fade' },
  { id: 'summer', name: 'Summer Vibes', text: 'Summer Vibes', preset: 'retro', size: 140, animIn: 'pop', animLoop: 'swing' },
  { id: 'poster', name: 'Poster', text: 'COMING SOON', preset: 'bebas', size: 180, animIn: 'zoomOut', animOut: 'fade' },
  { id: 'caption', name: 'Caption', text: 'Tulis caption di sini', preset: 'subtitle', y: 0.36, animIn: 'fade', animOut: 'fade' },
];

export const STICKERS = [
  '😀', '😂', '🤣', '😍', '🥰', '😎', '🤩', '🥳', '😭', '😱', '🤯', '🤔', '😴', '😡', '🙄', '😇',
  '🔥', '✨', '💯', '❤️', '💖', '💔', '👍', '👏', '🙌', '🙏', '👀', '💪', '🤝', '✌️', '👉', '👆',
  '🎉', '🎊', '🎂', '🎁', '🏆', '⭐', '🌟', '💥', '💫', '⚡', '🌈', '☀️', '🌙', '❄️', '🌸', '🍀',
  '🎵', '🎶', '🎬', '🎥', '📸', '📍', '💡', '💬', '🗯️', '✅', '❌', '⚠️', '➡️', '⬅️', '⬆️', '⬇️',
  '🍕', '🍔', '☕', '🍜', '🛍️', '💸', '💰', '🏠', '✈️', '🚗', '📱', '💻', '🎮', '⚽', '🐱', '🐶',
];

export const BADGES = [
  { id: 'subscribe', text: 'SUBSCRIBE', bg: '#ff0033', fg: '#ffffff', icon: '🔔' },
  { id: 'like', text: 'SUKA', bg: '#1d6bff', fg: '#ffffff', icon: '👍' },
  { id: 'follow', text: 'FOLLOW', bg: '#111111', fg: '#ffffff', icon: '➕' },
  { id: 'new', text: 'BARU', bg: '#2ed47a', fg: '#0b2a18', icon: '✨' },
  { id: 'sale', text: 'SALE', bg: '#ffd400', fg: '#111111', icon: '🏷️' },
  { id: 'live', text: 'LIVE', bg: '#ff2d55', fg: '#ffffff', icon: '●' },
  { id: 'hot', text: 'HOT', bg: '#ff6a00', fg: '#ffffff', icon: '🔥' },
  { id: 'link', text: 'LINK DI BIO', bg: '#ffffff', fg: '#111111', icon: '🔗' },
  { id: 'free', text: 'GRATIS', bg: '#6c5cff', fg: '#ffffff', icon: '🎁' },
];

export const SOLIDS = ['#000000', '#ffffff', '#111827', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899'];

export const GRADIENTS = [
  ['#ff5f6d', '#ffc371', 135], ['#6c5cff', '#20d6c7', 135], ['#0f2027', '#2c5364', 160], ['#f953c6', '#b91d73', 135],
  ['#00c6ff', '#0072ff', 135], ['#fceabb', '#f8b500', 135], ['#11998e', '#38ef7d', 135], ['#141e30', '#243b55', 180],
  ['#ee0979', '#ff6a00', 135], ['#8e2de2', '#4a00e0', 135], ['#f5f7fa', '#c3cfe2', 180], ['#232526', '#414345', 180],
];

export const SFX = [
  { id: 'whoosh', name: 'Whoosh', kind: 'sfx', dur: 0.9 },
  { id: 'pop', name: 'Pop', kind: 'sfx', dur: 0.25 },
  { id: 'ding', name: 'Ding', kind: 'sfx', dur: 1.4 },
  { id: 'click', name: 'Klik', kind: 'sfx', dur: 0.12 },
  { id: 'notif', name: 'Notifikasi', kind: 'sfx', dur: 0.7 },
  { id: 'riser', name: 'Riser', kind: 'sfx', dur: 2.2 },
  { id: 'impact', name: 'Boom', kind: 'sfx', dur: 1.8 },
  { id: 'swipe', name: 'Swipe', kind: 'sfx', dur: 0.35 },
  { id: 'lofi', name: 'Lo-fi Santai', kind: 'music', dur: 22.6 },
  { id: 'upbeat', name: 'Upbeat Ceria', kind: 'music', dur: 16 },
  { id: 'ambient', name: 'Ambient Tenang', kind: 'music', dur: 19.2 },
];
