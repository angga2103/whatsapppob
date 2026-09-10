# 🤖 Bot PPOB & Toko Digital WhatsApp + Telegram

Bot WhatsApp otomatis untuk melayani transaksi **PPOB (Pulsa, Paket Data, E-Money, Token PLN, Tagihan Pascabayar)** dan **Produk Digital (Akun / Lisensi / Voucher)** dengan sistem pembayaran otomatis menggunakan **Saldo Akun** dan **QRIS Realtime (PaymentKita)**, terintegrasi dengan provider **Digiflazz**.

Dilengkapi dengan **Interactive One-Click Installer**, **Pengaturan Penuh via Chat WhatsApp (In-Chat Admin Settings)**, **Shortcut Transaksi Instan**, dan **Database JSON Atomik Anti-Korupsi**.

---

## 🌟 Fitur Utama

### 🛒 Fitur Pelanggan & Transaksi
- **Transaksi Super Cepat & Mudah:**
  - **Menu Interaktif:** Ketik `MENU` untuk memilih kategori bertingkat dengan deteksi operator otomatis (Telkomsel, Indosat, XL, Axis, Tri, Smartfren, by.U).
  - **Shortcut Pembelian Instan:** Cukup ketik `.beli [SKU] [NoHP]` (Contoh: `.beli S10 081234567890`) untuk langsung checkout tanpa langkah panjang.
  - **Cek Daftar Harga & SKU:** Ketik `.harga [Operator]` (Contoh: `.harga tsel`, `.harga pln`) untuk melihat daftar produk dan harga aktif.
  - **Cek Status & SN:** Ketik `.status [Invoice]` untuk melihat status transaksi atau mengambil kembali nomor token PLN / SN.
  - **Riwayat Pembelian:** Ketik `.riwayat` untuk melihat 5 transaksi terakhir.
  - **Transfer Saldo Antar Member:** Ketik `.transfer [NoHP] [Nominal]` untuk saling kirim saldo instan bebas biaya admin.
- **Dua Metode Pembayaran Otomatis:**
  - **Potong Saldo Akun:** Transaksi langsung diproses dalam 1 detik jika saldo mencukupi.
  - **QRIS Realtime Otomatis:** Menghasilkan QR code QRIS dinamis via PaymentKita dengan deteksi pembayaran otomatis tanpa perlu kirim bukti transfer.
- **Deposit Saldo 24 Jam:** Ketik `DEPOSIT` untuk mengisi saldo akun via QRIS mulai dari Rp1.000.

### 👑 Fitur Kontrol & Pengaturan Admin (In-Chat Remote)
**Semua konfigurasi bot dapat diatur langsung dari chat WhatsApp tanpa perlu menyentuh terminal server:**
- **`.settings` / `.pengaturan`:** Melihat ringkasan seluruh pengaturan bot (Toko, API Key, Margin Profit, Daftar Admin).
- **`.setdigi [user] [api_key]`:** Mengubah kredensial Digiflazz secara langsung.
- **`.setpayment [merchant_id] [secret_key]`:** Mengubah kredensial PaymentKita.
- **`.settg [token] [chat_id]`:** Mengatur notifikasi bot Telegram Command Center.
- **`.setprofit [pulsa|data|emoney|pln] [nominal]`:** Mengatur margin keuntungan per kategori produk.
- **`.settier [kecil|sedang|besar|premium] [nominal]`:** Mengatur keuntungan bertingkat berdasarkan rentang harga.
- **`.addowner [NoHP]` & `.delowner [NoHP]`:** Menambah atau menghapus nomor admin WhatsApp.
- **`.sync`:** Menarik dan memperbarui seluruh katalog produk Digiflazz (Pulsa, Data, E-Money, PLN, Pascabayar) sekaligus dalam 1 perintah.
- **`.toko [on|off]`:** Membuka atau menutup toko (mode offline pemeliharaan).
- **`.namatoko [Nama_Baru]`:** Mengubah nama brand toko yang tampil di bot.
- **`.addsaldo [NoHP] [Nominal]`:** Menambah saldo member secara manual oleh admin.
- **`.addmenu` / `.adddata` / `.delmenu` / `.stok`:** Manajemen produk digital lokal (akun/voucher).
- **`.stats` & `.health`:** Melihat laporan omzet harian dan kesehatan sistem.

