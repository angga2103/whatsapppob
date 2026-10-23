const crypto = require('crypto');
const config = require('../config');
const db = require('../database/db');
const marginHelper = require('./margin');

const ipayService = require('./ipay');

const getDigiSign = (ref) => crypto.createHash('md5').update(config.digiflazz.username + config.digiflazz.key + ref).digest('hex');

async function cekSaldoDigi() {
    try {
        const username = config.digiflazz?.username;
        const apiKey = config.digiflazz?.key;
        if (!username || !apiKey) {
            return 'Kredensial Digiflazz Belum Diatur';
        }

        const sign = crypto.createHash('md5').update(username + apiKey + "depo").digest('hex');
        const req = await fetch('https://api.digiflazz.com/v1/cek-saldo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: "deposit", username: username, sign: sign }),
            signal: AbortSignal.timeout(10000)
        });

        if (!req.ok) {
            return `HTTP Error ${req.status}`;
        }

        const res = await req.json().catch(() => ({}));
        const data = res?.data;
        if (!data) {
            return 'Respons Digiflazz Kosong';
        }

        // Digiflazz API response pattern:
        // Sukses : { data: { deposit: 310088 } }
        // Gagal  : { data: { rc: '41', deposit: 0, message: 'Signature Anda salah' } }
        // Gagal  : { data: { rc: '42', deposit: 0, message: 'IP belum terdaftar di whitelist' } }
        if (data.rc !== undefined || data.message) {
            const msg = data.message || `Kode RC: ${data.rc}`;
            console.warn(`[DIGIFLAZZ SALDO ERROR] ${msg} (RC: ${data.rc})`);
            return `${msg}${data.rc ? ` (RC: ${data.rc})` : ''}`;
        }

        if (typeof data.deposit === 'number') {
            return Number(data.deposit);
        }

        return 'Format Saldo Tidak Dikenali';
    } catch (e) {
        console.error('[DIGIFLAZZ SALDO EXCEPTION]', e.message);
        return `Koneksi Timeout / Gagal (${e.message})`;
    }
}

async function cekSaldoProvider() {
    if (config.provider?.active === 'ipay') {
        return await ipayService.cekSaldoIpay();
    }
    return await cekSaldoDigi();
}

