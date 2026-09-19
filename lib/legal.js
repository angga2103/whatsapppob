/**
 * ==============================================================================
 * ⚖️ MODUL SYARAT & KETENTUAN LAYANAN (TERMS OF SERVICE & DISCLAIMER HUKUM)
 * ==============================================================================
 * Klausul hukum perlindungan admin/pengelola platform dari tuntutan pengguna
 * maupun pihak ketiga (Digiflazz, Payment Gateway, Operator, WhatsApp/Meta).
 * ==============================================================================
 */

const db = require('../database/db');

function getStoreName() {
    return (db.store && db.store.namaToko) ? db.store.namaToko : 'DIGITAL STORE';
}

/**
 * Teks Lengkap Syarat & Ketentuan untuk WhatsApp (.snk / .tos / .aturan)
 */
function getTermsAndConditionsWA() {
    const toko = getStoreName();
    return `⚖️ *SYARAT & KETENTUAN LAYANAN (TERMS OF SERVICE)*
*${toko} - PPOB & DIGITAL GOODS*
_Terakhir Diperbarui: September 2026_

Dengan mengakses, mendaftar, mengisi saldo, atau melakukan transaksi di bot ini, Pengguna menyatakan secara *SADAR, SUKARELA, dan TANPA PAKSAAN* telah membaca, memahami, dan menyetujui seluruh ketentuan di bawah ini:

━━━━━━━━━━━━━━━━━━━━
📌 *1. KEDUDUKAN HUKUM PLATFORM*
• Platform/Bot ini bertindak semata-mata sebagai *Sistem Gerbang Otomatisasi Teknis (Technical Gateway)* yang menjembatani Pengguna dengan Biller / Server Pihak Ketiga (Digiflazz, Operator Seluler, BUMN PLN/BPJS/PDAM, Bank, dan Payment Gateway).
• Pengelola/Admin *BUKAN* operator telekomunikasi, bukan penyedia utilitas resmi negara, dan bukan lembaga perbankan.

━━━━━━━━━━━━━━━━━━━━
🎯 *2. TANGGUNG JAWAB PENGGUNA (INPUT ERROR)*
• *Kesalahan Nomor/ID Tujuan:* Seluruh data transaksi (Nomor HP, ID Pelanggan PLN/PDAM/BPJS, No Akun Game, E-Money) diinput langsung oleh Pengguna.
• Jika transaksi *SUKSES* ke nomor/ID yang salah akibat kelalaian Pengguna, maka transaksi bersifat *FINAL, SAH, dan TIDAK DAPAT DIBATALKAN / DI-REFUND* dengan alasan apa pun.
• Kerugian sepenuhnya ditanggung oleh Pengguna.

━━━━━━━━━━━━━━━━━━━━
🏢 *3. BATASAN TANGGUNG JAWAB PIHAK KETIGA (DIGIFLAZZ / PROVIDER)*
• *Gangguan & Pemeliharaan:* Keterlambatan (*delay*), gangguan server (*down*), pemeliharaan berkala (*maintenance*), atau *cut-off* sistem perbankan/PLN/Provider berada di luar kuasa hukum Pengelola.
• Pengelola dibebaskan dari segala tuntutan kerugian materiil, immateriil, atau kehilangan keuntungan (*loss of profit*) yang diakibatkan oleh gangguan provider pihak ketiga.
• *Keabsahan Serial Number (SN):* SN atau bukti transaksi diterbitkan langsung oleh Biller/Operator resmi. Jika SN telah terbit dan dinyatakan sukses oleh Biller, produk dianggap sah telah terkirim. Komplain pulsa/paket belum masuk wajib disertai pengecekan ke Call Center Operator terkait dengan menyertakan SN resmi tersebut.

━━━━━━━━━━━━━━━━━━━━
🔄 *4. KEBIJAKAN PENGEMBALIAN DANA (REFUND POLICY)*
• Refund *HANYA* dapat diproses jika status transaksi resmi dinyatakan *GAGAL (FAILED/REFUNDED)* oleh server provider Digiflazz.
• Pengembalian dana transaksi gagal akan otomatis ditambahkan ke *SALDO AKUN BOT* Pengguna (bukan transfer tunai ke rekening bank/e-wallet pribadi).
• Transaksi yang berstatus *PROSES (PENDING)* wajib menunggu konfirmasi final dari provider (maksimal 1x24 jam) sebelum dapat diajukan investigasi. Transaksi yang masih berstatus proses tidak dapat dibatalkan sepihak.

━━━━━━━━━━━━━━━━━━━━
🛡️ *5. LARANGAN PENYALAHGUNAAN & ANTI PENCUCIAN UANG*
• Dilarang keras menggunakan platform/bot ini untuk perbuatan melanggar hukum, termasuk namun tidak terbatas pada:
  a. Penipuan, pemerasan, atau transaksi ilegal.
  b. Pencucian uang (*money laundering*) atau perputaran dana judi online.
  c. Penggunaan QRIS palsu, struk manipulasi, atau eksploitasi bug sistem.
• Pengelola berhak sewaktu-waktu membekukan saldo, memblokir akun tanpa pemberitahuan, dan menyerahkan data log transaksi kepada pihak Kepolisian RI atau Penegak Hukum tanpa ganti rugi.

━━━━━━━━━━━━━━━━━━━━
⚡ *6. FORCE MAJEURE (KEADAAN MEMAKSA)*
• Pengelola dibebaskan dari tanggung jawab atas kegagalan atau keterlambatan layanan yang disebabkan oleh Keadaan Memaksa (*Force Majeure*), termasuk namun tidak terbatas pada:
  a. Pemblokiran nomor bot oleh WhatsApp / Meta Inc.
  b. Suspensi bot/server oleh Telegram Inc atau penyedia hosting/VPS.
  c. Kebijakan regulasi pemerintah, bencana alam, pemadaman listrik massal, atau serangan siber (*DDoS/hacking*).

━━━━━━━━━━━━━━━━━━━━
🤝 *7. PENYELESAIAN SENGKETA*
• Segala perselisihan diselesaikan terlebih dahulu secara musyawarah dan kekeluargaan melalui kontak Admin Layanan Pelanggan.
• Jika tidak tercapai kesepakatan, Pengguna melepaskan hak untuk menuntut secara hukum pidana maupun perdata kepada Pengelola atas hal-hal yang telah diatur dalam batas tanggung jawab di atas.

Ketik *MENU* untuk kembali bertransaksi.`;
}

