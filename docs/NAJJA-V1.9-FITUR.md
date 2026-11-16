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

## 9. Klik klip → playhead pindah ke klip

Mengetuk atau mengklik klip memindahkan playhead dan timeline ke awal klip itu, kecuali playhead sudah berada di dalam klip tersebut.

## 10. Duplikat di samping aslinya

- **Track utama**: duplikat langsung setelah klip asli. Kalau magnet mati, klip sesudahnya bergeser.
- **Track lain**: kalau tempat tepat setelah klip asli terisi, duplikat diletakkan di track di atasnya pada waktu yang sama.

Sebelumnya duplikat sering jatuh di akhir track.

## 11. Lapisan

Untuk klip overlay, teks, dan stiker: **Paling depan**, **Maju**, **Mundur**, **Paling belakang**, dihitung di antara klip yang tumpang tindih. Klip tidak pernah turun ke bawah track utama.

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
