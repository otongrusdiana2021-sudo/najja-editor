# Najja v1.9: fitur baru

## 1. Volume: Kurangi kebisingan & Sempurnakan suara

Lokasi: Volume → bagian **Suara** (untuk klip video dan audio).

**Kurangi kebisingan** memakai *spectral gating*:
- Dasar bising tiap frekuensi diukur dari jeda di antara kata.
- Bagian yang berupa bising diturunkan. Gain diperhalus agar tidak "berdesir".
- Yang hilang: desis, dengung, kipas/AC, dan bising jalan yang terus-menerus.
- Uji (`test/e2e/features.mjs` K): desis di jeda turun **−38 → −53 dB**, sementara suara orang tetap (−20,4 → −20,6 dB).

**Sempurnakan suara** adalah rantai vokal:
- high-pass 80 Hz (24 dB/oktaf);
- −2,5 dB di 250 Hz;
- +3,5 dB di 3,2 kHz dan +2 dB di atas 9 kHz;
- kompresor 3:1;
- volume diratakan ke ±−18 dBFS, puncak tetap di bawah −1 dBFS.

Pemrosesannya (`voicedsp.js`) berjalan di *worker*, jadi pratinjau tidak tersendat. Hasilnya sama persis di pratinjau dan ekspor, karena suara yang sudah dibersihkan itulah yang dijadwalkan maupun di-mix. Kecepatannya ±150 ms per 4 detik audio mono.

Batasan: klip yang dipercepat/diperlambat dan file yang tidak bisa di-decode di perangkat memakai suara elemen. Suara itu tidak ikut dibersihkan.

## 2. Filter Crystal Clear & 4K

Ada di tab Filter, paling depan.
- **Crystal Clear**: sedikit lebih terang, kontras dan saturasi naik, ditambah penajaman.
- **4K**: penajaman kuat dua skala (*unsharp mask* 1 px dan 2 px), kontras naik.

Penajaman berjalan di GPU (`gpufx.js`).

## 3. Font Scholar, Abrason, Starry

Ada di grup **Populer**. Font aslinya berlisensi tertutup (pustaka CapCut dan Comicraft), jadi Najja memakai font terbuka SIL OFL dari Google Fonts dengan gaya yang sama:

| Nama di Najja | Font terbuka | Gaya |
|---|---|---|
| Scholar | Libre Baskerville | serif buku |
| Abrason | Bangers | huruf komik tebal |
| Starry | Patrick Hand | tulisan tangan santai |

Lewat MCP, kedua nama bisa dipakai, misalnya `font: "Scholar"`.

## 5. Sampul (thumbnail)

Lokasi: menu → **Sampul**. Ada dua cara:
- **Frame video**: geser untuk memilih frame. Sampul dirender seukuran proyek (1080×1920 untuk 9:16) dari **file kualitas penuh**, memakai decoder dan compositor ekspor, bukan gambar pratinjau 720p.
- **Dari galeri**: foto dipotong mengikuti rasio proyek. Foto yang lebih kecil dari ukuran proyek ditingkatkan ke HD dengan AI upscale di server.

Sampul disimpan sebagai gambar proyek dan tidak tampil di daftar media. Sampul lama dihapus saat diganti. Bisa disimpan ke Foto (menu Bagikan iPad). Secara bawaan sampul juga menjadi **frame pertama video ekspor**, supaya galeri dan media sosial memakainya sebagai gambar video; ini bisa dimatikan.

## 6. Pratinjau transisi & animasi yang akurat

Setiap kotak di tab Transisi dan Animasi memutar transisi atau animasi aslinya. Mesin render yang dipakai sama dengan pratinjau dan ekspor (`previews.js`), dengan dua gambar contoh. Untuk klip teks, yang ditampilkan adalah teksnya. Kotak hanya digambar saat terlihat, ±30 fps.

## 7. Favorit

Setiap item punya **☆** di tab efek, transisi, filter, template dan gaya teks, efek suara, font, dan animasi. Item favorit tampil paling depan di bagian "★ Favorit", dan disimpan di perangkat.

