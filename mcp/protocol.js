// Minimal, dependency-free MCP (Model Context Protocol) JSON-RPC handler.
// Shared by the Streamable HTTP endpoint (server.js) and the stdio entry (mcp-stdio.js).
import { TOOLS } from './tools.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS = `Najja Editor is a CapCut-style, browser-based video editor. These tools drive the editor tab that is open in the user's browser, and every change shows up there live.

Workflow tips:
- Call get_project first to see the canvas size, tracks, clip ids and media ids. Call it again after edits to confirm timing.
- Bring in footage with import_media (an http(s) URL or an absolute local file path). It returns a media_id for add_media_clip.
- The "main" track is magnetic: clips are packed back to back with no gaps. Put titles, stickers and overlays on their own tracks; the add_* tools pick a track for you.
- Times are in seconds. Positions x/y are fractions of the canvas measured from its center (x -0.5..0.5, y -0.5..0.5, positive y is down). Font sizes are canvas pixels on a canvas whose short side is 1080.
- Call list_assets to get the exact ids of filters, effects, transitions, animations, text presets, templates and fonts.
- Check your result with get_frame, which returns an image of the preview at any time.
- export_video renders in real time inside the browser and returns immediately. Poll get_export_status until it is done; the file is saved on the server.

Style Konsep (ready-made edits of a product video):
- list_styles shows the three styles (showcase, editorial, storypop), how well the project's material fits each, and the recommended one.
- For editorial and storypop call get_transcript first, then decide like an editor: the strongest 1-3 words of a sentence as keywords, the moment the price is said, retakes to cut, which shot (media id) goes over which sentence, a hook for Story Pop. Pass these as the plan of apply_style; what you leave out is chosen automatically.
- apply_style makes a new project (a copy) by default, so the user's project stays as it is; the user can ask for all three styles and pick one.
- Every style edit is complete: subtitles from the transcript, kinetic text, a sound effect on every text and transition, and no text over a person (texts move to the free background beside or above the people, automatically). plan.sfx tones the sounds down (graphics, none).
- Afterwards check the edit with get_frame (the title, a keyword, the price, the end).`;


// Prompts: the three styles as ready-made requests (in Claude they show up as /najja-editorial and so on).
const PRODUCT_ARGS = [
  { name: 'produk', description: 'Nama produk, misalnya "Travel Bag Motif Bunga"', required: false },
  { name: 'harga', description: 'Harga normal, misalnya 189rb', required: false },
  { name: 'harga_diskon', description: 'Harga diskon, misalnya 149rb', required: false },
  { name: 'varian', description: 'Varian (pisahkan koma), misalnya Mini, Medium, Jumbo', required: false },
];
export const PROMPTS = [
  { name: 'najja-showcase', title: 'Edit: Showcase Clean', description: 'Pamer varian produk: klip produk + musik, satu bagian per varian, zoom punch, garis ukuran.', style: 'showcase', arguments: [...PRODUCT_ARGS, { name: 'ukuran', description: 'Ukuran per varian, misalnya 28 cm, 35 cm, 45 cm', required: false }] },
  { name: 'najja-editorial', title: 'Edit: Editorial Review', description: 'Review produk gaya majalah: jeda dipotong, kata kunci besar menumpuk, label harga, outro merek.', style: 'editorial', arguments: PRODUCT_ARGS },
  { name: 'najja-storypop', title: 'Edit: Story Pop', description: 'Bercerita: hook kata per kata, B-roll per kalimat, stiker, harga turun yang meletup.', style: 'storypop', arguments: PRODUCT_ARGS },
  { name: 'najja-semua-style', title: 'Edit: ketiga style', description: 'Buat ketiga versi (Showcase Clean, Editorial Review, Story Pop) dari bahan yang sama, untuk dipilih.', style: 'all', arguments: PRODUCT_ARGS },
];
export function promptMessages(name, args = {}) {
  const pr = PROMPTS.find((x) => x.name === name);
  if (!pr) return null;
  const facts = [['produk', 'Produk'], ['varian', 'Varian'], ['ukuran', 'Ukuran'], ['harga', 'Harga normal'], ['harga_diskon', 'Harga diskon']]
    .filter(([k]) => args[k]).map(([k, n]) => `- ${n}: ${args[k]}`).join('\n');
  const which = pr.style === 'all' ? 'ketiga style (showcase, editorial, storypop), masing-masing jadi proyek baru' : `style "${pr.style}"`;
  const text = `Edit video di proyek Najja yang sedang terbuka dengan ${which}.