/**
 * Teks Singkat Syarat & Ketentuan untuk footer / invoice transaksi
 */
function getLegalDisclaimerShort() {
    return `⚖️ _Transaksi berarti setuju S&K layanan. Salah no tujuan tanggung jawab pembeli. Info: ketik .snk_`;
}

/**
 * Teks S&K Ringkas untuk Telegram Command Center
 */
function getTermsTelegram() {
    const toko = getStoreName();
    return `⚖️ *SYARAT & KETENTUAN LAYANAN PLATFORM*
*${toko} - PPOB & Digital Goods*

*Ringkasan Batasan Tanggung Jawab Hukum:*
1. *Bukan Operator / Biller:* Platform bertindak sebagai gerbang teknis (technical gateway) ke Digiflazz & Provider.
2. *Kesalahan Input:* Transaksi sukses ke nomor/ID salah akibat kelalaian pembeli bersifat *FINAL dan TIDAK DAPAT DI-REFUND*.
3. *Provider & Gateway:* Keterlambatan akibat cut-off bank, gangguan Digiflazz, atau maintenance Biller di luar kuasa hukum Pengelola.
4. *Kebijakan Refund:* Refund otomatis hanya berlaku jika provider Digiflazz menyatakan transaksi *GAGAL*. Refund masuk ke Saldo Akun Bot.
5. *Anti Kejahatan Keuangan:* Dilarang keras menggunakan bot untuk judi online, penipuan, atau pencucian uang. Pelanggaran akan dilaporkan ke aparat berwajib.
6. *Force Majeure:* Pemblokiran nomor oleh WhatsApp/Meta atau penutupan server berada di luar tanggung jawab perdata/pidana Pengelola.

_Pengguna yang bertransaksi otomatis terikat secara sah pada ketentuan ini._`;
}

/**
 * Teks Lengkap Syarat & Ketentuan Khusus Produk Digital (Akun / Aplikasi) (.snkdigital / .digital)
 */
