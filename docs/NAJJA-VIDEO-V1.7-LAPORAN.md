# Najja Video v1.7 — Laporan per fase

Laporan ini mengikuti format output yang diminta *NAJJA VIDEO Performance Blueprint* untuk setiap fase:
masalah (file/baris), keputusan desain dan trade-off, file yang berubah, tes, benchmark sebelum/sesudah,
risiko/fallback/deploy/migrasi/rollback, dan pekerjaan berikutnya. Rencananya ada di
[NAJJA-VIDEO-IMPLEMENTATION-PLAN.md](NAJJA-VIDEO-IMPLEMENTATION-PLAN.md).

## Ringkasan rilis v1.7.0

| Fase | Status | Hasil utama (diukur) |
|---|---|---|
| **P0** Keamanan | ✅ | Data per akun. Akun lain dijawab 404 di semua route, file, dan MCP. Token AI pribadi. Migrasi otomatis dengan cadangan, dan rollback ke v1.6 aman. |
| **P1** Pengukuran | ✅ | Menu Diagnostik, metrik blueprint 9.1, benchmark B0–B5 yang bisa diulang. Langsung menemukan bug frame salah setelah seek (diperbaiki: 6/10 → 10/10 benar dalam 41–77 ms). |
| **P2** Timeline | ✅ | Render plan terkompilasi. Pencarian klip 3,5–47× lebih cepat; `renderFrame` −10% (57 klip) s.d. −37% (2.057 klip). |
| P3 Render worker / WebGL2 | ⏸ | Ditunda: butuh data perangkat nyata (lihat rencana). |
| **P4** Memori ekspor | ✅ (spool Safari menyusul) | Ekspor 120 dtk dari video 10 menit: RAM renderer 2,7 GB → 1,3 GB, JS heap 690 → 174–284 MB. Audio identik, kecepatan sama. |
| **P5** Antrean job | ✅ | Tahan restart/crash, retry, cancel, adil antar-akun. Klip pendek siap 7–11 dtk (sebelumnya 111–112 dtk) saat video panjang sedang dikonversi. |
| **P6** Sinkron | ✅ | Revisi + 409. Perubahan perangkat A terlihat di B dalam 1,0 dtk. Konflik ditanyakan, tidak ditimpa diam-diam. Draf lokal tidak hilang. |
| P7 Cloud render | ⏸ | Butuh keputusan biaya/infrastruktur. |

**Tes:** `npm test` 53/53. `npm run test:e2e` (get_frame, UI iPad, sinkron dua perangkat) lolos.

### Benchmark akhir vs baseline, dan catatan noise

Benchmark akhir ada di `bench/results/2026-11-13-v1.7.0-desktop.*`. Dibanding baseline P1, beberapa angka pratinjau tampak lebih buruk: seek → frame dan frame terlewat di B0/B3. Untuk memastikan, B0 dan B3 dijalankan **bergantian** di kode P1 dan v1.7.0, masing-masing 2× dengan runner yang sama (`bench/results/2026-11-13-ab-*`):

| | P1 run 1 | P1 run 2 | v1.7.0 run 1 | v1.7.0 run 2 |
|---|---|---|---|---|
| B0 seek → frame p50 / p95 (ms) | 38,8 / 169,7 | 39,1 / 41,0 | 24,6 / 56,7 | 37,7 / 52,7 |
| B0 frame terlewat | 6,9% | 0% | 4,4% | 2,4% |
| B3 seek → frame p50 / p95 (ms) | 41,2 / 61,6 | 55,0 / 88,4 | 54,7 / 72,8 | 54,8 / 69,0 |
| B3 frame terlewat | 4,3% | 10,7% | 0% | 3,7% |
| B3 ekspor: RAM renderer puncak | 2.248 MB | 2.723 MB | **1.259 MB** | **1.320 MB** |
| B3 ekspor: JS heap puncak | 686 MB | 698 MB | **251 MB** | **284 MB** |

Kesimpulannya:
- Angka pratinjau (seek, frame terlewat) di mesin lab headless tanpa GPU berayun ±30–300% antar-run **pada kode yang sama**. Baseline P1 kebetulan run yang baik.
- Tidak ada regresi pratinjau. Penghematan memori ekspor konsisten di semua run.
- Angka pratinjau yang bisa dipercaya untuk keputusan berikutnya (terutama P3) harus diambil dari **Diagnostik di PC, iPad, dan HP nyata**, dengan beberapa run per perangkat (blueprint 9.3).

### Deploy dan rollback

- **Deploy:** jalankan installer seperti biasa. Saat start, v1.7 otomatis:
  1. memberi ID ke akun lama dan menetapkan pemilik data lama ke admin pertama (dicadangkan dulu ke `data/backups/`);
  2. membuat `data/jobs/` (antrean konversi).
- **Yang berubah bagi pengguna:**
  - Akun editor hanya melihat proyeknya sendiri.
  - AI disambungkan dengan **Token AI pribadi** (menu akun). Token server lama tetap berlaku sebagai admin pertama.
- **Saklar `.env` baru:** `NAJJA_JOB_LIGHT/FAST/SLOW`, `NAJJA_EXPORT_SPOOL=0`, `NAJJA_SYNC_POLL_MS`.
- **Rollback:** pasang v1.6.0. Semua kolom baru hanya ditambahkan; detailnya di `docs/DEPLOY.md`.

---

## P0 — Fondasi keamanan: data per akun

### Masalah (kode v1.6.0)

| Lokasi | Masalah |
|---|---|
| `lib/storage.js` `listProjects/getProject/putProject/deleteProject`, `getMeta/mediaFile/deleteMedia`, `putChunk/finishUpload` | Semua data global. Tidak ada konsep pemilik. |
| `server.js` route `/api/projects/*`, `/api/media/*`, `/api/upload/*`, `/exports/*`, `/media-cache/*` | Tidak memeriksa siapa pemiliknya. Akun B bisa membaca, menimpa, atau menghapus proyek/media akun A kalau tahu ID-nya. |
| `server.js` `Bridge.request()` | Perintah MCP dikirim ke editor yang paling aktif dari **akun mana pun**. `/bridge/result` menerima jawaban dari siapa saja. |
| `server.js` `/api/status` | `lastExport`, `exportsDir`, dan daftar klien MCP terlihat oleh semua akun. |
| `server.js` `prepareImport()` | Impor file dari disk server terbuka untuk semua akun. Impor URL bisa diarahkan ke layanan internal VPS (localhost/LAN). |
| `lib/auth.js` | Pengguna tidak punya ID tetap. Hanya ada satu token MCP (token server) untuk semua orang. |

### Keputusan desain

