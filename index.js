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
const { formatRupiah, getTanggal, getTanggalLengkap } = require('./lib/utils');
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
                hit = await postpaid.pay(order.sku, order.target, order.id);
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

                setTimeout(startBot, 5000);
            } else {
                console.log('❌ Sesi Log Out. Silakan hapus folder session_bot dan scan ulang.');

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
                'settier', 'addowner', 'delowner', 'listowner', 'sync', 'refund', 'batal'
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
        if (!item.hargaJual) {
            await sock.sendMessage(sender, { text: "⏳ *INQUIRY:* Sedang mengambil rincian tagihan dari server..." });
            const postpaid = require('./lib/postpaid');
            try {
                const inq = await postpaid.inquiry(item.sku, session.tempTarget, oid);
                if (inq && inq.data && inq.data.ref_id) {
                    order.digiflazz_oid = inq.data.ref_id;
                }
                if (!inq.data || inq.data.status === 'Gagal') {
                    activeTransactions.delete(trxKey);
                    return sock.sendMessage(sender, { text: `❌ *INQUIRY GAGAL*\nPesan: ${inq.data ? inq.data.message : 'ID Pelanggan salah atau sudah lunas.'}` });
                }
                const pascaProfit = (config.profit && config.profit.pasca !== undefined) ? Number(config.profit.pasca) : 1500;
                baseAmount = Number(inq.data.selling_price || inq.data.price || 0) + pascaProfit;
                item.hargaJual = baseAmount;
                item.nama = inq.data.customer_name ? `${item.brand || item.name} (${inq.data.customer_name})` : (item.brand || item.name);
                order.baseAmount = baseAmount;
                order.item = item.nama;
            } catch (e) {
                activeTransactions.delete(trxKey);
                return sock.sendMessage(sender, { text: "❌ *ERROR API:* Gagal terhubung ke Digiflazz." });
            }
        } else {
            baseAmount = item.hargaJual;
            order.baseAmount = baseAmount;
            order.item = item.nama;
            if (session.tempInquiryRef) {
                order.digiflazz_oid = session.tempInquiryRef;
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
        caption: `🧾 *TAGIHAN QRIS*

Invoice : ${oid}
Produk  : ${order.item}
Nominal : ${formatRupiah(order.total)}

Expired : 5 Menit (Otomatis Batal)`
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
                db.saveOrders();

                activeTransactions.delete(
                    (order.buyer || '') + '-' + (order.sku || order.item || 'ITEM') + '-' + (order.target || 'TARGET')
                );
                await sock.sendMessage(targetJid, { text: `✅ *PPOB SUKSES*\n\nProduk: ${order.item}\nTujuan: ${order.target}\nSN/Ket: ${formatDigiflazzMessage(hit.data.sn || hit.data.message)}` });
            } else if (hit.data.status === 'Pending') {
                order.status = 'processing'; if(typeof hit !== 'undefined' && hit.data && hit.data.ref_id) { order.digiflazz_oid = hit.data.ref_id; } db.saveOrders();
                await sock.sendMessage(targetJid, { text: `⏳ *MENUNGGU PROVIDER*\n\nPembayaran LUNAS. Transaksi sedang diproses oleh server pusat. Mohon ditunggu ya kak, produk akan segera masuk.` });
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
            await sock.sendMessage(targetJid, { text: `✅ *PESANAN SUKSES*\n\nDetail:\n${dataExtracted.join('\n---\n')}` });

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


    // 🗑️ WATCHER LAMA YANG MOGOK TELAH DIHAPUS



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
        }

        else if (
            now - order.timestamp > 30 * 60 * 1000
        ) {

            activeTransactions.delete(trx);
        }
    }

}, 60000);


// ========================================
// 🛡️ SMARTDATA TELEGRAM COMMAND CENTER (AUTO-BACKUP)
// ========================================
setInterval(() => {
    const { exec } = require('child_process');
    console.log('[SYSTEM] Menjalankan Auto-Backup 2 Jam ke Telegram...');
    exec('node lib/backup/backup-telegram.js', (error, stdout, stderr) => {
        if (error) console.log(`[BACKUP ERROR]: ${error.message}`);
    });
}, 2 * 60 * 60 * 1000); // Waktu Timer: 2 Jam
 // Eksekusi ketat setiap 10 detik

}


