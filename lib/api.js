const crypto = require('crypto');
const config = require('../config');
const db = require('../database/db');

const getDigiSign = (ref) => crypto.createHash('md5').update(config.digiflazz.username + config.digiflazz.key + ref).digest('hex');

async function cekSaldoDigi() {
    try {
        const sign = getDigiSign("depo");
        const req = await fetch('https://api.digiflazz.com/v1/cek-saldo', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: "deposit", username: config.digiflazz.username, sign: sign })
        });
        const res = await req.json();
        return res.data ? res.data.deposit : 'Error';
    } catch(e) { return 'Error'; }
}

async function pullAllDigiPrepaid() {
    try {
        const sign = getDigiSign("pricelist");
        const req = await fetch('https://api.digiflazz.com/v1/price-list', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: "prepaid", username: config.digiflazz.username, sign: sign })
        });
        const res = await req.json();
        if (!res.data || !Array.isArray(res.data)) {
            console.error('[DIGIFLAZZ PRICELIST ERROR]', res);
            return false;
        }

        const targetCats = [
            { key: 'pulsa', label: 'Pulsa', markup: config.profit.pulsa },
            { key: 'data', label: 'Data', markup: config.profit.data },
            { key: 'emoney', label: 'E-Money', markup: config.profit.emoney },
            { key: 'pln', label: 'PLN', markup: config.profit.pln }
        ];

        const targetLabels = targetCats.map(t => t.label);
        // Hapus produk lama dari kategori yang akan di-update
        db.ppob = db.ppob.filter(p => !targetLabels.includes(p.kategori));

        const counts = { pulsa: 0, data: 0, emoney: 0, pln: 0 };

        res.data.forEach(p => {
            if (p.buyer_product_status !== true || p.seller_product_status !== true) return;

            const pCatLower = String(p.category || '').toLowerCase().replace(/[^a-z]/g, '');
            const matched = targetCats.find(t => t.label.toLowerCase().replace(/[^a-z]/g, '') === pCatLower);
            if (!matched) return;

            const markup = matched.markup || 0;
            db.ppob.push({
                sku: p.buyer_sku_code,
                nama: p.product_name,
                hargaModal: p.price,
                hargaJual: p.price + markup + (
                    p.price <= 25000
                        ? config.profitTier.kecil
                        : p.price <= 100000
                            ? config.profitTier.sedang
                            : p.price <= 300000
                                ? config.profitTier.besar
                                : config.profitTier.premium
                ),
                brand: (p.brand || '').toUpperCase(),
                kategori: matched.label,
                tipe: p.type || 'Umum'
            });
            counts[matched.key]++;
        });

        db.savePpob();
        return counts;
    } catch (e) {
        console.error('[DIGIFLAZZ PREPAID SYNC EXCEPTION]', e.message);
        return false;
    }
}

async function pullDigiProducts(kategori) {
    try {
        const counts = await pullAllDigiPrepaid();
        if (!counts) return false;
        const norm = String(kategori || '').toLowerCase().replace(/[^a-z]/g, '');
        return typeof counts[norm] === 'number' ? counts[norm] : false;
    } catch (e) {
        return false;
    }
}

async function hitDigiflazz(sku, target, orderId) {
    const sign = getDigiSign(orderId);
    try {
        const req = await fetch('https://api.digiflazz.com/v1/transaction', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: config.digiflazz.username, buyer_sku_code: sku, customer_no: target, ref_id: orderId, sign: sign })
        });
        const hasil = await req.json();
        console.log('[DIGIFLAZZ RESPONSE]', hasil?.data?.status || 'No status', hasil?.data?.message ? `(${hasil.data.message})` : '');
        return hasil;
    } catch(e) { 
        console.error('[DIGIFLAZZ ERROR]', e.message);
        return null; 
    }
}

// ===================================
// PAYMENT GATEWAYS (PAYMENTKITA & PAKASIR)
// ===================================

async function createQrisPaymentKita(orderId, amount) {
    try {
        const req = await fetch(
            `https://api.paymentkita.com/v1/order?merchant=${config.paymentkita.merchantId}&secret=${config.paymentkita.secret}&ref_id=${orderId}&nominal=${amount}&metode=QRISREALTIME`
        );
        const hasil = await req.json();
        console.log('[PAYMENTKITA RESPONSE]', hasil?.status || 'No status');
        return hasil;
    } catch (e) {
        console.error('[PAYMENTKITA ERROR]', e.message);
        return null;
    }
}

async function checkQrisPaymentKita(orderId) {
    try {
        const sig = crypto.createHash('md5').update(config.paymentkita.merchantId + ':' + config.paymentkita.secret).digest('hex');
        const req = await fetch(
            `https://api.paymentkita.com/v1/check-order?merchant_id=${config.paymentkita.merchantId}&secret=${config.paymentkita.secret}&signature=${sig}&ref_id=${orderId}`
        );
        const data = await req.json();
        if (data && data.data && (data.data.status === 'Success' || data.data.status === 'PAID')) {
            return 'PAID';
        }
        return 'UNPAID';
    } catch (e) {
        console.error('[PAYMENTKITA CHECK ERROR]', e.message);
        return 'ERROR';
    }
}

