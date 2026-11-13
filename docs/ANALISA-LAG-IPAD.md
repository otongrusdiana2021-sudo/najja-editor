# Analisa: pratinjau patah-patah di iPad (v1.7.1, v1.7.2)

Sumber data: rekaman layar iPad mini (Safari, potret, proyek 1 klip 25 dtk), Diagnostik dari iPad pengguna, dan pengukuran ulang di lab (Chromium + Playwright, profil iPad).

## 1. Apa yang terlihat di rekaman

Angka waktu di layar dibaca per 0,2 detik:

| Waktu rekaman | Playhead | Arti |
|---|---|---|
| 0–2 dtk | 00:03 → 00:05 | play, lancar |
| 2–4 dtk | kembali ke 00:03 | scrub (geser timeline), lalu play |
| 4–9 dtk | 00:03 → 00:06 | hanya **±3 dtk video dalam 5 dtk nyata** (±60%) |
| ±7–9 dtk | 00:06 diam | **macet ±2 dtk** walau masih play |

Jadi pratinjau bukan sekadar "kasar". Pemutarannya **lebih lambat dari real-time dan sempat ditahan**.

## 2. Server atau engine?

**Bukan server.**
- Saat memutar, server tidak dipakai kalau medianya sudah ada di iPad: diputar dari file asli hasil impor, atau dari salinan ringan yang tersimpan di perangkat.
- Diagnostik iPad: beban CPU server 0,02, antrean konversi kosong, dan 457 MB media sudah tersimpan di iPad.

Peran server hanya dua, dan keduanya tidak terjadi saat memutar:
1. membuat **salinan ringan** (±40 dtk per klip di VPS 2 core, menurut data job di Diagnostik);
2. mengirim media ke perangkat yang belum punya salinannya.

**Penyebabnya di engine pratinjau (browser):**

1. **File kamera asli yang berat diputar langsung** (penyebab utama).
   - Video iPhone/iPad biasanya HEVC, HDR 10-bit, 4K atau 60 fps.
   - Setelah impor, pratinjau memutar file asli itu sampai salinan ringan dari server *selesai diunduh ke iPad*.
   - Unduhan itu ditahan selama memutar, dan penukaran ke salinan hanya terjadi saat di-pause.
   - Akibatnya decoder dan konversi warna HDR harus bekerja per frame, lebih lambat dari real-time.
   - Lab, video 4K60 yang sama: dari file asli decoder hanya memberi **5,7 gambar/dtk**, kecepatan putar **74%**, ditahan buffer 2×. Dari salinan ringan: **29,7 gambar/dtk, 99,9%, 0 buffer**.
2. **Penahanan buffer yang terlalu cepat** (sudah diperbaiki di b36f632).
   - Safari sesaat melaporkan "data belum cukup". Engine langsung menahan playhead, mem-pause semua video, lalu memutar lagi, dan siklus ini memicu jeda berikutnya.
   - Data iPad: 10 tahan × ±50 ms dalam 10 dtk, FPS 16,5.
3. **Jam pratinjau terpisah dari video.**
   - Engine menjalankan jam sendiri (`performance.now`) dan *mengejar* video dengan seek kalau tertinggal > 0,3 dtk.
   - Di decoder yang lambat, seek di Safari = berhenti mencari keyframe, lalu dianggap buffering.
   - Ini bukan cara pemutar video yang baik. Di lab, jumlah seek koreksi ternyata 0 (buffer menahan duluan), tapi mekanismenya tetap rapuh, jadi ikut diganti.
4. **Timeline menggambar ulang di setiap frame** (sudah diperbaiki di a397d4f): beban timeline turun 56%, sendatan turun ±65%.
5. **Scrub di Safari**: setiap gerakan jari = seek presisi, yang lambat untuk file dengan keyframe jarang.

## 3. Mekanisme Canva / CapCut web, dan posisi Najja sekarang

