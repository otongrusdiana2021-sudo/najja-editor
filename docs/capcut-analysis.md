# Analisis CapCut Web Editor (REA) → panduan rekonstruksi Najja Editor

Tanggal: 2026-11-10 · Alat: REA `rea-agents@6.8.0` (CLI, analisis statis) + pembacaan statis file bundle.

## Target & batasan
- Target: halaman publik `https://www.capcut.com/editor` dan 41 bundle JavaScript yang dikirim ke setiap pengunjung
  dari `sf16-web-tos-buz.capcutcdn-us.com` (13 MB). Folder target SHA-256 `0f431bfb3172…5311`.
- Tidak login, tidak menjalankan kode CapCut, tidak menganalisis mesin WASM-nya.
- **Tidak ada kode, aset, ikon, atau merek CapCut yang disalin ke Najja.** Analisis hanya dipakai untuk
  daftar fitur dan struktur. Implementasi Najja ditulis sendiri.

## Evidence REA
| Evidence ID | Isi |
|---|---|
| `ev_e7dbcb83…ff5a` | Analisis penuh 42 file. Berhenti di `framework.js` karena batas 300 dtk per file. Bukti parsial: 7 file, 2117 modul, 11 407 temuan. |
| `ev_839f5e17…b569` | Analisis terfokus pada 18 chunk aplikasi (`src-editor-*`, `widget-*`, `services-*`, `lv-components`, `runtime`, `wasmPreloader`). Cakupan lengkap untuk file yang dipilih: 2695 modul, 14 770 temuan, 0 gagal parse. 24 file lain sengaja di luar cakupan. |

## Temuan
Jenis bukti: **O** = teramati (literal statis di artefak), **I** = inferensi, **U** = belum diketahui.

1. **Tata letak UI (O → I).** Peta chunk webpack di `runtime.368be391dc.js` memberi nama chunk per area UI:
   - `sider-menu/*` (panel kiri): media, video, photo, audio, text, text-edit, caption, sticker, element, effect,
     transition, filter, template, brand-kit, shortcut
   - `toolbar/*` (panel properti kanan): video-basic/secondary, picture-adjust-basic, audio-basic/secondary,
     text-basic/secondary/template/tracking, sticker-basic/motion/tracking, effect-basic, filter-basic,
     transition-basic, digital-human
   - `titlebar/*`: export, export-list, template, checklist, feedback, collaborator, toolbar-view-mode
   - `timeline/*`: basic-actions, core-action, play, selection, audio-recorder, transcribe, ai-beat,
     partial-export, cover-entrance, template-action

   (I) Artinya editor terdiri dari 4 area: menu samping kiri, panel properti kanan, bar judul, dan timeline.
   Ini sama dengan tata letak Najja.
2. **Operasi edit (O, string literal).** `SPLIT_SEGMENT`, `smartSplit`, `freezeVideo`, `VIDEO_REVERSE`,
   `MIRROR_SEGMENT`, `VIDEO_CROP`/`SmartCrop`, `ADD_KEYFRAME`/`COPY_KEYFRAMES`/`PASTE_KEYFRAMES`, `AUDIO_KEYFRAME`,
   parameter chroma key (`KFTypeChromaIntensity`, `…Shadow`, `…Spill`, `…EdgeSmooth`), mask warna,
   `VideoStabilization`, `textToSpeech`, `RemoveBackground`, `ADD_AUDIO_BEAT` (mode beat/melody),
   `MetaTypeCanvasBlur`. (U) Cara kerja masing-masing saat dijalankan tidak diamati.
3. **Rasio kanvas (O).** Literal `16:9, 9:16, 1:1, 4:3, 3:4, 4:5, 21:9, 2:1`.
4. **Ekspor (O).** Literal resolusi `480p, 720p, 1080p, 2k, 4k` dan field `fps`. (U) Format dan bitrate tidak dicek.
5. **Mesin render (O = string ada, I = arsitektur).** 9 modul `static/wasm/*.module.wasm`, `"webgl2"`,
   `OffscreenCanvas` (15 file), `SharedArrayBuffer` (18 file), `new Worker` (4 file), `VideoDecoder` (1 file).
   (I) Kemungkinan mesin video WASM + WebGL di worker. Ini tidak dibuktikan berjalan.
6. **Penyimpanan draf (I, kandidat keyakinan rendah).** Endpoint `/lv/v1/editor/video_draft/save`,
   `/lv/v1/editor/video_draft/delta_update`, `third_party_clouds/get_plugins`, `ever_photo/sync_asset`.
   (I) Draf disimpan ke cloud dengan update inkremental. Penyimpanan lokal memakai localStorage,
   sessionStorage dan IndexedDB.
7. **Font UI (O).** CSS halaman memakai `'CapCut Sans Text'` (font milik CapCut) dengan fallback Inter/Albert Sans.
   Najja memakai **Poppins** sesuai permintaan.

## Belum terjawab
- Label UI yang sebenarnya: teks i18n dimuat saat runtime dari `starling-normal-sg.capcutapi.com` dan tidak dianalisis.
- Perilaku saat runtime dan tampilan visual editor: perlu login dan rekaman browser, tidak dilakukan.
- Isi pintasan keyboard: chunk `sider-menu/shortcut` ada, tetapi isinya tidak dibaca.
- Internal mesin WASM: di luar cakupan, dan WABT tidak terpasang.

## Keputusan desain Najja berdasarkan temuan
| Temuan CapCut | Najja |
|---|---|
| 4 area UI (sider-menu / toolbar / titlebar / timeline) | Struktur sama: tab kiri, inspector kanan, bar atas, timeline |
| Tab caption terpisah | Tab **Teks Otomatis** (impor SRT / naskah → subtitle; MCP `add_subtitles`) |
| split, freeze, mirror, crop, canvas blur, 8 rasio | Sudah diimplementasikan |
| keyframe | Keyframe posisi/skala/rotasi/opasitas per klip |
| chroma key | Chroma key (hapus latar hijau) di canvas |
| audio-recorder | Rekam voiceover dari mikrofon |
| partial-export | Ekspor rentang (klip terpilih) |
| 480p–4k + fps | Sama |
| Mesin WASM/WebGL | **Berbeda sengaja**: Canvas 2D + MediaRecorder (tanpa dependensi, ringan) |
| Draf di cloud | Autosave lokal (IndexedDB) |
| — | **Tambahan Najja:** server MCP agar AI agent bisa mengedit |
| reverse, stabilisasi, TTS, hapus latar AI | Belum (butuh mesin decode/ML) |