- **Pemilik disimpan sebagai metadata, file tidak dipindah.** Proyek dan `meta.json` media mendapat kolom `ownerId`. Ekspor dicatat di `data/exports-index.json`. Upload yang sedang berjalan diklaim lewat file `owner` di folder upload-nya.
  - *Trade-off:* folder masih satu untuk semua akun, jadi isolasinya ada di lapisan API, bukan di filesystem.
  - *Keuntungan:* tidak ada pemindahan file video (bisa puluhan GB). Migrasi hanya menulis JSON kecil, dan v1.6 tetap bisa membaca data (rollback mudah).
- **Identitas selalu dari server.** `authenticate()` mengembalikan `{ id, email, role, via }` dari sesi, token server, atau token AI pribadi. `ownerId` di body request selalu ditimpa server.
- **Data orang lain dijawab 404**, bukan 403, supaya keberadaannya tidak bocor.
- **Data lama → admin pertama.** Record tanpa pemilik (atau milik mode lokal `local`) dianggap milik admin paling awal. Migrasi menuliskannya secara eksplisit.
- **Token AI pribadi** (`najja_pat_…`):
  - Satu token per pengguna, ditampilkan sekali. Server hanya menyimpan hash SHA-256 dan 4 karakter terakhir.
  - Token server `NAJJA_TOKEN` tetap berlaku dan bertindak sebagai admin pertama, jadi konfigurasi MCP lama tidak putus.
- **Bridge MCP per akun.**
  - Editor terdaftar dengan kunci `pemilik:clientId`. Perintah hanya dikirim ke editor milik pemanggil.
  - Jawaban `/bridge/result` hanya diterima dari akun yang sama.
- **Impor dari disk server hanya untuk admin.** Impor URL oleh akun non-admin hanya ke alamat internet publik:
  - DNS dicek di setiap redirect.
  - Ditolak: loopback, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, IPv6 lokal.
- **Path server disembunyikan dari non-admin:** `exportsDir`, path `mcp-stdio.js`, dan `path` hasil upload ekspor.

### File yang berubah

| File | Perubahan |
|---|---|
| `lib/tenancy.js` (baru) | `ownerOf/owns`, indeks pemilik ekspor, `migrate()` (dry-run → backup → tulis → verifikasi → `migration.json`), `transfer()` saat pengguna dihapus. |
| `lib/auth.js` | ID pengguna `u_…` + `ensureIds()`, `primaryOwner()`, token AI pribadi (`createToken/revokeToken/tokenInfo/userByToken`). |
| `lib/storage.js` | `ownerId` di `putMeta/adoptFile/finishUpload`, klaim pemilik upload, `deleteMedia` hanya menghitung proyek pemilik yang sama. |
| `server.js` | Identitas per request, `initData()` (ID pengguna + migrasi saat start), cek pemilik di semua route data, bridge per akun, `/api/status` per akun, `/api/me/token`, transfer data saat hapus pengguna, `fetchPublic()`. |
| `public/js/account.js`, `public/css/app.css` | Menu **Token AI (MCP)**: buat, salin, ganti, cabut. Teks Kelola pengguna diperbarui. |
| `public/js/library.js` | Panel AI memakai `<TOKEN_AI_KAMU>` + tombol kelola token. |
| `public/js/app.js` | Status "Salinan tersimpan di server" tetap muncul walau path server tidak dikirim. |
| `test/tenancy.test.js` (baru) | 8 tes (lihat bawah). |
| `README.md`, `docs/DEPLOY.md` | Data per akun, token AI, migrasi & rollback. |

### Tes

`npm test` → **29/29 lolos** (21 lama + 8 baru). `npm run test:e2e` → lolos (get_frame + semua cek UI iPad).

Tes baru di `test/tenancy.test.js` dijalankan pada folder data berformat v1.6 (admin tanpa ID, proyek, media, dan ekspor tanpa pemilik):

1. **Migrasi:**
   - Pengguna mendapat ID, dan `users.json` dicadangkan dulu.
   - Proyek, media, dan ekspor lama jadi milik admin. Cadangan berisi file asli yang belum diubah.
   - `migration.json` mencatat `remaining: 0`.
2. **Proyek:**
   - Akun B mendapat 404 untuk get/put/delete dan daftar kosong.
   - `ownerId` palsu di body diabaikan.
3. **Media:**
   - Akun B mendapat 404 di semua route: meta, file, edit, sprite, poster, peaks, proxy, proxy-status, adopt, dan delete.
   - B tidak bisa menyelesaikan upload ke media A. Sebaliknya, A tidak bisa menulis atau menyelesaikan sesi upload B.
4. **Ekspor dan status:**
   - File ekspor A tidak bisa diunduh B, dan sebaliknya.
   - `lastExport` dan `editors` dihitung per akun.
   - `exportsDir` hanya untuk admin.
5. **MCP:**
   - Token pribadi B tidak menjangkau editor A ("not open in a browser for this account").
   - Token server menjangkau editor admin pertama.
   - Jawaban palsu dari B untuk perintah A diabaikan.
   - Token salah atau yang sudah dicabut → 401. Token hanya bisa diatur dari sesi login.
6. **Impor:**
   - Path disk server ditolak untuk non-admin.
   - URL ke 127.0.0.1, localhost, 10.x, [::1], dan 169.254.169.254 ditolak.
7. **Hapus pengguna:** data B pindah ke admin, dengan cadangan.
8. **Unit tenancy:**
   - Dry-run tidak mengubah apa pun, dan migrasi idempoten.
   - Data mode lokal menunggu sampai akun dibuat.

**Uji di data nyata:** salinan folder data v1.6 (1 proyek, 57 klip, 6 media, 3 ekspor, 557 MB) dijalankan dengan server v1.7.
- Migrasi: 1 proyek, 6 media, 3 ekspor diberi pemilik, `remaining: 0`. Cadangan hanya berisi JSON (file video tidak disalin atau disentuh).
- Di browser, admin membuka proyek seperti biasa.
- Akun editor baru hanya melihat proyeknya sendiri (editor terhitung 1 untuk akunnya, bukan 2).
- Modal Token AI rapi di iPad (1180×820) dan HP (390×844), tanpa geser samping. Tidak ada error konsol.

### Benchmark sebelum/sesudah

Server v1.6.0 vs v1.7 pada salinan data yang sama, request berurutan lewat keep-alive (400 sampel × 3 putaran, ms):

| Route | v1.6 p50 | v1.7 p50 | v1.6 p95 | v1.7 p95 |
|---|---|---|---|---|
| `GET /api/projects` | 1,54–1,72 | 1,57–1,82 | 2,01–2,32 | 2,07–2,42 |
| `GET /api/media/:id/meta` | 2,00–2,13 | 2,36–2,49 | 2,48–2,68 | 2,98–3,47 |
| `GET /api/media/:id/edit` (range 64 KB) | 0,54–0,74 | 0,96–1,10 | 1,09–1,28 | 1,55–1,60 |

Overhead cek pemilik ≈ 0,3–0,5 ms per request (satu baca `meta.json` kecil). Ini jauh di bawah latensi jaringan (puluhan ms), jadi pemutaran dan scrubbing tidak terpengaruh. Kalau nanti terlihat di metrik P1, pemilik media bisa di-cache di memori.

