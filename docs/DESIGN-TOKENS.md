# Design tokens — Najja Creative Studio (DESIGN.md §4)

Nama semantik `--najja-*` untuk nilai yang **sudah dipakai** app (diambil dari `public/css/app.css` dan
`public/css/design.css`, 2026-11-23). Token didefinisikan sebagai alias (`var(--…)`), sehingga ikut tema terang di
editor dan tidak mengubah tampilan apa pun. Belum ada aturan CSS yang memakainya; komponen baru atau yang dirapikan
memakai token ini, bukan warna langsung. Dijaga oleh `test/design-tokens.test.js`.

| Token | Editor video (gelap) | Najja Desain (terang) |
|---|---|---|
| `--najja-app-bg` | `--bg` `#0f0f11` | `--bg` `#eceef2` |
| `--najja-panel-bg` | `--panel` `#18181b` | `--panel` `#ffffff` |
| `--najja-panel-raised` | `--panel-2` `#1f1f23` | `--panel` `#ffffff` (Desain tidak punya tingkat panel kedua) |
| `--najja-canvas-bg` | `--stage` `#0f0f11` | `--bg` `#eceef2` (`.ds-stage` tidak punya latar sendiri) |
| `--najja-text-primary` | `--text` `#f2f2f5` | `--ink` `#1b2430` |
| `--najja-text-secondary` | `--text-2` `#b8b8c2` | `--ink2` `#5b6676` |
| `--najja-border` | `--border` `#26262b` | `--line` `#e2e5ea` |
| `--najja-accent` | `--accent` `#47c9d7` | `--acc` `#129aa9` |
| `--najja-success` | `--ok` `#2ed47a` | `--acc2` `#0d7f8c` (warna toast sukses) |
| `--najja-warning` | `--warn` `#ffb020` | `#ffb020` (Desain belum punya peringatan; memakai nilai editor) |
| `--najja-danger` | `--danger` `#ff4d6d` | `--danger` `#e5484d` |

Dicek di browser: nilai token yang terbaca sama dengan tabel di atas (editor), dan latar halaman tidak berubah.

**Belum (DESIGN.md):**
- §2 screenshot baseline desktop dan iPad.
- Tipografi, radius, dan spacing sebagai token. Nilainya sudah dicatat di `AUDIT_REPORT.md` §3.4.
- Memakai token di komponen yang dirapikan.
