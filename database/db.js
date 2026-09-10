const fs = require('fs-extra');
const path = require('path');

const atomicWriteJson = (filePath, data) => {
    const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.moveSync(tmpPath, filePath, { overwrite: true });
    } catch (e) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        // Fallback direct write if atomic move fails
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }
};

const safeReadJson = (filePath, defaultValue) => {
    try {
        if (!fs.existsSync(filePath)) {
            atomicWriteJson(filePath, defaultValue);
            return defaultValue;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (e) {
        console.error(`[DB ERROR] Gagal membaca ${filePath}:`, e.message);
        return defaultValue;
    }
};

const checkFile = (f, c) => { if (!fs.existsSync(f)) atomicWriteJson(f, JSON.parse(c)); };
checkFile('./database/menu.json', '[]');
checkFile('./database/ppob.json', '[]');
checkFile('./database/postpaid.json', '[]');
checkFile('./database/users.json', '{}');
checkFile('./database/orders.json', '[]');
checkFile('./database/store.json', '{"buka": true, "namaToko": "DIGITAL STORE"}');
checkFile('./database/deposits.json', '[]');
checkFile('./database/settings.json', '{}');

const db = {
    menu: safeReadJson('./database/menu.json', []),
    ppob: safeReadJson('./database/ppob.json', []),
    users: safeReadJson('./database/users.json', {}),
    orders: safeReadJson('./database/orders.json', []),
    postpaid: safeReadJson('./database/postpaid.json', []),
    store: safeReadJson('./database/store.json', { buka: true, namaToko: "DIGITAL STORE" }),
    deposits: safeReadJson('./database/deposits.json', []),
    settings: safeReadJson('./database/settings.json', {}),
    
    saveMenu: () => atomicWriteJson('./database/menu.json', db.menu),
    savePpob: () => atomicWriteJson('./database/ppob.json', db.ppob),
    saveUsers: () => atomicWriteJson('./database/users.json', db.users),
    saveOrders: () => atomicWriteJson('./database/orders.json', db.orders),
    savePostpaid: () => atomicWriteJson('./database/postpaid.json', db.postpaid),
    saveStore: () => atomicWriteJson('./database/store.json', db.store),
    saveDeposits: () => atomicWriteJson('./database/deposits.json', db.deposits),
    saveSettings: () => atomicWriteJson('./database/settings.json', db.settings),
    
    save: () => {
        db.saveStore();
        db.saveMenu();
        db.saveUsers();
        db.saveOrders();
        db.savePpob();
        db.savePostpaid();
        db.saveDeposits();
        db.saveSettings();
    },

    // 🧬 Penyatuan Dompet Akun (Wallet Consolidation)
    consolidateWallets: () => {
        let changed = false;
        for (const [jid, user] of Object.entries(db.users)) {
            if (jid.includes('@lid') && user && user.phone) {
                let cleanPhone = String(user.phone).replace(/[^0-9]/g, '');
                if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
                if (cleanPhone.length >= 10 && cleanPhone.startsWith('62')) {
                    const canonicalJid = `${cleanPhone}@s.whatsapp.net`;
                    if (!db.users[canonicalJid]) {
                        db.users[canonicalJid] = {
                            name: user.name || '',
                            phone: cleanPhone,
                            saldo: Number(user.saldo) || 0,
                            history: Array.isArray(user.history) ? [...user.history] : [],
                            date: user.date || Date.now()
                        };
                        user.saldo = 0;
                        user.canonical = canonicalJid;
                        changed = true;
                    } else {
                        // Jika akun canonical sudah ada, gabungkan saldo dan history
                        if (user.saldo && Number(user.saldo) > 0) {
                            db.users[canonicalJid].saldo = (Number(db.users[canonicalJid].saldo) || 0) + Number(user.saldo);
                            user.saldo = 0;
                            changed = true;
                        }
                        if (Array.isArray(user.history) && user.history.length > 0) {
                            if (!Array.isArray(db.users[canonicalJid].history)) db.users[canonicalJid].history = [];
                            db.users[canonicalJid].history = [...new Set([...db.users[canonicalJid].history, ...user.history])];
                            changed = true;
                        }
                        user.canonical = canonicalJid;
                    }
                }
            }
        }
        if (changed) db.saveUsers();
    },

    // 🧬 Normalisasi JID Terpusat (Resolusi @lid dan Multi-Device ke Canonical @s.whatsapp.net)
    normalizeJid: (sender) => {
        if (!sender || typeof sender !== 'string') return sender;
        let clean = sender;
        if (clean.includes(':')) {
            clean = clean.split(':')[0] + '@' + clean.split('@')[1];
        }
        if (clean.includes('@lid')) {
            // 1. Cek apakah ada pointer canonical
            if (db.users[clean] && db.users[clean].canonical) {
                return db.users[clean].canonical;
            }
            // 2. Cek nomor telepon terdaftar
            let pPhone = (db.users[clean] && db.users[clean].phone)
                ? String(db.users[clean].phone).replace(/[^0-9]/g, '')
                : '';
            if (pPhone.startsWith('0')) pPhone = '62' + pPhone.slice(1);
            if (pPhone.length >= 10 && pPhone.startsWith('62')) {
                return `${pPhone}@s.whatsapp.net`;
            }
            // 3. Cari dari data user yang sudah ada
            const findMain = Object.entries(db.users).find(([j, u]) => 
                !j.includes('@lid') && (u.phone === pPhone || (pPhone && j.startsWith(pPhone)))
            );
            if (findMain) return findMain[0];
        }
        return clean;
    },

    // 👤 Ambil User Secara Konsisten (Selalu Menggunakan Akun Canonical)
    getUser: (sender) => {
        const jid = db.normalizeJid(sender);
        if (!db.users[jid]) {
            let phone = jid.split('@')[0].replace(/[^0-9]/g, '');
            if (phone.startsWith('0')) phone = '62' + phone.slice(1);
            db.users[jid] = { saldo: 0, phone: phone, history: [], date: Date.now() };
            db.saveUsers();
        }
        // Pastikan format struktur data valid
        if (typeof db.users[jid].saldo === 'undefined') db.users[jid].saldo = 0;
        if (!Array.isArray(db.users[jid].history)) db.users[jid].history = [];
        return db.users[jid];
    },

    // 💸 Potong Saldo Atomik & Tercatat
    deductSaldo: (sender, amount, orderId = '', itemName = '') => {
        const user = db.getUser(sender);
        const nom = Number(amount);
        if (isNaN(nom) || nom <= 0) return { success: false, reason: 'Nominal tidak valid' };
        if ((Number(user.saldo) || 0) < nom) {
            return { success: false, reason: 'Saldo tidak mencukupi', saldo: user.saldo };
        }
        user.saldo = (Number(user.saldo) || 0) - nom;
        if (!Array.isArray(user.history)) user.history = [];
        const dateStr = new Date().toLocaleDateString('id-ID');
        user.history.push(`[${dateStr}] 🔴 Beli ${itemName || orderId} (-Rp ${nom.toLocaleString('id-ID')})`);
        db.saveUsers();
        return { success: true, remainingSaldo: user.saldo };
    },

    // 🛡️ REFUND ATOMIK & IDEMPOTEN (PENCEGAH DOUBLE REFUND 100%)
    refundOrder: (order, reason = 'Transaksi Gagal') => {
        if (!order) return { success: false, reason: 'Order tidak ditemukan' };
        
        // 🔒 PERISAI 1: Jangan pernah me-refund order yang sudah ditandai refunded
        if (order.refunded) {
            console.log(`[REFUND GUARD] ⚠️ Order ${order.id} sudah pernah di-refund sebelumnya. Memblokir refund ganda.`);
            return { success: false, reason: 'Order sudah di-refund sebelumnya', alreadyRefunded: true };
        }

        const refundAmount = Number(order.baseAmount || order.total || order.harga || 0);
        if (refundAmount <= 0) {
            return { success: false, reason: 'Nominal refund 0' };
        }

        // Kunci status refund pada order SEBELUM mengubah saldo
        order.refunded = true;
        order.refundedAt = Date.now();
        order.refundAmount = refundAmount;
        order.refundReason = reason;
        order.status = 'failed';

        // Dapatkan akun canonical penerima refund
        const buyerJid = db.normalizeJid(order.buyer || order.sender || order.jid);
        const user = db.getUser(buyerJid);

        user.saldo = (Number(user.saldo) || 0) + refundAmount;
        if (!Array.isArray(user.history)) user.history = [];
        const dateStr = new Date().toLocaleDateString('id-ID');
        user.history.push(`[${dateStr}] 🟢 Refund ${order.item || order.sku || order.id} (+Rp ${refundAmount.toLocaleString('id-ID')}) - ${reason}`);

        db.saveUsers();
        db.saveOrders();

        console.log(`[REFUND SUKSES] ✅ Order ${order.id}: Rp ${refundAmount.toLocaleString('id-ID')} dikembalikan ke ${buyerJid}. Saldo sekarang: Rp ${user.saldo.toLocaleString('id-ID')}`);
        return { success: true, amount: refundAmount, buyerJid, newSaldo: user.saldo };
    }
};

// Jalankan konsolidasi dompet saat module dimuat
try {
    db.consolidateWallets();
} catch (err) {
    console.error('[DB CONSOLIDATE ERROR]', err.message);
}

module.exports = db;


