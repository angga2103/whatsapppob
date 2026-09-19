/**
 * ==============================================================================
 * 📊 MODUL MARGIN AUTOTIER (BERDASARKAN NOMINAL HARGA MODAL PRODUK)
 * ==============================================================================
 * Sistem tiering dinamis untuk produk PPOB & Toko Digital.
 * Keuntungan dihitung murni berdasarkan nominal harga modal produk,
 * bukan lagi berdasarkan kategori (Pulsa, Data, E-Money, PLN).
 */

const db = require('../database/db');
const { formatRupiah } = require('./utils');

// Batas rentang harga modal default
const DEFAULT_LIMITS = {
    kecil: 25000,    // Rp 0 s/d Rp 25.000
    sedang: 100000,  // Rp 25.001 s/d Rp 100.000
    besar: 300000    // Rp 100.001 s/d Rp 300.000
    // Di atas besar = Tier Premium (> Rp 300.000)
};

// Nilai margin profit default per tier
const DEFAULT_TIER_MARGIN = {
    kecil: 250,
    sedang: 500,
    besar: 1000,
    premium: 2500
};

/**
 * Mendapatkan batas rentang nominal aktif
 */
function getTierLimits() {
    try {
        const s = db.settings || {};
        const lim = s.tierLimits || {};
        return {
            kecil: (typeof lim.kecil === 'number' && lim.kecil > 0) ? lim.kecil : DEFAULT_LIMITS.kecil,
            sedang: (typeof lim.sedang === 'number' && lim.sedang > 0) ? lim.sedang : DEFAULT_LIMITS.sedang,
            besar: (typeof lim.besar === 'number' && lim.besar > 0) ? lim.besar : DEFAULT_LIMITS.besar
        };
    } catch (_) {
        return { ...DEFAULT_LIMITS };
    }
}

/**
 * Mendapatkan nominal margin profit aktif per tier
 */
function getProfitTier() {
    try {
        const s = db.settings || {};
        const tier = s.marginTier || s.profitTier || {};
        return {
            kecil: (typeof tier.kecil === 'number' && tier.kecil >= 0) ? tier.kecil : DEFAULT_TIER_MARGIN.kecil,
            sedang: (typeof tier.sedang === 'number' && tier.sedang >= 0) ? tier.sedang : DEFAULT_TIER_MARGIN.sedang,
            besar: (typeof tier.besar === 'number' && tier.besar >= 0) ? tier.besar : DEFAULT_TIER_MARGIN.besar,
            premium: (typeof tier.premium === 'number' && tier.premium >= 0) ? tier.premium : DEFAULT_TIER_MARGIN.premium
        };
    } catch (_) {
        return { ...DEFAULT_TIER_MARGIN };
    }
}

/**
 * Evaluasi produk berdasarkan nominal harga modal
 * @param {number} modalPrice 
 * @returns {object} Informasi tier, rentang, dan margin
 */
function getTierInfo(modalPrice) {
    const p = Math.max(0, Math.round(Number(modalPrice) || 0));
    const lim = getTierLimits();
    const margin = getProfitTier();

    if (p <= lim.kecil) {
        return {
            key: 'kecil',
            name: 'Kecil',
            badge: '🟢',
            min: 0,
            max: lim.kecil,
            margin: margin.kecil,
            rangeStr: `Rp 0 - ${formatRupiah(lim.kecil)}`,
            desc: 'Pulsa 5k-25k, Kuota Harian, E-Money 10k-20k'
        };
    } else if (p <= lim.sedang) {
        return {
            key: 'sedang',
            name: 'Sedang',
            badge: '🟡',
            min: lim.kecil + 1,
            max: lim.sedang,
            margin: margin.sedang,
            rangeStr: `${formatRupiah(lim.kecil + 1)} - ${formatRupiah(lim.sedang)}`,
            desc: 'Pulsa 30k-100k, Token PLN 50k/100k, Kuota 30hr'
        };
    } else if (p <= lim.besar) {
        return {
            key: 'besar',
            name: 'Besar',
            badge: '🔵',
            min: lim.sedang + 1,
            max: lim.besar,
            margin: margin.besar,
            rangeStr: `${formatRupiah(lim.sedang + 1)} - ${formatRupiah(lim.besar)}`,
            desc: 'Pulsa 150k-200k, Token PLN 200k, Kuota Jumbo'
        };
    } else {
        return {
            key: 'premium',
            name: 'Premium',
            badge: '🟣',
            min: lim.besar + 1,
            max: Infinity,
            margin: margin.premium,
            rangeStr: `> ${formatRupiah(lim.besar)}`,
            desc: 'Token PLN 500k-1Jt, Game Voucher Besar, Kuota Tahunan'
        };
    }
}

/**
 * Menghitung harga jual dari harga modal berdasarkan Auto-Tier
 * @param {number} modalPrice 
 * @returns {number} Harga Jual Akhir
 */
function calculateSellingPrice(modalPrice) {
    const modal = Math.max(0, Math.round(Number(modalPrice) || 0));
    const info = getTierInfo(modal);
    return modal + info.margin;
}

