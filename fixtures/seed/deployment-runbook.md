# Deployment Runbook — Payment Service v2.4

**Project:** Core Platform (kode: `CORE`)
**Owner:** Rina Kartika (Platform Engineer)
**Klasifikasi:** Dokumen Acuan Baku (Canonical)

## 1. Prasyarat

Sebelum deployment dimulai, seluruh prasyarat berikut **wajib** terpenuhi.
Salah satu prasyarat yang tidak terpenuhi membuat deployment otomatis dihentikan.

| # | Prasyarat | Cara Pemeriksaan |
|---|---|---|
| P1 | Seluruh CI check pada PR Merge hijau | Status check pada Pull Request |
| P2 | Tidak ada konflik merge | Mergeability check pada Pull Request |
| P3 | Branch sudah ter-merge ke `main` | Status merge pada Pull Request |
| P4 | Image container sudah dibangun dan ber-tag | Cek pada CI/CD pipeline |
| P5 | Migration database sudah di-review | Label `migration-reviewed` pada PR |

## 2. Langkah Deployment

1. Pastikan prasyarat P1 sampai P5 terpenuhi.
2. Jalankan pipeline `deploy-production` pada branch `main`.
3. Pantau dashboard kesehatan selama 30 menit.
4. Catat hasil pada log deployment.

## 3. Pelaksanaan Rollback

Jika langkah 3 menunjukkan peningkatan error rate di atas 2 persen, lakukan
rollback ke image sebelumnya dan buat insiden P1.

## 4. Aturan Unggah Bukti

Staff wajib melampirkan tautan Pull Request sebagai bukti kerja pada tiket.
Bukti yang hanya berupa ringkasan verbal akan ditolak oleh sistem.