${facts ? `\nInfo produk:\n${facts}\n` : '\nKalau info produk (nama, varian, harga) belum ada, tanyakan dulu secukupnya.\n'}
Langkah:
1. list_styles: cek kecocokan bahan. Kalau bahan kurang untuk style ini, bilang dan sarankan yang cocok.
2. Untuk editorial/storypop: get_transcript, lalu baca kalimatnya dan tentukan rencana edit: kata kunci terkuat (1-3 kata, tiap 4-8 detik), momen harga disebut, bagian salah/ulang yang dipotong, B-roll (media_id) untuk kalimat yang cocok, dan hook untuk Story Pop.
3. apply_style dengan rencana itu (proyek baru, proyek asli tidak diubah). Hasilnya sudah lengkap: subtitle dari transkrip, teks kinetik, SFX di tiap teks dan transisi, dan teks otomatis digeser ke latar kosong supaya tidak menutupi orangnya (badan dan wajah).
4. Cek hasilnya dengan get_frame di beberapa titik (judul, kata kunci, harga, akhir): pastikan tidak ada teks yang menutupi orangnya, dan rapikan kalau perlu.
5. Ringkas hasilnya dalam bahasa Indonesia: durasi, apa yang dipotong, kata kunci, harga, jumlah SFX, teks yang digeser supaya tidak menutupi orang.`;
  return { description: pr.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

/** Convert the editor's tool payload ({data, text, image, isError}) into an MCP CallToolResult. */
export function formatToolResult(payload) {
  if (payload && Array.isArray(payload.content)) return payload; // already formatted
  const content = [];
  if (payload?.text) content.push({ type: 'text', text: String(payload.text) });
  if (payload?.data !== undefined) {
    content.push({ type: 'text', text: typeof payload.data === 'string' ? payload.data : JSON.stringify(payload.data, null, 2) });
  }
  if (payload?.image?.data) content.push({ type: 'image', data: payload.image.data, mimeType: payload.image.mimeType || 'image/png' });
  if (!content.length) content.push({ type: 'text', text: 'OK' });
  return { content, isError: !!payload?.isError };
}

export function createMcpHandler({ name, version, callTool, onInitialize }) {
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return fail(msg?.id ?? null, -32600, 'Invalid Request');
    }
    // Responses from the client (we never send requests) are ignored.
    if (typeof msg.method !== 'string') return null;
    const isNotification = msg.id === undefined || msg.id === null;
    const params = msg.params || {};

    switch (msg.method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        try { onInitialize?.(params.clientInfo || {}, protocolVersion); } catch { /* ignore */ }
        return ok(msg.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name, title: 'Najja Editor', version },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return isNotification ? null : ok(msg.id, {});
      case 'tools/list':
        return ok(msg.id, { tools: TOOLS });
      case 'tools/call': {
        const toolName = params.name;
        const tool = TOOLS.find((t) => t.name === toolName);
        if (!tool) return fail(msg.id, -32602, `Unknown tool: ${toolName}`);
        try {
          const result = await callTool(toolName, params.arguments || {});
          return ok(msg.id, formatToolResult(result));
        } catch (err) {
          return ok(msg.id, { content: [{ type: 'text', text: `Error: ${err?.message || err}` }], isError: true });
        }
      }
      case 'resources/list':
        return ok(msg.id, { resources: [] });
      case 'resources/templates/list':
        return ok(msg.id, { resourceTemplates: [] });
      case 'prompts/list':
        return ok(msg.id, { prompts: PROMPTS.map(({ name: n, title, description, arguments: a }) => ({ name: n, title, description, arguments: a })) });
      case 'prompts/get': {
        const r = promptMessages(params.name, params.arguments || {});
        if (!r) return fail(msg.id, -32602, `Unknown prompt: ${params.name}`);
        return ok(msg.id, r);
      }
      default:
        if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
        return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };
}
