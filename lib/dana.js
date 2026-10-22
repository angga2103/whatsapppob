/**
 * DANA Auto Transaksi & Mutasi Listener Service
 * Self-Hosted Micro Gateway with Real-Time Push Notification Listener
 * Ported from GarudaTel/Satset-Pay for Bot PPOB (WhatsApp & Telegram)
 */

const fs = require('fs');
const path = require('path');
const db = require('../database/db');
const { DEFAULT_DANA_QRIS_STRING } = require('./qris');

const DEVICE_STATUS_FILE = path.resolve(__dirname, '..', 'system', 'dana-device-status.json');
const UNMATCHED_FILE = path.resolve(__dirname, '..', 'system', 'dana_unmatched.json');

const processedEvents = new Set();

function getDanaConfig() {
    const s = db.settings || {};
    const d = s.dana || {};
    return {
        number: String(d.number || process.env.DANA_NUMBER || '081775700114').trim(),
        name: String(d.name || process.env.DANA_NAME || 'ANGGA DIAN PRATAMA PUTRA').trim(),
        deviceToken: String(d.deviceToken || process.env.DANA_DEVICE_TOKEN || 'dana_secret_token_2026').trim(),
        qrisString: String(d.qrisString || process.env.DANA_QRIS_STRING || DEFAULT_DANA_QRIS_STRING).trim()
    };
}

/**
 * Format tanggal WIB (UTC+7)
 */