## 8 & 15. Hasilkan keterangan otomatis

Lokasi: Teks → Teks otomatis, atau Keterangan. Isinya:
- **Hasilkan dari**: Video, Pengisi suara (klip audio/rekaman suara), atau Semua audio.
- **Bahasa sumber**: deteksi otomatis atau salah satu dari 99 bahasa Whisper. Daftarnya bisa dicari, termasuk Jawa dan Sunda.
- **Template**: gaya subtitle.
- **Opsi lanjutan**: panjang baris, posisi, huruf kapital, dan pilihan mengganti subtitle lama.

Cara kerjanya:
1. Suara dari klip yang dipilih di-mix di posisinya pada timeline (16 kHz mono).
2. Server Najja menulis teksnya dengan **Whisper** (faster-whisper, MIT), lengkap dengan waktu tiap kata. Modelnya **small** di server dengan RAM AI ≥ 1,1 GB, **base** kalau kurang. Model diunduh sekali saat pertama dipakai, dikunci ke revisi dan sha256 tertentu.
3. Kata-kata disusun menjadi baris pendek yang dipotong di jeda dan akhir kalimat, tanpa tumpang tindih.

Tidak ada layanan berbayar atau pihak ketiga. Naskah atau file SRT masih bisa dipakai di bagian "Buat dari naskah atau file SRT".

### Subtitle tertaut (v1.9.1)

Semua baris di track Subtitle punya satu tampilan. Mengubah satu subtitle mengubah semuanya. Fitur ini menyala secara default, juga untuk proyek lama.

- **Yang ikut berubah:** skala (seret sudut atau cubit dua jari di pratinjau), posisi, rotasi, cermin, opasitas, ukuran huruf, font, tebal/miring, rata, warna, garis tepi, latar, bayangan, gradien, spasi, gaya, dan animasi masuk/keluar/loop.
- **Yang tetap milik tiap baris:** teks dan waktunya.
- **Hanya yang diubah yang disalin.** Kalau satu baris punya warna sendiri lalu ukurannya diubah, hanya ukurannya yang menyebar dan warnanya tetap.
- **Undo:** satu kali urung mengembalikan semua baris.
- **Sakelar "Terapkan ke semua subtitle"** ada di lembar Teks, Transformasi, Animasi, dan Campuran saat sebuah subtitle dipilih. Kotak yang sama ada di panel Keterangan. Kalau dimatikan, setiap subtitle diatur sendiri-sendiri.
- **"Samakan semua dengan subtitle ini"** muncul saat sakelar menyala tapi tampilan baris-barisnya berbeda.
- Teks biasa di luar track Subtitle tidak terpengaruh.

Cara kerjanya (`store.js`): setiap perubahan pada subtitle yang dipilih, baik saat menyeret (`store.live`) maupun saat disimpan (`store.mutate`), dibandingkan sebelum dan sesudahnya per properti. Properti yang berubah lalu disalin ke baris lain di track yang sama. Keyframe tiap baris tidak ikut disalin.

## 9. Klik klip → playhead pindah ke klip

Mengetuk atau mengklik klip memindahkan playhead dan timeline ke awal klip itu, kecuali playhead sudah berada di dalam klip tersebut.

## 10. Duplikat di samping aslinya

- **Track utama**: duplikat langsung setelah klip asli. Kalau magnet mati, klip sesudahnya bergeser.
- **Track lain**: kalau tempat tepat setelah klip asli terisi, duplikat diletakkan di track di atasnya pada waktu yang sama.

Sebelumnya duplikat sering jatuh di akhir track.

## 11. Lapisan

Untuk klip overlay, teks, dan stiker: **Paling depan**, **Maju**, **Mundur**, **Paling belakang**, dihitung di antara klip yang tumpang tindih. Klip tidak pernah turun ke bawah track utama.

### Lapisan untuk efek (v1.10.1)

