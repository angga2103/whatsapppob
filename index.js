const { addLog } = require('./lib/logger');


// ANTI DOUBLE TRANSACTION
global.transactionLock = global.transactionLock || {};

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const config = require('./config');
const db = require('./database/db');
const api = require('./lib/api');
const marginHelper = require('./lib/margin');
const analytics = require('./lib/analytics');
const { formatRupiah, getTanggal, getTanggalLengkap, formatPlnToken } = require('./lib/utils');
const { handleAdmin } = require('./handlers/admin');
const { handleUser, S } = require('./handlers/user');



const ALERT_FILE = './system/alert-state.json';

function loadAlertState() {

    try {

        if (!fs.existsSync(ALERT_FILE)) {

            return {
                reconnectSent:false
            };

        }

        return JSON.parse(
            fs.readFileSync(ALERT_FILE)
        );

    } catch {

        return {
            reconnectSent:false
        };

    }

}

function saveAlertState(data) {
    fs.mkdirSync('./system', {
        recursive: true
    });

    fs.writeFileSync(
        ALERT_FILE,
        JSON.stringify(data, null, 2)
    );
}


process.on('uncaughtException', err => {

    console.error('Caught exception:', err);

    fs.appendFileSync(
        'error.log',
        '\n\n' +
        new Date().toISOString() +
        '\n' +
        (err.stack || err)
    );
});
process.on('unhandledRejection', err => {

    console.error('Unhandled rejection:', err);

    fs.appendFileSync(
        'error.log',
        '\n\n' +
        new Date().toISOString() +
        '\n' +
        (err.stack || err)
    );
});
const userSessions = new Map();
const activeCheckers = new Map();
const activeTransactions = new Set();
const spamDelay = new Map();

let currentSock = null;

// ================================
// DIGIFLAZZ RETRY CONFIG
// ================================
const MAX_DIGI_RETRY = 3;
const DIGI_RETRY_DELAY = 5000;

// ================================
// ADMIN ALERT
// ================================
async function notifyAdmin(sock, message) {
    for (const owner of config.owner) {
        await sock.sendMessage(owner, {
            text: `🚨 *SYSTEM ALERT*\n\n${message}`
        }).catch(() => {});
    }
}

// ================================
// SAFE DIGIFLAZZ HIT
// ================================
async function safeHitDigiflazz(sock, order) {

    let retry = 0;
    let lastError = null;

    while (retry < MAX_DIGI_RETRY) {

        try {

            console.log(
                `[DIGIFLAZZ] Attempt ${retry + 1} -> ${order.id}`
            );

            let hit;
            if (order.isPasca) {
                const postpaid = require('./lib/postpaid');
                // KRUSIAL: Pada Digiflazz pay-pasca, ref_id WAJIB identik dengan ref_id saat inq-pasca!
                let pascaRef = order.digiflazz_oid || order.inquiry_ref || order.ref_id;
                if (!pascaRef) {
                    console.log(`[DIGIFLAZZ PASCA] Tidak ada ref_id inquiry untuk order ${order.id}. Menjalankan auto-inquiry...`);
                    const inqRes = await postpaid.inquiry(order.sku, order.target, `INQ-${order.id}`);
                    if (inqRes && inqRes.data && (inqRes.data.status === 'Sukses' || inqRes.data.rc === '00')) {
                        pascaRef = inqRes.data.ref_id || `INQ-${order.id}`;
                        order.digiflazz_oid = pascaRef;
                        order.inquiry_ref = pascaRef;
                        db.saveOrders();
                    } else {
                        console.error(`[DIGIFLAZZ PASCA ERROR] Auto-inquiry gagal:`, inqRes?.data?.message || 'Gagal');
                        return inqRes || { data: { status: 'Gagal', message: inqRes?.data?.message || 'Tagihan tidak ditemukan' } };
                    }
                }
                console.log(`[DIGIFLAZZ PASCA] Menembak pembayaran SKU: ${order.sku}, Target: ${order.target}, Ref: ${pascaRef}`);
                hit = await postpaid.pay(order.sku, order.target, pascaRef);
            } else {
                hit = await api.hitDigiflazz(
                    order.sku,
                    order.target,
                    order.id
                );
            }

            if (hit && hit.data) {
                return hit;
            }

            lastError = 'Empty response from Digiflazz';

        } catch (err) {

            lastError = err.message;

            console.error(
                `[DIGIFLAZZ ERROR] ${order.id}`,
                err
            );
        }

        retry++;

        if (retry < MAX_DIGI_RETRY) {
            await new Promise(resolve =>
                setTimeout(resolve, DIGI_RETRY_DELAY)
            );
        }
    }

    order.status = 'processing';
    order.needRetry = true;
    order.retryCount = (order.retryCount || 0) + 1;
    order.lastRetryAt = Date.now();
    order.lastError = lastError;

    db.saveOrders();

    await notifyAdmin(
        sock,
        `Digiflazz gagal ${MAX_DIGI_RETRY}x\n\nOrder ID: ${order.id}\nTarget: ${order.target}\n\nError:\n${lastError}`
    );

    return null;
}


const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => { rl.question(text, (answer) => { rl.close(); resolve(answer); }); });
};



// =====================================
// FORMAT DIGIFLAZZ RESPONSE
// =====================================
function formatDigiflazzMessage(text = '') {
    if (!text) return '-';

    return text
        .replace(/Dukcapil=/gi, 'Dukcapil : ')
        .replace(/\s\/\s/g, '\n')
        .replace(/,\s*(\d+hr\.)/gi, '\nMasa Aktif : $1')
        .replace(/Expired:/gi, '\nExpired : ')
        .replace(/DATA/gi, '\nData')
        .replace(/VOICE/gi, '\nVoice')
        .replace(/\s-\s/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

// =====================================
// 📊 SISTEM MONITORING STATUS STATUS GANDA (WA & TELEGRAM)
// =====================================
const saveBotStatus = (patch = {}) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const dir = path.resolve(__dirname, 'system');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.resolve(dir, 'bot-status.json');
        let cur = {};
        if (fs.existsSync(filePath)) {
            try { cur = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
        }
        const waUser = global.sock?.user;
        const waPhone = waUser?.id ? waUser.id.split(':')[0].replace(/[^0-9]/g, '') : (cur.whatsapp?.phone || '');
        const waConnected = Boolean(global.sock && waUser);

        const tgToken = config.telegram?.token || '';
        const tgActive = Boolean(global.botTg && tgToken && tgToken.includes(':'));

        const data = {
            whatsapp: {
                status: waConnected ? 'online' : (cur.whatsapp?.status === 'connecting' ? 'connecting' : 'offline'),
                connected: waConnected,
                phone: waPhone,
                updatedAt: Date.now(),
                ...(cur.whatsapp || {}),
                ...(patch.whatsapp || {})
            },
            telegram: {
                status: patch.telegramStatus || cur.telegram?.status || (tgActive ? 'online' : 'offline'),
                active: tgActive,
                username: global.tgBotInfo?.username || cur.telegram?.username || 'ipay_wabot',
                botName: global.tgBotInfo?.first_name || cur.telegram?.botName || 'ipay_wa',
                adminId: config.telegram?.chatId || cur.telegram?.adminId || '',
                tokenMasked: tgToken.length > 10 ? tgToken.slice(0, 6) + '••••' + tgToken.slice(-4) : '',
                lastError: (patch.telegramError !== undefined) ? patch.telegramError : (cur.telegram?.lastError || null),
                updatedAt: Date.now(),
                ...(cur.telegram || {}),
                ...(patch.telegram || {})
            },
            updatedAt: Date.now()
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {}
};
global.saveBotStatus = saveBotStatus;

global.restartWhatsAppBot = async () => {
    console.log('[SYSTEM] 🔄 Merestart koneksi WhatsApp Bot...');
    saveBotStatus({ whatsapp: { status: 'connecting', connected: false } });
    try {
        if (global.sock && typeof global.sock.end === 'function') {
            global.sock.end();
        }
    } catch (_) {}
    setTimeout(() => {
        startBot().catch(err => console.error('[WHATSAPP RESTART ERROR]:', err.message));
    }, 2000);
};

async function startBot(targetPhone = null, tgChatId = null) {
    const { state, saveCreds } = await useMultiFileAuthState('session_bot');
    const { version } = await fetchLatestBaileysVersion();
    
    // ATURAN EMAS 1 & 2: Identitas Desktop Chrome & Matikan QR
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

    global.sock = sock;

    // Registrasi creds.update segera saat socket dibuat agar handshake tersimpan
    sock.ev.on('creds.update', saveCreds);

    // LOGIKA KODE PAIRING (4 ATURAN EMAS BAILEYS)
    if (!sock.authState.creds.registered) {
        let phoneToPair = targetPhone;

        if (phoneToPair && phoneToPair.length >= 10 && phoneToPair.startsWith('62')) {
            console.log(`[PAIRING] ⏳ Menunggu 3 detik agar socket stabil sebelum memanggil requestPairingCode...`);
            // ATURAN EMAS 3: Jeda minimal 3000ms untuk stabilisasi koneksi
            await new Promise(resolve => setTimeout(resolve, 3000));

            // ATURAN EMAS 4: Validasi state
            if (!sock.authState.creds.registered) {
                try {
                    const code = await sock.requestPairingCode(phoneToPair);
                    const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`\n🔗 KODE PAIRING WHATSAPP: \x1b[32m${formatted}\x1b[0m\n`);

                    const targetChat = tgChatId || config.telegram?.chatId;
                    if (global.botTg && targetChat) {
                        await global.botTg.sendMessage(targetChat, 
                            `🔑 *KODE PAIRING WHATSAPP ANDA:*\n\n` +
                            `👉 \`${formatted}\` 👈\n\n` +
                            `📱 *Cara Tautkan di HP:*\n` +
                            `1. Buka aplikasi WhatsApp di HP Anda\n` +
                            `2. Buka menu titik 3 (kanan atas) > *Perangkat tertaut*\n` +
                            `3. Ketuk *Tautkan Perangkat*\n` +
                            `4. Pilih menu *"Tautkan dengan nomor telepon saja"*\n` +
                            `5. Masukkan 8 digit kode: \`${formatted}\`\n\n` +
                            `⏳ _Menunggu verifikasi WhatsApp di HP Anda (Kode aktif ~120 detik)..._`,
                            { parse_mode: 'Markdown' }
                        );
                    }
                } catch (pairErr) {
                    console.error('❌ Gagal request pairing code:', pairErr.message);
                    const targetChat = tgChatId || config.telegram?.chatId;
                    if (global.botTg && targetChat) {
                        global.botTg.sendMessage(targetChat, `❌ *Gagal Mengambil Kode Pairing:*\n${pairErr.message}`, { parse_mode: 'Markdown' });
                    }
                }
            }
        } else {
            console.log('⚠️ [WHATSAPP] Belum terhubung. Menunggu nomor pairing dari Telegram.');
            if (global.botTg && config.telegram?.chatId && !global.hasSentUnpairedNotice) {
                global.hasSentUnpairedNotice = true;
                global.botTg.sendMessage(config.telegram.chatId,
                    `🚨 *WHATSAPP BELUM TERTAUT* 🚨\n\n` +
                    `Sistem mendeteksi sesi WhatsApp belum terdaftar.\n\n` +
                    `Silakan gunakan tombol di bawah untuk memasukkan nomor WhatsApp Bot dan mendapatkan kode pairing:`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📱 HUBUNGKAN WHATSAPP (PAIRING)', callback_data: 'tg_pair' }],
                                [{ text: '🤖 COMMAND CENTER DASHBOARD', callback_data: 'tg_menu' }]
                            ]
                        }
                    }
                ).catch(() => {});
            }
        }
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const isRegistered = Boolean(sock.authState?.creds?.registered);
            if (!isRegistered) {
                console.log('ℹ️ [WHATSAPP] Socket tertutup. Menunggu pairing nomor baru dari Telegram Command Center.');
                return;
            }

            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            // JIKA BENAR-BENAR LOGGED OUT / TERHAPUS
            if (!shouldReconnect) {
                console.log('🚨 [SYSTEM FATAL] Sesi WhatsApp Terhapus / Suspend!');
                try {
                    const axios = require('axios');
                    axios.post('https://api.telegram.org/bot' + config.telegram.token + '/sendMessage', {
                        chat_id: config.telegram.chatId,
                        text: `🚨 *WHATSAPP LOGGED OUT / TERHAPUS* 🚨\n\nSistem mendeteksi sesi WhatsApp bot telah hilang/ter-suspend.\n\nSilakan klik tombol di bawah untuk menautkan ulang:`,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '📱 TAUTKAN NOMOR BARU', callback_data: 'tg_pair' }]]
                        }
                    }).catch(e => console.log("Gagal kirim alarm telegram:", e.message));
                } catch(e) {}
            }
            if (shouldReconnect) {
                console.log('🔄 Mencoba menyambung kembali dalam 5 detik...');

try {

    const state = loadAlertState();

    if (!state.reconnectSent) {

        state.reconnectSent = true;

        saveAlertState(state);

        axios.post(
            `https://api.telegram.org/bot${config.telegram.token}/sendMessage`,
            {
                chat_id: config.telegram.chatId,
                text:
`🟡 WHATSAPP DISCONNECTED

Bot mencoba reconnect otomatis.

🕒 ${new Date().toLocaleString('id-ID')}`
            }
        ).catch(()=>{});

    }

} catch(e) {}


try {
    require('fs').mkdirSync('./system',{recursive:true});

    require('fs').writeFileSync(
        './system/status.json',
        JSON.stringify({
            mode:'reconnect',
            updatedAt:Date.now()
        },null,2)
    );
} catch(e) {}

                saveBotStatus({ whatsapp: { status: 'reconnecting', connected: false } });
                setTimeout(startBot, 5000);
            } else {
                console.log('❌ Sesi Log Out. Silakan hapus folder session_bot dan scan ulang.');
                saveBotStatus({ whatsapp: { status: 'session_lost', connected: false, phone: '' } });

try {

    axios.post(
        `https://api.telegram.org/bot${config.telegram.token}/sendMessage`,
        {
            chat_id: config.telegram.chatId,
            text:
`🚨 SESSION WHATSAPP HILANG

Bot memerlukan pairing ulang.

🕒 ${new Date().toLocaleString('id-ID')}`
        }
    ).catch(()=>{});

} catch(e) {}


try {
    require('fs').mkdirSync('./system',{recursive:true});

    require('fs').writeFileSync(
        './system/status.json',
        JSON.stringify({
            mode:'session_lost',
            updatedAt:Date.now()
        },null,2)
    );
} catch(e) {}

            }
        } else if (connection === 'open') {
            const botNumberRaw = sock.user?.id ? sock.user.id.split(':')[0].replace(/[^0-9]/g, '') : '';
            saveBotStatus({ whatsapp: { status: 'online', connected: true, phone: botNumberRaw } });
            // Cek apakah ini adalah sesi bangun tidur sehabis di-restore
            if (require('fs').existsSync('RESTORE_SUCCESS.txt')) {
                try {
                    fs.unlinkSync('RESTORE_SUCCESS.txt'); // Hapus bendera
                    const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    
                    // Beri jeda 5 detik agar koneksi Baileys stabil sebelum kirim pesan
                    setTimeout(() => {
                        sock.sendMessage(botNumber, { 
                            text: '✅ *SYSTEM RESTORE SUCCESS*\n\nData backup terbaru berhasil dipulihkan dari Telegram Command Center. Seluruh layanan berjalan normal dan siap digunakan!' 
                        });
                    }, 5000); 
                } catch(err) { 
                    console.log("Gagal kirim notif restore:", err); 
                }
            }
            console.log(`✅  BOT PPOB & KASIR ONLINE!`);

            // Notifikasi sukses ke Telegram jika terhubung
            if (global.botTg && (tgChatId || config.telegram?.chatId)) {
                const targetChat = tgChatId || config.telegram?.chatId;
                global.botTg.sendMessage(targetChat, 
                    `✅ *WHATSAPP BERHASIL TERHUBUNG!*\n\n` +
                    `Bot WhatsApp telah aktif, tersambung ke server WhatsApp, dan siap melayani transaksi pelanggan.`, 
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
            }
            
            // --- 🚨 ALARM RESTORE WA ---
            if (require('fs').existsSync('RESTORE_SUCCESS.txt')) {
                try {
                    fs.unlinkSync('RESTORE_SUCCESS.txt'); // Hapus bendera pancingan
                    let botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    
                    setTimeout(() => {
                        sock.sendMessage(botNumber, { 
                            text: '✅ *SYSTEM RESTORE SUCCESS*\n\nData backup terbaru berhasil dipulihkan dari Telegram Command Center!' 
                        }).catch(e => console.log("Gagal kirim notif WA:", e.message));
                    }, 3000);
                } catch(e) {}
            }

try {

    const state = loadAlertState();

    if (state.reconnectSent) {

        axios.post(
            `https://api.telegram.org/bot${config.telegram.token}/sendMessage`,
            {
                chat_id: config.telegram.chatId,
                text:
`🟢 BOT ONLINE KEMBALI

Status:
Normal

🕒 ${new Date().toLocaleString('id-ID')}`
            }
        ).catch(()=>{});

    }

    state.reconnectSent = false;

    saveAlertState(state);

} catch(e) {}


try {
    require('fs').mkdirSync('./system',{recursive:true});

    require('fs').writeFileSync(
        './system/status.json',
        JSON.stringify({
            mode:'normal',
            updatedAt:Date.now()
        },null,2)
    );
} catch(e) {}

/* HEARTBEAT ENGINE */
if (!global.heartbeatStarted) {

    global.heartbeatStarted = true;

    fs.mkdirSync('./system',{
        recursive:true
    });

    global.sock = sock;

    const writeHeartbeat = () => {

        fs.writeFileSync(
            './system/heartbeat.json',
            JSON.stringify({
                status:'running',
                lastSeen:Date.now(),
                startedAt:
                    global.startedAt ||
                    Date.now(),
                store:
                    db.store?.buka
                    ? 'on'
                    : 'off'
            },null,2)
        );

    };

    global.startedAt =
        Date.now();

    writeHeartbeat();

    setInterval(
        writeHeartbeat,
        60000
    );

    console.log(
        '[HEARTBEAT] STARTED'
    );
}
/* END HEARTBEAT */


            // START PROCESSING WATCHER
            if (!processingWatcherStarted) {

                startProcessingWatcher(sock);

                processingWatcherStarted = true;

                console.log(
                    '[WATCHER] STARTED'
                );
            }

            // RECOVERY ACTIVE TRANSACTION LOCK
            db.orders
                .filter(o =>
                    o.status === 'pending' ||
                    o.status === 'processing'
                )
                .forEach(o => {
                    activeTransactions.add(
                        (o.buyer || '') +
                        '-' +
                        (o.sku || o.item || 'ITEM') +
                        '-' +
                        (o.target || 'TARGET')
                    );
                });

            currentSock = sock;

            console.log(
                '[LOCK] Active transaction:',
                activeTransactions.size
            );

            // Recover both pending and unpaid QRIS orders
            db.orders
                .filter(o => (o.status === 'pending' || o.status === 'unpaid') && !o.refunded)
                .forEach(o => {
                    if (!activeCheckers.has(o.id)) startPolling(sock, o);
                });

            // Recover pending deposits
            if (Array.isArray(db.deposits)) {
                db.deposits
                    .filter(d => d.status === 'pending' && (Date.now() - (d.createdAt || 0) < 5 * 60 * 1000))
                    .forEach(d => {
                        resumeDepositPolling(sock, d);
                    });
            }
        }
    });

    global.sock = sock;
    
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message || m.key.fromMe) return;

            // Filter out groups, broadcasts, and newsletters
            const remoteJid = m.key.remoteJid || '';
            if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter') || remoteJid.endsWith('@broadcast')) {
                return;
            }

            // 1. Ekstrak real phone number & PushName dari WhatsApp
            let realPhone = null;
            const altJid = m.key.remoteJidAlt || m.key.participantAlt || m.key.participant || '';
            if (remoteJid.includes('@s.whatsapp.net')) {
                realPhone = remoteJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            } else if (altJid && altJid.includes('@s.whatsapp.net')) {
                realPhone = altJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            }

            // Fallback signal repository jika remoteJid adalah LID
            if (!realPhone && remoteJid.includes('@lid') && sock.signalRepository?.lidMapping?.getPNForLID) {
                try {
                    const pn = await sock.signalRepository.lidMapping.getPNForLID(remoteJid);
                    if (pn) realPhone = pn.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                } catch (_) {}
            }

            if (realPhone) {
                if (realPhone.startsWith('0')) realPhone = '62' + realPhone.slice(1);
            }

            const pushName = (m.pushName || '').trim();
            if (realPhone && remoteJid.includes('@lid') && db.linkLidToPhone) {
                db.linkLidToPhone(remoteJid, realPhone, pushName);
            }

            const sender = jidNormalizedUser(remoteJid);
            const normSender = db.normalizeJid ? db.normalizeJid(sender) : sender;
            const isOwner = (config.owner || []).some(o => {
                const normO = db.normalizeJid ? db.normalizeJid(o) : o;
                return normO === normSender || o === sender;
            });
            let textBody = m.message.conversation || m.message.extendedTextMessage?.text || '';

            db.getUser(normSender, { phone: realPhone, name: pushName });
            if (!userSessions.has(normSender)) userSessions.set(normSender, { step: S.IDLE });
            const session = userSessions.get(normSender);

            const lastChat = spamDelay.get(sender) || 0;

            if (Date.now() - lastChat < 1500) {
                return;
            }

            spamDelay.set(sender, Date.now());

            
            

            // =========================================
            // AUTO KIRIM AKUN MANUAL (FIXED VERSION)
            // =========================================
            if (
                isOwner &&
                m.message?.extendedTextMessage?.contextInfo?.quotedMessage
            ) {

                const quoted =
                    m.message.extendedTextMessage.contextInfo.quotedMessage;

                const quotedText =
                    quoted.conversation ||
                    quoted.extendedTextMessage?.text ||
                    '';

                // hanya proses reply ORDER MANUAL
                if (quotedText.includes('ORDER MASUK MANUAL')) {

                    // ambil ORDER ID
                    const idMatch = quotedText.match(/ID:\s*(.+)/);
                    
                    // 🛡️ KOPLING PEMBATALAN (CEGAH SUKSES JIKA ADMIN KETIK BATAL)
                    let adminReplyText = m.message?.extendedTextMessage?.text || '';
                    let txtLower = adminReplyText.toLowerCase();
                    let isCancelCommand = txtLower.startsWith('batal') || txtLower.startsWith('tolak') || txtLower.startsWith('refund');

                    if (idMatch && isCancelCommand) {
                        let targetInv = idMatch[1].trim();
                        let targetOrder = typeof db !== 'undefined' && db.orders ? db.orders.find(o => o.id === targetInv) : null;
                        
                        if (targetOrder && (targetOrder.status === 'pending' || targetOrder.status === 'processing')) {
                            const refundResult = db.refundOrder(targetOrder, 'Dibatalkan Admin (Via Reply)');
                            
                            if (refundResult.success) {
                                // Lapor Admin
                                sock.sendMessage(m.key.remoteJid, { text: '✅ *ORDER DIBATALKAN (VIA REPLY)*\n\n🧾 Invoice: ' + targetInv + '\n💸 Saldo Rp ' + refundResult.amount.toLocaleString('id-ID') + ' telah dikembalikan ke pembeli.' }, { quoted: m });
                                
                                // Lapor Pembeli
                                let pesanPembeli = '❌ *ORDER DIBATALKAN ADMIN*\n\nMohon maaf, pesanan Anda dibatalkan.\n\n📦 Produk: ' + (targetOrder.item || targetOrder.sku) + '\n🧾 Invoice: ' + targetInv + '\n💰 Saldo Rp ' + refundResult.amount.toLocaleString('id-ID') + ' telah dikembalikan ke dompet Anda.';
                                sock.sendMessage(refundResult.buyerJid, { text: pesanPembeli }).catch(()=>{});
                            } else {
                                sock.sendMessage(m.key.remoteJid, { text: '⚠️ *PERHATIAN:* Order ' + targetInv + ' ' + (refundResult.alreadyRefunded ? 'sudah pernah di-refund sebelumnya.' : 'gagal di-refund: ' + refundResult.reason) }, { quoted: m });
                            }
                        }
                        return; // 🛑 HENTIKAN KODE DISINI AGAR TIDAK DIEKSEKUSI SEBAGAI PESANAN SUKSES
                    }

                    if (!idMatch) {
                        return sock.sendMessage(sender, {
                            text: '❌ ORDER ID tidak ditemukan.'
                        });
                    }

                    const orderId = idMatch[1].trim();

                    // cari order berdasarkan ID
                    const order = db.orders.find(
                        o =>
                            o.id == orderId &&
                            o.isPpob === false &&
                            o.status !== 'success'
                    );

                    if (!order) {
                        return sock.sendMessage(sender, {
                            text:
                                '❌ Order manual tidak ditemukan atau sudah selesai.'
                        });
                    }

                    // ambil isi reply admin
                    const akunText = textBody.trim();

                    if (!akunText) {
                        return sock.sendMessage(sender, {
                            text: '❌ Isi akun kosong.'
                        });
                    }

                    // kirim akun ke pembeli
                    await currentSock.sendMessage(order.buyer, {
                        text:
`✅ *PESANAN BERHASIL*


📦 Produk: ${order.item}

📩 Detail Akun:
${akunText}

Terima kasih telah berbelanja.`
                    });

                    // update status
                    const menuItem = db.menu.find(m => m.nama === order.item);
                    if (menuItem) {
                        menuItem.stok = Math.max(0, (menuItem.stok || 0) - (order.qty || 1));
                        db.saveMenu();
                    }

                    order.status = 'success';
                    order.doneAt = Date.now();

                    db.saveOrders();

                    return sock.sendMessage(sender, {
                        text:
                            '✅ Akun berhasil dikirim ke pembeli.'
                    });
                }
            }

            const rawCmd = textBody.split(/\s+/)[0] || '';
            const cmd = rawCmd.toLowerCase().replace(/^[.!\/#]/, '');
            const args = textBody.slice(rawCmd.length).trim();

            const adminCommands = [
                'admin', 'pullppob', 'cekdigi', 'addsaldo', 'tariksaldo', 'addmenu', 'adddata', 'delmenu', 
                'editmenu', 'setharga', 'stok', 'setstok', 'listmenu', 'cekdata', 'resend', 'member', 'info', 'topsaldo', 
                'toptrx', 'stats', 'toko', 'namatoko', 'lunas', 'backup', 'health',
                'settings', 'pengaturan', 'setdigi', 'setpayment', 'setgateway', 'gateway', 'setpakasir', 'settg', 'setprofit', 
                'settier', 'setpasca', 'setadminpasca', 'margin', 'tier', 'laba', 'topproduk', 'terlaris', 'produkgagal', 'gagal', 'addowner', 'delowner', 'listowner', 'sync', 'refund', 'batal',
                'snk', 'tos', 'syarat', 'aturan', 'snkdigital', 'digital', 'aturanakun'
            ];

            if (isOwner && adminCommands.includes(cmd)) {
                return handleAdmin(sock, sender, cmd, args, m);
            }
            if (
                !isOwner &&
                db.store &&
                db.store.buka === false
            ) {
                return sock.sendMessage(sender, {
                    text:
`🔴 *${db.store.namaToko || 'TOKO'} SEDANG OFFLINE*

Silakan coba lagi nanti.`
                });
            }

if (textBody)
    await handleUser(
        sock,
        sender,
        textBody,
        session,
        processCheckout
    );

        } catch (e) {
    console.error('[MESSAGE ERROR]');
    console.error(e);
    console.error(e.stack);
}
    });

    global.sock = sock;
}

