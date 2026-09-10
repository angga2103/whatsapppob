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

    fs.mkdirSync('./system',{
        recursive:true
    });

    global.sock = sock;

    fs.writeFileSync(
        ALERT_FILE,
        JSON.stringify(data,null,2)
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


async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session_bot');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // Kita matikan QR, ganti ke Pairing
        auth: state, 
        browser: Browsers.ubuntu('Chrome'), 
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    global.sock = sock;

    // --- FITUR KODE PAIRING KEMBALI ---
    if (!sock.authState.creds.registered) {
        console.clear();
        console.log('🤖 LOGIN BOT PPOB & DIGITAL STORE');
        const phoneNumber = await question('Masukan Nomor HP Bot (Format 628xxx): ');
        const code = await sock.requestPairingCode(phoneNumber.trim());
        console.log(`\n🔗 KODE PAIRING: \x1b[32m${code?.match(/.{1,4}/g)?.join('-') || code}\x1b[0m`);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            // JIKA BENAR-BENAR LOGGED OUT / TERHAPUS
            if (!shouldReconnect) {
                console.log('🚨 [SYSTEM FATAL] Sesi WhatsApp Terhapus / Suspend!');
                try {
                    const axios = require('axios');
                    axios.post('https://api.telegram.org/bot' + config.telegram.token + '/sendMessage', {
                        chat_id: config.telegram.chatId,
                        text: `🚨 *WHATSAPP LOGGED OUT / TERHAPUS* 🚨

Sistem mendeteksi sesi WhatsApp bot telah hilang/ter-suspend.

Silakan klik tombol di bawah untuk menautkan ulang:`,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '📱 TAUTKAN NOMOR BARU', callback_data: 'cmd_pair_new' }]]
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
                        o.buyer +
                        '-' +
                        o.sku +
                        '-' +
                        o.target
                    );
                });

      currentSock = sock;

            console.log(
                '[LOCK] Active transaction:',
                activeTransactions.size
            );
            db.orders.filter(o => o.status === 'pending').forEach(o => {
                if (!activeCheckers.has(o.id)) startPolling(sock, o);
            });
        }
    });

    global.sock = sock;
    
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const m = messages[0];
            if (!m.message || m.key.fromMe) return;
            const sender = jidNormalizedUser(m.key.remoteJid);
            const normSender = db.normalizeJid ? db.normalizeJid(sender) : sender;
            const isOwner = (config.owner || []).some(o => {
                const normO = db.normalizeJid ? db.normalizeJid(o) : o;
                return normO === normSender || o === sender;
            });
            let textBody = m.message.conversation || m.message.extendedTextMessage?.text || '';

            db.getUser(sender);
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
                'admin', 'pullppob', 'cekdigi', 'addsaldo', 'addmenu', 'adddata', 'delmenu', 
                'editmenu', 'stok', 'listmenu', 'resend', 'member', 'info', 'topsaldo', 
                'toptrx', 'stats', 'toko', 'namatoko', 'lunas', 'backup', 'health',
                'settings', 'pengaturan', 'setdigi', 'setpayment', 'settg', 'setprofit', 
                'settier', 'addowner', 'delowner', 'listowner', 'sync'
            ];

            if (isOwner && adminCommands.includes(cmd)) {
                return handleAdmin(sock, sender, cmd, args, m);
            }
            if (
    !isOwner &&
    db.store &&
    db.store.buka === false
) {
    return sock.sendMessage(sender,{
        text:
`🔴 *${db.store.namaToko || 'TOKO'} SEDANG OFFLINE*

Silakan coba lagi nanti.`
    });

    global.sock = sock;
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

    const trxKey =
        sender +
        '-' +
        item.sku +
        '-' +
        session.tempTarget;

    if (activeTransactions.has(trxKey)) {

        return sock.sendMessage(sender, {
            text:
`⚠️ Transaksi yang sama masih sedang diproses.

Target:
${session.tempTarget}

Mohon tunggu beberapa saat.`
        });
    }

    activeTransactions.add(trxKey);

    const isPpob = !!item.sku;
    const qty = isPpob ? 1 : session.tempQty;
    let baseAmount = (isPpob ? item.hargaJual : item.harga) * qty;

    const oid = `INV-${Date.now()}`;
    const cleanBuyer = db.normalizeJid(sender);
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
        target: session.tempTarget, 
        timestamp: Date.now() 
    };

    // --- INJEKSI INQUIRY PASCABAYAR ---
    if (item.isPasca) {
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
            baseAmount = inq.data.selling_price || inq.data.price;
            item.hargaJual = baseAmount;
            item.nama = inq.data.customer_name ? `${item.brand || item.name} (${inq.data.customer_name})` : (item.brand || item.name);
            order.baseAmount = baseAmount;
            order.item = item.nama;
        } catch (e) {
            activeTransactions.delete(trxKey);
            return sock.sendMessage(sender, { text: "❌ *ERROR API:* Gagal terhubung ke Digiflazz." });
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
    order.buyer +
    '-' +
    order.sku +
    '-' +
    order.target
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
db.saveOrders();

activeTransactions.delete(
    order.buyer +
    '-' +
    order.sku +
    '-' +
    order.target
);
                await sock.sendMessage(targetJid, { text: `✅ *PPOB SUKSES*\n\nProduk: ${order.item}\nTujuan: ${order.target}\nSN/Ket: ${formatDigiflazzMessage(hit.data.sn || hit.data.message)}` });
            } else if (hit.data.status === 'Pending') {
                order.status = 'processing'; if(typeof hit !== 'undefined' && hit.data && hit.data.ref_id) { order.digiflazz_oid = hit.data.ref_id; } db.saveOrders();
                await sock.sendMessage(targetJid, { text: `⏳ *MENUNGGU PROVIDER*\n\nPembayaran LUNAS. Transaksi sedang diproses oleh server pusat. Mohon ditunggu ya kak, produk akan segera masuk.` });
            } else {
                activeTransactions.delete(
                    order.buyer +
                    '-' +
                    order.sku +
                    '-' +
                    order.target
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
// 🎧 TELEGRAM COMMAND CENTER LISTENER
// ==========================================
try {
    const TelegramBot = require('node-telegram-bot-api');
    
    // Mencegah bentrok / double polling jika file dimuat ulang
    if (!global.botTg && config.telegram.token && config.telegram.token.includes(':')) {
        global.botTg = new TelegramBot(config.telegram.token, {polling: true});
        global.awaitingPhoneNumber = false;

        global.botTg.on('callback_query', async (query) => {
            const chatId = String(query.message?.chat?.id || query.from?.id || '');
            const authorizedChatId = String(config.telegram.chatId || '');

            if (!authorizedChatId || chatId !== authorizedChatId) {
                console.warn(`[SECURITY] Unauthorized Telegram callback attempt from Chat ID: ${chatId}`);
                return global.botTg.answerCallbackQuery(query.id, { text: "❌ Akses ditolak! Anda bukan Administrator.", show_alert: true });
            }

            const action = query.data;

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

            if (action === 'cmd_pair_new') {
                global.botTg.answerCallbackQuery(query.id);
                global.awaitingPhoneNumber = true;
                global.botTg.sendMessage(chatId, "📱 *TAUTKAN NOMOR BARU*\n\nSistem WhatsApp terdeteksi Logged Out/Suspend.\n\nSilakan balas pesan ini dengan nomor WhatsApp baru Anda menggunakan awalan *62* (Tanpa spasi atau tanda plus).\n\nContoh: `6281234567890`", {parse_mode: "Markdown"});
            }
        });

        global.botTg.on('message', async (msg) => {
            const chatId = String(msg.chat?.id || '');
            const authorizedChatId = String(config.telegram.chatId || '');
            if (!authorizedChatId || chatId !== authorizedChatId) return;

            const text = msg.text;

            // Jika bot sedang menunggu input nomor HP
            if (global.awaitingPhoneNumber && text && text.startsWith('62')) {
                global.awaitingPhoneNumber = false;
                global.botTg.sendMessage(chatId, "⏳ Memproses nomor: *" + text + "*...\n\n_Menyiapkan jembatan Pairing ke server Baileys..._", {parse_mode: 'Markdown'});
            }
        });
        
        console.log('[SYSTEM] 🎧 Telinga Telegram Command Center Berhasil Aktif!');
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
                if (typeof db.saveOrders === 'function') db.saveOrders();
                
                let snText = sn ? `\nSN/Ket: ${sn}` : '';
                await botSock.sendMessage(buyerJid, { text: `✅  *PPOB SUKSES*\n\nProduk: ${order.item || order.sku}\nTujuan: ${order.target}${snText}\n\nTerima kasih telah berbelanja!\n\n🌐 *Transaksi produk lebih lengkap kunjungi:* garudatel.my.id` });
                console.log("[RADAR V4] ✅ Sukses! Pesan terkirim.");
            } 
            else if (status === 'Gagal') {
                // PERISAI ANTI-REFUND PALSU:
                // Jika error karena kunci salah atau OID tidak ditemukan, abaikan! Jangan refund!
                if (sn.includes("tidak ditemukan") || sn.includes("Signature") || sn.includes("Gagal memproses")) {
                    console.log("[RADAR V4] ⚠️ Mengabaikan Gagal palsu karena OID lama.");
                    continue; 
                }

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