### Risiko, fallback, deploy, migrasi, rollback

- **Deploy:** sama seperti biasa (jalankan installer). Migrasi otomatis saat server start, lalu tercatat di log server dan di `data/backups/v1.7-owner-migration-<waktu>/migration.json`.
- **Kalau migrasi gagal** (misalnya disk penuh):
  - Request dijawab error (fail closed: tidak ada data yang terbuka tanpa pemilik).
  - Server mencoba lagi di request berikutnya.
  - Cadangan dibuat sebelum ada file yang ditulis.
- **Rollback:** pasang v1.6 lagi.
  - Kolom `ownerId`/`id` diabaikan v1.6, jadi semua data tetap terbaca.
  - Untuk mengembalikan file persis, salin isi folder cadangan ke `data/`. Langkahnya ada di `docs/DEPLOY.md`.
- **Perubahan perilaku untuk pengguna:**
  - Akun editor tidak lagi melihat proyek admin. Ini memang tujuan blueprint, dan sudah dijelaskan di Kelola pengguna dan DEPLOY.md.
  - Klien MCP lama yang memakai token server tetap jalan sebagai admin pertama.
- **Sisa risiko:**
  - Cek DNS untuk impor URL rentan DNS rebinding (waktu cek ≠ waktu unduh). Mitigasinya: hanya file media yang disimpan, dan hasilnya hanya bisa diunduh pemiliknya.
  - File `media-cache` yang diunduh sebelum restart dan tidak tercatat dianggap milik admin pertama.

### Berikutnya

P1 — metrik pipeline (impor, proxy, pratinjau, ekspor) dan fixture benchmark B0–B5, supaya fase P2/P4/P5/P6 bisa diukur sebelum/sesudah.

---

## P1 — Pengukuran (observability) dan fixture benchmark

### Masalah

v1.6 tidak punya angka. Tidak bisa menjawab pertanyaan blueprint bagian 9: stage mana yang lambat, di perangkat apa, untuk proyek seperti apa, dan apakah sebuah perubahan memperbaikinya. Hanya ekspor cepat yang mencetak profil ke console, dan server tidak punya metrik antrean.

### Keputusan desain

- **Kolektor di memori, tanpa layanan luar** (`public/js/metrics.js`):
  - Sampel disimpan di ring buffer 600 nilai per metrik, jadi memori tetap datar walau editor terbuka berjam-jam.
  - Tidak ada data yang dikirim ke mana pun. Pengguna menyalin JSON sendiri dari menu **⋯ → Diagnostik performa**.
  - *Trade-off:* belum ada agregasi lintas pengguna. Kalau nanti dibutuhkan, JSON yang sama bisa dikirim ke endpoint VPS sendiri.
- **Diukur di titik yang benar-benar dirasakan pengguna:**
  - *Seek → frame tepat:* dari perintah seek sampai video di layar menunjukkan frame posisi itu (menunggu decoder, bukan sekadar event `seeked`).
  - *Impor → bisa dipakai:* sampai frame berikutnya tergambar.
  - *Geser/trim klip:* dari event input sampai frame berikutnya.
- **Benchmark yang bisa diulang:**
  - `bench/fixtures.mjs` membuat B0–B3 dengan ffmpeg: H.264 High, GOP 1 dtk, bitrate konstan supaya ukuran file realistis.
  - `bench/run.mjs` menjalankan editor asli di Chromium (Playwright). Proyek disusun lewat MCP, upload lewat input file seperti pengguna. B4 memakai dua perangkat (desktop dan profil HP), B5 memakai empat akun bersamaan.
  - *Trade-off:* angka dari mesin lab headless (tanpa GPU) adalah **baseline untuk perbandingan sebelum/sesudah**, bukan vonis per perangkat. Blueprint 9.3 tetap meminta pengukuran di PC, iPad, dan HP nyata, dan menu Diagnostik dibuat untuk itu.

### Metrik yang dikumpulkan (blueprint 9.1)

| Kategori | Metrik |
|---|---|
| Impor | `import_visible_ms`, `upload_ms`, `upload_mbps`, `upload_retry_count`, `asset_ready_ms` (salinan ringan siap) |
| Pemutaran | `fps_rendered`, `preview_frames_missed_pct`, `video_dropped_frames_pct` (dari `getVideoPlaybackQuality`), `frame_draw_ms`, `buffer_wait_ms`, `seek_to_frame_ms`, `seek_timeouts`, `preview_quality_down`, elemen media aktif, ukuran kanvas pratinjau |
| Respons UI | `long_tasks_over_50ms`, `main_thread_blocked_ms`, `long_task_ms`, `interaction_ms` (Event Timing), `timeline_drag_ms`, `timeline_trim_ms` |
| Memori/perangkat | JS heap, pemakaian penyimpanan browser (OPFS), core, RAM, layar, GPU, dukungan WebCodecs H.264/HEVC, OPFS, frame callback video, jaringan |
| Ekspor | `fetch_media_ms`, `prepare_ms`, `decode_ms`, `composite_ms`, `encode_ms`, `mux_ms`, `total_ms`, `realtime_factor`, `mode`, `fallback`, `encoder_queue_max`, `output_size`, `failure_stage` |
| Sync | `save_ack_ms`, `save_failed` (konflik revisi menyusul di P6) |
| Backend (admin, `/api/status` → `metrics`) | antrean job per jenis (selesai/gagal, tunggu p50/p95, durasi p50/p95, jalan/batas, antre), disk kosong, RAM, load CPU, respons HTTP 2xx/3xx/4xx/5xx |

### File yang berubah

| File | Perubahan |
|---|---|
| `public/js/metrics.js` (baru) | Kolektor: `sample/count/gauge/event/timer/afterPaint`, `stats` (p50/p95/max), `snapshot` (+ info perangkat), observer long task & Event Timing. |
| `public/js/engine.js` | FPS, frame terlewat, frame video di-drop per sesi putar; tunggu buffer; seek → frame tepat; waktu gambar frame. |
| `public/js/media.js`, `remote.js`, `store.js` | Impor → bisa dipakai, durasi/kecepatan upload, upload diulang, salinan ringan siap, simpan → diterima server. |
| `public/js/fastexport.js`, `exporter.js` | Waktu per tahap ekspor, antrean encoder maksimum, mode/fallback, tahap gagal, kecepatan real-time. |
| `public/js/timeline.js`, `player.js` | Latensi geser/trim klip; berapa kali kualitas pratinjau diturunkan. |
| `public/js/app.js`, `public/css/app.css` | Menu ⋯ → **Diagnostik performa** (juga lewat 🔍 cari fitur, termasuk di HP): ringkasan, Salin/Unduh JSON, Reset. |
| `lib/media-proxy.js`, `server.js` | Metrik antrean job + disk/RAM/load/HTTP di `/api/status` (admin). |
| `bench/fixtures.mjs`, `bench/run.mjs`, `bench/report.mjs` (baru) | Fixture B0–B3, runner B0–B5, laporan + perbandingan sebelum/sesudah. |
| `test/metrics.test.js` (baru) | Persentil, ring buffer terbatas, counter/event/timer/snapshot. |

