require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const getSettings = () => {
    try {
        const file = path.join(__dirname, 'database', 'settings.json');
        const backupFile = path.join(__dirname, 'database', 'settings.backup.json');
        let s = {};
        if (fs.existsSync(file)) {
            try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
        }
        if (fs.existsSync(backupFile)) {
            try {
                const b = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
                if (!s.digiflazz?.username && b.digiflazz?.username) s.digiflazz = b.digiflazz;
                if (!s.dana?.number && b.dana?.number) s.dana = b.dana;
                if (!s.paymentGateway && b.paymentGateway) s.paymentGateway = b.paymentGateway;
                const isDummy = (t) => !t || typeof t !== 'string' || !t.includes(':');
                if (!isDummy(b.telegram?.token) && isDummy(s.telegram?.token)) s.telegram = b.telegram;
                if (!s.owner && b.owner) s.owner = b.owner;
            } catch (_) {}
        }
        return s;
    } catch (_) {}
    return {};
};

const config = {
    get owner() {
        const s = getSettings();
        if (Array.isArray(s.owner) && s.owner.length > 0) return s.owner;
        const envOwner = process.env.OWNER_NUMBER;
        return envOwner ? [envOwner] : [];
    },
    port: parseInt(process.env.PORT || '3000', 10),
    get paymentGateway() {
        return 'dana';
    },
    get dana() {
        const s = getSettings();
        const d = s.dana || {};
        let defaultQris = "00020101021240560011ID.DANA.WWW01189360091531433862600215ANGGA DIAN PRAT5204482953033605405101205802ID5924ANGGA DIAN PRATAMA PUTRA6011Kota Bekasi61051279062460804DMCT9934000200012428101201202610205004486663049B67";
        try {
            const { DEFAULT_DANA_QRIS_STRING } = require('./lib/qris');
            if (DEFAULT_DANA_QRIS_STRING) defaultQris = DEFAULT_DANA_QRIS_STRING;
        } catch (_) {}
        return {
            number: String(d.number || process.env.DANA_NUMBER || '081775700114').trim(),
            name: String(d.name || process.env.DANA_NAME || 'ANGGA DIAN PRATAMA PUTRA').trim(),
            deviceToken: String(d.deviceToken || process.env.DANA_DEVICE_TOKEN || 'dana_secret_token_2026').trim(),
            qrisString: String(d.qrisString || process.env.DANA_QRIS_STRING || defaultQris).trim()
        };
    },
    get digiflazz() {
        const s = getSettings();
        return {
            username: s.digiflazz?.username || process.env.DIGIFLAZZ_USERNAME || '',
            key: s.digiflazz?.key || process.env.DIGIFLAZZ_KEY || ''
        };
    },
    get telegram() {
        const s = getSettings();
        const sToken = (s.telegram?.token || '').trim();
        const sChatId = (s.telegram?.chatId || '').trim();
        const envToken = (process.env.TELEGRAM_TOKEN || '').trim();
        const envChatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

        const isValid = (t) => Boolean(t && typeof t === 'string' && t.includes(':'));

        const token = isValid(sToken) ? sToken : (isValid(envToken) ? envToken : '');
        const chatId = (isValid(sToken) && sChatId) ? sChatId : (envChatId || sChatId || '');

        return { token, chatId };
    },
    get profit() {
        const s = getSettings();
        return {
            pulsa: (s.profit && s.profit.pulsa !== undefined) ? Number(s.profit.pulsa) : 500,
            data: (s.profit && s.profit.data !== undefined) ? Number(s.profit.data) : 500,
            emoney: (s.profit && s.profit.emoney !== undefined) ? Number(s.profit.emoney) : 500,
            pln: (s.profit && s.profit.pln !== undefined) ? Number(s.profit.pln) : 500,
            pasca: (s.profit && s.profit.pasca !== undefined) ? Number(s.profit.pasca) : 1500
        };
    },
    get tierLimits() {
        const s = getSettings();
        const lim = s.tierLimits || {};
        return {
            kecil: (typeof lim.kecil === 'number' && lim.kecil > 0) ? lim.kecil : 25000,
            sedang: (typeof lim.sedang === 'number' && lim.sedang > 0) ? lim.sedang : 100000,
            besar: (typeof lim.besar === 'number' && lim.besar > 0) ? lim.besar : 300000
        };
    },
    get profitTier() {
        const s = getSettings();
        const tier = s.marginTier || s.profitTier || {};
        return {
            kecil: (typeof tier.kecil === 'number' && tier.kecil >= 0) ? tier.kecil : 250,
            sedang: (typeof tier.sedang === 'number' && tier.sedang >= 0) ? tier.sedang : 500,
            besar: (typeof tier.besar === 'number' && tier.besar >= 0) ? tier.besar : 1000,
            premium: (typeof tier.premium === 'number' && tier.premium >= 0) ? tier.premium : 2500
        };
    }
};

module.exports = config;

