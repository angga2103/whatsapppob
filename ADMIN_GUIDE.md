# 🛠️ PANDUAN LENGKAP ADMIN BOT PPOB (IN-CHAT WHATSAPP)

Seluruh konfigurasi, margin profit, API key, multi-owner, dan manajemen produk bot dapat diatur **langsung dari chat WhatsApp** tanpa perlu membuka terminal atau mengubah file `.env`.

> [!NOTE]
> Semua perintah admin diawali dengan titik (`.`) dan hanya dapat dieksekusi oleh nomor yang terdaftar sebagai Owner/Admin.

---

## 1. Perintah Pengaturan Sistem & Kredensial API

| Perintah | Deskripsi | Contoh Penggunaan |
| :--- | :--- | :--- |
| `.settings` / `.pengaturan` | Menampilkan seluruh status setting aktif saat ini | `.settings` |
| `.setgateway [paymentkita\|pakasir]` | Mengubah payment gateway aktif | `.setgateway pakasir` |
| `.setpayment [merchantId] [secret]` | Mengubah kredensial PaymentKita (QRIS) | `.setpayment PKM123 PKSK_xxxx` |
| `.setpakasir [project] [apiKey]` | Mengubah kredensial Pakasir (QRIS) | `.setpakasir myproject 98a7bc...` |
| `.setdigi [username] [apiKey]` | Mengubah kredensial API Digiflazz | `.setdigi user123 32d4-xxxx-xxxx` |
| `.settg [token] [chatId]` | Mengubah bot token & chat ID Telegram | `.settg 847009:AAExxx 723611` |
| `.namatoko [nama]` | Mengubah nama toko bot | `.namatoko Bintang PPOB` |
| `.toko [on\|off]` | Mengatur status buka / tutup toko | `.toko on` atau `.toko off` |
| `.cekdigi` | Cek sisa saldo akun Digiflazz | `.cekdigi` |

---

## 🤖 1B. Telegram Command Center (Model Tombol Inline Penuh)

Selain melalui chat WhatsApp, **seluruh pengaturan toko, member, produk, transaksi, dan operasional bot dapat dikendalikan 100% langsung lewat Telegram** menggunakan **Model Tombol Inline (Inline Keyboard)** interaktif:

### 1. 👥 Manajemen Member & Pengguna
- **[🔍 Cek Profil Member]**: Menampilkan daftar tombol seluruh member terdaftar secara interaktif (dilengkapi pagination & saldo). Admin cukup mengklik tombol nama/nomor member untuk langsung membuka profil lengkap tanpa perlu mengetik manual (tetap tersedia opsi ketik manual jika diinginkan).
- **[➕ Tambah / ➖ Tarik Saldo Cepat]**: Tombol cepat di profil member atau format input `[Nomor] [+ / -][Nominal]` (contoh: `62812xxx +50000` atau `62812xxx -25000`). Sistem otomatis memperbarui saldo, mencatat riwayat audit, dan mengirim pesan konfirmasi ke WhatsApp member!
- **[🏆 Top Member]**: Menampilkan Top 5 Member dengan saldo tertinggi serta Top 5 Member dengan total transaksi belanja sukses terbanyak.
- **[➕ Tambah Member Manual]**: Daftarkan member baru langsung dari Telegram dengan format `[Nomor] [Nama] [SaldoAwal]`. Jika diberikan saldo awal, member akan otomatis menerima notifikasi penyambutan di WhatsApp.
- **[📋 10 Member Terbaru]**: Menampilkan daftar 10 member yang baru terdaftar beserta saldo dan tanggal daftarnya.

### 2. 🏪 Pengaturan Toko Digital
- **[🟢 Buka / 🔴 Tutup Toko]**: Mengubah status operasional toko online/offline seketika dengan 1 klik.
- **[🏷️ Ubah Nama Toko]**: Mengganti nama toko digital yang tampil di WhatsApp dan struk transaksi.

### 3. 📦 Manajemen Produk Digital & Akun Lokal
- **[📂 List Produk Digital]**: Melihat daftar produk akun (Netflix, Spotify, Canva, dsb), harga, stok, dan jumlah data akun mentah tersimpan.
- **[➕ Tambah Produk]**: Format input `[Nama]|[Harga]|[Stok]` (contoh: `Netflix Premium 1 Bulan|35000|10`).
- **[💰 Edit Harga]**: Ubah harga produk digital langsung dari Telegram dengan format `[ID] [HargaBaru]` (contoh: `1 15000`).
- **[📦 Edit Stok]**: Ubah stok produk digital langsung dari Telegram dengan format `[ID] [StokBaru]` (contoh: `1 50`).
- **[📥 Isi Stok Data Akun]**: Format `[ID] [Data Akun]` atau untuk banyak stok `[ID] [Jumlah] [Data]`.
- **[🗑️ Hapus Produk]**: Hapus produk digital lokal berdasarkan ID.

### 4. 🔍 Pencarian Transaksi, Resend SN & Refund
- **[🔍 Cari Invoice]**: Masukkan ID invoice (contoh: `INV-1726000000`) untuk melihat detail produk, nomor tujuan, waktu, dan SN/Token.
- **[📲 Kirim Ulang SN ke Pembeli]**: Kirim ulang SN/token transaksi ke nomor WhatsApp pembeli secara instan langsung dari tombol inline di Telegram.
- **[💸 Batalkan & Refund Order]**: Batalkan pesanan bermasalah dan kembalikan saldo ke dompet pengguna secara otomatis disertai notifikasi WA ke pembeli.