### Temuan langsung: bug frame salah setelah seek (sudah diperbaiki, commit terpisah)

Metrik `seek_to_frame_ms` langsung memperlihatkan bug di v1.6.

- **Gejala:** saat dijeda, seek jauh ke klip lain atau scrub cepat bisa membuat pratinjau tertahan di frame yang salah.
- **Penyebab:** `sync()` melewati elemen yang belum punya metadata atau masih seeking, dan tidak ada yang memposisikannya ulang.
- **Bukti:** sebelum diperbaiki, di proyek nyata 6 dari 10 seek tidak pernah menampilkan frame yang benar dalam 10 detik. Sesudahnya 10/10 benar dalam 41–77 ms.
- **Perbaikan:** commit "Perbaiki pratinjau yang tertahan di frame salah…" (`engine.js`, sinkron ulang saat `loadedmetadata`/`seeked`).

### Tes

- `npm test`: **32/32 lolos** (3 tes metrik baru).
- `npm run test:e2e`: lolos. `get_frame` tepat 8/8, dan semua cek UI iPad lolos.

### Baseline B0–B5 (sebelum P2–P6)

Lab: 4 vCPU Xeon 2,1 GHz, 17 GB, Chromium headless **tanpa GPU** (SwiftShader), profil desktop 1280×800. Detail lengkap ada di `bench/results/2026-11-13-p1-baseline-desktop.{json,md}`.

| Fixture | Angka utama |
|---|---|
| **B0** 1 klip 1080p 60 dtk + musik | Impor → bisa dipakai p95 **167 ms**. Upload 88 MB 0,8 dtk (loopback). Salinan ringan siap 10 dtk. Putar 30,1 fps, 0% frame terlewat, gambar frame p50/p95 5,9/8,5 ms. Seek → frame p50/p95 **25/41 ms**. Ekspor 1080p **2,85× real-time** (komposit 16,2 dtk dari 21 dtk total). RAM renderer naik 741 → 1.141 MB. |
| **B1** 9:16, 6 klip + 2 teks + musik + filter | Putar 30,3 fps, 1,6% frame terlewat. Seek p95 110 ms. Ekspor **1,2× real-time** (komposit 41 dtk dari 50 dtk: filter di 9:16 1080×1920 mahal). RAM renderer puncak 1.452 MB. |
| **B2** 3 klip + 2 overlay + teks animasi + efek + transisi | Putar 30,5 fps tapi **8,7% frame terlewat**, gambar frame p95 15,1 ms. Seek p95 209 ms. Ekspor 1,6× real-time. |
| **B3** 10 menit, 62 potongan, 2 audio | Putar 30,1 fps. Seek p95 58 ms. Ekspor 120 dtk pertama: 2,6× real-time, tapi **RAM renderer 770 → 2.715 MB dan JS heap 669 MB**, karena file sumber 440 MB dibaca utuh ke memori. |
| **B4** perangkat kedua (profil HP, CPU 4× lebih lambat) membuka proyek B1 | Dingin: siap 1,2 dtk, frame pertama 159 ms, seek p95 145 ms, semua media tersalin 1,1 dtk. Hangat (reload): siap 0,9 dtk. |
| **B5** 4 akun impor bersamaan (12–440 MB) | Latensi API saat antrean penuh p50/p95 **9,5/32 ms** (tetap responsif). Tapi job thumbnail/waveform **menunggu sampai 117 dtk** di belakang konversi video 10 menit (satu antrean, satu job). Salinan ringan file 88 MB baru siap setelah 22,5 dtk. |

**Bottleneck yang teridentifikasi (masukan untuk fase berikutnya):**

1. **Memori ekspor (P4):** sumber dibaca utuh dan hasil encode dikumpulkan di RAM. B3 menembus 2,7 GB untuk 2 menit ekspor, dan di HP/iPad ini berarti tab crash.
2. **Antrean job tunggal (P5):** pekerjaan kecil tertahan di belakang pekerjaan besar akun lain. Tidak ada retry, cancel, atau status job, dan job hilang saat restart.
3. **Proyek berlapis (P2, lalu P3):** B2 kehilangan 8,7% frame. Waktu gambar frame dan komposit ekspor mendominasi. P2 mengurangi kerja JS per frame. Biaya gambar Canvas 2D sendiri adalah wilayah P3 (ditunda sampai ada data perangkat nyata).

### Risiko, fallback, rollback

- Metrik pasif dan ringan: satu `performance.now()` dan satu tulis ke ring buffer per event. Observer long task dan Event Timing dibungkus `try`, jadi browser yang tidak mendukung tidak terpengaruh.
- Tidak ada data yang dikirim keluar. JSON hanya keluar kalau pengguna menekan Salin/Unduh.
- `/api/status` → `metrics` hanya untuk admin.
- Rollback: revert commit. Tidak ada perubahan data atau skema.

### Berikutnya

P2: render plan terkompilasi (indeks per track + binary search), lalu ukur ulang B1/B2/B3 dengan `node bench/report.mjs baseline.json sesudah.json`.

---

## P2 — Timeline hot path: render plan terkompilasi

### Masalah (kode v1.6/P1)

| Lokasi | Masalah |
|---|---|
| `public/js/render.js` `renderFrame` | Setiap frame (30–60×/dtk): `P.tracks.filter(...)` dua kali, lalu `sortedClips()` (filter + sort semua klip) untuk **setiap** track, lalu `mainTrackState` yang menyisir track utama dari awal. |
| `public/js/engine.js` `sync()` | Setiap tick saat diputar: `chainKeys()` (kelompokkan + sort semua klip video/audio), `sortedClips('main')`, bangun ulang peta grup elemen, dan `mainList.indexOf()` per klip (O(n²)). |

Biayanya tumbuh dengan jumlah klip, bukan dengan apa yang terlihat di layar.

### Keputusan desain

- **`store.rev`**: nomor revisi proyek, naik pada setiap perubahan (`mutate`, `live`, undo/redo, muat proyek, batal geser).
- **`public/js/plan.js` (baru, fungsi murni tanpa DOM):** `compilePlan(P)` membangun sekali per revisi:
  - klip per track terurut (sort stabil, urutan seri sama seperti `sortedClips`), plus `maxEnd` (maksimum berjalan ujung klip);
  - urutan track visual/efek, posisi klip di track utama, *chain key* elemen media, dan grup elemen.