Efek video, lapisan Filter, dan lapisan Sesuaikan sekarang juga punya tombol **Lapisan**.

- Sebuah efek hanya mengenai **lapisan di bawahnya**. Lapisan di atasnya tetap seperti aslinya. Contoh: efek Hitam Putih atau Kabur ditaruh di bawah teks, maka videonya kena efek tapi teks, stiker, atau logonya tetap berwarna dan tajam.
- Efek yang baru ditambahkan tetap masuk di lapisan **paling atas**, jadi mengenai semuanya seperti sebelumnya.
- Proyek lama tampil dan diekspor persis sama, karena efeknya memang selalu di lapisan paling atas.
- Efek tidak pernah turun ke bawah track utama.

### Efek langsung ke footage (v1.10.2)

Pilih klip video, foto, atau warna solid, lalu ketuk **Efek** di toolbar. Tersedia dua pilihan di **Terapkan ke**:

- **Klip ini** (default): efek menempel di footage itu.
  - Hanya klip itu yang kena. Teks, stiker, dan overlay lain tidak kena.
  - Efek ikut saat klip digeser, dipotong, dibagi, atau diduplikat.
  - Satu klip bisa punya sampai 4 efek, masing-masing dengan intensitas sendiri dan tombol hapus.
  - Klip di track utama punya tombol **Terapkan efek ini ke semua klip utama**.
  - Klip yang punya efek diberi badge ✦ di timeline.
- **Semua lapisan**: perilaku lama. Efek ditaruh di track efek selama klip itu dan mengenai semua lapisan di bawahnya.

Lewat MCP: `add_effect` dengan `clip_id` menempelkan efek ke klip itu, dan `update_clip` dengan `clip_effects` mengganti daftar efek klip (`[]` menghapus semuanya). `get_project` menampilkan `clip_effects` tiap klip.

Cara kerjanya: klip digambar sendirian di lapisan seukuran frame, lalu efeknya diterapkan di lapisan itu. Hasilnya dipotong sesuai bentuk klip, jadi kilat atau salju tidak meluber ke luar klip. Setelah itu lapisan ditempel ke frame dengan mode campuran klip. Prosesnya sama di pratinjau dan ekspor.

### Teks kinetik (v1.12)

Animasi teks ala motion graphics yang dibuat dengan kode: kata, huruf, atau baris bergerak sendiri-sendiri dengan gerak pegas (memantul lalu diam, seperti benda sungguhan). Semuanya digambar oleh mesin Najja sendiri, jadi teksnya tetap bisa diedit, pratinjau sama dengan hasil ekspor, dan jalan di iPad.

**Cara pakai:** pilih klip teks → **Animasi** → tab **Kinetik**. Tiap pilihan punya pratinjau kecil yang bergerak. Ketuk satu, klipnya langsung diputar dari awal.

| Kelompok | Animasi |
|---|---|
| **Masuk** (bergantian) | Pop per kata, Naik per kata, Hentak, Fokus per kata, Ayun per kata, Tirai per baris, Huruf meluncur, Huruf jatuh, Gelombang, Huruf berputar, Ketik + kursor, Acak huruf |
| **Penekanan** (sepanjang klip) | Sorot per kata (kata yang sedang aktif menyala dan membesar), Stabilo (blok warna menyapu di belakang baris), Angka berjalan (angka menghitung naik ke nilainya, misalnya harga) |
| **Terus-menerus** | Melambai, Glitch |

**Pengaturan:**
- **Gaya gerak:** Halus (tanpa memantul), Memantul, Tegas, Pelan.
- **Jeda antar kata/huruf/baris:** kalau klipnya terlalu pendek, jedanya dirapatkan otomatis supaya semua masuk.
- **Kecepatan** dan **Warna sorot** (untuk Sorot per kata dan Stabilo).
- **Keluar: Kebalikan:** di akhir klip potongan-potongannya keluar bergantian seperti saat masuk.

Bisa digabung dengan animasi Masuk/Keluar/Kombo klip yang sudah ada. Ganti gaya teks (preset) tidak menghapus animasi kinetiknya.

