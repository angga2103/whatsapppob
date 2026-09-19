/**
 * ============================================================================
 * BRIDGE PAIRING WHATSAPP (BAILEYS) - TELEGRAM BOT
 * ============================================================================
 * Mematuhi 4 Aturan Emas Baileys Pairing Code:
 * 1. IDENTITAS BROWSER: Browsers.ubuntu('Chrome') (Desktop/Ubuntu)
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

const config = require('./config');

// 1. Inisialisasi Konfigurasi & Bot Telegram
const TELEGRAM_TOKEN = config.telegram.token || process.env.TELEGRAM_TOKEN || '';
const ADMIN_CHAT_ID = String(config.telegram.chatId || process.env.TELEGRAM_CHAT_ID || '').trim();
const SESSION_DIR = path.resolve(__dirname, 'session_bot');

if (!TELEGRAM_TOKEN || !TELEGRAM_TOKEN.includes(':')) {
    console.error('❌ TELEGRAM_TOKEN belum diatur atau tidak valid di settings.json atau .env!');
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log(`🚀 [TELEGRAM] Bridge Pairing Bot aktif! Admin ID: ${ADMIN_CHAT_ID || '(Belum Diatur di TELEGRAM_CHAT_ID)'}`);

// Tangkap error polling
bot.on('polling_error', (error) => {
    const desc = error.response?.body?.description || error.message || '';
    const code = error.code || '';
    if (code === 'EFATAL' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNRESET' || desc.includes('socket hang up') || desc.includes('ETIMEDOUT')) {
        return;
    }
    if (desc.includes('Conflict') || desc.includes('terminated by other getUpdates')) {
        console.warn('⚠️ [TELEGRAM CONFLICT]: Token bot ini sedang aktif di proses lain (409 Conflict). Pastikan hanya 1 bot yang berjalan.');
        return;
    }
    console.warn('⚠️ [TELEGRAM POLLING ERROR]:', desc || code);
});

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

// Helper: Eksekusi Pairing WhatsApp
async function executePairing(chatId, rawPhone) {
    let phone = (rawPhone || '').replace(/[^0-9]/g, '');
    if (phone.startsWith('0')) phone = '62' + phone.slice(1);

    if (!phone.startsWith('62') || phone.length < 10) {
        return bot.sendMessage(
            chatId,
            '❌ *Format nomor tidak valid!*\n\n' +
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
        `_Menyiapkan socket Baileys dan kode pairing (mohon tunggu 3-5 detik)..._`,
        { parse_mode: 'Markdown' }
    );

    try {
        cleanSession();

        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        const { version } = await fetchLatestBaileysVersion();

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

        // Jeda minimal 3000ms untuk stabilisasi koneksi WebSocket
        await new Promise((resolve) => setTimeout(resolve, 3000));

        if (!sock.authState.creds.registered) {
            const code = await sock.requestPairingCode(phone);
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
                if (statusCode === 401 || statusCode === 408) {
                    console.log('🚨 [PAIRING] Sesi ditutup oleh WhatsApp.');
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

// 2. Listener Tombol "cmd_pair_new"
bot.on('callback_query', async (query) => {
    const chatId = String(query.message?.chat?.id || query.from?.id || '');

    if (ADMIN_CHAT_ID && chatId !== ADMIN_CHAT_ID) {
        return bot.answerCallbackQuery(query.id, { 
            text: `❌ Akses ditolak! Chat ID Anda (${chatId}) tidak cocok dengan ADMIN_CHAT_ID (${ADMIN_CHAT_ID}).`, 
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

// 3. Listener Pesan Teks
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    if (!text) return;

    // Cek ID (selalu diizinkan agar admin tahu Chat ID miliknya)
    if (/^\/id(@\w+)?$/i.test(text)) {
        return bot.sendMessage(chatId, `🆔 *Chat ID Telegram Anda:* \`${chatId}\``, { parse_mode: 'Markdown' });
    }

    // Validasi Keamanan
    if (!ADMIN_CHAT_ID) {
        return bot.sendMessage(
            chatId,
            `⚠️ *TELEGRAM_CHAT_ID BELUM DIATUR*\n\n` +
            `Chat ID Anda: \`${chatId}\`\n\n` +
            `Silakan masukkan ke file \`.env\`:\n\`TELEGRAM_CHAT_ID=${chatId}\`\nLalu restart bot.`,
            { parse_mode: 'Markdown' }
        );
    }

    if (chatId !== ADMIN_CHAT_ID) {
        console.warn(`[SECURITY] Pesan dari Chat ID ${chatId} ditolak (Admin: ${ADMIN_CHAT_ID})`);
        return bot.sendMessage(
            chatId,
            `❌ *Akses Ditolak!*\n\n` +
            `Chat ID Anda: \`${chatId}\`\n` +
            `Chat ID Admin di .env: \`${ADMIN_CHAT_ID}\`\n\n` +
            `Sesuaikan \`TELEGRAM_CHAT_ID=${chatId}\` di file \`.env\` jika ini akun Anda.`,
            { parse_mode: 'Markdown' }
        );
    }

    // Menu /start
    if (/^\/start(@\w+)?$/i.test(text) || /^\/help(@\w+)?$/i.test(text)) {
        return bot.sendMessage(
            chatId,
            '🤖 *BRIDGE PAIRING BOT WHATSAPP*\n\n' +
            'Perintah tersedia:\n' +
            '• `/pair` - Minta input nomor WhatsApp\n' +
            '• `/pair 628xxx` - Langsung proses kode pairing\n' +
            '• `/id` - Cek ID Telegram Anda\n\n' +
            'Atau klik tombol di bawah:',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '📱 TAUTKAN NOMOR BARU', callback_data: 'cmd_pair_new' }]]
                }
            }
        );
    }

    // Perintah /pair atau /pair 628xxx
    const pairMatch = text.match(/^\/pair(@\w+)?(?:\s+(.+))?$/i);
    if (pairMatch) {
        const argPhone = pairMatch[2] ? pairMatch[2].trim() : '';
        if (argPhone) {
            return executePairing(chatId, argPhone);
        } else {
            userState.awaitingNumber = true;
            return bot.sendMessage(
                chatId,
                '📱 *TAUTKAN NOMOR WHATSAPP BARU*\n\n' +
                'Ketik dan kirimkan nomor WhatsApp Anda dengan awalan *62*:\n' +
                'Contoh: `6281234567890`',
                { parse_mode: 'Markdown' }
            );
        }
    }

    // Input nomor saat awaitingNumber
    if (userState.awaitingNumber) {
        return executePairing(chatId, text);
    }
});

console.log('✅ Bridge siap digunakan. Kirim /pair di Telegram atau klik tombol Tautkan Nomor Baru.');
