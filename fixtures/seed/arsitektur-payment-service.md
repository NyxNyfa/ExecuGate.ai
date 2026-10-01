# Arsitektur Sistem — Payment Service v2.4

**Project:** Core Platform (kode: `CORE`)
**Owner:** Divisi Teknikal
**Terakhir diperbarui:** 2026-09-18
**Klasifikasi:** Dokumen Acuan Baku (Canonical)

## 1. Ringkasan

Payment Service v2.4 adalah layanan pemrosesan pembayaran yang berjalan di atas
layanan internal `core-gateway`. Seluruh lalu lintas pembayaran melewati satu
pintu masuk (`POST /v2/payments`) dan satu pintu keluar (`GET /v2/payments/{id}`).

## 2. Batasan Kapasitas (Canonical)

Nilai di bawah ini adalah acuan baku. Nilai yang berbeda di dokumen lain
dianggap kedaluwarsa.

| Parameter | Nilai Baku | Catatan |
|---|---|---|
| Batas payload request | 512 KB | Body JSON yang di-encode UTF-8, setelah kompresi field metadata |
| Batas unggah bukti lampiran | 25 MB | Per berkas, untuk unggahan dokumen administratif |
| Durasi maksimum rekaman suara | 300 detik | Voice note dari kanal Telegram |
| Ukuran maksimum unggahan dokumen | 25 MB | Lampiran pada tiket operasional |
| Timeout upstream | 8 detik | Calls ke core-gateway dan bank acquirer |
| Jumlah item per rekonsiliasi | 5.000 baris | Setelah itu wajib dipaginasi |

### 2.1 Catatan Implementasi Batas Payload

Ketika payload melebihi 512 KB, `core-gateway` mengembalikan HTTP 413 dengan
kode galat `PAYLOAD_TOO_LARGE`. Aksinya adalah memisahkan data menjadi beberapa
batch dan mengirim ulang, bukan menaikkan batas. Menaikkan batas payload
memerlukan persetujuan-security-review dan tidak dapat dilakukan dalam sprint
berjalan.

## 3. Aturan Branch dan Code Review

Semua perubahan pada repository `acme/payment-service` wajib:

1. Berasal dari branch berawalan `feat/`, `fix/`, `chore/`, atau `hotfix/`.
2. Merged melalui Pull Request; merge langsung ke `main` dilarang.
3. Seluruh status check wajib hijau sebelum merge dapat diaktifkan. Daftar check
   yang wajib: `lint`, `unit-test`, `integration-test`, `security-scan`,
   `build-image`.
4. Tidak boleh ada konflik merge pada PR yang akan di-merge.

## 4. Debt yang Diketahui

- `POST /v2/payments/refund` masih memakai enum status lama; migrasi ke
  `REFUND_PENDING` dijadwalkan pada sprint berikutnya.
- Retry pada `bank-acquirer` belum memiliki exponential backoff.

## 5. Glosarium

| Istilah | Definisi |
|---|---|
| DoD | Definition of Done — kriteria objektif yang harus terpenuhi sebelum sebuah tugas dinyatakan selesai |
| Gatekeeper | Lapis pemeriksaan mutu otomatis yang memverifikasi bukti kerja terhadap sistem eksternal |
| Rekonsiliasi | Proses mencocokkan catatan transaksi sistem aplikasi dengan catatan settle dari bank acquirer |
| Otorisasi | Persetujuan eksplisit commanding officer sebelum penugasan didistribusikan ke staf |
