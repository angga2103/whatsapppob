# 🔄 WORKFLOW & SIKLUS TRANSAKSI BOT PPOB

Dokumen ini menjelaskan alur operasional, siklus hidup order (*order lifecycle*), alur Prabayar dan Pascabayar, serta mekanisme refund otomatis.

---

## 1. Peta Navigasi Menu Utama Berbasis Angka

```text
                             [Pesan Masuk: MENU / HALO / P / 1-10]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
             [User Memilih Angka 1-10]                    [Shortcut Cepat]
                       │                                   .beli / .harga / .transfer
                       ├─► [1] Pulsa Reguler (Prabayar)
                       ├─► [2] Paket Data Internet
                       ├─► [3] Topup E-Money & E-Wallet
                       ├─► [4] Token Listrik PLN (Prabayar)
                       ├─► [5] Tagihan Pascabayar (PPOB) ──► (Inquiry ➔ Konfirmasi ➔ Bayar)
                       ├─► [6] Produk Digital (Akun / App)
                       ├─► [7] Isi Saldo (Deposit QRIS)
                       ├─► [8] Profil & Cek Saldo
                       ├─► [9] Riwayat Transaksi
                       └─► [10] Bantuan & Panduan
```

---

## 2. Alur Transaksi Prabayar (Prepaid)

```text
[Pilih Kategori: 1/2/3/4] ──► [Input No HP / Meteran] ──► [Deteksi Operator / Brand]
                                                                  │
                                                                  ▼
                                                      [Daftar Produk Bernomor: 1, 2, 3..]
                                                                  │
                                                                  ▼
                                                      [Pilih Nomor Produk]
                                                                  │
                                                                  ▼
                                                      [Invoice Konfirmasi]
                                                      Balas 1: Bayar | Balas 2: Batal
                                                                  │
                                            ┌─────────────────────┴─────────────────────┐
                                            ▼ (Cukup Saldo)                             ▼ (Kurang Saldo)
                                     [Potong Saldo Akun]                         [Generate QRIS 5 Menit]
                                            │                                           │
                                            │                                           ▼
                                            │                                  [Polling Payment Lunas]
                                            └─────────────────────┬─────────────────────┘
                                                                  │
                                                                  ▼
                                                      [Tembak Digiflazz API]
                                                      (api.hitDigiflazz)
                                                                  │
                                            ┌─────────────────────┴─────────────────────┐
                                            ▼                                           ▼
                                    [Sukses / Pending]                               [Gagal]
                                            │                                           │
                         ┌──────────────────┴──────────────────┐                        ▼
                         ▼                                     ▼                 [Auto Refund 1x]
                    [Kirim SN]                        [Radar Pemantau 10s]       (db.refundOrder)
                                                      Mengecek hingga Sukses/Gagal
```

---

## 3. Alur Transaksi Pascabayar (Postpaid)

Digiflazz Pascabayar menggunakan alur **2 Langkah: Inquiry Tagihan (`inq-pasca`) lalu Bayar Tagihan (`pay-pasca`)**:

```text
1. [User Memilih Menu 5: Pascabayar]
   Pilihan Kategori:
   • 1: PLN Pascabayar (Listrik Bulanan)
   • 2: BPJS Kesehatan
   • 3: PDAM (Air Bersih)
   • 4: PBB (Pajak Bumi Bangunan)
   • 5: PLN Non-Taglis
   • 6: HP Pascabayar & Internet Kabel

2. [Input ID Pelanggan / Nomor Kontrak]
   Sistem mengeksekusi inquiry otomatis:
   commands: "inq-pasca"
   buyer_sku_code: [SKU Pascabayar]
   customer_no: [ID Pelanggan]

3. [Server Mengembalikan Data Tagihan]
   • Nama Pelanggan: Contoh "BUDI SANTOSO"
   • Periode Tagihan: Contoh "September 2026"
   • Nominal Tagihan Pokok
   • Biaya Admin
   • Total Bayar = Tagihan + Admin

4. [Bot Menampilkan Rincian Tagihan Resmi]
   Menampilkan detail lengkap ke WhatsApp pembeli dengan pilihan:
   • Balas 1 untuk BAYAR SEKARANG
   • Balas 2 untuk BATAL

5. [Eksekusi Pembayaran]
   Jika pembeli membalas 1:
   • Saldo dipotong (atau bayar QRIS jika saldo kurang)
   • Sistem menembak commands: "pay-pasca" ke Digiflazz
   • Struk resmi, No Referensi, dan SN dikirimkan ke pembeli!

6. [Jika Pembayaran Gagal di Provider]
   • Otomatis di-refund tepat 1x ke dompet akun via `db.refundOrder(order, reason)`.
```

---

## 4. Siklus Hidup Order (Order Lifecycle)

| Status | Arti | Aksi Sistem |
| :--- | :--- | :--- |
| `unpaid` | Menunggu pembayaran QRIS | Polling setiap 10 detik, batas expired 5 menit |
| `pending` | Order dibuat, saldo terpotong | Menyiapkan pengiriman ke provider |
| `processing` | Sedang diproses oleh server Digiflazz | Dipantau oleh Radar Intelijen setiap 10 detik |
| `success` | Transaksi berhasil masuk ke target | Serial Number (SN) / Token dikirimkan ke pembeli |
| `failed` | Transaksi gagal / nomor gangguan | Saldo dikembalikan 1x (`order.refunded = true`) |
| `cancelled` | Dibatalkan oleh user atau QRIS expired | Kunci transaksi dilepas |

---

## 5. Protokol Radar Pemantau Background (10 Detik)

1. Mengambil seluruh order dengan status `processing` dan `isPpob !== false`.
2. Mengecek status aktual ke Digiflazz (`commands: status` untuk prabayar atau `commands: status-pasca` untuk pascabayar).
3. **Jika Sukses:** Update status `order.status = 'success'`, simpan ke database, dan kirimkan SN ke pembeli.
4. **Jika Gagal:**
   - Memeriksa apakah pesan gagal valid (bukan error signature/OID sementara).
   - Memanggil `db.refundOrder(order, sn)`.
   - Menolak refund jika `order.refunded === true`.
   - Mengirim notifikasi gagal dan pengembalian saldo ke pembeli.
