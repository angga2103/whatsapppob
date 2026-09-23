const path = require('path');
const config = require('../config');
const marginHelper = require('./margin');
const { formatRupiah } = require('./utils');

// Helper untuk mengambil database orders dan ppob secara aman
function getDb(override = null) {
    if (override && typeof override === 'object') return override;
    try {
        return require('../database/db');
    } catch (_) {
        return { orders: [], ppob: [], users: {}, menu: [], settings: {} };
    }
}

/**
 * Menghitung laba bersih (net profit) untuk satu order transaksi
 * @param {Object} order - Objek order dari db.orders
 * @param {Array} ppobCatalog - Opsional katalog db.ppob untuk pencocokan harga modal
 * @returns {number} Nominal laba bersih dalam rupiah (>= 0)
 */
function calculateOrderProfit(order, ppobCatalog) {
    if (!order) return 0;
    
    // Jika status bukan sukses, laba = 0 (karena dibatalkan / dana direfund)
    if (order.status !== 'success') return 0;

    // Jika profit sudah pernah dicatat di order secara eksplisit dan valid
    if (typeof order.profit === 'number' && !isNaN(order.profit) && order.profit >= 0) {
        return Math.round(order.profit);
    }

    const baseAmount = Number(order.baseAmount || order.total || 0);
    if (baseAmount <= 0) return 0;

    // 1. KASUS PASCABAYAR
    if (order.isPasca) {
        const pascaFee = (config.profit && typeof config.profit.pasca === 'number') ? config.profit.pasca : 1500;
        return Math.round(pascaFee);
    }

    // 2. KASUS PPOB PRABAYAR (Pulsa, Data, PLN, E-Money)
    if (order.isPpob) {
        const catalog = ppobCatalog || getDb().ppob || [];
        const itemSku = String(order.sku || '').trim().toLowerCase();
        const itemName = String(order.item || '').trim().toLowerCase();

        // Cari produk di katalog PPOB
        const prod = catalog.find(p => 
            (p.buyer_sku_code && String(p.buyer_sku_code).toLowerCase() === itemSku) ||
            (p.sku && String(p.sku).toLowerCase() === itemSku) ||
            (p.product_name && String(p.product_name).toLowerCase() === itemName) ||
            (p.name && String(p.name).toLowerCase() === itemName)
        );

        if (prod && typeof prod.price === 'number' && prod.price > 0) {
            const profit = baseAmount - prod.price;
            return Math.max(0, Math.round(profit));
        }

        // Fallback jika produk tidak ditemukan di katalog: gunakan autotier aktif
        const tierProfit = (typeof marginHelper.getTierMargin === 'function')
            ? marginHelper.getTierMargin(baseAmount)
            : (typeof marginHelper.getTierInfo === 'function' ? marginHelper.getTierInfo(baseAmount).margin : 500);
        return Math.max(0, Math.round(tierProfit));
    }

    // 3. KASUS PRODUK DIGITAL / AKUN TOKO INTERNAL
    // Karena produk internal toko (stok akun admin), laba dihitung dari harga jual dikurangi modal (jika ada)
    const modal = Number(order.modal || 0);
    const digitalProfit = modal > 0 ? (baseAmount - modal) : baseAmount;
    return Math.max(0, Math.round(digitalProfit));
}

/**
 * Mengonversi berbagai format input tanggal menjadi rentang Timestamp [startMs, endMs]
 * Mendukung: 'today', 'kemarin', 'yesterday', 'DD-MM-YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY'
 */
