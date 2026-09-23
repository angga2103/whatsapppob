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
checkFile('./database/subscription_catalog.json', '[]');
checkFile('./database/subscriptions.json', '[]');
checkFile('./database/debts.json', '[]');

const syncSettingsToEnv = (settings) => {
    if (!settings || typeof settings !== 'object') return;
    try {
        const envPath = path.resolve(__dirname, '..', '.env');
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        
        const updates = {};
        if (settings.telegram?.token) updates['TELEGRAM_TOKEN'] = settings.telegram.token;
        if (settings.telegram?.chatId) updates['TELEGRAM_CHAT_ID'] = settings.telegram.chatId;
        if (settings.digiflazz?.username) updates['DIGIFLAZZ_USERNAME'] = settings.digiflazz.username;
        if (settings.digiflazz?.key) updates['DIGIFLAZZ_KEY'] = settings.digiflazz.key;
        if (settings.paymentkita?.merchantId) updates['PAYMENTKITA_MERCHANT_ID'] = settings.paymentkita.merchantId;
        if (settings.paymentkita?.secret) updates['PAYMENTKITA_SECRET'] = settings.paymentkita.secret;
        if (settings.pakasir?.project) updates['PAKASIR_PROJECT'] = settings.pakasir.project;
        if (settings.pakasir?.key) updates['PAKASIR_KEY'] = settings.pakasir.key;
        if (settings.paymentGateway) updates['PAYMENT_GATEWAY'] = settings.paymentGateway;

        let lines = envContent ? envContent.split(/\r?\n/) : [];
        for (const [key, val] of Object.entries(updates)) {
            if (!val) continue;
            let found = false;
            lines = lines.map(line => {
                if (line.trim().startsWith(`${key}=`)) {
                    found = true;
                    return `${key}=${val}`;
                }
                return line;
            });
            if (!found) {
                lines.push(`${key}=${val}`);
            }
        }
        fs.writeFileSync(envPath, lines.join('\n').trim() + '\n', 'utf8');
    } catch (err) {
        console.error('[ENV SYNC ERROR]', err.message);
    }
};

