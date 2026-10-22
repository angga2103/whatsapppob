/**
 * ==============================================================================
 * 🚀 IPAY (GARUDATEL) H2H MERCHANT INTEGRATION SERVICE (lib/ipay.js)
 * Standar Host-to-Host (H2H) API Client untuk Bot PPOB WhatsApp & Telegram
 * Terintegrasi penuh dengan ekosistem GarudaTel (ipay.my.id)
 * ==============================================================================
 */

const crypto = require('crypto');
const config = require('../config');
const db = require('../database/db');
const marginHelper = require('./margin');

class IpayService {
    /**
     * Memuat konfigurasi aktif H2H iPay
     */
    static getIpayConfig() {
        return config.ipay;
    }

    /**
     * Cek apakah kredensial iPay sudah terisi lengkap
     */
    static isConfigured() {
        const cfg = this.getIpayConfig();
        return Boolean(cfg.apiKey && cfg.merchantId && cfg.secretKey);
    }

    /**
     * Menghasilkan signature MD5 anti-tamper sesuai standar GarudaTel
     * Format: md5(merchant_id + secret_key + ref_id)
     */
    static generateSignature(refId = '') {
        const cfg = this.getIpayConfig();
        const raw = String(cfg.merchantId || '') + String(cfg.secretKey || '') + String(refId || '');
        return crypto.createHash('md5').update(raw).digest('hex').toLowerCase();
    }

    /**
     * Header otentikasi resmi untuk request ke ipay.my.id
     */
    static getAuthHeaders() {
        const cfg = this.getIpayConfig();
        return {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-API-KEY': cfg.apiKey,
            'Authorization': `Bearer ${cfg.apiKey}`,
            'X-MERCHANT-ID': cfg.merchantId,
            'X-SECRET-KEY': cfg.secretKey,
            'User-Agent': 'Bot-PPOB-H2H/1.0'
        };
    }

    /**
     * Cek Saldo Akun Merchant H2H di iPay (GarudaTel)
     * Mengembalikan nominal saldo (Number) atau string pesan status
     */
    static async cekSaldoIpay() {
        try {
            const cfg = this.getIpayConfig();
            if (!this.isConfigured()) return 'Belum Diatur';

            const cleanBase = cfg.baseUrl.replace(/\/+$/, '');
            const sign = this.generateSignature('');

            // Coba metode GET terlebih dahulu
            const getUrl = `${cleanBase}/api/v1/profile/balance?merchant_id=${encodeURIComponent(cfg.merchantId)}&sign=${encodeURIComponent(sign)}`;
            let res;
            try {
                res = await fetch(getUrl, {
                    method: 'GET',
                    headers: this.getAuthHeaders(),
                    signal: AbortSignal.timeout(10000)
                });
            } catch (_) {}

            // Fallback ke POST jika GET gagal / 404
            if (!res || !res.ok) {
                res = await fetch(`${cleanBase}/api/v1/profile/balance`, {
                    method: 'POST',
                    headers: this.getAuthHeaders(),
                    body: JSON.stringify({
                        merchant_id: cfg.merchantId,
                        sign: sign
                    }),
                    signal: AbortSignal.timeout(10000)
                });
            }

            if (!res.ok) {
                console.warn(`[IPAY SALDO HTTP ERROR] Status: ${res.status} ${res.statusText}`);
                return 'Error';
            }

            const json = await res.json().catch(() => ({}));
            const data = json.data || json;
            if (data && data.balance !== undefined) {
                return Number(data.balance);
            }
            return 'Error';
        } catch (e) {
            console.error('[IPAY SALDO EXCEPTION]', e.message);
            return 'Error';
        }
    }

