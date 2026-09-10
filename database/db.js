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

    // Centralized JID normalization (Resolves @lid vs @s.whatsapp.net)
    normalizeJid: (sender) => {
        if (!sender || typeof sender !== 'string') return sender;
        let realJid = sender;
        if (sender.includes('@lid')) {
            let pPhone = (db.users[sender] && db.users[sender].phone)
                ? String(db.users[sender].phone).replace(/[^0-9]/g, '')
                : sender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            if (pPhone.startsWith('0')) pPhone = '62' + pPhone.slice(1);
            
            const findMain = Object.entries(db.users).find(([j, u]) => 
                !j.includes('@lid') && (u.phone === pPhone || j.startsWith(pPhone))
            );
            if (findMain) realJid = findMain[0];
        } else if (sender.includes(':')) {
            realJid = sender.split(':')[0] + '@s.whatsapp.net';
        }
        return realJid;
    },

    getUser: (sender) => {
        const jid = db.normalizeJid(sender);
        if (!db.users[jid]) {
            let phone = jid.split('@')[0].replace(/[^0-9]/g, '');
            if (phone.startsWith('0')) phone = '62' + phone.slice(1);
            db.users[jid] = { saldo: 0, phone: phone, date: Date.now() };
            db.saveUsers();
        }
        return db.users[jid];
    }
};

module.exports = db;