const recoverSettings = () => {
    let settings = safeReadJson('./database/settings.json', {});
    const backupPath = './database/settings.backup.json';
    const backupSettings = fs.existsSync(backupPath) ? safeReadJson(backupPath, {}) : {};

    // 1. Pulihkan dari settings.backup.json jika kosong
    if (!settings.digiflazz?.username && backupSettings.digiflazz?.username) {
        settings.digiflazz = backupSettings.digiflazz;
    }
    if (!settings.paymentkita?.merchantId && backupSettings.paymentkita?.merchantId) {
        settings.paymentkita = backupSettings.paymentkita;
    }
    if (!settings.pakasir?.project && backupSettings.pakasir?.project) {
        settings.pakasir = backupSettings.pakasir;
    }
    if (!settings.paymentGateway && backupSettings.paymentGateway) {
        settings.paymentGateway = backupSettings.paymentGateway;
    }
    if (!settings.telegram?.token && backupSettings.telegram?.token && !backupSettings.telegram.token.startsWith('8470095940')) {
        settings.telegram = backupSettings.telegram;
    }

    // 2. Pulihkan / sinkronkan dari .env
    const envPath = path.resolve(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        try {
            const dotenv = require('dotenv');
            const envConfig = dotenv.parse(fs.readFileSync(envPath));
            if (!settings.digiflazz?.username && envConfig.DIGIFLAZZ_USERNAME) {
                settings.digiflazz = { username: envConfig.DIGIFLAZZ_USERNAME, key: envConfig.DIGIFLAZZ_KEY || '' };
            }
            if (!settings.paymentkita?.merchantId && envConfig.PAYMENTKITA_MERCHANT_ID) {
                settings.paymentkita = { merchantId: envConfig.PAYMENTKITA_MERCHANT_ID, secret: envConfig.PAYMENTKITA_SECRET || '' };
            }
            if (!settings.pakasir?.project && envConfig.PAKASIR_PROJECT) {
                settings.pakasir = { project: envConfig.PAKASIR_PROJECT, key: envConfig.PAKASIR_KEY || '' };
            }
            if (!settings.paymentGateway && envConfig.PAYMENT_GATEWAY) {
                settings.paymentGateway = envConfig.PAYMENT_GATEWAY;
            }

            const envToken = (envConfig.TELEGRAM_TOKEN || '').trim();
            const envChatId = (envConfig.TELEGRAM_CHAT_ID || '').trim();
            const envStat = fs.statSync(envPath);
            const settingsFile = path.resolve(__dirname, 'settings.json');
            const settingsStat = fs.existsSync(settingsFile) ? fs.statSync(settingsFile) : { mtimeMs: 0 };

            // Jika token di .env valid dan bukan token lama
            if (envToken && envToken.includes(':') && !envToken.startsWith('8470095940')) {
                // Adopsi dari .env jika settings kosong, token lama, ATAU file .env diedit lebih baru
                if (!settings.telegram?.token || settings.telegram.token.startsWith('8470095940') || (envStat.mtimeMs > settingsStat.mtimeMs && settings.telegram.token !== envToken)) {
                    settings.telegram = {
                        token: envToken,
                        chatId: envChatId || settings.telegram?.chatId || ''
                    };
                }
            }
        } catch (_) {}
    }

    // Bersihkan residu token lama yang sudah dicabut jika masih tersisa
    if (settings.telegram?.token && settings.telegram.token.startsWith('8470095940')) {
        settings.telegram = { token: '', chatId: '' };
    }

    // 3. Pulihkan dari git stash HANYA jika kredensial benar-benar kosong
    try {
        const { execSync } = require('child_process');
        const stashes = execSync('git stash list', { stdio: 'pipe', encoding: 'utf-8' }).trim();
        if (stashes && (!settings.digiflazz?.username || !settings.paymentkita?.merchantId || !settings.telegram?.token)) {
            const stashLines = stashes.split('\n');
            for (let i = 0; i < Math.min(stashLines.length, 5); i++) {
                try {
                    const stashedStr = execSync(`git show stash@{${i}}:database/settings.json`, { stdio: 'pipe', encoding: 'utf-8' }).trim();
                    if (stashedStr) {
                        const stashedObj = JSON.parse(stashedStr);
                        if (stashedObj.digiflazz?.username && !settings.digiflazz?.username) {
                            settings.digiflazz = stashedObj.digiflazz;
                            console.log(`[RECOVERY] 🛡️ Berhasil memulihkan akun Digiflazz dari git stash@{${i}}!`);
                        }
                        if (stashedObj.paymentkita?.merchantId && !settings.paymentkita?.merchantId) {
                            settings.paymentkita = stashedObj.paymentkita;
                            console.log(`[RECOVERY] 🛡️ Berhasil memulihkan akun PaymentKita dari git stash@{${i}}!`);
                        }
                        if (stashedObj.pakasir?.project && !settings.pakasir?.project) {
                            settings.pakasir = stashedObj.pakasir;
                            console.log(`[RECOVERY] 🛡️ Berhasil memulihkan akun Pakasir dari git stash@{${i}}!`);
                        }
                        if (stashedObj.paymentGateway && !settings.paymentGateway) {
                            settings.paymentGateway = stashedObj.paymentGateway;
                        }
                        if (stashedObj.telegram?.token && !stashedObj.telegram.token.startsWith('8470095940')) {
                            if (!settings.telegram?.token) {
                                settings.telegram = stashedObj.telegram;
                                console.log(`[RECOVERY] 🛡️ Berhasil memulihkan Telegram bot dari git stash@{${i}}!`);
                            }
                        }
                    }
                } catch (_) {}
            }
        }
    } catch (_) {}

    atomicWriteJson('./database/settings.json', settings);
    atomicWriteJson(backupPath, settings);
    syncSettingsToEnv(settings);
    return settings;
};

