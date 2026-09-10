const readline = require('readline');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

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

function ask(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.trim());
    }));
}

async function runInstaller() {
    console.clear();
    console.log(`${C.cyan}╔══════════════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.cyan}║   ${C.bold}${C.yellow}⚡ ONE-CLICK INSTALLER BOT PPOB WA & DIGITAL STORE ⚡${C.reset}${C.cyan}        ║${C.reset}`);
    console.log(`${C.cyan}║   ${C.dim}Automated Setup, Configuration & Interactive WhatsApp Pairing${C.reset}${C.cyan}  ║${C.reset}`);
    console.log(`${C.cyan}╚══════════════════════════════════════════════════════════════════╝${C.reset}\n`);

    // 1. Check Node.js
    const nodeVer = parseInt(process.version.slice(1).split('.')[0], 10);
    console.log(`${C.blue}[1/4] Memeriksa Lingkungan Sistem...${C.reset}`);
    if (nodeVer < 18) {
        console.log(`${C.yellow}⚠️  Peringatan: Node.js Anda versi ${process.version}. Disarankan minimal v18 atau v20+.${C.reset}`);
    } else {
        console.log(`${C.green}✓ Node.js ${process.version} terdeteksi.${C.reset}`);
    }

    // 2. Ensure Database Structure
    console.log(`\n${C.blue}[2/4] Menginisialisasi Database Atomik...${C.reset}`);
    try {
        const db = require('./database/db');
        console.log(`${C.green}✓ Database terverifikasi (${Object.keys(db.users).length} users, ${db.ppob.length} produk PPOB).${C.reset}`);
    } catch (e) {
        console.log(`${C.red}✗ Gagal inisialisasi database: ${e.message}${C.reset}`);
    }

    // 3. Setup Configuration (.env)
    console.log(`\n${C.blue}[3/4] Konfigurasi Kredensial Bot (.env)...${C.reset}`);
    require('dotenv').config();
    const envExists = fs.existsSync('.env');

    if (envExists) {
        console.log(`${C.green}✓ File .env sudah ada.${C.reset}`);
        const setupAgain = await ask(`${C.yellow}Apakah Anda ingin memperbarui kredensial sekarang? (y/N): ${C.reset}`);
        if (setupAgain.toLowerCase() === 'y') {
            await promptConfig();
        }
    } else {
        console.log(`${C.yellow}File .env belum ditemukan. Memulai wizard konfigurasi...${C.reset}`);
        await promptConfig();
    }

    // 4. WhatsApp Pairing Wizard
    console.log(`\n${C.blue}[4/4] Proses Pairing WhatsApp Bot...${C.reset}`);
    const sessionDir = path.join(__dirname, 'session_bot');
    const hasSession = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;

    if (hasSession) {
        console.log(`${C.green}✓ Folder sesi session_bot terdeteksi.${C.reset}`);
        const rePair = await ask(`${C.yellow}Apakah Anda ingin mereset sesi dan melakukan pairing baru? (y/N): ${C.reset}`);
        if (rePair.toLowerCase() === 'y') {
            console.log(`${C.yellow}Menghapus sesi lama...${C.reset}`);
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log(`${C.green}✓ Sesi lama berhasil dibersihkan.${C.reset}`);
                await startPairingProcess();
            } catch (err) {
                console.log(`${C.red}Gagal menghapus sesi: ${err.message}${C.reset}`);
            }
        } else {
            console.log(`${C.green}✓ Menggunakan sesi yang sudah ada.${C.reset}`);
        }
    } else {
        await startPairingProcess();
    }

    console.log(`\n${C.green}╔══════════════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.green}║   ${C.bold}🎉 INSTALASI & SETUP BOT SELESAI DENGAN SUKSES!${C.reset}${C.green}               ║${C.reset}`);
    console.log(`${C.green}║                                                                  ║${C.reset}`);
    console.log(`${C.green}║   Untuk menjalankan bot:                                         ║${C.reset}`);
    console.log(`${C.green}║   👉 ${C.bold}npm start${C.reset}${C.green}  atau  ${C.bold}node index.js${C.reset}${C.green}                              ║${C.reset}`);
    console.log(`${C.green}║                                                                  ║${C.reset}`);
    console.log(`${C.green}║   Semua pengaturan (profit, API key, dll.) dapat diubah          ║${C.reset}`);
    console.log(`${C.green}║   langsung melalui chat WhatsApp dengan ketik: ${C.bold}.admin${C.reset}${C.green}            ║${C.reset}`);
    console.log(`${C.green}╚══════════════════════════════════════════════════════════════════╝${C.reset}\n`);
    process.exit(0);
}