**Subtitle otomatis:** tiap baris menyimpan waktu kata-katanya. Dengan Pop per kata atau Sorot per kata, setiap kata bergerak atau menyala **tepat saat diucapkan**. Subtitle tertaut ikut berubah semua, tapi setiap baris tetap memakai waktu katanya sendiri. Kalau isi baris diedit sampai jumlah katanya berubah, kata-katanya dibagi rata sepanjang baris.

**Style Konsep memakainya:**
- **Story Pop:** subtitle menyala per kata, kata kunci pop per kata, harga menghitung naik.
- **Editorial Review:** harga menghitung naik, huruf merek meluncur masuk di akhir.
- **Showcase Clean:** nama varian naik per kata, harga akhir menghitung naik.

Sejak v1.12.4, tiap teks yang muncul di Style Konsep juga diberi SFX yang sesuai gerakannya (pop per kata, swipe, ketik, kaching saat harga selesai menghitung), dan teks otomatis dipindah ke latar kosong supaya tidak menutupi orangnya, baik wajah maupun badan (v1.12.5). Lihat [STYLE-KONSEP.md](STYLE-KONSEP.md).

**MCP:** `add_text`/`update_clip` dengan `text_motion` (+ `text_motion_spring`, `text_motion_stagger`, `text_motion_speed`, `text_motion_color`, `text_motion_out`). `add_subtitles` menerima `text_motion` dan `words` (waktu tiap kata dari `get_transcript`). `get_project` menampilkan `text_motion`.

**Cara kerjanya:** `public/js/kinetic.js` mengukur posisi tiap kata/huruf sekali per teks, lalu tiap frame menghitung posenya dari rumus pegas teredam (deterministik: waktu yang sama selalu menghasilkan gambar yang sama). `render.js` menggambar tiap potongan dengan gaya teks yang sama (bayangan, garis tepi, isi/gradien).

### Hapus latar otomatis (v1.11)

Mirip "Hapus latar otomatis" di CapCut: satu sakelar, latarnya hilang, dan **semua objek di depan tetap**: orang, produk, tas, koper, hewan. Tidak ada lagi pilihan mode "Orang saja" atau "Orang + objek" dan pilihan kualitas dari v1.10.3/v1.10.4.

**Cara pakai:** pilih klip video atau foto, ketuk **Hapus Latar Belakang**, lalu nyalakan **Hapus latar otomatis**.

- Klip dianalisis **sekali**. Progres per frame dan perkiraan sisa waktu tampil di lembar, dengan tombol **Batal**.
- Setelah selesai, lembar menampilkan **✓ Latar dihapus · N frame dianalisis**. Pratinjau dan ekspor langsung memakainya.
- **Ketelitian** dan **Tepi halus** bisa digeser kapan saja. Hasilnya langsung terlihat, tanpa analisis ulang.
- Kalau klip dipotong atau diperpanjang ke bagian video yang belum dianalisis, muncul tombol **Analisis ulang**.
- Klip duplikat atau klip lain dari video yang sama memakai hasil analisis yang sudah ada.
- **Klip di track utama:** latarnya diganti warna latar proyek. Tombol **Pindah ke Overlay** memindahkan klip supaya objeknya bisa ditaruh di atas video atau foto lain.
- **Kunci kroma** (layar hijau) tetap ada di lembar yang sama, tidak berubah.

**Mesinnya:** BiRefNet lite 512 (MIT), model hapus latar yang juga dipakai alat hapus latar foto di beranda. Model ini memisahkan objek utama dari latar, bukan khusus orang.

