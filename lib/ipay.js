/**
 * ==============================================================================
 * 🚀 IPAY (GARUDATEL) H2H MERCHANT INTEGRATION SERVICE (lib/ipay.js)
 * Standar Host-to-Host (H2H) API Client untuk Bot PPOB WhatsApp & Telegram
 * Terintegrasi penuh dengan ekosistem GarudaTel (ipay.my.id)
 * ==============================================================================
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../database/db');
const marginHelper = require('./margin');

const QUEUE_FILE = path.resolve(__dirname, '..', 'system', 'ipay_pending_queue.json');

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

    /**
     * Normalisasi nomor telepon ke format 08...
     */
    static normalizePhone(phone) {
        if (!phone) return '';
        let clean = String(phone).replace(/[^0-9]/g, '');
        if (clean.startsWith('62')) clean = '0' + clean.slice(2);
        return clean;
    }

    /**
     * Sinkronisasi data member antara Bot WA dan Web iPay
     * Memeriksa apakah member terdaftar di iPay.
     * Jika ada, mengambil saldo live terbaru.
     * Jika belum ada, otomatis membuat member baru di iPay.
     */
    static async syncMember(phone, name = '', autoCreate = true, initialBalance = 0) {
        try {
            const cfg = this.getIpayConfig();
            if (!this.isConfigured()) return { success: false, message: 'iPay belum diatur' };

            const normPhone = this.normalizePhone(phone);
            if (!normPhone || normPhone.length < 9) return { success: false, message: 'Nomor telepon tidak valid' };

            const cleanBase = cfg.baseUrl.replace(/\/+$/, '');
            const payload = {
                phone: normPhone,
                name: name || `Member ${normPhone.slice(-4)}`,
                auto_create: Boolean(autoCreate),
                create_if_missing: Boolean(autoCreate),
                initial_balance: Number(initialBalance) || 0
            };

            const res = await fetch(`${cleanBase}/api/v1/member/sync-pos`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000)
            });

            if (!res.ok && res.status !== 404) {
                return { success: false, status: res.status, message: `HTTP Error ${res.status}` };
            }

            const json = await res.json().catch(() => ({}));

            if (res.ok && (json.is_member || json.status === 'success')) {
                const u = json.user || {};
                return {
                    success: true,
                    isMember: true,
                    user: {
                        id: u.id,
                        name: u.name || name,
                        phone: u.phone || normPhone,
                        balance: Number(u.balance !== undefined ? u.balance : (json.balance || 0)),
                        role: u.role || 'user'
                    },
                    message: json.message || 'Member terverifikasi'
                };
            }

            return {
                success: false,
                isMember: false,
                message: json.message || 'Member tidak ditemukan di iPay'
            };
        } catch (err) {
            console.error('[IPAY SYNC MEMBER ERROR]', err.message);
            return { success: false, offline: true, error: err.message };
        }
    }

    /**
     * Membaca antrian mutasi offline yang belum terkirim ke iPay
     */
    static getPendingQueue() {
        try {
            if (!fs.existsSync(QUEUE_FILE)) return [];
            const content = fs.readFileSync(QUEUE_FILE, 'utf8');
            const list = JSON.parse(content);
            return Array.isArray(list) ? list : [];
        } catch (_) {
            return [];
        }
    }

    /**
     * Menyimpan antrian mutasi offline ke disk
     */
    static savePendingQueue(queue) {
        try {
            const dir = path.dirname(QUEUE_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
        } catch (e) {
            console.error('[IPAY QUEUE SAVE ERROR]', e.message);
        }
    }

    /**
     * Menambahkan mutasi ke antrian offline jika server iPay sedang down/maintenance
     */
    static enqueuePendingAdjustment(phone, amount, action, reason) {
        try {
            const queue = this.getPendingQueue();
            const item = {
                id: `ADJ-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                phone: this.normalizePhone(phone),
                amount: Math.abs(Number(amount) || 0),
                action: action || 'add',
                reason: String(reason || 'Offline adjustment').trim(),
                timestamp: Date.now(),
                createdAtWib: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB'
            };
            queue.push(item);
            this.savePendingQueue(queue);
            console.log(`[IPAY OFFLINE QUEUE] 📥 Mutasi ${item.action} Rp ${item.amount.toLocaleString('id-ID')} untuk ${item.phone} disimpan di antrian offline.`);
            return item;
        } catch (e) {
            console.error('[IPAY ENQUEUE ERROR]', e.message);
            return null;
        }
    }

    /**
     * Memproses & memutar ulang (flush/replay) seluruh antrian mutasi tertunda ke iPay
     * Dipanggil secara otomatis begitu server iPay hidup kembali
     */
    static async flushPendingQueue() {
        const queue = this.getPendingQueue();
        if (queue.length === 0) return { processed: 0, remaining: 0 };

        console.log(`[IPAY QUEUE FLUSH] 🔄 Mencoba memproses ${queue.length} mutasi tertunda ke server iPay...`);
        const remaining = [];
        let processed = 0;

        for (const item of queue) {
            try {
                const res = await this.adjustMemberBalanceDirect(item.phone, item.amount, item.action, item.reason);
                if (res && res.success) {
                    processed++;
                    console.log(`[IPAY QUEUE SUCCESS] ✅ Mutasi ${item.id} (${item.action} ${item.amount} untuk ${item.phone}) berhasil disinkronkan ke iPay.`);
                } else {
                    remaining.push(item);
                    console.warn(`[IPAY QUEUE RETRY] ⚠️ Mutasi ${item.id} gagal dikirim (${res?.message || 'Server belum siap'}), akan dicoba lagi nanti.`);
                }
            } catch (err) {
                remaining.push(item);
                console.error(`[IPAY QUEUE EXCEPTION] ${item.id}:`, err.message);
            }
        }

        this.savePendingQueue(remaining);
        if (processed > 0) {
            console.log(`[IPAY QUEUE COMPLETED] 🚀 Berhasil memutar ${processed} mutasi tertunda. Sisa antrian: ${remaining.length}`);
        }
        return { processed, remaining: remaining.length };
    }

    /**
     * Eksekusi langsung ke endpoint iPay tanpa fallback queue (internal)
     */
    static async adjustMemberBalanceDirect(phone, amount, action = 'add', reason = '') {
        const cfg = this.getIpayConfig();
        if (!this.isConfigured()) return { success: false, message: 'iPay belum diatur' };

        const normPhone = this.normalizePhone(phone);
        if (!normPhone) return { success: false, message: 'Nomor tidak valid' };

        const cleanBase = cfg.baseUrl.replace(/\/+$/, '');
        const payload = {
            phone: normPhone,
            amount: Math.abs(Number(amount) || 0),
            action: action,
            reason: reason || 'Sinkronisasi Bot WA'
        };

        const res = await fetch(`${cleanBase}/api/v1/member/adjust-balance`, {
            method: 'POST',
            headers: this.getAuthHeaders(),
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000)
        });

        const json = await res.json().catch(() => ({}));
        if (res.ok && json.status === 'success') {
            return {
                success: true,
                old_balance: json.old_balance,
                new_balance: json.new_balance,
                message: json.message
            };
        }
        return { success: false, message: json.message || `HTTP Error ${res.status}` };
    }

    /**
     * Menyesuaikan saldo member di iPay (Deposit / Belanja / Refund)
     * Dilengkapi Offline Tolerance & Auto-Queue jika iPay offline/down!
     * Action: 'add' | 'deduct' | 'set'
     */
    static async adjustMemberBalance(phone, amount, action = 'add', reason = '') {
        try {
            // Coba eksekusi langsung terlebih dahulu
            const res = await this.adjustMemberBalanceDirect(phone, amount, action, reason);
            if (res && res.success) {
                return res;
            }
            // Jika ditolak dengan alasan saldo member tidak cukup dari iPay, jangan masukkan antrian
            if (res && res.message && res.message.toLowerCase().includes('tidak mencukupi')) {
                return res;
            }
            // Jika gagal karena network/server iPay offline (HTTP 502/503/timeout):
            this.enqueuePendingAdjustment(phone, amount, action, reason);
            return {
                success: true,
                queued: true,
                message: `Server iPay offline/maintenance. Mutasi disimpan di antrian offline dan akan otomatis disinkronkan saat iPay hidup kembali.`
            };
        } catch (err) {
            console.warn('[IPAY OFFLINE DETECTED] Server iPay tidak dapat dihubungi:', err.message);
            this.enqueuePendingAdjustment(phone, amount, action, reason);
            return {
                success: true,
                queued: true,
                message: `Server iPay offline (${err.message}). Mutasi disimpan di antrian offline.`
            };
        }
    }

    /**
     * Batch Sync seluruh member di db.users ke server iPay
     */
    static async batchSyncAllMembers() {
        // 🔄 1. Putar ulang antrian offline terlebih dahulu jika ada
        try {
            await this.flushPendingQueue();
        } catch (_) {}

        let total = 0;
        let synced = 0;
        let created = 0;
        let errors = 0;

        const usersEntries = Object.entries(db.users || {});
        for (const [jid, u] of usersEntries) {
            if (!u || typeof u !== 'object') continue;
            let phone = u.phone || '';
            if (!phone && jid.includes('@s.whatsapp.net')) {
                phone = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            }
            if (!phone || phone.length < 9) continue;
            total++;

            try {
                const res = await this.syncMember(phone, u.name, true, Number(u.saldo) || 0);
                // 🛡️ Jangan timpa saldo lokal jika iPay sedang offline!
                if (res && res.success && res.user && !res.offline) {
                    u.saldo = res.user.balance;
                    if (res.user.name && (!u.name || u.name === 'User')) {
                        u.name = res.user.name;
                    }
                    synced++;
                } else {
                    errors++;
                }
            } catch (_) {
                errors++;
            }
        }

        if (db.saveUsers) db.saveUsers();
        return { total, synced, created, errors };
    }
}

module.exports = IpayService;
