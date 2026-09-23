/**
 * Smart Natural Language Quick-Order Parser
 * Menganalisis pesan teks bebas pelanggan (contoh: "pulsa tsel 10k 0812xxx", "token pln 50rb 1412xxx", "dana 20k 0812xxx")
 * dan langsung mencocokkan produk PPOB terbaik.
 */

const { formatRupiah } = require('./utils');

// Prefix Provider Indonesia
const PREFIX_MAP = {
    '0811': 'TELKOMSEL', '0812': 'TELKOMSEL', '0813': 'TELKOMSEL',
    '0821': 'TELKOMSEL', '0822': 'TELKOMSEL', '0823': 'TELKOMSEL',
    '0851': 'TELKOMSEL', '0852': 'TELKOMSEL', '0853': 'TELKOMSEL',
    '0814': 'INDOSAT', '0815': 'INDOSAT', '0816': 'INDOSAT',
    '0855': 'INDOSAT', '0856': 'INDOSAT', '0857': 'INDOSAT', '0858': 'INDOSAT',
    '0817': 'XL', '0818': 'XL', '0819': 'XL', '0859': 'XL', '0877': 'XL', '0878': 'XL',
    '0831': 'AXIS', '0832': 'AXIS', '0833': 'AXIS', '0838': 'AXIS',
    '0895': 'TRI', '0896': 'TRI', '0897': 'TRI', '0898': 'TRI', '0899': 'TRI',
    '0881': 'SMARTFREN', '0882': 'SMARTFREN', '0883': 'SMARTFREN',
    '0884': 'SMARTFREN', '0885': 'SMARTFREN', '0886': 'SMARTFREN',
    '0887': 'SMARTFREN', '0888': 'SMARTFREN', '0889': 'SMARTFREN'
};

function detectProviderFromPhone(phone) {
    if (!phone) return null;
    let clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.startsWith('62')) clean = '0' + clean.slice(2);
    const prefix4 = clean.slice(0, 4);
    return PREFIX_MAP[prefix4] || null;
}

/**
 * Parsing teks bebas menjadi entitas order
 * @param {string} text - Pesan dari user
 * @param {Array} ppobCatalog - db.ppob katalog
 */