function parseDateRange(dateInput) {
    const now = new Date();
    
    // Normalisasi waktu awal dan akhir ke jam 00:00:00 s/d 23:59:59
    if (!dateInput || dateInput === 'today' || dateInput === 'hariini') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        return { start: start.getTime(), end: end.getTime(), label: 'Hari Ini', formattedDate: formatDateDisplay(start) };
    }

    if (dateInput === 'kemarin' || dateInput === 'yesterday') {
        const d = new Date(now.getTime() - 86400000);
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
        const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
        return { start: start.getTime(), end: end.getTime(), label: 'Kemarin', formattedDate: formatDateDisplay(start) };
    }

    if (dateInput === '2hari' || dateInput === '2days') {
        const d = new Date(now.getTime() - (2 * 86400000));
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
        const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
        return { start: start.getTime(), end: end.getTime(), label: '2 Hari Lalu', formattedDate: formatDateDisplay(start) };
    }

    // Parsing manual format string: YYYY-MM-DD atau DD-MM-YYYY atau DD/MM/YYYY
    const cleanStr = String(dateInput).trim();
    let year, month, day;

    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(cleanStr)) {
        // YYYY-MM-DD
        const parts = cleanStr.split(/[-/.]/);
        year = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10) - 1;
        day = parseInt(parts[2], 10);
    } else if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(cleanStr)) {
        // DD-MM-YYYY
        const parts = cleanStr.split(/[-/.]/);
        day = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10) - 1;
        year = parseInt(parts[2], 10);
    }

    if (year && !isNaN(month) && day) {
        const target = new Date(year, month, day, 0, 0, 0, 0);
        if (!isNaN(target.getTime())) {
            const start = target.getTime();
            const end = new Date(year, month, day, 23, 59, 59, 999).getTime();
            return {
                start,
                end,
                label: formatDateDisplay(target),
                formattedDate: formatDateDisplay(target)
            };
        }
    }

    return null;
}

function formatDateDisplay(d) {
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const dayName = days[d.getDay()];
    const dateNum = d.getDate();
    const monthName = months[d.getMonth()];
    const yearNum = d.getFullYear();
    return `${dayName}, ${dateNum} ${monthName} ${yearNum}`;
}

/**
 * Ringkasan Statistik & Laba Bersih berdasarkan periode
 * @param {string} range - 'today', '7d', '30d', 'all', atau tanggal custom
 */
function getStatsSummary(range = 'all', dbOverride = null) {
    const db = getDb(dbOverride);
    const orders = db.orders || [];
    const ppobCatalog = db.ppob || [];
    const now = Date.now();

    let startMs = 0;
    let endMs = Infinity;
    let rangeLabel = 'Semua Waktu';

    if (range === 'today' || range === '1d') {
        const parsed = parseDateRange('today');
        startMs = parsed.start;
        endMs = parsed.end;
        rangeLabel = 'Hari Ini';
    } else if (range === '7d' || range === 'week') {
        startMs = now - (7 * 24 * 60 * 60 * 1000);
        rangeLabel = '7 Hari Terakhir';
    } else if (range === '30d' || range === 'month') {
        startMs = now - (30 * 24 * 60 * 60 * 1000);
        rangeLabel = '30 Hari Terakhir';
    } else if (range !== 'all') {
        const custom = parseDateRange(range);
        if (custom) {
            startMs = custom.start;
            endMs = custom.end;
            rangeLabel = custom.formattedDate;
        }
    }

    // Filter order berdasarkan rentang waktu
    const filteredOrders = orders.filter(o => {
        const t = Number(o.timestamp || o.doneAt || 0);
        if (t <= 0) return range === 'all';
        return t >= startMs && t <= endMs;
    });

    const successOrders = filteredOrders.filter(o => o.status === 'success');
    const failedOrders = filteredOrders.filter(o => o.status === 'failed' || o.status === 'cancelled');
    const pendingOrders = filteredOrders.filter(o => o.status === 'pending' || o.status === 'processing' || o.status === 'unpaid');

    let totalOmzet = 0;
    let totalLabaBersih = 0;

    successOrders.forEach(o => {
        const amount = Number(o.baseAmount || o.total || 0);
        const profit = calculateOrderProfit(o, ppobCatalog);
        totalOmzet += amount;
        totalLabaBersih += profit;
    });

    const totalTrx = filteredOrders.length;
    const successRate = totalTrx > 0 ? ((successOrders.length / totalTrx) * 100).toFixed(1) : '0.0';
    const marginPercent = totalOmzet > 0 ? ((totalLabaBersih / totalOmzet) * 100).toFixed(1) : '0.0';
    const avgProfit = successOrders.length > 0 ? Math.round(totalLabaBersih / successOrders.length) : 0;

    return {
        range,
        rangeLabel,
        totalOrders: totalTrx,
        successCount: successOrders.length,
        failedCount: failedOrders.length,
        pendingCount: pendingOrders.length,
        omzet: totalOmzet,
        labaBersih: totalLabaBersih,
        successRate: Number(successRate),
        marginPercent: Number(marginPercent),
        avgProfitPerTrx: avgProfit,
        successOrders,
        failedOrders
    };
}