// LOGIKA PEMBAYARAN & POLLING
async function processCheckout(sock, sender, session) {

    // ============================
    // SMART IDEMPOTENCY LOCK
    // ============================
    const item = session.tempItem;
    const cleanBuyer = db.normalizeJid(sender);
    const itemIdentifier = item.sku || item.nama || item.cleanName || 'ITEM';
    const targetIdentifier = session.tempTarget || '-';

    const trxKey = cleanBuyer + '-' + itemIdentifier + '-' + targetIdentifier;

    if (activeTransactions.has(trxKey)) {
        return sock.sendMessage(sender, {
            text: `⚠️ Transaksi yang sama masih sedang diproses.\n\nTarget:\n${targetIdentifier}\n\nMohon tunggu beberapa saat.`
        });
    }

    activeTransactions.add(trxKey);

    const isPpob = !!item.sku;
    const qty = isPpob ? 1 : (session.tempQty || 1);
    let baseAmount = (isPpob ? item.hargaJual : item.harga) * qty;

    const oid = `INV-${Date.now()}`;
    const order = { 
        id: oid, 
        buyer: cleanBuyer, 
        item: item.nama || item.cleanName, 
        qty: qty, 
        baseAmount: baseAmount, 
        status: 'pending', 
        isPpob: isPpob, 
        isPasca: !!item.isPasca,
        sku: item.sku, 
        target: session.tempTarget || '-', 
        timestamp: Date.now() 
    };

    // --- INJEKSI INQUIRY PASCABAYAR ---
    if (item.isPasca) {
        if (!item.hargaJual || !(session.tempInquiryRef || item.inquiryRef)) {
            await sock.sendMessage(sender, { text: "⏳ *INQUIRY:* Sedang mengambil rincian tagihan dari server..." });
            const postpaid = require('./lib/postpaid');
            try {
                const inqRef = `INQ-${oid}`;
                const inq = await postpaid.inquiry(item.sku, session.tempTarget, inqRef);
                const data = inq?.data;
                const billVal = Number(data?.price || data?.selling_price || 0);
                if (!data || data.status === 'Gagal' || billVal <= 0) {
                    activeTransactions.delete(trxKey);
                    return sock.sendMessage(sender, { text: `❌ *INQUIRY GAGAL*\nPesan: ${data ? (data.message || 'Tagihan Rp 0 atau sudah lunas.') : 'Gagal terhubung ke server Digiflazz.'}` });
                }
                const pascaProfit = (config.profit && config.profit.pasca !== undefined) ? Number(config.profit.pasca) : 1500;
                baseAmount = billVal + pascaProfit;
                item.hargaJual = baseAmount;
                item.nama = data.customer_name ? `${item.brand || item.name} (${data.customer_name})` : (item.brand || item.name);
                order.baseAmount = baseAmount;
                order.item = item.nama;
                order.digiflazz_oid = data.ref_id || inqRef;
                order.inquiry_ref = data.ref_id || inqRef;
            } catch (e) {
                activeTransactions.delete(trxKey);
                return sock.sendMessage(sender, { text: "❌ *ERROR API:* Gagal terhubung ke Digiflazz." });
            }
        } else {
            baseAmount = item.hargaJual;
            order.baseAmount = baseAmount;
            order.item = item.nama;
            const inqRef = session.tempInquiryRef || item.inquiryRef;
            if (inqRef) {
                order.digiflazz_oid = inqRef;
                order.inquiry_ref = inqRef;
            }
        }
    }

    const buyerUser = db.getUser(cleanBuyer);
    const actualSaldo = Number(buyerUser.saldo) || 0;

    if (actualSaldo >= baseAmount) {
        const deduct = db.deductSaldo(cleanBuyer, baseAmount, oid, order.item);
        if (deduct.success) {
            order.method = 'Saldo Akun';
            order.status = 'processing';
            db.orders.push(order);
            db.saveOrders();
            return handleSuccessPayment(sock, order, true);
        }
    }

    // Notifikasi instan sebelum generate barcode QRIS (agar user tidak merasa jeda)
    await sock.sendMessage(sender, {
        text: "⏳ *MENYIAPKAN QRIS...*\nSedang membuat barcode pembayaran resmi, mohon tunggu beberapa detik ya kak..."
    }).catch(() => {});

    // Jika saldo tidak cukup -> Generate QRIS
    const qris = await api.createQris(oid, baseAmount);
    if (!qris || qris.status !== 'Success') {
        activeTransactions.delete(trxKey);
        return sock.sendMessage(sender, { text: "❌ Gangguan server payment QRIS." });
    }
    order.total = qris.data.total_bayar;
    order.method = 'QRIS';
    order.status = 'unpaid';
    db.orders.push(order);
    db.saveOrders();

    let qrPayload = { url: `https://quickchart.io/qr?size=500&margin=2&text=${encodeURIComponent(qris.data.qr_string)}` };
    try {
        const QRCode = require('qrcode');
        const qrBuf = await QRCode.toBuffer(qris.data.qr_string, { width: 500, margin: 2 });
        qrPayload = qrBuf;
    } catch (_) {}

    await sock.sendMessage(sender, {
        image: qrPayload,
        caption: `🧾 *TAGIHAN PEMBAYARAN QRIS*

• Invoice : \`${oid}\`
• Produk  : *${order.item}*
• Tujuan  : *${order.target}*
• Total   : *${formatRupiah(order.total)}* _(Tepat)_

⏳ Batas Waktu: *5 Menit* (Otomatis Batal)

💡 *Cara Bayar Mudah:*
1. Simpan / Screenshot gambar QR di atas.
2. Buka m-Banking (BCA, Mandiri, BRI, BNI) atau E-Wallet (DANA, GoPay, OVO, ShopeePay).
3. Pilih menu *Scan QRIS* lalu unggah foto dari galeri HP Anda.

_Transaksi otomatis diproses seketika setelah pembayaran berhasil diterima!_`
    });
    startPolling(sock, order);
}

function startPolling(sock, orderData) {
    const oid = orderData.id;
    const checkerInterval = setInterval(async () => {
        const order = db.orders.find(o => o.id === oid);
        if (!order || (order.status !== 'pending' && order.status !== 'unpaid')) { clearInterval(checkerInterval); activeCheckers.delete(oid); return; }

        if (Date.now() - order.timestamp > 5 * 60 * 1000) {
            clearInterval(checkerInterval); activeCheckers.delete(oid);
            order.status = 'cancelled'; 
            db.saveOrders();

            activeTransactions.delete(
                (order.buyer || '') + '-' + (order.sku || order.item || 'ITEM') + '-' + (order.target || 'TARGET')
            );
            return sock.sendMessage(order.buyer, { text:
`❌ QRIS EXPIRED

Pembayaran melewati batas 5 menit.

🧾 Invoice:
${order.id}

Silakan buat transaksi baru.` }).catch(()=>{});
        }
        if (await api.checkQris(oid, order.baseAmount) === 'PAID') {
            clearInterval(checkerInterval); activeCheckers.delete(oid);
            handleSuccessPayment(sock, order, false);
        }
    }, 10000);
    activeCheckers.set(oid, checkerInterval);
}

// ================================
// RECOVERY PENDING DEPOSITS
// ================================
function resumeDepositPolling(sock, dep) {
    if (!dep || dep.status !== 'pending') return;
    const depositId = dep.id;
    const finalAmount = dep.finalAmount || dep.amount;
    const targetJid = dep.buyer;
    if (activeCheckers.has(depositId)) return;

    const depositChecker = setInterval(async () => {
        try {
            const currentDep = (db.deposits || []).find(d => d.id === depositId);
            if (!currentDep || currentDep.status !== 'pending') {
                clearInterval(depositChecker);
                activeCheckers.delete(depositId);
                return;
            }

            if (Date.now() - (currentDep.createdAt || 0) > 5 * 60 * 1000) {
                currentDep.status = 'expired';
                if (db.saveDeposits) db.saveDeposits();
                clearInterval(depositChecker);
                activeCheckers.delete(depositId);
                return sock.sendMessage(targetJid, {
                    text: `❌ *DEPOSIT EXPIRED*\n\nID: \`${depositId}\`\nPembayaran melewati batas waktu 5 menit.`
                }).catch(() => {});
            }

            const check = await api.checkQris(depositId, finalAmount);
            if (check === 'PAID') {
                currentDep.status = 'paid';
                currentDep.paidAt = Date.now();
                clearInterval(depositChecker);
                activeCheckers.delete(depositId);

                const user = db.getUser(targetJid);
                user.saldo = (Number(user.saldo) || 0) + Number(currentDep.amount);
                if (!Array.isArray(user.history)) user.history = [];
                const dateStr = new Date().toLocaleDateString('id-ID');
                user.history.push(`[${dateStr}] 🟢 Deposit QRIS (+Rp ${Number(currentDep.amount).toLocaleString('id-ID')})`);
                if (db.saveDeposits) db.saveDeposits();
                db.saveUsers();

                await sock.sendMessage(targetJid, {
                    text: `✅ *DEPOSIT BERHASIL*\n\n💰 Saldo Masuk: Rp ${Number(currentDep.amount).toLocaleString('id-ID')}\n🧾 ID: \`${depositId}\`\n💵 Saldo Baru: ${formatRupiah(user.saldo)}`
                }).catch(() => {});

                for (const owner of config.owner) {
                    await sock.sendMessage(owner, {
                        text: `💰 *DEPOSIT MASUK*\nUser: ${targetJid}\nNominal: Rp ${Number(currentDep.amount).toLocaleString('id-ID')}\nID: \`${depositId}\``
                    }).catch(() => {});
                }
            }
        } catch (_) {}
    }, 5000);

    activeCheckers.set(depositId, depositChecker);
}

// LOGIKA EKSEKUSI PRODUK (DIGIFLAZZ / LOKAL)
async function handleSuccessPayment(sock, order, viaSaldo) {
    const targetJid = order.buyer;
    
    if (order.isPpob) {
        order.status = 'processing'; db.saveOrders();
        await sock.sendMessage(targetJid, { text: `⏳ *DIPROSES*...\nMenembak ke server pusat untuk nomor: *${order.target}*.` });
        
                const maskPhone = (p = '') => p.length > 7 ? p.slice(0, 4) + '****' + p.slice(-3) : p;
                console.log(`[ORDER PPOB] ID: ${order.id} | SKU: ${order.sku} | Target: ${maskPhone(order.target)}`);
                const hit = await safeHitDigiflazz(sock, order);
        
        if (hit && hit.data) {
            if (hit.data.status === 'Sukses') {
                console.log(`[HIT SUCCESS] ${order.id} -> Sukses`);
                    const menuItem = db.menu.find(m => m.nama === order.item);
                    if (menuItem) {
                        menuItem.stok = Math.max(0, (menuItem.stok || 0) - (order.qty || 1));
                        db.saveMenu();
                    }

                order.status = 'success'; 
                order.sn = hit.data.sn || order.sn;
                if (hit.data.ref_id) order.digiflazz_oid = hit.data.ref_id;
                order.profit = analytics.calculateOrderProfit(order, db.ppob);
                db.saveOrders();

                activeTransactions.delete(
                    (order.buyer || '') + '-' + (order.sku || order.item || 'ITEM') + '-' + (order.target || 'TARGET')
                );

                if (order.isPasca) {
                    let descText = '';
                    if (hit.data.desc) {
                        try {
                            const d = typeof hit.data.desc === 'object' ? hit.data.desc : JSON.parse(hit.data.desc);
                            if (d.tarif && d.daya) descText += `⚡ Daya/Tarif: *${d.tarif} / ${d.daya}VA*\n`;
                            if (d.lembar_tagihan) descText += `📑 Lembar Tagihan: *${d.lembar_tagihan} bulan*\n`;
                        } catch (_) {}
                    }
                    const snText = hit.data.sn ? `\n🧾 *No. Ref / SN:* \`${hit.data.sn}\`` : '';
                    await sock.sendMessage(targetJid, {
                        text: `✅ *PEMBAYARAN PASCABAYAR BERHASIL*\n\n` +
                              `📦 Layanan: *${order.item}*\n` +
                              `🎯 ID Pelanggan: *${order.target}*\n` +
                              `${descText}` +
                              `💰 Total Bayar: *${formatRupiah(order.baseAmount || order.total || 0)}*` +
                              `${snText}\n\n` +
                              `_Terima kasih telah melakukan pembayaran di *${db.store.namaToko || 'Toko Kami'}*!_`
                    });
                } else {
                    const rawSn = hit.data.sn || hit.data.message || '';
                    const plnData = formatPlnToken(rawSn);
                    const storeName = db.store.namaToko || 'DIGITAL STORE';
                    const timeStr = getTanggalLengkap(order.timestamp || Date.now());

                    if (plnData) {
                        let plnMsg = `✅ *PEMBELIAN TOKEN LISTRIK BERHASIL*\n\n` +
                                     `⚡ *KODE TOKEN ANDA (20 DIGIT):*\n` +
                                     `\`${plnData.token}\`\n` +
                                     `_(Ketuk kode di atas untuk menyalin ke meteran)_\n\n`;
                        if (plnData.nama) plnMsg += `👤 Nama Pelanggan : *${plnData.nama}*\n`;
                        if (plnData.tarif) plnMsg += `⚡ Tarif / Daya    : *${plnData.tarif}*\n`;
                        if (plnData.kwh) plnMsg += `📊 Jumlah Kwh     : *${plnData.kwh}*\n`;
                        plnMsg += `🎯 No. Meter / ID  : *${order.target}*\n` +
                                  `💰 Total Bayar     : *${formatRupiah(order.baseAmount || order.total || 0)}*\n` +
                                  `🕒 Waktu           : ${timeStr}\n\n` +
                                  `_Terima kasih telah berbelanja di *${storeName}*!_`;
                        await sock.sendMessage(targetJid, { text: plnMsg });
                    } else {
                        await sock.sendMessage(targetJid, {
                            text: `✅ *TRANSAKSI BERHASIL*\n\n` +
                                  `📦 Produk   : *${order.item}*\n` +
                                  `🎯 Tujuan   : *${order.target}*\n` +
                                  `💰 Total    : *${formatRupiah(order.baseAmount || order.total || 0)}*\n` +
                                  `🧾 SN / Ref : \`${formatDigiflazzMessage(rawSn)}\`\n` +
                                  `🕒 Waktu    : ${timeStr}\n\n` +
                                  `_Terima kasih telah berbelanja di *${storeName}*!_`
                        });
                    }
                }
            } else if (hit.data.status === 'Pending') {
                order.status = 'processing';
                if (typeof hit !== 'undefined' && hit.data && hit.data.ref_id) { order.digiflazz_oid = hit.data.ref_id; }
                db.saveOrders();
                if (order.isPasca) {
                    await sock.sendMessage(targetJid, { text: `⏳ *MENUNGGU KONFIRMASI BILLER*\n\nPembayaran tagihan Anda sedang diproses oleh server pusat/biller. Mohon ditunggu ya kak, notifikasi sukses akan dikirim otomatis.` });
                } else {
                    await sock.sendMessage(targetJid, { text: `⏳ *MENUNGGU PROVIDER*\n\nPembayaran LUNAS. Transaksi sedang diproses oleh server pusat. Mohon ditunggu ya kak, produk akan segera masuk.` });
                }
            } else {
                activeTransactions.delete(
                    (order.buyer || '') + '-' + (order.sku || order.item || 'ITEM') + '-' + (order.target || 'TARGET')
                );

                const refundRes = db.refundOrder(order, hit.data.message || 'Gangguan Server');
                if (refundRes.success) {
                    await sock.sendMessage(targetJid, {
                        text:
`❌ *TRANSAKSI GAGAL*

Alasan:
${hit.data.message || 'Gangguan'}

💰 Saldo otomatis dikembalikan:
${formatRupiah(refundRes.amount)}`
                    });

                    for (const owner of config.owner) {
                        await sock.sendMessage(owner, { 
                            text: `⚠️ *PPOB GAGAL*\nID: ${order.id}\nTarget: ${order.target}\nAlasan: ${hit.data.message || 'Gangguan'}\nSaldo di-refund: ${formatRupiah(refundRes.amount)}` 
                        }).catch(()=>{});
                    }
                }
            }
        } else {

            order.status = 'processing';
            order.needRetry = true;
            order.lastRetryAt = Date.now();

            db.saveOrders();

            await sock.sendMessage(targetJid, {
                text:
`⚠️ *SERVER PPOB SEDANG SIBUK*

Pembayaran Anda sudah diterima.

Sistem akan mencoba memproses transaksi secara otomatis.

🧾 ID Transaksi:
${order.id}

Mohon tunggu beberapa menit ya kak.`
            });
        }
        

    } else {
        const dbItem = db.menu.find(m => m.nama === order.item);
        if (dbItem && dbItem.dataAkun && dbItem.dataAkun.length >= order.qty) {
            const dataExtracted = dbItem.dataAkun.splice(0, order.qty);
            dbItem.stok = dbItem.dataAkun.length; 
            db.saveMenu();

            order.status = 'success'; db.saveOrders();
            let deliverMsg = `✅ *PESANAN PRODUK DIGITAL SUKSES*\n\n` +
                `📦 Produk : *${order.item}*\n` +
                `📊 Jumlah : *${order.qty}*\n` +
                `🧾 No. Inv: \`${order.id}\`\n\n` +
                `🔑 *DETAIL AKUN / KREDENSIAL:*\n` +
                `${dataExtracted.join('\n---\n')}\n\n` +
                `📌 *ATURAN PENGGUNAAN WAJIB & BATASAN HUKUM:*\n` +
                `1. Wajib login HANYA di *1 Device* (Dilarang multi-device/sharing).\n` +
                `2. Dilarang mengubah email, password, profile, atau billing/pembayaran.\n` +
                `3. Akun bersumber dari promo seller luar, *TIDAK ADA garansi seumur hidup/permanen*.\n` +
                `4. Garansi HANYA saat *First Login (maks 1x24 jam)* jika salah password saat pertama diterima.\n` +
                `5. Jika akun tersuspend pihak provider resmi di kemudian hari, *TIDAK ADA REFUND / UANG KEMBALI*.\n\n` +
                `_Ketik *.snkdigital* untuk membaca syarat & ketentuan lengkap._`;
            await sock.sendMessage(targetJid, { text: deliverMsg });

addLog(
`TRANSACTION SUCCESS
ID: ${order.id}
USER: ${targetJid}
ITEM: ${order.item}
QTY: ${order.qty}
STATUS: SUCCESS`,
'transaksi.log'
);
        } else {
            order.status = 'processing'; if(typeof hit !== 'undefined' && hit.data && hit.data.ref_id) { order.digiflazz_oid = hit.data.ref_id; } db.saveOrders();
            await sock.sendMessage(targetJid, { text: `✅ Pembayaran diterima. Menunggu admin memproses.` });
            for (const owner of config.owner) await sock.sendMessage(owner, { text: `🔔 ORDER MASUK MANUAL\nID: ${order.id}\nProduk: ${order.item}\nReply untuk mengirim.` }).catch(()=>{});
        }
    }
}

startBot();

// ================================
// PROCESSING WATCHER
// ================================
let processingWatcherStarted = false;

function startProcessingWatcher(sock) {
    // AUTO CLEAN TRANSACTION LOCK
    setInterval(() => {
        const now = Date.now();
        for (const trx of activeTransactions) {
            const order = db.orders.find(o =>
                (o.buyer + '-' + o.sku + '-' + o.target) === trx
            );

            if (
                !order ||
                order.status === 'success' ||
                order.status === 'failed' ||
                order.status === 'cancelled'
            ) {
                activeTransactions.delete(trx);
            } else if (
                now - order.timestamp > 30 * 60 * 1000
            ) {
                activeTransactions.delete(trx);
            }
        }
    }, 60000);
}

// ========================================
// 🛠️ OTOMATIS PASANG SYMLINK CLI botwa (LINUX)
// ========================================
if (process.platform === 'linux') {
    try {
        const { execSync } = require('child_process');
        const botwaBin = path.resolve(__dirname, 'bin', 'botwa.sh');
        if (fs.existsSync(botwaBin)) {
            try { fs.chmodSync(botwaBin, 0o755); } catch (_) {}
            execSync(`chmod +x "${botwaBin}" 2>/dev/null || true`);
            execSync(`ln -sf "${botwaBin}" /usr/local/bin/botwa 2>/dev/null || true`);
            execSync(`ln -sf "${botwaBin}" /usr/bin/botwa 2>/dev/null || true`);
            execSync(`rm -f /usr/local/bin/bot-ppob /usr/bin/bot-ppob 2>/dev/null || true`);
            execSync(`chmod +x /usr/local/bin/botwa /usr/bin/botwa 2>/dev/null || true`);
        }
    } catch (_) {}
}

// ========================================
// 🛡️ SMARTDATA TELEGRAM COMMAND CENTER (AUTO-BACKUP DINAMIS)
// ========================================
let autoBackupIntervalTimer = null;

function setupAutoBackupTimer() {
    if (autoBackupIntervalTimer) {
        clearInterval(autoBackupIntervalTimer);
        autoBackupIntervalTimer = null;
    }
    const minutes = Number(db.store?.backupIntervalMinutes !== undefined ? db.store.backupIntervalMinutes : 60);
    if (minutes <= 0) {
        console.log('[SYSTEM] 🛑 Auto-backup ke Telegram dinonaktifkan.');
        return;
    }
    const ms = minutes * 60 * 1000;
    console.log(`[SYSTEM] 🛡️ Auto-backup ke Telegram aktif setiap ${minutes} menit.`);
    autoBackupIntervalTimer = setInterval(() => {
        const { exec } = require('child_process');
        console.log(`[SYSTEM] 📦 Menjalankan Auto-Backup (${minutes}m) ke Telegram...`);
        const targetChat = config.telegram.chatId || '';
        exec(`node lib/backup/backup-telegram.js ${targetChat}`, (error, stdout, stderr) => {
            if (error) console.log(`[BACKUP ERROR]: ${error.message}`);
        });
    }, ms);
}

setupAutoBackupTimer();