### 5. 📢 Broadcast Pesan WhatsApp Massal
- **[✍️ Tulis Pesan Broadcast]**: Kirim pengumuman, info maintenance, atau promo massal ke seluruh kontak member yang terdaftar di database.
- **🛡️ Fitur Anti-Banned**: Pengiriman dilakukan secara berurutan dengan jeda aman 1 detik per nomor untuk melindungi nomor WhatsApp bot dari risiko blokir. Laporan sukses dan gagal dikirimkan ke Telegram setelah selesai.

### 6. 💳 Payment Gateway & Digiflazz
- **[💳 Gateway: PAYMENTKITA / PAKASIR]**: Pilih payment gateway aktif dengan 1 klik, serta tombol input kredensial Merchant ID, Secret Key, Project Slug, dan API Key.
- **[⚡ Menu Digiflazz]**: Set Username & API Key, cek saldo Digiflazz, dan sinkronisasi produk.
- **[💰 Cek Saldo Digi]**: Cek saldo deposit Digiflazz secara realtime.
- **[🔄 Sync Produk PPOB]**: Tarik ulang seluruh katalog produk prabayar & pascabayar Digiflazz.

### 7. ⚙️ Sistem, Margin, Health & Backup
- **[📊 Status & Health]**: Monitor uptime server, penggunaan RAM, status database, dan koneksi socket Baileys.
- **[📈 Statistik Omzet]**: Rekap omzet penjualan harian, transaksi sukses all-time, dan total member.
- **[⏳ Antrian Transaksi]**: Cek transaksi pending yang sedang dalam pemrosesan.
- **[📦 Backup Data]**: Buat arsip zip database dan kirimkan langsung ke Telegram untuk restore darurat.
- **[📱 Hubungkan / Re-Pairing WA]**: Hubungkan nomor bot baru, kode pairing 8-digit langsung dikirimkan ke Telegram.

### 8. 🚀 Cek & Pasang Pembaruan Otomatis (1-Click Updater)
- **[🚀 Cek Pembaruan / Update Bot]** (atau ketik `/update`):
  - Bot secara otomatis memeriksa pembaruan repositori Git dari GitHub (`origin/main`) tanpa memutus layanan yang sedang berjalan.
  - Jika bot sudah pada versi paling baru, bot menampilkan info `✅ Up to date` lengkap dengan commit hash dan tanggal update.
  - Jika ada pembaruan baru yang dirilis, bot merangkum jumlah commit dan ringkasan perubahannya (changelog), disertai tombol aksi **[⚡ Update Sekarang & Restart]**.
- **[⚡ Update Sekarang & Restart]**:
  - Menjalankan `git pull origin`, memperbarui paket dependensi jika ada perubahan `package.json`, dan otomatis merestart proses daemon (PM2) dalam 2-3 detik. Admin tidak perlu lagi repot-repot membuka terminal SSH VPS hanya untuk update bot!

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

## 5. Manajemen Saldo, Profil & Nama Member

| Perintah | Deskripsi | Contoh |
| :--- | :--- | :--- |
| `.setnama [NoHP] [NamaBaru]` | Menambah / mengubah nama member di sistem | `.setnama 081775700114 Ansor studio` |
| `.addsaldo [NoHP] [nominal]` | Menambah/menyesuaikan saldo member | `.addsaldo 08123456789 50000` |
| `.info [NoHP]` | Cek profil lengkap, nama, dan saldo member | `.info 08123456789` |
| `.topsaldo` | Melihat daftar member dengan saldo terbanyak | `.topsaldo` |
| `.toptrx` | Melihat daftar member paling sering transaksi | `.toptrx` |
| *Reply pesan order manual* dengan kata `BATAL` | Membatalkan order dan mengembalikan saldo 1x secara otomatis | Balas: `BATAL` |

> [!TIP]
> **Identitas Member Otomatis**: Bot secara cerdas menangkap nama profil WhatsApp pengguna (`pushName`) dan nomor telepon asli (format `081775700114`), bukan ID internal WhatsApp yang rumit. Admin juga dapat mengubah nama member kapan saja melalui Telegram (`[ ✏️ Ubah Nama Member ]`) atau WhatsApp (`.setnama`).

---

## 6. ⚡ Fitur Pembelian & Pencarian Cepat (WhatsApp Pengguna)

Pengguna tidak perlu scroll ratusan produk! Bot WhatsApp sudah dilengkapi **Smart Filter Engine** untuk menemukan paket dalam hitungan detik:

### A. Pencarian Cepat Sekaligus Input Nomor
Saat diminta memasukkan nomor tujuan paket data, pengguna dapat langsung menyertakan kriteria paket dipisahkan spasi atau titik:
- `08123456789 2gb` atau `08123456789.2gb` → Langsung memfilter paket kisaran 2 GB.
- `08123456789 30hari` atau `08123456789.30hari` → Langsung memfilter paket masa aktif 30 hari.
- `08123456789 50k` atau `08123456789.50k` → Langsung memfilter paket di kisaran harga Rp50.000.

### B. Filter Pintar di Sesi Katalog (Saat Memilih Paket)
Di layar katalog, pengguna cukup membalas pesan dengan kata kunci:
- **Filter Kuota**: Ketik `2gb`, `5gb`, `10gb`, `500mb`, dll.
- **Filter Masa Aktif**: Ketik `30hari`, `7hari`, `1hari`, `30h`, `7h`, dll.
- **Filter Rentang Harga**: Ketik `25k`, `50k`, `100k`, `50rb`, dll.
- **Filter Nama / Jenis Paket**: Ketik `combo`, `akrab`, `unlimited`, `booster`, `mini`, dll.
- **Kembali ke Katalog Lengkap**: Ketik `LANJUT`, `Z`, `SEMUA`, atau `RESET`.