async function promptConfig() {
    const curPort = process.env.PORT || '3000';
    const curOwner = process.env.OWNER_NUMBER || '6281234567890';
    const curDigiUser = process.env.DIGIFLAZZ_USERNAME || 'wulilio6xBvW';
    const curDigiKey = process.env.DIGIFLAZZ_KEY || '32d4d136-84de-549a-9870-3f7e873e2cd8';
    const curMId = process.env.PAYMENTKITA_MERCHANT_ID || 'PKM78524949';
    const curMSecret = process.env.PAYMENTKITA_SECRET || 'PKSK_cEeTfLiVKc9tEESTnOmnyCoDB2GnYr8OF9ClcJ8V';
    const curTgToken = process.env.TELEGRAM_TOKEN || '';
    const curTgChat = process.env.TELEGRAM_CHAT_ID || '';

    console.log(`\n${C.cyan}Tekan [ENTER] langsung untuk menggunakan nilai default/saat ini.${C.reset}\n`);

    const port = (await ask(`• Port Server [${curPort}]: `)) || curPort;
    const owner = (await ask(`• Nomor WA Owner / Admin (Contoh: 6281234567890) [${curOwner}]: `)) || curOwner;
    const digiUser = (await ask(`• Digiflazz Username [${curDigiUser}]: `)) || curDigiUser;
    const digiKey = (await ask(`• Digiflazz API Key [${curDigiKey}]: `)) || curDigiKey;
    const pMId = (await ask(`• PaymentKita Merchant ID [${curMId}]: `)) || curMId;
    const pSecret = (await ask(`• PaymentKita Secret [${curMSecret}]: `)) || curMSecret;
    const tgToken = (await ask(`• Telegram Bot Token (Opsional) [${curTgToken || '-'}]: `)) || curTgToken;
    const tgChat = (await ask(`• Telegram Chat ID (Opsional) [${curTgChat || '-'}]: `)) || curTgChat;

    const envContent = `# Kredensial Bot PPOB & Toko Digital
PORT=${port}

# WhatsApp Owner
OWNER_NUMBER=${owner}

# Digiflazz Gateway
DIGIFLAZZ_USERNAME=${digiUser}
DIGIFLAZZ_KEY=${digiKey}

# PaymentKita Gateway
PAYMENTKITA_MERCHANT_ID=${pMId}
PAYMENTKITA_SECRET=${pSecret}

# Telegram Command Center (Opsional)
TELEGRAM_TOKEN=${tgToken}
TELEGRAM_CHAT_ID=${tgChat}
`;

    fs.writeFileSync('.env', envContent, 'utf8');
    console.log(`${C.green}✓ File .env berhasil disimpan!${C.reset}`);
}

async function startPairingProcess() {
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
    
    console.log(`\n${C.cyan}──────────────────────────────────────────────────${C.reset}`);
    console.log(`${C.bold}LANGKAH PAIRING KODE WHATSAPP${C.reset}`);
    console.log(`Pastikan nomor WhatsApp Anda aktif dan siap menerima kode pairing.`);
    console.log(`${C.cyan}──────────────────────────────────────────────────${C.reset}\n`);

    let phone = await ask(`${C.yellow}👉 Masukkan Nomor WhatsApp Bot (Contoh: 6281234567890): ${C.reset}`);
    phone = phone.replace(/[^0-9]/g, '');
    if (phone.startsWith('0')) phone = '62' + phone.slice(1);

    if (!phone || phone.length < 10) {
        console.log(`${C.red}Nomor tidak valid. Gunakan format internasional (awalan 62).${C.reset}`);
        return;
    }

    console.log(`\n${C.blue}⏳ Menghubungkan ke server WhatsApp dan meminta kode pairing...${C.reset}`);

    const { state, saveCreds } = await useMultiFileAuthState('session_bot');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        try {
            await new Promise(r => setTimeout(r, 2000));
            const code = await sock.requestPairingCode(phone);
            const formatted = code?.match(/.{1,4}/g)?.join(' - ') || code;

            console.log(`\n${C.yellow}╔═════════════════════════════════════════════════════════════╗${C.reset}`);
            console.log(`${C.yellow}║                   ${C.bold}KODE PAIRING WHATSAPP ANDA${C.reset}${C.yellow}                ║${C.reset}`);
            console.log(`${C.yellow}║                                                             ║${C.reset}`);
            console.log(`${C.yellow}║                 ${C.bold}${C.bgGreen}  [ ${formatted} ]  ${C.reset}${C.yellow}                  ║${C.reset}`);
            console.log(`${C.yellow}║                                                             ║${C.reset}`);
            console.log(`${C.yellow}║  ${C.cyan}CARA TAUTKAN DI HP:${C.reset}${C.yellow}                                        ║${C.reset}`);
            console.log(`${C.yellow}║  1. Buka aplikasi WhatsApp di HP Anda                       ║${C.reset}`);
            console.log(`${C.yellow}║  2. Buka menu titik 3 (kanan atas) > ${C.bold}Perangkat tertaut${C.reset}${C.yellow}      ║${C.reset}`);
            console.log(`${C.yellow}║  3. Ketuk ${C.bold}Tautkan Perangkat${C.reset}${C.yellow}                                 ║${C.reset}`);
            console.log(`${C.yellow}║  4. Pilih ${C.bold}"Tautkan dengan nomor telepon saja"${C.reset}${C.yellow}              ║${C.reset}`);
            console.log(`${C.yellow}║  5. Masukkan 8 digit kode di atas                           ║${C.reset}`);
            console.log(`${C.yellow}╚═════════════════════════════════════════════════════════════╝${C.reset}\n`);
            console.log(`${C.dim}Menunggu Anda memasukkan kode di HP... (Masa aktif kode: ~2 menit)${C.reset}`);
        } catch (err) {
            console.log(`${C.red}✗ Gagal meminta kode pairing: ${err.message}${C.reset}`);
            return;
        }
    }

    return new Promise(resolve => {
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                console.log(`\n${C.green}✅ BERHASIL TERHUBUNG DENGAN WHATSAPP!${C.reset}`);
                console.log(`${C.green}Akun: ${sock.user?.id?.split(':')[0] || phone}${C.reset}`);
                await sock.end();
                resolve();
            } else if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode && statusCode !== 401) {
                    // Temporary disconnect during pairing
                }
            }
        });
    });
}

runInstaller().catch(err => {
    console.error("\n[INSTALLER ERROR]", err.message);
    process.exit(1);
});