/**
 * Rekalkulasi seluruh produk PPOB secara instan ketika margin tier diubah
 * @returns {object} { updatedCount, totalCount }
 */
function recalculatePpobPrices() {
    if (!Array.isArray(db.ppob) || db.ppob.length === 0) {
        return { updatedCount: 0, totalCount: 0 };
    }

    let updatedCount = 0;
    db.ppob.forEach(p => {
        if (typeof p.hargaModal === 'number' && p.hargaModal > 0) {
            const expectedSelling = calculateSellingPrice(p.hargaModal);
            if (p.hargaJual !== expectedSelling) {
                p.hargaJual = expectedSelling;
                updatedCount++;
            }
        }
    });

    if (updatedCount > 0 && db.savePpob) {
        db.savePpob();
    }

    return { updatedCount, totalCount: db.ppob.length };
}

/**
 * Mengubah margin nominal tier dan otomatis rekalkulasi katalog
 * @param {'kecil'|'sedang'|'besar'|'premium'} tierKey 
 * @param {number} nominal 
 * @returns {object} Hasil update
 */
function setTierMargin(tierKey, nominal) {
    const key = String(tierKey || '').toLowerCase().trim();
    if (!['kecil', 'sedang', 'besar', 'premium'].includes(key)) {
        throw new Error('Tier tidak valid. Pilihan: kecil, sedang, besar, premium');
    }
    const nom = Math.max(0, Math.round(Number(nominal) || 0));

    if (!db.settings) db.settings = {};
    if (!db.settings.marginTier) db.settings.marginTier = getProfitTier();
    db.settings.marginTier[key] = nom;
    db.settings.profitTier = { ...db.settings.marginTier };

    if (db.saveSettings) db.saveSettings();

    const recalc = recalculatePpobPrices();
    return { tierKey: key, nominal: nom, ...recalc };
}

/**
 * Mengubah batas rentang nominal tier
 * @param {number} kecilMax 
 * @param {number} sedangMax 
 * @param {number} besarMax 
 */
function setTierLimits(kecilMax, sedangMax, besarMax) {
    const k = Math.round(Number(kecilMax) || 0);
    const s = Math.round(Number(sedangMax) || 0);
    const b = Math.round(Number(besarMax) || 0);

    if (k <= 0 || s <= k || b <= s) {
        throw new Error('Urutan batas harus: 0 < kecil < sedang < besar');
    }

    if (!db.settings) db.settings = {};
    db.settings.tierLimits = { kecil: k, sedang: s, besar: b };
    if (db.saveSettings) db.saveSettings();

    const recalc = recalculatePpobPrices();
    return { limits: { kecil: k, sedang: s, besar: b }, ...recalc };
}

/**
 * Format ringkasan teks untuk Telegram & WhatsApp
 */
function getMarginSummaryText() {
    const lim = getTierLimits();
    const margin = getProfitTier();
    const totalProduk = Array.isArray(db.ppob) ? db.ppob.length : 0;

    let text = `📊 *SKEMA MARGIN AUTOTIER (BERDASARKAN HARGA MODAL)*\n`;
    text += `_Keuntungan otomatis menyesuaikan nominal modal produk (Bukan Kategori)_\n\n`;

    text += `🟢 *Tier Kecil* (Rp 0 - ${formatRupiah(lim.kecil)}):\n`;
    text += `   ➥ Margin: *${formatRupiah(margin.kecil)}*\n`;
    text += `   _(Pulsa 5k-25k, Kuota Harian, E-Money 10k-20k)_\n\n`;

    text += `🟡 *Tier Sedang* (${formatRupiah(lim.kecil + 1)} - ${formatRupiah(lim.sedang)}):\n`;
    text += `   ➥ Margin: *${formatRupiah(margin.sedang)}*\n`;
    text += `   _(Pulsa 30k-100k, Token PLN 50k/100k, Kuota Bulanan)_\n\n`;

    text += `🔵 *Tier Besar* (${formatRupiah(lim.sedang + 1)} - ${formatRupiah(lim.besar)}):\n`;
    text += `   ➥ Margin: *${formatRupiah(margin.besar)}*\n`;
    text += `   _(Pulsa 150k-200k, Token PLN 200k, Kuota Jumbo)_\n\n`;

    text += `🟣 *Tier Premium* (> ${formatRupiah(lim.besar)}):\n`;
    text += `   ➥ Margin: *${formatRupiah(margin.premium)}*\n`;
    text += `   _(Token PLN 500k-1Jt, Game Voucher Besar, Kuota Tahunan)_\n\n`;

    text += `📦 *Total Produk PPOB Aktif:* ${totalProduk} Produk`;
    return text;
}

function getTierMargin(modalPrice) {
    const info = getTierInfo(modalPrice);
    return info ? info.margin : DEFAULT_TIER_MARGIN.sedang;
}

module.exports = {
    DEFAULT_LIMITS,
    DEFAULT_TIER_MARGIN,
    getTierLimits,
    getProfitTier,
    getTierInfo,
    getTierMargin,
    calculateSellingPrice,
    recalculatePpobPrices,
    setTierMargin,
    setTierLimits,
    getMarginSummaryText
};