// ==========================================
// 🎧 TELEGRAM COMMAND CENTER LISTENER (INLINE KEYBOARD)
// ==========================================
function initTelegramBot() {
    try {
        const TelegramBot = require('node-telegram-bot-api');
        const { exec, spawnSync } = require('child_process');
        
        // Mencegah bentrok / double polling jika file dimuat ulang
        if (config.telegram?.token && config.telegram.token.includes(':')) {
            if (global.botTg) {
                try {
                    if (typeof global.botTg.stopPolling === 'function') global.botTg.stopPolling();
                } catch (_) {}
                global.botTg = null;
            }
            global.botTg = new TelegramBot(config.telegram.token, { polling: true });
            global.tgInputState = null;

        // Verifikasi getMe & simpan status
        global.botTg.getMe().then(me => {
            global.tgBotInfo = me;
            console.log(`[SYSTEM] 🎧 Telegram Bot @${me.username} (${me.first_name}) Aktif & Polling! (Admin ID: ${config.telegram.chatId || 'Belum Diatur'})`);
            saveBotStatus({ telegramStatus: 'online', telegramError: null, username: me.username, botName: me.first_name });
        }).catch(err => {
            console.warn(`⚠️ [TELEGRAM GETME ERROR]: ${err.message}`);
            saveBotStatus({ telegramStatus: 'error', telegramError: err.message });
        });

        // Tangkap polling error agar tidak crash dan filter timeout rutin
        global.botTg.on('polling_error', (error) => {
            const desc = error.response?.body?.description || error.message || '';
            const code = error.code || '';

            // Abaikan timeout koneksi berkala yang normal pada long-polling Telegram
            if (code === 'EFATAL' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNRESET' || desc.includes('socket hang up') || desc.includes('ETIMEDOUT')) {
                return;
            }

            // Peringatan jika token bot dipakai di 2 tempat sekaligus
            if (desc.includes('Conflict') || desc.includes('terminated by other getUpdates')) {
                console.warn('⚠️ [TELEGRAM CONFLICT]: Token bot ini sedang aktif di proses lain (409 Conflict). Pastikan hanya 1 bot yang berjalan.');
                saveBotStatus({ telegramStatus: 'conflict', telegramError: '409 Conflict' });
                return;
            }

            if (desc.includes('Unauthorized') || error.response?.statusCode === 401) {
                console.warn('⚠️ [TELEGRAM 401]: Token Bot Telegram tidak valid atau telah dicabut (Unauthorized).');
                saveBotStatus({ telegramStatus: 'unauthorized', telegramError: '401 Unauthorized' });
                return;
            }

            console.warn('⚠️ [TELEGRAM POLLING]:', desc || code);
            saveBotStatus({ telegramStatus: 'error', telegramError: desc || code });
        });

        const maskSecret = (str = '') => (str && str.length > 8 ? str.slice(0, 4) + '••••' + str.slice(-4) : (str ? '••••••••' : '-'));

        const cleanMd = (str = '') => String(str || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

        const normalizePhone = (raw) => {
            let p = String(raw || '').replace(/[^0-9]/g, '');
            if (p.startsWith('0')) p = '62' + p.slice(1);
            else if (p.startsWith('8')) p = '62' + p;
            return p;
        };

        const formatDisplayPhone = (raw) => {
            let p = normalizePhone(raw);
            if (p.startsWith('62')) return '0' + p.slice(2);
            return p;
        };

        const findMember = (rawPhone) => {
            const clean = normalizePhone(rawPhone);
            if (!clean || clean.length < 9) return null;
            if (db.users && db.users[clean]) return { jid: clean, user: db.users[clean], phone: clean };
            const directJid = `${clean}@s.whatsapp.net`;
            if (db.users && db.users[directJid]) return { jid: directJid, user: db.users[directJid], phone: clean };
            for (const [j, u] of Object.entries(db.users || {})) {
                if (u) {
                    const uPhone = normalizePhone(u.phone || j);
                    if (uPhone === clean || j.startsWith(clean)) {
                        return { jid: j, user: u, phone: uPhone || clean };
                    }
                }
            }
            return null;
        };

        const getMemberList = () => {
            const memberMap = new Map();
            
            // Ambil nomor bot sendiri agar tidak masuk ke daftar member
            const waStatus = getWaStatus();
            const botPhone = normalizePhone(waStatus?.phone || '');
            let botLid = '';
            try {
                if (fs.existsSync('./session_bot/creds.json')) {
                    const c = JSON.parse(fs.readFileSync('./session_bot/creds.json', 'utf8'));
                    if (c?.me?.lid) botLid = c.me.lid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
                }
            } catch (_) {}

            for (const [jid, u] of Object.entries(db.users || {})) {
                if (!u || typeof u !== 'object') continue;
                if (u.canonical) continue; // Pointer LID ke akun utama dilewati
                if (jid.includes('@newsletter') || jid.includes('@broadcast') || jid.includes('@g.us')) continue;

                // Ambil nomor telepon
                let rawPhone = u.phone;
                if (!rawPhone && jid.includes('@s.whatsapp.net')) {
                    rawPhone = jid.split('@')[0].split(':')[0];
                }

                // Cek jika nomor adalah bot sendiri
                if (botPhone && (jid.startsWith(botPhone) || u.phone === botPhone)) continue;
                if (botLid && jid.startsWith(botLid)) continue;

                const phone = normalizePhone(rawPhone);
                // Validasi nomor HP nyata (Indonesia 628xxx, 10-14 digit)
                if (!phone || !phone.startsWith('628') || phone.length < 10 || phone.length > 14) {
                    continue;
                }

                const displayPhone = '0' + phone.slice(2);
                const currentSaldo = Number(u.saldo) || 0;
                const currentName = (u.name && u.name !== 'User') ? u.name : '';

                if (memberMap.has(phone)) {
                    const existing = memberMap.get(phone);
                    const mergedSaldo = Math.max(currentSaldo, existing.saldo);
                    const mergedName = currentName || existing.name || '';
                    memberMap.set(phone, {
                        jid: u.canonical || jid,
                        phone,
                        displayPhone,
                        name: mergedName,
                        saldo: mergedSaldo,
                        date: u.date || existing.date || 0,
                        user: u
                    });
                } else {
                    memberMap.set(phone, {
                        jid,
                        phone,
                        displayPhone,
                        name: currentName,
                        saldo: currentSaldo,
                        date: u.date || 0,
                        user: u
                    });
                }
            }
            const list = Array.from(memberMap.values());
            list.sort((a, b) => (b.date || 0) - (a.date || 0));
            return list;
        };

        const renderMemberProfile = (rawPhone) => {
            const found = findMember(rawPhone);
            if (!found) {
                return {
                    text: `❌ *Member Tidak Ditemukan!*\n\nNomor \`${rawPhone}\` tidak terdaftar di database.`,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '➕ Tambah Member Manual', callback_data: 'tg_input_addmember' }],
                            [{ text: '👥 Pilih Dari Daftar', callback_data: 'tg_input_cekuser' }],
                            [{ text: '⬅️ Menu Member', callback_data: 'tg_member_menu' }]
                        ]
                    }
                };
            }

            const orders = (db.orders || []).filter(o => 
                o.buyer === found.jid || o.sender === found.jid || (found.phone && o.buyer && o.buyer.includes(found.phone))
            );
            const successCount = orders.filter(o => o.status === 'success').length;
            const failedCount = orders.filter(o => o.status === 'failed' || o.status === 'cancelled').length;
            const totalBelanja = orders.filter(o => o.status === 'success').reduce((acc, o) => acc + Number(o.baseAmount || o.total || 0), 0);
            const lastOrder = orders[orders.length - 1];
            const lastDate = lastOrder ? new Date(lastOrder.timestamp || lastOrder.doneAt || 0).toLocaleString('id-ID') : '-';
            const dateJoin = found.user.date ? new Date(found.user.date).toLocaleDateString('id-ID') : '-';
            let histStr = '';
            if (Array.isArray(found.user.history) && found.user.history.length > 0) {
                histStr = '\n\n📜 *3 Riwayat Terakhir:*\n' + found.user.history.slice(-3).map(h => `• ${cleanMd(h)}`).join('\n');
            }

            const dPhone = formatDisplayPhone(found.phone);
            const safeName = found.user.name ? cleanMd(found.user.name) : '-';

            let report = `👤 *PROFIL LENGKAP MEMBER*\n\n` +
                `📱 *Nomor HP:* \`${dPhone}\` _(+${found.phone})_\n` +
                `👤 *Nama Member:* *${safeName}*\n` +
                `💰 *Saldo:* *${formatRupiah(found.user.saldo || 0)}*\n` +
                `📅 *Terdaftar Sejak:* ${dateJoin}\n` +
                `📦 *Total Transaksi:* ${orders.length} order (${successCount} sukses, ${failedCount} gagal)\n` +
                `💵 *Total Belanja Sukses:* ${formatRupiah(totalBelanja)}\n` +
                `🕒 *Trx Terakhir:* ${lastDate}${histStr}`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '➕ Tambah Saldo', callback_data: `tg_salplus_${found.phone}` },
                        { text: '➖ Tarik Saldo', callback_data: `tg_salmin_${found.phone}` }
                    ],
                    [
                        { text: '✏️ Ubah Nama Member', callback_data: `tg_setname_${found.phone}` }
                    ],
                    [
                        { text: '🔄 Refresh Profil', callback_data: `tg_viewuser_${found.phone}` },
                        { text: '👥 Pilih Member Lain', callback_data: 'tg_input_cekuser' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Member', callback_data: 'tg_member_menu' }
                    ]
                ]
            };

            return { text: report, reply_markup };
        };

        const renderMemberPicker = (page = 0) => {
            const members = getMemberList();
            const totalUsers = members.length;

            if (totalUsers === 0) {
                return {
                    text: `👥 *DAFTAR MEMBER TERDAFTAR*\n\n` +
                          `_Belum ada member yang terdaftar di database._\n\n` +
                          `Anda dapat mendaftarkan member baru secara manual atau menunggu pengguna berinteraksi di WhatsApp.`,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '➕ Tambah Member Manual', callback_data: 'tg_input_addmember' }],
                            [{ text: '⬅️ Kembali ke Menu Member', callback_data: 'tg_member_menu' }]
                        ]
                    }
                };
            }

            const pageSize = 6;
            const totalPages = Math.ceil(totalUsers / pageSize) || 1;
            const currentPage = Math.max(0, Math.min(page, totalPages - 1));
            const startIdx = currentPage * pageSize;
            const currentMembers = members.slice(startIdx, startIdx + pageSize);

            let text = `🔍 *PILIH MEMBER UNTUK CEK PROFIL*\n\n`;
            text += `_Klik tombol member di bawah untuk melihat detail profil & kelola saldo:_\n\n`;
            text += `📊 *Total Member:* ${totalUsers} pengguna\n`;
            text += `📄 *Halaman:* ${currentPage + 1} dari ${totalPages}\n\n`;
            text += `_Daftar Member Halaman Ini:_\n`;

            const inline_keyboard = [];

            currentMembers.forEach((m, idx) => {
                const num = startIdx + idx + 1;
                const dPhone = m.displayPhone || formatDisplayPhone(m.phone);
                const safeName = m.name ? cleanMd(m.name) : '';
                const nameStr = safeName ? ` *${safeName}*` : '';
                text += `${num}. \`${dPhone}\`${nameStr} — *${formatRupiah(m.saldo)}*\n`;

                const btnText = m.name 
                    ? `👤 ${dPhone} ${m.name.slice(0, 16)} • ${formatRupiah(m.saldo)}`
                    : `📱 ${dPhone} • ${formatRupiah(m.saldo)}`;

                inline_keyboard.push([
                    { text: btnText, callback_data: `tg_viewuser_${m.phone}` }
                ]);
            });

            if (totalPages > 1) {
                const navRow = [];
                if (currentPage > 0) {
                    navRow.push({ text: '◀️ Prev', callback_data: `tg_pick_member_${currentPage - 1}` });
                }
                navRow.push({ text: `📍 ${currentPage + 1}/${totalPages}`, callback_data: `tg_pick_member_${currentPage}` });
                if (currentPage < totalPages - 1) {
                    navRow.push({ text: 'Next ▶️', callback_data: `tg_pick_member_${currentPage + 1}` });
                }
                inline_keyboard.push(navRow);
            }

            inline_keyboard.push([
                { text: '⌨️ Cari / Ketik Nomor Manual', callback_data: 'tg_input_cekuser_manual' }
            ]);
            inline_keyboard.push([
                { text: '⬅️ Kembali ke Menu Member', callback_data: 'tg_member_menu' }
            ]);

            return { text, reply_markup: { inline_keyboard } };
        };

        const getUniqueUserPhones = () => {
            const set = new Set();
            for (const [jid, u] of Object.entries(db.users || {})) {
                let p = u?.phone || (jid.includes('@s.whatsapp.net') ? jid.split('@')[0] : '');
                p = normalizePhone(p);
                if (p && p.startsWith('62') && p.length >= 10) {
                    set.add(p);
                }
            }
            return Array.from(set);
        };

        const getWaStatus = () => {
            let connected = false;
            let phone = '';
            try {
                if (global.sock?.user?.id) {
                    connected = true;
                    phone = global.sock.user.id.split(':')[0] || global.sock.user.id.split('@')[0];
                } else if (fs.existsSync('./session_bot/creds.json')) {
                    const creds = JSON.parse(fs.readFileSync('./session_bot/creds.json', 'utf8'));
                    if (creds && creds.registered && creds.me?.id) {
                        connected = true;
                        phone = creds.me.id.split(':')[0] || creds.me.id.split('@')[0];
                    }
                }
            } catch (_) {}
            return { connected, phone };
        };

        const performCheckGitUpdate = () => {
            const { execSync } = require('child_process');
            let branch = 'main';
            try {
                branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe', encoding: 'utf-8' }).trim() || 'main';
            } catch (_) {}

            // 1. Fetch remote changes dari branch aktif
            execSync(`git fetch origin ${branch}`, { stdio: 'pipe', timeout: 30000 });

            // 2. Cek commit saat ini
            const currentCommit = execSync('git log -1 --pretty=format:"%h (%cd) - %s" --date=format:"%d/%m/%Y %H:%M"', { stdio: 'pipe', encoding: 'utf-8' }).trim();

            // 3. Hitung jumlah commit tertinggal dari origin/<branch>
            const behindCount = parseInt(execSync(`git rev-list HEAD..origin/${branch} --count`, { stdio: 'pipe', encoding: 'utf-8' }).trim(), 10) || 0;

            if (behindCount === 0) {
                return {
                    isUpToDate: true,
                    currentCommit,
                    behindCount: 0,
                    text: `🚀 *SISTEM SUDAH VERSI TERBARU!*\n\n` +
                        `• Branch: \`${branch}\`\n` +
                        `• Commit Saat Ini: \`${currentCommit}\`\n` +
                        `• Status Git: ✅ *Up to date* (Tidak ada pembaruan baru di GitHub).\n\n` +
                        `_Seluruh fitur bot, gateway pembayaran, dan patch keamanan sudah menggunakan versi terbaru._`,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Cek Ulang', callback_data: 'tg_check_update' }],
                            [{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]
                        ]
                    }
                };
            } else {
                const changelog = execSync(`git log -n 5 --pretty=format:"• \`%h\`: %s" HEAD..origin/${branch}`, { stdio: 'pipe', encoding: 'utf-8' }).trim();

                return {
                    isUpToDate: false,
                    currentCommit,
                    behindCount,
                    text: `🚀 *PEMBARUAN TERSEDIA DI GITHUB!*\n\n` +
                        `Ditemukan *${behindCount} commit pembaruan baru* pada branch \`${branch}\`.\n\n` +
                        `*Versi Lokal Saat Ini:*\n\`${currentCommit}\`\n\n` +
                        `*Log Pembaruan Baru:*\n${changelog}\n\n` +
                        `_Klik tombol di bawah untuk mengunduh pembaruan dan merestart bot secara otomatis._`,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⚡ Update Sekarang & Restart', callback_data: 'tg_apply_update' }],
                            [{ text: '⬅️ Kembali ke Dashboard', callback_data: 'tg_menu' }]
                        ]
                    }
                };
            }
        };

        const renderTelegramDashboard = () => {
            const wa = getWaStatus();
            const activeGw = (config.paymentGateway || 'paymentkita').toLowerCase();
            const storeStatus = db.store.buka ? "🟢 BUKA" : "🔴 TUTUP (Offline)";
            const totalUsers = (typeof getMemberList === 'function') ? getMemberList().length : Object.keys(db.users || {}).length;
            const totalProducts = (db.ppob || []).length;
            const totalDigital = (db.menu || []).length;
            const pendingOrders = (db.orders || []).filter(o => o.status === 'pending' || o.status === 'processing').length;

            let text = `🤖 *COMMAND CENTER BOT PPOB & TOKO DIGITAL*\n`;
            text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            text += `🏪 *Toko:* *${db.store.namaToko || "DIGITAL STORE"}* (${storeStatus})\n`;
            text += `📱 *WhatsApp:* ${wa.connected ? `🟢 Terhubung (\`+${wa.phone}\`)` : '🔴 Belum Terhubung'}\n`;
            text += `💳 *Gateway:* *${activeGw.toUpperCase()}*\n`;
            text += `⚡ *Digiflazz:* ${config.digiflazz.username ? `🟢 \`${config.digiflazz.username}\`` : '🔴 Belum Diatur'}\n`;
            text += `📦 *Katalog:* ${totalProducts} PPOB | ${totalDigital} Digital\n`;
            text += `⏳ *Antrian:* ${pendingOrders} Trx | 👥 *Member:* ${totalUsers} Akun\n`;
            text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
            text += `_Silakan pilih menu kendali melalui tombol di bawah:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '👥 Manajemen Member', callback_data: 'tg_member_menu' },
                        { text: '🏪 Pengaturan Toko', callback_data: 'tg_store_menu' }
                    ],
                    [
                        { text: '📦 Produk Digital / Akun', callback_data: 'tg_digital_menu' },
                        { text: '🔍 Cari & Resend Trx', callback_data: 'tg_trx_menu' }
                    ],
                    [
                        { text: '📢 Broadcast Pesan WA', callback_data: 'tg_broadcast_menu' },
                        { text: `⏳ Antrian Order (${pendingOrders})`, callback_data: 'tg_lunas' }
                    ],
                    [
                        { text: `💳 Gateway: ${activeGw.toUpperCase()}`, callback_data: 'tg_gw_menu' },
                        { text: '⚡ Menu Digiflazz', callback_data: 'tg_digi_menu' }
                    ],
                    [
                        { text: '💰 Cek Saldo Digi', callback_data: 'tg_cekdigi' },
                        { text: '🔄 Sync Produk PPOB', callback_data: 'tg_sync' }
                    ],
                    [
                        { text: '📊 Status & Health', callback_data: 'tg_health' },
                        { text: '📊 Laba & Statistik', callback_data: 'tg_stats' }
                    ],
                    [
                        { text: '⚙️ Margin & Owner', callback_data: 'tg_settings_menu' },
                        { text: '📦 Auto-Backup & Restore', callback_data: 'tg_backup_menu' }
                    ],
                    [
                        { text: '⚖️ S&K & Batasan Hukum', callback_data: 'tg_legal_snk' }
                    ],
                    [
                        { text: '🚀 Cek Pembaruan / Update Bot', callback_data: 'tg_check_update' }
                    ],
                    [
                        { text: wa.connected ? '📱 Re-Pairing WA' : '📱 Hubungkan WA', callback_data: 'tg_pair' },
                        { text: '🔄 Refresh', callback_data: 'tg_menu' }
                    ]
                ]
            };

            return { text, reply_markup };
        };

        const renderLegalMenu = (mode = 'general') => {
            const legal = require('./lib/legal');
            const text = mode === 'digital' ? legal.getTermsDigitalTg() : legal.getTermsTelegram();
            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: mode === 'general' ? '• 📱 S&K Umum PPOB •' : '📱 S&K Umum PPOB', callback_data: 'tg_legal_snk' },
                        { text: mode === 'digital' ? '• 🔑 S&K Akun Digital •' : '🔑 S&K Akun Digital', callback_data: 'tg_legal_digital' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderStoreMenu = () => {
            const storeStatus = db.store.buka ? "🟢 BUKA (Menerima Pesanan)" : "🔴 TUTUP (Toko Offline)";
            let text = `🏪 *PENGATURAN TOKO DIGITAL*\n\n`;
            text += `• Nama Toko: *${db.store.namaToko || "DIGITAL STORE"}*\n`;
            text += `• Status Operasional: *${storeStatus}*\n`;
            text += `• Total Produk PPOB: *${(db.ppob || []).length} SKU*\n`;
            text += `• Total Produk Digital: *${(db.menu || []).length} Item*\n\n`;
            text += `_Pilih aksi pengaturan toko di bawah:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: db.store.buka ? '🔴 Tutup Toko' : '🟢 Buka Toko', callback_data: 'tg_toggletoko' },
                        { text: '🏷️ Ubah Nama Toko', callback_data: 'tg_input_namatoko' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderMemberMenu = () => {
            const memberList = (typeof getMemberList === 'function') ? getMemberList() : [];
            const totalUsers = memberList.length;
            const totalSaldo = memberList.reduce((acc, m) => acc + (Number(m.saldo || m.user?.saldo) || 0), 0);

            let text = `👥 *MANAJEMEN PENGGUNA & MEMBER*\n\n`;
            text += `• Total Member Terdaftar: *${totalUsers} pengguna*\n`;
            text += `• Total Saldo Mengendap: *${formatRupiah(totalSaldo)}*\n\n`;
            text += `_Pilih aksi manajemen member di bawah:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '🔍 Cek Profil Member', callback_data: 'tg_input_cekuser' },
                        { text: '🏆 Top Member', callback_data: 'tg_topmember' }
                    ],
                    [
                        { text: '💳 Edit Saldo (+ / -)', callback_data: 'tg_input_editsaldo' },
                        { text: '✏️ Ubah Nama Member', callback_data: 'tg_input_setname_manual' }
                    ],
                    [
                        { text: '➕ Tambah Member Manual', callback_data: 'tg_input_addmember' },
                        { text: '📋 10 Member Terbaru', callback_data: 'tg_listmember' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderDigitalMenu = () => {
            const items = db.menu || [];
            const totalRawData = items.reduce((acc, m) => acc + (m.dataAkun?.length || 0), 0);

            let text = `📦 *MANAJEMEN PRODUK DIGITAL & AKUN*\n\n`;
            text += `• Jumlah Produk: *${items.length} item*\n`;
            text += `• Total Stok Data Mentah: *${totalRawData} akun/voucher*\n\n`;
            text += `_Pilih aksi manajemen produk digital di bawah:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '📂 Daftar Produk Digital', callback_data: 'tg_listproduk' },
                        { text: '➕ Tambah Produk', callback_data: 'tg_input_addmenu' }
                    ],
                    [
                        { text: '💰 Edit Harga Produk', callback_data: 'tg_input_editharga' },
                        { text: '📦 Edit Stok Produk', callback_data: 'tg_input_editstok' }
                    ],
                    [
                        { text: '📥 Isi Stok Data Akun', callback_data: 'tg_input_adddata' },
                        { text: '🗑️ Hapus Produk', callback_data: 'tg_input_delmenu' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderTrxMenu = () => {
            const orders = db.orders || [];
            const pendingOrders = orders.filter(o => o.status === 'pending' || o.status === 'processing').length;
            const successOrders = orders.filter(o => o.status === 'success').length;

            let text = `🔍 *PENCARIAN TRANSAKSI & RESEND SN*\n\n`;
            text += `• Total Transaksi: *${orders.length} order*\n`;
            text += `• Transaksi Sukses: *${successOrders} order*\n`;
            text += `• Antrian Pending/Proses: *${pendingOrders} order*\n\n`;
            text += `_Pilih aksi di bawah untuk mencari invoice atau refund order:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '🔍 Cari Invoice & Resend SN', callback_data: 'tg_input_cekinv' },
                        { text: '💸 Batalkan & Refund Order', callback_data: 'tg_input_refund' }
                    ],
                    [
                        { text: `⏳ Cek Antrian Pending (${pendingOrders})`, callback_data: 'tg_lunas' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderBroadcastMenu = () => {
            const phones = getUniqueUserPhones();
            let text = `📢 *BROADCAST PESAN WHATSAPP MASSAL*\n\n`;
            text += `Kirimkan pengumuman atau promosi ke seluruh kontak WhatsApp member yang tersimpan di database.\n\n`;
            text += `• Total Penerima Terdaftar: *${phones.length} nomor*\n`;
            text += `• Kecepatan Pengiriman: *1 detik / pesan (Pacing Anti-Banned)*\n\n`;
            text += `_Tekan tombol di bawah untuk mulai menulis pesan broadcast:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '✍️ Tulis Pesan Broadcast', callback_data: 'tg_input_broadcast' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderGatewayMenu = () => {
            const activeGw = (config.paymentGateway || 'paymentkita').toLowerCase();
            let text = `💳 *PENGATURAN PAYMENT GATEWAY*\n\n`;
            text += `Gateway Aktif Saat Ini: *${activeGw.toUpperCase()}*\n\n`;
            text += `🔹 *PaymentKita:*\n`;
            text += `• Merchant ID: \`${config.paymentkita.merchantId || '(Belum diset)'}\`\n`;
            text += `• Secret Key: \`${maskSecret(config.paymentkita.secret)}\`\n\n`;
            text += `🔹 *Pakasir:*\n`;
            text += `• Project Slug: \`${config.pakasir.project || '(Belum diset)'}\`\n`;
            text += `• API Key: \`${maskSecret(config.pakasir.key)}\`\n\n`;
            text += `_Pilih aksi melalui tombol di bawah:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: activeGw === 'paymentkita' ? '✅ PaymentKita (Aktif)' : '⚡ Aktifkan PaymentKita', callback_data: 'tg_setgw_pk' },
                        { text: activeGw === 'pakasir' ? '✅ Pakasir (Aktif)' : '⚡ Aktifkan Pakasir', callback_data: 'tg_setgw_pakasir' }
                    ],
                    [
                        { text: '🔑 Set Kredensial PaymentKita', callback_data: 'tg_input_pk' },
                        { text: '🔑 Set Kredensial Pakasir', callback_data: 'tg_input_pakasir' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };

            return { text, reply_markup };
        };

        const renderDigiMenu = () => {
            let text = `⚡ *PENGATURAN DIGIFLAZZ*\n\n`;
            text += `• Username: \`${config.digiflazz.username || '(Belum diatur)'}\`\n`;
            text += `• API Key: \`${maskSecret(config.digiflazz.key)}\`\n\n`;
            text += `_Pilih aksi melalui tombol di bawah:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '🔑 Set Username & Key', callback_data: 'tg_input_digi' }
                    ],
                    [
                        { text: '💰 Cek Saldo Digi', callback_data: 'tg_cekdigi' },
                        { text: '🔄 Sinkronisasi Produk', callback_data: 'tg_sync' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };

            return { text, reply_markup };
        };

        const renderSettingsMenu = () => {
            const configData = require('./config');
            const lim = marginHelper.getTierLimits();
            const tier = marginHelper.getProfitTier();
            const pascaFee = (configData.profit && typeof configData.profit.pasca === 'number') ? configData.profit.pasca : 1500;
            const ppobCount = Array.isArray(db.ppob) ? db.ppob.length : 0;

            let text = `⚙️ *PENGATURAN TOKO & SKEMA MARGIN AUTOTIER*\n\n`;
            text += `🏪 *Nama Toko:* ${db.store.namaToko || "DIGITAL STORE"}\n`;
            text += `👑 *Owner Terdaftar:* ${configData.owner.map(o => o.split('@')[0]).join(', ') || 'Belum ada'}\n\n`;

            text += `📊 *1. Skema Margin Auto-Tier Prabayar (Berdasarkan Modal):*\n`;
            text += `_Keuntungan produk otomatis mengikuti nominal modal prabayar:_\n\n`;

            text += `🟢 *Tier Kecil* (Rp 0 - ${formatRupiah(lim.kecil)}):\n`;
            text += `   ➥ Margin: *${formatRupiah(tier.kecil)}*\n`;
            text += `   _(Pulsa 5k-25k, Kuota Harian, E-Money 10k-20k)_\n\n`;

            text += `🟡 *Tier Sedang* (${formatRupiah(lim.kecil + 1)} - ${formatRupiah(lim.sedang)}):\n`;
            text += `   ➥ Margin: *${formatRupiah(tier.sedang)}*\n`;
            text += `   _(Pulsa 30k-100k, Token PLN 50k/100k, Kuota Bulanan)_\n\n`;

            text += `🔵 *Tier Besar* (${formatRupiah(lim.sedang + 1)} - ${formatRupiah(lim.besar)}):\n`;
            text += `   ➥ Margin: *${formatRupiah(tier.besar)}*\n`;
            text += `   _(Pulsa 150k-200k, Token PLN 200k, Kuota Jumbo)_\n\n`;

            text += `🟣 *Tier Premium* (> ${formatRupiah(lim.besar)}):\n`;
            text += `   ➥ Margin: *${formatRupiah(tier.premium)}*\n`;
            text += `   _(Token PLN 500k-1Jt, Game Voucher Besar, Kuota Tahunan)_\n\n`;

            text += `📑 *2. Biaya Admin Loket Pascabayar:*\n`;
            text += `   ➥ Fee Loket Toko: *${formatRupiah(pascaFee)}* per transaksi\n`;
            text += `   _(PLN Pasca, PDAM, BPJS, Telkom, dll. Murni fee admin loket, terpisah dari autotier)_\n\n`;

            text += `📦 *Total Produk PPOB di Katalog:* ${ppobCount} Produk\n`;
            text += `_💡 Klik tombol di bawah untuk mengubah margin masing-masing tier secara dinamis:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: `🟢 Kecil: ${formatRupiah(tier.kecil)}`, callback_data: 'tg_set_tier_kecil' },
                        { text: `🟡 Sedang: ${formatRupiah(tier.sedang)}`, callback_data: 'tg_set_tier_sedang' }
                    ],
                    [
                        { text: `🔵 Besar: ${formatRupiah(tier.besar)}`, callback_data: 'tg_set_tier_besar' },
                        { text: `🟣 Premium: ${formatRupiah(tier.premium)}`, callback_data: 'tg_set_tier_premium' }
                    ],
                    [
                        { text: `📑 Fee Pasca: ${formatRupiah(pascaFee)}`, callback_data: 'tg_set_pasca_profit' },
                        { text: '📏 Atur Batas Range', callback_data: 'tg_set_tier_range' }
                    ],
                    [
                        { text: '🏷️ Ganti Nama Toko', callback_data: 'tg_input_namatoko' },
                        { text: '🔄 Hitung Ulang Harga', callback_data: 'tg_recalc_prices' }
                    ],
                    [
                        { text: '👑 Tambah Owner', callback_data: 'tg_input_addowner' },
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };

            return { text, reply_markup };
        };

        const renderBackupMenu = () => {
            const interval = Number(db.store?.backupIntervalMinutes !== undefined ? db.store.backupIntervalMinutes : 60);
            const intervalText = interval > 0 ? `🟢 *AKTIF* (Setiap ${interval} Menit)` : `🔴 *NONAKTIF*`;

            let latestBackup = 'Belum ada file backup';
            let latestSize = '-';
            try {
                const zips = fs.readdirSync('.').filter(f => /^AUTO-BACKUP-[\w.-]+\.zip$/.test(f)).sort().reverse();
                if (zips.length > 0) {
                    latestBackup = zips[0];
                    const stat = fs.statSync(latestBackup);
                    latestSize = (stat.size / 1024 / 1024).toFixed(2) + ' MB';
                }
            } catch (_) {}

            let text = `📦 *MANAJEMEN AUTO-BACKUP & RESTORE DATA*\n\n` +
                       `• Status Auto-Backup : ${intervalText}\n` +
                       `• Penyimpanan VPS    : ✅ *Hanya simpan 1 file terakhir* (Replace otomatis)\n` +
                       `• File Backup VPS    : \`${latestBackup}\`\n` +
                       `• Ukuran File Backup : *${latestSize}*\n\n` +
                       `💡 _File backup mencakup seluruh database, konfigurasi akun, dan sesi WhatsApp lengkap untuk restore di VPS baru._\n\n` +
                       `_Pilih aksi yang ingin Anda lakukan:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '📦 Backup Manual Sekarang', callback_data: 'tg_backup_now' }
                    ],
                    [
                        { text: `⏱️ Atur Durasi (${interval > 0 ? interval + 'm' : 'Off'})`, callback_data: 'tg_backup_duration_menu' },
                        { text: '🔄 Restore ke VPS Ini', callback_data: 'cmd_restore' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderBackupDurationMenu = () => {
            const currentInterval = Number(db.store?.backupIntervalMinutes !== undefined ? db.store.backupIntervalMinutes : 60);
            let text = `⏱️ *PENGATURAN DURASI AUTO-BACKUP*\n\n` +
                       `Durasi saat ini: *${currentInterval > 0 ? currentInterval + ' Menit' : 'Nonaktif'}*\n\n` +
                       `Pilih seberapa sering sistem akan membuat file backup lengkap (.zip) dan mengirimkannya secara otomatis ke bot Telegram ini:\n\n` +
                       `_(Di VPS, sistem selalu otomatis menghapus file lama dan hanya menyimpan 1 file backup terbaru agar hemat disk)_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: (currentInterval === 30 ? '✅ ' : '') + '⚡ 30 Menit', callback_data: 'tg_set_interval_30' },
                        { text: (currentInterval === 60 ? '✅ ' : '') + '⏱️ 60 Menit (Default)', callback_data: 'tg_set_interval_60' }
                    ],
                    [
                        { text: (currentInterval === 120 ? '✅ ' : '') + '🕒 2 Jam (120m)', callback_data: 'tg_set_interval_120' },
                        { text: (currentInterval === 360 ? '✅ ' : '') + '🕕 6 Jam (360m)', callback_data: 'tg_set_interval_360' }
                    ],
                    [
                        { text: (currentInterval === 720 ? '✅ ' : '') + '🕛 12 Jam', callback_data: 'tg_set_interval_720' },
                        { text: (currentInterval === 1440 ? '✅ ' : '') + '📅 24 Jam (1 Hari)', callback_data: 'tg_set_interval_1440' }
                    ],
                    [
                        { text: (currentInterval === 0 ? '✅ ' : '') + '🛑 Nonaktifkan Auto-Backup', callback_data: 'tg_set_interval_0' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Backup', callback_data: 'tg_backup_menu' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const safeTg = (t = '') => String(t || '').replace(/[_*`\[\]]/g, ' ');

        const renderStatsOverview = () => {
            const sToday = analytics.getStatsSummary('today');
            const s7d = analytics.getStatsSummary('7d');
            const s30d = analytics.getStatsSummary('30d');
            const sAll = analytics.getStatsSummary('all');
            const userCount = Object.keys(db.users || {}).length;

            let text = `📊 *LAPORAN PENJUALAN & LABA BERSIH*\n\n`;
            text += `📅 *HARI INI (${sToday.rangeLabel}):*\n`;
            text += `• Transaksi Sukses : *${sToday.successCount} trx* (Gagal: ${sToday.failedCount})\n`;
            text += `• Omzet Penjualan  : *${formatRupiah(sToday.omzet)}*\n`;
            text += `• 💰 *Laba Bersih*  : *${formatRupiah(sToday.labaBersih)}* _(${sToday.marginPercent}% margin)_\n\n`;

            text += `🗓️ *7 HARI TERAKHIR:*\n`;
            text += `• Transaksi Sukses : *${s7d.successCount} trx*\n`;
            text += `• Omzet Penjualan  : *${formatRupiah(s7d.omzet)}*\n`;
            text += `• 💰 *Laba Bersih*  : *${formatRupiah(s7d.labaBersih)}*\n\n`;

            text += `📆 *30 HARI TERAKHIR (BULAN INI):*\n`;
            text += `• Transaksi Sukses : *${s30d.successCount} trx*\n`;
            text += `• Omzet Penjualan  : *${formatRupiah(s30d.omzet)}*\n`;
            text += `• 💰 *Laba Bersih*  : *${formatRupiah(s30d.labaBersih)}*\n\n`;

            text += `🏆 *KESELURUHAN (ALL-TIME):*\n`;
            text += `• Total Sukses     : *${sAll.successCount} trx* | Gagal: *${sAll.failedCount}*\n`;
            text += `• Total Omzet      : *${formatRupiah(sAll.omzet)}*\n`;
            text += `• 💰 *Total Laba*   : *${formatRupiah(sAll.labaBersih)}*\n`;
            text += `• Total Pengguna   : *${userCount} member*\n\n`;
            text += `_💡 Pilih menu di bawah untuk rincian analisis atau cek tanggal tertentu:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '🔍 Cek Tanggal Tertentu', callback_data: 'tg_stats_datepicker' }
                    ],
                    [
                        { text: '🏆 Produk Terlaris', callback_data: 'tg_stats_topproduk' },
                        { text: '⚠️ Laporan Produk Gagal', callback_data: 'tg_stats_produkgagal' }
                    ],
                    [
                        { text: '👥 Top Member Trx', callback_data: 'tg_stats_topmember' },
                        { text: '🔄 Refresh Data', callback_data: 'tg_stats' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Dashboard', callback_data: 'tg_menu' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderDatePickerMenu = () => {
            let text = `🔍 *CEK LABA BERSIH TANGGAL TERTENTU*\n\n`;
            text += `Anda dapat memeriksa omzet, laba bersih, dan rincian produk yang terjual pada tanggal spesifik.\n\n`;
            text += `_Pilih opsi cepat di bawah atau ketik tanggal manual:_`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '📅 Hari Ini', callback_data: 'tg_stats_date_today' },
                        { text: '⏮️ Kemarin', callback_data: 'tg_stats_date_yesterday' }
                    ],
                    [
                        { text: '⏮️ 2 Hari Lalu', callback_data: 'tg_stats_date_2days' },
                        { text: '⌨️ Ketik Tanggal Manual', callback_data: 'tg_input_stats_date' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Laporan', callback_data: 'tg_stats' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderDateDetail = (dateInput) => {
            const dayData = analytics.getDayStats(dateInput);
            if (!dayData.success) {
                return {
                    text: `❌ *TANGGAL TIDAK VALID*\n\n${dayData.message}`,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Coba Lagi', callback_data: 'tg_input_stats_date' }],
                            [{ text: '⬅️ Kembali ke Laporan', callback_data: 'tg_stats' }]
                        ]
                    }
                };
            }

            let text = `📅 *LAPORAN TANGGAL: ${dayData.dateFormatted.toUpperCase()}*\n\n`;
            text += `• Total Transaksi   : *${dayData.totalOrders} trx*\n`;
            text += `• Transaksi Sukses  : *${dayData.successCount} trx*\n`;
            text += `• Transaksi Gagal   : *${dayData.failedCount} trx*\n`;
            text += `• Transaksi Pending : *${dayData.pendingCount} trx*\n\n`;
            text += `💵 *Omzet Penjualan* : *${formatRupiah(dayData.omzet)}*\n`;
            text += `💰 *Laba Bersih Toko*: *${formatRupiah(dayData.labaBersih)}* _(${dayData.marginPercent}% margin)_\n\n`;

            text += `📦 *Rincian Produk Terjual:*\n`;
            if (dayData.itemsSold.length === 0) {
                text += `_Tidak ada produk yang berhasil terjual pada tanggal ini._\n`;
            } else {
                dayData.itemsSold.forEach((item, i) => {
                    text += `${i + 1}. *${safeTg(item.name)}*\n`;
                    text += `   ➥ Terjual: *${item.qty}x* | Omzet: *${formatRupiah(item.omzet)}* | Laba: *${formatRupiah(item.profit)}*\n`;
                });
            }

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '🔍 Cek Tanggal Lain', callback_data: 'tg_stats_datepicker' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Laporan', callback_data: 'tg_stats' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderTopProductsMenu = (days = 0) => {
            const data = analytics.getTopProducts(10, days);
            let text = `🏆 *TOP 10 PRODUK PALING BANYAK DIBELI*\n`;
            text += `Periode: *${data.periodLabel}* | Total Produk Aktif: *${data.totalUniqueProducts}*\n\n`;

            if (data.ranking.length === 0) {
                text += `_Belum ada transaksi sukses yang tercatat dalam periode ini._\n`;
            } else {
                data.ranking.forEach((item, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                    text += `${medal} *${safeTg(item.name)}*\n`;
                    text += `   ➥ Kategori: *${item.category}* | Terjual: *${item.qty}x*\n`;
                    text += `   ➥ Omzet: *${formatRupiah(item.omzet)}* | 💰 Laba: *${formatRupiah(item.profit)}*\n\n`;
                });
            }

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: days === 0 ? '✅ All-Time' : 'All-Time', callback_data: 'tg_topprod_all' },
                        { text: days === 30 ? '✅ 30 Hari' : '30 Hari', callback_data: 'tg_topprod_30' },
                        { text: days === 7 ? '✅ 7 Hari' : '7 Hari', callback_data: 'tg_topprod_7' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Laporan', callback_data: 'tg_stats' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderFailedProductsMenu = (days = 0) => {
            const data = analytics.getFailedProducts(10, days);
            let text = `⚠️ *LAPORAN ANALISA PRODUK GAGAL*\n`;
            text += `Periode: *${data.periodLabel}* | Total Gagal: *${data.totalFailedTrx} trx*\n\n`;

            if (data.ranking.length === 0) {
                text += `_🎉 Tidak ada transaksi gagal tercatat dalam periode ini._\n`;
            } else {
                text += `_Daftar produk dengan frekuensi kegagalan tertinggi (evaluasi Digiflazz):_\n\n`;
                data.ranking.forEach((item, i) => {
                    text += `${i + 1}. ❌ *${safeTg(item.name)}*\n`;
                    text += `   • Total Gagal : *${item.failCount} kali*\n`;
                    text += `   • Alasan      : _${safeTg(item.topReasons)}_\n\n`;
                });
            }

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: days === 0 ? '✅ All-Time' : 'All-Time', callback_data: 'tg_failprod_all' },
                        { text: days === 30 ? '✅ 30 Hari' : '30 Hari', callback_data: 'tg_failprod_30' },
                        { text: days === 7 ? '✅ 7 Hari' : '7 Hari', callback_data: 'tg_failprod_7' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Laporan', callback_data: 'tg_stats' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const renderTopMembersTrxMenu = (days = 0) => {
            const data = analytics.getTopMembers(10, days);
            let text = `👥 *PERINGKAT MEMBER TRANSAKSI TERBANYAK*\n`;
            text += `Periode: *${data.periodLabel}* | Pembeli Aktif: *${data.totalActiveBuyers} orang*\n\n`;

            if (data.ranking.length === 0) {
                text += `_Belum ada member bertransaksi sukses pada periode ini._\n`;
            } else {
                data.ranking.forEach((m, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                    const dispP = formatDisplayPhone(m.phone);
                    const nameStr = m.name ? ` (${safeTg(m.name)})` : '';
                    text += `${medal} \`${dispP}\`${nameStr}\n`;
                    text += `   ➥ Frekuensi : *${m.trxCount} transaksi*\n`;
                    text += `   ➥ Belanja   : *${formatRupiah(m.totalBelanja)}* | 💰 Profit Toko: *${formatRupiah(m.totalProfit)}*\n\n`;
                });
            }

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: days === 0 ? '✅ All-Time' : 'All-Time', callback_data: 'tg_topmem_all' },
                        { text: days === 30 ? '✅ 30 Hari' : '30 Hari', callback_data: 'tg_topmem_30' },
                        { text: days === 7 ? '✅ 7 Hari' : '7 Hari', callback_data: 'tg_topmem_7' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Laporan', callback_data: 'tg_stats' }
                    ]
                ]
            };
            return { text, reply_markup };
        };

        const updateOrSend = async (chatId, messageId, content) => {
            try {
                if (messageId) {
                    await global.botTg.editMessageText(content.text, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: content.reply_markup
                    });
                    return;
                }
            } catch (_) {}
            await global.botTg.sendMessage(chatId, content.text, {
                parse_mode: 'Markdown',
                reply_markup: content.reply_markup
            });
        };

        // Trigger Pairing WhatsApp
        const triggerPairing = async (chatId, rawPhone) => {
            let cleanPhone = (rawPhone || '').replace(/[^0-9]/g, '');
            if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);

            if (!cleanPhone.startsWith('62') || cleanPhone.length < 10) {
                return global.botTg.sendMessage(chatId, 
                    `❌ *Format Nomor Tidak Valid!*\n\n` +
                    `Nomor harus diawali angka *62* dan minimal 10 digit (contoh: \`6281234567890\`).\n\n` +
                    `Silakan ketik ulang nomor WhatsApp Anda:`, 
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_menu' }]]
                        }
                    }
                );
            }

            global.tgInputState = null;
            await global.botTg.sendMessage(chatId, 
                `⏳ *Menghubungkan ke server WhatsApp...*\n\n` +
                `Nomor target: \`${cleanPhone}\`\n\n` +
                `_Menyiapkan socket Baileys dan meminta kode pairing (mohon tunggu 3-5 detik)..._`, 
                { parse_mode: 'Markdown' }
            );

            try {
                if (global.sock) {
                    try { await global.sock.end(); } catch (_) {}
                    global.sock = null;
                }

                try {
                    fs.rmSync('./session_bot', { recursive: true, force: true });
                } catch (_) {}

                await startBot(cleanPhone, chatId);
            } catch (err) {
                console.error('[TELEGRAM PAIRING ERROR]:', err);
                global.botTg.sendMessage(chatId, 
                    `❌ *Gagal Memulai Pairing:*\n\`${err.message}\``, 
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔄 Coba Tautkan Ulang', callback_data: 'tg_pair' }],
                                [{ text: '⬅️ Menu Utama', callback_data: 'tg_menu' }]
                            ]
                        }
                    }
                );
            }
        };

        // 🔘 CALLBACK QUERY LISTENER
        global.botTg.on('callback_query', async (query) => {
            const chatId = String(query.message?.chat?.id || query.from?.id || '');
            const messageId = query.message?.message_id;
            const authorizedChatId = String(config.telegram.chatId || '').trim();

            if (authorizedChatId && chatId !== authorizedChatId) {
                return global.botTg.answerCallbackQuery(query.id, { 
                    text: `❌ Akses ditolak! Chat ID Anda (${chatId}) tidak terdaftar sebagai Admin.`, 
                    show_alert: true 
                });
            }

            const action = query.data;

            if (action === 'tg_menu') {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderTelegramDashboard());
            }

            // === TOKO ===
            if (action === 'tg_store_menu') {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderStoreMenu());
            }

            if (action === 'tg_toggletoko') {
                db.store.buka = !db.store.buka;
                if (db.saveStore) db.saveStore();
                else if (db.save) db.save();
                global.botTg.answerCallbackQuery(query.id, { 
                    text: db.store.buka ? '🟢 Toko berhasil DIBUKA!' : '🔴 Toko berhasil DITUTUP!' 
                });
                return updateOrSend(chatId, messageId, renderStoreMenu());
            }

            // === MEMBER ===
            if (action === 'tg_member_menu') {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderMemberMenu());
            }

            if (action === 'tg_listmember') {
                global.botTg.answerCallbackQuery(query.id);
                const members = getMemberList().slice(0, 10);

                let text = `👥 *10 MEMBER TERBARU*\n\n`;
                if (members.length === 0) {
                    text += `_Belum ada member terdaftar di database._`;
                } else {
                    members.forEach((m, i) => {
                        const nameStr = m.name ? ` (${cleanMd(m.name)})` : '';
                        const dateStr = m.date ? new Date(m.date).toLocaleDateString('id-ID') : '-';
                        const dispP = m.displayPhone || formatDisplayPhone(m.phone);
                        text += `${i + 1}. \`${dispP}\`${nameStr}\n   💰 ${formatRupiah(m.saldo || 0)} | 📅 ${dateStr}\n\n`;
                    });
                }

                const inline_keyboard = [];
                // Tombol cepat langsung ke profil masing-masing member terbaru
                members.slice(0, 5).forEach(m => {
                    const dispP = m.displayPhone || formatDisplayPhone(m.phone);
                    const label = m.name 
                        ? `👤 ${dispP} ${m.name.slice(0, 14)}` 
                        : `📱 ${dispP}`;
                    inline_keyboard.push([
                        { text: `${label} • ${formatRupiah(m.saldo)}`, callback_data: `tg_viewuser_${m.phone}` }
                    ]);
                });

                inline_keyboard.push([
                    { text: '🔍 Lihat Semua Member (Tombol)', callback_data: 'tg_input_cekuser' }
                ]);
                inline_keyboard.push([
                    { text: '➕ Tambah Member', callback_data: 'tg_input_addmember' },
                    { text: '⬅️ Kembali ke Menu Member', callback_data: 'tg_member_menu' }
                ]);

                return updateOrSend(chatId, messageId, {
                    text,
                    reply_markup: { inline_keyboard }
                });
            }

            if (action === 'tg_topmember') {
                global.botTg.answerCallbackQuery(query.id);
                const members = getMemberList();
                const topSaldo = [...members]
                    .filter(m => (Number(m.saldo) || 0) > 0)
                    .sort((a, b) => (Number(b.saldo) || 0) - (Number(a.saldo) || 0))
                    .slice(0, 5);

                const spendingMap = {};
                (db.orders || []).forEach(o => {
                    if (o.status !== 'success') return;
                    const buyer = o.buyer || o.sender || '';
                    if (!buyer) return;
                    const cleanP = normalizePhone(buyer);
                    if (!isRealPhone(cleanP)) return;
                    const amount = Number(o.baseAmount || o.total || 0);
                    spendingMap[cleanP] = (spendingMap[cleanP] || 0) + amount;
                });
                const topSpender = Object.entries(spendingMap)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5);

                let text = `🏆 *TOP MEMBER BOT PPOB*\n\n`;
                text += `💰 *TOP 5 SALDO TERTINGGI:*\n`;
                if (topSaldo.length === 0) {
                    text += `_Belum ada member dengan saldo tersimpan._\n`;
                } else {
                    topSaldo.forEach((m, i) => {
                        const dispP = m.displayPhone || formatDisplayPhone(m.phone);
                        const nameStr = m.name ? ` (${cleanMd(m.name)})` : '';
                        text += `${i + 1}. \`${dispP}\`${nameStr} : *${formatRupiah(m.saldo || 0)}*\n`;
                    });
                }

                text += `\n🔥 *TOP 5 TOTAL BELANJA (SUKSES):*\n`;
                if (topSpender.length === 0) {
                    text += `_Belum ada transaksi sukses tercatat._\n`;
                } else {
                    topSpender.forEach(([phone, total], i) => {
                        const dispP = formatDisplayPhone(phone);
                        const found = findMember(phone);
                        const nameStr = (found && found.name) ? ` (${cleanMd(found.name)})` : '';
                        text += `${i + 1}. \`${dispP}\`${nameStr} : *${formatRupiah(total)}*\n`;
                    });
                }

                return updateOrSend(chatId, messageId, {
                    text,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Refresh Top Member', callback_data: 'tg_topmember' }],
                            [{ text: '⬅️ Kembali ke Menu Member', callback_data: 'tg_member_menu' }]
                        ]
                    }
                });
            }

            if (action === 'tg_input_cekuser' || action.startsWith('tg_pick_member_')) {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                const page = action.startsWith('tg_pick_member_')
                    ? parseInt(action.replace('tg_pick_member_', ''), 10) || 0
                    : 0;
                return updateOrSend(chatId, messageId, renderMemberPicker(page));
            }

            if (action === 'tg_input_cekuser_manual') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_cekuser', chatId };
                return global.botTg.sendMessage(chatId,
                    `🔍 *CEK PROFIL MEMBER (KETIK MANUAL)*\n\n` +
                    `Silakan balas pesan ini dengan nomor WhatsApp member yang ingin dicek:\n` +
                    `Contoh: \`6281234567890\` atau \`081234567890\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '👥 Pilih Dari Tombol Member', callback_data: 'tg_input_cekuser' }],
                                [{ text: '❌ Batal', callback_data: 'tg_member_menu' }]
                            ]
                        }
                    }
                );
            }

            if (action.startsWith('tg_viewuser_')) {
                const phone = action.replace('tg_viewuser_', '');
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderMemberProfile(phone));
            }

            if (action === 'tg_input_editsaldo') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_editsaldo', chatId };
                return global.botTg.sendMessage(chatId,
                    `💳 *EDIT SALDO MEMBER (+ / -)*\n\n` +
                    `Kirimkan nomor dan nominal perubahan saldo:\n` +
                    `Format: \`<NOMOR> <+ / -><NOMINAL>\`\n\n` +
                    `• Tambah Saldo: \`6281234567890 +50000\`\n` +
                    `• Tarik Saldo: \`6281234567890 -25000\`\n\n` +
                    `_Tips: Anda juga dapat memilih langsung dari tombol member di bawah:_`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '👥 Pilih Member Dari Tombol', callback_data: 'tg_input_cekuser' }],
                                [{ text: '❌ Batal', callback_data: 'tg_member_menu' }]
                            ]
                        }
                    }
                );
            }

            if (action.startsWith('tg_salplus_')) {
                const phone = action.replace('tg_salplus_', '');
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'quick_saldo', mode: 'plus', phone, chatId };
                return global.botTg.sendMessage(chatId,
                    `➕ *TAMBAH SALDO MEMBER*\n\n` +
                    `Target: \`+${phone}\`\n\n` +
                    `Ketik nominal yang ingin ditambahkan (contoh: \`50000\`):`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                    }
                );
            }

            if (action.startsWith('tg_salmin_')) {
                const phone = action.replace('tg_salmin_', '');
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'quick_saldo', mode: 'minus', phone, chatId };
                return global.botTg.sendMessage(chatId,
                    `➖ *TARIK / KURANGI SALDO MEMBER*\n\n` +
                    `Target: \`+${phone}\`\n\n` +
                    `Ketik nominal yang ingin ditarik (contoh: \`20000\`):`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                    }
                );
            }

            if (action === 'tg_input_addmember') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_addmember', chatId };
                return global.botTg.sendMessage(chatId,
                    `➕ *TAMBAH MEMBER MANUAL*\n\n` +
                    `Kirimkan data member baru dipisahkan spasi:\n` +
                    `Format: \`<NOMOR> <NAMA> <SALDO_AWAL>\`\n` +
                    `Contoh: \`62812345678 Budi 50000\`\n` +
                    `_Catatan: Saldo awal boleh diisi 0._`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                    }
                );
            }

            if (action.startsWith('tg_setname_')) {
                const phone = action.replace('tg_setname_', '');
                global.botTg.answerCallbackQuery(query.id);
                const found = findMember(phone);
                const currentName = (found && found.name) ? found.name : 'Belum diatur';
                const dispP = formatDisplayPhone(phone);
                global.tgInputState = { type: 'quick_setname', phone, chatId };
                return global.botTg.sendMessage(chatId,
                    `✏️ *UBAH NAMA MEMBER*\n\n` +
                    `• Nomor Member: \`${dispP}\` (\`+${phone}\`)\n` +
                    `• Nama Saat Ini: *${cleanMd(currentName)}*\n\n` +
                    `Silakan ketikkan *Nama Baru* untuk member ini:`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '❌ Batal', callback_data: `tg_viewuser_${phone}` }]
                            ]
                        }
                    }
                );
            }

            if (action === 'tg_input_setname_manual') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_setname_manual', chatId };
                return global.botTg.sendMessage(chatId,
                    `✏️ *UBAH NAMA MEMBER (MANUAL)*\n\n` +
                    `Kirimkan nomor HP dan nama baru yang diinginkan:\n` +
                    `Format: \`<NOMOR> <NAMA_BARU>\`\n` +
                    `Contoh: \`081775700114 Ansor Studio\` atau \`6281775700114 Toko Berkah\`\n\n` +
                    `_Tips: Anda juga bisa langsung klik tombol "Ubah Nama Member" pada profil masing-masing member._`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '👥 Pilih Dari Daftar Member', callback_data: 'tg_input_cekuser' }],
                                [{ text: '❌ Batal', callback_data: 'tg_member_menu' }]
                            ]
                        }
                    }
                );
            }

            // === PRODUK DIGITAL / AKUN ===
            if (action === 'tg_digital_menu') {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderDigitalMenu());
            }

            if (action === 'tg_listproduk') {
                global.botTg.answerCallbackQuery(query.id);
                const items = db.menu || [];
                let text = `📂 *DAFTAR PRODUK DIGITAL LOKAL*\n\n`;
                if (items.length === 0) {
                    text += `_Belum ada produk digital lokal terdaftar._\n_Gunakan tombol Tambah Produk untuk mulai menambahkan._`;
                } else {
                    items.forEach((m) => {
                        const rawCount = (m.dataAkun && m.dataAkun.length) ? m.dataAkun.length : 0;
                        text += `• *[ID ${m.id}]* *${m.nama}*\n`;
                        text += `  💵 Harga: ${formatRupiah(m.harga)} | 📦 Stok: ${m.stok || 0} (Akun mentah: ${rawCount})\n\n`;
                    });
                }

                return updateOrSend(chatId, messageId, {
                    text,
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '➕ Tambah Produk', callback_data: 'tg_input_addmenu' },
                                { text: '📥 Isi Stok Akun', callback_data: 'tg_input_adddata' }
                            ],
                            [
                                { text: '💰 Edit Harga', callback_data: 'tg_input_editharga' },
                                { text: '📦 Edit Stok', callback_data: 'tg_input_editstok' }
                            ],
                            [
                                { text: '🗑️ Hapus Produk', callback_data: 'tg_input_delmenu' },
                                { text: '⬅️ Menu Digital', callback_data: 'tg_digital_menu' }
                            ]
                        ]
                    }
                });
            }

            if (action === 'tg_input_addmenu') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_addmenu', chatId };
                return global.botTg.sendMessage(chatId,
                    `➕ *TAMBAH PRODUK DIGITAL BARU*\n\n` +
                    `Kirimkan nama produk, harga modal/jual, dan estimasi stok awal dipisahkan garis vertikal (\`|\`):\n` +
                    `Format: \`<NAMA_PRODUK>|<HARGA>|<STOK>\`\n` +
                    `Contoh: \`Netflix Premium 1 Bulan|35000|10\`\n` +
                    `Contoh: \`Canva Pro Lifetime|20000|5\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]] }
                    }
                );
            }

            if (action === 'tg_input_editharga') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_editharga', chatId };
                return global.botTg.sendMessage(chatId,
                    `💰 *EDIT HARGA PRODUK DIGITAL*\n\n` +
                    `Kirimkan ID Produk dan Harga Baru dipisahkan spasi:\n` +
                    `Format: \`<ID_PRODUK> <HARGA_BARU>\`\n\n` +
                    `Contoh: \`1 15000\`\n` +
                    `Contoh: \`4 7500000\`\n\n` +
                    `_Catatan: Ketik ID sesuai yang tertera pada Daftar Produk Digital._`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📂 Lihat Daftar Produk', callback_data: 'tg_listproduk' }],
                                [{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]
                            ]
                        }
                    }
                );
            }

            if (action === 'tg_input_editstok') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_editstok', chatId };
                return global.botTg.sendMessage(chatId,
                    `📦 *EDIT STOK PRODUK DIGITAL*\n\n` +
                    `Kirimkan ID Produk dan Jumlah Stok Baru dipisahkan spasi:\n` +
                    `Format: \`<ID_PRODUK> <STOK_BARU>\`\n\n` +
                    `Contoh: \`1 50\`\n` +
                    `Contoh: \`2 10\`\n\n` +
                    `_Catatan: Untuk stok yang menggunakan akun mentah, Anda juga bisa menggunakan menu Isi Stok Data Akun._`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📂 Lihat Daftar Produk', callback_data: 'tg_listproduk' }],
                                [{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]
                            ]
                        }
                    }
                );
            }

            if (action === 'tg_input_adddata') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_adddata', chatId };
                return global.botTg.sendMessage(chatId,
                    `📥 *ISI STOK DATA AKUN / VOUCHER*\n\n` +
                    `Kirimkan ID produk dan isi akun yang ingin dimasukkan:\n` +
                    `Format: \`<ID_PRODUK> <DATA_AKUN>\`\n` +
                    `Atau Isi Banyak: \`<ID_PRODUK> <JUMLAH> <DATA_AKUN>\`\n\n` +
                    `Contoh: \`1 user@mail.com:pass123\`\n` +
                    `Contoh Voucher: \`2 10 KODE-VOUCHER-TEST\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]] }
                    }
                );
            }

            if (action === 'tg_input_delmenu') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_delmenu', chatId };
                return global.botTg.sendMessage(chatId,
                    `🗑️ *HAPUS PRODUK DIGITAL*\n\n` +
                    `Ketik ID Produk Digital yang ingin dihapus:\n` +
                    `Contoh: \`1\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]] }
                    }
                );
            }

            // === PENCARIAN TRANSAKSI & RESEND ===
            if (action === 'tg_trx_menu') {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderTrxMenu());
            }

            if (action === 'tg_input_cekinv') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_cekinv', chatId };
                return global.botTg.sendMessage(chatId,
                    `🔍 *CARI INVOICE TRANSAKSI*\n\n` +
                    `Ketik ID Invoice transaksi yang ingin dicek:\n` +
                    `Contoh: \`INV-1726000000\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_trx_menu' }]] }
                    }
                );
            }

            if (action.startsWith('tg_resend_')) {
                const orderId = action.replace('tg_resend_', '');
                const order = (db.orders || []).find(o => o.id === orderId);
                if (!order) {
                    return global.botTg.answerCallbackQuery(query.id, { text: '❌ Order tidak ditemukan.', show_alert: true });
                }
                if (!order.sn) {
                    return global.botTg.answerCallbackQuery(query.id, { text: '❌ Order ini belum memiliki SN/Token!', show_alert: true });
                }
                const targetJid = db.normalizeJid ? db.normalizeJid(order.buyer || order.sender) : (order.buyer || order.sender);
                if (global.sock && typeof global.sock.sendMessage === 'function') {
                    await global.sock.sendMessage(targetJid, {
                        text: `✅ *KIRIM ULANG TRANSAKSI*\n\n` +
                              `🧾 Invoice: \`${order.id}\`\n` +
                              `📦 Produk: ${order.item || order.sku}\n` +
                              `🎯 Tujuan: ${order.target || '-'}\n` +
                              `🔑 *SN/TOKEN/AKUN:*\n\`${order.sn}\`\n\n` +
                              `Terima kasih telah berbelanja di *${db.store.namaToko || 'DIGITAL STORE'}*!`
                    }).catch(() => {});
                    return global.botTg.answerCallbackQuery(query.id, { text: `✅ SN berhasil dikirim ulang ke pembeli!`, show_alert: true });
                } else {
                    return global.botTg.answerCallbackQuery(query.id, { text: '⚠️ WhatsApp bot sedang tidak terhubung.', show_alert: true });
                }
            }

            if (action.startsWith('tg_refund_')) {
                const orderId = action.replace('tg_refund_', '');
                const order = (db.orders || []).find(o => o.id === orderId);
                if (!order) {
                    return global.botTg.answerCallbackQuery(query.id, { text: '❌ Order tidak ditemukan.', show_alert: true });
                }
                if (order.refunded) {
                    return global.botTg.answerCallbackQuery(query.id, { text: '⚠️ Order ini sudah pernah di-refund!', show_alert: true });
                }
                if (order.status === 'success') {
                    return global.botTg.answerCallbackQuery(query.id, { text: '⚠️ Order berstatus SUKSES tidak dapat di-refund!', show_alert: true });
                }
                const refundRes = db.refundOrder(order, 'Dibatalkan oleh Admin via Telegram');
                if (refundRes.success) {
                    if (global.sock && typeof global.sock.sendMessage === 'function') {
                        await global.sock.sendMessage(refundRes.buyerJid, {
                            text: `❌ *ORDER DIBATALKAN ADMIN*\n\nMohon maaf, pesanan Anda telah dibatalkan oleh Admin.\n\n📦 Produk: ${order.item || order.sku}\n🧾 Invoice: \`${order.id}\`\n💰 Saldo Rp ${refundRes.amount.toLocaleString('id-ID')} telah dikembalikan ke dompet Anda.`
                        }).catch(() => {});
                    }
                    global.botTg.answerCallbackQuery(query.id, { text: `✅ Order ${order.id} berhasil di-refund!`, show_alert: true });
                    return global.botTg.sendMessage(chatId,
                        `✅ *ORDER BERHASIL DIREFUND*\n\n` +
                        `🧾 Invoice: \`${order.id}\`\n` +
                        `📦 Produk: ${order.item || order.sku}\n` +
                        `💸 Refund: *${formatRupiah(refundRes.amount)}*\n` +
                        `👤 Pembeli: \`${refundRes.buyerJid}\`\n` +
                        `💰 Saldo Baru Member: *${formatRupiah(refundRes.newSaldo)}*`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '🔍 Menu Trx', callback_data: 'tg_trx_menu' }]] }
                        }
                    );
                } else {
                    return global.botTg.answerCallbackQuery(query.id, { text: `❌ Gagal refund: ${refundRes.reason}`, show_alert: true });
                }
            }

            if (action === 'tg_input_refund') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_refund', chatId };
                return global.botTg.sendMessage(chatId,
                    `💸 *BATALKAN & REFUND ORDER*\n\n` +
                    `Ketik ID Invoice yang ingin dibatalkan dan dikembalikan saldonya:\n` +
                    `Contoh: \`INV-1726000000\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_trx_menu' }]] }
                    }
                );
            }

            // === BROADCAST PESAN WA ===
            if (action === 'tg_broadcast_menu') {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderBroadcastMenu());
            }

            if (action === 'tg_input_broadcast') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_broadcast', chatId };
                return global.botTg.sendMessage(chatId,
                    `📢 *TULIS PESAN BROADCAST WHATSAPP*\n\n` +
                    `Ketik isi pesan teks yang ingin dikirimkan secara massal ke seluruh member WhatsApp:\n\n` +
                    `_Tips: Pesan akan dikirim dengan jeda aman 1 detik per nomor untuk mencegah blokir WhatsApp._`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_broadcast_menu' }]] }
                    }
                );
            }

            if (action === 'tg_pair' || action === 'cmd_pair_new') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'awaiting_phone', chatId };
                return global.botTg.sendMessage(chatId,
                    `📱 *HUBUNGKAN / PAIRING WHATSAPP*\n\n` +
                    `Silakan balas pesan ini dengan nomor WhatsApp yang ingin dijadikan bot menggunakan awalan *62* (Tanpa spasi atau simbol plus).\n\n` +
                    `Contoh: \`6281234567890\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_menu' }]]
                        }
                    }
                );
            }

            if (action === 'tg_gw_menu') {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderGatewayMenu());
            }

            if (action === 'tg_setgw_pk') {
                if (!db.settings) db.settings = {};
                db.settings.paymentGateway = 'paymentkita';
                if (db.saveSettings) db.saveSettings();
                global.botTg.answerCallbackQuery(query.id, { text: '✅ Gateway aktif: PAYMENTKITA' });
                return updateOrSend(chatId, messageId, renderGatewayMenu());
            }

            if (action === 'tg_setgw_pakasir') {
                if (!db.settings) db.settings = {};
                db.settings.paymentGateway = 'pakasir';
                if (db.saveSettings) db.saveSettings();
                global.botTg.answerCallbackQuery(query.id, { text: '✅ Gateway aktif: PAKASIR' });
                return updateOrSend(chatId, messageId, renderGatewayMenu());
            }

            if (action === 'tg_input_pk') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'set_paymentkita', chatId };
                return global.botTg.sendMessage(chatId,
                    `🔑 *SET KREDENSIAL PAYMENTKITA*\n\n` +
                    `Kirimkan Merchant ID dan Secret Key dipisahkan spasi:\n` +
                    `Format: \`<MERCHANT_ID> <SECRET_KEY>\`\n` +
                    `Contoh: \`PKM12345 PKSK_abcdef123456\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_gw_menu' }]]
                        }
                    }
                );
            }

            if (action === 'tg_input_pakasir') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'set_pakasir', chatId };
                return global.botTg.sendMessage(chatId,
                    `🔑 *SET KREDENSIAL PAKASIR*\n\n` +
                    `Kirimkan Project Slug dan API Key dipisahkan spasi:\n` +
                    `Format: \`<PROJECT_SLUG> <API_KEY>\`\n` +
                    `Contoh: \`myproject 98a7bc1234...\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_gw_menu' }]]
                        }
                    }
                );
            }

            if (action === 'tg_digi_menu') {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderDigiMenu());
            }

            if (action === 'tg_input_digi') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'set_digi', chatId };
                return global.botTg.sendMessage(chatId,
                    `🔑 *SET KREDENSIAL DIGIFLAZZ*\n\n` +
                    `Kirimkan Username dan API Key Digiflazz dipisahkan spasi:\n` +
                    `Format: \`<USERNAME> <API_KEY>\`\n` +
                    `Contoh: \`digiuser dev-98a7bc...\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digi_menu' }]]
                        }
                    }
                );
            }

            if (action === 'tg_cekdigi') {
                global.botTg.answerCallbackQuery(query.id, { text: '⏳ Mengambil saldo Digiflazz...' });
                const saldo = await api.cekSaldoDigi();
                const text = `💰 *SALDO API DIGIFLAZZ*\n\n` +
                    `• Username: \`${config.digiflazz.username || '-'}\`\n` +
                    `• Saldo: *${typeof saldo === 'number' ? formatRupiah(saldo) : saldo}*\n` +
                    `• Waktu Cek: ${new Date().toLocaleString('id-ID')}`;
                return updateOrSend(chatId, messageId, {
                    text,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Cek Saldo Lagi', callback_data: 'tg_cekdigi' }],
                            [{ text: '⬅️ Menu Utama', callback_data: 'tg_menu' }]
                        ]
                    }
                });
            }

            if (action === 'tg_sync') {
                global.botTg.answerCallbackQuery(query.id, { text: '⏳ Memulai sinkronisasi produk...' });
                await global.botTg.sendMessage(chatId, "⏳ *Sedang menyinkronkan seluruh produk Digiflazz...*\nMohon tunggu sejenak...", { parse_mode: 'Markdown' });
                
                const prep = await api.pullAllDigiPrepaid();
                const pascaRes = await api.pullDigiPostpaid();

                let report = "📊 *HASIL SINKRONISASI DIGIFLAZZ*\n\n";
                if (prep) {
                    report += `• PULSA: ${prep.pulsa} produk\n`;
                    report += `• DATA: ${prep.data} produk\n`;
                    report += `• EMONEY: ${prep.emoney} produk\n`;
                    report += `• PLN: ${prep.pln} produk\n`;
                } else {
                    report += `• PRABAYAR (PULSA/DATA/EMONEY/PLN): ❌ Gagal\n`;
                }
                report += `• PASCABAYAR: ${pascaRes !== false ? pascaRes + ' produk' : '❌ Gagal'}\n\n`;
                report += `✅ *Total Produk Aktif:* ${db.ppob.length + (db.postpaid || []).length} SKU`;
                return global.botTg.sendMessage(chatId, report, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }]]
                    }
                });
            }

            if (action === 'tg_legal_snk') {
                global.botTg.answerCallbackQuery(query.id);
                const content = renderLegalMenu('general');
                return updateOrSend(chatId, messageId, content);
            }

            if (action === 'tg_legal_digital') {
                global.botTg.answerCallbackQuery(query.id);
                const content = renderLegalMenu('digital');
                return updateOrSend(chatId, messageId, content);
            }

            if (action === 'tg_health') {
                global.botTg.answerCallbackQuery(query.id);
                let health = {};
                try {
                    const checkHealth = require('./system/health-check');
                    health = checkHealth();
                } catch (_) {}
                const wa = getWaStatus();
                const mem = process.memoryUsage();
                const uptimeSec = Math.floor(process.uptime());
                const uptimeStr = `${Math.floor(uptimeSec / 3600)}j ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}d`;

                let text = `📊 *STATUS & KESEHATAN SISTEM*\n\n`;
                text += `• Server Uptime: *${uptimeStr}*\n`;
                text += `• RAM Used: *${(mem.rss / 1024 / 1024).toFixed(1)} MB*\n`;
                text += `• WhatsApp: ${wa.connected ? `🟢 Connected (+${wa.phone})` : '🔴 Disconnected'}\n`;
                text += `• Database: ${health.database ? '🟢 Normal' : '🔴 Error'}\n`;
                text += `• Status Toko: *${health.store === 'ON' ? '🟢 Buka' : '🔴 Tutup'}*\n`;
                text += `• Heartbeat: ${health.heartbeat ? '🟢 Aktif' : '🟡 Offline'}\n`;
                text += `• Antrian Trx: *${health.processing || 0} order*\n`;
                text += `• Waktu: ${new Date().toLocaleString('id-ID')}`;

                return updateOrSend(chatId, messageId, {
                    text,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Refresh Health', callback_data: 'tg_health' }],
                            [{ text: '⬅️ Menu Utama', callback_data: 'tg_menu' }]
                        ]
                    }
                });
            }

            if (action === 'tg_stats') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderStatsOverview());
            }

            if (action === 'tg_stats_datepicker') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderDatePickerMenu());
            }

            if (action === 'tg_stats_date_today') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderDateDetail('today'));
            }

            if (action === 'tg_stats_date_yesterday') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderDateDetail('kemarin'));
            }

            if (action === 'tg_stats_date_2days') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderDateDetail('2hari'));
            }

            if (action === 'tg_input_stats_date') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'input_stats_date', chatId };
                return global.botTg.sendMessage(chatId,
                    `🔍 *CEK LABA BERSIH TANGGAL TERTENTU*\n\n` +
                    `Silakan balas pesan ini dengan tanggal yang ingin diperiksa:\n\n` +
                    `• Format: \`DD-MM-YYYY\` (contoh: \`19-09-2026\`)\n` +
                    `• Atau: \`YYYY-MM-DD\` (contoh: \`2026-09-19\`)\n` +
                    `• Kata kunci cepat: \`kemarin\` atau \`today\``,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '❌ Batal', callback_data: 'tg_stats' }]
                            ]
                        }
                    }
                );
            }

            if (action === 'tg_stats_topproduk' || action === 'tg_topprod_all') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderTopProductsMenu(0));
            }

            if (action === 'tg_topprod_30') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderTopProductsMenu(30));
            }

            if (action === 'tg_topprod_7') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderTopProductsMenu(7));
            }

            if (action === 'tg_stats_produkgagal' || action === 'tg_failprod_all') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderFailedProductsMenu(0));
            }

            if (action === 'tg_failprod_30') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderFailedProductsMenu(30));
            }

            if (action === 'tg_failprod_7') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderFailedProductsMenu(7));
            }

            if (action === 'tg_stats_topmember' || action === 'tg_topmem_all') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderTopMembersTrxMenu(0));
            }

            if (action === 'tg_topmem_30') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderTopMembersTrxMenu(30));
            }

            if (action === 'tg_topmem_7') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderTopMembersTrxMenu(7));
            }

            if (action === 'tg_lunas') {
                global.botTg.answerCallbackQuery(query.id);
                const pending = (db.orders || []).filter(o => o.status === 'pending' || o.status === 'processing');
                let text = `⏳ *ANTRIAN TRANSAKSI AKTIF*\n\n`;
                if (pending.length === 0) {
                    text += `_Tidak ada transaksi dalam antrian saat ini. Seluruh order telah tuntas._`;
                } else {
                    pending.slice(0, 10).forEach((o, i) => {
                        text += `${i + 1}. \`${o.id}\` | ${o.item || o.sku} | ${formatRupiah(o.total || 0)} (${o.status})\n`;
                    });
                    if (pending.length > 10) text += `\n_...dan ${pending.length - 10} order lainnya._`;
                }
                return updateOrSend(chatId, messageId, {
                    text,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Refresh Antrian', callback_data: 'tg_lunas' }],
                            [{ text: '⬅️ Menu Utama', callback_data: 'tg_menu' }]
                        ]
                    }
                });
            }

            if (action === 'tg_backup' || action === 'tg_backup_menu') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderBackupMenu());
            }

            if (action === 'tg_backup_duration_menu') {
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderBackupDurationMenu());
            }

            if (action.startsWith('tg_set_interval_')) {
                const intervalMinutes = parseInt(action.replace('tg_set_interval_', ''), 10);
                if (isNaN(intervalMinutes) || intervalMinutes < 0) {
                    global.botTg.answerCallbackQuery(query.id, { text: '❌ Durasi tidak valid!' });
                    return;
                }
                if (!db.store) db.store = {};
                db.store.backupIntervalMinutes = intervalMinutes;
                if (typeof db.saveStore === 'function') db.saveStore();

                setupAutoBackupTimer();

                const statusLabel = intervalMinutes > 0 ? `setiap ${intervalMinutes} menit` : 'dinonaktifkan';
                global.botTg.answerCallbackQuery(query.id, { text: `✅ Auto-backup ${statusLabel}!` });
                return updateOrSend(chatId, messageId, renderBackupDurationMenu());
            }

            if (action === 'tg_backup_now') {
                global.botTg.answerCallbackQuery(query.id, { text: '⏳ Menjalankan backup...' });
                await global.botTg.sendMessage(chatId, "⏳ *Membuat file backup terbaru dan mengunggah ke Telegram...*\n_Harap tunggu sejenak, seluruh data & sesi sedang dikompresi..._", { parse_mode: 'Markdown' });
                exec(`node lib/backup/backup-telegram.js ${chatId}`, (err, stdout, stderr) => {
                    const backupFiles = fs.readdirSync('.').filter(f => /^AUTO-BACKUP-[\w.-]+\.zip$/.test(f)).sort().reverse();
                    if (err || backupFiles.length === 0) {
                        const errMsg = (err ? err.message : '') + (stderr ? '\n' + stderr : '') + (stdout ? '\n' + stdout : '');
                        return global.botTg.sendMessage(chatId, `❌ *Backup Gagal Dibuat / Dikirim:*\n\`\`\`\n${errMsg.slice(0, 400) || 'File zip tidak berhasil terbuat di server'}\n\`\`\`\n\n_Sistem akan mencoba membuat backup ulang dengan modul Python fallback._`, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Coba Backup Lagi', callback_data: 'tg_backup_now' }],
                                    [{ text: '⬅️ Kembali ke Menu Backup', callback_data: 'tg_backup_menu' }]
                                ]
                            }
                        });
                    }
                    const targetZip = backupFiles[0];
                    const stat = fs.statSync(targetZip);
                    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
                    return global.botTg.sendMessage(chatId, `✅ *Backup Berhasil Diselesaikan!*\n\n• File: \`${targetZip}\`\n• Ukuran: *${sizeMB} MB*\n\nFile zip telah terkirim ke obrolan Telegram ini dan tersimpan di VPS.`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔄 Restore ke VPS Ini', callback_data: 'cmd_restore' }],
                                [{ text: '⬅️ Kembali ke Menu Backup', callback_data: 'tg_backup_menu' }]
                            ]
                        }
                    });
                });
                return;
            }

            if (action === 'tg_settings_menu') {
                global.tgInputState = null;
                global.botTg.answerCallbackQuery(query.id);
                return updateOrSend(chatId, messageId, renderSettingsMenu());
            }

            if (action === 'tg_input_namatoko') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'set_namatoko', chatId };
                return global.botTg.sendMessage(chatId, `🏷️ *GANTI NAMA TOKO*\n\nKetik nama toko digital Anda yang baru:\nContoh: \`Garuda Multi Payment\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                });
            }

            if (action === 'tg_set_tier_kecil') {
                global.botTg.answerCallbackQuery(query.id);
                const lim = marginHelper.getTierLimits();
                const tier = marginHelper.getProfitTier();
                global.tgInputState = { type: 'set_tier_margin', tierKey: 'kecil', chatId };
                return global.botTg.sendMessage(chatId, `🟢 *SET MARGIN TIER KECIL*\n\n• Rentang Produk : *Rp 0 - ${formatRupiah(lim.kecil)}*\n• Margin Saat Ini : *${formatRupiah(tier.kecil)}*\n• Contoh Produk   : Pulsa 5k-25k, Kuota Harian, E-Money 10k-20k\n\nKetik nominal keuntungan (margin) baru yang diinginkan:\nContoh: \`350\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                });
            }

            if (action === 'tg_set_tier_sedang') {
                global.botTg.answerCallbackQuery(query.id);
                const lim = marginHelper.getTierLimits();
                const tier = marginHelper.getProfitTier();
                global.tgInputState = { type: 'set_tier_margin', tierKey: 'sedang', chatId };
                return global.botTg.sendMessage(chatId, `🟡 *SET MARGIN TIER SEDANG*\n\n• Rentang Produk : *${formatRupiah(lim.kecil + 1)} - ${formatRupiah(lim.sedang)}*\n• Margin Saat Ini : *${formatRupiah(tier.sedang)}*\n• Contoh Produk   : Pulsa 30k-100k, Token PLN 50k/100k, Kuota 30hr\n\nKetik nominal keuntungan (margin) baru yang diinginkan:\nContoh: \`600\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                });
            }

            if (action === 'tg_set_tier_besar') {
                global.botTg.answerCallbackQuery(query.id);
                const lim = marginHelper.getTierLimits();
                const tier = marginHelper.getProfitTier();
                global.tgInputState = { type: 'set_tier_margin', tierKey: 'besar', chatId };
                return global.botTg.sendMessage(chatId, `🔵 *SET MARGIN TIER BESAR*\n\n• Rentang Produk : *${formatRupiah(lim.sedang + 1)} - ${formatRupiah(lim.besar)}*\n• Margin Saat Ini : *${formatRupiah(tier.besar)}*\n• Contoh Produk   : Pulsa 150k-200k, Token PLN 200k, Kuota Jumbo\n\nKetik nominal keuntungan (margin) baru yang diinginkan:\nContoh: \`1200\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                });
            }

            if (action === 'tg_set_tier_premium') {
                global.botTg.answerCallbackQuery(query.id);
                const lim = marginHelper.getTierLimits();
                const tier = marginHelper.getProfitTier();
                global.tgInputState = { type: 'set_tier_margin', tierKey: 'premium', chatId };
                return global.botTg.sendMessage(chatId, `🟣 *SET MARGIN TIER PREMIUM*\n\n• Rentang Produk : *> ${formatRupiah(lim.besar)}*\n• Margin Saat Ini : *${formatRupiah(tier.premium)}*\n• Contoh Produk   : Token PLN 500k-1Jt, Game Voucher Besar, Kuota Tahunan\n\nKetik nominal keuntungan (margin) baru yang diinginkan:\nContoh: \`3000\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                });
            }

            if (action === 'tg_set_pasca_profit') {
                global.botTg.answerCallbackQuery(query.id);
                const configData = require('./config');
                const curFee = (configData.profit && typeof configData.profit.pasca === 'number') ? configData.profit.pasca : 1500;
                global.tgInputState = { type: 'set_pasca_profit', chatId };
                return global.botTg.sendMessage(chatId, `📑 *SET BIAYA ADMIN LOKET PASCABAYAR*\n\n• Fee Loket Saat Ini : *${formatRupiah(curFee)}* per transaksi\n• Layanan : PLN Pasca, PDAM, BPJS, Telkom, dll.\n\n_💡 Margin pascabayar murni berasal dari Fee Admin Loket Toko + Komisi Biller, terpisah dari skema autotier prabayar._\n\nKetik nominal fee admin baru yang diinginkan:\nContoh: \`2000\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                });
            }

            if (action === 'tg_set_tier_range') {
                global.botTg.answerCallbackQuery(query.id);
                const lim = marginHelper.getTierLimits();
                global.tgInputState = { type: 'set_tier_range', chatId };
                return global.botTg.sendMessage(chatId, `📏 *ATUR BATAS RENTANG HARGA MODAL (TIER LIMITS)*\n\nBatas Nominal Saat Ini:\n• Batas Kecil  : ≤ ${formatRupiah(lim.kecil)}\n• Batas Sedang : ≤ ${formatRupiah(lim.sedang)}\n• Batas Besar  : ≤ ${formatRupiah(lim.besar)}\n• Tier Premium : > ${formatRupiah(lim.besar)}\n\nKetik 3 angka batas berurutan dipisahkan spasi:\nFormat: \`<BATAS_KECIL> <BATAS_SEDANG> <BATAS_BESAR>\`\nContoh: \`25000 100000 300000\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                });
            }

            if (action === 'tg_recalc_prices') {
                global.botTg.answerCallbackQuery(query.id, { text: 'Sedang menghitung ulang harga...' });
                const res = marginHelper.recalculatePpobPrices();
                const content = renderSettingsMenu();
                await updateOrSend(chatId, messageId, content);
                return global.botTg.sendMessage(chatId, `🔄 *REKALKULASI HARGA SELESAI!*\n\n✅ Berhasil memeriksa dan memperbarui *${res.updatedCount}* dari total *${res.totalCount}* produk PPOB di katalog sesuai skema margin tier aktif.`, {
                    parse_mode: 'Markdown'
                });
            }

            if (action === 'tg_input_profit') {
                global.botTg.answerCallbackQuery(query.id);
                const lim = marginHelper.getTierLimits();
                const tier = marginHelper.getProfitTier();
                return global.botTg.sendMessage(chatId, `📊 *PILIH TIER YANG INGIN DIATUR*\n\n` +
                    `1. 🟢 Kecil (Rp 0 - ${formatRupiah(lim.kecil)}) : ${formatRupiah(tier.kecil)}\n` +
                    `2. 🟡 Sedang (${formatRupiah(lim.kecil + 1)} - ${formatRupiah(lim.sedang)}) : ${formatRupiah(tier.sedang)}\n` +
                    `3. 🔵 Besar (${formatRupiah(lim.sedang + 1)} - ${formatRupiah(lim.besar)}) : ${formatRupiah(tier.besar)}\n` +
                    `4. 🟣 Premium (> ${formatRupiah(lim.besar)}) : ${formatRupiah(tier.premium)}\n\n` +
                    `_Klik salah satu tombol di bawah untuk mengubah nominal margin:_`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🟢 Set Kecil', callback_data: 'tg_set_tier_kecil' },
                                { text: '🟡 Set Sedang', callback_data: 'tg_set_tier_sedang' }
                            ],
                            [
                                { text: '🔵 Set Besar', callback_data: 'tg_set_tier_besar' },
                                { text: '🟣 Set Premium', callback_data: 'tg_set_tier_premium' }
                            ],
                            [{ text: '⬅️ Kembali ke Pengaturan', callback_data: 'tg_settings_menu' }]
                        ]
                    }
                });
            }

            if (action === 'tg_input_addowner') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'add_owner', chatId };
                return global.botTg.sendMessage(chatId, `👑 *TAMBAH ADMIN / OWNER WHATSAPP*\n\nKetik nomor WhatsApp yang ingin dijadikan Admin (Format 62):\nContoh: \`6281234567890\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                });
            }

            if (action === 'cmd_restore') {
                global.botTg.answerCallbackQuery(query.id);
                try {
                    const backupFiles = fs.readdirSync('.').filter(f => /^AUTO-BACKUP-[\w.-]+\.zip$/.test(f)).sort().reverse();
                    if (backupFiles.length === 0) {
                        return updateOrSend(chatId, messageId, {
                            text: `❌ *FILE BACKUP TIDAK DITEMUKAN*\n\n` +
                                  `Tidak ada file \`AUTO-BACKUP-*.zip\` yang tersedia di direktori VPS ini.\n\n` +
                                  `_Silakan klik tombol di bawah untuk membuat file backup terlebih dahulu:_`,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📦 Backup Manual Sekarang', callback_data: 'tg_backup_now' }],
                                    [{ text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }]
                                ]
                            }
                        });
                    }
                    const targetZip = backupFiles[0];
                    const stat = fs.statSync(targetZip);
                    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

                    const confirmText = `⚠️ *KONFIRMASI RESTORE DATA DI VPS INI*\n\n` +
                        `Apakah Anda yakin ingin memulihkan seluruh data bot dari file backup terakhir?\n\n` +
                        `• *File Backup :* \`${targetZip}\`\n` +
                        `• *Ukuran File  :* *${sizeMB} MB*\n` +
                        `• *Tindakan     :* Database, konfigurasi toko, dan sesi WhatsApp aktif akan diekstrak dan ditimpa dari file backup ini.\n` +
                        `• *Restart      :* Bot akan me-restart otomatis via PM2 sesaat setelah file diekstrak.\n\n` +
                        `_PERINGATAN: Perubahan yang belum ter-backup akan ditimpa dengan data dari file backup ini._`;

                    return updateOrSend(chatId, messageId, {
                        text: confirmText,
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Ya, Pulihkan Data Sekarang', callback_data: 'cmd_restore_confirm' }],
                                [{ text: '❌ Batalkan', callback_data: 'tg_backup_menu' }]
                            ]
                        }
                    });
                } catch (err) {
                    return global.botTg.sendMessage(chatId, `❌ *Gagal memeriksa file backup:* ${err.message}`);
                }
            }

            if (action === 'cmd_restore_confirm') {
                global.botTg.answerCallbackQuery(query.id, { text: '⏳ Memulihkan data...' });
                await global.botTg.sendMessage(chatId, 
                    `⏳ *SEDANG MEMULIHKAN DATA DARI BACKUP...*\n\n` +
                    `1. Mengekstrak file backup (\`unzip -o\`)\n` +
                    `2. Menimpa database & sesi aktif\n` +
                    `3. Mempersiapkan restart sistem via PM2\n\n` +
                    `_Mohon tunggu sejenak..._`,
                    { parse_mode: 'Markdown' }
                );
                try {
                    const { spawnSync } = require('child_process');
                    const path = require('path');
                    const backupFiles = fs.readdirSync('.').filter(f => /^AUTO-BACKUP-[\w.-]+\.zip$/.test(f)).sort().reverse();
                    if (backupFiles.length === 0) {
                        return global.botTg.sendMessage(chatId, "❌ *Tidak ada file backup AUTO-BACKUP-*.zip yang valid ditemukan.*", { parse_mode: 'Markdown' });
                    }
                    const targetZip = backupFiles[0];
                    const safeZipPath = path.resolve('.', targetZip);

                    if (process.platform === 'win32') {
                        spawnSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive', '-LiteralPath', safeZipPath, '-DestinationPath', '.', '-Force'], { stdio: 'ignore' });
                    } else {
                        spawnSync('unzip', ['-o', safeZipPath, '-d', '.'], { stdio: 'ignore' });
                    }
                    fs.writeFileSync('RESTORE_SUCCESS.txt', 'true');
                    await global.botTg.sendMessage(chatId, `✅ *Restore Berhasil (${targetZip})!*\nSeluruh data dan konfigurasi telah dipulihkan.\nSistem sedang melakukan restart via PM2...`, { parse_mode: 'Markdown' });
                    setTimeout(() => { process.exit(0); }, 2000);
                } catch (err) {
                    global.botTg.sendMessage(chatId, "❌ *Gagal Restore:* " + err.message);
                }
                return;
            }

            if (action === 'tg_check_update') {
                global.botTg.answerCallbackQuery(query.id, { text: '🔍 Memeriksa pembaruan repository Git...' });
                try {
                    const result = performCheckGitUpdate();
                    return updateOrSend(chatId, query.message.message_id, result);
                } catch (err) {
                    const errMsg = (err.stderr ? err.stderr.toString() : err.message);
                    return updateOrSend(chatId, query.message.message_id, {
                        text: `❌ *Gagal Memeriksa Update Git*\n\n` +
                            `Detail Error:\n\`\`\`\n${errMsg.slice(0, 500)}\n\`\`\`\n\n` +
                            `_Pastikan bot dijalankan dalam repositori Git dan memiliki koneksi internet._`,
                        reply_markup: {
                            inline_keyboard: [[{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]]
                        }
                    });
                }
            }

            if (action === 'tg_apply_update') {
                global.botTg.answerCallbackQuery(query.id, { text: '⚡ Memulai proses update...' });
                await global.botTg.sendMessage(chatId, 
                    `⏳ *SEDANG MENERAPKAN PEMBARUAN...*\n\n` +
                    `1. Mengunduh kode terbaru (\`git pull origin\`)\n` +
                    `2. Memeriksa pembaharuan dependensi (\`npm install\` jika diperlukan)\n` +
                    `3. Merestart proses bot secara otomatis (PM2)\n\n` +
                    `_Mohon tunggu beberapa detik hingga bot aktif kembali..._`,
                    { parse_mode: 'Markdown' }
                );

                try {
                    const { execSync } = require('child_process');
                    const path = require('path');
                    let branch = 'main';
                    try {
                        branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe', encoding: 'utf-8' }).trim() || 'main';
                    } catch (_) {}

                    // 1. BACKUP DATA PENGGUNA & KREDENSIAL SEBELUM GIT PULL
                    const backupDir = path.resolve('./system/.update_backup');
                    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

                    const filesToProtect = [
                        'database/settings.json',
                        'database/settings.backup.json',
                        'database/store.json',
                        'database/menu.json',
                        'database/ppob.json',
                        'database/postpaid.json',
                        'database/users.json',
                        'database/orders.json',
                        'database/deposits.json',
                        '.env'
                    ];

                    const memoryBackups = {};
                    for (const f of filesToProtect) {
                        if (fs.existsSync(f)) {
                            memoryBackups[f] = fs.readFileSync(f, 'utf8');
                            try { fs.writeFileSync(path.join(backupDir, path.basename(f)), memoryBackups[f], 'utf8'); } catch (_) {}
                        }
                    }

                    // 2. Discard local edits on tracked database files so git pull merges cleanly
                    try {
                        execSync('git checkout -- database/settings.json database/store.json database/menu.json database/ppob.json database/postpaid.json 2>/dev/null || true', { stdio: 'ignore' });
                    } catch (_) {}

                    // Simpan file non-database jika ada perubahan tak terlacak
                    const dirty = execSync('git status --porcelain', { stdio: 'pipe', encoding: 'utf-8' }).trim();
                    if (dirty) {
                        try { execSync('git stash', { stdio: 'pipe' }); } catch (_) {}
                    }

                    const pullOutput = execSync(`git pull origin ${branch}`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
                    const newCommit = execSync('git log -1 --pretty=format:"%h (%cd) - %s" --date=format:"%d/%m/%Y %H:%M"', { stdio: 'pipe', encoding: 'utf-8' }).trim();

                    // 3. RESTORE SEMUA DATA PENGGUNA SETELAH GIT PULL
                    for (const f of filesToProtect) {
                        if (memoryBackups[f]) {
                            if (f === 'database/settings.json') {
                                try {
                                    const oldObj = JSON.parse(memoryBackups[f]);
                                    const newObj = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
                                    const merged = { ...newObj, ...oldObj };
                                    fs.writeFileSync(f, JSON.stringify(merged, null, 2), 'utf8');
                                } catch (_) {
                                    fs.writeFileSync(f, memoryBackups[f], 'utf8');
                                }
                            } else {
                                fs.writeFileSync(f, memoryBackups[f], 'utf8');
                            }
                        }
                    }

                    // 4. Pastikan sinkronisasi kredensial ke .env dan backup
                    if (db && db.saveSettings) db.saveSettings();

                    let npmNotice = '';
                    if (pullOutput.includes('package.json')) {
                        try {
                            execSync('npm install --omit=dev --no-audit', { stdio: 'pipe', timeout: 60000 });
                            npmNotice = '\n📦 Dependensi npm berhasil diperbarui.';
                        } catch (npmErr) {
                            npmNotice = `\n⚠️ Gagal update npm: ${npmErr.message}`;
                        }
                    }

                    // Pastikan CLI botwa selalu aktif dan executable di Linux
                    if (process.platform === 'linux') {
                        try {
                            const botwaBin = path.resolve(__dirname, 'bin', 'botwa.sh');
                            if (fs.existsSync(botwaBin)) {
                                execSync(`chmod +x "${botwaBin}" 2>/dev/null || true`);
                                execSync(`ln -sf "${botwaBin}" /usr/local/bin/botwa 2>/dev/null || true`);
                                execSync(`ln -sf "${botwaBin}" /usr/bin/botwa 2>/dev/null || true`);
                                execSync(`chmod +x /usr/local/bin/botwa /usr/bin/botwa 2>/dev/null || true`);
                            }
                        } catch (_) {}
                    }

                    await global.botTg.sendMessage(chatId,
                        `✅ *PEMBARUAN BERHASIL DITERAPKAN!*\n\n` +
                        `*Output Git:*\n\`\`\`\n${pullOutput.slice(0, 300)}\n\`\`\`\n` +
                        `*Commit Terbaru:*\n\`${newCommit}\`${npmNotice}\n\n` +
                        `🛡️ *Kredensial & Database:* Utuh & Terlindungi 100%\n` +
                        `🔄 *Sistem sedang merestart proses (PM2)...*\nBot WhatsApp & Telegram akan kembali online dalam 3-5 detik!`,
                        { parse_mode: 'Markdown' }
                    );

                    setTimeout(() => {
                        process.exit(0);
                    }, 2000);
                } catch (err) {
                    const errMsg = (err.stderr ? err.stderr.toString() : err.message);
                    return global.botTg.sendMessage(chatId,
                        `❌ *GAGAL MENERAPKAN UPDATE GIT*\n\n` +
                        `Terjadi kendala saat \`git pull origin\`:\n\`\`\`\n${errMsg.slice(0, 600)}\n\`\`\`\n\n` +
                        `💡 *Tips Pemulihan di Terminal VPS:*\n` +
                        `\`cd /var/www/bot-ppob && git stash && git pull origin main && pm2 restart all\``,
                        { parse_mode: 'Markdown' }
                    );
                }
            }
        });

        // 📩 MESSAGE LISTENER (INTERACTIVE TEXT & COMMANDS)
        global.botTg.on('message', async (msg) => {
            const chatId = String(msg.chat?.id || '');
            const authorizedChatId = String(config.telegram.chatId || '').trim();
            const text = (msg.text || '').trim();

            if (!text) return;

            // 1. Cek Chat ID (selalu diizinkan)
            if (/^\/id(@\w+)?$/i.test(text)) {
                return global.botTg.sendMessage(chatId, `🆔 *Chat ID Telegram Anda:* \`${chatId}\``, { parse_mode: 'Markdown' });
            }

            // 2. Validasi Hak Akses Admin
            if (!authorizedChatId) {
                console.warn(`[TELEGRAM] Pesan diterima tapi TELEGRAM_CHAT_ID belum diisi di .env! Pengirim: ${chatId}`);
                return global.botTg.sendMessage(chatId,
                    `⚠️ *TELEGRAM CHAT ID BELUM DIATUR*\n\n` +
                    `Chat ID Telegram Anda: \`${chatId}\`\n\n` +
                    `Untuk mengaktifkan kendali bot, masukkan baris berikut ke file \`.env\` di VPS:\n` +
                    `\`TELEGRAM_CHAT_ID=${chatId}\`\n\n` +
                    `Lalu restart bot dengan: \`pm2 restart all\` atau \`npm start\``,
                    { parse_mode: 'Markdown' }
                );
            }

            if (chatId !== authorizedChatId) {
                console.warn(`[SECURITY] Pesan '${text}' dari Chat ID ${chatId} ditolak (Admin: ${authorizedChatId})`);
                return global.botTg.sendMessage(chatId,
                    `❌ *Akses Ditolak!*\n\n` +
                    `Chat ID Anda: \`${chatId}\`\n` +
                    `Chat ID Admin di .env: \`${authorizedChatId}\``,
                    { parse_mode: 'Markdown' }
                );
            }

            // 3. Menangani Input State Interaktif
            if (global.tgInputState && global.tgInputState.chatId === chatId) {
                const stateType = global.tgInputState.type;

                if (stateType === 'awaiting_phone') {
                    return triggerPairing(chatId, text);
                }

                // === AWAITING CEK USER ===
                if (stateType === 'awaiting_cekuser') {
                    const found = findMember(text);
                    global.tgInputState = null;
                    if (!found) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Member Tidak Ditemukan!*\n\n` +
                            `Nomor \`${text}\` belum terdaftar di database.\n` +
                            `Apakah Anda ingin mendaftarkannya secara manual?`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '➕ Daftarkan Member Ini', callback_data: 'tg_input_addmember' }],
                                        [{ text: '👥 Pilih Dari Daftar', callback_data: 'tg_input_cekuser' }],
                                        [{ text: '⬅️ Kembali ke Menu Member', callback_data: 'tg_member_menu' }]
                                    ]
                                }
                            }
                        );
                    }

                    const profile = renderMemberProfile(found.phone);
                    return global.botTg.sendMessage(chatId, profile.text, {
                        parse_mode: 'Markdown',
                        reply_markup: profile.reply_markup
                    });
                }

                // === QUICK SALDO (+ / -) ===
                if (stateType === 'quick_saldo') {
                    const mode = global.tgInputState.mode;
                    const phone = global.tgInputState.phone;
                    const nom = parseInt(text.replace(/[^0-9]/g, ''), 10);

                    if (isNaN(nom) || nom <= 0) {
                        return global.botTg.sendMessage(chatId, `❌ *Nominal tidak valid!* Masukkan angka positif saja.\nContoh: \`50000\``, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                        });
                    }

                    const found = findMember(phone);
                    if (!found) {
                        global.tgInputState = null;
                        return global.botTg.sendMessage(chatId, `❌ Member \`+${phone}\` tidak ditemukan.`);
                    }

                    const targetJid = found.jid;
                    const user = found.user;

                    if (mode === 'plus') {
                        user.saldo = (Number(user.saldo) || 0) + nom;
                        if (!Array.isArray(user.history)) user.history = [];
                        const dateStr = new Date().toLocaleDateString('id-ID');
                        user.history.push(`[${dateStr}] 🟢 Topup Admin Telegram (+Rp ${nom.toLocaleString('id-ID')})`);
                        db.saveUsers();
                        global.tgInputState = null;

                        if (global.sock && typeof global.sock.sendMessage === 'function') {
                            await global.sock.sendMessage(targetJid, {
                                text: `✅ *SALDO DITAMBAHKAN ADMIN*\n\nSaldo Anda telah ditambah sebesar *${formatRupiah(nom)}* oleh Admin.\n💵 Sisa Saldo Anda: *${formatRupiah(user.saldo)}*`
                            }).catch(() => {});
                        }

                        return global.botTg.sendMessage(chatId,
                            `✅ *Saldo Member Berhasil Ditambah!*\n\n` +
                            `• Target: \`+${phone}\`\n` +
                            `• Tambahan: *+${formatRupiah(nom)}*\n` +
                            `• Saldo Baru: *${formatRupiah(user.saldo)}*\n` +
                            `• Notifikasi WA: ${global.sock ? '🟢 Terkirim' : '🟡 Bot WA Offline'}`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '👤 Lihat Profil Member Ini', callback_data: `tg_viewuser_${phone}` }],
                                        [{ text: '👥 Daftar Semua Member', callback_data: 'tg_input_cekuser' }],
                                        [{ text: '⬅️ Menu Member', callback_data: 'tg_member_menu' }]
                                    ]
                                }
                            }
                        );
                    } else if (mode === 'minus') {
                        if ((Number(user.saldo) || 0) < nom) {
                            return global.botTg.sendMessage(chatId,
                                `❌ *Saldo Tidak Mencukupi!*\n\nSaldo member \`+${phone}\` saat ini hanya *${formatRupiah(user.saldo || 0)}*, tidak dapat ditarik *${formatRupiah(nom)}*.`,
                                {
                                    parse_mode: 'Markdown',
                                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                                }
                            );
                        }

                        user.saldo = (Number(user.saldo) || 0) - nom;
                        if (!Array.isArray(user.history)) user.history = [];
                        const dateStr = new Date().toLocaleDateString('id-ID');
                        user.history.push(`[${dateStr}] 🔴 Penarikan Admin Telegram (-Rp ${nom.toLocaleString('id-ID')})`);
                        db.saveUsers();
                        global.tgInputState = null;

                        if (global.sock && typeof global.sock.sendMessage === 'function') {
                            await global.sock.sendMessage(targetJid, {
                                text: `⚠️ *SALDO DIKURANGI/DITARIK ADMIN*\n\nSaldo Anda telah dikurangi sebesar *${formatRupiah(nom)}* oleh Admin.\n💵 Sisa Saldo Anda: *${formatRupiah(user.saldo)}*`
                            }).catch(() => {});
                        }

                        return global.botTg.sendMessage(chatId,
                            `✅ *Saldo Member Berhasil Dikurangi!*\n\n` +
                            `• Target: \`+${phone}\`\n` +
                            `• Penarikan: *-${formatRupiah(nom)}*\n` +
                            `• Sisa Saldo: *${formatRupiah(user.saldo)}*\n` +
                            `• Notifikasi WA: ${global.sock ? '🟢 Terkirim' : '🟡 Bot WA Offline'}`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '👤 Lihat Profil Member Ini', callback_data: `tg_viewuser_${phone}` }],
                                        [{ text: '👥 Daftar Semua Member', callback_data: 'tg_input_cekuser' }],
                                        [{ text: '⬅️ Menu Member', callback_data: 'tg_member_menu' }]
                                    ]
                                }
                            }
                        );
                    }
                }

                // === AWAITING EDIT SALDO (+ / -) ===
                if (stateType === 'awaiting_editsaldo') {
                    const match = text.match(/^(\+?\d+)\s+([+-])\s*(\d+)$/);
                    if (!match) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Format salah!*\n\nFormat: \`<NOMOR> <+ / -><NOMINAL>\`\nContoh Tambah: \`6281234567890 +50000\`\nContoh Tarik: \`6281234567890 -25000\``,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                            }
                        );
                    }

                    const rawPhone = match[1];
                    const sign = match[2];
                    const nom = parseInt(match[3], 10);
                    const found = findMember(rawPhone);

                    if (!found) {
                        return global.botTg.sendMessage(chatId, `❌ Member \`${rawPhone}\` tidak ditemukan di database.`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                        });
                    }

                    const user = found.user;
                    const phone = found.phone;
                    const targetJid = found.jid;

                    if (sign === '+') {
                        user.saldo = (Number(user.saldo) || 0) + nom;
                        if (!Array.isArray(user.history)) user.history = [];
                        const dateStr = new Date().toLocaleDateString('id-ID');
                        user.history.push(`[${dateStr}] 🟢 Topup Admin Telegram (+Rp ${nom.toLocaleString('id-ID')})`);
                        db.saveUsers();
                        global.tgInputState = null;

                        if (global.sock && typeof global.sock.sendMessage === 'function') {
                            await global.sock.sendMessage(targetJid, {
                                text: `✅ *SALDO DITAMBAHKAN ADMIN*\n\nSaldo Anda telah ditambah sebesar *${formatRupiah(nom)}* oleh Admin.\n💵 Sisa Saldo Anda: *${formatRupiah(user.saldo)}*`
                            }).catch(() => {});
                        }

                        return global.botTg.sendMessage(chatId,
                            `✅ *Saldo Member Berhasil Ditambah!*\n\n` +
                            `• Target: \`+${phone}\`\n` +
                            `• Tambahan: *+${formatRupiah(nom)}*\n` +
                            `• Saldo Baru: *${formatRupiah(user.saldo)}*`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '👥 Menu Member', callback_data: 'tg_member_menu' }]] }
                            }
                        );
                    } else {
                        if ((Number(user.saldo) || 0) < nom) {
                            return global.botTg.sendMessage(chatId,
                                `❌ *Saldo Tidak Mencukupi!*\n\nSaldo member \`+${phone}\` saat ini hanya *${formatRupiah(user.saldo || 0)}*.`,
                                {
                                    parse_mode: 'Markdown',
                                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                                }
                            );
                        }

                        user.saldo = (Number(user.saldo) || 0) - nom;
                        if (!Array.isArray(user.history)) user.history = [];
                        const dateStr = new Date().toLocaleDateString('id-ID');
                        user.history.push(`[${dateStr}] 🔴 Penarikan Admin Telegram (-Rp ${nom.toLocaleString('id-ID')})`);
                        db.saveUsers();
                        global.tgInputState = null;

                        if (global.sock && typeof global.sock.sendMessage === 'function') {
                            await global.sock.sendMessage(targetJid, {
                                text: `⚠️ *SALDO DIKURANGI/DITARIK ADMIN*\n\nSaldo Anda telah dikurangi sebesar *${formatRupiah(nom)}* oleh Admin.\n💵 Sisa Saldo Anda: *${formatRupiah(user.saldo)}*`
                            }).catch(() => {});
                        }

                        return global.botTg.sendMessage(chatId,
                            `✅ *Saldo Member Berhasil Dikurangi!*\n\n` +
                            `• Target: \`+${phone}\`\n` +
                            `• Penarikan: *-${formatRupiah(nom)}*\n` +
                            `• Sisa Saldo: *${formatRupiah(user.saldo)}*`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '👥 Menu Member', callback_data: 'tg_member_menu' }]] }
                            }
                        );
                    }
                }

                // === AWAITING ADD MEMBER MANUAL ===
                if (stateType === 'awaiting_addmember') {
                    const parts = text.split(/\s+/);
                    if (parts.length < 2) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Format salah!*\nFormat: \`<NOMOR> <NAMA> <SALDO_AWAL>\`\nContoh: \`62812345678 Budi 50000\``,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                            }
                        );
                    }

                    const rawPhone = parts[0];
                    const cleanPhone = normalizePhone(rawPhone);
                    if (!cleanPhone.startsWith('62') || cleanPhone.length < 10) {
                        return global.botTg.sendMessage(chatId, `❌ *Format nomor tidak valid!* Harus diawali 62 dan minimal 10 digit.`);
                    }

                    let saldoAwal = 0;
                    let name = '';
                    const lastPart = parts[parts.length - 1];
                    if (!isNaN(parseInt(lastPart, 10)) && parts.length >= 3) {
                        saldoAwal = parseInt(lastPart, 10);
                        name = parts.slice(1, -1).join(' ');
                    } else {
                        name = parts.slice(1).join(' ');
                    }

                    const targetJid = `${cleanPhone}@s.whatsapp.net`;
                    const user = db.getUser(targetJid);
                    user.name = name;
                    user.phone = cleanPhone;
                    if (saldoAwal > 0) {
                        user.saldo = (Number(user.saldo) || 0) + saldoAwal;
                        if (!Array.isArray(user.history)) user.history = [];
                        const dateStr = new Date().toLocaleDateString('id-ID');
                        user.history.push(`[${dateStr}] 🟢 Saldo Awal Admin (+Rp ${saldoAwal.toLocaleString('id-ID')})`);
                    }
                    db.saveUsers();
                    global.tgInputState = null;

                    if (global.sock && typeof global.sock.sendMessage === 'function') {
                        await global.sock.sendMessage(targetJid, {
                            text: `🎉 *SELAMAT DATANG DI ${db.store.namaToko || 'DIGITAL STORE'}*\n\n` +
                                  `Akun Anda telah berhasil didaftarkan oleh Admin.\n` +
                                  `• Nama: *${name}*\n` +
                                  `• Saldo: *${formatRupiah(user.saldo || 0)}*\n\n` +
                                  `Ketik *menu* untuk melihat daftar produk & layanan.`
                        }).catch(() => {});
                    }

                    return global.botTg.sendMessage(chatId,
                        `✅ *Member Berhasil Didaftarkan!*\n\n` +
                        `• Nomor: \`+${cleanPhone}\`\n` +
                        `• Nama: *${name}*\n` +
                        `• Saldo Awal: *${formatRupiah(user.saldo || 0)}*\n` +
                        `• Status WA: ${global.sock ? '🟢 Notifikasi Terkirim' : '🟡 Bot WA Offline'}`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '👤 Lihat Profil Member Ini', callback_data: `tg_viewuser_${cleanPhone}` }],
                                    [{ text: '👥 Daftar Semua Member', callback_data: 'tg_input_cekuser' }],
                                    [{ text: '⬅️ Menu Member', callback_data: 'tg_member_menu' }]
                                ]
                            }
                        }
                    );
                }

                // === QUICK SET NAME MEMBER ===
                if (stateType === 'quick_setname') {
                    const phone = global.tgInputState.phone;
                    const newName = text.trim();

                    if (!newName || newName.length < 2) {
                        return global.botTg.sendMessage(chatId, `❌ *Nama terlalu pendek!* Minimal 2 karakter.`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `tg_viewuser_${phone}` }]] }
                        });
                    }

                    const found = findMember(phone);
                    if (!found) {
                        global.tgInputState = null;
                        return global.botTg.sendMessage(chatId, `❌ Member tidak ditemukan.`);
                    }

                    if (db.setUserName) {
                        db.setUserName(phone, newName);
                    } else {
                        found.user.name = newName;
                        found.user.customName = true;
                        db.saveUsers();
                    }
                    global.tgInputState = null;

                    const dispP = formatDisplayPhone(found.phone);
                    return global.botTg.sendMessage(chatId,
                        `✅ *Nama Member Berhasil Diperbarui!*\n\n` +
                        `• Nomor: \`${dispP}\` (\`+${found.phone}\`)\n` +
                        `• Nama Baru: *${cleanMd(newName)}*`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '👤 Lihat Profil Member', callback_data: `tg_viewuser_${found.phone}` }],
                                    [{ text: '👥 Daftar Member', callback_data: 'tg_input_cekuser' }],
                                    [{ text: '⬅️ Menu Member', callback_data: 'tg_member_menu' }]
                                ]
                            }
                        }
                    );
                }

                // === AWAITING SET NAME MANUAL ===
                if (stateType === 'awaiting_setname_manual') {
                    const parts = text.trim().split(/\s+/);
                    if (parts.length < 2) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Format salah!*\nFormat: \`<NOMOR> <NAMA_BARU>\`\nContoh: \`081775700114 Ansor studio\``,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_member_menu' }]] }
                            }
                        );
                    }

                    const rawPhone = parts[0];
                    const newName = parts.slice(1).join(' ').trim();
                    const found = findMember(rawPhone);

                    if (!found) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Member Tidak Ditemukan!*\n\nNomor \`${rawPhone}\` belum terdaftar di database.`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '➕ Daftarkan Member', callback_data: 'tg_input_addmember' }],
                                        [{ text: '👥 Pilih Dari Tombol Member', callback_data: 'tg_input_cekuser' }],
                                        [{ text: '❌ Batal', callback_data: 'tg_member_menu' }]
                                    ]
                                }
                            }
                        );
                    }

                    if (db.setUserName) {
                        db.setUserName(found.phone, newName);
                    } else {
                        found.user.name = newName;
                        found.user.customName = true;
                        db.saveUsers();
                    }
                    global.tgInputState = null;

                    const dispP = formatDisplayPhone(found.phone);
                    return global.botTg.sendMessage(chatId,
                        `✅ *Nama Member Berhasil Diperbarui!*\n\n` +
                        `• Nomor: \`${dispP}\` (\`+${found.phone}\`)\n` +
                        `• Nama Baru: *${cleanMd(newName)}*`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '👤 Lihat Profil Member', callback_data: `tg_viewuser_${found.phone}` }],
                                    [{ text: '👥 Daftar Member', callback_data: 'tg_input_cekuser' }],
                                    [{ text: '⬅️ Menu Member', callback_data: 'tg_member_menu' }]
                                ]
                            }
                        }
                    );
                }

                // === AWAITING ADD MENU (PRODUK DIGITAL) ===
                if (stateType === 'awaiting_addmenu') {
                    let nama, harga, stok;
                    if (text.includes('|')) {
                        [nama, harga, stok] = text.split('|').map(s => s ? s.trim() : '');
                    } else {
                        const parts = text.split(/\s+/);
                        if (parts.length >= 2) {
                            const lastPart = parts[parts.length - 1];
                            const secondLast = parts[parts.length - 2];
                            if (!isNaN(parseInt(lastPart, 10)) && !isNaN(parseInt(secondLast, 10)) && parts.length >= 3) {
                                stok = lastPart;
                                harga = secondLast;
                                nama = parts.slice(0, -2).join(' ');
                            } else if (!isNaN(parseInt(lastPart, 10))) {
                                harga = lastPart;
                                stok = 0;
                                nama = parts.slice(0, -1).join(' ');
                            }
                        }
                    }

                    if (!nama || !harga || isNaN(parseInt(harga, 10))) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Format salah!*\nFormat: \`<NAMA>|<HARGA>|<STOK>\`\nContoh: \`Netflix Premium 1 Bulan|35000|10\``,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]] }
                            }
                        );
                    }

                    const id = db.menu.length ? db.menu[db.menu.length - 1].id + 1 : 1;
                    db.menu.push({ id, nama, harga: parseInt(harga, 10), stok: parseInt(stok || 0, 10), dataAkun: [] });
                    db.saveMenu();
                    global.tgInputState = null;

                    return global.botTg.sendMessage(chatId,
                        `✅ *Produk Digital Berhasil Ditambahkan!*\n\n` +
                        `• ID: *${id}*\n` +
                        `• Produk: *${nama}*\n` +
                        `• Harga: *${formatRupiah(parseInt(harga, 10))}*\n` +
                        `• Stok Awal: *${parseInt(stok || 0, 10)} akun*`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📥 Isi Stok Akun Ini', callback_data: 'tg_input_adddata' }],
                                    [{ text: '📂 Daftar Produk', callback_data: 'tg_listproduk' }]
                                ]
                            }
                        }
                    );
                }

                // === AWAITING EDIT HARGA PRODUK DIGITAL ===
                if (stateType === 'awaiting_editharga') {
                    const match = text.match(/^(\d+)\s+(\d+)$/);
                    if (!match) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Format salah!*\n\nFormat: \`<ID_PRODUK> <HARGA_BARU>\`\nContoh: \`1 15000\``,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]] }
                            }
                        );
                    }

                    const id = parseInt(match[1], 10);
                    const hargaBaru = parseInt(match[2], 10);
                    const item = (db.menu || []).find(m => m.id === id);

                    if (!item) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Produk Digital ID ${id} tidak ditemukan!*\nSilakan cek ID produk pada menu Daftar Produk.`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '📂 Daftar Produk', callback_data: 'tg_listproduk' }],
                                        [{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]
                                    ]
                                }
                            }
                        );
                    }

                    const hargaLama = item.harga;
                    item.harga = hargaBaru;
                    if (db.saveMenu) db.saveMenu();
                    else if (db.save) db.save();
                    global.tgInputState = null;

                    return global.botTg.sendMessage(chatId,
                        `✅ *Harga Produk Berhasil Diperbarui!*\n\n` +
                        `• Produk: *${item.nama}* (ID ${item.id})\n` +
                        `• Harga Lama: ${formatRupiah(hargaLama)}\n` +
                        `• Harga Baru: *${formatRupiah(hargaBaru)}*`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📂 Cek Daftar Produk', callback_data: 'tg_listproduk' }],
                                    [{ text: '⬅️ Menu Digital', callback_data: 'tg_digital_menu' }]
                                ]
                            }
                        }
                    );
                }

                // === AWAITING EDIT STOK PRODUK DIGITAL ===
                if (stateType === 'awaiting_editstok') {
                    const match = text.match(/^(\d+)\s+(\d+)$/);
                    if (!match) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Format salah!*\n\nFormat: \`<ID_PRODUK> <STOK_BARU>\`\nContoh: \`1 50\``,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]] }
                            }
                        );
                    }

                    const id = parseInt(match[1], 10);
                    const stokBaru = parseInt(match[2], 10);
                    const item = (db.menu || []).find(m => m.id === id);

                    if (!item) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Produk Digital ID ${id} tidak ditemukan!*\nSilakan cek ID produk pada menu Daftar Produk.`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '📂 Daftar Produk', callback_data: 'tg_listproduk' }],
                                        [{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]
                                    ]
                                }
                            }
                        );
                    }

                    const stokLama = item.stok || 0;
                    item.stok = stokBaru;
                    if (db.saveMenu) db.saveMenu();
                    else if (db.save) db.save();
                    global.tgInputState = null;

                    return global.botTg.sendMessage(chatId,
                        `✅ *Stok Produk Berhasil Diperbarui!*\n\n` +
                        `• Produk: *${item.nama}* (ID ${item.id})\n` +
                        `• Stok Lama: ${stokLama} unit\n` +
                        `• Stok Baru: *${stokBaru} unit*`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📂 Cek Daftar Produk', callback_data: 'tg_listproduk' }],
                                    [{ text: '⬅️ Menu Digital', callback_data: 'tg_digital_menu' }]
                                ]
                            }
                        }
                    );
                }

                // === AWAITING ADD DATA (ISI STOK AKUN MENTAH) ===
                if (stateType === 'awaiting_adddata') {
                    const parts = text.split(/\s+/);
                    const idStr = parseInt(parts[0], 10);
                    let qty = parseInt(parts[1], 10);
                    let dataTxt = (!isNaN(qty) && parts.length > 2) ? parts.slice(2).join(' ') : parts.slice(1).join(' ');
                    if (isNaN(qty)) qty = 1;

                    const item = (db.menu || []).find(m => m.id === idStr);
                    if (!item) {
                        return global.botTg.sendMessage(chatId, `❌ *ID Produk ${idStr} tidak ditemukan!* Cek ID lewat tombol List Produk.`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]] }
                        });
                    }

                    if (!item.dataAkun) item.dataAkun = [];
                    for (let i = 0; i < qty; i++) item.dataAkun.push(dataTxt);
                    item.stok = item.dataAkun.length;
                    db.saveMenu();
                    global.tgInputState = null;

                    return global.botTg.sendMessage(chatId,
                        `✅ *Stok Akun Berhasil Dimasukkan!*\n\n` +
                        `• Produk: *${item.nama}* (ID: ${item.id})\n` +
                        `• Data Baru Ditambahkan: *${qty} data*\n` +
                        `• Total Stok Sekarang: *${item.stok} akun*`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📂 List Produk Digital', callback_data: 'tg_listproduk' }],
                                    [{ text: '📦 Menu Digital', callback_data: 'tg_digital_menu' }]
                                ]
                            }
                        }
                    );
                }

                // === AWAITING DEL MENU ===
                if (stateType === 'awaiting_delmenu') {
                    const id = parseInt(text.trim(), 10);
                    const index = (db.menu || []).findIndex(m => m.id === id);
                    if (index === -1) {
                        return global.botTg.sendMessage(chatId, `❌ ID Produk Digital *${text}* tidak ditemukan.`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digital_menu' }]] }
                        });
                    }

                    const namaProduk = db.menu[index].nama;
                    db.menu.splice(index, 1);
                    db.saveMenu();
                    global.tgInputState = null;

                    return global.botTg.sendMessage(chatId,
                        `✅ *Produk Digital Berhasil Dihapus!*\n\n• ID: *${id}*\n• Nama: *${namaProduk}*`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '📦 Menu Digital', callback_data: 'tg_digital_menu' }]] }
                        }
                    );
                }

                // === AWAITING CEK INVOICE ===
                if (stateType === 'awaiting_cekinv') {
                    const invId = text.trim().toUpperCase();
                    const order = (db.orders || []).find(o => o.id && o.id.toUpperCase() === invId);
                    global.tgInputState = null;

                    if (!order) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Invoice Tidak Ditemukan!*\n\nID Invoice \`${invId}\` tidak ada dalam riwayat database.`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '🔍 Cari Lagi', callback_data: 'tg_input_cekinv' }]] }
                            }
                        );
                    }

                    const buyerPhone = (order.buyer || order.sender || '').replace(/[^0-9]/g, '');
                    const dateStr = order.timestamp ? new Date(order.timestamp).toLocaleString('id-ID') : '-';
                    const amountStr = formatRupiah(order.baseAmount || order.total || order.harga || 0);

                    let detail = `🧾 *DETAIL TRANSAKSI*\n\n` +
                        `• Invoice: \`${order.id}\`\n` +
                        `• Status: *${order.status.toUpperCase()}* ${order.refunded ? '(REFUNDED)' : ''}\n` +
                        `• Produk: *${order.item || order.sku}*\n` +
                        `• Target / No HP: \`${order.target || '-'}\`\n` +
                        `• Pembeli: \`+${buyerPhone || '-'}\`\n` +
                        `• Total Bayar: *${amountStr}*\n` +
                        `• Waktu: ${dateStr}\n` +
                        `• SN / Akun: \`${order.sn || '(Belum ada / Tidak tersedia)'}\``;

                    const actionButtons = [];
                    if (order.sn && (order.buyer || order.sender)) {
                        actionButtons.push([{ text: '📲 Kirim Ulang SN ke Pembeli', callback_data: `tg_resend_${order.id}` }]);
                    }
                    if (order.status !== 'success' && !order.refunded) {
                        actionButtons.push([{ text: '💸 Batalkan & Refund Saldo', callback_data: `tg_refund_${order.id}` }]);
                    }
                    actionButtons.push([{ text: '⬅️ Kembali ke Menu Trx', callback_data: 'tg_trx_menu' }]);

                    return global.botTg.sendMessage(chatId, detail, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: actionButtons }
                    });
                }

                // === AWAITING REFUND ORDER ===
                if (stateType === 'awaiting_refund') {
                    const invId = text.trim().toUpperCase();
                    const order = (db.orders || []).find(o => o.id && o.id.toUpperCase() === invId);
                    global.tgInputState = null;

                    if (!order) {
                        return global.botTg.sendMessage(chatId, `❌ Order \`${invId}\` tidak ditemukan.`);
                    }
                    if (order.refunded) {
                        return global.botTg.sendMessage(chatId, `⚠️ Order \`${invId}\` sudah pernah di-refund sebelumnya.`);
                    }
                    if (order.status === 'success') {
                        return global.botTg.sendMessage(chatId, `⚠️ Order \`${invId}\` sudah berstatus SUKSES dan tidak dapat di-refund.`);
                    }

                    const refundRes = db.refundOrder(order, 'Dibatalkan Manual oleh Admin via Telegram');
                    if (refundRes.success) {
                        if (global.sock && typeof global.sock.sendMessage === 'function') {
                            await global.sock.sendMessage(refundRes.buyerJid, {
                                text: `❌ *ORDER DIBATALKAN ADMIN*\n\nMohon maaf, pesanan Anda telah dibatalkan oleh Admin.\n\n📦 Produk: ${order.item || order.sku}\n🧾 Invoice: \`${order.id}\`\n💰 Saldo Rp ${refundRes.amount.toLocaleString('id-ID')} telah dikembalikan ke dompet Anda.`
                            }).catch(() => {});
                        }

                        return global.botTg.sendMessage(chatId,
                            `✅ *ORDER BERHASIL DIREFUND!*\n\n` +
                            `• Invoice: \`${order.id}\`\n` +
                            `• Produk: ${order.item || order.sku}\n` +
                            `• Saldo Dikembalikan: *${formatRupiah(refundRes.amount)}*\n` +
                            `• Penerima: \`${refundRes.buyerJid}\`\n` +
                            `• Saldo Baru Member: *${formatRupiah(refundRes.newSaldo)}*`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '🔍 Menu Trx', callback_data: 'tg_trx_menu' }]] }
                            }
                        );
                    } else {
                        return global.botTg.sendMessage(chatId, `❌ Gagal refund: ${refundRes.reason}`);
                    }
                }

                // === AWAITING BROADCAST WA ===
                if (stateType === 'awaiting_broadcast') {
                    const broadcastMsg = text;
                    global.tgInputState = null;

                    const phones = getUniqueUserPhones();
                    if (phones.length === 0) {
                        return global.botTg.sendMessage(chatId, `❌ Tidak ada nomor WhatsApp member yang tersimpan di database.`);
                    }

                    await global.botTg.sendMessage(chatId,
                        `🚀 *BROADCAST WHATSAPP SEDANG BERJALAN...*\n\n` +
                        `• Total Sasaran: *${phones.length} member*\n` +
                        `• Estimasi Waktu: *~${phones.length} detik*\n\n` +
                        `_Sistem mengirim dengan jeda 1 detik per nomor agar aman anti-banned. Laporan hasil akan dikirim setelah selesai._`,
                        { parse_mode: 'Markdown' }
                    );

                    // Jalankan background broadcast dengan pacing 1000ms
                    (async () => {
                        let sent = 0;
                        let failed = 0;
                        for (const p of phones) {
                            const targetJid = `${p}@s.whatsapp.net`;
                            try {
                                if (global.sock && typeof global.sock.sendMessage === 'function') {
                                    await global.sock.sendMessage(targetJid, { text: broadcastMsg });
                                    sent++;
                                } else {
                                    failed++;
                                }
                            } catch (_) {
                                failed++;
                            }
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }

                        global.botTg.sendMessage(chatId,
                            `✅ *BROADCAST WHATSAPP SELESAI!*\n\n` +
                            `• Berhasil Terkirim: *${sent} nomor*\n` +
                            `• Gagal / Offline: *${failed} nomor*\n` +
                            `• Total Sasaran: *${phones.length} member*\n\n` +
                            `_Seluruh pesan pengumuman telah tuntas dikirimkan._`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]] }
                            }
                        );
                    })();

                    return;
                }

                if (stateType === 'set_paymentkita') {
                    const [mId, secret] = text.split(/\s+/);
                    if (!mId || !secret || mId.length < 3 || secret.length < 6) {
                        return global.botTg.sendMessage(chatId, `❌ *Format salah!*\nKetik: \`<MERCHANT_ID> <SECRET_KEY>\`\nContoh: \`PKM12345 PKSK_abcdef123456\``, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_gw_menu' }]] }
                        });
                    }
                    if (!db.settings) db.settings = {};
                    db.settings.paymentkita = { merchantId: mId, secret: secret };
                    if (db.saveSettings) db.saveSettings();
                    global.tgInputState = null;
                    return global.botTg.sendMessage(chatId, `✅ *Kredensial PaymentKita Berhasil Disimpan!*\nMerchant ID: \`${mId}\`\nSecret: \`${maskSecret(secret)}\``, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💳 Menu Gateway', callback_data: 'tg_gw_menu' }],
                                [{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]
                            ]
                        }
                    });
                }

                if (stateType === 'set_pakasir') {
                    const [proj, key] = text.split(/\s+/);
                    if (!proj || !key || proj.length < 2 || key.length < 6) {
                        return global.botTg.sendMessage(chatId, `❌ *Format salah!*\nKetik: \`<PROJECT_SLUG> <API_KEY>\`\nContoh: \`myproject 98a7bc...\``, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_gw_menu' }]] }
                        });
                    }
                    if (!db.settings) db.settings = {};
                    db.settings.pakasir = { project: proj, key: key };
                    if (db.saveSettings) db.saveSettings();
                    global.tgInputState = null;
                    return global.botTg.sendMessage(chatId, `✅ *Kredensial Pakasir Berhasil Disimpan!*\nProject: \`${proj}\`\nKey: \`${maskSecret(key)}\``, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💳 Menu Gateway', callback_data: 'tg_gw_menu' }],
                                [{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]
                            ]
                        }
                    });
                }

                if (stateType === 'set_digi') {
                    const [u, k] = text.split(/\s+/);
                    if (!u || !k || u.length < 3 || k.length < 6) {
                        return global.botTg.sendMessage(chatId, `❌ *Format salah!*\nKetik: \`<USERNAME> <API_KEY>\`\nContoh: \`digiuser dev-98a7bc...\``, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_digi_menu' }]] }
                        });
                    }
                    if (!db.settings) db.settings = {};
                    db.settings.digiflazz = { username: u, key: k };
                    if (db.saveSettings) db.saveSettings();
                    global.tgInputState = null;
                    return global.botTg.sendMessage(chatId, `✅ *Kredensial Digiflazz Berhasil Disimpan!*\nUsername: \`${u}\`\nKey: \`${maskSecret(k)}\``, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '💰 Cek Saldo', callback_data: 'tg_cekdigi' }],
                                [{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]
                            ]
                        }
                    });
                }

                if (stateType === 'set_namatoko') {
                    db.store.namaToko = text;
                    if (db.saveStore) db.saveStore();
                    else if (db.save) db.save();
                    global.tgInputState = null;
                    return global.botTg.sendMessage(chatId, `✅ *Nama Toko Diperbarui:* ${text}`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🏪 Menu Toko', callback_data: 'tg_store_menu' }],
                                [{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]
                            ]
                        }
                    });
                }

                if (stateType === 'set_tier_margin') {
                    const tierKey = (global.tgInputState.tierKey || '').toLowerCase();
                    const nom = parseInt(text.replace(/[^0-9]/g, ''), 10);
                    if (isNaN(nom) || nom < 0 || nom > 1000000) {
                        return global.botTg.sendMessage(chatId, `❌ *Nominal tidak valid!*\nMasukkan angka keuntungan antara 0 - 1.000.000 (rupiah).\nContoh: \`500\``, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                        });
                    }

                    try {
                        const res = marginHelper.setTierMargin(tierKey, nom);
                        global.tgInputState = null;
                        const info = marginHelper.getTierInfo(
                            tierKey === 'kecil' ? 10000 :
                            tierKey === 'sedang' ? 50000 :
                            tierKey === 'besar' ? 150000 : 500000
                        );

                        return global.botTg.sendMessage(chatId,
                            `✅ *MARGIN TIER ${tierKey.toUpperCase()} BERHASIL DIUBAH!*\n\n` +
                            `• Rentang Produk : *${info.rangeStr}*\n` +
                            `• Margin Baru    : *${formatRupiah(nom)}*\n` +
                            `• Rekalkulasi    : *${res.updatedCount}* dari ${res.totalCount} produk PPOB langsung diperbarui!\n\n` +
                            `_Pelanggan WhatsApp kini langsung mendapatkan harga jual baru._`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '⚙️ Kembali ke Pengaturan', callback_data: 'tg_settings_menu' }],
                                        [{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]
                                    ]
                                }
                            }
                        );
                    } catch (err) {
                        return global.botTg.sendMessage(chatId, `❌ Terjadi kesalahan: ${err.message}`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '⚙️ Menu Pengaturan', callback_data: 'tg_settings_menu' }]] }
                        });
                    }
                }

                if (stateType === 'set_tier_range') {
                    const parts = text.trim().split(/\s+/).map(p => parseInt(p.replace(/[^0-9]/g, ''), 10));
                    if (parts.length < 3 || parts.some(isNaN) || parts[0] <= 0 || parts[1] <= parts[0] || parts[2] <= parts[1]) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Format batas rentang tidak valid!*\n\n` +
                            `Ketik 3 angka yang berurutan naik (Kecil < Sedang < Besar):\n` +
                            `Format: \`<KECIL> <SEDANG> <BESAR>\`\n` +
                            `Contoh: \`25000 100000 300000\``,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                            }
                        );
                    }

                    try {
                        const res = marginHelper.setTierLimits(parts[0], parts[1], parts[2]);
                        global.tgInputState = null;
                        return global.botTg.sendMessage(chatId,
                            `✅ *BATAS RENTANG HARGA BERHASIL DIPERBARUI!*\n\n` +
                            `• Tier Kecil  : ≤ ${formatRupiah(parts[0])}\n` +
                            `• Tier Sedang : ${formatRupiah(parts[0] + 1)} - ${formatRupiah(parts[1])}\n` +
                            `• Tier Besar  : ${formatRupiah(parts[1] + 1)} - ${formatRupiah(parts[2])}\n` +
                            `• Premium     : > ${formatRupiah(parts[2])}\n\n` +
                            `🔄 *${res.updatedCount}* produk PPOB langsung dikalkulasi ulang ke tier baru!`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '⚙️ Kembali ke Pengaturan', callback_data: 'tg_settings_menu' }],
                                        [{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]
                                    ]
                                }
                            }
                        );
                    } catch (err) {
                        return global.botTg.sendMessage(chatId, `❌ Terjadi kesalahan: ${err.message}`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '⚙️ Menu Pengaturan', callback_data: 'tg_settings_menu' }]] }
                        });
                    }
                }

                if (stateType === 'set_pasca_profit') {
                    const nom = parseInt(text.replace(/[^0-9]/g, ''), 10);
                    if (isNaN(nom) || nom < 0 || nom > 100000) {
                        return global.botTg.sendMessage(chatId, `❌ *Nominal tidak valid!*\nMasukkan angka biaya admin loket antara 0 - 100.000 (rupiah).\nContoh: \`2000\``, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                        });
                    }

                    try {
                        if (!db.settings) db.settings = {};
                        const configData = require('./config');
                        if (!db.settings.profit) db.settings.profit = { ...configData.profit };
                        db.settings.profit.pasca = nom;
                        if (db.saveSettings) db.saveSettings();
                        global.tgInputState = null;

                        return global.botTg.sendMessage(chatId,
                            `✅ *BIAYA ADMIN LOKET PASCABAYAR BERHASIL DIUBAH!*\n\n` +
                            `• Fee Loket Baru : *${formatRupiah(nom)}* per transaksi\n` +
                            `• Layanan        : PLN Pasca, PDAM, BPJS, Telkom, dll.\n\n` +
                            `_Setiap pelanggan yang mengecek tagihan pascabayar di WhatsApp akan otomatis ditambahkan biaya layanan ini._`,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '⚙️ Kembali ke Pengaturan', callback_data: 'tg_settings_menu' }],
                                        [{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]
                                    ]
                                }
                            }
                        );
                    } catch (err) {
                        return global.botTg.sendMessage(chatId, `❌ Terjadi kesalahan: ${err.message}`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '⚙️ Menu Pengaturan', callback_data: 'tg_settings_menu' }]] }
                        });
                    }
                }

                if (stateType === 'input_stats_date') {
                    const dayData = analytics.getDayStats(text);
                    if (!dayData.success) {
                        return global.botTg.sendMessage(chatId,
                            `❌ *Format tanggal tidak valid!*\n\n${dayData.message}\n\n` +
                            `• Contoh: \`19-09-2026\` atau \`2026-09-19\`\n` +
                            `• Atau ketik: \`kemarin\``,
                            {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_stats' }]]
                                }
                            }
                        );
                    }
                    global.tgInputState = null;
                    const content = renderDateDetail(text);
                    return global.botTg.sendMessage(chatId, content.text, {
                        parse_mode: 'Markdown',
                        reply_markup: content.reply_markup
                    });
                }

                if (stateType === 'set_profit') {
                    const [katRaw, nomStr] = text.split(/\s+/);
                    const kat = (katRaw || '').toLowerCase();
                    const nom = parseInt(nomStr, 10);
                    if (!['pulsa', 'data', 'emoney', 'pln', 'pasca'].includes(kat) || isNaN(nom) || nom < 0) {
                        return global.botTg.sendMessage(chatId, `❌ *Format salah!*\nKetik: \`<kategori> <nominal>\`\nContoh: \`pulsa 750\``, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                        });
                    }
                    if (!db.settings) db.settings = {};
                    if (!db.settings.profit) db.settings.profit = { ...config.profit };
                    db.settings.profit[kat] = nom;
                    if (db.saveSettings) db.saveSettings();
                    global.tgInputState = null;
                    return global.botTg.sendMessage(chatId, `✅ *Margin Profit ${kat.toUpperCase()} Disetel:* ${formatRupiah(nom)}`, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]] }
                    });
                }

                if (stateType === 'add_owner') {
                    let cleanNo = text.replace(/[^0-9]/g, '');
                    if (cleanNo.startsWith('0')) cleanNo = '62' + cleanNo.slice(1);
                    if (!cleanNo || cleanNo.length < 10) {
                        return global.botTg.sendMessage(chatId, `❌ *Format nomor tidak valid!* Minimal 10 digit diawali 62.`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
                        });
                    }
                    const newJid = cleanNo + '@s.whatsapp.net';
                    if (!db.settings) db.settings = {};
                    let owners = Array.isArray(db.settings.owner) ? [...db.settings.owner] : [...config.owner];
                    if (!owners.includes(newJid)) owners.push(newJid);
                    db.settings.owner = owners;
                    if (db.saveSettings) db.saveSettings();
                    global.tgInputState = null;
                    return global.botTg.sendMessage(chatId, `✅ *Nomor ${cleanNo} berhasil ditambahkan sebagai Admin/Owner!*`, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🤖 Menu Utama', callback_data: 'tg_menu' }]] }
                    });
                }
            }

            // 4. Perintah /pair langsung (misal: /pair 628123456789)
            const pairMatch = text.match(/^\/pair(@\w+)?(?:\s+(.+))?$/i);
            if (pairMatch) {
                const argPhone = pairMatch[2] ? pairMatch[2].trim() : '';
                if (argPhone) {
                    return triggerPairing(chatId, argPhone);
                } else {
                    global.tgInputState = { type: 'awaiting_phone', chatId };
                    return global.botTg.sendMessage(chatId, 
                        `📱 *TAUTKAN NOMOR BARU*\n\n` +
                        `Silakan balas pesan ini dengan nomor WhatsApp yang ingin dijadikan bot (Format *62*, contoh: \`6281234567890\`):`, 
                        { 
                            parse_mode: "Markdown",
                            reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_menu' }]] }
                        }
                    );
                }
            }

            // 5. Perintah /update atau update langsung
            if (/^\/?update(@\w+)?$/i.test(text)) {
                try {
                    const res = performCheckGitUpdate();
                    return global.botTg.sendMessage(chatId, res.text, {
                        parse_mode: 'Markdown',
                        reply_markup: res.reply_markup
                    });
                } catch (err) {
                    const errMsg = (err.stderr ? err.stderr.toString() : err.message);
                    return global.botTg.sendMessage(chatId,
                        `❌ *Gagal Memeriksa Update Git*\n\n\`\`\`\n${errMsg.slice(0, 500)}\n\`\`\``,
                        { parse_mode: 'Markdown' }
                    );
                }
            }

            // 6. Perintah /backup atau backup langsung
            if (/^\/?backup(@\w+)?$/i.test(text)) {
                return updateOrSend(chatId, null, renderBackupMenu());
            }

            // 7. Perintah /restore atau restore langsung
            if (/^\/?restore(@\w+)?$/i.test(text)) {
                return updateOrSend(chatId, null, renderBackupMenu());
            }

            // 8. Default: Render Dashboard Interaktif Inline Keyboard
            return updateOrSend(chatId, null, renderTelegramDashboard());
        });
        
        console.log(`[SYSTEM] 🎧 Telegram Command Center (Inline Keyboard) Aktif! (Admin ID: ${config.telegram.chatId || 'Belum Diatur'})`);
    } else if (!config.telegram?.token || !config.telegram.token.includes(':')) {
        console.warn('⚠️ [TELEGRAM] TELEGRAM_TOKEN belum diatur di file .env. Command Center Telegram dinonaktifkan.');
        saveBotStatus({ telegramStatus: 'disabled', telegramError: 'Token belum diatur' });
    }
} catch (e) {
    console.log('[SYSTEM ERROR] Gagal memuat Telegram Listener:', e.message);
    saveBotStatus({ telegramStatus: 'error', telegramError: e.message });
}
}

