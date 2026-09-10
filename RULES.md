# 📜 PROJECT RULES & STANDAR ARSITEKTUR BOT PPOB

Dokumen ini berisi standar teknis, aturan arsitektur, kebijakan keamanan transaksi, dan konvensi penulisan kode untuk bot WhatsApp PPOB & Toko Digital. Semua pengembang atau agen AI yang memodifikasi proyek ini **WAJIB** mematuhi aturan di bawah ini.

---

## 1. Aturan Emas Integritas Transaksi (Anti Double Refund)

> [!CAUTION]
> **DILARANG KERAS** memodifikasi saldo user secara langsung tanpa proteksi idempoten saat transaksi gagal!

1. **Satu Pintu Refund (`db.refundOrder`):**
   - Seluruh pengembalian saldo (refund) karena transaksi gagal, penolakan server, atau pembatalan admin **HANYA BOLEH** dilakukan melalui fungsi resmi `db.refundOrder(order, reason)`.
   - **DILARANG** melakukan `db.users[id].saldo += amount` secara manual di luar fungsi ini.
2. **Flag Status Idempoten (`order.refunded`):**
   - Setiap order yang telah di-refund **wajib** memiliki properti `order.refunded = true` dan `order.refundedAt = Date.now()`.
   - Sebelum saldo dikembalikan, sistem wajib memeriksa:
     ```javascript
     if (order.refunded) {
         return { success: false, reason: 'Already refunded' };
     }
     ```
3. **Pencegahan Race Condition:**
   - Karena radar background berjalan setiap 10 detik dan event handler transaksi berjalan asinkron, order harus dikunci (`order.refunded = true`) **sebelum** penambahan saldo dilakukan ke memori.

---

## 2. Standar Penanganan Identitas WhatsApp (`@lid` vs `@s.whatsapp.net`)

> [!IMPORTANT]
> WhatsApp Multi-Device dapat mengirimkan pesan dengan format `@lid` (Linked Device ID) atau `@s.whatsapp.net` untuk orang yang sama.

1. **Satu Pengguna Satu Dompet (Canonical JID):**
   - Tidak boleh ada saldo terpisah antara akun `@lid` dan akun `@s.whatsapp.net` milik pengguna yang sama.
   - Semua akses pengguna wajib melalui:
     ```javascript
     const canonicalJid = db.normalizeJid(sender);
     const user = db.getUser(canonicalJid);
     ```
2. **Konsolidasi Otomatis:**
   - Modul `database/db.js` menjalankan `db.consolidateWallets()` saat startup untuk menggabungkan data akun `@lid` yang memiliki nomor HP yang sama ke akun canonical `@s.whatsapp.net`.

---

## 3. Aturan Penyimpanan Database (Atomic File Writes)

1. **Dilarang Direct Write Parsial:**
   - **JANGAN PERNAH** menggunakan `fs.writeFileSync` langsung pada file database (`users.json`, `orders.json`, `ppob.json`, `postpaid.json`, `store.json`).
2. **Wajib Atomic Write (`atomicWriteJson`):**
   - Seluruh penyimpanan database dilakukan dengan menulis ke file sementara (`.tmp`) terlebih dahulu, kemudian di-rename secara atomik (`fs.moveSync` dengan overwrite) untuk mencegah file korup/berukuran 0 byte jika server mati tiba-tiba saat proses tulis.

---

## 4. Hirarki Konfigurasi Dinamis

1. **Prioritas Konfigurasi:**
   `database/settings.json` (WhatsApp Chat Admin) **>** `process.env` (`.env`) **>** Nilai Default Hardcoded.
2. **Semua Pengaturan Wajib Reaktif:**
   - Modul `config.js` menggunakan JavaScript *getter* sehingga setiap perubahan yang dibuat admin via chat WhatsApp (`.setprofit`, `.setdigi`, `.settier`) langsung berlaku saat itu juga tanpa perlu restart server.

---

## 5. Standar Interaksi Pengguna (Menu Angka)

1. **Interaksi Utama Ramah Pengguna (Nomor/Angka):**
   - Semua alur pengguna dari pemilihan kategori, pemilihan produk, hingga konfirmasi pembayaran wajib dapat dijalankan cukup dengan membalas **ANGKA** (`1`, `2`, `3`...).
2. **Konfirmasi Standar:**
   - Balas **1** untuk **BAYAR SEKARANG**
   - Balas **2** untuk **BATAL**
   *(Dukungan `Y` dan `B` tetap dipertahankan untuk fleksibilitas)*.
3. **Shortcut Cepat:**
   - Perintah cepat seperti `.beli [SKU] [NoHP]` dan `.harga [Operator]` bersifat opsional untuk pengguna mahir dan tidak boleh merusak alur interaktif menu angka.

---

## 6. Protokol Keamanan & Git Deployment

1. **Dilarang Commit Kredensial & Data Pribadi:**
   - File `.env`, folder sesi WhatsApp `session_bot/`, dan file data pengguna (`database/users.json`, `database/orders.json`, `database/deposits.json`) **WAJIB** masuk ke dalam `.gitignore`.
2. **File Template Publik:**
   - Sediakan selalu `.env.example` dengan kunci dummy untuk pengguna baru yang mengkloning repository.