- **`clipsAt(track, t)`**: binary search + mundur selama `maxEnd > t`, jadi O(log n + klip yang terlihat).
- **`mainStateAt(plan, t)`**: hasilnya persis sama dengan `mainTrackState` (klip, atau pasangan transisi + progres), tapi hanya memeriksa klip di sekitar `t`.
- **`renderFrame`** memakai `env.plan`. Pemanggil tanpa plan tetap benar karena plan dikompilasi di tempat. **Ekspor cepat** mengompilasi plan sekali per ekspor. **`engine.sync`** memakai grup, *chain key*, dan indeks track utama dari plan.
- *Trade-off:* cache bergantung pada setiap perubahan struktur yang lewat `store.mutate/live`. Semua jalur edit (timeline, inspector, MCP, undo) sudah memakainya. Selain itu, cache juga dikunci pada objek proyek, jadi undo/muat proyek selalu membuat plan baru. `mainTrackState` versi lama tetap ada sebagai referensi tes.

### File yang berubah

`public/js/plan.js` (baru), `public/js/store.js` (`rev`, `plan()`), `public/js/render.js`, `public/js/engine.js`, `public/js/fastexport.js`, `test/plan.test.js` (baru), `bench/plan-micro.mjs` (baru).

### Tes

- `test/plan.test.js` (4 tes) membandingkan langsung dengan kode lama di 20 proyek acak (hingga ~280 klip per proyek, termasuk celah, transisi, potongan dari file yang sama, dan start yang sama):
  - `clipsAt` = `sortedClips().filter()` di setiap track, ±8.000 titik waktu acak, plus semua batas klip (tepat di awal/akhir dan 1e-9 sebelumnya).
  - `mainStateAt` = `mainTrackState` (klip yang sama, atau pasangan A/B transisi yang sama dengan progres sama hingga 1e-12).
  - urutan track, track tersembunyi, chain key, grup elemen, dan cache per revisi.
- `npm test` **36/36 lolos**. `npm run test:e2e` lolos (`get_frame` 8/8 tepat, semua cek UI iPad).

### Benchmark sebelum/sesudah

**1. Mikro (`node bench/plan-micro.mjs`)**: biaya JS per frame untuk "apa yang terlihat di t" (renderFrame) ditambah pengelompokan elemen (engine.sync).

| Klip | v1.6 (ms/frame) | P2 (ms/frame) | Lebih cepat | Kompilasi plan (sekali per edit) |
|---|---|---|---|---|
| 50 | 0,033 | 0,007 | 4,6× | 0,04 ms |
| 200 | 0,064 | 0,019 | 3,5× | 0,12 ms |
| 1.000 | 0,407 | 0,010 | 41× | 0,46 ms |
| 3.000 | 1,618 | 0,034 | 47× | 0,98 ms |

**2. A/B `renderFrame` di browser**: renderer commit P1 vs P2, berselang-seling per blok 40 frame di halaman yang sama (menghilangkan noise antar-run). Dipakai proyek nyata pengguna (57 klip: 38 teks, 7 video, 6 efek, 5 stiker) dan versi yang ditambah klip teks. Dua putaran:

| Proyek | v1.6 (ms/frame) | P2 (ms/frame) | Perubahan |
|---|---|---|---|
| Nyata, 57 klip | 0,53–0,57 | 0,48–0,51 | **−10%** |
| +500 klip (557) | 0,66–0,67 | 0,51–0,54 | **−20%** |
| +2.000 klip (2.057) | 1,11–1,15 | 0,70–0,72 | **−37%** |

**3. Fixture B1–B3** (`bench/results/2026-11-13-p2-desktop.*`):
- FPS, frame terlewat, seek, dan ekspor berada dalam rentang noise lab.
- Contoh noisenya: decode/encode ekspor, yang tidak disentuh P2, bergerak ±10–14% antar-run, dan B1 baseline sendiri 1,6% vs 2,4% frame terlewat di dua run.
- Di proyek ≤62 klip, pencarian klip hanya ~0,03 ms dari 6–10 ms waktu gambar frame. Biaya utamanya ada di gambar Canvas 2D (filter, teks, komposit), yang menjadi wilayah P3.
- **Kesimpulan jujur:** P2 tidak membuat B1–B3 terasa berbeda di desktop lab. P2 menghapus biaya yang tumbuh dengan jumlah klip, yang paling terasa di proyek panjang dan di HP (CPU 4–8× lebih lambat dari lab).

### Risiko, fallback, rollback

- **Risiko:** plan basi kalau ada kode yang mengubah `start/duration/trackId/transition/hidden` tanpa `store.mutate/live`. Mitigasinya: semua jalur edit sudah lewat store (diaudit: timeline, inspector, actions, MCP api), cache juga dikunci pada objek proyek, dan tes e2e iPad (geser, trim, transisi, pindah overlay) lolos.
- **Fallback:** `renderFrame` tanpa `env.plan` (atau plan untuk proyek lain) langsung mengompilasi plan sendiri.
- **Rollback:** revert commit. Tidak ada perubahan data.

### Berikutnya

P4: memori ekspor (B3 baseline 2,7 GB RAM renderer untuk 2 menit ekspor).

---

## P4 — Memori ekspor

### Masalah (kode sebelum P4)

| Lokasi | Masalah |
|---|---|
| `public/js/fastexport.js` `bytes()` | Setiap file sumber dibaca utuh ke RAM (`fetch(url).then(r => r.arrayBuffer())`). Untuk B3, itu 440 MB sebelum satu frame pun dirender. |
| `fastexport.js` `audioBufferFor` + `audioCache` | Audio setiap file di-decode **utuh** (10 menit stereo float ≈ 230 MB per file) dan disimpan di cache tingkat modul, yang tidak pernah dibersihkan, bahkan antar-ekspor. |
| `fastexport.js` encoder `output` | Semua chunk H.264 hasil encode dikumpulkan di `chunks[]` (RAM) sampai akhir. Memori tumbuh sepanjang durasi ekspor. |
| `muxMp4` | Ukuran `mdat` 32-bit: file > 4 GB akan ditulis rusak diam-diam. |

Baseline P1 (B3, 120 dtk pertama): RAM renderer naik 770 → 2.715 MB dan JS heap 669 MB.

### Keputusan desain

- **Sumber dibaca bertahap:**
  - `ByteSource` membaca Blob di balik URL media (File impor atau salinan OPFS, berbasis disk) per jendela 8 MB.
  - `moov()` mencari kotak `moov` dengan menelusuri header kotak tingkat atas (juga kalau `moov` ada di akhir file), lalu hanya kotak itu yang dibaca utuh.
  - Demuxer tidak berubah perilakunya: offset sampel tetap absolut.
  - Blob tiap URL dicatat lewat `objectUrl()/revokeUrl()` di `util.js`. URL tanpa catatan memakai `fetch().blob()` sebagai fallback.