/**
 * Pengecekan Laba Bersih & Rincian Transaksi pada Satu Tanggal Tertentu
 * @param {string} dateInput - 'DD-MM-YYYY', 'YYYY-MM-DD', 'kemarin', dll
 */
function getDayStats(dateInput, dbOverride = null) {
    const rangeInfo = parseDateRange(dateInput);
    if (!rangeInfo) return { success: false, message: 'Format tanggal tidak valid. Contoh format: 19-09-2026 atau 2026-09-19' };

    const db = getDb(dbOverride);
    const orders = db.orders || [];
    const ppobCatalog = db.ppob || [];

    const dayOrders = orders.filter(o => {
        const t = Number(o.timestamp || o.doneAt || 0);
        return t >= rangeInfo.start && t <= rangeInfo.end;
    });

    const successOrders = dayOrders.filter(o => o.status === 'success');
    const failedOrders = dayOrders.filter(o => o.status === 'failed' || o.status === 'cancelled');
    const pendingOrders = dayOrders.filter(o => o.status === 'pending' || o.status === 'processing');

    let totalOmzet = 0;
    let totalLabaBersih = 0;
    const itemMap = {};

    successOrders.forEach(o => {
        const amount = Number(o.baseAmount || o.total || 0);
        const profit = calculateOrderProfit(o, ppobCatalog);
        totalOmzet += amount;
        totalLabaBersih += profit;

        const key = o.item || o.sku || 'Produk Lain';
        if (!itemMap[key]) {
            itemMap[key] = { name: key, qty: 0, omzet: 0, profit: 0 };
        }
        itemMap[key].qty += Number(o.qty || 1);
        itemMap[key].omzet += amount;
        itemMap[key].profit += profit;
    });

    const itemsSold = Object.values(itemMap).sort((a, b) => b.qty - a.qty);

    return {
        success: true,
        dateInput,
        dateFormatted: rangeInfo.formattedDate,
        totalOrders: dayOrders.length,
        successCount: successOrders.length,
        failedCount: failedOrders.length,
        pendingCount: pendingOrders.length,
        omzet: totalOmzet,
        labaBersih: totalLabaBersih,
        marginPercent: totalOmzet > 0 ? ((totalLabaBersih / totalOmzet) * 100).toFixed(1) : '0.0',
        itemsSold
    };
}

/**
 * Laporan Peringkat Produk yang Paling Banyak Dibeli (Top Selling Products)
 * @param {number} limit - Jumlah produk teratas yang diambil (default 10)
 * @param {number} days - Rentang hari filter (0 = all time, 7 = 7 hari terakhir, 30 = 30 hari)
 */
function getTopProducts(limit = 10, days = 0, dbOverride = null) {
    const db = getDb(dbOverride);
    const orders = db.orders || [];
    const ppobCatalog = db.ppob || [];
    const now = Date.now();
    const cutoff = days > 0 ? (now - (days * 86400000)) : 0;

    const successOrders = orders.filter(o => {
        if (o.status !== 'success') return false;
        if (cutoff > 0) {
            const t = Number(o.timestamp || o.doneAt || 0);
            return t >= cutoff;
        }
        return true;
    });

    const productMap = {};

    successOrders.forEach(o => {
        const name = o.item || o.sku || 'Item Tanpa Nama';
        const qty = Number(o.qty || 1);
        const amount = Number(o.baseAmount || o.total || 0);
        const profit = calculateOrderProfit(o, ppobCatalog);

        if (!productMap[name]) {
            productMap[name] = {
                name: name,
                sku: o.sku || '-',
                category: o.isPasca ? 'Pascabayar' : (o.isPpob ? 'Prabayar' : 'Digital/Akun'),
                qty: 0,
                omzet: 0,
                profit: 0,
                trxCount: 0
            };
        }

        productMap[name].qty += qty;
        productMap[name].omzet += amount;
        productMap[name].profit += profit;
        productMap[name].trxCount += 1;
    });

    const ranking = Object.values(productMap)
        .sort((a, b) => b.qty - a.qty || b.omzet - a.omzet)
        .slice(0, limit);

    return {
        days,
        periodLabel: days > 0 ? `${days} Hari Terakhir` : 'Semua Waktu',
        totalUniqueProducts: Object.keys(productMap).length,
        ranking
    };
}

