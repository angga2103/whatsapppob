require('dotenv').config();
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
                if (!s.telegram?.token && b.telegram?.token) s.telegram = b.telegram;
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
        return {
            token: s.telegram?.token || process.env.TELEGRAM_TOKEN || '',
            chatId: s.telegram?.chatId || process.env.TELEGRAM_CHAT_ID || ''
        };
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
    get profitTier() {
        const s = getSettings();
        const tier = s.profitTier || s.marginTier || {};
        return {
            kecil: (tier.kecil !== undefined) ? Number(tier.kecil) : 1000,
            sedang: (tier.sedang !== undefined) ? Number(tier.sedang) : 1500,
            besar: (tier.besar !== undefined) ? Number(tier.besar) : 2000,
            premium: (tier.premium !== undefined) ? Number(tier.premium) : 3000
        };
    }
};

module.exports = config;