- **Audio hanya rentang yang dipakai:**
  - `demuxAudio` membaca trak AAC (esds → AudioSpecificConfig, edit list untuk priming).
  - Rentang sumber semua klip dari file yang sama digabung, lalu di-decode dengan **WebCodecs AudioDecoder** hanya untuk rentang itu (±0,25 dtk).
  - Memori sebanding dengan durasi ekspor, bukan panjang file.
  - **Fallback:** file non-MP4 (MP3/WAV/OGG) atau browser tanpa AudioDecoder memakai `decodeAudioData` utuh seperti v1.6, tapi **tanpa cache permanen**.
- **Hasil encode ke file sementara OPFS:**
  - Data ditulis bertahap (batch 4 MB) dengan *backpressure* (encoder menunggu kalau > 32 MB belum tertulis).
  - MP4 akhir adalah Blob gabungan header + **File OPFS** (berbasis disk).
  - File sementara dihapus saat ekspor berikutnya dimulai, karena Blob hasil masih dipakai untuk unduh/upload.
  - **Fallback:** memori (perilaku v1.6) bila OPFS/`createWritable` tidak ada, atau server diset `NAJJA_EXPORT_SPOOL=0` (diteruskan lewat `/api/status` → `features.exportSpool`).
- **Jaga-jaga 4 GB:** output yang akan melewati batas ukuran 32-bit dilempar sebagai `unsupported`, lalu jatuh ke perekam real-time. File tidak pernah ditulis rusak.
- **Kualitas tidak diubah:** resolusi, fps, bitrate, codec, dan sumber kualitas penuh sama persis.

### File yang berubah

| File | Perubahan |
|---|---|
| `public/js/fastexport.js` | `sampleTable`/`traks` (dipakai bersama video dan audio), `demuxAudio`, `ByteSource`, rentang audio + `AudioDecoder`, spool OPFS, `VideoSource` membaca bertahap, muxer menerima body Blob + jaga 4 GB, statistik `spool`/`audio_decoded_s`/`audio_full_decode`. |
| `public/js/util.js`, `media.js`, `devicecache.js` | `objectUrl()/revokeUrl()/blobOfUrl()`: semua URL blob media lewat registri. |
| `public/js/exporter.js`, `server.js` | Saklar `NAJJA_EXPORT_SPOOL=0` → `features.exportSpool`. |
| `public/js/app.js` | Diagnostik: tempat hasil encode, detik audio yang di-decode, jumlah file yang di-decode utuh. |
| `bench/run.mjs` | Cek kebenaran: ffprobe + **loudness audio** (`volumedetect`) untuk hasil ekspor B0/B3. |
| `test/export-read.test.js` (baru) | `moov` di awal/akhir file, sampel identik dengan demux file utuh, pembacaan jendela = byte file, demux AAC (codec, rate, channel, ASC, priming), file tanpa audio/`moov` → unsupported. |

### Tes

- `npm test`: **38/38 lolos**.
- `npm run test:e2e`: lolos.
- Uji fallback MP3 di browser: ekspor tetap mode cepat dengan 1 file di-decode utuh. Audio hening −91 dB sebelum klip mulai dan −21,5 dB saat nada berbunyi. Durasi dan stream benar.

### Benchmark sebelum/sesudah (runner sama, kode commit P2 vs P4)

Data lengkap ada di `bench/results/2026-11-13-p4-{before,after}-desktop.*`.

| | Sebelum | Sesudah | Perubahan |
|---|---|---|---|
| **B3 ekspor 120 dtk** · RAM renderer puncak | 2.667 MB | **1.287 MB** | **−52%** |
| B3 · pertumbuhan RAM selama ekspor | +1.652 MB | **+224 MB** | **−86%** |
| B3 · JS heap puncak | 690 MB | **174 MB** | **−75%** |
| B3 · kecepatan ekspor | 2,48× real-time | 2,40× | noise |
| B3 · audio hasil (rata-rata/puncak) | −16,3 / −8,5 dB | −16,3 / −8,5 dB | **identik** |
| **B0 ekspor 60 dtk** · JS heap puncak | 140 MB | **74 MB** | **−47%** |
| B0 · RAM renderer puncak | 1.136 MB | 1.049 MB | −8% |
| B0 · kecepatan ekspor | 2,52× | 2,55× | noise |
| B0 · audio hasil | −18,1 / −10,9 dB | −18,1 / −10,9 dB | **identik** |
| Video hasil (B0, B3) | h264 1920×1080 30 fps | sama | identik |

### Risiko, fallback, rollback

- **Safari/iPad:** `createWritable` OPFS di main thread belum ada di semua versi Safari. Di sana spool otomatis kembali ke memori, sementara pembacaan sumber bertahap dan decode audio per rentang tetap bekerja. Spool untuk Safari butuh worker + `createSyncAccessHandle`. Ini dicatat sebagai pekerjaan lanjutan, bersama P3.
- **AudioDecoder tidak ada** (Safari lama): kembali ke `decodeAudioData` utuh, tanpa cache permanen.
- **Disk penuh saat spool:** error penulisan menggagalkan ekspor dengan pesan jelas (tahap tercatat di Diagnostik), lalu file sementara dihapus.
- **Rollback:** revert commit, atau `NAJJA_EXPORT_SPOOL=0` untuk mematikan spool saja. Tidak ada perubahan data.

### Berikutnya

P5: antrean job media yang tahan restart, dengan konkurensi terbatas, retry, cancel, dan status job. Baseline B5: job thumbnail menunggu sampai 117 dtk di belakang konversi video akun lain.

---

## P5 — Sistem job media

### Masalah (kode sebelum P5)

| Lokasi | Masalah |
|---|---|
| `lib/media-proxy.js` `schedule/pump` | Antrean di memori, **satu job sekaligus untuk semua akun**, FIFO. Konversi video 10 menit satu akun menahan klip 10 detik akun lain sampai selesai. |
| sama | Tidak ada retry, timeout per job, atau cancel. ffmpeg yang macet menahan antrean selamanya, kecuali kena timeout asset 10 menit. |
| sama | Antrean hilang saat restart. Hanya ada deteksi "pending tanpa antrean" saat media dibuka, jadi job tidak jalan sampai ada yang membuka medianya. |
| `server.js` | Tidak ada status job untuk pengguna: tidak bisa melihat, membatalkan, atau mengulang. |

Data lab (B5 bertahap: video 10 menit masuk dulu, lalu tiga akun mengunggah klip pendek): klip 9–12 dtk baru siap setelah **111–112 dtk**, dan tunggu antrean p95 110 dtk.

### Keputusan desain

- **`lib/jobs.js` (baru), antrean tahan restart:**
  - Satu file JSON kecil per job di `data/jobs/`, ditulis atomik. Isinya hanya data (jenis, id media, pemilik), tidak pernah kode.
  - Handler didaftarkan per jenis.
  - Saat start, job `queued` dilanjutkan dan job `running` (terputus) dikembalikan ke antrean dengan `interrupted+1`. File jurnal rusak dilewati.
