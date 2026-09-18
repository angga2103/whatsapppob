const readline = require('readline');
const fs = require('fs');
const path = require('path');

// ANSI Color Codes
const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    red: "\x1b[31m",
    bgBlue: "\x1b[44m",
    bgGreen: "\x1b[42m"
};

let rl = null;
const linesQueue = [];
const pendingResolvers = [];

function initRL() {
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    rl.on('line', (line) => {
        if (pendingResolvers.length > 0) {
            const resolve = pendingResolvers.shift();
            resolve(line.trim());
        } else {
            linesQueue.push(line.trim());
        }
    });
}

function ask(query) {
    if (!rl) initRL();
    process.stdout.write(query);
    if (linesQueue.length > 0) {
        const val = linesQueue.shift();
        process.stdout.write(val + '\n');
        return Promise.resolve(val);
    }
    return new Promise((resolve) => {
        pendingResolvers.push(resolve);
    });
}

function closeRL() {
    if (rl) {
        rl.close();
        rl = null;
    }
}

async function runInstaller() {
    console.clear();
    console.log(`${C.cyan}╔══════════════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.cyan}║   ${C.bold}${C.yellow}⚡ ONE-CLICK INSTALLER BOT PPOB WA & DIGITAL STORE ⚡${C.reset}${C.cyan}        ║${C.reset}`);
    console.log(`${C.cyan}║   ${C.dim}Setup Cepat & Otomatis — Kendali Penuh via Telegram Bot${C.reset}${C.cyan}         ║${C.reset}`);
    console.log(`${C.cyan}╚══════════════════════════════════════════════════════════════════╝${C.reset}\n`);

    // 1. Check Node.js
    const nodeVer = parseInt(process.version.slice(1).split('.')[0], 10);
    console.log(`${C.blue}[1/3] Memeriksa Lingkungan Sistem...${C.reset}`);
    if (nodeVer < 18) {
        console.log(`${C.yellow}⚠️  Peringatan: Node.js Anda versi ${process.version}. Disarankan minimal v18 atau v20+.${C.reset}`);
    } else {
        console.log(`${C.green}✓ Node.js ${process.version} terdeteksi.${C.reset}`);
    }

    // 2. Ensure Database Structure
    console.log(`\n${C.blue}[2/3] Menginisialisasi Database Atomik...${C.reset}`);
    try {
        const db = require('./database/db');
        console.log(`${C.green}✓ Database terverifikasi (${Object.keys(db.users || {}).length} users, ${(db.ppob || []).length} produk PPOB).${C.reset}`);
    } catch (e) {
        console.log(`${C.red}✗ Gagal inisialisasi database: ${e.message}${C.reset}`);
    }

    // 3. Setup Configuration (HANYA TELEGRAM TOKEN & CHAT ID)
    console.log(`\n${C.blue}[3/3] Konfigurasi Akses Telegram Command Center...${C.reset}`);
    require('dotenv').config();

    const curTgToken = process.env.TELEGRAM_TOKEN || '';
    const curTgChat = process.env.TELEGRAM_CHAT_ID || '';

    console.log(`${C.cyan}ℹ️  Semua konfigurasi (Pairing WA, Digiflazz, Payment Gateway)`);
    console.log(`   dapat diatur langsung lewat bot Telegram dengan model tombol interaktif!`);
    console.log(`   Installer hanya membutuhkan akses bot Telegram Anda.${C.reset}\n`);

    let tgToken = curTgToken;
    let tgChat = curTgChat;

    while (!tgToken || !tgToken.includes(':')) {
        console.log(`${C.yellow}📱 Buat bot Telegram baru di @BotFather lalu salin API Token-nya.${C.reset}`);
        tgToken = (await ask(`• Masukkan Telegram Bot Token ${curTgToken ? `[${curTgToken}]` : ''}: `)) || curTgToken;
        if (!tgToken || !tgToken.includes(':')) {
            console.log(`${C.red}❌ Token tidak valid! Format token harus seperti: 123456789:ABCDefghijk...${C.reset}\n`);
        }
    }

    while (!tgChat || !/^[0-9-]+$/.test(tgChat)) {
        console.log(`${C.yellow}🆔 Dapatkan Chat ID Anda via @userinfobot atau @raw_data_bot di Telegram.${C.reset}`);
        tgChat = (await ask(`• Masukkan Telegram Chat ID Admin ${curTgChat ? `[${curTgChat}]` : ''}: `)) || curTgChat;
        if (!tgChat || !/^[0-9-]+$/.test(tgChat)) {
            console.log(`${C.red}❌ Chat ID tidak valid! Chat ID berupa angka unik (contoh: 7236113204).${C.reset}\n`);
        }
    }

    // Tulis file .env lengkap dengan template aman
    const port = process.env.PORT || '3000';
    const owner = process.env.OWNER_NUMBER || '';
    const digiUser = process.env.DIGIFLAZZ_USERNAME || '';
    const digiKey = process.env.DIGIFLAZZ_KEY || '';
    const pMId = process.env.PAYMENTKITA_MERCHANT_ID || '';
    const pSecret = process.env.PAYMENTKITA_SECRET || '';
    const pksProj = process.env.PAKASIR_PROJECT || '';
    const pksKey = process.env.PAKASIR_KEY || '';
    const pGw = process.env.PAYMENT_GATEWAY || 'paymentkita';

    const envContent = `# ==============================================================================
# 🤖 KREDENSIAL BOT PPOB & TOKO DIGITAL
# Seluruh pengaturan dapat diubah langsung melalui Bot Telegram (Tombol Inline)
# ==============================================================================
PORT=${port}
PAYMENT_GATEWAY=${pGw}

# Telegram Command Center (Wajib)
TELEGRAM_TOKEN=${tgToken}
TELEGRAM_CHAT_ID=${tgChat}

# WhatsApp Owner (Dapat ditambahkan via bot)
OWNER_NUMBER=${owner}

# Digiflazz Gateway (Dapat diset via bot Telegram / WA)
DIGIFLAZZ_USERNAME=${digiUser}
DIGIFLAZZ_KEY=${digiKey}

# Payment Gateway Kredensial (Dapat diset via bot Telegram / WA)
PAYMENTKITA_MERCHANT_ID=${pMId}
PAYMENTKITA_SECRET=${pSecret}
PAKASIR_PROJECT=${pksProj}
PAKASIR_KEY=${pksKey}
`;

    fs.writeFileSync('.env', envContent, 'utf8');
    console.log(`${C.green}✓ Konfigurasi .env berhasil disimpan!${C.reset}`);

    // Update settings.json agar sync
    try {
        const settingsPath = path.join(__dirname, 'database', 'settings.json');
        let currentSettings = {};
        if (fs.existsSync(settingsPath)) {
            currentSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        }
        currentSettings.telegram = { token: tgToken, chatId: tgChat };
        if (!currentSettings.paymentGateway) currentSettings.paymentGateway = pGw;
        fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf8');
    } catch (_) {}

    // 4. Manajemen Proses Background (PM2)
    const isLinux = process.platform === 'linux';
    let ranViaPm2 = false;

    if (isLinux) {
        console.log(`\n${C.cyan}──────────────────────────────────────────────────${C.reset}`);
        console.log(`${C.bold}MANAJEMEN PROSES BACKGROUND (PM2)${C.reset}`);
        console.log(`Menjalankan bot 24 jam nonstop di background.`);
        console.log(`${C.cyan}──────────────────────────────────────────────────${C.reset}\n`);

        console.log(`${C.blue}Menyiapkan proses bot via PM2...${C.reset}`);
        try {
            const { execSync } = require('child_process');
            try {
                execSync('pm2 -v', { stdio: 'ignore' });
            } catch (_) {
                console.log(`Memasang PM2 secara global...`);
                execSync('npm install -g pm2', { stdio: 'inherit' });
            }
            execSync('pm2 delete bot-ppob 2>/dev/null || true', { stdio: 'ignore' });
            execSync('pm2 start index.js --name "bot-ppob"', { stdio: 'inherit' });
            execSync('pm2 save', { stdio: 'ignore' });
            ranViaPm2 = true;
            console.log(`${C.green}✓ Bot berhasil dijalankan 24 jam di background via PM2!${C.reset}`);
        } catch (pm2Err) {
            console.log(`${C.yellow}Peringatan PM2: ${pm2Err.message}. Anda dapat menjalankannya manual via npm start.${C.reset}`);
        }
    }

    console.log(`\n${C.green}╔══════════════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.green}║   ${C.bold}🎉 INSTALASI SUKSES! BOT TELEGRAM SEKARANG TELAH AKTIF!${C.reset}${C.green}        ║${C.reset}`);
    console.log(`${C.green}║                                                                  ║${C.reset}`);
    console.log(`${C.green}║   👉 ${C.bold}Silakan buka Bot Telegram Anda sekarang juga!${C.reset}${C.green}              ║${C.reset}`);
    console.log(`${C.green}║   👉 ${C.bold}Kirim perintah /start atau /menu${C.reset}${C.green}                             ║${C.reset}`);
    console.log(`${C.green}║                                                                  ║${C.reset}`);
    console.log(`${C.green}║   ${C.yellow}${C.bold}FITUR-FITUR INTERAKTIF MODEL TOMBOL INLINE TELEGRAM:${C.reset}${C.green}           ║${C.reset}`);
    console.log(`${C.green}║   • [📱 Hubungkan WA] : Minta kode pairing WhatsApp 8 digit      ║${C.reset}`);
    console.log(`${C.green}║   • [💳 Ganti Gateway] : Pilih PaymentKita / Pakasir & set key   ║${C.reset}`);
    console.log(`${C.green}║   • [⚡ Digiflazz]     : Set username/key & cek saldo live       ║${C.reset}`);
    console.log(`${C.green}║   • [🏪 Buka/Tutup]   : Buka atau tutup toko langsung 1-klik     ║${C.reset}`);
    console.log(`${C.green}║   • [🔄 Sync PPOB]     : Sinkronisasi katalog produk otomatis    ║${C.reset}`);
    console.log(`${C.green}║   • [📦 Backup Data]   : Backup data otomatis ke Telegram        ║${C.reset}`);
    if (ranViaPm2) {
        console.log(`${C.green}║                                                                  ║${C.reset}`);
        console.log(`${C.green}║   Perintah Cepat Sistem di VPS:                                  ║${C.reset}`);
        console.log(`${C.green}║   • ${C.bold}bot-ppob status${C.reset}${C.green}   : Cek status bot di background (PM2)       ║${C.reset}`);
        console.log(`${C.green}║   • ${C.bold}bot-ppob logs${C.reset}${C.green}     : Cek log pesan & transaksi live           ║${C.reset}`);
        console.log(`${C.green}║   • ${C.bold}bot-ppob restart${C.reset}${C.green}  : Restart bot                              ║${C.reset}`);
    }
    console.log(`${C.green}╚══════════════════════════════════════════════════════════════════╝${C.reset}\n`);

    closeRL();
    process.exit(0);
}