/**
 * Laporan Jumlah Nama Produk yang Gagal Transaksi & Analisa Penyebabnya
 * @param {number} limit - Jumlah produk teratas yang diambil (default 10)
 * @param {number} days - Rentang hari filter (0 = all time, 7 = 7 hari, 30 = 30 hari)
 */
function getFailedProducts(limit = 10, days = 0, dbOverride = null) {
    const db = getDb(dbOverride);
    const orders = db.orders || [];
    const now = Date.now();
    const cutoff = days > 0 ? (now - (days * 86400000)) : 0;

    const failedOrders = orders.filter(o => {
        if (o.status !== 'failed' && o.status !== 'cancelled') return false;
        if (cutoff > 0) {
            const t = Number(o.timestamp || o.doneAt || 0);
            return t >= cutoff;
        }
        return true;
    });

    const failMap = {};

    failedOrders.forEach(o => {
        const name = o.item || o.sku || 'Item Tanpa Nama';
        const reason = o.refundReason || o.sn || o.message || o.lastError || 'Alasan tidak tercatat';

        if (!failMap[name]) {
            failMap[name] = {
                name: name,
                sku: o.sku || '-',
                failCount: 0,
                reasons: {}
            };
        }

        failMap[name].failCount += 1;
        failMap[name].reasons[reason] = (failMap[name].reasons[reason] || 0) + 1;
    });

    const ranking = Object.values(failMap)
        .sort((a, b) => b.failCount - a.failCount)
        .slice(0, limit)
        .map(item => {
            // Urutkan alasan kegagalan dari yang paling sering
            const topReasons = Object.entries(item.reasons)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([reason, count]) => `${reason} (${count}x)`);

            return {
                name: item.name,
                sku: item.sku,
                failCount: item.failCount,
                topReasons: topReasons.join(', ') || 'Gangguan'
            };
        });

    return {
        days,
        periodLabel: days > 0 ? `${days} Hari Terakhir` : 'Semua Waktu',
        totalFailedTrx: failedOrders.length,
        ranking
    };
}

/**
 * Laporan Peringkat Transaksi Terbanyak per Member (Top Buyers)
 * @param {number} limit - Jumlah member teratas (default 10)
 * @param {number} days - Rentang hari filter
 */
function getTopMembers(limit = 10, days = 0, dbOverride = null) {
    const db = getDb(dbOverride);
    const orders = db.orders || [];
    const ppobCatalog = db.ppob || [];
    const now = Date.now();
    const cutoff = days > 0 ? (now - (days * 86400000)) : 0;

    const successOrders = orders.filter(o => {
        if (o.status !== 'success') return false;
        if (cutoff > 0) {
            const t = Number(o.timestamp || o.doneAt || 0);
            return t >= cutoff;
        }
        return true;
    });

    const buyerMap = {};

    successOrders.forEach(o => {
        const buyer = o.buyer || o.sender || '';
        if (!buyer) return;

        const cleanPhone = String(buyer).replace(/[^0-9]/g, '');
        if (!cleanPhone || cleanPhone.length < 8) return;

        const amount = Number(o.baseAmount || o.total || 0);
        const profit = calculateOrderProfit(o, ppobCatalog);

        if (!buyerMap[cleanPhone]) {
            const userObj = db.users ? (db.users[cleanPhone] || db.users[`${cleanPhone}@s.whatsapp.net`] || {}) : {};
            buyerMap[cleanPhone] = {
                phone: cleanPhone,
                name: userObj.name || userObj.nama || '',
                trxCount: 0,
                totalBelanja: 0,
                totalProfit: 0
            };
        }

        buyerMap[cleanPhone].trxCount += 1;
        buyerMap[cleanPhone].totalBelanja += amount;
        buyerMap[cleanPhone].totalProfit += profit;
    });

    const ranking = Object.values(buyerMap)
        .sort((a, b) => b.trxCount - a.trxCount || b.totalBelanja - a.totalBelanja)
        .slice(0, limit);

    return {
        days,
        periodLabel: days > 0 ? `${days} Hari Terakhir` : 'Semua Waktu',
        totalActiveBuyers: Object.keys(buyerMap).length,
        ranking
    };
}

