# SOP Rekonsiliasi Harian — Divisi Operasional

**Project:** Core Platform (kode: `CORE`)
**Owner:** Divisi Operasional
**Berlaku sejak:** 2026-08-01
**Klasifikasi:** Dokumen Acuan Baku (Canonical)

## 1. Tujuan

Memastikan seluruh transaksi settlement harian pada Payment Service v2.4 sudah
tercocokkan dengan catatan bank acquirer sebelum laporan keuangan ditutup.

## 2. Prosedur

1. Unduh laporan settlement bank dari kanal operasi bank pada pukul 09.00 WIB.
2. Ekspor rekap transaksi dari Payment Service pada rentang waktu yang sama.
3. Jalankan skrip `reconcile` dengan parameter `--strict`.
4. Periksa tiga nilai berikut wajib sama:
   - `total_amount` — jumlah nilai transaksi
   - `transaction_count` — jumlah baris transaksi
   - `settlement_count` — jumlah baris settlement
5. Selisih lebih dari 1 persen pada nilai mana pun wajib dilaporkan sebagai
   insiden dan **tidak boleh** dicatat sebagai selesai.

## 3. Lampiran Wajib

Setiap laporan rekonsiliasi harian wajib menyertakan:

- Berkas output rekonsiliasi (`.csv`) berisi rincian per tanggal.
- Tangkapan layar (screenshot) dashboard settle yang menunjukkan timestamp pengambilan data.
- Catatan penyimpangan bila ada.

## 4. Alur Eskalasi

| Kondisi | Tindakan |
|---|---|
| Selisih 0 | Rekap dikirim ke صباح hari berikutnya pada pukul 08.30 WIB |
| Selisih > 1 persen | Buat insiden, hubungi tim bank acquirer, jangan tutup hari tersebut |
| Data bank tidak tersedia | Tunda rekonsiliasi, catat sebagai pending; eskalasi ke supervisor pada pukul 12.00 WIB |

## 5. Pemeriksaan Otomatis oleh Gatekeeper

Sistem Otomatis akan menolak menandai tugas rekonsiliasi selesai apabila:

- Berkas output rekonsiliasi tidak ditemukan atau berukuran nol.
- `transaction_count` pada berkas tidak sama dengan `settlement_count`.
- Berkas rekonsiliasi bertanggal lebih lama dari hari berjalan.

Staff wajib memperbaiki dan mengunggah ulang sebelum pengajuan diterima.
