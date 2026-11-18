# Style Konsep (v1.10)

Style Konsep menyusun edit lengkap video produk dalam salah satu dari tiga konsep. Ketiganya diambil dari analisis tiga video sampel (lihat dokumen *Analisa Konsep Editing — 3 Style Najja*).

| Konsep | Bahan | Ciri khas |
|---|---|---|
| **Showcase Clean** | Klip produk, boleh tanpa suara | Satu bagian per varian (±4,5 dtk), zoom punch dengan motion blur, nama produk Roboto Italic, baris varian Poppins 800 dengan bayangan keras, garis ukuran "← 28 cm →", penutup berisi semua varian dan harga, warna Cerah Hangat, musik saja |
| **Editorial Review** | Video kamu ngomong | Jeda dan kata pengisi dipotong, punch-in bergantian, judul Instrument Serif, kata kunci Anton krem (#F8F8A8) menumpuk kata per kata saat diucapkan, harga lama dicoret + kartu harga krem + "!!", cahaya bocor, piksel saat keluar dari harga, sisipan klip produk, subtitle kecil italic huruf kecil, outro "bye" + merek diketik di atas gambar blur, warna Matte Hangat, musik pelan (−13 dB) |
| **Story Pop** | Video kamu ngomong + B-roll | Hook kata per kata kiri-kanan, kata terakhir merapat, 🤔 kalau berupa pertanyaan; kata kunci Inter 800 yang meletup + stiker emoji; B-roll per kalimat (tanpa B-roll: punch-in dekat); "turun HARGA!!" huruf per huruf, harga coret + label merah; sting merek di tengah; subtitle tebal; warna Natural Bersih |

## Cara pakai di Najja

1. Impor bahan ke proyek, misalnya video kamu ngomong, klip produk, dan foto.
2. Ketuk **Style** di toolbar. Muncul 3 kartu konsep:
   - **✓ Cocok / ⚠ Bisa, ada catatan / ✗ Bahan kurang** menunjukkan kecocokan dengan bahan.
   - Satu kartu diberi label **Disarankan**: Story Pop kalau ada suara dan ≥ 3 klip lain, Editorial kalau ada suara, Showcase kalau tidak ada suara.
3. Kalau bahan belum diperiksa, ketuk **Periksa bahan**. Suara tiap video ditranskrip dengan Whisper di server Najja. Ini dilakukan sekali per video, dan hasilnya disimpan di proyek.
4. Isi info produk: nama, varian, ukuran, keterangan, harga normal, harga diskon, merek.
5. Ketuk **Generate**. Hasilnya **proyek baru** bernama "‹proyek› · ‹konsep›", dan proyek asli tidak diubah. Centang **Buat ketiganya** untuk membuat 3 proyek sekaligus. Yang disarankan langsung dibuka, yang lain ada di Beranda.
6. Hasilnya bisa diedit seperti biasa. Satu kali **Urung** mengembalikan seluruh edit style.

## Hasil selalu lengkap (v1.12.4)

Tiap konsep, dari tombol **Generate** maupun dari prompt ke Claude, langsung menghasilkan:

- **subtitle dari transkrip** (Editorial dan Story Pop) dengan teks kinetik yang bergerak saat katanya diucapkan;
- **teks kinetik** untuk judul, kata kunci, harga (Angka berjalan), dan hook;
- **SFX di tiap teks dan gerakan**, di track audio **SFX** tersendiri (track kedua/ketiga hanya dipakai kalau suara panjang masih berbunyi);
- **teks tidak menutupi wajah.**

### Teks tidak menutupi wajah

1. Sebelum menyusun edit, Najja mencari wajah di tiap video dan foto bahan, kira-kira 2 kali per detik. Detektornya UltraFace RFB-320 (Apache-2.0, 1,3 MB) yang berjalan **di perangkat** lewat onnxruntime-web WebAssembly, jadi tidak butuh GPU. Model diambil dari server Najja (`/vendor/ultraface-320/`). Hasilnya disimpan di proyek (`media.faces`), jadi tiap video cukup diperiksa sekali. Style kedua dan seterusnya langsung memakai data itu.
2. Setelah edit tersusun, tiap teks dan stiker dicek terhadap posisi wajah sepanjang waktu tampilnya. Ukuran teks diukur dengan font aslinya, dan punch-in, posisi, serta cermin klip ikut dihitung.
3. Teks yang tampil bersamaan dan berdekatan (judul + nama varian, harga coret + harga) dipindah sebagai satu kelompok, jadi tata letaknya tetap. Kelompok yang kena wajah dipindah ke tempat kosong terdekat di atas atau bawah wajah. Kalau ruangnya kurang, ukurannya diperkecil (sampai 50%). Kalau masih tidak muat, teks-teks di momen itu dipindah sebagai satu blok, lalu dicoba ke samping wajah. Subtitle lebih dulu dicoba ke bawah wajah. Teks lain tidak masuk ke 20% bawah layar, tempat tombol dan caption aplikasi.
4. Teks tidak pernah dipindah ke atas teks lain yang tampil bersamaan.
5. Kalau perangkat tidak bisa memuat model, edit tetap dibuat. Posisi wajah di video ngomong ditebak (kepala dan bahu di tengah atas), dan hasilnya memberi tahu hal itu.
6. Untuk close-up ekstrem (wajah memenuhi layar), teks ditaruh di tempat yang paling sedikit menutupi wajah.

Ringkasan `apply_style` berisi `faces: { checked, moved, scaled, partly, left }` dan `sfx` (jumlah efek suara).

### SFX di tiap teks dan gerakan

| Kejadian | Suara |
|---|---|
| Kata muncul per kata (Pop, Hentak, Naik, Ayun, Fokus) | pop / swipe / whoosh per kata (maks. 4 per teks), tepat saat kata diucapkan kalau ada waktu ucapannya |
| Huruf meluncur, Tirai, Stabilo | swipe |
| Ketik + kursor, animasi Mesin tik | typing |
| Acak huruf, Glitch | glitch |
| Angka berjalan (harga) | pop saat muncul, **kaching** saat angkanya selesai |
| Stiker emoji / label | bubble / ding |
| Transisi Zoom Punch / Cahaya Bocor / Kabur / Piksel | swipe / whoosh / whoosh / glitch, mulai sedikit sebelum potongan |
| B-roll muncul di atas video ngomong | swipe pelan |
| Tiap baris subtitle | klik pelan |

Dua suara yang jatuh di waktu yang sama tidak ditumpuk (yang lebih kuat dipakai). Teks yang muncul tanpa gerak memakai suara yang lebih pelan. Volume dibuat di bawah suara orang ngomong (0,2–0,6). Suaranya memakai SFX bawaan editor, dibuat di browser, jadi tanpa aset luar.

Pilihan `plan.sfx`: `full` (bawaan), `graphics` (tanpa klik subtitle), atau `none` (tanpa SFX).

## Cara pakai lewat Claude (MCP)

Di Claude, ketik `/najja-editorial`, `/najja-showcase`, `/najja-storypop`, atau `/najja-semua-style`. Bisa juga dengan kalimat biasa, misalnya "edit video ini pakai Editorial Review, harga 189 ribu diskon 149 ribu".

Alat MCP yang dipakai:

| Alat | Isi |
|---|---|
| `list_styles` | Ketiga konsep, kecocokan bahan, dan saran |
| `get_transcript` | Kata dan waktunya (transkrip dibuat dulu kalau belum ada) |
| `apply_style` | Membuat edit. Pilihan AI dikirim lewat `plan` |

Di sini AI berperan sebagai sutradara, dan mesin style yang mengerjakan teknisnya. Pilihan AI dikirim sebagai `plan`:

```json
{
  "keywords": [{ "start": 12.4, "words": ["SEHARGA", "TIKET", "BIOSKOP"] }],
  "price": { "start": 11.2, "normal": "189rb", "discount": "149rb" },
  "cuts": [{ "start": 30.1, "end": 33.0 }],
  "broll": [{ "start": 5.0, "duration": 2, "media_id": "m_..." }],
  "hook": { "words": ["butuh", "lebih", "dari", "satu", "size"], "question": true }
}
```

Waktunya memakai "waktu ucapan": semua video ngomong disambung berurutan, sebelum ada yang dipotong (sama dengan hasil `get_transcript`). Bagian yang tidak diisi dipilih otomatis. Tanpa Claude pun fitur ini tetap jalan, dengan pilihan otomatis:
- kata terkuat per kalimat (angka, kata produk, kata penekanan);
- momen harga disebut;
- jeda lebih dari 0,5 dtk dipotong.

## Yang ditambahkan (tidak mengubah yang lama)

- **Transisi baru:** Zoom Punch, Cahaya Bocor, Piksel.
- **Animasi teks baru:** Merapat.
- **Gaya teks baru:** coret (`text.strike`).
- **Filter baru:** Cerah Hangat, Matte Hangat, Natural Bersih.
- **Data proyek baru:**
  - `speech`: transkrip per video;
  - `media[].faces`: posisi wajah per video/foto (v1.12.4);
  - `style`: konsep dan info produk hasil edit;
  - `styleSource`: proyek asal;
  - `styleProduct`: isi form terakhir.

Semua efek, transisi, animasi, dan alat MCP yang sudah ada tetap sama. Proyek lama terbuka dan diekspor persis seperti sebelumnya.

## Kode

| File | Isi |
|---|---|
| `public/js/styles.js` | Mesin (tanpa browser, diuji di Node): kecocokan bahan, rencana otomatis, peta potongan, ketiga konsep |
| `public/js/stylerun.js` | Transkripsi bahan, cari wajah, salinan proyek, musik, SFX, satu langkah undo |
| `public/js/stylefx.js` | (v1.12.4) Teks menghindari wajah dan SFX per teks/transisi (tanpa browser, diuji di Node) |
| `public/js/faces.js` | (v1.12.4) Deteksi wajah di perangkat (UltraFace RFB-320, onnxruntime-web WebAssembly) |
| `public/js/stylepanel.js` | Lembar Style |
| `public/js/api.js`, `mcp/tools.js`, `mcp/protocol.js` | Alat dan prompt MCP |
| `test/styles.test.js`, `test/stylefx.test.js`, `test/e2e/styles.mjs`, `test/e2e/stylefx.mjs` | Tes |

## Batasan

- Garis ukuran dibuat dari teks (panah + ukuran). Logo yang digambar dan tepi teks kasar (grunge) dari sampel belum ada.
- Orang yang dipotong dari latar di atas grid (sampel 2 dan 3) belum ada. Sebagai gantinya ada sisipan klip produk atau punch-in.
- Wajah dicari kira-kira 2 kali per detik. Gerakan kepala yang sangat cepat di antara dua titik bisa sedikit tersentuh teks (ada ruang ±12–18% di sekitar wajah). Pencarian pertama butuh beberapa detik per menit video (±18 dtk untuk video 50 dtk di laptop tanpa GPU).
- Pemilihan B-roll otomatis bergantian per kalimat. Pemilihan B-roll yang sesuai isi kalimat dilakukan oleh AI lewat `plan.broll`.