global.initTelegramBot = initTelegramBot;
initTelegramBot();

// ==========================================
// 🔄 FUNGSI RESTART INDEPENDEN TELEGRAM & IPC WATCHER
// ==========================================
global.restartTelegramBot = async () => {
    console.log('[SYSTEM] 🔄 Merestart koneksi Telegram Bot...');
    saveBotStatus({ telegramStatus: 'restarting' });
    try {
        if (global.botTg && typeof global.botTg.stopPolling === 'function') {
            await global.botTg.stopPolling();
        }
    } catch (_) {}
    global.botTg = null;

    setTimeout(() => {
        try {
            initTelegramBot();
        } catch (err) {
            console.error('[TELEGRAM RESTART ERROR]:', err.message);
        }
    }, 2000);
};

// Polling file trigger setiap 2 detik (.restart-wa dan .restart-tg)
setInterval(() => {
    try {
        const fs = require('fs');
        const path = require('path');
        const triggerTg = path.resolve(__dirname, 'system', '.restart-tg');
        const triggerWa = path.resolve(__dirname, 'system', '.restart-wa');

        if (fs.existsSync(triggerTg)) {
            try { fs.unlinkSync(triggerTg); } catch (_) {}
            if (typeof global.restartTelegramBot === 'function') {
                global.restartTelegramBot();
            }
        }
        if (fs.existsSync(triggerWa)) {
            try { fs.unlinkSync(triggerWa); } catch (_) {}
            if (typeof global.restartWhatsAppBot === 'function') {
                global.restartWhatsAppBot();
            }
        }
    } catch (_) {}
}, 2000);