function formatWib(date = new Date()) {
    try {
        return new Intl.DateTimeFormat('id-ID', {
            timeZone: 'Asia/Jakarta',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).format(date) + ' WIB';
    } catch (_) {
        return new Date(date).toLocaleString('id-ID') + ' WIB';
    }
}

/**
 * Menghasilkan kode unik acak (10 - 150) yang dijamin TIDAK BENTROK dengan
 * tagihan pending lain dalam 45 menit terakhir.
 */
function generateUniqueCode(nominal) {
    const cutoff = Date.now() - 45 * 60 * 1000;
    const baseNom = Math.round(Number(nominal) || 0);

    const busyAmounts = new Set();

    if (Array.isArray(db.orders)) {
        db.orders.forEach(o => {
            if ((o.status === 'pending' || o.status === 'unpaid') && (o.timestamp || 0) >= cutoff) {
                if (o.total) busyAmounts.add(Math.round(o.total));
            }
        });
    }

    if (Array.isArray(db.deposits)) {
        db.deposits.forEach(d => {
            if (d.status === 'pending' && (d.createdAt || 0) >= cutoff) {
                if (d.finalAmount) busyAmounts.add(Math.round(d.finalAmount));
            }
        });
    }

    // 1. Prioritas range 10 s/d 150 (141 variasi angka hemat biaya)
    for (let i = 0; i < 100; i++) {
        const code = Math.floor(Math.random() * 141) + 10;
        const total = baseNom + code;
        if (!busyAmounts.has(total)) {
            return { code, total };
        }
    }

    // 2. Fallback range 151 s/d 300
    for (let i = 0; i < 100; i++) {
        const code = Math.floor(Math.random() * 150) + 151;
        const total = baseNom + code;
        if (!busyAmounts.has(total)) {
            return { code, total };
        }
    }

    const code = Math.floor(Math.random() * 699) + 301;
    return { code, total: baseNom + code };
}

/**
 * Ekstraksi nominal Rupiah dari teks notifikasi DANA.
 * Mendukung format: 'Rp 15.234', 'Rp15.234', 'sebesar 15000', 'masuk 25000', dll.
 */
function extractAmountFromText(text) {
    if (!text) return null;
    const str = String(text);

    // 1. Pola Rp dengan pemisah titik/koma
    const mRp = str.match(/Rp\s*([0-9.,]+)/i);
    if (mRp && mRp[1]) {
        const raw = mRp[1].replace(/[.,]/g, '');
        const val = parseInt(raw, 10);
        if (val > 0) return val;
    }

    // 2. Pola kata kunci sebesar / uang / masuk
    const mWords = str.match(/(?:sebesar|uang|masuk|saldo)\s*([0-9.,]+)/i);
    if (mWords && mWords[1]) {
        const raw = mWords[1].replace(/[.,]/g, '');
        const val = parseInt(raw, 10);
        if (val > 0) return val;
    }

    // 3. Fallback: Cari deretan angka wajar (4 s/d 9 digit)
    const mDigits = str.match(/\b\d{4,9}\b/);
    if (mDigits) {
        const val = parseInt(mDigits[0], 10);
        if (val > 0) return val;
    }

    return null;
}

/**
 * Ekstraksi nama pengirim dari teks notifikasi DANA.
 */
function extractSenderFromText(text) {
    if (!text) return 'Member DANA';
    const str = String(text);
    const m = str.match(/dari\s+([^,.\n\r]+)/i);
    if (m && m[1]) {
        let name = m[1].trim();
        name = name.replace(/\s+(melalui|lewat|pada|di).*$/i, '').trim();
        return name.slice(0, 50) || 'Member DANA';
    }
    return 'Member DANA';
}

/**
 * Mencatat sinyal ping aktif (heartbeat) dari HP Samsung J1 Ace / PayHook / Notification Listener
 */
function recordDeviceHeartbeat(data = {}) {
    try {
        const dir = path.dirname(DEVICE_STATUS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let current = {};
        if (fs.existsSync(DEVICE_STATUS_FILE)) {
            try { current = JSON.parse(fs.readFileSync(DEVICE_STATUS_FILE, 'utf8')); } catch (_) {}
        }

        const updated = {
            ...current,
            lastPingIso: new Date().toISOString(),
            lastPingWib: formatWib(),
            battery: data.battery !== undefined ? String(data.battery) : (current.battery || '-'),
            isCharging: data.isCharging !== undefined ? Boolean(data.isCharging) : (current.isCharging || false),
            clientIp: data.clientIp || current.clientIp || '-',
            appVersion: data.appVersion || current.appVersion || 'PayHook Android',
            deviceId: data.deviceId || current.deviceId || 'Samsung J1 Ace',
            listenerConnected: data.listenerConnected !== undefined ? Boolean(data.listenerConnected) : true
        };

        fs.writeFileSync(DEVICE_STATUS_FILE, JSON.stringify(updated, null, 2), 'utf8');
        return updated;
    } catch (e) {
        console.error('[DANA HEARTBEAT ERROR]', e.message);
        return null;
    }
}

/**
 * Mengambil status live HP Samsung J1 Ace pembaca mutasi DANA
 */
function getDeviceStatus() {
    try {
        if (!fs.existsSync(DEVICE_STATUS_FILE)) {
            return {
                isOnline: false,
                minutesAgo: null,
                lastPingStr: 'Belum Pernah Terhubung',
                battery: '-',
                isCharging: false,
                clientIp: '-',
                appVersion: 'PayHook Android',
                deviceId: 'Samsung J1 Ace'
            };
        }

        const data = JSON.parse(fs.readFileSync(DEVICE_STATUS_FILE, 'utf8'));
        let isOnline = false;
        let minutesAgo = null;
        let lastPingStr = data.lastPingWib || 'Belum Terhubung';

        if (data.lastPingIso) {
            const diffSeconds = (Date.now() - new Date(data.lastPingIso).getTime()) / 1000;
            minutesAgo = Math.floor(diffSeconds / 60);
            isOnline = (diffSeconds <= 900); // Online jika ada laporan dalam 15 menit
        }

        return {
            isOnline,
            minutesAgo,
            lastPingStr,
            battery: data.battery || '-',
            isCharging: Boolean(data.isCharging),
            clientIp: data.clientIp || '-',
            appVersion: data.appVersion || 'PayHook Android',
            deviceId: data.deviceId || 'Samsung J1 Ace'
        };
    } catch (_) {
        return { isOnline: false, lastPingStr: 'Error baca status', battery: '-' };
    }
}

/**
 * Mencatat mutasi yang tidak cocok ke log JSON untuk audit
 */
function logUnmatchedMutation(entry) {
    try {
        const dir = path.dirname(UNMATCHED_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let list = [];
        if (fs.existsSync(UNMATCHED_FILE)) {
            try { list = JSON.parse(fs.readFileSync(UNMATCHED_FILE, 'utf8')); } catch (_) {}
        }
        if (!Array.isArray(list)) list = [];

        list.unshift({
            ...entry,
            timestamp: Date.now(),
            timeWib: formatWib()
        });

        // Simpan 50 entri terakhir
        if (list.length > 50) list = list.slice(0, 50);
        fs.writeFileSync(UNMATCHED_FILE, JSON.stringify(list, null, 2), 'utf8');
    } catch (_) {}
}

/**
 * Memproses mutasi transfer masuk dari DANA
 * Mencocokkan nominal dengan pending order atau pending deposit.
 */
async function processIncomingDanaMutation(options = {}) {
    const p = options.payload || options || {};
    const rawText = options.rawText || p.rawText || p.text || p.body || p.message || p.notif_text || p.content || '';
    const rawAmount = options.rawAmount ?? p.rawAmount ?? p.amount ?? p.nominal ?? p.total ?? p.value;
    const senderName = options.senderName || p.senderName || p.sender || p.from || p.title || '';
    const eventId = options.eventId || p.eventId || p.event_id || p.id || p.notification_id || null;
    const onOrderSuccess = options.onOrderSuccess;
    const onDepositSuccess = options.onDepositSuccess;

    // 1. Idempotency Key Guard
    if (eventId) {
        const cleanEvt = String(eventId).trim();
        if (processedEvents.has(cleanEvt)) {
            console.log(`[DANA IDEMPOTENT] Event ${cleanEvt} sudah diproses sebelumnya.`);
            return { success: true, idempotent: true, message: 'Event sudah pernah diproses.' };
        }
        processedEvents.add(cleanEvt);
        // Pertahankan maksimal 1000 ID di RAM
        if (processedEvents.size > 1000) {
            const first = processedEvents.values().next().value;
            processedEvents.delete(first);
        }
    }

    const amount = extractAmountFromText(rawAmount) || extractAmountFromText(rawText);
    if (!amount || amount <= 0) {
        return { success: false, message: `Nominal mutasi tidak valid: ${rawAmount || rawText}` };
    }

    const sender = senderName ? String(senderName).trim() : extractSenderFromText(rawText);
    const cutoff = Date.now() - 45 * 60 * 1000;
    const nowWib = formatWib();

    console.log(`[DANA MUTASI MASUK] Nominal: Rp ${amount.toLocaleString('id-ID')} | Pengirim: ${sender} | Waktu: ${nowWib}`);

    // ==========================================
    // PRIORITAS 1: TIKET DEPOSIT SALDO PENDING
    // ==========================================
    if (Array.isArray(db.deposits)) {
        const deposit = db.deposits.slice().reverse().find(d => {
            if (d.status !== 'pending' || d.isCredited) return false;
            if ((d.createdAt || 0) < cutoff) return false;

            const expectedFinal = Math.round(Number(d.finalAmount) || 0);
            const expectedBase = Math.round(Number(d.amount) || 0);

            // 🛡️ VALIDASI KETAT KODE UNIK:
            // Jika tiket deposit memiliki kode unik (finalAmount > 0 dan !== amount),
            // WAJIB match strictly dengan finalAmount! Transfer flat tanpa kode unik ditolak auto-match.
            if (expectedFinal > 0 && expectedFinal !== expectedBase) {
                return expectedFinal === amount;
            }
            return expectedBase === amount;
        });

        if (deposit) {
            deposit.status = 'success';
            deposit.isCredited = true;
            deposit.paidAt = Date.now();
            deposit.paidSender = sender;
            deposit.paidAmount = amount;
            deposit.eventId = eventId || null;

            // Tambah Saldo Member
            const canonicalBuyer = deposit.buyer;
            const buyerPhone = canonicalBuyer.replace(/[^0-9]/g, '');
            const targetJid = canonicalBuyer.includes('@') ? canonicalBuyer : `${buyerPhone}@s.whatsapp.net`;
            
            const user = db.getUser(targetJid);
            const nominalPokok = Number(deposit.amount) || amount;
            user.saldo = (Number(user.saldo) || 0) + nominalPokok;

            if (!Array.isArray(user.history)) user.history = [];
            const dateStr = new Date().toLocaleDateString('id-ID');
            user.history.push(`[${dateStr}] 🟢 Deposit DANA Otomatis (+Rp ${nominalPokok.toLocaleString('id-ID')})`);

            if (db.saveDeposits) db.saveDeposits();
            if (db.saveUsers) db.saveUsers();

            console.log(`[DANA DEPOSIT SUKSES] User ${buyerPhone} saldo +Rp ${nominalPokok.toLocaleString('id-ID')} | Sisa: Rp ${user.saldo.toLocaleString('id-ID')}`);

            if (typeof onDepositSuccess === 'function') {
                try {
                    await onDepositSuccess({ deposit, user, nominalPokok, amount, sender, targetJid });
                } catch (errCb) {
                    console.error('[ON DEPOSIT SUCCESS ERR]', errCb.message);
                }
            }

            return {
                success: true,
                type: 'deposit',
                depositId: deposit.id,
                buyer: buyerPhone,
                amount: nominalPokok,
                totalPaid: amount,
                sender,
                user
            };
        }
    }

    // ==========================================
    // PRIORITAS 2: ORDER PRODUK PPOB / DIGITAL LANGSUNG
    // ==========================================
    if (Array.isArray(db.orders)) {
        const order = db.orders.slice().reverse().find(o => 
            (o.status === 'pending' || o.status === 'unpaid') &&
            Math.round(o.total || 0) === amount &&
            (o.timestamp || 0) >= cutoff
        );

        if (order) {
            order.status = 'paid';
            order.paidAt = Date.now();
            order.paidSender = sender;
            order.paidAmount = amount;
            order.eventId = eventId || null;
            db.saveOrders();

            console.log(`[DANA ORDER SUKSES] Invoice ${order.id} (${order.item}) lunas Rp ${amount.toLocaleString('id-ID')}`);

            if (typeof onOrderSuccess === 'function') {
                try {
                    await onOrderSuccess({ order, amount, sender });
                } catch (errCb) {
                    console.error('[ON ORDER SUCCESS ERR]', errCb.message);
                }
            }

            return {
                success: true,
                type: 'order',
                orderId: order.id,
                item: order.item,
                amount,
                sender,
                order
            };
        }
    }

    // Jika tidak ditemukan tagihan yang cocok
    console.warn(`[DANA MUTASI UNMATCHED] Rp ${amount.toLocaleString('id-ID')} dari ${sender} tidak cocok dengan tagihan pending manapun.`);
    logUnmatchedMutation({ amount, sender, rawText, eventId });

    return {
        success: false,
        unmatched: true,
        message: `Tidak ditemukan tagihan pending aktif untuk nominal Rp ${amount.toLocaleString('id-ID')}`,
        amount,
        sender
    };
}

module.exports = {
    getDanaConfig,
    formatWib,
    generateUniqueCode,
    extractAmountFromText,
    extractSenderFromText,
    recordDeviceHeartbeat,
    getDeviceStatus,
    processIncomingDanaMutation,
    logUnmatchedMutation
};