| Mekanisme | Canva / CapCut web | Najja v1.7.0 | Najja v1.7.1 |
|---|---|---|---|
| Media untuk pratinjau | Selalu *proxy* ringan buatan server; file asli tidak pernah diputar di editor | Salinan 720p ada, tapi file asli diputar sampai salinan tiba di perangkat | **File asli yang berat langsung diganti salinan ringan** begitu server selesai (stream dulu, lalu dari perangkat) |
| fps proxy | ≤ 30 | Sama dengan asli (60 tetap 60) | **≤ 30** (60 → 30, 59,94 → 29,97, 50 → 25) |
| HDR / 60 fps | Dikonversi ke SDR 8-bit | HDR ditonemap hanya bila ada alasan lain | **HDR & > 30 fps selalu dibuatkan salinan ringan** |
| Jam pemutaran | Gambar/suara yang sedang diputar menjadi jam utama | Jam sendiri + seek video yang tertinggal | **Jam tidak boleh mendahului gambar video > 0,15 dtk**: decoder lambat membuat putar sedikit lebih lambat tapi mulus, tanpa seek koreksi |
| Jeda data sesaat | Diabaikan; spinner hanya untuk tunggu lama | Langsung tahan + pause semua | **Toleransi 300 ms**, spinner setelah 0,4 dtk |
| Scrub | Frame terdekat dulu, presisi saat jari berhenti | Seek presisi setiap gerakan | **`fastSeek` saat jari bergerak** (Safari), presisi 0,2 dtk setelah berhenti |
| Media disimpan di perangkat | Cache lokal | OPFS, tapi unduhan ditahan saat memutar | Unduhan **jalan terus** selama yang diputar sudah lokal |
| UI saat memutar | Hanya transform yang digeser compositor | (sudah diperbaiki) | Ruler tile, filmstrip/waveform per blok |
| Dekode & komposit | Banyak memakai WebCodecs + WebGL di worker | `<video>` + Canvas 2D di main thread | sama (lihat §6) |

## 4. Perubahan v1.7.1

**Engine (`public/js/engine.js`):**
- Jam tidak boleh mendahului gambar video utama lebih dari 0,15 dtk (`engine.videoClock`, bisa dimatikan untuk A/B).
  - Versi pertama yang selalu mengikuti video terbukti membuat putar 1,5% lebih lambat di proyek banyak potongan, karena menunggu setiap klip mulai.
  - Itu bisa membuat musik latar tertinggal lalu di-seek. Batas 0,15 dtk menghindarinya: jeda mulai klip di bawah batas, jadi tidak menumpuk.
- `engine.scrub()` memakai `fastSeek` di Safari saat jari bergerak, lalu seek presisi setelah berhenti, tanpa seek berulang ke keyframe yang sama.
- Sumber baru (misalnya salinan ringan) bisa ditukar saat memutar untuk klip yang tidak sedang tampil.
- Metrik baru:
  - `video_presented_fps`: gambar yang benar-benar diberikan decoder;
  - `playback_speed_pct`: detik timeline per detik nyata;
  - `drift_seek`: seek koreksi;
  - `raf_gap_over_50ms`: jeda frame;
  - `event_loop_lag_ms`: lag event loop (bekerja di Safari).

**Pemilihan sumber (`public/js/media.js`, `public/js/app.js`):**
- File asli yang dinilai berat oleh server (codec/fps/HDR/bitrate/> 1080p) langsung diganti salinan ringan.
- Salinan disimpan ke perangkat juga selama memutar kalau semua yang diputar sudah lokal.
- Label di pratinjau: "Menyiapkan versi ringan untuk pratinjau lancar… xx%" selama file asli berat masih dipakai.

**Server (`lib/media-proxy.js`):** probe membaca fps; salinan ringan juga dibuat untuk video > 30 fps dan HDR/10-bit; salinan ringan maksimal 30 fps.

**Impor dari iPad (`public/js/util.js` `pickFiles`, `sheet.js`, `library.js`, `media.js`):**
- Input file kini terpasang di halaman dan **ditahan sampai pilihan datang**. Memilih video dari Foto/iCloud bisa lama, dan input yang terlepas bisa hilang sebelum itu, sehingga media "tidak muncul".
- Video untuk membaca metadata ikut dipasang di halaman dan dimuat eksplisit (`load()`).

**Kompatibilitas iPadOS lama:** `??=` (butuh Safari 14) dan `.at()` (Safari 15.4) diganti dengan bentuk lama. `??=` yang tidak didukung membuat seluruh engine gagal dimuat.

**Diagnostik:**
- Sumber yang diputar per video ("file asli di perangkat", "salinan ringan di perangkat", "salinan ringan (stream server)").
- Fps dari decoder, kecepatan putar, seek koreksi, jeda frame, dan penyebab buffer.

## 5. Bukti

- **B7** (video 4K 60 fps, baru diimpor, profil iPad), `bench/results/2026-11-13-b7-light-ipad.*`:

  | | File asli | Salinan ringan |
  |---|---|---|
  | Kecepatan putar | 73,8% | **99,9%** |
  | Gambar dari decoder | 5,7 fps | **29,7 fps** |
  | FPS pratinjau | 6,2 | **30,2** |
  | Ditahan buffer | 2× / 1,6 dtk | **0** |
  | Jeda frame > 25 ms (12 dtk) | 80 | 24 |

