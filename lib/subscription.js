/**
 * ==============================================================================
 * 🔄 MODUL PRODUK BERLANGGANAN (AUTO-ORDER / RECURRING SUBSCRIPTION)
 * ==============================================================================
 * Mengelola katalog produk langganan, kontrak aktif pengguna, kalkulasi siklus,
 * dan background worker eksekusi otomatis berkala.
 * ==============================================================================
 */

const db = require('../database/db');
const { formatRupiah } = require('./utils');
const api = require('./api');

// --- HELPER FORMATING ---
function formatInterval(days) {
    const d = parseInt(days, 10);
    if (d === 1) return '1 Hari Sekali (Tiap Hari)';
    if (d === 7) return '7 Hari (Mingguan)';
    if (d === 14) return '14 Hari (2 Mingguan)';
    if (d === 30) return '30 Hari (Bulanan)';
    return `${d} Hari Sekali`;
}

function formatCycles(max, current) {
    const m = parseInt(max, 10);
    const c = parseInt(current, 10);
    if (!m || m <= 0) {
        return c ? `Siklus ${c} (Tanpa Batas / Berkelanjutan)` : `Tanpa Batas (Sampai Dibatalkan)`;
    }
    return c ? `Siklus ${c} dari ${m}` : `${m} Kali Pembelian`;
}

// --- KATALOG PRODUK LANGGANAN (ADMIN CONTROL) ---
function getCatalog(onlyActive = true) {
    const catalog = db.subscriptionCatalog || [];
    if (!onlyActive) return catalog;
    return catalog.filter(item => item.enabled !== false);
}