- **Idempoten:** kunci `edit:<id>`, `assets:<id>`, `proxy:<id>`. Meminta lagi selama masih antre atau berjalan mengembalikan job yang sama.
- **Status:** `queued → running → succeeded | failed | cancelled`, dengan progres, heartbeat (≤ 5 dtk di jurnal), percobaan, error, dan waktu coba lagi.
- **Retry dan timeout:**
  - Retry dengan *backoff* 5 dtk lalu 20 dtk (maks. 3 percobaan). Media yang sudah dihapus gagal permanen tanpa retry.
  - Timeout per job sebanding durasi media. ffmpeg dihentikan lewat `AbortSignal`.
  - Selama masih ada percobaan tersisa, status media tetap "pending", jadi editor tidak menampilkan "gagal" palsu.
- **Cancel:** job yang antre langsung dibatalkan, dan yang berjalan dihentikan (ffmpeg di-kill). Menghapus media membatalkan job-nya.
- **Konkurensi terbatas per kelas:**
  - `light` untuk thumbnail/waveform: 1, atau 2 bila ≥ 8 core.
  - `fast` untuk salinan ringan: 1 per 4 core, maks. 3.
  - `slow` untuk kualitas penuh: 1, atau 2 bila ≥ 8 core & 8 GB.
  - Bisa diubah lewat `NAJJA_JOB_LIGHT/FAST/SLOW`.
  - *Trade-off:* satu konversi ffmpeg memakai semua core. Menambah slot hanya membagi CPU, tidak menambah throughput.
- **Keadilan antar-akun:**
  - *Pendek dulu dengan aging:* posisi antre = waktu masuk + 0,5 × durasi media. Video panjang tetap pasti jalan; contoh di tes: video yang sudah menunggu 400 dtk mendahului klip baru.
  - *Jalur pendek:* media ≤ 90 dtk boleh memakai 1 slot tambahan **hanya** saat semua yang berjalan adalah job panjang. Maksimal limit + 1, jadi VPS tetap terbatas.
- **Dependensi:** thumbnail menunggu salinan ringan media yang sama (dibuat dari file 720p, lebih cepat) tanpa memakan slot.
- **API dan tampilan:**
  - `GET /api/jobs` hanya menampilkan job milik akun.
  - `POST /api/jobs/:id/cancel|retry` memeriksa pemilik dan menjawab 404 untuk job akun lain.
  - Diagnostik → **Antrean server** menampilkan job akun ini dengan tombol Batalkan/Ulangi.
  - Metrik job (kelas, limit, tunggu/durasi p50/p95, retry) ada di `/api/status` untuk admin.

### File yang berubah

| File | Perubahan |
|---|---|
| `lib/jobs.js` (baru) | Antrean tahan restart: jurnal, idempotensi, retry/backoff, timeout, cancel, kelas + jalur pendek + aging, dependensi, metrik. |
| `lib/media-proxy.js` | Memakai `lib/jobs.js`; `run()` menerima `AbortSignal`; progres ke job; status "pending" selama masih ada retry. |
| `server.js` | Antrean di `data/jobs/`, pemilik job = pemilik media, `/api/jobs`, cancel/retry, batalkan job saat media dihapus. |
| `public/js/app.js`, `public/css/app.css` | Diagnostik: daftar job akun + Batalkan/Ulangi. |
| `bench/run.mjs` | B5 bertahap (video panjang dulu, lalu klip pendek dari 3 akun lain). |
| `test/jobs.test.js` (baru), `test/tenancy.test.js` | 10 tes antrean + tes isolasi job antar-akun. |
| `README.md`, `docs/DEPLOY.md` | Antrean, saklar `.env`, lokasi `data/jobs/`. |

### Tes

- `test/jobs.test.js` (10 tes): idempoten; batas per kelas (fast tidak tertahan slow); dependensi tanpa memakan slot; retry dengan backoff lalu gagal dengan pesan; timeout menghentikan job; cancel (berjalan dan antre); restart melanjutkan job antre dan terputus serta melewati jurnal rusak; daftar per pemilik; urutan pendek dulu + aging; jalur pendek; batas default dan saklar env.
- `test/tenancy.test.js`: job upload 1080p milik A tidak terlihat oleh B, B tidak bisa membatalkan atau mengulangnya (404), dan jurnalnya ada di disk.
- `test/proxy.test.js` (7 tes lama) lolos dengan antrean baru.
- Total `npm test` **49/49**. `npm run test:e2e` lolos.
- **Uji crash:** server di-`SIGKILL` saat konversi 10%. Setelah dinyalakan, log mencatat "antrean job dilanjutkan: 2 job", konversi selesai di percobaan ke-2 (`interrupted: 1`), dan salinan ringan siap.

### Benchmark sebelum/sesudah (B5 bertahap, runner sama, kode commit P4 vs P5)

Data lengkap ada di `bench/results/2026-11-13-p5-{before,after}-desktop.*`.

| | Sebelum (FIFO, 1 slot) | Sesudah (P5) |
|---|---|---|
| Klip 9 dtk (12 MB) → salinan ringan siap | 112,4 dtk | **7,1 dtk (−94%)** |
| Klip 12 dtk (18 MB) | 110,9 dtk | **10,7 dtk (−90%)** |
| Klip 60 dtk (88 MB) | 123,8 dtk | **26,5 dtk (−79%)** |
| Video 10 menit (439 MB) | 88,3 dtk | 95,6 dtk (+8%, berbagi CPU sebentar) |
| Tunggu antrean salinan ringan p95 | 110,4 dtk | **6,0 dtk** |
| Seluruh skenario selesai | 127 dtk | 96 dtk |
| Latensi API saat antre p50/p95 | 7,5 / 22,5 ms | 6,2 / 38 ms (tetap responsif; 2 ffmpeg di 4 core) |

### Risiko, fallback, rollback

- **Beban VPS:** jalur pendek bisa menjalankan 2 konversi bersamaan, sehingga CPU penuh sebentar. Itu tetap dibatasi (maks. limit + 1, hanya untuk media ≤ 90 dtk). VPS yang juga menjalankan aplikasi lain (misalnya ecom) bisa menurunkan `NAJJA_JOB_FAST`. ffmpeg tetap berjalan dengan prioritas rendah (`nice 10`) kecuali salinan ringan.
- **Jurnal rusak:** file dilewati dan dihapus. Media yang statusnya masih "pending" tanpa job aktif dibuat ulang otomatis saat statusnya dibaca.
- **Rollback:** pasang versi sebelumnya. Folder `data/jobs/` tidak dibaca versi lama dan aman dihapus. Status media (`edit.json`/`proxy.json`) tetap kompatibel.

### Berikutnya

P6: revisi proyek + deteksi konflik antar-perangkat (sekarang simpan terakhir menimpa diam-diam).

---

## P6 — Sinkron multi-perangkat

### Masalah (kode sebelum P6)