    /**
     * Sinkronisasi seluruh katalog produk prabayar dari iPay ke database lokal (db.ppob)
     * Otomatis mengkalkulasi harga jual member sesuai margin aktif bot
     */
    static async pullAllIpayProducts() {
        try {
            const cfg = this.getIpayConfig();
            if (!this.isConfigured()) {
                console.warn('[IPAY SYNC] Kredensial H2H iPay belum disetel di settings.');
                return false;
            }

            const cleanBase = cfg.baseUrl.replace(/\/+$/, '');
            const url = `${cleanBase}/api/v1/products`;

            console.log(`[IPAY SYNC] Mengambil katalog produk dari ${url}...`);
            const res = await fetch(url, {
                method: 'GET',
                headers: this.getAuthHeaders(),
                signal: AbortSignal.timeout(25000)
            });

            if (!res.ok) {
                console.error(`[IPAY PRODUCTS HTTP ERROR] Status: ${res.status} ${res.statusText}`);
                return false;
            }

            const json = await res.json().catch(() => null);
            if (!json || (!json.status && json.status !== 'success') || !Array.isArray(json.data)) {
                console.error('[IPAY PRODUCTS PARSE ERROR]', json);
                return false;
            }

            const rawProducts = json.data;
            const targetCats = [
                { key: 'pulsa', label: 'Pulsa' },
                { key: 'data', label: 'Data' },
                { key: 'emoney', label: 'E-Money' },
                { key: 'pln', label: 'PLN' }
            ];

            const targetLabels = targetCats.map(t => t.label);
            // Bersihkan produk lama dari kategori yang akan disinkronkan
            db.ppob = (db.ppob || []).filter(p => !targetLabels.includes(p.kategori));

            const counts = { pulsa: 0, data: 0, emoney: 0, pln: 0, total: 0 };

            rawProducts.forEach(p => {
                const sku = String(p.sku_code || p.sku || '').trim();
                if (!sku) return;

                const isActive = p.status !== undefined 
                    ? (String(p.status).toLowerCase() === 'normal' || p.status === true || p.status === 1)
                    : (p.is_active !== undefined ? Boolean(p.is_active) : true);

                if (!isActive) return;

                const pCatLower = String(p.category || p.category_code || '').toLowerCase().replace(/[^a-z]/g, '');
                let matched = targetCats.find(t => t.label.toLowerCase().replace(/[^a-z]/g, '') === pCatLower);

                // Smart categorizer fallback
                if (!matched) {
                    if (pCatLower.includes('pulsa')) matched = targetCats.find(t => t.key === 'pulsa');
                    else if (pCatLower.includes('data') || pCatLower.includes('paket') || pCatLower.includes('internet')) matched = targetCats.find(t => t.key === 'data');
                    else if (pCatLower.includes('money') || pCatLower.includes('wallet') || pCatLower.includes('saldo') || pCatLower.includes('dana') || pCatLower.includes('gopay') || pCatLower.includes('ovo') || pCatLower.includes('shopee')) matched = targetCats.find(t => t.key === 'emoney');
                    else if (pCatLower.includes('pln') || pCatLower.includes('listrik') || pCatLower.includes('token')) matched = targetCats.find(t => t.key === 'pln');
                }

                if (!matched) return;

                const basePrice = parseFloat(p.price ?? p.base_price ?? 0);
                const sellingPrice = marginHelper.calculateSellingPrice(basePrice);

                db.ppob.push({
                    sku: sku,
                    nama: p.product_name || p.name || sku,
                    hargaModal: basePrice,
                    hargaJual: sellingPrice,
                    brand: String(p.brand || p.provider_code || 'UMUM').toUpperCase(),
                    kategori: matched.label,
                    tipe: p.type || 'Umum',
                    source: 'ipay'
                });

                counts[matched.key]++;
                counts.total++;
            });

            if (typeof db.savePpob === 'function') db.savePpob();
            console.log(`[IPAY PRODUCTS SYNC SUCCESS] Total ${counts.total} produk (Pulsa: ${counts.pulsa}, Data: ${counts.data}, E-Money: ${counts.emoney}, PLN: ${counts.pln})`);
            return counts;
        } catch (e) {
            console.error('[IPAY SYNC EXCEPTION]', e.message);
            return false;
        }
    }

