require('dotenv').config();
const fs = require('fs');
const path = require('path');

const getSettings = () => {
    try {
        const file = path.join(__dirname, 'database', 'settings.json');
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
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
    pakasir: {
        project: process.env.PAKASIR_PROJECT || '',
        key: process.env.PAKASIR_KEY || ''
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
            pln: (s.profit && s.profit.pln !== undefined) ? Number(s.profit.pln) : 500
        };
    },
    get profitTier() {
        const s = getSettings();
        return {
            kecil: (s.profitTier && s.profitTier.kecil !== undefined) ? Number(s.profitTier.kecil) : 1000,
            sedang: (s.profitTier && s.profitTier.sedang !== undefined) ? Number(s.profitTier.sedang) : 1500,
            besar: (s.profitTier && s.profitTier.besar !== undefined) ? Number(s.profitTier.besar) : 2000,
            premium: (s.profitTier && s.profitTier.premium !== undefined) ? Number(s.profitTier.premium) : 3000
        };
    }
};

module.exports = config;

