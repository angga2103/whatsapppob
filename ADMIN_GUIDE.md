# 🛠️ PANDUAN LENGKAP ADMIN BOT PPOB (IN-CHAT WHATSAPP)

Seluruh konfigurasi, margin profit, API key, multi-owner, dan manajemen produk bot dapat diatur **langsung dari chat WhatsApp** tanpa perlu membuka terminal atau mengubah file `.env`.

> [!NOTE]
> Semua perintah admin diawali dengan titik (`.`) dan hanya dapat dieksekusi oleh nomor yang terdaftar sebagai Owner/Admin.

---

## 1. Perintah Pengaturan Sistem & Kredensial API

| Perintah | Deskripsi | Contoh Penggunaan |
| :--- | :--- | :--- |
| `.settings` / `.pengaturan` | Menampilkan seluruh status setting aktif saat ini | `.settings` |
| `.setdigi [username] [apiKey]` | Mengubah kredensial API Digiflazz | `.setdigi user123 32d4-xxxx-xxxx` |
| `.setpayment [merchantId] [secret]` | Mengubah kredensial PaymentKita (QRIS) | `.setpayment PKM123 PKSK_xxxx` |
| `.settg [token] [chatId]` | Mengubah bot token & chat ID Telegram | `.settg 847009:AAExxx 723611` |
| `.namatoko [nama]` | Mengubah nama toko bot | `.namatoko GarudaTel PPOB` |
| `.toko [buka\|tutup]` | Mengatur status buka / tutup toko | `.toko buka` atau `.toko tutup` |
| `.cekdigi` | Cek sisa saldo akun Digiflazz | `.cekdigi` |

---

## 2. Pengaturan Margin Keuntungan (Profit)

### A. Profit Berdasarkan Kategori
| Perintah | Deskripsi | Contoh |
| :--- | :--- | :--- |
| `.setprofit pulsa [nominal]` | Margin pulsa per transaksi | `.setprofit pulsa 300` |
| `.setprofit data [nominal]` | Margin paket data per transaksi | `.setprofit data 500` |
| `.setprofit emoney [nominal]` | Margin topup e-money | `.setprofit emoney 400` |
| `.setprofit pln [nominal]` | Margin token PLN prabayar | `.setprofit pln 500` |

### B. Profit Berdasarkan Rentang Harga Modal (Tiering)
| Perintah | Kriteria Modal | Default | Contoh |
| :--- | :--- | :--- | :--- |
| `.settier kecil [nominal]` | Harga modal Rp 0 – Rp 25.000 | Rp 250 | `.settier kecil 300` |
| `.settier sedang [nominal]` | Harga modal Rp 25.001 – Rp 100.000 | Rp 500 | `.settier sedang 600` |
| `.settier besar [nominal]` | Harga modal Rp 100.001 – Rp 300.000 | Rp 1.000 | `.settier besar 1200` |
| `.settier premium [nominal]` | Harga modal > Rp 300.000 | Rp 2.000 | `.settier premium 2500` |

---

## 3. Manajemen Multi-Owner / Admin

| Perintah | Deskripsi | Contoh |
| :--- | :--- | :--- |
| `.addowner [nomor]` | Menambahkan nomor admin baru | `.addowner 628123456789` |
| `.delowner [nomor]` | Menghapus nomor admin | `.delowner 628123456789` |
| `.listowner` | Melihat seluruh daftar nomor admin terdaftar | `.listowner` |

---

## 4. Sinkronisasi & Manajemen Produk

| Perintah | Deskripsi | Contoh |
| :--- | :--- | :--- |
| `.sync` | Menarik ulang seluruh harga & produk terbaru Digiflazz (Prabayar & Pascabayar) | `.sync` |
| `.addmenu [nama] [harga]` | Menambah produk digital lokal (akun/aplikasi) | `.addmenu Netflix 1 Bulan 35000` |
| `.delmenu [id]` | Menghapus produk digital lokal | `.delmenu 1` |
| `.setstok [id] [jumlah]` | Mengubah stok produk digital lokal | `.setstok 1 20` |
| `.setharga [id] [harga]` | Mengubah harga produk digital lokal | `.setharga 1 30000` |

---

## 5. Manajemen Saldo & Operasional Transaksi

| Perintah | Deskripsi | Contoh |
| :--- | :--- | :--- |
| `.addsaldo [NoHP] [nominal]` | Menambah/menyesuaikan saldo member | `.addsaldo 08123456789 50000` |
| `.info [NoHP]` | Cek profil lengkap dan saldo member | `.info 08123456789` |
| `.topsaldo` | Melihat daftar member dengan saldo terbanyak | `.topsaldo` |
| `.toptrx` | Melihat daftar member paling sering transaksi | `.toptrx` |
| *Reply pesan order manual* dengan kata `BATAL` | Membatalkan order dan mengembalikan saldo 1x secara otomatis | Balas: `BATAL` |
