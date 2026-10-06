---
name: bot-ppob-modernization
description: >-
  Panduan dan standar arsitektur pemutakhiran, penguatan keamanan, audit bug,
  dan otomatisasi skalabilitas untuk sistem Bot PPOB WhatsApp & Telegram.
---

# 🚀 Bot PPOB Modernization & Security Architecture Skill

Skill ini memuat instruksi, standar keamanan, checklist pengujian, dan arsitektur pemutakhiran untuk proyek **Bot PPOB (WhatsApp + Telegram + Web Service)**.

---

## 🛡️ 1. Standar Keamanan & Perlindungan Anti-Fraud

### A. Web Endpoint Protection (`/struk/:orderId`)
1. **IDOR & Brute Force Prevention:**
   - Parameter `orderId` harus divalidasi dengan regex ketat: `^INV-\d{10,14}-[A-Z0-9]{3,8}$`.
   - Pasang rate limiter pada Express (`express-rate-limit`): maksimal 30 request/menit per IP.
2. **Data Minimization:**
   - Jangan pernah menyertakan `ref_id` internal provider, saldo sisa pembeli, atau JID internal pada HTML/PDF publik.
   - Mask nomor telepon target (misal: `0812****7890`) pada struk publik kecuali diakses dengan signed token/signature.

### B. Anti Double-Spending & Race Condition
1. Gunakan library `mutex.js` (`withLock(buyerJid, ...)` atau `withLock(orderId, ...)`) pada setiap alur transaksi:
   - Pemotongan saldo (`deductSaldo`)
   - Eksekusi hit API Digiflazz (`hitDigiflazz`)
   - Penambahan refund (`refundOrder`)
2. Jangan pernah mengizinkan pemanggilan `refundOrder` jika `order.refunded === true` atau status transaksi masih dalam rentang validasi quick-poll.

### C. Telegram Authentication & Webhook/Polling Hardening
1. Pastikan setiap callback query dan message pada `botTg` memvalidasi:
   - `msg.chat.id.toString() === config.telegram.chatId.toString()`
2. Abaikan perintah dari grup atau chat non-admin untuk command administratif sensitif (`addsaldo`, `setdigi`, `backup`, `settings`).

---

## ⚡ 2. Standar Integritas Data & Transaksi

### A. Format Nomor Telepon & Normalisasi JID
1. Selalu gunakan `db.normalizeJid(sender)` sebelum memanggil `db.getUser()`.
2. Format penyimpanan nomor:
   - Nomor WhatsApp JID: `628xxxxxxxxxx@s.whatsapp.net`
   - Nomor lokal Indonesia: `08xxxxxxxxxx` (hilangkan karakter spasi, strip, dan karakter non-numerik).
3. Dukung integrasi akun multi-device (`@lid` linked ke canonical `@s.whatsapp.net`).

### B. Sinkronisasi Asinkron Provider (Digiflazz Radar & Quick-Poll)
1. Eksekusi awal transaksi Digiflazz hampir selalu menghasilkan status `Pending`.
2. Terapkan quick-poll sinkron (3-4 kali dengan jeda 2-3 detik) saat eksekusi langganan/pembelian sebelum mengirimkan respon pertama ke pembeli.
3. Jika masih pending, serahkan penanganan ke `Radar Pemantau Digiflazz V4` (`index.js`).
4. Radar wajib:
   - Mengisolasi per-order `try...catch` agar error 1 transaksi tidak menghentikan pemantauan transaksi lain.
   - Menyinkronkan nomor SN / Token PLN ke `sub.history` jika `order.isSubscription === true`.
   - Mengirim kartu SN khusus (`🧾 SERIAL NUMBER LANGGANAN` / `⚡ TOKEN PLN`) ke chat pembeli saat transaksi sukses.

---

## 📦 3. Checklist Modularisasi & Refactoring Kode

Saat mengembangkan atau memutakhirkan kode:
1. **Pemisahan `index.js` Monolit:**
   - Pindahkan inisialisasi Express & routing ke `routes/struk.js` atau `lib/server.js`.
   - Pindahkan logika Command Center Telegram ke `handlers/telegram.js`.
   - Pindahkan background worker (Radar, Cron, Watchdog) ke `workers/`.
2. **Migrasi Database JSON ke SQLite / PostgreSQL:**
   - Gunakan ORM/query builder ringan (`better-sqlite3` atau `prisma`) untuk mencegah disk IO bottleneck akibat serialisasi JSON berukuran besar.

---

## 🛠️ 4. Prosedur Deploy & Update VPS Aman
1. Jalankan `git status` untuk memastikan tidak ada file runtime yang belum di-ignore.
2. Pastikan file data (`database/*.json`, `session_bot/`) terdaftar di `.gitignore`.
3. Gunakan perintah:
   ```bash
   git pull origin main
   npm install --omit=dev
   pm2 reload bot-ppob || pm2 restart bot-ppob
   ```