function addCatalogItem({ sku, type = 'ppob', nama, kategori = 'PPOB', hargaJual, allowedIntervals = [7, 14, 30], defaultInterval = 30, allowedCycles = [3, 6, 12, 0], description = '' }) {
    if (!db.subscriptionCatalog) db.subscriptionCatalog = [];
    
    // Cek apakah produk dengan SKU tersebut sudah ada
    const existingIndex = db.subscriptionCatalog.findIndex(item => item.sku && item.sku.toUpperCase() === String(sku).toUpperCase());
    
    const newItem = {
        id: existingIndex >= 0 ? db.subscriptionCatalog[existingIndex].id : `SCAT-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
        sku: String(sku).trim(),
        type: type === 'digital' ? 'digital' : 'ppob',
        nama: String(nama).trim(),
        kategori: String(kategori).trim(),
        hargaJual: Number(hargaJual) || 0,
        enabled: true,
        allowedIntervals: Array.isArray(allowedIntervals) && allowedIntervals.length ? allowedIntervals : [7, 14, 30],
        defaultInterval: Number(defaultInterval) || 30,
        allowedCycles: Array.isArray(allowedCycles) && allowedCycles.length ? allowedCycles : [3, 6, 12, 0],
        description: description ? String(description).trim() : 'Layanan langganan otomatis berkala',
        updatedAt: Date.now()
    };

    if (existingIndex >= 0) {
        db.subscriptionCatalog[existingIndex] = { ...db.subscriptionCatalog[existingIndex], ...newItem };
    } else {
        newItem.createdAt = Date.now();
        db.subscriptionCatalog.push(newItem);
    }

    if (typeof db.saveSubscriptionCatalog === 'function') {
        db.saveSubscriptionCatalog();
    }
    return newItem;
}

function toggleCatalogItem(idOrSku) {
    if (!db.subscriptionCatalog) db.subscriptionCatalog = [];
    const target = String(idOrSku).toUpperCase();
    const item = db.subscriptionCatalog.find(i => (i.id && i.id.toUpperCase() === target) || (i.sku && i.sku.toUpperCase() === target));
    if (!item) return { success: false, reason: 'Produk tidak ditemukan di katalog langganan.' };
    
    item.enabled = item.enabled === false ? true : false;
    item.updatedAt = Date.now();
    
    if (typeof db.saveSubscriptionCatalog === 'function') {
        db.saveSubscriptionCatalog();
    }
    return { success: true, item };
}

function deleteCatalogItem(idOrSku) {
    if (!db.subscriptionCatalog) db.subscriptionCatalog = [];
    const target = String(idOrSku).toUpperCase();
    const index = db.subscriptionCatalog.findIndex(i => (i.id && i.id.toUpperCase() === target) || (i.sku && i.sku.toUpperCase() === target));
    if (index === -1) return { success: false, reason: 'Produk tidak ditemukan.' };
    
    const removed = db.subscriptionCatalog.splice(index, 1)[0];
    if (typeof db.saveSubscriptionCatalog === 'function') {
        db.saveSubscriptionCatalog();
    }
    return { success: true, removed };
}

// --- KONTRAK LANGGANAN PENGGUNA (USER SUBSCRIPTIONS) ---
function getSubscriptions(filter = {}) {
    let list = db.subscriptions || [];
    if (filter.buyer) {
        const cleanBuyer = filter.buyer.replace(/[^0-9]/g, '');
        list = list.filter(s => (s.buyer && s.buyer.includes(cleanBuyer)) || (s.buyerPhone && s.buyerPhone.includes(cleanBuyer)));
    }
    if (filter.status) {
        list = list.filter(s => s.status === filter.status);
    }
    return list;
}

function getUserSubscriptions(buyerJid) {
    const list = db.subscriptions || [];
    const cleanJid = db.normalizeJid ? db.normalizeJid(buyerJid) : buyerJid;
    const cleanPhone = cleanJid.replace(/[^0-9]/g, '');
    
    return list.filter(s => {
        const sJid = s.buyer ? (db.normalizeJid ? db.normalizeJid(s.buyer) : s.buyer) : '';
        const sPhone = s.buyerPhone ? s.buyerPhone.replace(/[^0-9]/g, '') : (s.buyer ? s.buyer.replace(/[^0-9]/g, '') : '');
        return sJid === cleanJid || sPhone === cleanPhone;
    });
}

function createSubscription({ buyer, buyerPhone, catalogId, sku, productType, productName, target, price, intervalDays, maxCycles, firstOrderId }) {
    if (!db.subscriptions) db.subscriptions = [];
    
    const now = Date.now();
    const days = Math.max(1, parseInt(intervalDays, 10) || 30);
    const cyclesLimit = parseInt(maxCycles, 10) || 0; // 0 = unlimited
    const amount = Number(price) || 0;
    
    const subId = `SUB-${now}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    const nextRun = now + (days * 24 * 60 * 60 * 1000);

    const newSub = {
        id: subId,
        buyer: buyer,
        buyerPhone: buyerPhone || (buyer ? buyer.replace(/[^0-9]/g, '') : ''),
        catalogId: catalogId || null,
        sku: sku,
        productType: productType === 'digital' ? 'digital' : 'ppob',
        productName: productName,
        target: target,
        price: amount,
        intervalDays: days,
        maxCycles: cyclesLimit,
        currentCycle: 1, // Pembelian ke-1 sudah terjadi saat mendaftar
        status: cyclesLimit === 1 ? 'completed' : 'active',
        createdAt: now,
        lastRunAt: now,
        nextRunAt: cyclesLimit === 1 ? null : nextRun,
        failCount: 0,
        history: [
            {
                cycle: 1,
                date: now,
                orderId: firstOrderId || `INV-${now}`,
                status: 'success',
                amount: amount
            }
        ]
    };

    db.subscriptions.push(newSub);
    if (typeof db.saveSubscriptions === 'function') {
        db.saveSubscriptions();
    }
    return newSub;
}

function cancelSubscription(subId, reason = 'Dibatalkan oleh Pengguna', cancelledBy = 'user') {
    if (!db.subscriptions) return { success: false, reason: 'Belum ada data langganan.' };
    const sub = db.subscriptions.find(s => s.id && s.id.toUpperCase() === String(subId).toUpperCase());
    if (!sub) return { success: false, reason: 'Langganan tidak ditemukan.' };
    if (sub.status === 'cancelled') return { success: false, reason: 'Langganan ini sudah dibatalkan sebelumnya.' };
    if (sub.status === 'completed') return { success: false, reason: 'Langganan ini sudah selesai (seluruh siklus telah tuntas).' };

    sub.status = 'cancelled';
    sub.cancelledAt = Date.now();
    sub.cancelReason = reason;
    sub.cancelledBy = cancelledBy;

    if (typeof db.saveSubscriptions === 'function') {
        db.saveSubscriptions();
    }
    return { success: true, subscription: sub };
}

function pauseSubscription(subId, reason = 'Saldo Tidak Mencukupi') {
    if (!db.subscriptions) return { success: false, reason: 'Belum ada data langganan.' };
    const sub = db.subscriptions.find(s => s.id && s.id.toUpperCase() === String(subId).toUpperCase());
    if (!sub) return { success: false, reason: 'Langganan tidak ditemukan.' };

    sub.status = 'paused';
    sub.pausedAt = Date.now();
    sub.pauseReason = reason;

    if (typeof db.saveSubscriptions === 'function') {
        db.saveSubscriptions();
    }
    return { success: true, subscription: sub };
}

function resumeSubscription(subId) {
    if (!db.subscriptions) return { success: false, reason: 'Belum ada data langganan.' };
    const sub = db.subscriptions.find(s => s.id && s.id.toUpperCase() === String(subId).toUpperCase());
    if (!sub) return { success: false, reason: 'Langganan tidak ditemukan.' };
    if (sub.status !== 'paused') return { success: false, reason: `Langganan berstatus ${sub.status}, hanya langganan dijeda yang dapat diaktifkan kembali.` };

    sub.status = 'active';
    sub.failCount = 0;
    sub.nextRunAt = Date.now(); // Coba eksekusi segera pada jadwal berikutnya

    if (typeof db.saveSubscriptions === 'function') {
        db.saveSubscriptions();
    }
    return { success: true, subscription: sub };
}

// --- ENGINE EKSEKUSI OTOMATIS (BACKGROUND WORKER) ---
let workerIntervalId = null;

function startSubscriptionWorker(getSock, getBotTg, getConfig, handleSuccessPaymentFunc) {
    if (workerIntervalId) return; // Mencegah double interval

    console.log('[SUBSCRIPTION] 🚀 Engine background worker langganan otomatis aktif (interval: 60 detik).');

    const runWorkerCycle = async () => {
        try {
            if (!db.subscriptions || db.subscriptions.length === 0) return;

            const now = Date.now();
            const dueSubscriptions = db.subscriptions.filter(s => s.status === 'active' && s.nextRunAt && s.nextRunAt <= now);
            if (dueSubscriptions.length === 0) return;

            const sock = typeof getSock === 'function' ? getSock() : getSock;
            const botTg = typeof getBotTg === 'function' ? getBotTg() : getBotTg;
            const config = typeof getConfig === 'function' ? getConfig() : getConfig;

            for (const sub of dueSubscriptions) {
                const buyerJid = db.normalizeJid ? db.normalizeJid(sub.buyer) : sub.buyer;
                const buyerUser = db.getUser ? db.getUser(buyerJid) : null;
                const actualSaldo = Number(buyerUser?.saldo) || 0;
                const requiredAmount = Number(sub.price) || 0;

                // SKENARIO 1: SALDO CUKUP -> POTONG SALDO & EKSEKUSI TRANSAKSI
                if (actualSaldo >= requiredAmount) {
                    const oid = `INV-${Date.now()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
                    const deduct = db.deductSaldo(buyerJid, requiredAmount, oid, `[LANGGANAN] ${sub.productName}`);

                    if (deduct && deduct.success) {
                        const targetCycle = sub.currentCycle + 1;
                        const isFinalCycle = (sub.maxCycles > 0 && targetCycle >= sub.maxCycles);

                        const newOrder = {
                            id: oid,
                            buyer: buyerJid,
                            sender: buyerJid,
                            item: sub.productName,
                            sku: sub.sku,
                            target: sub.target,
                            price: requiredAmount,
                            baseAmount: requiredAmount,
                            total: requiredAmount,
                            qty: 1,
                            method: 'Saldo Akun (Auto-Debit Langganan)',
                            status: 'processing',
                            isPpob: sub.productType === 'ppob',
                            isSubscription: true,
                            subscriptionId: sub.id,
                            cycle: targetCycle,
                            timestamp: Date.now()
                        };

                        if (!db.orders) db.orders = [];
                        db.orders.push(newOrder);
                        db.saveOrders();

                        // Eksekusi PPOB atau Digital via handleSuccessPayment (lengkap dengan notifikasi & token PLN)
                        const paymentHandler = handleSuccessPaymentFunc || global.handleSuccessPayment;
                        if (typeof paymentHandler === 'function') {
                            try {
                                await paymentHandler(sock, newOrder, true);
                            } catch (payErr) {
                                console.error('[SUBS EXECUTION ERR]', payErr.message);
                            }
                        } else if (sub.productType === 'ppob') {
                            try {
                                const hit = typeof api.hitDigiflazz === 'function'
                                    ? await api.hitDigiflazz(sub.sku, sub.target, oid)
                                    : (typeof api.topup === 'function' ? await api.topup(sub.sku, sub.target, oid) : null);
                                if (hit && (hit.status === 'Success' || hit.data?.status === 'Sukses' || hit.data?.status === 'Pending')) {
                                    newOrder.digiflazz_oid = hit.data?.ref_id || oid;
                                    db.saveOrders();
                                }
                            } catch (apiErr) {
                                console.error('[SUBS PPOB ERR]', apiErr.message);
                            }
                        }

                        // Perbarui data langganan
                        sub.currentCycle = targetCycle;
                        sub.lastRunAt = Date.now();
                        sub.failCount = 0;
                        if (!Array.isArray(sub.history)) sub.history = [];
                        sub.history.push({
                            cycle: targetCycle,
                            date: Date.now(),
                            orderId: oid,
                            status: 'success',
                            amount: requiredAmount
                        });

                        if (isFinalCycle) {
                            sub.status = 'completed';
                            sub.nextRunAt = null;
                        } else {
                            sub.nextRunAt = Date.now() + (sub.intervalDays * 24 * 60 * 60 * 1000);
                        }

                        if (typeof db.saveSubscriptions === 'function') db.saveSubscriptions();

                        // Kirim Notifikasi Sukses ke WhatsApp Pembeli
                        if (sock && typeof sock.sendMessage === 'function') {
                            const cycleStr = formatCycles(sub.maxCycles, targetCycle);
                            const nextDateStr = sub.nextRunAt ? new Date(sub.nextRunAt).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'Tidak ada (Siklus Berakhir)';
                            
                            let waSuccessMsg = `🔄 *PERPANJANGAN LANGGANAN OTOMATIS BERHASIL!*\n\n` +
                                `Pesanan otomatis Anda telah sukses dieksekusi:\n` +
                                `• Produk   : *${sub.productName}*\n` +
                                `• Tujuan   : \`${sub.target}\`\n` +
                                `• Biaya    : *${formatRupiah(requiredAmount)}* _(Auto-Debit)_\n` +
                                `• Siklus   : *${cycleStr}*\n` +
                                `• Invoice  : \`${oid}\`\n` +
                                `• Sisa Saldo: *${formatRupiah(buyerUser.saldo)}*\n\n`;

                            if (isFinalCycle) {
                                waSuccessMsg += `🎉 *SELURUH SIKLUS TELAH SELESAI!*\nTerima kasih atas kesetiaan Anda berlangganan di *${db.store?.namaToko || 'STORE'}*. Kontrak langganan ini telah tuntas.`;
                            } else {
                                waSuccessMsg += `📅 *Jadwal Berikutnya:* ${nextDateStr}\n` +
                                    `_Pastikan saldo dompet akun Anda tetap terisi sebelum jadwal berikutnya._\n` +
                                    `Ketik *.langganan* untuk melihat atau mengelola langganan Anda.`;
                            }

                            await sock.sendMessage(buyerJid, { text: waSuccessMsg }).catch(() => {});
                        }

                        // Laporan ke Telegram Admin
                        if (botTg && config?.telegram?.chatId) {
                            const cycleStr = formatCycles(sub.maxCycles, targetCycle);
                            botTg.sendMessage(config.telegram.chatId,
                                `🔄 *[AUTO-ORDER LANGGANAN SUKSES]*\n\n` +
                                `🧾 Invoice : \`${oid}\`\n` +
                                `📦 Produk  : *${sub.productName}*\n` +
                                `🎯 Target  : \`${sub.target}\`\n` +
                                `💰 Nominal : *${formatRupiah(requiredAmount)}*\n` +
                                `👤 Pembeli : \`+${sub.buyerPhone}\`\n` +
                                `📊 Status  : *${cycleStr}* ${isFinalCycle ? '(SELESAI)' : ''}`,
                                { parse_mode: 'Markdown' }
                            ).catch(() => {});
                        }
                    }
                } 
                // SKENARIO 2: SALDO KURANG -> PERINGATAN RAMAH KE PEMBELI (GRACE PERIOD)
                else {
                    sub.failCount = (sub.failCount || 0) + 1;
                    const shortage = requiredAmount - actualSaldo;

                    // Jika gagal 3 kali berturut-turut -> Jeda langganan (Paused)
                    if (sub.failCount >= 3) {
                        sub.status = 'paused';
                        sub.pausedAt = Date.now();
                        sub.pauseReason = 'Saldo akun tidak mencukupi setelah 3x percobaan.';
                        if (typeof db.saveSubscriptions === 'function') db.saveSubscriptions();

                        if (sock && typeof sock.sendMessage === 'function') {
                            const waPauseMsg = `⏸️ *LANGGANAN DIJEDA SEMENTARA*\n\n` +
                                `Mohon maaf kak, sistem menjeda sementara perpanjangan langganan *${sub.productName}* (${sub.id}) karena saldo akun Anda belum mencukupi setelah beberapa kali percobaan.\n\n` +
                                `💰 Biaya Perpanjangan : *${formatRupiah(requiredAmount)}*\n` +
                                `💵 Saldo Anda Saat Ini: *${formatRupiah(actualSaldo)}*\n\n` +
                                `Untuk mengaktifkan kembali langganan:\n` +
                                `1. Isi saldo dengan ketik *DEPOSIT*.\n` +
                                `2. Setelah saldo terisi, ketik *.langganan* untuk melanjutkan jadwal.`;
                            await sock.sendMessage(buyerJid, { text: waPauseMsg }).catch(() => {});
                        }

                        if (botTg && config?.telegram?.chatId) {
                            botTg.sendMessage(config.telegram.chatId,
                                `⚠️ *[LANGGANAN DIJEDA - SALDO KOSONG]*\n\n` +
                                `🆔 ID Langganan : \`${sub.id}\`\n` +
                                `📦 Produk        : *${sub.productName}*\n` +
                                `👤 Pembeli       : \`+${sub.buyerPhone}\`\n` +
                                `💰 Kurang        : *${formatRupiah(shortage)}*\n` +
                                `Status otomatis diubah menjadi *PAUSED*.`,
                                { parse_mode: 'Markdown' }
                            ).catch(() => {});
                        }
                    } else {
                        // Coba lagi dalam 24 jam ke depan
                        sub.nextRunAt = Date.now() + (24 * 60 * 60 * 1000);
                        if (typeof db.saveSubscriptions === 'function') db.saveSubscriptions();

                        if (sock && typeof sock.sendMessage === 'function') {
                            const waReminderMsg = `⚠️ *PENGINGAT PERPANJANGAN LANGGANAN*\n\n` +
                                `Halo kak! Hari ini adalah jadwal perpanjangan otomatis untuk:\n` +
                                `📦 Produk : *${sub.productName}*\n` +
                                `🎯 Tujuan : \`${sub.target}\`\n` +
                                `💰 Biaya  : *${formatRupiah(requiredAmount)}*\n` +
                                `💵 Saldo Anda: *${formatRupiah(actualSaldo)}* (Kurang *${formatRupiah(shortage)}*)\n\n` +
                                `Sistem belum dapat memproses perpanjangan karena saldo dompet akun Anda belum mencukupi.\n` +
                                `👉 Ketik *DEPOSIT* untuk isi saldo sekarang.\n\n` +
                                `_Sistem akan mencoba kembali memproses secara otomatis besok._`;
                            await sock.sendMessage(buyerJid, { text: waReminderMsg }).catch(() => {});
                        }

                        if (botTg && config?.telegram?.chatId) {
                            botTg.sendMessage(config.telegram.chatId,
                                `⚠️ *[PERINGATAN SALDO KURANG LANGGANAN]*\n\n` +
                                `🆔 ID Langganan : \`${sub.id}\`\n` +
                                `📦 Produk        : *${sub.productName}*\n` +
                                `👤 Pembeli       : \`+${sub.buyerPhone}\`\n` +
                                `💰 Kurang        : *${formatRupiah(shortage)}*\n` +
                                `Notifikasi pengingat ke-${sub.failCount} telah dikirim ke WA pembeli.`,
                                { parse_mode: 'Markdown' }
                            ).catch(() => {});
                        }
                    }
                }
            }
        } catch (workerErr) {
            console.error('[SUBSCRIPTION WORKER ERROR]', workerErr.message);
        }
    };

    // Jalankan segera saat start dan ulangi tiap 60 detik
    runWorkerCycle();
    workerIntervalId = setInterval(runWorkerCycle, 60 * 1000);
}

module.exports = {
    formatInterval,
    formatCycles,
    getCatalog,
    addCatalogItem,
    toggleCatalogItem,
    deleteCatalogItem,
    getSubscriptions,
    getUserSubscriptions,
    createSubscription,
    cancelSubscription,
    pauseSubscription,
    resumeSubscription,
    startSubscriptionWorker
};
