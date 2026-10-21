/**
 * EMVCo Dynamic QRIS Engine
 * Ported from GarudaTel/Satset-Pay for Bot PPOB (WhatsApp & Telegram)
 * Generates official EMVCo Dynamic QRIS with exact nominal & CRC16-CCITT checksum.
 */

const DEFAULT_DANA_QRIS_STRING = (
    "00020101021240560011ID.DANA.WWW01189360091531433862600215ANGGA DIAN PRAT" +
    "5204482953033605405101205802ID5924ANGGA DIAN PRATAMA PUTRA6011Kota Bekasi" +
    "61051279062460804DMCT9934000200012428101201202610205004486663049B67"
);

/**
 * Menghitung CRC16-CCITT standar EMVCo QRIS:
 * Polynomial: 0x1021, Initial value: 0xFFFF.
 * Returns 4-character uppercase hex string (e.g. '9B67').
 */
function crc16Ccitt(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            if (crc & 0x8000) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Mem-parsing string EMVCo TLV menjadi array [ [tag, val], ... ]
 */
function parseEmvcoQris(qrisStr) {
    let clean = String(qrisStr || '').trim();
    const pos63 = clean.lastIndexOf('6304');
    if (pos63 !== -1 && pos63 >= clean.length - 8) {
        clean = clean.slice(0, pos63);
    }
    const tags = [];
    let idx = 0;
    while (idx < clean.length) {
        if (idx + 4 > clean.length) break;
        const tag = clean.slice(idx, idx + 2);
        const len = parseInt(clean.slice(idx + 2, idx + 4), 10);
        if (isNaN(len)) break;
        const val = clean.slice(idx + 4, idx + 4 + len);
        tags.push([tag, val]);
        idx += 4 + len;
    }
    return tags;
}

/**
 * Mengubah Base QRIS Statis/Dinamis menjadi QRIS Dinamis spesifik nominal:
 * 1. Mengubah Tag 01 menjadi '12' (Dinamis).
 * 2. Menyisipkan/mengganti Tag 54 (Transaction Amount).
 * 3. Menghitung ulang Tag 63 (CRC16-CCITT).
 */
function generateDynamicQris(baseQris, amount) {
    if (typeof baseQris === 'number' && amount === undefined) {
        amount = baseQris;
        baseQris = null;
    }
    const rawBase = (typeof baseQris === 'string' && baseQris.trim().length > 30) ? baseQris.trim() : DEFAULT_DANA_QRIS_STRING;
    const amountInt = Math.round(Number(amount) || 0);
    if (amountInt <= 0) {
        throw new Error(`Nominal pembayaran QRIS harus lebih besar dari 0 (diberikan: ${amount})`);
    }

    const tags = parseEmvcoQris(rawBase);
    if (!tags || tags.length === 0) {
        throw new Error('Format string Base QRIS tidak valid');
    }

    const amtStr = String(amountInt);
    const newTags = [];
    let hasAmt = false;

    for (const [tag, val] of tags) {
        if (tag === '01') {
            newTags.push(['01', '12']);
        } else if (tag === '54') {
            newTags.push(['54', amtStr]);
            hasAmt = true;
        } else if ((tag === '58' || tag === '59') && !hasAmt) {
            newTags.push(['54', amtStr]);
            hasAmt = true;
            newTags.push([tag, val]);
        } else {
            newTags.push([tag, val]);
        }
    }

    if (!hasAmt) {
        newTags.push(['54', amtStr]);
    }

    let payload = '';
    for (const [tag, val] of newTags) {
        const lenStr = String(val.length).padStart(2, '0');
        payload += tag + lenStr + val;
    }

    payload += '6304';
    return payload + crc16Ccitt(payload);
}

/**
 * Validasi keabsahan QRIS berdasarkan CRC16
 */
function validateQris(qrisStr) {
    if (!qrisStr || qrisStr.length < 20) return false;
    const pos63 = qrisStr.lastIndexOf('6304');
    if (pos63 === -1 || qrisStr.length !== pos63 + 8) return false;
    const payload = qrisStr.slice(0, pos63 + 4);
    const expected = qrisStr.slice(pos63 + 4).toUpperCase();
    return crc16Ccitt(payload) === expected;
}

module.exports = {
    DEFAULT_DANA_QRIS_STRING,
    crc16Ccitt,
    parseEmvcoQris,
    generateDynamicQris,
    validateQris
};
