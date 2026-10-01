# Struktur Tim dan Spesialisasi — Core Platform

**Project:** Core Platform (kode: `CORE`)
**Klasifikasi:** Dokumen Acuan Baku (Canonical)

Dokumen ini menjadi rujukan mesin ketika sistem menentukan pengalokasian
penugasan. Nama di bawah ini harus cocok dengan data pengguna di sistem.

## Divisi Teknikal

| Nama | Peran | Spesialisasi |
|---|---|---|
| Budi Santoso | Senior Backend Engineer | Payment service, core-gateway, Java/Kotlin |
| Rina Kartika | Platform Engineer | CI/CD, Docker, Kubernetes, GitHub Actions |
| Dimas Prakoso | QA Engineer | Integration testing, contract testing, test automation |

## Divisi Operasional

| Nama | Peran | Spesialisasi |
|---|---|---|
| Sari Wijaya | Reconciliation Officer | Rekonsiliasi harian, settlement bank, laporan keuangan |
| Agus Setiawan | Data Entry and Compliance | Entri data logistik, formulir kepatuhan, arsip dokumen |
| Maya Puspita | Inventory Coordinator | Sinkronisasi inventaris, stok gudang, mutasi barang |

## Divisi Manajemen

| Nama | Peran | Spesialisasi |
|---|---|---|
| Rahma Dewi | Director of Operations | Project owner, approve penugasan, executive reporting |

## Aturan Alokasi

1. Penugasan rekayasa perangkat lunak harus diarahkan ke anggota divisi Teknikal.
2. Penugasan dokumen, formulir, dan rekonsiliasi harus diarahkan ke anggota divisi Operasional.
3. Penugasan dengan prioritas P0 pada sistem pembayaran wajib diarahkan ke Budi Santoso sebagai pemilik modul.
4. Pengujian otomatis (CI) wajib dijalankan untuk seluruh perubahan kode pada repository pembayaran.
5. Rekonsiliasi harian wajib dikerjakan oleh Sari Wijaya atau pengganti yang ditentukan.
6. Bila pengalokasian tidak disebutkan dalam arahan pimpinan, sistem memilih anggota dengan
   spesialisasi paling cocok dan menampilkan pilihan tersebut pada kartu otorisasi agar
   commanding officer dapat mengoreksinya sebelum pendistribusian.

## Alamat Kanal Divisi

| Divisi | Kanal |
|---|---|
| Teknikal | Percakapan grup kanal Telegram `Divisi Teknikal` |
| Operasional | Percakapan grup kanal Telegram `Divisi Operasional` |
| Manajemen | Percakapan pribadi commanding officer |
