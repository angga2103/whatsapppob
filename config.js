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
                if (!s.paymentkita?.merchantId && b.paymentkita?.merchantId) s.paymentkita = b.paymentkita;
                if (!s.pakasir?.project && b.pakasir?.project) s.pakasir = b.pakasir;
                if (!s.paymentGateway && b.paymentGateway) s.paymentGateway = b.paymentGateway;
                if (!s.telegram?.token && b.telegram?.token && !b.telegram.token.startsWith('8470095940')) s.telegram = b.telegram;
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
        const s = getSettings();
        return (s.paymentGateway || process.env.PAYMENT_GATEWAY || 'paymentkita').toLowerCase();
    },
    get pakasir() {
        const s = getSettings();
        return {
            project: s.pakasir?.project || process.env.PAKASIR_PROJECT || '',
            key: s.pakasir?.key || process.env.PAKASIR_KEY || ''
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

        const token = (sToken && !sToken.startsWith('8470095940')) ? sToken : (envToken && !envToken.startsWith('8470095940') ? envToken : '');
        const chatId = sChatId || envChatId || '';

        return { token, chatId };
    },
    get paymentkita() {
        const s = getSettings();
        return {
            merchantId: s.paymentkita?.merchantId || process.env.PAYMENTKITA_MERCHANT_ID || '',
            secret: s.paymentkita?.secret || process.env.PAYMENTKITA_SECRET || ''
        };
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