| Lokasi | Masalah |
|---|---|
| `server.js` `PUT /api/projects/:id`, `lib/storage.js` `putProject` | *Last write wins*: simpan dari perangkat mana pun menimpa begitu saja. HP yang masih membuka versi lama bisa menghapus pekerjaan dari laptop tanpa peringatan. |
| `public/js/store.js` `save()` | Tidak ada revisi atau basis, dan simpan-simpan dari satu tab bisa saling menyusul. |
| Klien | Perubahan dari perangkat lain tidak pernah terlihat sampai proyek dibuka ulang. Perubahan yang gagal terkirim (tab ditutup, offline) hilang. |

### Keputusan desain

- **Revisi di server:**
  - Setiap simpan → `rev + 1`.
  - `PUT ?baseRev=N` ditolak **409** `{ conflict, rev, updatedAt }` kalau server sudah di revisi lain. `&force=1` hanya dipakai setelah pengguna memilih "timpa".
  - Simpan tanpa `baseRev` (klien lama) tetap diterima, demi kompatibilitas.
  - Penulisan per proyek diserialkan (kunci per id), jadi dari dua simpan bersamaan dengan basis sama tepat satu yang menang.
  - `GET /api/projects/:id/rev` dijawab dari cache memori, cukup murah untuk dipolling tiap detik.
- **Klien:**
  - `store.baseRev` disimpan **di luar** objek proyek, supaya undo/redo tidak memundurkan revisi dan tidak memicu konflik palsu.
  - Simpan dalam satu tab dijalankan berurutan.
  - Simpan dilewati kalau tidak ada perubahan (`dirty`), sehingga perangkat lain tidak memuat ulang tanpa alasan.
- **Mengikuti perangkat lain:**
  - Polling revisi tiap `NAJJA_SYNC_POLL_MS` (default 1 dtk), hanya saat tab terlihat, dan tidak saat menggeser klip atau mengekspor.
  - Tanpa perubahan lokal, versi baru langsung dimuat (playhead dan pilihan klip dipertahankan).
  - Dengan perubahan lokal, simpan berikutnya kena 409, lalu **dialog konflik** muncul: *muat versi terbaru* / *simpan versiku sebagai salinan* / *timpa dengan versiku*. Simpan otomatis berhenti sampai pengguna memilih.
- **Draf lokal:**
  - Setiap perubahan disimpan ke IndexedDB (`drafts`, ±0,4 dtk) dan dihapus setelah server menerimanya. Tab yang disembunyikan langsung menyimpan.
  - Saat proyek dibuka: draf yang berbasis revisi server yang sama dipulihkan otomatis. Kalau server juga berubah, dialog konflik ditampilkan.
- *Trade-off:* tidak ada penggabungan otomatis (*merge*) JSON proyek. Blueprint melarang auto-merge tanpa semantik revisi, dan dua versi timeline yang digabung otomatis bisa menghasilkan proyek yang tidak diinginkan siapa pun. Pengguna yang memilih, dan tidak ada versi yang hilang.

### File yang berubah

| File | Perubahan |
|---|---|
| `lib/storage.js` | `putProject(id, p, { baseRev, force })` dengan kunci per proyek, `projectRev()` + cache revisi. |
| `server.js` | `PUT ?baseRev&force`, `GET /api/projects/:id/rev` (cek pemilik), 409 membawa info konflik, `features.syncPollMs`. |
| `public/js/remote.js`, `storage.js`, `db.js` | `putProject` dengan basis, `projectRev`, tabel `drafts` (IndexedDB v2). |
| `public/js/store.js` | `baseRev`, `dirty`, simpan berurutan, draf, status `conflict`, metrik `revision_conflict_count`. |
| `public/js/app.js`, `public/css/app.css` | `loadProject` (draf), polling revisi, dialog konflik, indikator "Diubah di perangkat lain — pilih versi" (bisa diklik), simpan saat tab disembunyikan; footer modal bisa membungkus (tombol tidak meluber di HP). |
| `test/sync.test.js`, `test/e2e/sync.mjs` (baru) | Tes API + e2e dua perangkat. |

### Tes

- `test/sync.test.js` (4 tes):
  - revisi naik per simpan; basis lama → 409 dengan revisi server, tanpa menimpa; `force` menimpa; klien lama tanpa `baseRev` tetap bisa menyimpan;
  - revisi dan konflik per akun (404 untuk akun lain);
  - 6 simpan bersamaan dengan basis sama → tepat 1 berhasil, 5 dapat 409;
  - proyek lama tanpa `rev` mulai dari 0, dan cache mengikuti penghapusan.
- `test/e2e/sync.mjs` (dua konteks browser, satu akun, 15 cek): B melihat perubahan nama dan klip dari A; undo di A tidak menimbulkan konflik dan B ikut; B mengubah saat offline sementara A menyimpan, lalu dialog konflik muncul di B, versi A tetap utuh, dan pilihan "salinan" menyimpan versi B sebagai proyek baru; tombol dialog tidak meluber (iPad dan 390 px); tab A ditutup sebelum perubahan terkirim, lalu dibuka lagi: perubahan dipulihkan dari draf dan tersimpan sebagai revisi berikutnya; tanpa error halaman.
- Diulang 3×, stabil.
- `npm test` **53/53**. `npm run test:e2e` (get-frame, iPad UI, sync) lolos.

### Ukuran (target blueprint: perubahan perangkat kedua terlihat ≤ 2 dtk di jaringan lab)

| | Sebelum | Sesudah |
|---|---|---|
| Perubahan di A terlihat di B | tidak pernah (sampai dibuka ulang) | **1,0 dtk** (3 run; jeda simpan 0,7 dtk + polling 1 dtk) |
| Dua perangkat menyimpan versi berbeda | yang terakhir menimpa diam-diam | 409 → pengguna memilih, tidak ada versi hilang |
| Perubahan yang belum terkirim saat tab ditutup | hilang | dipulihkan dari draf, lalu tersimpan |
| Beban polling | — | 1 GET kecil/dtk per tab yang terlihat, dijawab dari memori |

### Risiko, fallback, rollback

- **Klien lama** (tab v1.6 yang masih terbuka saat update) menyimpan tanpa `baseRev`: tetap diterima, dengan perilaku lama untuk tab itu. Setelah reload, tab memakai revisi.
- **IndexedDB tidak tersedia** (mode privat): draf dilewati tanpa error; sinkron dan konflik tetap bekerja.
- **Jam perangkat berbeda:** `sync_lag_ms` di Diagnostik memakai jam perangkat pengirim, jadi hanya perkiraan. Keputusan sinkron hanya memakai nomor revisi, tidak memakai jam.
- **Rollback:** pasang versi sebelumnya. Kolom `rev` di JSON proyek diabaikan versi lama, dan tabel `drafts` di browser tidak mengganggu.

### Berikutnya

Rilis v1.7.0: tes lengkap, ringkasan, versi 1.7.0. P3 (render worker/WebGL2) dan P7 (cloud render) tetap ditunda dengan alasan di rencana.