function parseQuickOrder(text, ppobCatalog = []) {
    if (!text || typeof text !== 'string') return null;

    const raw = text.trim();
    // Abaikan pesan jika terlalu panjang atau diawali tanda command sistem
    if (raw.length > 120 || /^[./!#]/.test(raw)) return null;

    // Normalisasi teks
    const lower = raw.toLowerCase().replace(/,/g, '');

    // 1. Ekstraksi Target (No HP atau No Meter PLN)
    let target = null;
    let targetType = 'phone';

    // Cari format No Meter PLN (10 - 12 digit)
    const plnMatch = lower.match(/\b(1[1-9]\d{8,11}|\d{10,12})\b/);
    // Cari format No HP (08xx / 628xx, 10 - 13 digit)
    const phoneMatch = lower.match(/\b(08\d{8,11}|628\d{8,12})\b/);

    // 2. Deteksi Kategori & Brand
    let category = null; // 'Pulsa', 'Data', 'PLN', 'E-Money'
    let brand = null;

    if (/\b(pln|token|listrik|stroom)\b/.test(lower)) {
        category = 'PLN';
        brand = 'PLN';
        if (plnMatch) {
            target = plnMatch[0];
            targetType = 'pln';
        } else if (phoneMatch) {
            target = phoneMatch[0];
            targetType = 'pln';
        }
    } else if (/\b(dana)\b/.test(lower)) {
        category = 'E-Money';
        brand = 'DANA';
    } else if (/\b(gopay|go-pay|gojek)\b/.test(lower)) {
        category = 'E-Money';
        brand = 'GO PAY';
    } else if (/\b(ovo)\b/.test(lower)) {
        category = 'E-Money';
        brand = 'OVO';
    } else if (/\b(shopeepay|shopee|spay)\b/.test(lower)) {
        category = 'E-Money';
        brand = 'SHOPEEPAY';
    } else if (/\b(linkaja|link-aja)\b/.test(lower)) {
        category = 'E-Money';
        brand = 'LINKAJA';
    } else if (/\b(data|paket\s*data|kuota|internet)\b/.test(lower)) {
        category = 'Data';
    } else if (/\b(pulsa|pulsa\s*reguler)\b/.test(lower)) {
        category = 'Pulsa';
    }

    // Jika target belum didapat dan bukan PLN, prioritaskan phoneMatch
    if (!target && phoneMatch) {
        target = phoneMatch[0];
        targetType = 'phone';
    }

    // Jika target belum ditemukan sama sekali, ini bukan order
    if (!target) return null;

    // Deteksi Brand Telco jika belum ada
    if (!brand && category !== 'PLN' && category !== 'E-Money') {
        if (/\b(telkomsel|tsel|simpati|kartuas)\b/.test(lower)) brand = 'TELKOMSEL';
        else if (/\b(indosat|isat|im3|mentari)\b/.test(lower)) brand = 'INDOSAT';
        else if (/\b(xl|axiata)\b/.test(lower)) brand = 'XL';
        else if (/\b(axis)\b/.test(lower)) brand = 'AXIS';
        else if (/\b(tri|three)\b/.test(lower)) brand = 'TRI';
        else if (/\b(smartfren|smart)\b/.test(lower)) brand = 'SMARTFREN';
        else if (targetType === 'phone') {
            brand = detectProviderFromPhone(target);
        }
    }

    // Default category ke Pulsa jika ada nomor HP dan brand Telco terdeteksi
    if (!category && brand && ['TELKOMSEL', 'INDOSAT', 'XL', 'AXIS', 'TRI', 'SMARTFREN'].includes(brand)) {
        category = 'Pulsa';
    }

    // 3. Ekstraksi Denominasi / Nominal
    let nominal = null;
    let dataQuota = null;

    // Pola: 5k, 10k, 20k, 25k, 50k, 100k, 5rb, 10rb, 20rb, 50rb, 100rb
    const kMatch = lower.match(/\b(\d+)\s*(k|rb|ribu)\b/);
    if (kMatch) {
        nominal = parseInt(kMatch[1], 10) * 1000;
    } else {
        // Pola angka langsung: 5000, 10000, 20000, 25000, 50000, 100000
        const directNomMatch = lower.match(/\b(5000|10000|15000|20000|25000|30000|50000|100000|150000|200000)\b/);
        if (directNomMatch) {
            nominal = parseInt(directNomMatch[1], 10);
        } else {
            // Pola kuota gigabyte: 1gb, 2gb, 5gb, 10gb
            const gbMatch = lower.match(/\b(\d+)\s*(gb|gigabyte)\b/);
            if (gbMatch) {
                dataQuota = gbMatch[1] + 'gb';
                category = 'Data';
            }
        }
    }

    // Jika tidak ada nominal maupun data quota yang terdeteksi, batalkan
    if (!nominal && !dataQuota) return null;

    // Pastikan ada brand dan category
    if (!brand || !category) return null;

    // 4. Pencocokan Produk di Katalog PPOB
    const candidates = ppobCatalog.filter(p => {
        if (!p.buyer_sku_code && !p.sku) return false;
        // Hanya produk aktif
        if (p.buyer_product_status === false || p.seller_product_status === false) return false;

        // Cocokkan brand
        const pBrand = String(p.brand || '').toUpperCase();
        if (!pBrand.includes(brand)) return false;

        // Cocokkan kategori
        const pCat = String(p.kategori || '').toLowerCase();
        if (category === 'Pulsa' && !pCat.includes('pulsa')) return false;
        if (category === 'Data' && !pCat.includes('data')) return false;
        if (category === 'PLN' && !pCat.includes('pln')) return false;
        if (category === 'E-Money' && !pCat.includes('e-money') && !pCat.includes('wallet')) return false;

        return true;
    });

    if (candidates.length === 0) return null;

    // Filter kandidat terbaik berdasarkan nominal atau kuota
    let bestProduct = null;

    if (nominal) {
        // Cari produk dengan nominal yang cocok
        // Di Digiflazz, nominal biasanya ada di product_name atau buyer_sku_code (misal "TL10" -> 10000)
        const matchedNom = candidates.filter(p => {
            const name = String(p.product_name || p.nama || '').toLowerCase();
            const sku = String(p.buyer_sku_code || p.sku || '').toLowerCase();
            
            // Format ribuan di nama produk: "10.000" atau "10000" atau "10 rb"
            const nomStr1 = nominal.toLocaleString('id-ID'); // "10.000"
            const nomStr2 = String(nominal); // "10000"
            const nomK = (nominal / 1000) + 'k'; // "10k"
            const nomRb = (nominal / 1000) + 'rb'; // "10rb"

            return name.includes(nomStr1) || name.includes(nomStr2) || name.includes(nomK) || name.includes(nomRb) || sku.endsWith(String(nominal / 1000));
        });

        if (matchedNom.length > 0) {
            // Urutkan harga termurah
            matchedNom.sort((a, b) => (Number(a.hargaJual || a.price || 0)) - (Number(b.hargaJual || b.price || 0)));
            bestProduct = matchedNom[0];
        }
    } else if (dataQuota) {
        const matchedQuota = candidates.filter(p => {
            const name = String(p.product_name || p.nama || '').toLowerCase();
            return name.includes(dataQuota);
        });

        if (matchedQuota.length > 0) {
            matchedQuota.sort((a, b) => (Number(a.hargaJual || a.price || 0)) - (Number(b.hargaJual || b.price || 0)));
            bestProduct = matchedQuota[0];
        }
    }

    // Jika belum ketemu, cari kandidat harga jual yang paling mendekati nominal
    if (!bestProduct && nominal) {
        const sortedByPriceDiff = [...candidates].sort((a, b) => {
            const diffA = Math.abs((Number(a.price || 0)) - nominal);
            const diffB = Math.abs((Number(b.price || 0)) - nominal);
            return diffA - diffB;
        });

        if (sortedByPriceDiff.length > 0 && Math.abs((Number(sortedByPriceDiff[0].price || 0)) - nominal) <= (nominal * 0.15)) {
            bestProduct = sortedByPriceDiff[0];
        }
    }

    if (!bestProduct) return null;

    // Normalisasi target nomor HP
    let cleanTarget = target;
    if (targetType === 'phone' && cleanTarget.startsWith('62')) {
        cleanTarget = '0' + cleanTarget.slice(2);
    }

    return {
        matched: true,
        category,
        brand,
        target: cleanTarget,
        targetType,
        nominal,
        product: {
            sku: bestProduct.buyer_sku_code || bestProduct.sku,
            nama: bestProduct.product_name || bestProduct.nama || bestProduct.name,
            kategori: bestProduct.kategori || category,
            brand: bestProduct.brand || brand,
            price: Number(bestProduct.price || 0),
            hargaJual: Number(bestProduct.hargaJual || bestProduct.price || 0)
        }
    };
}

module.exports = {
    parseQuickOrder,
    detectProviderFromPhone
};