### 🛡️ Keamanan & Ketahanan Sistem (High Integrity)
- **Database Atomik Anti-Corrupt:** Seluruh penulisan file database JSON menggunakan mekanisme write-to-temp lalu rename. File database dijamin tidak akan pernah 0 byte atau rusak meskipun server mati mendadak.
- **Anti-Double Refund Shield:** Transaksi gagal di Digiflazz secara ketat hanya mengembalikan 1x nominal (bebas dari celah eksploitasi saldo ganda).
- **Anti-LID Smart Resolver:** Mengatasi akun multi-device WhatsApp (`@lid`) sehingga saldo pelanggan tidak pernah terpisah atau tertukar.
- **Idempotency Transaction Lock:** Mencegah spam klik yang memicu transaksi ganda untuk SKU dan nomor tujuan yang sama.

---

## 📋 Persyaratan Sistem

- **Node.js:** Versi `18.x`, `20.x`, atau yang lebih baru ([Download Node.js](https://nodejs.org/))
- **NPM:** Versi 9.x atau lebih baru
- **Akun Provider PPOB:** Akun [Digiflazz](https://digiflazz.com) (Username & Production Key)
- **Akun Payment Gateway:** Akun [PaymentKita](https://paymentkita.com) (Merchant ID & Secret Key)
- **Akun Telegram (Opsional):** Bot Token & Chat ID untuk monitoring command center

---

## 🚀 Panduan Instalasi Cepat (One-Click Installer)

### 1. Clone Repository
```bash
git clone https://github.com/angga2103/whatsapppob.git
cd whatsapppob
```

### 2. Jalankan One-Click Installer

#### Pengguna Windows:
Cukup klik dua kali file **`install.bat`** atau jalankan perintah:
```powershell
npm run setup
```

#### Pengguna Linux / VPS:
```bash
chmod +x install.sh
./install.sh
# Atau jalankan:
npm run setup
```

### 3. Ikuti Panduan Interaktif di Terminal:
1. Installer akan memeriksa Node.js dan memasang dependensi secara otomatis.
2. Anda akan dipandu memasukkan kredensial (`.env`) seperti username Digiflazz, PaymentKita, dan nomor WhatsApp Admin.
3. Masukkan nomor WhatsApp Bot (format: `628xxxxxxxx`).
4. Terminal akan menampilkan **Kotak Kode Pairing 8 Digit** (Contoh: `ABCD - 1234`).
5. Buka WhatsApp di HP Anda:
   - Ketuk menu **Titik Tiga (Kanan Atas)** > **Perangkat tertaut (Linked devices)**
   - Ketuk **Tautkan perangkat (Link a device)**
   - Pilih **Tautkan dengan nomor telepon saja (Link with phone number instead)**
   - Masukkan 8 digit kode pairing yang tampil di terminal.
6. Selesai! Bot WhatsApp Anda resmi terhubung.

---

## ▶️ Menjalankan Bot di Server

Untuk menjalankan bot dalam mode normal:
```bash
npm start
# Atau:
node index.js
```

### Menjalankan di Background (24/7 menggunakan PM2):
```bash
npm install -g pm2
pm2 start index.js --name "bot-ppob"
pm2 save
pm2 startup
```

---

## 📖 Panduan Perintah Lengkap

### 👤 Perintah Pengguna (Pelanggan)

| Perintah | Deskripsi | Contoh |
| :--- | :--- | :--- |
| `MENU` / `P` | Membuka menu katalog interaktif | `MENU` |
| `.beli [SKU] [NoHP]` | Transaksi instan langsung ke pembayaran | `.beli S10 081234567890` |
| `.harga [Operator]` | Melihat daftar produk, SKU, dan harga | `.harga tsel` / `.harga pln` |
| `DEPOSIT` | Mengisi saldo akun via QRIS otomatis | `DEPOSIT` lalu ketik `20000` |
| `PROFIL` | Mengecek saldo dompet dan nomor akun | `PROFIL` |
| `.riwayat` | Melihat 5 transaksi terakhir beserta SN/Token | `.riwayat` |
| `.status [Invoice]` | Memeriksa status transaksi invoice tertentu | `.status INV-1741604820` |
| `.transfer [NoHP] [Nominal]` | Mengirim saldo ke pengguna lain | `.transfer 085712345678 15000` |
| `.help` / `BANTUAN` | Menampilkan panduan format transaksi | `.help` |
| `B` | Membatalkan transaksi yang sedang berjalan | `B` |

---

### 👑 Perintah Admin / Owner

| Perintah | Deskripsi | Contoh |
| :--- | :--- | :--- |
| `.admin` | Membuka menu Command Center admin | `.admin` |
| `.settings` | Menampilkan semua konfigurasi aktif dan margin profit | `.settings` |
| `.setdigi [user] [key]` | Mengubah kredensial Digiflazz | `.setdigi user123 32d4-xxxx` |
| `.setpayment [id] [secret]` | Mengubah kredensial PaymentKita | `.setpayment PKM12345 PKSK_xxxx` |
| `.settg [token] [chatId]` | Mengubah konfigurasi bot Telegram | `.settg 847009:AA... 72361132` |
| `.setprofit [kategori] [nominal]` | Mengatur margin keuntungan produk | `.setprofit pulsa 700` |
| `.settier [tier] [nominal]` | Mengatur margin bertingkat | `.settier kecil 1000` |
| `.addowner [NoHP]` | Menambahkan nomor admin baru | `.addowner 628123456789` |
| `.delowner [NoHP]` | Mencabut hak admin dari nomor | `.delowner 628123456789` |
| `.sync` | Sinkronisasi seluruh katalog Digiflazz otomatis | `.sync` |
| `.toko [on/off]` | Membuka atau menutup toko | `.toko on` / `.toko off` |
| `.namatoko [Nama]` | Mengubah nama toko | `.namatoko Garuda Store` |
| `.addsaldo [NoHP] [Nominal]` | Menambahkan saldo pelanggan | `.addsaldo 0812345678 50000` |
| `.cekdigi` | Mengecek sisa saldo deposit di Digiflazz | `.cekdigi` |
| `.addmenu [Nama]\|[Harga]\|[Stok]` | Menambah produk digital lokal | `.addmenu Netflix 1 Bln\|35000\|5` |
| `.adddata [ID] [Teks]` | Mengisi data akun produk digital | `.adddata 1 email:pass` |
| `.stats` | Menampilkan statistik omzet dan transaksi toko | `.stats` |
| `.health` | Memeriksa status kesehatan WhatsApp dan Database | `.health` |
| `.backup` | Melakukan pencadangan data ke Telegram | `.backup` |

---

## ⚙️ Struktur Proyek

```
Bot PPOB/
├── config.js               # Konfigurasi dinamis (Integrasi .env & settings.json)
├── index.js                # Server utama (Baileys, Transaction Engine, Polling)
├── installer.js            # Interactive One-Click Installer & Pairing CLI
├── install.bat             # Skrip installer instan untuk Windows
├── install.sh              # Skrip installer instan untuk Linux / VPS
├── package.json            # Node.js dependencies & scripts
├── .env.example            # Template kredensial publik
├── .gitignore              # Proteksi file kredensial & session bot
├── database/               # Database Engine JSON Atomik
│   ├── db.js               # Engine atomik & normalisasi identitas
│   ├── menu.json           # Produk digital lokal
│   ├── orders.json         # Riwayat pesanan
│   ├── postpaid.json       # Katalog produk pascabayar
│   ├── ppob.json           # Katalog produk prepaid Digiflazz
│   ├── settings.json       # Pengaturan dinamis via WhatsApp
│   ├── store.json          # Status buka/tutup & nama toko
│   └── users.json          # Data saldo dan profil pelanggan
├── handlers/               # Pengelola pesan masuk
│   ├── admin.js            # Command Center & In-Chat Settings Admin
│   └── user.js             # Alur belanja, shortcut cepat, & transaksi pelanggan
├── lib/                    # Library pembantu
│   ├── api.js              # Integrasi API Digiflazz & PaymentKita
│   ├── logger.js           # Pencatatan log transaksi
│   ├── postpaid.js         # Inquiry & Pembayaran Pascabayar
│   ├── search.js           # Engine pencarian produk cerdas
│   └── utils.js            # Helper format rupiah & operator
└── system/                 # Health check, watchdog, & alert state
```

---

## ❓ Troubleshooting (Tanya Jawab)

**T: WhatsApp tiba-tiba disconnect / terputus?**  
J: Bot memiliki auto-reconnect bawaan. Jika sesi kadaluarsa/keluar, jalankan `npm run setup` untuk menautkan ulang kode pairing.

**T: Saldo pelanggan terpotong tapi pulsa gagal masuk?**  
J: Sistem memiliki fitur **Auto-Refund 1x Nominal**. Jika provider Digiflazz melaporkan status transaksi gagal, saldo otomatis dikembalikan utuh ke dompet pembeli saat itu juga.

**T: Bagaimana cara mengganti markup/keuntungan?**  
J: Cukup kirim pesan WhatsApp ke bot menggunakan nomor Admin: `.setprofit pulsa 800` atau `.settier kecil 1200`. Pengaturan langsung aktif seketika tanpa perlu restart bot.

---

## 📜 Lisensi

Didistribusikan di bawah lisensi ISC. Bebas digunakan dan dikembangkan untuk kebutuhan operasional bisnis digital Anda.