/**
 * Menghasilkan teks laporan keuangan harian (P&L) komprehensif untuk Telegram Admin
 */
function generateFinancialReportText(dateInput = 'today', balances = {}) {
    const stats = getDayStats(dateInput);
    if (!stats || !stats.success) {
        return `⚠️ Gagal menghasilkan laporan keuangan untuk tanggal: ${dateInput}`;
    }

    const db = getDb();
    const omzet = stats.omzet || 0;
    const profit = stats.labaBersih || 0;
    const modal = Math.max(0, omzet - profit);
    const margin = stats.marginPercent || '0.0';

    // Hitung total liabilitas saldo user yang mengendap di bot
    let totalUserSaldo = 0;
    let totalUsersCount = 0;
    if (db.users && typeof db.users === 'object') {
        for (const u of Object.values(db.users)) {
            if (u && typeof u === 'object' && !u.isBot) {
                totalUserSaldo += Number(u.saldo || 0);
                totalUsersCount++;
            }
        }
    }

    const digiBalance = balances.digiflazz !== undefined ? formatRupiah(balances.digiflazz) : (balances.digiflazzStr || 'Memeriksa...');
    const gatewayBalance = balances.gateway !== undefined ? formatRupiah(balances.gateway) : (balances.gatewayStr || 'Memeriksa...');

    let t = `📊 *LAPORAN KEUANGAN & LABA BERSIH (P&L)*\n`;
    t += `📅 Periode: *${stats.dateFormatted}*\n`;
    t += `────────────────────────────\n\n`;

    t += `📈 *RINGKASAN OMSET & PROFIT:*\n`;
    t += `• Total Omset Kotor : *${formatRupiah(omzet)}*\n`;
    t += `• Total Modal Biller : *${formatRupiah(modal)}*\n`;
    t += `• 💰 *Laba Bersih*  : *${formatRupiah(profit)}* (${margin}%)\n\n`;

    t += `📦 *VOLUME TRANSAKSI:*\n`;
    t += `• Transaksi Sukses : *${stats.successCount}* Trx\n`;
    t += `• Transaksi Gagal  : *${stats.failedCount}* Trx\n`;
    t += `• Transaksi Proses : *${stats.pendingCount}* Trx\n`;
    t += `• Total Aktivitas  : *${stats.totalOrders}* Trx\n\n`;

    if (Array.isArray(stats.itemsSold) && stats.itemsSold.length > 0) {
        t += `🏆 *TOP 3 PRODUK TERLARIS:*\n`;
        stats.itemsSold.slice(0, 3).forEach((item, idx) => {
            t += `${idx + 1}. *${item.name}* (${item.qty}x) ➔ Profit: ${formatRupiah(item.profit)}\n`;
        });
        t += `\n`;
    }

    t += `🏦 *STATUS SALDO PROVIDER & SISTEM:*\n`;
    t += `• Saldo Digiflazz   : *${digiBalance}*\n`;
    t += `• Saldo Gateway     : *${gatewayBalance}*\n`;
    t += `• Liabilitas Member : *${formatRupiah(totalUserSaldo)}* (${totalUsersCount} Pengguna)\n\n`;

    if (balances.digiflazz !== undefined && Number(balances.digiflazz) < 100000) {
        t += `⚠️ *PERINGATAN:* Saldo Digiflazz Anda tersisa di bawah Rp 100.000. Segera lakukan topup tiket deposit!\n\n`;
    }

    t += `_Laporan otomatis digenerate oleh Bot Command Center._`;
    return t;
}

module.exports = {
    calculateOrderProfit,
    parseDateRange,
    getStatsSummary,
    getDayStats,
    getTopProducts,
    getFailedProducts,
    getTopMembers,
    generateFinancialReportText
};
