/**
 * ============================================================================
 * BRIDGE PAIRING WHATSAPP (BAILEYS) - TELEGRAM BOT
 * ============================================================================
 * Mematuhi 4 Aturan Emas Baileys Pairing Code:
 * 1. IDENTITAS BROWSER: Browsers.ubuntu('Chrome') (Desktop/Ubuntu, bukan mobile)
 * 2. MATIKAN QR: printQRInTerminal: false
 * 3. JEDA EKSEKUSI: Minimal 3000ms setelah makeWASocket sebelum requestPairingCode
 * 4. VALIDASI STATE: Hanya panggil jika !sock.authState.creds.registered
 * ============================================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    Browsers, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// 1. Inisialisasi Konfigurasi & Bot Telegram
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SESSION_DIR = path.resolve(__dirname, 'session_bot');

if (!TELEGRAM_TOKEN || !TELEGRAM_TOKEN.includes(':')) {
    console.error('❌ TELEGRAM_TOKEN tidak valid di file .env!');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('🚀 [TELEGRAM] Bridge Pairing Bot aktif dan mendengarkan...');

// State Management
const userState = {
    awaitingNumber: false,
    activeSock: null
};

// Helper: Bersihkan session lama agar handshake fresh
function cleanSession() {
    try {
        if (userState.activeSock) {
            try { userState.activeSock.end(); } catch (_) {}
            userState.activeSock = null;
        }
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        }
    } catch (err) {
        console.warn('⚠️ Gagal membersihkan session lama:', err.message);
    }
}

// 2. Listener Tombol "cmd_pair_new"
bot.on('callback_query', async (query) => {
    const chatId = String(query.message?.chat?.id || query.from?.id || '');

    // Keamanan: Cek Chat ID Admin jika disetel
    if (ADMIN_CHAT_ID && chatId !== String(ADMIN_CHAT_ID)) {
        return bot.answerCallbackQuery(query.id, { 
            text: '❌ Akses ditolak! Anda bukan Administrator.', 
            show_alert: true 
        });
    }

    if (query.data === 'cmd_pair_new') {
        bot.answerCallbackQuery(query.id);
        userState.awaitingNumber = true;

        await bot.sendMessage(
            chatId,
            '📱 *TAUTKAN NOMOR WHATSAPP BARU*\n\n' +
            'Silakan balas pesan ini dengan nomor WhatsApp Anda.\n' +
            'Gunakan awalan *62* tanpa spasi atau simbol.\n\n' +
            'Contoh: `6281234567890`',
            { parse_mode: 'Markdown' }
        );
    }
});

// Perintah /pair langsung via chat
bot.onText(/\/pair/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (ADMIN_CHAT_ID && chatId !== String(ADMIN_CHAT_ID)) return;

    userState.awaitingNumber = true;
    await bot.sendMessage(
        chatId,
        '📱 *TAUTKAN NOMOR WHATSAPP BARU*\n\n' +
        'Ketik dan kirimkan nomor WhatsApp Anda dengan awalan *62*:\n' +
        'Contoh: `6281234567890`',
        { parse_mode: 'Markdown' }
    );
});

// 3. Listener Pesan Nomor WhatsApp
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    if (ADMIN_CHAT_ID && chatId !== String(ADMIN_CHAT_ID)) return;

    const text = (msg.text || '').trim();

    // Hanya proses jika user sedang dalam status menunggu input nomor
    if (userState.awaitingNumber) {
        let phone = text.replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.slice(1);

        if (!phone.startsWith('62') || phone.length < 10) {
            return bot.sendMessage(
                chatId,
                '❌ *Format nomor tidak valid!*\n' +
                'Nomor harus diawali *62* dan minimal 10 digit (contoh: `6281234567890`).\n\n' +
                'Silakan ketik ulang nomor WhatsApp Anda:',
                { parse_mode: 'Markdown' }
            );
        }

        userState.awaitingNumber = false;

        await bot.sendMessage(
            chatId,
            `⏳ *Menghubungkan ke server WhatsApp...*\n\n` +
            `Nomor target: \`${phone}\`\n` +
            `_Menyiapkan socket dan kode pairing (mohon tunggu 3-5 detik)..._`,
            { parse_mode: 'Markdown' }
        );

        try {
            // Bersihkan sesi lama untuk handshake baru
            cleanSession();

            const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
            const { version } = await fetchLatestBaileysVersion();

            // ATURAN EMAS 1 & 2: Identitas Desktop & Matikan QR
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

            userState.activeSock = sock;
            sock.ev.on('creds.update', saveCreds);

            // ATURAN EMAS 3: Jeda minimal 3000ms untuk stabilisasi socket
            await new Promise((resolve) => setTimeout(resolve, 3000));

            // ATURAN EMAS 4: Validasi state sebelum request pairing
            if (!sock.authState.creds.registered) {
                const code = await sock.requestPairingCode(phone);
                // Format kode: XXXX-XXXX
                const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;

                console.log(`[PAIRING] Kode berhasil dibuat untuk ${phone}: ${formattedCode}`);

                await bot.sendMessage(
                    chatId,
                    `🔑 *KODE PAIRING WHATSAPP:*\n\n` +
                    `👉 \`${formattedCode}\` 👈\n\n` +
                    `📱 *Langkah Menautkan di HP:*\n` +
                    `1. Buka aplikasi WhatsApp di HP Anda\n` +
                    `2. Ketuk menu titik 3 (kanan atas) > *Perangkat tertaut*\n` +
                    `3. Ketuk *Tautkan Perangkat*\n` +
                    `4. Pilih menu *"Tautkan dengan nomor telepon saja"*\n` +
                    `5. Masukkan 8 digit kode: \`${formattedCode}\`\n\n` +
                    `⏳ _Menunggu verifikasi WhatsApp di HP Anda (Kode aktif ~120 detik)..._`,
                    { parse_mode: 'Markdown' }
                );
            }

            // Pantau status koneksi hingga berhasil terhubung
            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection === 'open') {
                    console.log('✅ [PAIRING] WhatsApp Berhasil Terhubung!');
                    await bot.sendMessage(
                        chatId,
                        `✅ *WHATSAPP BERHASIL TERHUBUNG!*\n\n` +
                        `Akun WhatsApp \`${phone}\` telah resmi terhubung dengan sistem bot dan siap digunakan.`,
                        { parse_mode: 'Markdown' }
                    );
                } else if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    
                    if (!shouldReconnect) {
                        console.log('🚨 [PAIRING] Sesi ditutup atau ditolak oleh server WhatsApp.');
                    }
                }
            });

        } catch (err) {
            console.error('❌ [PAIRING ERROR]:', err);
            await bot.sendMessage(
                chatId,
                `❌ *Gagal Mendapatkan Kode Pairing!*\n\n` +
                `Penyebab: \`${err.message}\`\n\n` +
                `Silakan ulangi proses dengan menekan tombol di bawah:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔄 Coba Tautkan Ulang', callback_data: 'cmd_pair_new' }]]
                    }
                }
            );
        }
    }
});

console.log('✅ Bridge siap digunakan. Kirim /pair di Telegram atau kirim tombol callback cmd_pair_new.');