// ==========================================
// 🎧 TELEGRAM COMMAND CENTER LISTENER (INLINE KEYBOARD)
// ==========================================
try {
    const TelegramBot = require('node-telegram-bot-api');
    const { exec, spawnSync } = require('child_process');
    
    // Mencegah bentrok / double polling jika file dimuat ulang
    if (!global.botTg && config.telegram.token && config.telegram.token.includes(':')) {
        global.botTg = new TelegramBot(config.telegram.token, { polling: true });
        global.tgInputState = null;

        // Tangkap polling error agar tidak crash dan mudah dilacak
        global.botTg.on('polling_error', (error) => {
            console.warn('⚠️ [TELEGRAM POLLING]:', error.code || error.message);
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
                        { text: '📈 Statistik Omzet', callback_data: 'tg_stats' }
                    ],
                    [
                        { text: '⚙️ Margin & Owner', callback_data: 'tg_settings_menu' },
                        { text: '📦 Backup Data', callback_data: 'tg_backup' }
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
            let text = `⚙️ *PENGATURAN HARGA & TOKO*\n\n`;
            text += `🏪 Nama Toko: *${db.store.namaToko || "DIGITAL STORE"}*\n\n`;
            text += `💰 *Markup Kategori:*\n`;
            text += `• Pulsa: ${formatRupiah(configData.profit.pulsa)}\n`;
            text += `• Data: ${formatRupiah(configData.profit.data)}\n`;
            text += `• E-Money: ${formatRupiah(configData.profit.emoney)}\n`;
            text += `• PLN: ${formatRupiah(configData.profit.pln)}\n\n`;
            text += `📊 *Margin Tier:*\n`;
            text += `• Kecil: ${formatRupiah(configData.profitTier.kecil)}\n`;
            text += `• Sedang: ${formatRupiah(configData.profitTier.sedang)}\n`;
            text += `• Besar: ${formatRupiah(configData.profitTier.besar)}\n`;
            text += `• Premium: ${formatRupiah(configData.profitTier.premium)}\n\n`;
            text += `👑 *Owner Terdaftar:* ${configData.owner.join(', ') || 'Belum ada'}\n`;

            const reply_markup = {
                inline_keyboard: [
                    [
                        { text: '🏷️ Ganti Nama Toko', callback_data: 'tg_input_namatoko' },
                        { text: '💵 Set Margin Profit', callback_data: 'tg_input_profit' }
                    ],
                    [
                        { text: '👑 Tambah Admin/Owner', callback_data: 'tg_input_addowner' }
                    ],
                    [
                        { text: '⬅️ Kembali ke Menu Utama', callback_data: 'tg_menu' }
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
                const orders = db.orders || [];
                const successOrders = orders.filter(o => o.status === 'success');
                const failedOrders = orders.filter(o => o.status === 'failed' || o.status === 'cancelled');
                const totalOmzet = successOrders.reduce((acc, o) => acc + (Number(o.total) || 0), 0);
                
                const startOfDay = new Date();
                startOfDay.setHours(0, 0, 0, 0);
                const todayOrders = successOrders.filter(o => (o.timestamp || o.doneAt || 0) >= startOfDay.getTime());
                const todayOmzet = todayOrders.reduce((acc, o) => acc + (Number(o.total) || 0), 0);

                let text = `📈 *STATISTIK PENJUALAN & OMZET*\n\n`;
                text += `📅 *Hari Ini:*\n`;
                text += `• Transaksi Berhasil: *${todayOrders.length} trx*\n`;
                text += `• Omzet Hari Ini: *${formatRupiah(todayOmzet)}*\n\n`;
                text += `🏆 *Keseluruhan (All Time):*\n`;
                text += `• Total Sukses: *${successOrders.length} trx*\n`;
                text += `• Total Gagal/Refund: *${failedOrders.length} trx*\n`;
                text += `• Total Omzet: *${formatRupiah(totalOmzet)}*\n`;
                text += `• Total Member: *${Object.keys(db.users || {}).length} pengguna*`;

                return updateOrSend(chatId, messageId, {
                    text,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⬅️ Menu Utama', callback_data: 'tg_menu' }]
                        ]
                    }
                });
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

            if (action === 'tg_backup') {
                global.botTg.answerCallbackQuery(query.id, { text: '⏳ Menjalankan backup...' });
                await global.botTg.sendMessage(chatId, "⏳ *Membuat file backup dan mengirimkan ke chat ini...*", { parse_mode: 'Markdown' });
                exec('node lib/backup/backup-telegram.js', (err) => {
                    if (err) {
                        return global.botTg.sendMessage(chatId, `❌ Backup gagal: ${err.message}`, {
                            reply_markup: {
                                inline_keyboard: [[{ text: '⬅️ Menu Utama', callback_data: 'tg_menu' }]]
                            }
                        });
                    }
                    return global.botTg.sendMessage(chatId, `✅ *Backup Berhasil Dikirim!*\nFile arsip data telah terkirim ke Telegram.`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📦 Restore Backup', callback_data: 'cmd_restore' }],
                                [{ text: '⬅️ Menu Utama', callback_data: 'tg_menu' }]
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

            if (action === 'tg_input_profit') {
                global.botTg.answerCallbackQuery(query.id);
                global.tgInputState = { type: 'set_profit', chatId };
                return global.botTg.sendMessage(chatId, `💵 *SET MARGIN KEUNTUNGAN KATEGORI*\n\nKetik kategori dan nominal margin dipisahkan spasi:\nFormat: \`<KATEGORI> <NOMINAL>\`\nKategori: \`pulsa\`, \`data\`, \`emoney\`, \`pln\`, \`pasca\`\nContoh: \`pulsa 750\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'tg_settings_menu' }]] }
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
                global.botTg.sendMessage(chatId, "⏳ *Mengekstrak file backup...*\nMohon tunggu, proses penimpaan data sedang berlangsung...", {parse_mode: 'Markdown'});
                try {
                    const { spawnSync } = require('child_process');
                    const path = require('path');
                    const backupFiles = fs.readdirSync('.').filter(f => /^AUTO-BACKUP-[\w.-]+\.zip$/.test(f)).sort().reverse();
                    if (backupFiles.length === 0) {
                        return global.botTg.sendMessage(chatId, "❌ *Tidak ada file backup AUTO-BACKUP-*.zip yang valid ditemukan.*", {parse_mode: 'Markdown'});
                    }
                    const targetZip = backupFiles[0];
                    const safeZipPath = path.resolve('.', targetZip);

                    if (process.platform === 'win32') {
                        spawnSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive', '-LiteralPath', safeZipPath, '-DestinationPath', '.', '-Force'], { stdio: 'ignore' });
                    } else {
                        spawnSync('unzip', ['-o', safeZipPath, '-d', '.'], { stdio: 'ignore' });
                    }
                    fs.writeFileSync('RESTORE_SUCCESS.txt', 'true');
                    global.botTg.sendMessage(chatId, `✅ *Restore Berhasil (${targetZip})!*\nSistem melakukan restart untuk menerapkan data baru...`, {parse_mode: 'Markdown'});
                    setTimeout(() => { process.exit(0); }, 2000);
                } catch (err) {
                    global.botTg.sendMessage(chatId, "❌ *Gagal Restore:* " + err.message);
                }
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

            // 6. Default: Render Dashboard Interaktif Inline Keyboard
            return updateOrSend(chatId, null, renderTelegramDashboard());
        });
        
        console.log(`[SYSTEM] 🎧 Telegram Command Center (Inline Keyboard) Aktif! (Admin ID: ${config.telegram.chatId || 'Belum Diatur'})`);
    } else if (!config.telegram.token || !config.telegram.token.includes(':')) {
        console.warn('⚠️ [TELEGRAM] TELEGRAM_TOKEN belum diatur di file .env. Command Center Telegram dinonaktifkan.');
    }
} catch (e) {
    console.log('[SYSTEM ERROR] Gagal memuat Telegram Listener:', e.message);
}






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

            if (order.sku && (order.sku.includes('PASCA') || order.sku.includes('PLNPOST'))) {
                payload.commands = 'status-pasca';
            }

            // LOGGING INTELIJEN: Tampilkan apa yang sedang dicek
            const maskTrg = (t = '') => t.length > 6 ? t.slice(0, 4) + '****' + t.slice(-3) : t;
            console.log(`[RADAR V4] 🔍 Mengecek OID: ${oid} | SKU: ${order.sku} | Trg: ${maskTrg(order.target)}`);

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
                if (typeof db.saveOrders === 'function') db.saveOrders();

                activeTransactions.delete(
                    (order.buyer || '') + '-' + (order.sku || order.item || 'ITEM') + '-' + (order.target || 'TARGET')
                );
                
                let snText = sn ? `\nSN/Ket: ${sn}` : '';
                await botSock.sendMessage(buyerJid, { text: `✅  *PPOB SUKSES*\n\nProduk: ${order.item || order.sku}\nTujuan: ${order.target}${snText}\n\nTerima kasih telah berbelanja di *${db.store.namaToko || 'Toko Kami'}*!` });
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