// ==========================================
// 📡 RADAR PEMANTAU DIGIFLAZZ V4 (INTELIJEN)
// ==========================================
setInterval(async () => {
    try {
        if (typeof db === 'undefined' || !db.orders) return;
        let botSock = typeof sock !== 'undefined' ? sock : global.sock;
        if (!botSock) return;

        let ordersArray = Array.isArray(db.orders) ? db.orders : Object.values(db.orders);
        let pendingOrders = ordersArray.filter(o => o && (o.status === 'pending' || o.status === 'Pending' || o.status === 'processing') && o.isPpob !== false && o.sku);
        
        if (pendingOrders.length === 0) return;

        const crypto = require('crypto');
        const configData = require('./config'); 

        for (let order of pendingOrders) {
            // Anti-Conflict: Biarkan safeHitDigiflazz menyelesaikan siklus retry awalnya (< 45 detik)
            const orderAge = Date.now() - (order.lastRetryAt || order.timestamp || 0);
            if (orderAge < 45000) {
                continue;
            }

            // PRIORITAS: Gunakan OID asli dari Digiflazz yang baru kita tambal
            let oid = order.digiflazz_oid || order.ref_id || order.invoice || order.oid || order.refId || order.id; 
            if (!oid) continue;

            const sign = crypto.createHash('md5').update(configData.digiflazz.username + configData.digiflazz.key + oid).digest('hex');
            
            let payload = {
                username: configData.digiflazz.username,
                buyer_sku_code: order.sku,
                customer_no: order.target,
                ref_id: oid,
                sign: sign
            };

            const isPostpaid = !!order.isPasca || (order.sku && (String(order.sku).toLowerCase().startsWith('post') || String(order.sku).toLowerCase().includes('pasca')));

            if (isPostpaid) {
                payload.commands = 'status-pasca';
            }

            // LOGGING INTELIJEN: Tampilkan apa yang sedang dicek
            const maskTrg = (t = '') => t.length > 6 ? t.slice(0, 4) + '****' + t.slice(-3) : t;
            console.log(`[RADAR V4] 🔍 Mengecek OID: ${oid} | SKU: ${order.sku} | Pasca: ${isPostpaid} | Trg: ${maskTrg(order.target)}`);

            const req = await fetch('https://api.digiflazz.com/v1/transaction', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const res = await req.json();

            if (!res || !res.data) continue;

            let status = res.data.status;
            let sn = res.data.sn || res.data.message || '';
            let buyerJid = order.buyer || order.sender || order.jid;
            // 🧬 Normalisasi Dompet Utama
            let realBuyerJid = buyerJid && typeof buyerJid === 'string' && buyerJid.includes(':') ? buyerJid.split(':')[0] + '@s.whatsapp.net' : buyerJid;

            console.log(`[RADAR V4] 📡 Respon Digiflazz -> Status: ${status} | Ket: ${sn}`);

            if (status === 'Sukses') {
                order.status = 'success';
                if (sn) order.sn = sn;
                order.profit = analytics.calculateOrderProfit(order, db.ppob);
                if (typeof db.saveOrders === 'function') db.saveOrders();

                activeTransactions.delete(
                    (order.buyer || '') + '-' + (order.sku || order.item || 'ITEM') + '-' + (order.target || 'TARGET')
                );
                
                if (isPostpaid) {
                    let snText = sn ? `\n🧾 *No. Ref / SN:* \`${sn}\`` : '';
                    await botSock.sendMessage(realBuyerJid || buyerJid, {
                        text: `✅ *PEMBAYARAN PASCABAYAR BERHASIL*\n\n` +
                              `📦 Layanan: *${order.item || order.sku}*\n` +
                              `🎯 ID Pelanggan: *${order.target}*\n` +
                              `💰 Total Bayar: *${formatRupiah(order.baseAmount || order.total || 0)}*` +
                              `${snText}\n\n` +
                              `_Terima kasih telah melakukan pembayaran di *${db.store.namaToko || 'Toko Kami'}*!_`
                    });
                } else {
                    const rawSn = sn || order.sn || '';
                    const plnData = formatPlnToken(rawSn);
                    const storeName = db.store.namaToko || 'DIGITAL STORE';
                    const timeStr = getTanggalLengkap(order.timestamp || Date.now());

                    if (plnData) {
                        let plnMsg = `✅ *PEMBELIAN TOKEN LISTRIK BERHASIL*\n\n` +
                                     `⚡ *KODE TOKEN ANDA (20 DIGIT):*\n` +
                                     `\`${plnData.token}\`\n` +
                                     `_(Ketuk kode di atas untuk menyalin ke meteran)_\n\n`;
                        if (plnData.nama) plnMsg += `👤 Nama Pelanggan : *${plnData.nama}*\n`;
                        if (plnData.tarif) plnMsg += `⚡ Tarif / Daya    : *${plnData.tarif}*\n`;
                        if (plnData.kwh) plnMsg += `📊 Jumlah Kwh     : *${plnData.kwh}*\n`;
                        plnMsg += `🎯 No. Meter / ID  : *${order.target}*\n` +
                                  `💰 Total Bayar     : *${formatRupiah(order.baseAmount || order.total || 0)}*\n` +
                                  `🕒 Waktu           : ${timeStr}\n\n` +
                                  `_Terima kasih telah berbelanja di *${storeName}*!_`;
                        await botSock.sendMessage(realBuyerJid || buyerJid, { text: plnMsg });
                    } else {
                        await botSock.sendMessage(realBuyerJid || buyerJid, {
                            text: `✅ *TRANSAKSI BERHASIL*\n\n` +
                                  `📦 Produk   : *${order.item || order.sku}*\n` +
                                  `🎯 Tujuan   : *${order.target}*\n` +
                                  `💰 Total    : *${formatRupiah(order.baseAmount || order.total || 0)}*\n` +
                                  `🧾 SN / Ref : \`${formatDigiflazzMessage(rawSn)}\`\n` +
                                  `🕒 Waktu    : ${timeStr}\n\n` +
                                  `_Terima kasih telah berbelanja di *${storeName}*!_`
                        });
                    }
                }
                console.log("[RADAR V4] ✅ Sukses! Pesan terkirim.");
            } 
            else if (status === 'Gagal') {
                // PERISAI ANTI-REFUND PALSU:
                // Jika error karena kunci salah atau OID tidak ditemukan, abaikan! Jangan refund!
                if (sn.includes("tidak ditemukan") || sn.includes("Signature") || sn.includes("Gagal memproses")) {
                    console.log("[RADAR V4] ⚠️ Mengabaikan Gagal palsu karena OID lama.");
                    continue; 
                }

                activeTransactions.delete(
                    (order.buyer || '') + '-' + (order.sku || order.item || 'ITEM') + '-' + (order.target || 'TARGET')
                );

                const refundRes = db.refundOrder(order, sn || 'Gagal dari server Digiflazz');
                if (refundRes.success) {
                    await botSock.sendMessage(refundRes.buyerJid, { text: `❌  *PPOB GAGAL*\n\nProduk: ${order.item || order.sku}\nTujuan: ${order.target}\nAlasan: ${sn}\n\n💰 Saldo Rp ${refundRes.amount.toLocaleString('id-ID')} telah dikembalikan ke dompet Anda.` });
                    console.log(`[RADAR V4] ❌ Gagal asli! Saldo Rp ${refundRes.amount} di-refund ke ${refundRes.buyerJid}.`);
                }
            }
        }
    } catch (e) {
        // Mode senyap untuk error jaringan
    }
}, 10000);