- **Jam lama vs baru** (profil iPad; `bench/results/2026-11-13-vc-*`, `vl-*`):

  | | Jam lama | Jam baru (batas 0,15 dtk) |
  |---|---|---|
  | B6, 48 potongan dari 3 file: kecepatan putar | 100% | 99,9% |
  | B6: buffer / seek koreksi | 0 / 0 | 0 / 0 |
  | B1, musik + potongan: seek koreksi (musik) | 0 | 0 |
  | B7 file asli 4K60: kecepatan putar | 68,6% | 71% |
  | B7 setelah pindah ke salinan ringan | 99,8%, 29,9 fps, 0 buffer | 99,9%, 29,9 fps, 0 buffer |

  Penentu kelancaran adalah **sumber yang diputar** (salinan ringan vs file asli berat). Batas jam adalah pengaman untuk decoder lambat, tanpa efek samping di konten normal.
- **Tes otomatis:** `npm test` 53/53, `npm run test:e2e` lolos (get_frame tepat 8/8, UI iPad termasuk simulasi jeda Safari, sinkron dua perangkat).

## 6. Yang belum (dan kenapa)

- **Pemutar WebCodecs + render di worker/WebGL**, seperti yang dipakai editor web besar:
  - Dekode diatur sendiri, gambar disimpan di GPU, dan komposit tidak di main thread. Ini paling tahan terhadap perilaku `<video>` Safari.
  - Pekerjaannya besar (fase P3 di rencana). Butuh demux HEVC/rotasi, sinkron audio, dan pengujian di iPad sungguhan.
  - Dikerjakan **setelah** Diagnostik v1.7.1 dari iPad menunjukkan sisa masalah ada di sana. Kalau "Gambar dari decoder" sudah ±30 fps tapi FPS pratinjau masih rendah, itu tanda komposit Canvas 2D-nya yang perlu dipindah.
- **Salinan ringan langsung di iPad** (transcode lokal dengan WebCodecs, tanpa menunggu server): menghapus jeda ±40 dtk setelah impor. Butuh demux HEVC .MOV dan penanganan rotasi.
- **Server lebih cepat membuat salinan:** VPS 2 core membutuhkan ±40 dtk per klip 4K HEVC. Bisa dipercepat dengan VPS lebih banyak core (keputusan biaya, tidak saya ubah).

## 7. Cara cek setelah update

1. Jalankan installer, lalu tutup dan buka lagi tab editor di iPad.
2. Impor video. Selama label "Menyiapkan versi ringan…" muncul, pratinjau masih memakai file asli. Setelah label hilang dan di-pause sekali, pratinjau memakai salinan ringan.
3. Putar ±15 dtk, lalu menu ⋯ → **Diagnostik performa** → **Salin JSON**. Yang diharapkan:
   - **Gambar dari decoder** ±30 fps dan **Kecepatan putar** ±100%;
   - **Menunggu buffer** ±0;
   - **Diputar:** "salinan ringan di perangkat".

## 8. Setelah v1.7.1: Diagnostik iPad dan perbaikan v1.7.2

Diagnostik dari iPad setelah update:
- **Sudah beres:** menunggu buffer 0, FPS 27,7–29,8, seek p95 17 ms, lag event loop 2–3 ms. Engine dan UI tidak lagi menjadi penghambat.
- **Sisa masalah:** "Gambar dari decoder" p95 **41 fps** dan "Kecepatan putar" p50 **90%**. Salinan ringan yang diputar ternyata masih **60 fps**, karena dibuat sebelum batas 30 fps ada. Decoder iPad tidak sanggup 60 fps penuh untuk video ini, sehingga jam pratinjau menunggu gambar (putar ±10% lebih lambat).

Perbaikan di v1.7.2:
- Salinan lama yang dibuat dengan aturan lama **dibuat ulang otomatis** saat medianya dibuka, kalau aturan baru mengubahnya (fps > 30 atau HDR).
- Selama dibuat ulang, salinan lama tetap dipakai. Setelah salinan baru siap, editor mengunduhnya ke perangkat lalu menukarnya.
- Server kini mengirim alasan salinan dibuat (`reasons`). Video iPhone 1080×1920 HDR/60 fps langsung dikenali sebagai berat, bukan hanya video > 1920 px.
- Metrik "frame terlewat" tidak lagi menghitung video 60 fps di proyek 30 fps sebagai terlewat.

Cara cek: buka proyeknya, lalu tunggu ±1 menit per klip (VPS membuat ulang salinan). Putar ±15 dtk, lalu salin Diagnostik. Yang diharapkan: "Gambar dari decoder" ±30 fps, "Kecepatan putar" ±100%, "Frame proyek terlewat" mendekati 0.