async function createQrisPakasir(orderId, amount) {
    try {
        const req = await fetch('https://app.pakasir.com/api/transactioncreate/qris', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                project: config.pakasir.project,
                order_id: orderId,
                amount: amount,
                api_key: config.pakasir.key
            })
        });
        const hasil = await req.json();
        console.log('[PAKASIR RESPONSE]', hasil?.status || 'No status');
        if (!hasil) return null;

        // Normalisasi format respon seragam
        const qrString = hasil.data?.qr_string || hasil.payment?.payment_number || hasil.payment_number || hasil.qr_string || hasil.data?.payment_number;
        const totalBayar = hasil.data?.total_bayar || hasil.payment?.total_payment || hasil.total_payment || amount;
        const expiredAt = hasil.data?.expired_at || hasil.payment?.expired_at || '5 Menit';

        if (qrString) {
            return {
                status: 'Success',
                data: {
                    total_bayar: Number(totalBayar) || amount,
                    qr_string: qrString,
                    expired_at: expiredAt
                }
            };
        }

        if (hasil.status === 'Success' && hasil.data) return hasil;
        return hasil;
    } catch (e) {
        console.error('[PAKASIR ERROR]', e.message);
        return null;
    }
}

async function checkQrisPakasir(orderId, amount) {
    try {
        const req = await fetch(
            `https://app.pakasir.com/api/transactiondetail?project=${config.pakasir.project}&amount=${amount}&order_id=${orderId}&api_key=${config.pakasir.key}`
        );
        const data = await req.json();
        if (data && (
            (data.transaction && (data.transaction.status === 'completed' || data.transaction.status === 'PAID' || data.transaction.status === 'Success')) ||
            data.status === 'completed' ||
            data.status === 'PAID' ||
            data.status === 'Success'
        )) {
            return 'PAID';
        }
        return 'UNPAID';
    } catch (e) {
        console.error('[PAKASIR CHECK ERROR]', e.message);
        return 'ERROR';
    }
}

async function createQris(orderId, amount) {
    const gw = (config.paymentGateway || 'paymentkita').toLowerCase();
    if (gw === 'pakasir') {
        return await createQrisPakasir(orderId, amount);
    }
    return await createQrisPaymentKita(orderId, amount);
}

async function checkQris(orderId, amount) {
    const gw = (config.paymentGateway || 'paymentkita').toLowerCase();
    if (gw === 'pakasir') {
        return await checkQrisPakasir(orderId, amount);
    }
    return await checkQrisPaymentKita(orderId);
}

module.exports = { 
    cekSaldoDigi, 
    pullDigiProducts, 
    pullAllDigiPrepaid,
    hitDigiflazz, 
    createQris, 
    checkQris,
    createQrisPakasir,
    checkQrisPakasir,
    createQrisPaymentKita,
    checkQrisPaymentKita
};

// ===================================
// CHECK DIGIFLAZZ STATUS
// ===================================
async function checkDigiflazz(ref_id) {

    try {

        const axios = require('axios');
        const crypto = require('crypto');

        const username = config.digiflazz.username;
        const apiKey = config.digiflazz.key;

        const sign = crypto
            .createHash('md5')
            .update(username + apiKey + ref_id)
            .digest('hex');

        const response = await axios.post(
            'https://api.digiflazz.com/v1/transaction',
            {
                cmd: 'status',
                username,
                buyer_sku_code: '',
                customer_no: '',
                ref_id,
                sign
            }
        );

        return response.data.data;

    } catch (err) {

        console.error(
            '[CHECK DIGIFLAZZ ERROR]',
            err.message
        );

        return null;
    }
}

module.exports.checkDigiflazz = checkDigiflazz;


// ===================================
// DIGIFLAZZ POSTPAID
// ===================================
async function pullDigiPostpaid() {
    try {
        const axios = require('axios');
        const crypto = require('crypto');

        const username = config.digiflazz.username;
        const apiKey = config.digiflazz.key;

        const sign = crypto
            .createHash('md5')
            .update(username + apiKey + 'pricelist')
            .digest('hex');

        const response = await axios.post(
            'https://api.digiflazz.com/v1/price-list',
            {
                cmd: 'pasca',
                username,
                sign
            }
        );

        const raw = response.data?.data || [];

        const filtered = raw.filter(
            p => String(p.category || '').toLowerCase() === 'pascabayar'
        );

        db.postpaid = filtered.map(p => ({
            sku: p.buyer_sku_code,
            name: p.product_name,
            category: p.category,
            brand: p.brand,
            type: 'postpaid',
            admin: parseInt(p.admin || 0),
            komisi: parseInt(p.commission || 0),
            is_active:
                p.buyer_product_status &&
                p.seller_product_status
                    ? 1
                    : 0,
            desc: p.desc || ''
        }));

        db.savePostpaid();

        return db.postpaid.length;
    } catch (err) {
        console.log(
            '[POSTPAID ERROR]',
            err.response?.data || err.message
        );
        return false;
    }
}

module.exports.pullDigiPostpaid = pullDigiPostpaid;

