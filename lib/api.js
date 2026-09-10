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

async function pullDigiProducts(kategori) {
    try {
        const sign = getDigiSign("pricelist");
        const req = await fetch('https://api.digiflazz.com/v1/price-list', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: "prepaid", username: config.digiflazz.username, sign: sign })
        });
        const res = await req.json();
        if (!res.data) return false;

        let markup = 0;
        let targetKategori = "";
        
        if (kategori === 'pulsa') { markup = config.profit.pulsa; targetKategori = "Pulsa"; }
        else if (kategori === 'data') { markup = config.profit.data; targetKategori = "Data"; }
        else if (kategori === 'emoney') { markup = config.profit.emoney; targetKategori = "E-Money"; }
        else if (kategori === 'pln') { markup = config.profit.pln; targetKategori = "PLN"; }
        else return false;

        // Filter produk aktif dan sesuai kategori
        const filtered = res.data.filter(p => p.category === targetKategori && p.buyer_product_status === true && p.seller_product_status === true);
        
        // Hapus data lama di db kategori ini, ganti dengan yang baru
        db.ppob = db.ppob.filter(p => p.kategori !== targetKategori);
        
        filtered.forEach(p => {
            db.ppob.push({
                sku: p.buyer_sku_code,
                nama: p.product_name,
                hargaModal: p.price,
                hargaJual: p.price + (
    p.price <= 25000
        ? config.profitTier.kecil
        : p.price <= 100000
            ? config.profitTier.sedang
            : p.price <= 300000
                ? config.profitTier.besar
                : config.profitTier.premium
),
                brand: p.brand.toUpperCase(),
                kategori: targetKategori,
                tipe: p.type // Umumnya 'Umum'
            });
        });
        db.savePpob();
        return filtered.length;
    } catch(e) { return false; }
}

async function hitDigiflazz(sku, target, orderId) {
    const sign = getDigiSign(orderId);
    try {
        const req = await fetch('https://api.digiflazz.com/v1/transaction', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: config.digiflazz.username, buyer_sku_code: sku, customer_no: target, ref_id: orderId, sign: sign })
        });
        const hasil = await req.json();
        console.log('[DIGIFLAZZ RESPONSE]', JSON.stringify(hasil));
        return hasil;
    } catch(e) { 
        console.error('[DIGIFLAZZ ERROR]', e.message);
        return null; 
    }
}

// FUNGSI PAKASIR
// PAYMENTKITA
async function createQris(orderId, amount) {
    try {
        const req = await fetch(
            `https://api.paymentkita.com/v1/order?merchant=${config.paymentkita.merchantId}&secret=${config.paymentkita.secret}&ref_id=${orderId}&nominal=${amount}&metode=QRISREALTIME`
        );

        const hasil = await req.json();
        console.log('[PAYMENTKITA RESPONSE]', JSON.stringify(hasil));
        return hasil;
    } catch (e) {
        console.log('[PAYMENTKITA ERROR]', e.message);
        return null;
    }
}

async function checkQris(orderId) {

    try {

        const req = await fetch(
            `https://api.paymentkita.com/v1/check-order?merchant_id=${config.paymentkita.merchantId}&secret=${config.paymentkita.secret}&signature=${require('crypto').createHash('md5').update(config.paymentkita.merchantId + ':' + config.paymentkita.secret).digest('hex')}&ref_id=${orderId}`
        );

        const data = await req.json();

        if (
            data &&
            data.data &&
            data.data.status === 'Success'
        ) {
            return 'PAID';
        }

        return 'UNPAID';

    } catch (e) {

        return 'ERROR';

    }
}

module.exports = { cekSaldoDigi, pullDigiProducts, hitDigiflazz, createQris, checkQris };

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

