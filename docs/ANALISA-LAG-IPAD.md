# Analisa: pratinjau patah-patah di iPad, dan ekspor dari iPad (v1.7.1–v1.8.1)

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

## 9. "Playback sudah lumayan smooth, tapi audionya sering delay" (v1.7.3)

### Penyebab: suara diambil dari elemen video

Sampai v1.7.2, suara setiap klip berasal dari elemen `<video>`/`<audio>` klip itu sendiri. Suaranya disalurkan ke Web Audio (`createMediaElementSource`) untuk volume dan fade. Ada tiga kelemahan:

1. **Bug Safari di jalur itu.** WebKit punya laporan yang cocok dengan gejalanya:
   - suara lewat Web Audio terlambat dan tersendat (bug [221334](https://lists.webkit.org/pipermail/webkit-unassigned/2021-March/967175.html), [239696](https://bugs.webkit.org/show_bug.cgi?id=239696));
   - `currentTime` elemen tidak sama dengan suara yang terdengar ([204228](https://bugs.webkit.org/show_bug.cgi?id=204228)), jadi engine bahkan tidak bisa melihat selisihnya;
   - dua elemen audio saling menjauh di Safari, sementara di Chrome tetap sinkron ([301824](https://bugs.webkit.org/show_bug.cgi?id=301824)).
2. **Setiap potongan menunggu elemen berikutnya mulai.** Elemen klip berikutnya baru diputar tepat di potongan. Jeda mulainya (lab ±35–50 ms, di Safari lebih lama) membuat suara dan gambar masuk terlambat di setiap potongan.
3. **Track lain hanya dikoreksi kalau sudah 0,3 dtk meleset**, dan koreksinya dengan seek, yang terdengar sebagai lompatan. Jam pratinjau juga sesekali menunggu video (batas 0,15 dtk), sementara musik jalan terus, jadi musik menjauh dari gambar.

Ini bukan masalah server: suara diputar dari file di perangkat, dan server tidak dipakai saat memutar.

### Mekanisme baru, seperti editor web (Canva, CapCut web)

**`public/js/audio.js`:**
- Suara setiap klip yang terdengar di-**decode per blok 8 detik**, hanya bagian yang diputar, dengan WebCodecs `AudioDecoder` dari track AAC file di perangkat.
- Suara **dijadwalkan sampel-akurat** di jam Web Audio (`AudioBufferSourceNode`), 1 detik ke depan, dan di-decode 8 detik ke depan.
- Volume dan fade dibuat sebagai otomasi gain. Mengubah volume saat diputar tidak memulai ulang suara.
- **Jam pratinjau = suara yang sedang keluar dari speaker** (`getOutputTimestamp`), jadi latensi output ikut terkompensasi.

**`public/js/engine.js`:**
- Elemen video **dibisukan** dan mengikuti jam suara.
  - Selisih kecil dikoreksi dengan kecepatan putar 0,8–1,2×. Karena videonya bisu, koreksi ini tidak terdengar.
  - Selisih diukur pada frame yang benar-benar tampil (`requestVideoFrameCallback`), karena `currentTime` meleset ±20 ms.
  - Seek hanya kalau selisih > 0,45 dtk.
- Elemen klip berikutnya **mulai sebelum potongan**, sesuai jeda mulai yang terukur di perangkat itu.

**Fallback per klip ke suara elemen (cara lama):**
- klip yang dipercepat atau diperlambat (supaya nada suara tetap);
- file yang belum ada di perangkat (masih di-stream);
- format yang tidak bisa di-decode, termasuk MP3/WAV yang lebih dari 150 dtk (yang lebih pendek di-decode utuh);
- AudioContext yang berhenti (misalnya iOS saat ada telepon);
- file asli berat yang masih diputar sebelum salinan ringannya siap.

Ekspor real-time tetap memakai jalur lama.

**iOS:** saat Play ditekan, sesi audio diatur ke `playback` (Safari 16.4+), jadi suara pratinjau tetap keluar walau perangkat dalam mode senyap.

### Bug lama yang ikut ditemukan

- Saat decode dimulai dari frame pertama file, frame priming AAC punya waktu negatif (−21 ms), dan Chromium melabelinya 0. Akibatnya suara dari awal file terlambat 21 ms.
- Di pratinjau baru ini muncul sebagai klik di sambungan blok. Di **ekspor cepat**, ini terjadi sejak v1.6: suara bagian awal file terlambat 21 ms.
- Diperbaiki di `decodeAudioRange` (`public/js/fastexport.js`).

### Bukti

Lab: B8 (fixture bip tepat di setiap detik sumber, detektor AudioWorklet di master mixer), profil iPad. Hasilnya di `bench/results/2026-11-14-av-old-ipad.*` dan `2026-11-14-v173-ipad.*`.

| | v1.7.2 (suara elemen) | v1.7.3 (terjadwal) |
|---|---|---|
| 16 potongan: suara terdengar di belakang gambar (p50) | **70 ms** | **8 ms** |
| 16 potongan: sebaran selisih | 36 ms | 16 ms |
| Musik di track terpisah: suara di belakang gambar (p50) | **55 ms** | **8 ms** |
| Bip hilang / bunyi ekstra | 0 / 0 | 0 / 0 |
| Gambar di belakang suara, dari frame yang tampil (p50 / p95) | — | 7 / 44–57 ms (p95 = sesaat setelah potongan) |

- Chromium tidak punya bug Safari di atas. Di iPad, jalur lama kemungkinan jauh lebih buruk daripada angka lab ini.
- Kelancaran tidak turun:
  - B1: 29 fps, 0 buffer, ekspor cepat tetap berhasil;
  - B6 (48 potongan): 29,7 fps, 0 buffer, 0 seek koreksi;
  - B7: file asli berat memakai jam lama; salinan ringan berjalan 99%.

`test/e2e/audio.mjs` merekam keluaran mixer:
- sambungan blok tanpa klik (lompatan sampel 0,031, nada murni 0,029; sebelum perbaikan priming 0,358);
- tanpa celah;
- volume yang diubah saat diputar berlaku tanpa memulai ulang suara;
- track bisu benar-benar diam;
- klip 2× memakai suara elemen;
- browser tanpa konversi format sampel tetap bekerja;
- mode lama masih bisa dipakai.

### Cara cek di iPad

1. Jalankan installer, lalu tutup dan buka lagi tab editor.
2. Putar proyek yang tadi ±15 dtk.
3. Buka menu ⋯ → **Diagnostik performa**, bagian **Audio**. Yang diharapkan:
   - Mode: **terjadwal di jam audio**;
   - "Gambar tertinggal dari suara" p50 di bawah ±20 ms;
   - "Suara kosong" dan "terlambat" 0;
   - "pakai elemen" 0. Kalau bukan 0, ada file yang tidak bisa di-decode di perangkat itu, dan barisnya menunjukkan berapa.

## 10. "Audio sudah tidak delay, tapi hilang setelah beberapa detik" (v1.7.4)

### Rekaman iPad

Rekaman layar iPad, 17,9 detik dengan suara, diukur per 0,25 detik:

| Waktu rekaman | Playhead | Suara |
|---|---|---|
| 1,0 dtk | 00:00 (Play ditekan) | mulai, tanpa delay |
| 1,0–9,3 dtk | 00:00 → 00:08 | terdengar penuh (−1 s.d. −5 dB) |
| ±9,4 dtk | ±00:08 | berhenti; sesudahnya hening total (nol digital) |
| 9,5–14 dtk | 00:08 → 00:14 | video tetap berjalan normal, ikon speaker di tab Safari hilang |

Suara berhenti tepat setelah **8 detik pertama sumber**, yaitu persis satu blok decode (`BLOCK = 8`). Gambar tetap jalan. Artinya penjadwal hanya berhasil memutar blok pertama: decode dari awal file berhasil di Safari, decode yang dimulai di tengah file tidak.

### Kemungkinan penyebab

Di lab (Chromium) semua blok berjalan, jadi ini perilaku `AudioDecoder` Safari 26. API ini baru ada di Safari sejak versi itu. Ada empat kemungkinan, dan v1.7.3 tidak tahan terhadap satu pun:

1. **Label waktu output berbeda**, misalnya dihitung dari `configure()` dan bukan waktu file. Posisi blok ke-2 jadi salah, sehingga potongannya terlewati.
2. **Decode berhasil, tapi hasilnya hening** untuk blok di tengah file.
3. **Decoder error.** v1.7.3 lalu memindahkan klip ke suara elemen video dengan menyalakan suara elemen yang sudah diputar. Di iOS, cara ini tidak bersuara.
4. **Decoder menggantung**, `flush()` tidak pernah selesai. Antrean decode v1.7.3 menunggu selamanya, sehingga tidak ada blok lain yang pernah di-decode.

### Perbaikan v1.7.4: setiap kemungkinan ditangani

- **Posisi blok dihitung dari jumlah sampel**, mundur dari frame terakhir yang dimasukkan, bukan dari label waktu decoder. Di Chromium hasilnya sama persis dengan label waktu untuk blok di tengah file, dan lebih benar untuk blok pertama.
- **Batas waktu decode** 2,5 dtk per blok. `flush()` dipacu dengan batas waktu, dan decoder yang menggantung ditutup. Antrean decode tidak bisa macet lagi: `reset()` membuka antrean yang tersangkut.
- **Cek hening:** waveform dari server (100 titik/dtk) dibandingkan dengan hasil decode. Hening total di bagian yang ada suaranya dianggap gagal.
- **Rantai fallback per file:**
  - blok gagal → **decode file utuh** dengan `decodeAudioData` (decoder bawaan Safari, file ≤ 150 dtk);
  - masih gagal → **suara elemen**.
  - Peralihannya tanpa suara dobel: potongan lama diserahkan di titik yang sama, dengan fade beberapa ms.
- **Suara elemen di tengah putar:** elemen video **dibuat ulang** dengan suaranya, seperti v1.7.2. Tidak lagi dengan menyalakan suara elemen yang sudah diputar, karena di iOS itu tetap bisu.
- **AudioContext berhenti** (iOS: telepon atau interupsi):
  - pemutaran lanjut dengan jam biasa;
  - elemen dibuat ulang langsung ke speaker. Elemen yang tersalur ke context yang berhenti ikut macet, dan gambarnya ikut berhenti;
  - setelah context jalan lagi, elemen kembali lewat mixer, supaya ekspor real-time tetap merekam suaranya.
- **Error di penjadwal tidak boleh menghentikan gambar:** jam pindah ke jam biasa.
- **Diagnostik → Audio** kini menampilkan:
  - **Masalah terakhir**, misalnya `decode_block: audio decoder did not finish within 2500 ms`;
  - jumlah peralihan ke decode utuh, ke suara elemen, dan elemen yang dibuat ulang.
  - Screenshot dari iPad akan menunjukkan kemungkinan mana yang terjadi.
- Suara di posisi playhead mulai di-decode saat proyek dibuka, jadi Play pertama tidak menunggu.

### Bukti (lab, simulasi perilaku Safari)

`test/e2e/audio.mjs` membungkus `AudioDecoder` supaya berperilaku buruk untuk blok di tengah file, lalu merekam keluaran mixer 6 detik yang melewati batas blok:

| Simulasi | Suara sampai akhir | Celah | Level (harapan 0,354) | Jalur akhir / alasan tercatat |
|---|---|---|---|---|
| label waktu dari 0 | 5,6 dari 6 dtk | 0 | 0,353 | blok (posisi dari hitungan sampel) |
| decode hening | 5,6 dtk | 0 | 0,353 | decode utuh — "decoded silence where the waveform has sound" |
| decoder menggantung | 5,6 dtk | 0 | 0,353 | decode utuh — "did not finish within 2500 ms" |
| decoder error | 5,6 dtk | 0 | 0,353 | decode utuh — "Decoding error" |
| semua decoder gagal | 5,6 dtk | — | 0,354 | suara elemen — "Unable to decode audio data" |
| AudioContext berhenti | jam biasa, video jalan | — | — | elemen langsung ke speaker |

(5,6 dari 6 dtk: 0,4 dtk sisanya adalah jeda mulai, yang dipotong oleh analisis.)

v1.7.3 gagal di simulasi "menggantung": suara berhenti di batas blok, dan semua decode sesudahnya ikut mati. Pola ini sama dengan yang terlihat di rekaman iPad.

Benchmark B8 (profil iPad, `bench/results/2026-11-14-v174-ipad.*`):
- suara di belakang gambar 6 ms (potongan) dan 3 ms (musik);
- sebaran 9 dan 4 ms (v1.7.3: 16 dan 11 ms), karena posisi blok kini seragam;
- B6: 30 fps, 0 buffer.

### Cara cek

1. Deploy, lalu tutup dan buka lagi tab editor.
2. Putar proyek yang sama lebih dari 15 detik. Suara harus terdengar sampai akhir.
3. Buka **Diagnostik performa → Audio** dan kirim screenshot-nya. Kalau "pindah ke decode utuh" > 0, berarti `AudioDecoder` Safari memang bermasalah di blok tengah file, dan baris "Masalah terakhir" menunjukkan jenisnya. Suara tetap jalan lewat decode utuh.

## 11. Ekspor tidak bisa diputar, video hasil render beku, preview patah-patah lagi, ekspor lama (v1.8.1)

### 11.1 "Video hasil ekspor tidak bisa diputar di Android/PC"

File ekspor dari iPad diperiksa dengan ffprobe: track audionya terbaca sebagai *"Audio object type 0, 22050 Hz, 0 channels"*. Android, PC, dan WhatsApp menolak file seperti itu ("format tidak biasa").

**Penyebab.** `AudioEncoder` Safari memberikan `decoderConfig.description` berupa **ES_Descriptor utuh** (38 byte, diawali `03 80 80 80 22`). Chrome memberikan **AudioSpecificConfig** (2 byte, `11 90` = AAC-LC 48 kHz stereo). Muxer Najja menulis isi itu apa adanya ke kotak `esds` sebagai AudioSpecificConfig, jadi di iPad konfigurasinya rusak.

**Perbaikan (`public/js/aac.js`).**
- AudioSpecificConfig diambil dari dalam ES_Descriptor (tag 3 → 4 → 5).
- Konfigurasi mentah dari Chrome dipakai apa adanya.
- Kalau deskripsinya kosong atau rusak, konfigurasi dibuat dari sample rate dan jumlah channel.

**Bukti (`test/aac.test.js`, `test/export-read.test.js`).**
- Byte asli dari file pengguna menghasilkan `11 90`.
- MP4 yang ditulis dengan deskripsi gaya Safari:
  - terbaca oleh ffprobe sebagai AAC-LC stereo 48 kHz;
  - ffmpeg men-decode seluruh file tanpa error;
  - suaranya sama persis dengan sumbernya (selain 1024 sampel priming encoder).

### 11.2 "Hasil render tidak playable; yang smooth hanya efek dan teks"

Di file ekspor pengguna, **91% frame video sama dengan frame sebelumnya**, sementara teks dan efek tetap bergerak. Artinya pembaca frame ekspor (`VideoSource`) terus mengembalikan gambar lama.

**Penyebab.** `VideoSource` menganggap decoder mengeluarkan frame segera dan berurutan waktu tampil. `VideoDecoder` Safari tidak selalu begitu:
- stream dengan B-frame keluar menurut urutan decode;
- frame ditahan sampai ada input berikutnya atau sampai flush.

Lihat laporan WebKit [263901](https://bugs.webkit.org/show_bug.cgi?id=263901), [268987](https://bugs.webkit.org/show_bug.cgi?id=268987), [287516](https://bugs.webkit.org/show_bug.cgi?id=287516). Frame "dari masa depan" di depan antrean membuat kode lama menganggap frame yang diminta belum ada, lalu memakai gambar sebelumnya. Kode lama juga tidur 40 ms setiap kali frame belum keluar.

**Perbaikan (`public/js/fastexport.js`).**
- Frame hasil decode disimpan **terurut menurut waktu tampil**.
- Frame untuk waktu t baru dipakai setelah **semua sampel yang tampil sebelum/pada t sudah keluar** dari decoder. Yang dilacak: sampel yang sudah dimasukkan, dan minimum waktu tampil dari sampel yang belum dimasukkan.
- Sampai 10 sampel dimasukkan di depan. Kalau decoder tetap diam, jendelanya diperbesar sampai 48.
- Decoder yang menahan frame sampai flush akan di-flush, lalu diisi ulang dari keyframe sebelumnya. Frame yang keluar dua kali dibuang. Setelah itu decoder di-flush di setiap keyframe.
- Tidak ada lagi tidur 40 ms: loop dibangunkan begitu ada frame keluar.
- Frame yang terlambat atau hilang dihitung. Kalau lebih dari 2%, ekspor **tidak menyimpan video patah-patah**. Ekspor pindah ke mode real-time, dan keputusan ini sudah diambil setelah ±3 detik, tidak menunggu render selesai.
- Diagnostik → Ekspor terakhir menampilkan:
  - *Frame video dari decoder* (terlambat, hilang, flush, ulang, jendela);
  - *Audio AAC* (sumber konfigurasinya).

**Server (`lib/media-proxy.js`).** Salinan kualitas penuh dan salinan ringan yang baru dibuat **tanpa B-frame** (`-bf 0`). Setiap frame keluar dari decoder begitu masuk dan selalu berurutan. Salinan lama tidak dibuat ulang; `VideoSource` yang baru menangani keduanya.

**Bukti (`test/e2e/export.mjs`).** Encoder dan decoder Chromium dibungkus supaya berperilaku seperti Safari, lalu hasil ekspornya diperiksa dengan ffprobe/ffmpeg. Setiap frame dibandingkan dengan gambar sumbernya pada waktu yang sama.

| Skenario decoder | v1.8.0 | v1.8.1 |
|---|---|---|
| Chromium apa adanya | 179/180 frame tepat | 180/180 |
| Gaya Safari (tidak urut + ditahan) | **30/180 tepat, 56% frame berulang** | 180/180, 0% berulang |
| Menahan semua frame sampai flush | **16/180 tepat, 98% berulang** | 180/180, 0% berulang (6 flush, 1 isi ulang) |
| Menghilangkan 1 dari 10 frame | file patah-patah tetap disimpan | pindah ke real-time ("18 lost of 91") |

### 11.3 "Timeline preview patah-patah lagi"

Rekaman/screenshot preview tidak ikut terkirim, jadi analisa ini memakai lab (profil iPad, CPU 4× lebih lambat), lalu dibandingkan dengan suara elemen seperti sebelum v1.7.3.

**Mekanisme 1: koreksi kecepatan video terlalu sering.**
- Sejak v1.7.3, video bisu mengikuti jam suara. Selisih kecil dikoreksi dengan `playbackRate`.
- Ambangnya 6/15 ms dan diperiksa setiap tick, dengan langkah sampai ±20%.
- Setiap perubahan kecepatan membuat decoder membuang frame. Di iOS, perubahan itu juga mengatur ulang waktu player.

| Lab, 15 dtk | Suara elemen (v1.7.2) | Jam audio v1.8.0 | Jam audio v1.8.1 |
|---|---|---|---|
| Ganti kecepatan video | 0 | 12× | 2–3× |
| Frame video dibuang | 0% | 2,3% | 0–2,3% |
| Jeda frame > 25 ms | 55–95 | 127 | 54–77 |
| Gambar di belakang suara p50 / p95 | — | -2 / 53 ms | 9–11 / 41–55 ms |

Perbaikan v1.8.1 (`engine.js`):
- Koreksi baru dimulai di atas **40 ms**, karena selisih bibir–suara baru terasa sekitar ±45 ms.
- Koreksi berhenti di bawah 12 ms atau kalau sudah lewat sasaran.
- Langkahnya ±3/6/12%, dan kecepatan berubah paling sering **sekali per detik**.

**Mekanisme 2: decoder yang lebih lambat dari real-time.**
- Sebelum v1.7.3, jam pratinjau menunggu gambar (`VIDEO_LEAD`, v1.7.1). Itu yang dulu membuat iPad smooth untuk file berat.
- Dengan jam audio, suara tidak menunggu. Video yang tertinggal di-seek, dan seek di Safari menunggu keyframe. Polanya jadi tertinggal → seek → macet → tertinggal lagi.
- Sekarang, kalau video utama tertinggal ≥ 0,45 dtk **dua kali dalam 10 dtk**, file itu diputar dengan jam yang menunggu gambar selama sesi itu. Diagnostik → Audio menampilkan "video lebih lambat dari real-time → jam video" serta jumlah koreksi kecepatan dan seek koreksi.

**Batasan.** Lab memakai Chromium. Penyebab yang khusus iPad hanya terlihat dari Diagnostik iPad (Audio + Pemutaran) sesudah update.

### 11.4 "Ekspor lama"

Lab B1 (60 dtk, 9 klip, filter vivid, 1080p, desktop): 1,55× real-time, sama dengan v1.8.0 (1,62×). Komposit makan ±80% waktu karena canvas di lab dirender perangkat lunak; di iPad, canvas memakai GPU.

Yang membuat ekspor di iPad lebih lama, dan sudah diperbaiki:
- Kode lama tidur 40 ms setiap kali decoder Safari belum memberi frame. Ini menahan render di bawah ±25 frame/dtk, bahkan sebelum komposit dan encode.
- Antrean encoder dicek dengan timer 1 ms, yang di Safari minimal 4 ms. Sekarang loop dibangunkan oleh event `dequeue` encoder.
- Ekspor yang decoder-nya rusak dulu baru jatuh ke real-time setelah render penuh, jadi waktunya terpakai dua kali. Sekarang keputusan itu diambil setelah ±3 detik.

Yang masih bisa lama, dan terlihat di Diagnostik → Ekspor terakhir:
- *Siapkan media*: file yang tidak bisa dibaca browser (misalnya HEVC iPhone) menunggu salinan kualitas penuh dari server dan mengunduhnya ke iPad;
- *Komposit/Encode* per detik video.

### Cara cek

1. Deploy, lalu tutup dan buka lagi tab editor.
2. Ekspor ulang proyek yang sama. File lama tetap rusak, karena audio dan videonya sudah tertulis salah.
3. Kirim file hasilnya ke Android/WhatsApp; harus bisa diputar.
4. Buka **Diagnostik performa → Ekspor terakhir**:
   - "Frame video dari decoder" harus menunjukkan terlambat/hilang 0;
   - "Audio AAC" harus "… · ES_Descriptor (Safari) → ASC".
5. Putar preview ±15 dtk, lalu kirim screenshot **Diagnostik → Pemutaran** dan **Audio**: koreksi kecepatan video, seek koreksi, frame dibuang.
