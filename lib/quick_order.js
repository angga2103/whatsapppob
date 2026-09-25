/**
 * Smart Natural Language Quick-Order Parser v2.1
 * Mendukung format pesan teks bebas pelanggan dengan urutan kata APA SAJA (Bebas Bolak-Balik).
 * Mendukung filter durasi / masa aktif: 3hari, 30hari, 7hari, 1hari, 14hari, bulanan, mingguan, harian.
 * Serta mampu menebak dan mengarahkan jika input belum lengkap atau ambigu.
 */

const { formatRupiah, detectOperator } = require('./utils');

// Prefix Provider Indonesia untuk deteksi cepat
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
    const detected = PREFIX_MAP[prefix4] || (detectOperator ? detectOperator(clean) : null);
    return (detected && detected !== 'UNKNOWN') ? detected : null;
}

/**
 * Parsing teks bebas menjadi entitas order cerdas dan dinamis
 * @param {string} text - Pesan dari user
 * @param {Array} ppobCatalog - db.ppob katalog
 * @returns {Object|null}
 */
function parseQuickOrder(text, ppobCatalog = []) {
    if (!text || typeof text !== 'string') return null;

    const raw = text.trim();
    // Abaikan pesan jika terlalu panjang atau diawali tanda command sistem (. / ! #)
    if (raw.length > 150 || /^[./!#]/.test(raw)) return null;

    const lower = raw.toLowerCase().replace(/,/g, ' ');

    // 0. Cek Percakapan Panduan / Niat Transaksi Ambigu
    const isConversationalIntent = /\b(mau|cara|pengen|tolong|bisa|gimana|bagaimana)\s*(beli|isi|order|transaksi|topup|top\s*up)\b|\b(isi|beli|topup|top\s*up)\s*(pulsa|kuota|data|token|listrik|dana|gopay|ovo|shopee|spay)\b/i.test(lower);

    // 1. Ekstraksi Target (No HP atau No Meter PLN)
    let target = null;
    let targetType = null;

    // Cek konteks PLN
    const isPlnContext = /\b(pln|token|listrik|stroom)\b/i.test(lower);

    // Format No Meter PLN (11 - 12 digit)
    const plnMatch = lower.match(/\b(1\d{10,11}|\d{11,12})\b/);
    // Format No HP (08xx / 628xx, 10 - 13 digit)
    const phoneMatch = lower.match(/\b(08\d{8,12}|628\d{8,12})\b/);

    if (isPlnContext && plnMatch) {
        target = plnMatch[0];
        targetType = 'pln';
    } else if (phoneMatch) {
        let clean = phoneMatch[0];
        if (clean.startsWith('62')) clean = '0' + clean.slice(2);
        target = clean;
        targetType = 'phone';
    } else if (plnMatch) {
        target = plnMatch[0];
        targetType = 'pln';
    }

    // 2. Ekstraksi Kategori & Brand
    let category = null;
    let brand = null;

    if (isPlnContext) {
        category = 'PLN';
        brand = 'PLN';
    } else if (/\b(dana)\b/i.test(lower)) {
        category = 'E-Money';
        brand = 'DANA';
    } else if (/\b(gopay|go-pay|gojek)\b/i.test(lower)) {
        category = 'E-Money';
        brand = 'GO PAY';
    } else if (/\b(ovo)\b/i.test(lower)) {
        category = 'E-Money';
        brand = 'OVO';
    } else if (/\b(shopeepay|shopee|spay)\b/i.test(lower)) {
        category = 'E-Money';
        brand = 'SHOPEE PAY';
    } else if (/\b(linkaja|link-aja)\b/i.test(lower)) {
        category = 'E-Money';
        brand = 'LINKAJA';
    } else if (/\b(data|kuota|kouta|paket\s*data|paket\s*internet|internet)\b/i.test(lower)) {
        category = 'Data';
    } else if (/\b(pulsa|pulsa\s*reguler|pls|pulza)\b/i.test(lower)) {
        category = 'Pulsa';
    }

    // Deteksi Brand Telco Eksplisit
    if (!brand && category !== 'PLN' && category !== 'E-Money') {
        if (/\b(telkomsel|tsel|simpati|kartuas|halo)\b/i.test(lower)) brand = 'TELKOMSEL';
        else if (/\b(indosat|isat|im3|mentari|ioh)\b/i.test(lower)) brand = 'INDOSAT';
        else if (/\b(xl|axiata)\b/i.test(lower)) brand = 'XL';
        else if (/\b(axis)\b/i.test(lower)) brand = 'AXIS';
        else if (/\b(tri|three|3)\b/i.test(lower)) brand = 'TRI';
        else if (/\b(smartfren|smart|sf)\b/i.test(lower)) brand = 'SMARTFREN';
        else if (/\b(byu|by\.u|by\s*u)\b/i.test(lower)) brand = 'BY.U';
    }

    // Deteksi Brand Telco dari Awalan Nomor HP jika belum ada brand
    if (!brand && targetType === 'phone') {
        brand = detectProviderFromPhone(target);
    }

    // 3. Ekstraksi Denominasi / Nominal / Kuota / Masa Aktif
    // Bersihkan target dari string agar digit target tidak disangka nominal
    let cleanText = lower;
    if (target) {
        cleanText = cleanText.replace(target, ' ');
    }

    let nominal = null;
    let quotaVal = null;
    let quotaUnit = null;
    let validityDays = null;
    let validityText = null;

    // A. Cek Kuota (misal: 25gb, 50 gb, 500mb, 1.5gb, 1,5 gb)
    const quotaMatch = cleanText.match(/(?:^|[^0-9])(\d+(?:[.,]\d+)?)\s*(gb|gigabyte|mb|megabyte)(?:$|[^a-z0-9])/i);
    if (quotaMatch) {
        quotaVal = parseFloat(quotaMatch[1].replace(',', '.'));
        quotaUnit = quotaMatch[2].toLowerCase().startsWith('g') ? 'GB' : 'MB';
        category = 'Data';
    }

    // B. Cek Masa Aktif / Durasi (misal: 3hari, 30hari, 7hari, 1hari, 14hari, bulanan, mingguan, harian)
    const validityMatch = cleanText.match(/(?:^|[^0-9])(\d+)\s*(hari|hr|h|bulan|bln)(?:$|[^a-z0-9])/i);
    if (validityMatch) {
        let val = parseInt(validityMatch[1], 10);
        const unit = validityMatch[2].toLowerCase();
        if (unit.startsWith('bul') || unit.startsWith('bln')) val *= 30;
        validityDays = val;
        validityText = val + ' Hari';
        category = 'Data';
    } else if (/\b(bulanan)\b/i.test(cleanText)) {
        validityDays = 30;
        validityText = '30 Hari';
        category = 'Data';
    } else if (/\b(mingguan)\b/i.test(cleanText)) {
        validityDays = 7;
        validityText = '7 Hari';
        category = 'Data';
    } else if (/\b(harian)\b/i.test(cleanText)) {
        validityDays = 1;
        validityText = '1 Hari';
        category = 'Data';
    }

    // C. Cek Nominal dengan akhiran k / rb / ribu (misal: 5k, 10k, 50rb, 100 ribu)
    const kMatch = cleanText.match(/(?:^|[^0-9])(\d+)\s*(k|rb|ribu)(?:$|[^a-z0-9])/i);
    if (kMatch) {
        nominal = parseInt(kMatch[1], 10) * 1000;
    } else {
        // Cek format Rp (misal: Rp 10.000 atau Rp50000)
        const rpMatch = cleanText.match(/\brp\.?\s*(\d{1,3}(?:\.\d{3})+|\d+)\b/i);
        if (rpMatch) {
            nominal = parseInt(rpMatch[1].replace(/\./g, ''), 10);
        } else {
            // Cek nominal langsung (5000, 10000, 20000, 25000, 50000, 100000, dst)
            const directMatch = cleanText.match(/\b(1000|2000|3000|5000|10000|15000|20000|25000|30000|40000|50000|60000|70000|75000|80000|90000|100000|150000|200000|300000|500000|1000000)\b/);
            if (directMatch) {
                nominal = parseInt(directMatch[1], 10);
            } else {
                // Shorthand: jika ada pulsa/token dan angka tunggal 5, 10, 15, 20, 25, 50, 100
                const shortMatch = cleanText.match(/(?:^|\s)(5|10|15|20|25|30|50|75|100)(?:\s|$)/);
                if (shortMatch && (category === 'Pulsa' || category === 'PLN' || brand)) {
                    nominal = parseInt(shortMatch[1], 10) * 1000;
                }
            }
        }
    }

    // Default kategori ke Pulsa jika ada nomor HP + nominal tapi tidak menyebut 'data', kuota, atau hari
    if (!category && targetType === 'phone' && nominal && brand && brand !== 'PLN' && !validityDays) {
        category = 'Pulsa';
    }

    // ========================================
    // 🧠 LOGIKA PANDUAN, TEBAKAN & PENCOCOKAN CERDAS
    // ========================================

    // KASUS 1: Hanya ada Nomor HP Tujuan (Belum pilih Pulsa / Data / Nominal / Durasi)
    if (target && targetType === 'phone' && !nominal && !quotaVal && !validityDays && !category) {
        return {
            type: 'NEED_PRODUCT',
            matched: false,
            target,
            targetType,
            brand: brand || detectProviderFromPhone(target) || 'Operator Seluler',
            message: `💡 *Nomor Tujuan Terdeteksi:* \`${target}\` (${brand || 'Operator Seluler'})\n\n` +
                     `Silakan pilih produk yang ingin dibeli:\n` +
                     `👉 Balas *1* untuk *Pulsa Reguler*\n` +
                     `👉 Balas *2* untuk *Paket Kuota Internet*\n\n` +
                     `Atau langsung ketik nominal/hari, contoh:\n` +
                     `• \`pulsa ${target} 10k\`\n` +
                     `• \`data ${target} 25gb\`\n` +
                     `• \`data ${target} 30hari\``
        };
    }

    // KASUS 2: Produk / Nominal / Durasi Terdeteksi, tapi Nomor Tujuan BELUM ADA
    if (!target && (nominal || quotaVal || validityDays) && (category || brand)) {
        return {
            type: 'NEED_TARGET',
            matched: false,
            category: category || 'Pulsa',
            brand,
            nominal,
            quotaVal,
            quotaUnit,
            validityDays,
            validityText,
            message: `💡 *Pesanan Terdeteksi:* *${brand ? brand + ' ' : ''}${category || 'Produk'}${quotaVal ? ' ' + quotaVal + quotaUnit : (validityText ? ' ' + validityText : (nominal ? ' ' + formatRupiah(nominal) : ''))}*\n\n` +
                     `Tinggal 1 langkah lagi! Masukkan *Nomor Tujuan Anda*:\n` +
                     `${category === 'PLN' ? '_Ketik Nomor Meteran PLN (11-12 digit)_' : '_Ketik Nomor HP: 08123456789_'}\n\n` +
                     `_Tips: Anda juga bisa mengetik langsung nomor tujuan dan nominalnya sekaligus._`
        };
    }

    // KASUS 3: Kalimat Niat Transaksi Tapi Format Belum Terstruktur
    if (!target && !nominal && !quotaVal && !validityDays && isConversationalIntent) {
        return {
            type: 'GUIDE',
            matched: false,
            message: `🤖 *FORMAT ORDER CEPAT (BEBAS URUTAN):*\n\n` +
                     `Anda dapat langsung mengetik pesanan tanpa harus buka menu. Bot otomatis paham urutan kata apa saja:\n\n` +
                     `📱 *Pulsa:* \`pulsa tsel 10k 081234567890\` atau \`081234567890 10k\`\n` +
                     `📶 *Paket Data:* \`data 081234567890 25gb\` atau \`081234567890 data 30hari\`\n` +
                     `⚡ *Token Listrik:* \`token pln 50rb 141234567890\`\n` +
                     `💸 *E-Money:* \`dana 20k 081234567890\`\n\n` +
                     `Ketik *MENU* untuk melihat daftar semua menu layanan.`
        };
    }

    // Jika tidak ada target atau tidak ada nominal/kuota/validity/kategori, batalkan
    if (!target || (!nominal && !quotaVal && !validityDays && category !== 'Data')) return null;

    // Default brand jika masih kosong dan target adalah phone
    if (!brand && targetType === 'phone') {
        brand = detectProviderFromPhone(target);
    }
    if (!brand || !category) return null;

    // 4. Pencarian Produk di Katalog PPOB (db.ppob)
    let pool = ppobCatalog.filter(p => {
        if (!p.sku || !p.nama) return false;
        // Exclude inquiry cek nama
        if (p.nama.toLowerCase().includes('cek ') || p.sku.toLowerCase().includes('cek')) return false;
        if (p.kategori !== category) return false;

        const pBrand = String(p.brand || '').toUpperCase();
        if (brand === 'SHOPEE PAY' && pBrand === 'SHOPEE PAY') return true;
        if (brand === 'GO PAY' && pBrand === 'GO PAY') return true;
        if (brand === 'PLN' && (pBrand === 'PLN' || p.kategori === 'PLN')) return true;
        return pBrand.includes(brand);
    });

    if (pool.length === 0) return null;

    let bestProduct = null;
    let suggestions = [];

    // ==================== A. PULSA, PLN, E-MONEY ====================
    if (category === 'Pulsa' || category === 'PLN' || category === 'E-Money') {
        if (!nominal) return null;

        const nomFormatted = nominal.toLocaleString('id-ID'); // "10.000"
        const nomRaw = String(nominal); // "10000"
        const nomK = (nominal / 1000) + 'k';
        const nomRb = (nominal / 1000) + 'rb';

        let exactMatches = pool.filter(p => {
            const n = p.nama.toLowerCase();
            return n.includes(nomFormatted) || n.includes(nomRaw) || n.includes(nomK) || n.includes(nomRb) || p.sku.toLowerCase().endsWith(String(nominal / 1000));
        });

        if (exactMatches.length > 0) {
            exactMatches.sort((a, b) => (Number(a.hargaJual || 0)) - (Number(b.hargaJual || 0)));
            bestProduct = exactMatches[0];
        } else {
            // Fallback harga terdekat jika nominal pas tidak ada (toleransi 10%)
            const sortedByPrice = [...pool].sort((a, b) => Math.abs((Number(a.hargaJual || 0)) - nominal) - Math.abs((Number(b.hargaJual || 0)) - nominal));
            if (sortedByPrice.length > 0 && Math.abs((Number(sortedByPrice[0].hargaJual || 0)) - nominal) <= (nominal * 0.15)) {
                bestProduct = sortedByPrice[0];
            }
        }
    }

    // ==================== B. PAKET DATA INTERNET ====================
    if (category === 'Data') {
        const extraVal = validityDays === 30 ? 'bulanan' : validityDays === 7 ? 'mingguan' : validityDays === 1 ? 'harian' : 'NOMATCH_EXTRA';
        const valRegex = validityDays ? new RegExp('(\\b' + validityDays + '\\s*(?:hari|hr)\\b|\\b' + extraVal + '\\b)', 'i') : null;

        // Subkasus 1: Ada Kuota (dan opsional durasi)
        if (quotaVal) {
            const regex = new RegExp('(^|[^0-9])' + quotaVal + '\\s*' + (quotaUnit || 'gb') + '($|[^a-z0-9])', 'i');
            let matchedQuota = pool.filter(p => regex.test(p.nama));

            if (valRegex && matchedQuota.some(p => valRegex.test(p.nama))) {
                matchedQuota = matchedQuota.filter(p => valRegex.test(p.nama));
            }

            if (matchedQuota.length > 0) {
                matchedQuota.sort((a, b) => (Number(a.hargaJual || 0)) - (Number(b.hargaJual || 0)));
                bestProduct = matchedQuota[0];
            } else {
                // Saran paket data terdekat berdasarkan angka GB
                const withQuota = pool.map(p => {
                    const m = p.nama.match(/(?:^|[^0-9])(\d+(?:[.,]\d+)?)\s*gb(?:$|[^a-z0-9])/i);
                    const q = m ? parseFloat(m[1].replace(',', '.')) : null;
                    return { ...p, parsedQuota: q };
                }).filter(p => p.parsedQuota !== null);

                withQuota.sort((a, b) => Math.abs(a.parsedQuota - quotaVal) - Math.abs(b.parsedQuota - quotaVal));
                suggestions = withQuota.slice(0, 4);

                return {
                    type: 'SUGGESTIONS',
                    matched: false,
                    target,
                    targetType,
                    brand,
                    category: 'Data',
                    quotaVal,
                    quotaUnit,
                    validityDays,
                    validityText,
                    suggestions: suggestions.map(s => ({
                        sku: s.sku,
                        nama: s.nama,
                        kategori: 'Data',
                        brand: s.brand,
                        hargaJual: Number(s.hargaJual || 0)
                    }))
                };
            }
        } else if (validityDays) {
            // Subkasus 2: Ada Masa Aktif (Durasi), contoh: "data 08123654855 3hari" atau "0812362545525 30hari"
            let matchedValidity = pool.filter(p => valRegex.test(p.nama));

            if (nominal) {
                matchedValidity = matchedValidity.filter(p => {
                    const price = Number(p.hargaJual || 0);
                    return price >= nominal * 0.75 && price <= nominal * 1.25;
                });
            }

            if (matchedValidity.length > 0) {
                matchedValidity.sort((a, b) => (Number(a.hargaJual || 0)) - (Number(b.hargaJual || 0)));
                
                if (nominal && matchedValidity.length === 1) {
                    bestProduct = matchedValidity[0];
                } else {
                    return {
                        type: 'SUGGESTIONS',
                        matched: false,
                        target,
                        targetType,
                        brand,
                        category: 'Data',
                        validityDays,
                        validityText,
                        suggestions: matchedValidity.slice(0, 5).map(s => ({
                            sku: s.sku,
                            nama: s.nama,
                            kategori: 'Data',
                            brand: s.brand,
                            hargaJual: Number(s.hargaJual || 0)
                        }))
                    };
                }
            }
        } else if (nominal) {
            // Subkasus 3: Pencarian berdasarkan budget rupiah saja (contoh: "data 50k")
            const nomFormatted = nominal.toLocaleString('id-ID');
            let matchedBudget = pool.filter(p => {
                const n = p.nama.toLowerCase();
                const price = Number(p.hargaJual || 0);
                return n.includes(nomFormatted) || (price >= nominal * 0.75 && price <= nominal * 1.25);
            });

            if (matchedBudget.length > 0) {
                matchedBudget.sort((a, b) => Math.abs((Number(a.hargaJual || 0)) - nominal) - Math.abs((Number(b.hargaJual || 0)) - nominal));
                bestProduct = matchedBudget[0];
                suggestions = matchedBudget.slice(0, 3);
            }
        } else if (target) {
            // Subkasus 4: Hanya "data [nomor]" tanpa kuota/nominal/durasi (contoh: "data 081234567890")
            let popular = [...pool].sort((a, b) => (Number(a.hargaJual || 0)) - (Number(b.hargaJual || 0)));
            return {
                type: 'SUGGESTIONS',
                matched: false,
                target,
                targetType,
                brand,
                category: 'Data',
                suggestions: popular.slice(0, 5).map(s => ({
                    sku: s.sku,
                    nama: s.nama,
                    kategori: 'Data',
                    brand: s.brand,
                    hargaJual: Number(s.hargaJual || 0)
                }))
            };
        }
    }

    if (!bestProduct) {
        // Jika pencarian tidak menemukan produk pasti tetapi ada brand & target
        return {
            type: 'NEED_PRODUCT',
            matched: false,
            target,
            targetType,
            brand,
            message: `🤔 *Produk tidak ditemukan:* Tidak ada produk ${brand} ${category || ''} yang cocok dengan "${raw}".\n\n` +
                     `Ketik *MENU* untuk melihat katalog lengkap, atau coba contoh format:\n` +
                     `• \`pulsa ${target} 10k\`\n` +
                     `• \`data ${target} 25gb\`\n` +
                     `• \`data ${target} 30hari\``
        };
    }

    return {
        type: 'CONFIRM',
        matched: true,
        category,
        brand,
        target,
        targetType,
        nominal,
        quotaVal,
        quotaUnit,
        validityDays,
        validityText,
        product: {
            sku: bestProduct.sku,
            nama: bestProduct.nama,
            kategori: bestProduct.kategori || category,
            brand: bestProduct.brand || brand,
            hargaModal: Number(bestProduct.hargaModal || 0),
            hargaJual: Number(bestProduct.hargaJual || 0)
        }
    };
}

module.exports = {
    parseQuickOrder,
    detectProviderFromPhone
};