async function pullAllDigiPrepaid() {
    if (config.provider?.active === 'ipay') {
        return await ipayService.pullAllIpayProducts();
    }
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
            { key: 'pulsa', label: 'Pulsa' },
            { key: 'data', label: 'Data' },
            { key: 'emoney', label: 'E-Money' },
            { key: 'pln', label: 'PLN' }
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

            const sellingPrice = marginHelper.calculateSellingPrice(p.price);
            db.ppob.push({
                sku: p.buyer_sku_code,
                nama: p.product_name,
                hargaModal: p.price,
                hargaJual: sellingPrice,
                brand: (p.brand || '').toUpperCase(),
                kategori: matched.label,
                tipe: p.type || 'Umum',
                source: 'digiflazz'
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
    if (config.provider?.active === 'ipay') {
        return await ipayService.pullIpayProducts(kategori);
    }
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
    if (config.provider?.active === 'ipay') {
        return await ipayService.hitIpay(sku, target, orderId);
    }
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
// PAYMENT GATEWAY: DANA AUTO TRANSAKSI (0% FEE)
// ===================================
const qrisHelper = require('./qris');
const danaHelper = require('./dana');

async function createQris(orderId, amount) {
    try {
        const danaCfg = danaHelper.getDanaConfig();
        const baseNominal = Math.round(Number(amount) || 0);

        // Generate kode unik pintar anti-bentrok (10 - 150)
        const { code, total } = danaHelper.generateUniqueCode(baseNominal);

        // Generate string Dynamic QRIS standar EMVCo dengan nominal terkunci
        const dynamicQris = qrisHelper.generateDynamicQris(danaCfg.qrisString, total);

        console.log(`[DANA AUTO QRIS] Ref: ${orderId} | Pokok: Rp ${baseNominal.toLocaleString('id-ID')} | Unik: ${code} | Total: Rp ${total.toLocaleString('id-ID')}`);

        return {
            status: 'Success',
            data: {
                total_bayar: total,
                nominal_pokok: baseNominal,
                unique_code: code,
                qr_string: dynamicQris,
                dana_number: danaCfg.number,
                dana_name: danaCfg.name,
                expired_at: '5 Menit'
            }
        };
    } catch (e) {
        console.error('[DANA QRIS ERROR]', e.message);
        return null;
    }
}

async function checkQris(orderId, amount) {
    try {
        const db = require('../database/db');
        // Cek apakah order sudah diselesaikan oleh Webhook Notifikasi DANA
        if (Array.isArray(db.orders)) {
            const ord = db.orders.find(o => o.id === orderId);
            if (ord && (ord.status === 'paid' || ord.status === 'processing' || ord.status === 'success')) {
                return 'PAID';
            }
        }
        // Cek apakah tiket deposit sudah berhasil
        if (Array.isArray(db.deposits)) {
            const dep = db.deposits.find(d => d.id === orderId);
            if (dep && dep.status === 'success') {
                return 'PAID';
            }
        }
        return 'UNPAID';
    } catch (e) {
        console.error('[DANA CHECK ERROR]', e.message);
        return 'ERROR';
    }
}

async function cekSaldoGateway() {
    try {
        const devStatus = danaHelper.getDeviceStatus();
        return {
            balance: 'DANA Auto (0% Fee)',
            status: devStatus.isOnline ? 'Online' : 'Standby',
            battery: devStatus.battery,
            isOnline: devStatus.isOnline,
            lastPing: devStatus.lastPingStr
        };
    } catch (e) {
        return { balance: 'DANA Auto (0% Fee)', status: 'Standby' };
    }
}

module.exports = { 
    cekSaldoDigi, 
    cekSaldoProvider,
    pullDigiProducts, 
    pullAllDigiPrepaid,
    hitDigiflazz, 
    createQris, 
    checkQris,
    cekSaldoGateway
};

// ===================================
// CHECK PROVIDER STATUS (DIGIFLAZZ / IPAY)
// ===================================
async function checkDigiflazz(ref_id, sku = '', target = '') {
    if (config.provider?.active === 'ipay') {
        const check = await ipayService.checkStatusIpay(ref_id);
        if (check) {
            return {
                status: check.status,
                sn: check.sn,
                message: check.message,
                ref_id: ref_id
            };
        }
    }
    try {
        const username = config.digiflazz.username;
        const apiKey = config.digiflazz.key;

        const sign = crypto
            .createHash('md5')
            .update(username + apiKey + ref_id)
            .digest('hex');

        const payload = {
            username,
            buyer_sku_code: sku || '',
            customer_no: target || '',
            ref_id,
            sign
        };
        if (sku && (String(sku).toLowerCase().startsWith('post') || String(sku).toLowerCase().includes('pasca'))) {
            payload.commands = 'status-pasca';
        }

        const response = await fetch('https://api.digiflazz.com/v1/transaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const res = await response.json();
        return res?.data || res || null;
    } catch (err) {
        console.error('[CHECK DIGIFLAZZ ERROR]', err.message);
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

        const raw = response.data?.data;
        if (!Array.isArray(raw)) {
            console.log(
                '[POSTPAID NOTICE] Respon pricelist bukan array (rate limit / info: ' + (raw?.rc || 'unknown') + '):',
                raw?.message || response.data
            );
            return db.postpaid && db.postpaid.length > 0 ? db.postpaid.length : false;
        }

        const filtered = raw.filter(
            p => String(p.category || '').toLowerCase() === 'pascabayar'
        );

        if (filtered.length > 0) {
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
        }

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