- **Di GPU perangkat (WebGPU, onnxruntime-web 1.29.0):** jalur utama, paling cepat. Dianalisis sampai 30 frame per detik (paling banyak ±450 frame per klip; klip panjang dianalisis lebih jarang, minimal 10 fps).
- **Di server (perangkat tanpa WebGPU, atau GPU-nya gagal memuat model):** sakelar yang sama otomatis memakai server Najja. Lebih lambat (sekitar 5 detik per frame per CPU), 8–15 fps, paling banyak ±240 frame. Lembar boleh ditutup atau ditinggal untuk mengedit.
- **Supaya halus:** tiap masker dicampur sedikit dengan frame sebelumnya (tepi tidak berkedip), dan di antara dua frame yang dianalisis, masker dicampur halus mengikuti waktu.
- **Model pertama kali:** ±190 MB, diunduh sekali per perangkat dari server Najja (bukan CDN) lalu disimpan di cache browser.
- **Ekspor** menunggu hasil analisis. Kalau belum ada, ekspor berhenti dengan pesan, jadi latar tidak muncul diam-diam di video hasil.

**Penyimpanan:** masker disimpan gzip di `<data>/masks/` (milik akun pembuatnya) dan disajikan di `/api/masks/<id>`, jadi perangkat lain dan ekspor memakai hasil yang sama.

- Dari perangkat: `POST /api/masks` (hanya untuk video milik akun itu yang sudah selesai diunggah; ukurannya dicek).
- Dari server: tugas `cutoutvideo` (`lib/ai.js` mengekstrak frame dengan ffmpeg, `ai/server.py` menjalankan BiRefNet).
- Di editor: `public/js/bgdevice.js` (analisis di GPU), `bgremove.js` (memilih mesin, progres, menyimpan), `segment.js` (memutar masker).

**Asal file:** onnxruntime-web dan modelnya tidak dimuat dari CDN. Server Najja mengambilnya sekali dari versi yang dikunci, mencocokkan sha256-nya, lalu menyajikannya di `/vendor/` (`lib/vendor.js`). Modelnya diambil dari folder model layanan AI kalau sudah ada, kalau belum diunduh dari sumbernya.

**Proyek lama:** klip dengan mode "Orang + objek" dari v1.10.4 tetap terpotong (hasil analisisnya masih dipakai). Klip dengan mode "Orang saja" dari v1.10.3 belum punya hasil analisis: lembarnya menampilkan **Analisis sekarang**.

**MCP:** `update_clip` dengan `remove_background: true/false` dan `remove_background_threshold` (0–1). `get_project` menampilkan `remove_background` dengan `ready`/`analysing`.

Cara kerja lapisan efek: render menggambar lapisan dari bawah ke atas (`plan.layers`). Saat bertemu efek, efek itu diterapkan ke gambar yang sudah tersusun sejauh itu. Lapisan sesudahnya digambar di atas hasilnya, sama di pratinjau maupun ekspor.

## 13. Efek suara

- Semua suara bawaan dinormalisasi ke puncak **−1 dBFS**. Sebelumnya −6 sampai −10 dB di bawah kompresor.
- Ada 12 suara dasar baru: jepret kamera, lonceng, ta-da, berhasil, salah, boing, gelembung, kaching, ketik, detak jantung, drum roll, glitch.

Semuanya dibuat di editor tanpa audio pihak ketiga. Proyek lama otomatis memakai versi baru.

## 14. Efek Hitam Putih & Kabur

**Penyebab:** di Safari (iPad), filter canvas (`ctx.filter`) belum didukung, dan pada canvas di luar halaman nilainya tetap "none" (WebKit [198416](https://bugs.webkit.org/show_bug.cgi?id=198416), [276135](https://bugs.webkit.org/show_bug.cgi?id=276135)). Akibatnya efek Hitam Putih, Kabur, Pelangi, dan Mimpi, semua preset filter, serta Sesuaikan tidak berpengaruh di iPad.

**Perbaikan:** `gpufx.js` menjalankan fungsi filter yang sama di WebGL:
- matriks warna sesuai spesifikasi Filter Effects;
- blur Gaussian, dengan radius besar diproses di resolusi lebih kecil;
- hasil warnanya sama dengan filter asli browser, selisih 1–3 level.

Kabur juga dibuat lebih kuat (1–4% sisi pendek), dan tepi frame tidak lagi menggelap.