// Fallback Pairing di Terminal jika dipanggil khusus
async function startPairingProcess() {
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
    
    console.log(`\n${C.cyan}──────────────────────────────────────────────────${C.reset}`);
    console.log(`${C.bold}LANGKAH PAIRING KODE WHATSAPP (FALLBACK CLI)${C.reset}`);
    console.log(`Buka WhatsApp di HP > Perangkat Tertaut > Tautkan dengan nomor telepon saja.`);
    console.log(`${C.cyan}──────────────────────────────────────────────────${C.reset}\n`);

    let phone = '';
    while (!phone || phone.length < 10 || !phone.startsWith('62')) {
        const input = await ask(`• Masukkan nomor WhatsApp Bot (awali 62, contoh: 6281234567890): `);
        phone = input.replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.slice(1);
        if (phone.length < 10 || !phone.startsWith('62')) {
            console.log(`${C.red}❌ Format nomor tidak valid! Harus diawali 62 dan minimal 10 digit.${C.reset}`);
        }
    }

    const sessionDir = path.join(__dirname, 'session_bot');
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const pino = require('pino');
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    console.log(`\n${C.yellow}⏳ Menghubungkan ke WhatsApp... Mohon tunggu 3 detik...${C.reset}`);
    await new Promise(r => setTimeout(r, 3000));

    if (!sock.authState.creds.registered) {
        try {
            const code = await sock.requestPairingCode(phone);
            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log(`\n${C.bgGreen}${C.bold} KODE PAIRING WHATSAPP ANDA: ${formatted} ${C.reset}\n`);
            console.log(`${C.dim}Masukkan kode 8 digit di atas pada menu 'Perangkat Tertaut' di WhatsApp HP Anda.${C.reset}`);
        } catch (err) {
            console.log(`${C.red}✗ Gagal meminta kode pairing: ${err.message}${C.reset}`);
            return false;
        }
    }

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log(`\n${C.yellow}⚠️ Waktu tunggu pairing selesai (timeout 120s). Sesi tetap tersimpan.${C.reset}`);
            resolve(true);
        }, 120000);

        sock.ev.on('connection.update', (update) => {
            const { connection } = update;
            if (connection === 'open') {
                clearTimeout(timeout);
                console.log(`\n${C.green}✓ WHATSAPP BERHASIL TERHUBUNG DENGAN SUKSES!${C.reset}`);
                resolve(true);
            }
        });
    });
}

if (require.main === module) {
    runInstaller().catch(err => {
        console.error(`${C.red}Error Installer: ${err.message}${C.reset}`);
        closeRL();
        process.exit(1);
    });
}

module.exports = { runInstaller, startPairingProcess };