    /**
     * Sinkronisasi kategori tertentu dari iPay
     */
    static async pullIpayProducts(kategori) {
        try {
            const counts = await this.pullAllIpayProducts();
            if (!counts) return false;
            const norm = String(kategori || '').toLowerCase().replace(/[^a-z]/g, '');
            return typeof counts[norm] === 'number' ? counts[norm] : counts.total;
        } catch (e) {
            return false;
        }
    }

    /**
     * Eksekusi Pembelian PPOB Prabayar ke GarudaTel (ipay.my.id)
     * Mengembalikan payload format standar yang cocok dengan index.js
     */
    static async hitIpay(sku, target, orderId) {
        try {
            const cfg = this.getIpayConfig();
            if (!this.isConfigured()) {
                return {
                    data: {
                        status: 'Gagal',
                        message: 'Kredensial H2H iPay belum disetel di server',
                        buyer_sku_code: sku,
                        customer_no: target,
                        ref_id: orderId
                    }
                };
            }

            const cleanBase = cfg.baseUrl.replace(/\/+$/, '');
            const sign = this.generateSignature(orderId);

            const payload = {
                merchant_id: cfg.merchantId,
                secret_key: cfg.secretKey,
                buyer_sku_code: sku,
                sku_code: sku,
                customer_no: target,
                ref_id: orderId,
                client_ref_id: orderId,
                sign: sign
            };

            console.log(`[IPAY HIT] Mengirim order ${orderId} (SKU: ${sku}, Target: ${target}) ke ${cleanBase}...`);
            const res = await fetch(`${cleanBase}/api/v1/transaction/create`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(30000)
            });

            const data = await res.json().catch(() => ({}));
            const cData = data.data || data;
            const apiStatus = String(cData.status || data.status || '').toLowerCase();
            const snFromApi = String(cData.sn || data.sn || '').trim();
            const msgFromApi = String(cData.message || data.message || '').trim();

            let normalizedStatus = 'Pending';
            if (apiStatus === 'success' || apiStatus === 'sukses') {
                normalizedStatus = 'Sukses';
            } else if (apiStatus === 'failed' || apiStatus === 'gagal') {
                normalizedStatus = 'Gagal';
            }

            // Fast Auto-Check: Jika status awal masih Pending, beri jeda 2.5 detik lalu cek status
            if (normalizedStatus === 'Pending') {
                try {
                    await new Promise(r => setTimeout(r, 2500));
                    const check = await this.checkStatusIpay(orderId);
                    if (check && check.status === 'Sukses') {
                        normalizedStatus = 'Sukses';
                        return {
                            data: {
                                status: 'Sukses',
                                message: check.message || 'Transaksi Sukses',
                                sn: check.sn || snFromApi,
                                buyer_sku_code: sku,
                                customer_no: target,
                                ref_id: orderId,
                                rc: '00'
                            }
                        };
                    } else if (check && check.status === 'Gagal') {
                        normalizedStatus = 'Gagal';
                    }
                } catch (_) {}
            }

            return {
                data: {
                    status: normalizedStatus,
                    message: msgFromApi || (normalizedStatus === 'Sukses' ? 'Transaksi Sukses' : 'Menunggu pemrosesan antrian'),
                    sn: snFromApi || (normalizedStatus === 'Sukses' ? msgFromApi : ''),
                    buyer_sku_code: sku,
                    customer_no: target,
                    ref_id: orderId,
                    rc: cData.rc || '00'
                }
            };
        } catch (e) {
            console.error('[IPAY HIT EXCEPTION]', e.message);
            return {
                data: {
                    status: 'Gagal',
                    message: e.message || 'Gagal menghubungi server iPay',
                    buyer_sku_code: sku,
                    customer_no: target,
                    ref_id: orderId
                }
            };
        }
    }

    /**
     * Memeriksa status transaksi ke iPay berdasarkan ref_id
     */
    static async checkStatusIpay(orderId) {
        try {
            const cfg = this.getIpayConfig();
            if (!this.isConfigured()) return null;

            const cleanBase = cfg.baseUrl.replace(/\/+$/, '');

            let res;
            try {
                res = await fetch(`${cleanBase}/api/v1/transaction/status`, {
                    method: 'POST',
                    headers: this.getAuthHeaders(),
                    body: JSON.stringify({
                        merchant_id: cfg.merchantId,
                        ref_id: orderId,
                        client_ref_id: orderId
                    }),
                    signal: AbortSignal.timeout(10000)
                });
            } catch (_) {}

            if (!res || !res.ok) {
                res = await fetch(`${cleanBase}/api/v1/transaction/status/${encodeURIComponent(orderId)}`, {
                    method: 'GET',
                    headers: this.getAuthHeaders(),
                    signal: AbortSignal.timeout(10000)
                });
            }

            if (!res || !res.ok) return null;
            const data = await res.json().catch(() => ({}));
            const cData = data.data || data;
            const cStat = String(cData.status || '').toLowerCase();
            const cSn = String(cData.sn || '').trim();
            const cMsg = String(cData.message || '').trim();

            let normStat = 'Pending';
            if (cStat === 'success' || cStat === 'sukses') normStat = 'Sukses';
            else if (cStat === 'failed' || cStat === 'gagal') normStat = 'Gagal';

            return {
                status: normStat,
                sn: cSn,
                message: cMsg
            };
        } catch (e) {
            console.error('[IPAY CHECK STATUS ERROR]', e.message);
            return null;
        }
    }

    /**
     * Inquiry tagihan pascabayar ke iPay (PLN Pasca, BPJS, PDAM, dll)
     */
    static async inquiryPostpaidIpay(sku, customerNo, refId) {
        try {
            const cfg = this.getIpayConfig();
            if (!this.isConfigured()) {
                return { status: 'Gagal', data: { status: 'Gagal', message: 'Kredensial H2H iPay belum disetel' } };
            }

            const cleanBase = cfg.baseUrl.replace(/\/+$/, '');
            const sign = this.generateSignature(refId);

            const res = await fetch(`${cleanBase}/api/v1/transaction/inquiry`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    merchant_id: cfg.merchantId,
                    buyer_sku_code: sku,
                    sku_code: sku,
                    customer_no: customerNo,
                    ref_id: refId,
                    client_ref_id: refId,
                    sign: sign
                }),
                signal: AbortSignal.timeout(25000)
            });

            const data = await res.json().catch(() => ({}));
            const isOk = data.status === 'success' || data.status === true;
            const cData = data.data || data;

            return {
                status: isOk ? 'Sukses' : 'Gagal',
                data: {
                    status: isOk ? 'Sukses' : 'Gagal',
                    customer_no: customerNo,
                    customer_name: cData.customer_name || data.customer_name || '',
                    amount: cData.amount || cData.price || 0,
                    admin: cData.admin || data.admin || 0,
                    selling_price: (cData.amount || 0) + (cData.admin || 0),
                    desc: {
                        tagihan: cData.desc?.tagihan || '',
                        detail: cData.desc?.detail || []
                    },
                    message: cData.message || data.message || ''
                }
            };
        } catch (e) {
            console.error('[IPAY INQUIRY ERROR]', e.message);
            return { status: 'Gagal', data: { status: 'Gagal', message: e.message } };
        }
    }

    /**
     * Verifikasi Signature Webhook dari GarudaTel
     */
    static verifySignature(receivedSign, refId) {
        if (!receivedSign) return false;
        const expected = this.generateSignature(refId);
        return String(receivedSign).toLowerCase() === expected.toLowerCase();
    }
}

module.exports = IpayService;