function getTermsDigitalWA() {
    const toko = getStoreName();
    return `⚖️ *SYARAT & KETENTUAN KHUSUS PRODUK DIGITAL (AKUN & APLIKASI)*
*${toko} - DIGITAL STORE*
_Wajib Dibaca & Dipahami Sebelum Membeli_

Membeli produk digital (Akun Streaming Netflix/Spotify/YouTube, Canva, ChatGPT, VPN, Lisensi, dll) di bot ini berarti Anda *MEMAHAMI DAN MENYETUJUI RESIKO PRODUK DIGITAL* berikut ini:

━━━━━━━━━━━━━━━━━━━━
📦 *1. ASAL USUL PRODUK (DARI SELLER LUAR)*
• Seluruh produk digital akun/lisensi didapatkan dari pihak ketiga (*seller/supplier luar*), *BUKAN* diterbitkan langsung oleh Admin.
• Harga murah yang kami tawarkan karena akun memanfaatkan program promo, trial, family sharing, atau regional rate dari provider resmi.

━━━━━━━━━━━━━━━━━━━━
⚡ *2. RESIKO SUSPEND & KEBIJAKAN SEPIHAK PROVIDER*
• Provider resmi (Netflix, Google, Spotify, OpenAI, Canva, dll) berhak sewaktu-waktu mengubah algoritma, mengakhiri promo, membatalkan langganan, atau memblokir (*suspend/hold*) akun secara sepihak tanpa pemberitahuan.
• Pembeli memahami bahwa penertiban/suspend oleh provider resmi adalah *RISIKO WAJAR PRODUK DIGITAL PROMO* yang berada di luar kendali Admin.

━━━━━━━━━━━━━━━━━━━━
📱 *3. ATURAN WAJIB 1 DEVICE (TIDAK BOLEH SHARING)*
• Akun yang dibeli *HANYA BOLEH DI-LOGIN DI 1 DEVICE (1 HP / 1 LAPTOP / 1 TV)*.
• *DILARANG KERAS:*
  a. Login di lebih dari 1 perangkat secara bersamaan.
  b. Membagikan (*sharing*) email/password ke orang lain/grup.
  c. Mengubah email, password, metode pembayaran (*billing*), profil, atau pengaturan akun.
• Pelanggaran aturan di atas akan menyebabkan akun otomatis terblokir dan *MENGHANGUSKAN SEGALA BENTUK BANTUAN/GARANSI INSTAN*.

━━━━━━━━━━━━━━━━━━━━
⏳ *4. TIDAK ADA GARANSI PERMANEN / SEUMUR HIDUP*
• *TIDAK ADA istilah akun permanen atau seumur hidup.* Semua akun digital terikat pada masa berlaku promo dan kebijakan provider.
• Tidak bergaransi permanen jika di kemudian hari terjadi suspend massal (*sweep*) oleh provider resmi.

━━━━━━━━━━━━━━━━━━━━
🛡️ *5. KEBIJAKAN GARANSI TERBATAS (FIRST LOGIN ONLY)*
• Garansi yang kami berikan *HANYA GARANSI LOGIN AWAL (FIRST LOGIN GUARANTEE)*:
  - Pembeli wajib mencoba login maksimal dalam waktu *1x24 jam* sejak akun dikirimkan oleh bot.
  - Jika saat pertama kali diterima akun salah password / tidak bisa login, silakan hubungi Admin dengan menyertakan bukti screenshot untuk diganti (*replace*).
• *SETELAH AKUN BERHASIL LOGIN PERTAMA KALI, TRANSAKSI DINYATAKAN SELESAI DAN SAH*.
• Jika di kemudian hari akun terkena suspend oleh provider sebelum durasi habis, *TIDAK ADA PENGEMBALIAN UANG (NO REFUND)*. Admin hanya akan membantu mengajukan replace ke seller luar *JIKA DAN HANYA JIKA* seller masih menyediakan garansi penggantian.

━━━━━━━━━━━━━━━━━━━━
🤝 *6. PELEPASAN TUNTUTAN HUKUM*
• Pembeli secara sadar dan sukarela membeli produk digital ini atas kehendak sendiri dengan mengetahui segala kelemahan dan resiko di atas.
• Pembeli *MELEPASKAN ADMIN DARI SEGALA BENTUK TUNTUTAN HUKUM, GANTI RUGI, LAPORAN PIDANA MAUPUN PERDATA* atas pemblokiran/suspend akun oleh pihak provider resmi.

Ketik *MENU* untuk kembali belanja.`;
}

/**
 * Teks Singkat Khusus Transaksi Produk Digital (Invoice / Konfirmasi / Pengiriman)
 */
function getTermsDigitalShort() {
    return `⚠️ *S&K PRODUK DIGITAL:* Akun promo seller (max 1 device, dilarang ubah password/profil/billing). Garansi HANYA First Login (saat pertama diterima). TIDAK ADA garansi permanen & NO REFUND jika akun tersuspend provider di kemudian hari. Beli = setuju tanpa syarat. Info: ketik .snkdigital`;
}

/**
 * Teks S&K Digital untuk Telegram Command Center
 */
function getTermsDigitalTg() {
    const toko = getStoreName();
    return `⚖️ *SYARAT & KETENTUAN KHUSUS PRODUK DIGITAL*
*${toko} - Akun Streaming & Aplikasi*

*Ringkasan Aturan Produk Digital:*
1. *Bukan Penerbit Langsung:* Akun bersumber dari seller/supplier luar memanfaatkan promo, trial, atau family sharing.
2. *Resiko Suspend Provider:* Provider resmi (Netflix, Google, Spotify, dll) berhak sewaktu-waktu menutup promo / suspend akun sepihak di luar kendali Admin.
3. *Aturan 1 Device:* Akun HANYA boleh dipakai di 1 perangkat. Dilarang multi-login atau sharing.
4. *Dilarang Utak-Atik:* Dilarang ganti email, password, metode bayar (billing), atau profil akun.
5. *Garansi Terbatas:* HANYA Garansi Login Awal (First Login maks 1x24 jam). Tidak ada garansi seumur hidup/permanen.
6. *Kebijakan Refund:* TIDAK ADA pengembalian dana (No Cash Refund) jika terjadi suspend massal di kemudian hari.
7. *Pelepasan Tuntutan:* Pembeli melepaskan Admin dari segala tuntutan hukum perdata/pidana.`;
}

module.exports = {
    getTermsAndConditionsWA,
    getLegalDisclaimerShort,
    getTermsTelegram,
    getTermsDigitalWA,
    getTermsDigitalShort,
    getTermsDigitalTg
};