const db = {
    menu: safeReadJson('./database/menu.json', []),
    ppob: safeReadJson('./database/ppob.json', []),
    users: safeReadJson('./database/users.json', {}),
    orders: safeReadJson('./database/orders.json', []),
    postpaid: safeReadJson('./database/postpaid.json', []),
    store: safeReadJson('./database/store.json', { buka: true, namaToko: "DIGITAL STORE" }),
    deposits: safeReadJson('./database/deposits.json', []),
    settings: recoverSettings(),
    subscriptionCatalog: safeReadJson('./database/subscription_catalog.json', []),
    subscriptions: safeReadJson('./database/subscriptions.json', []),
    debts: safeReadJson('./database/debts.json', []),
    
    saveMenu: () => atomicWriteJson('./database/menu.json', db.menu),
    savePpob: () => atomicWriteJson('./database/ppob.json', db.ppob),
    saveUsers: () => atomicWriteJson('./database/users.json', db.users),
    saveOrders: () => atomicWriteJson('./database/orders.json', db.orders),
    savePostpaid: () => atomicWriteJson('./database/postpaid.json', db.postpaid),
    saveStore: () => atomicWriteJson('./database/store.json', db.store),
    saveDeposits: () => atomicWriteJson('./database/deposits.json', db.deposits),
    saveSubscriptionCatalog: () => atomicWriteJson('./database/subscription_catalog.json', db.subscriptionCatalog),
    saveSubscriptions: () => atomicWriteJson('./database/subscriptions.json', db.subscriptions),
    saveDebts: () => atomicWriteJson('./database/debts.json', db.debts),
    saveSettings: () => {
        atomicWriteJson('./database/settings.json', db.settings);
        atomicWriteJson('./database/settings.backup.json', db.settings);
        syncSettingsToEnv(db.settings);
    },
    
    save: () => {
        db.saveStore();
        db.saveMenu();
        db.saveUsers();
        db.saveOrders();
        db.savePpob();
        db.savePostpaid();
        db.saveDeposits();
        db.saveSubscriptionCatalog();
        db.saveSubscriptions();
        db.saveDebts();
        db.saveSettings();
    },

    // 🧬 Penyatuan Dompet Akun (Wallet Consolidation)
    consolidateWallets: () => {
        let changed = false;
        
        // Deteksi ID bot dari creds jika ada
        let botPhone = '';
        let botLid = '';
        try {
            if (fs.existsSync('./session_bot/creds.json')) {
                const creds = JSON.parse(fs.readFileSync('./session_bot/creds.json', 'utf8'));
                if (creds?.me?.id) botPhone = creds.me.id.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
                if (creds?.me?.lid) botLid = creds.me.lid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
            }
        } catch (_) {}

        for (const [jid, user] of Object.entries(db.users)) {
            if (!user || typeof user !== 'object') continue;

            // Bersihkan entity non-user (broadcast / newsletter)
            if (jid.includes('@newsletter') || jid.includes('@broadcast') || jid.includes('@g.us')) {
                delete db.users[jid];
                changed = true;
                continue;
            }

            // Jika ini akun bot sendiri, tandai dan lewati
            if (botPhone && (jid.startsWith(botPhone) || user.phone === botPhone)) {
                user.isBot = true;
                continue;
            }
            if (botLid && jid.startsWith(botLid)) {
                user.isBot = true;
                continue;
            }

            if (jid.includes('@lid') && user && user.phone) {
                let cleanPhone = String(user.phone).replace(/[^0-9]/g, '');
                if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
                if (cleanPhone.length >= 10 && cleanPhone.startsWith('628')) {
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
                        if (!db.users[canonicalJid].phone) {
                            db.users[canonicalJid].phone = cleanPhone;
                            changed = true;
                        }
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
                        if (user.name && (!db.users[canonicalJid].name || !db.users[canonicalJid].customName)) {
                            db.users[canonicalJid].name = user.name;
                            changed = true;
                        }
                        user.canonical = canonicalJid;
                    }
                }
            }

            if (jid.includes('@s.whatsapp.net')) {
                const p = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
                if (p.startsWith('628') && p.length >= 10 && p.length <= 14) {
                    if (!user.phone) {
                        user.phone = p;
                        changed = true;
                    }
                }
            }
        }
        if (changed) db.saveUsers();
    },

    // 🔗 Hubungkan LID ke Nomor Telepon Asli (Canonical JID)
    linkLidToPhone: (lidJid, phone, name) => {
        if (!lidJid || !phone) return null;
        let cleanPhone = String(phone).replace(/[^0-9]/g, '');
        if (cleanPhone.startsWith('0')) cleanPhone = '62' + cleanPhone.slice(1);
        if (cleanPhone.length < 10) return null;

        const canonicalJid = `${cleanPhone}@s.whatsapp.net`;
        const cleanLid = lidJid.includes(':') ? lidJid.split(':')[0] + '@lid' : lidJid;

        if (!db.users[canonicalJid]) {
            db.users[canonicalJid] = {
                name: name || '',
                phone: cleanPhone,
                saldo: 0,
                history: [],
                date: Date.now()
            };
        }

        const canUser = db.users[canonicalJid];
        canUser.phone = cleanPhone;
        canUser.lid = cleanLid;
        if (name && (!canUser.name || canUser.name === 'User' || !canUser.customName)) {
            canUser.name = name;
        }

        if (db.users[cleanLid]) {
            const lidUser = db.users[cleanLid];
            if (Number(lidUser.saldo) > 0) {
                canUser.saldo = (Number(canUser.saldo) || 0) + Number(lidUser.saldo);
                lidUser.saldo = 0;
            }
            if (Array.isArray(lidUser.history) && lidUser.history.length > 0) {
                if (!Array.isArray(canUser.history)) canUser.history = [];
                canUser.history = [...new Set([...canUser.history, ...lidUser.history])];
            }
            lidUser.canonical = canonicalJid;
            lidUser.phone = cleanPhone;
            if (name) lidUser.name = name;
        } else {
            db.users[cleanLid] = {
                canonical: canonicalJid,
                phone: cleanPhone,
                name: name || '',
                saldo: 0,
                history: [],
                date: Date.now()
            };
        }

        db.saveUsers();
        return canUser;
    },

    // ✏️ Ubah / Set Nama Member
    setUserName: (phoneOrJid, newName) => {
        if (!phoneOrJid || !newName) return false;
        let clean = String(phoneOrJid).trim();
        let targetUser = null;
        let canonicalJid = null;

        if (db.users[clean]) {
            targetUser = db.users[clean];
            canonicalJid = targetUser.canonical || clean;
        } else {
            let p = clean.replace(/[^0-9]/g, '');
            if (p.startsWith('0')) p = '62' + p.slice(1);
            canonicalJid = `${p}@s.whatsapp.net`;
            if (db.users[canonicalJid]) {
                targetUser = db.users[canonicalJid];
            } else {
                for (const [j, u] of Object.entries(db.users)) {
                    if (u && (u.phone === p || j.startsWith(p))) {
                        targetUser = u;
                        canonicalJid = u.canonical || j;
                        break;
                    }
                }
            }
        }

        if (!targetUser) return false;

        const valName = newName.trim();
        targetUser.name = valName;
        targetUser.customName = true;

        if (canonicalJid && db.users[canonicalJid]) {
            db.users[canonicalJid].name = valName;
            db.users[canonicalJid].customName = true;
        }

        for (const [j, u] of Object.entries(db.users)) {
            if (u && (u.canonical === canonicalJid || (targetUser.phone && u.phone === targetUser.phone))) {
                u.name = valName;
                u.customName = true;
            }
        }

        db.saveUsers();
        return true;
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
    getUser: (sender, extra = {}) => {
        const jid = db.normalizeJid(sender);
        let phone = extra.phone || null;
        if (!phone && jid.includes('@s.whatsapp.net')) {
            phone = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        }
        if (phone && phone.startsWith('0')) phone = '62' + phone.slice(1);

        if (!db.users[jid]) {
            db.users[jid] = { 
                saldo: 0, 
                phone: phone, 
                name: extra.name || '', 
                history: [], 
                date: Date.now() 
            };
            db.saveUsers();
        }
        const u = db.users[jid];
        // Pastikan format struktur data valid
        if (typeof u.saldo === 'undefined') u.saldo = 0;
        if (!Array.isArray(u.history)) u.history = [];
        if (phone && (!u.phone || u.phone !== phone)) {
            u.phone = phone;
            db.saveUsers();
        }
        if (extra.name && (!u.name || u.name === 'User' || !u.customName)) {
            u.name = extra.name;
            db.saveUsers();
        }
        return u;
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
    refundOrder: (orderTarget, reason = 'Transaksi Gagal') => {
        let order = orderTarget;
        if (typeof orderTarget === 'string') {
            order = (db.orders || []).find(o => o.id === orderTarget);
        }
        if (!order) return { success: false, reason: 'Order tidak ditemukan' };
        
        // 🔒 PERISAI 1: Jangan pernah me-refund order yang sudah ditandai refunded
        if (order.refunded) {
            console.log(`[REFUND GUARD] ⚠️ Order ${order.id} sudah pernah di-refund sebelumnya. Memblokir refund ganda.`);
            return { success: false, reason: 'Order sudah di-refund sebelumnya', alreadyRefunded: true };
        }

        // Jika metode pembayaran QRIS dan ada total bayar (termasuk fee/kode unik), refund total bayarnya
        const refundAmount = (order.method === 'QRIS' && order.total)
            ? Number(order.total)
            : Number(order.baseAmount || order.total || order.harga || 0);
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


