const db = require('../database/db');
const { formatRupiah, detectOperator } = require('../lib/utils');
const api = require('../lib/api');
const config = require('../config');
const legal = require('../lib/legal');
const subLib = require('../lib/subscription');
const receiptLib = require('../lib/receipt');
const debtLib = require('../lib/debt');
const quickOrder = require('../lib/quick_order');
const mutex = require('../lib/mutex');

// System Session (State Machine)
const S = {
    IDLE: 0,
    PILIH_KATEGORI: 1,
    INPUT_TARGET_PULSA: 2,
    PILIH_PRODUK_PULSA: 3,
    PILIH_BRAND_EMONEY: 4,
    INPUT_TARGET_EMONEY: 5,
    PILIH_PRODUK_EMONEY: 6,
    PILIH_PRODUK_DIGITAL: 7,
    QTY_DIGITAL: 8,
    CONFIRM: 9,
    INPUT_DEPOSIT: 10,
    PILIH_KATEGORI_PASCA: 11,
    INPUT_TARGET_PASCA: 12,
    PILIH_PRODUK_PASCA: 13,
    PILIH_SUB_MENU: 14,
    PILIH_PRODUK_SUBS: 15,
    INPUT_TARGET_SUBS: 16,
    PILIH_INTERVAL_SUBS: 17,
    PILIH_CYCLES_SUBS: 18,
    CONFIRM_SUBS: 19
};

// --- ENGINE CERDAS UNTUK SORTING & GROUPING OTOMATIS ---
function parseProduct(name, brand) {
    let cleanName = name;
    if (brand) {
        // Hapus nama awalan brand agar tidak boros teks (Contoh: "XL " dihapus)
        const re = new RegExp(`^${brand}\\s*`, 'i');
        cleanName = cleanName.replace(re, '').trim();
    }
    
    // Cari angka masa aktif (Contoh: "28 Hari", "5 Hr", "1 Bulan")
    let validityMatch = cleanName.match(/(\d+)\s*(hari|hr|bulan|bln)/i);
    let validityDays = 999; // Default jika tidak ada masa aktif
    if (validityMatch) {
        let val = parseInt(validityMatch[1]);
        let unit = validityMatch[2].toLowerCase();
        if (unit.startsWith('bul') || unit.startsWith('bln')) val *= 30;
        validityDays = val;
    }

    // Ekstrak nama paket (Potong kata sebelum besaran GB/MB atau nominal angka)
    let groupName = "UMUM";
    let groupMatch = cleanName.match(/^(.*?)(?=\s*\d+(\.\d+)?\s*(GB|MB|Hari|Hr))/i);
    if (groupMatch && groupMatch[1].trim()) {
        groupName = groupMatch[1].trim();
    } else {
        // Jika tidak ada GB/MB, ambil 2 kata pertama sebagai kelompok
        let words = cleanName.split(' ');
        if (words.length > 1) groupName = words.slice(0, 2).join(' ');
        else groupName = cleanName;
    }

    // SMART QUOTA DETECTOR
    let quotaGb = 0;
    let quotaMb = 0;

    const gbMatch =
        cleanName.match(/(\d+(\.\d+)?)\s*GB/i);

    if (gbMatch) {
        quotaGb =
            parseFloat(gbMatch[1]);
    }

    const mbMatch =
        cleanName.match(/(\d+(\.\d+)?)\s*MB/i);

    if (mbMatch) {
        quotaMb =
            parseFloat(mbMatch[1]);
    }

    return {
        cleanName,
        validityDays,
        quotaGb,
        quotaMb,
        groupName:
            groupName.toUpperCase()
    };
}

// --- SMART FILTER & SEARCH ENGINE ---
function filterSmartProducts(sourceProducts, rawKeyword) {
    if (!rawKeyword || !Array.isArray(sourceProducts) || sourceProducts.length === 0) {
        return null;
    }

    const keyword = rawKeyword.toLowerCase().trim();

    // 1. Filter Kuota: e.g. "2gb", "2 gb", "1.5gb", "500mb"
    const gbMatch = keyword.match(/^(\d+(?:\.\d+)?)\s*(gb|giga|gigabyte)$/i);
    const mbMatch = keyword.match(/^(\d+(?:\.\d+)?)\s*(mb|mega|megabyte)$/i);
    if (gbMatch) {
        const targetGb = parseFloat(gbMatch[1]);
        const matched = sourceProducts
            .filter(p => (p.quotaGb && p.quotaGb > 0) || (p.nama && p.nama.toLowerCase().includes(`${targetGb}gb`)))
            .sort((a, b) => {
                const aDiff = Math.abs((a.quotaGb || 0) - targetGb);
                const bDiff = Math.abs((b.quotaGb || 0) - targetGb);
                if (aDiff !== bDiff) return aDiff - bDiff;
                return a.hargaJual - b.hargaJual;
            });
        if (matched.length > 0) return matched.slice(0, 10);
    } else if (mbMatch) {
        const targetMb = parseFloat(mbMatch[1]);
        const matched = sourceProducts
            .filter(p => (p.quotaMb && p.quotaMb > 0) || (p.nama && p.nama.toLowerCase().includes(`${targetMb}mb`)))
            .sort((a, b) => {
                const aDiff = Math.abs((a.quotaMb || 0) - targetMb);
                const bDiff = Math.abs((b.quotaMb || 0) - targetMb);
                if (aDiff !== bDiff) return aDiff - bDiff;
                return a.hargaJual - b.hargaJual;
            });
        if (matched.length > 0) return matched.slice(0, 10);
    }

    // 2. Filter Masa Aktif: e.g. "30hari", "30 hari", "30h", "7h", "7hari", "1hari"
    const hariMatch = keyword.match(/^(\d+)\s*(h|hari|hr|day|days)$/i);
    if (hariMatch) {
        const targetHari = parseInt(hariMatch[1], 10);
        const matched = sourceProducts
            .filter(p => p.validityDays && p.validityDays > 0 && p.validityDays !== 999)
            .sort((a, b) => {
                const aDiff = Math.abs((a.validityDays || 0) - targetHari);
                const bDiff = Math.abs((b.validityDays || 0) - targetHari);
                if (aDiff !== bDiff) return aDiff - bDiff;
                return a.hargaJual - b.hargaJual;
            });
        if (matched.length > 0) return matched.slice(0, 10);
    }

    // 3. Filter Harga: e.g. "50k", "50 k", "50rb", "50 rb", "50000", "25k"
    const hargaMatch = keyword.match(/^(?:rp\.?\s*)?(\d+)\s*(k|rb|ribu)?$/i);
    if (hargaMatch) {
        let val = parseInt(hargaMatch[1], 10);
        const unit = (hargaMatch[2] || '').toLowerCase();
        if (unit === 'k' || unit === 'rb' || unit === 'ribu') {
            val *= 1000;
        } else if (val < 1000) {
            val *= 1000;
        }
        const matched = [...sourceProducts]
            .sort((a, b) => {
                const aDiff = Math.abs(a.hargaJual - val);
                const bDiff = Math.abs(b.hargaJual - val);
                if (aDiff !== bDiff) return aDiff - bDiff;
                return a.hargaJual - b.hargaJual;
            });
        if (matched.length > 0) return matched.slice(0, 10);
    }

    // 4. Pencarian Teks / Nama Paket (e.g. "akrab", "combo", "unlimited", "booster")
    let matched = sourceProducts.filter(p => {
        const nama = (p.nama || '').toLowerCase();
        const clean = (p.cleanName || '').toLowerCase();
        const group = (p.groupName || '').toLowerCase();
        return nama.includes(keyword) || clean.includes(keyword) || group.includes(keyword);
    });

    if (matched.length === 0) {
        const words = keyword.split(/\s+/).filter(Boolean);
        if (words.length > 1) {
            matched = sourceProducts.filter(p => {
                const combined = ((p.nama || '') + ' ' + (p.cleanName || '') + ' ' + (p.groupName || '')).toLowerCase();
                return words.every(w => combined.includes(w));
            });
        }
    }

    if (matched.length > 0) {
        matched.sort((a, b) => {
            const aExact = (a.nama || '').toLowerCase().includes(keyword) ? 1 : 0;
            const bExact = (b.nama || '').toLowerCase().includes(keyword) ? 1 : 0;
            if (aExact !== bExact) return bExact - aExact;
            return a.hargaJual - b.hargaJual;
        });
        return matched.slice(0, 10);
    }

    return [];
}

async function showProductList(sock, sender, session) {
    const perPage = 10;
    const total = session.tempList.length;
    const maxPage = Math.ceil(total / perPage) - 1;
    
    if (session.tempPage > maxPage) session.tempPage = 0; // Kembali ke awal jika kelewatan
    
    const start = session.tempPage * perPage;
    const end = start + perPage;
    const pageItems = session.tempList.slice(start, end);
    
    let t = `📱 *KATALOG ${session.tempOp || session.tempBrand}*\n`;
    if (session.tempSearchKeyword) {
        t += `🔍 *Hasil Filter:* "${session.tempSearchKeyword}" (${total} paket ditemukan)\n`;
    }
    t += `Halaman *${session.tempPage + 1}* dari *${maxPage + 1}*\n`;
    
    let currentGroup = "";
    pageItems.forEach((p, idx) => {
        let globalIdx = start + idx + 1; // Angka urutan (1, 2, 3...)
        if (p.groupName && p.groupName !== currentGroup) {
            t += `\n*-- ${p.groupName} --*\n`;
            currentGroup = p.groupName;
        }
        t += `*${globalIdx}.* ${p.cleanName}\n   💰 ${formatRupiah(p.hargaJual)}\n`;
    });
    
    t += `\n👉 Balas *Angka (1 - ${pageItems.length})* produk pilihan Anda.`;

    if (session.tempSmartMode || session.tempSearchKeyword) {
        t += `\n➡️ Ketik *LANJUT* untuk melihat seluruh paket ${session.tempOp || session.tempBrand || ''}.`;
    } else if (maxPage > 0) {
        t += `\n➡️ Ketik *LANJUT* atau *HAL ${session.tempPage + 2}* untuk halaman berikutnya (${session.tempPage + 1}/${maxPage + 1}).`;
    }

    if (session.tempTipe === 'Data') {
        t += `\n💡 *Tips Cari Cepat:* Ketik kuota/harga (cth: *2gb*, *30hari*, *50k*, *combo*).`;
    } else if (session.tempTipe === 'Pulsa' || session.tempTipe === 'E-Money') {
        t += `\n💡 *Tips Cari Cepat:* Ketik nominal (cth: *10k*, *50k*, *100k*).`;
    }
    
    await sock.sendMessage(sender, { text: t });
}

async function handleUser(sock, sender, text, session, processCheckout) {
    const rawTrim = text.trim();
    const txt = rawTrim.toUpperCase();
    const parts = rawTrim.split(/\s+/);
    const cmdFirst = parts[0].toUpperCase();

    // 0. QUICK USER COMMANDS
    if (['.SNKDIGITAL', '!SNKDIGITAL', 'SNKDIGITAL', '.DIGITAL', '!DIGITAL', 'DIGITAL', '.ATURANAKUN', '!ATURANAKUN', 'ATURANAKUN'].includes(txt)) {
        return sock.sendMessage(sender, { text: legal.getTermsDigitalWA() });
    }

    if (['.SNK', '!SNK', 'SNK', '.TOS', '!TOS', 'TOS', '.ATURAN', '!ATURAN', 'ATURAN', '.SYARAT', '!SYARAT', 'SYARAT'].includes(txt)) {
        return sock.sendMessage(sender, { text: legal.getTermsAndConditionsWA() });
    }

    if (['.HELP', '!HELP', 'HELP', '.BANTUAN', '!BANTUAN', 'BANTUAN'].includes(txt)) {
        let t = `📖 *PANDUAN TRANSAKSI INSTAN*\n\n`;
        t += `• *MENU* : Buka menu belanja interaktif\n`;
        t += `• *.beli [Kode_Produk] [NoHP]* : Transaksi cepat instan\n`;
        t += `• *.harga [Operator]* : Cek daftar harga & kode produk\n`;
        t += `• *.langganan* : Beli produk auto-order / langganan berkala\n`;
        t += `• *.batallangganan [ID]* : Berhenti berlangganan otomatis\n`;
        t += `• *.deposit* : Isi saldo akun via QRIS otomatis\n`;
        t += `• *.profil* : Cek saldo dompet Anda\n`;
        t += `• *.riwayat* : Cek 5 transaksi terakhir\n`;
        t += `• *.status [Invoice]* : Cek status transaksi / token\n`;
        t += `• *.transfer [NoHP] [Nominal]* : Kirim saldo ke member\n`;
        t += `• *.snk* : Syarat & Ketentuan Umum Layanan (PPOB & Toko)\n`;
        t += `• *.snkdigital* : S&K Khusus Akun Digital (1 Device & Garansi)\n`;
        t += `• *B* : Batalkan transaksi yang sedang berjalan\n\n`;
        t += `🏪 *${db.store.namaToko || 'DIGITAL STORE'}* - Aman, Cepat, dan Otomatis.`;
        return sock.sendMessage(sender, { text: t });
    }

    // FAST ORDER: .beli [Kode_Produk] [NoHP]
    if (['.BELI', '!BELI', 'BELI'].includes(cmdFirst)) {
        const sku = (parts[1] || '').trim();
        const target = (parts[2] || '').trim().replace(/[^0-9]/g, '');
        if (!sku || !target) {
            return sock.sendMessage(sender, {
                text: `🛒 *FORMAT TRANSAKSI INSTAN:*\n.beli [Kode_Produk] [Nomor_Tujuan]\n\nContoh:\n• .beli S10 081234567890\n• .beli PLN20 123456789012\n\n_Ketik *.harga [operator]* untuk melihat daftar kode produk aktif._`
            });
        }
        const product = (db.ppob || []).find(p => p.sku && p.sku.toUpperCase() === sku.toUpperCase())
                     || (db.menu || []).find(m => m.id == sku || (m.nama && m.nama.toUpperCase().includes(sku.toUpperCase())));
        if (!product) {
            return sock.sendMessage(sender, {
                text: `❌ Produk dengan kode *${sku}* tidak ditemukan.\nKetik *.harga* untuk melihat daftar produk aktif.`
            });
        }

        // 🛡️ Cek stok untuk produk digital manual
        if (!product.sku && (product.stok <= 0 || (product.data && product.data.length === 0))) {
            return sock.sendMessage(sender, {
                text: `❌ Maaf, stok untuk produk *${product.nama}* sedang habis.`
            });
        }

        session.tempItem = product;
        session.tempTarget = target;
        session.tempQty = 1;
        session.step = S.CONFIRM;
        return showInvoice(sock, sender, session);
    }

    // FAST PRICE LIST: .harga [operator/kategori]
    if (['.HARGA', '!HARGA', 'HARGA'].includes(cmdFirst)) {
        const query = (parts.slice(1).join(' ') || '').toUpperCase().trim();
        let list = db.ppob || [];
        if (query) {
            list = list.filter(p => 
                (p.brand && p.brand.toUpperCase().includes(query)) ||
                (p.kategori && p.kategori.toUpperCase().includes(query)) ||
                (p.nama && p.nama.toUpperCase().includes(query))
            );
        }
        if (list.length === 0) {
            return sock.sendMessage(sender, {
                text: `❌ Tidak ditemukan produk untuk kata kunci *${query}*.\nContoh pencarian:\n.harga tsel\n.harga indosat\n.harga pln\n.harga dana`
            });
        }
        const topItems = list.slice(0, 15);
        let t = `📋 *DAFTAR HARGA PPOB ${query ? '(' + query + ')' : ''}*\n\n`;
        topItems.forEach((p, i) => {
            t += `*${i+1}.* ${p.nama}\n   SKU: \`${p.sku}\` | 💰 *${formatRupiah(p.hargaJual)}*\n`;
        });
        t += `\n🛒 *Beli Cepat:* .beli [SKU] [NoHP]\nContoh: .beli ${topItems[0].sku} 0812xxxx`;
        return sock.sendMessage(sender, { text: t });
    }

    // CHECK ORDER STATUS: .status [id]
    if (['.STATUS', '!STATUS', 'STATUS', '.CEK', '!CEK', 'CEK'].includes(cmdFirst) && parts[1]) {
        const orderId = parts[1].trim();
        const order = (db.orders || []).find(o => o.id && o.id.toUpperCase() === orderId.toUpperCase());
        if (!order) {
            return sock.sendMessage(sender, { text: `❌ Order ID *${orderId}* tidak ditemukan.` });
        }

        // 🛡️ ANTI-IDOR SHIELD: Validasi Otorisasi Kepemilikan Invoice
        const canonicalSender = db.normalizeJid ? db.normalizeJid(sender) : sender;
        const isBuyer = (order.buyer === sender || order.buyer === canonicalSender);
        const isOwner = (config.owner || []).some(o => {
            const normO = db.normalizeJid ? db.normalizeJid(o) : o;
            return normO === canonicalSender || o === sender;
        });

        if (!isBuyer && !isOwner) {
            return sock.sendMessage(sender, {
                text: `🔒 *AKSES DITOLAK*\n\nAnda tidak memiliki izin untuk melihat detail invoice ini karena bukan milik akun Anda.`
            });
        }

        let t = `🔎 *STATUS TRANSAKSI*\n\n`;
        t += `🧾 Invoice: \`${order.id}\`\n`;
        t += `📦 Produk: ${order.item || order.sku}\n`;
        t += `🎯 Tujuan: ${order.target || '-'}\n`;
        t += `💰 Total: ${formatRupiah(order.baseAmount || order.total || 0)}\n`;
        t += `📌 Status: *${String(order.status).toUpperCase()}*\n`;
        if (order.sn) t += `🔑 SN / Token: \`${order.sn}\`\n`;
        if (order.timestamp) t += `🕒 Waktu: ${new Date(order.timestamp).toLocaleString('id-ID')}\n`;
        return sock.sendMessage(sender, { text: t });
    }

    // USER TRANSACTION HISTORY: .riwayat
    if (['.RIWAYAT', '!RIWAYAT', 'RIWAYAT'].includes(txt)) {
        const realJid = db.normalizeJid ? db.normalizeJid(sender) : sender;
        const userOrders = (db.orders || [])
            .filter(o => o.buyer === realJid || o.buyer === sender)
            .slice(-5)
            .reverse();
        if (userOrders.length === 0) {
            return sock.sendMessage(sender, { text: "📦 Anda belum memiliki riwayat transaksi." });
        }
        let t = `🧾 *5 TRANSAKSI TERAKHIR ANDA*\n\n`;
        userOrders.forEach((o, i) => {
            const dateStr = o.timestamp ? new Date(o.timestamp).toLocaleString('id-ID') : '-';
            const icon = o.status === 'success' ? '✅' : o.status === 'failed' ? '❌' : '⏳';
            t += `*${i+1}.* ${icon} *${o.item || o.sku}*\n`;
            t += `   Inv: \`${o.id}\`\n`;
            t += `   Target: ${o.target || '-'}\n`;
            t += `   Total: ${formatRupiah(o.baseAmount || o.total || 0)}\n`;
            t += `   Status: *${String(o.status).toUpperCase()}*\n`;
            if (o.sn) t += `   SN/Token: \`${o.sn}\`\n`;
            t += `   Waktu: ${dateStr}\n\n`;
        });
        return sock.sendMessage(sender, { text: t });
    }

    // MEMBER BALANCE TRANSFER: .transfer [NoHP] [Nominal]
    if (['.TRANSFER', '!TRANSFER', 'TRANSFER'].includes(cmdFirst)) {
        let targetNo = (parts[1] || '').trim().replace(/[^0-9]/g, '');
        const nom = parseInt(parts[2]);
        if (!targetNo || isNaN(nom) || nom < 1000 || nom > 50000000) {
            return sock.sendMessage(sender, {
                text: `💸 *FORMAT TRANSFER SALDO:*\n.transfer [Nomor_Tujuan] [Nominal]\n\nContoh:\n.transfer 08123456789 10000\n\n📌 _Minimal transfer Rp1.000 (Maks Rp50.000.000)_`
            });
        }
        if (targetNo.startsWith('0')) targetNo = '62' + targetNo.slice(1);
        
        const senderUser = db.getUser ? db.getUser(sender) : (db.users[sender] || (db.users[sender] = { saldo: 0 }));
        const senderPhone = (senderUser.phone || sender.split('@')[0].split(':')[0]).replace(/[^0-9]/g, '');
        
        // 🛡️ CEGAH TRANSFER KE DIRI SENDIRI
        if (targetNo === senderPhone) {
            return sock.sendMessage(sender, { text: "❌ Tidak dapat mentransfer saldo ke nomor Anda sendiri." });
        }

        // 🛡️ DEDUCTION ATOMIK: Menjamin saldo cukup dan bebas race condition
        const deductRes = db.deductSaldo(sender, nom, `TRF-${targetNo}`, `Transfer ke ${targetNo}`);
        if (!deductRes.success) {
            return sock.sendMessage(sender, {
                text: `❌ Transfer gagal: ${deductRes.reason}.\nSaldo Anda saat ini: ${formatRupiah(deductRes.saldo || senderUser.saldo || 0)}`
            });
        }

        const targetJid = targetNo.includes('@') ? targetNo : targetNo + '@s.whatsapp.net';
        const targetUser = db.getUser ? db.getUser(targetJid) : (db.users[targetJid] || (db.users[targetJid] = { saldo: 0, phone: targetNo }));
        targetUser.saldo = (Number(targetUser.saldo) || 0) + nom;
        if (!Array.isArray(targetUser.history)) targetUser.history = [];
        const dateStr = new Date().toLocaleDateString('id-ID');
        targetUser.history.push(`[${dateStr}] 🟢 Terima Transfer (+Rp ${nom.toLocaleString('id-ID')}) dari ${senderPhone}`);
        db.saveUsers();

        await sock.sendMessage(sender, {
            text: `✅ *TRANSFER SALDO BERHASIL*\n\n🎯 Tujuan: ${targetNo}\n💰 Nominal: ${formatRupiah(nom)}\n💵 Sisa Saldo: ${formatRupiah(deductRes.remainingSaldo)}`
        });

        await sock.sendMessage(targetJid, {
            text: `🎁 *SALDO MASUK*\n\nAnda menerima transfer saldo sebesar *${formatRupiah(nom)}* dari ${senderPhone}.\n💰 Saldo Baru: ${formatRupiah(targetUser.saldo)}`
        }).catch(()=>{});
        return;
    }

    // SUBSCRIPTION COMMANDS
    if (['.LANGGANAN', '!LANGGANAN', 'LANGGANAN', '.SUBS', '!SUBS', 'SUBS'].includes(cmdFirst)) {
        session.step = S.PILIH_SUB_MENU;
        let t = `🔄 *LAYANAN PRODUK BERLANGGANAN (AUTO-ORDER)*\n\n`;
        t += `Beli produk secara rutin tanpa repot order manual berkala. Saldo akun Anda akan terpotong otomatis setiap jatuh tempo.\n\n`;
        t += `*PILIH MENU LANGGANAN:*\n`;
        t += `*1.* 📋 Beli Produk Berlangganan Baru\n`;
        t += `*2.* 📑 Cek / Kelola Langganan Aktif Saya\n`;
        t += `*3.* ⏹️ Batalkan Langganan\n\n`;
        t += `Balas *Angka (1 - 3)* untuk memilih.\nKetik *0* atau *B* untuk batal.`;
        return sock.sendMessage(sender, { text: t });
    }

    if (['.BATALLANGGANAN', '!BATALLANGGANAN', 'BATALLANGGANAN', '.STOPSUB', '!STOPSUB', 'STOPSUB'].includes(cmdFirst)) {
        const subId = (parts[1] || '').trim();
        if (!subId) {
            return sock.sendMessage(sender, {
                text: `⏹️ *FORMAT BATAL LANGGANAN:*\n.batallangganan [ID_LANGGANAN]\n\nContoh:\n.batallangganan SUB-123456\n\n_Ketik *.langganan* untuk melihat daftar ID langganan aktif Anda._`
            });
        }
        const userSubs = subLib.getUserSubscriptions(sender);
        const targetSub = userSubs.find(s => s.id && s.id.toUpperCase() === subId.toUpperCase());
        if (!targetSub) {
            return sock.sendMessage(sender, {
                text: `❌ Kontrak langganan dengan ID *${subId}* tidak ditemukan atau bukan milik akun Anda.\nKetik *.langganan* untuk melihat daftar langganan aktif Anda.`
            });
        }
        const cancelRes = subLib.cancelSubscription(targetSub.id, 'Dibatalkan oleh pembeli via WhatsApp', 'user');
        if (cancelRes.success) {
            return sock.sendMessage(sender, {
                text: `✅ *LANGGANAN BERHASIL DIBATALKAN*\n\n` +
                      `• ID Langganan : \`${targetSub.id}\`\n` +
                      `• Produk       : *${targetSub.productName}*\n` +
                      `• Target       : \`${targetSub.target}\`\n\n` +
                      `Sistem tidak akan lagi memotong saldo Anda untuk produk ini.`
            });
        } else {
            return sock.sendMessage(sender, { text: `❌ Gagal membatalkan langganan: ${cancelRes.reason || cancelRes.message}` });
        }
    }

    // STRUK COMMAND (.struk atau .struk [INV] atau .strukteks)
    if (['.STRUK', '!STRUK', 'STRUK', '.STRUKTEKS', '!STRUKTEKS', 'STRUKTEKS'].includes(cmdFirst)) {
        const isTextOnly = cmdFirst.includes('TEKS');
        const query = (parts[1] || '').trim();
        const orders = db.orders || [];
        const cleanSender = db.normalizeJid ? db.normalizeJid(sender) : sender;

        let targetOrder = null;
        if (query) {
            targetOrder = orders.find(o => 
                (o.id && o.id.toUpperCase() === query.toUpperCase()) ||
                (o.oid && o.oid.toUpperCase() === query.toUpperCase()) ||
                (o.digiflazz_oid && o.digiflazz_oid.toUpperCase() === query.toUpperCase())
            );
        } else {
            // Ambil order sukses terakhir milik user ini
            targetOrder = [...orders].reverse().find(o => 
                (o.buyer === sender || o.buyer === cleanSender || o.sender === sender) && 
                o.status === 'success'
            );
        }

        if (!targetOrder) {
            return sock.sendMessage(sender, {
                text: `❌ *STRUK TIDAK DITEMUKAN*\n\nBelum ada transaksi sukses yang dapat dicetak struk.\nKetik *.struk [NO_INVOICE]* jika ingin mencetak invoice tertentu.\nContoh: \`.struk INV-123456\``
            });
        }

        const u = db.getUser(sender);
        const warungProfile = u.warung || {};
        const finalPrice = Number(warungProfile.customPrice || targetOrder.customPrice || targetOrder.baseAmount || targetOrder.total || 0);

        if (isTextOnly) {
            const textReceipt = receiptLib.generateTextReceipt(targetOrder, warungProfile, 32);
            let reply = `🧾 *STRUK PEMBAYARAN THERMAL (58mm)*\n\n`;
            reply += `\`\`\`\n${textReceipt}\n\`\`\`\n\n`;
            reply += `💡 *Tips Warung:*\n`;
            reply += `• Format Dokumen PDF Resmi : Ketik *.struk*\n`;
            reply += `• Ganti Nama Toko : Ketik *.setnamatoko [Nama Warung]*\n`;
            reply += `• Atur Harga Jual : Ketik *.strukharga [Harga]* (cth: *.strukharga 12000*)`;
            return sock.sendMessage(sender, { text: reply });
        }

        try {
            const pdfBuffer = await receiptLib.generatePdfReceiptBuffer(targetOrder, warungProfile);
            const invName = targetOrder.id || targetOrder.oid || 'TRX';
            const fileName = `Struk-${invName}.pdf`;

            let caption = `🧾 *STRUK PEMBAYARAN RESMI*\n\n`;
            caption += `📋 *No. Reff :* \`${invName}\`\n`;
            caption += `📦 *Produk   :* ${targetOrder.item || targetOrder.sku || 'Produk Digital'}\n`;
            caption += `🎯 *Tujuan   :* ${targetOrder.target || '-'}\n`;
            caption += `💰 *Total    :* ${formatRupiah(finalPrice)}\n`;
            caption += `✅ *Status   :* LUNAS / BERHASIL\n\n`;
            caption += `📄 *File PDF Struk siap cetak terlampir di atas.*\n`;
            caption += `Bisa langsung disimpan, dicetak ke printer Bluetooth thermal, atau dikirimkan ke pelanggan.\n\n`;
            caption += `💡 *Kustomisasi Toko Warung:*\n`;
            caption += `• Ganti Nama Toko : Ketik *.setnamatoko [Nama Warung]*\n`;
            caption += `• Atur Harga Jual : Ketik *.strukharga [Harga]* (cth: *.strukharga 12000*)\n`;
            caption += `• Struk Format Teks : Ketik *.strukteks*`;

            return await sock.sendMessage(sender, {
                document: pdfBuffer,
                mimetype: 'application/pdf',
                fileName: fileName,
                caption: caption
            });
        } catch (err) {
            console.error('[STRUK_PDF_ERROR]', err);
            // Fallback ke teks jika generate PDF gagal
            const textReceipt = receiptLib.generateTextReceipt(targetOrder, warungProfile, 32);
            let reply = `🧾 *STRUK PEMBAYARAN THERMAL*\n\n`;
            reply += `\`\`\`\n${textReceipt}\n\`\`\`\n\n`;
            reply += `💡 *Kustomisasi Toko Warung:*\n`;
            reply += `• Ganti Nama Toko : Ketik *.setnamatoko [Nama Warung]*\n`;
            reply += `• Atur Harga Jual : Ketik *.strukharga [Harga]* (cth: *.strukharga 12000*)`;
            return sock.sendMessage(sender, { text: reply });
        }
    }

    // SET NAMA TOKO WARUNG UNTUK STRUK (.setnamatoko [Nama Warung])
    if (['.SETNAMATOKO', '!SETNAMATOKO', 'SETNAMATOKO'].includes(cmdFirst)) {
        const newStoreName = parts.slice(1).join(' ').trim();
        if (!newStoreName) {
            return sock.sendMessage(sender, {
                text: `🏪 *FORMAT GANTI NAMA TOKO STRUK:*\n.setnamatoko [Nama Warung Anda]\n\nContoh:\n.setnamatoko Warung Berkah Barokah`
            });
        }

        const u = db.getUser(sender);
        if (!u.warung) u.warung = {};
        u.warung.storeName = newStoreName;
        db.saveUsers();

        return sock.sendMessage(sender, {
            text: `✅ *NAMA TOKO STRUK DIPERBARUI!*\n\nNama Toko di struk Anda telah diatur menjadi:\n🏪 *${newStoreName}*\n\nSetiap kali Anda mengetik *.struk*, nama toko inilah yang akan tercantum di bagian atas struk.`
        });
    }

    // SET HARGA JUAL STRUK (.strukharga [Harga])
    if (['.STRUKHARGA', '!STRUKHARGA', 'STRUKHARGA'].includes(cmdFirst)) {
        const newPrice = parseInt((parts[1] || '').replace(/[^0-9]/g, ''), 10);
        if (isNaN(newPrice) || newPrice <= 0) {
            return sock.sendMessage(sender, {
                text: `💰 *FORMAT UBAH HARGA STRUK:*\n.strukharga [Nominal]\n\nContoh:\n.strukharga 12000\n\n_Digunakan jika Anda ingin menjual kembali produk ke pembeli dengan margin warung Anda._`
            });
        }

        const orders = db.orders || [];
        const cleanSender = db.normalizeJid ? db.normalizeJid(sender) : sender;
        const lastOrder = [...orders].reverse().find(o => 
            (o.buyer === sender || o.buyer === cleanSender || o.sender === sender) && 
            o.status === 'success'
        );

        if (!lastOrder) {
            return sock.sendMessage(sender, { text: `❌ Anda belum memiliki transaksi sukses terakhir untuk diubah harganya.` });
        }

        lastOrder.customPrice = newPrice;
        db.saveOrders();

        return sock.sendMessage(sender, {
            text: `✅ *HARGA STRUK BERHASIL DIATUR!*\n\nHarga pada struk terakhir (\`${lastOrder.id}\`) telah diubah menjadi: *${formatRupiah(newPrice)}*.\n\nKetik *.struk* untuk melihat struk dengan harga baru siap cetak!`
        });
    }

    // BUKU KASBON WARUNG (.kasbon)
    if (['.KASBON', '!KASBON', 'KASBON', '.BON', '!BON', 'BON'].includes(cmdFirst)) {
        const sub = (parts[1] || '').toLowerCase().trim();

        if (sub === 'tambah' || sub === 'add') {
            const debtorName = parts[2] || '';
            const amountRaw = parts[3] || '';
            const note = parts.slice(4).join(' ') || 'Pulsa / Token Listrik';

            if (!debtorName || !amountRaw) {
                return sock.sendMessage(sender, {
                    text: `📝 *FORMAT TAMBAH KASBON:*\n.kasbon tambah [Nama Pelanggan] [Nominal] [Keterangan]\n\nContoh:\n.kasbon tambah Pak Budi 25000 Token PLN 20rb`
                });
            }

            const res = debtLib.addDebt(sender, debtorName, amountRaw, note);
            if (!res.success) {
                return sock.sendMessage(sender, { text: `❌ Gagal mencatat kasbon: ${res.message}` });
            }

            return sock.sendMessage(sender, {
                text: `✅ *CATATAN KASBON TERSIMPAN*\n\n` +
                      `• ID Kasbon    : \`${res.debt.id}\`\n` +
                      `• Pelanggan    : *${res.debt.name}*\n` +
                      `• Nominal      : *${formatRupiah(res.debt.amount)}*\n` +
                      `• Keterangan   : ${res.debt.note}\n\n` +
                      `Ketik *.kasbon list* untuk melihat semua catatan kasbon Anda.`
            });
        }

        if (sub === 'list' || sub === 'daftar' || sub === 'cek') {
            const debts = debtLib.getUserDebts(sender, 'unpaid');
            if (debts.count === 0) {
                return sock.sendMessage(sender, {
                    text: `📑 *BUKU KASBON WARUNG*\n\nAlhamdulillah, saat ini tidak ada catatan kasbon/hutang yang belum lunas. Semuanya lunas!`
                });
            }

            let t = `📑 *BUKU KASBON WARUNG (BELUM LUNAS)*\n\n`;
            t += `Total Piutang: *${formatRupiah(debts.totalAmount)}* (${debts.count} orang)\n`;
            t += `────────────────────────\n`;
            debts.items.forEach((d, idx) => {
                const dateStr = new Date(d.createdAt).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' });
                t += `*${idx + 1}.* *${d.name}* (${formatRupiah(d.amount)})\n`;
                t += `   • ID  : \`${d.id}\`\n`;
                t += `   • Ket : ${d.note} (${dateStr})\n\n`;
            });

            t += `💡 *Tindakan Cepat:*\n`;
            t += `• Tandai Lunas : \`.kasbon lunas [ID]\`\n`;
            t += `• Buat Pesan Tagihan : \`.kasbon ingatkan [ID]\``;

            return sock.sendMessage(sender, { text: t });
        }

        if (sub === 'lunas' || sub === 'bayar') {
            const debtId = (parts[2] || '').trim();
            if (!debtId) {
                return sock.sendMessage(sender, { text: `❌ Masukkan ID Kasbon yang ingin dilunasi.\nContoh: \`.kasbon lunas BON-XXXXX\`` });
            }

            const res = debtLib.markDebtPaid(debtId, sender);
            if (!res.success) {
                return sock.sendMessage(sender, { text: `❌ ${res.message}` });
            }

            return sock.sendMessage(sender, {
                text: `🎉 *KASBON DITANDAI LUNAS!*\n\nKasbon atas nama *${res.debt.name}* sebesar *${formatRupiah(res.debt.amount)}* telah berstatus Lunas.`
            });
        }

        if (sub === 'ingatkan' || sub === 'tagih') {
            const debtId = (parts[2] || '').trim();
            if (!debtId) {
                return sock.sendMessage(sender, { text: `❌ Masukkan ID Kasbon yang ingin diingatkan.\nContoh: \`.kasbon ingatkan BON-XXXXX\`` });
            }

            const u = db.getUser(sender);
            const storeName = u.warung?.storeName || db.store.namaToko || 'Warung Kami';
            const reminderText = debtLib.generateReminderMessage(debtId, sender, storeName);

            if (!reminderText) {
                return sock.sendMessage(sender, { text: `❌ Catatan kasbon dengan ID tersebut tidak ditemukan.` });
            }

            return sock.sendMessage(sender, {
                text: `📲 *DRAF PESAN PENGINGAT SANTUN:*\n_Salin teks di bawah ini lalu teruskan ke WhatsApp pelanggan Anda:_\n\n────────────────\n${reminderText}\n────────────────`
            });
        }

        if (sub === 'hapus' || sub === 'del') {
            const debtId = (parts[2] || '').trim();
            if (!debtId) {
                return sock.sendMessage(sender, { text: `❌ Masukkan ID Kasbon yang ingin dihapus.\nContoh: \`.kasbon hapus BON-XXXXX\`` });
            }

            const res = debtLib.deleteDebt(debtId, sender);
            if (!res.success) {
                return sock.sendMessage(sender, { text: `❌ ${res.message}` });
            }

            return sock.sendMessage(sender, {
                text: `🗑️ Catatan kasbon atas nama *${res.debt.name}* telah dihapus dari buku kasbon Anda.`
            });
        }

        // Tampilan Panduan Kasbon
        let t = `📖 *BUKU KASBON & CATAT HUTANG WARUNG*\n\n`;
        t += `Gunakan fitur ini untuk mencatat bon pulsa/token pelanggan di warung Anda:\n\n`;
        t += `*1. Tambah Kasbon:*\n\`.kasbon tambah [Nama] [Nominal] [Ket]\`\n_Cth: .kasbon tambah Mas Agus 15000 Pulsa Tri_\n\n`;
        t += `*2. Cek Daftar Kasbon:*\n\`.kasbon list\`\n\n`;
        t += `*3. Tandai Sudah Lunas:*\n\`.kasbon lunas [ID_BON]\`\n\n`;
        t += `*4. Buat Pesan Pengingat Ramah:*\n\`.kasbon ingatkan [ID_BON]\`\n\n`;
        t += `*5. Hapus Catatan:*\n\`.kasbon hapus [ID_BON]\``;

        return sock.sendMessage(sender, { text: t });
    }

    // ========================================
    // ⚡ SMART NATURAL LANGUAGE QUICK-ORDER
    // ========================================
    if (session.step === S.IDLE && !['MENU', 'HALO', 'P', 'YY', 'MM', 'JJ', 'KK', 'PP', '#', 'START', 'INFO', 'BOT'].includes(txt)) {
        const quick = quickOrder.parseQuickOrder(text, db.ppob || []);
        if (quick && quick.matched) {
            const user = db.getUser(sender);
            const userSaldo = Number(user.saldo) || 0;
            session.tempItem = quick.product;
            session.tempTarget = quick.target;
            session.tempQty = 1;
            session.step = S.CONFIRM;

            let card = `⚡ *QUICK ORDER TERDETEKSI*\n\n`;
            card += `📦 Produk : *${quick.product.nama}*\n`;
            card += `🎯 Tujuan : *${quick.target}*\n`;
            card += `💰 Total  : *${formatRupiah(quick.product.hargaJual)}*\n`;
            card += `💵 Saldo  : ${formatRupiah(userSaldo)}\n\n`;
            if (userSaldo >= quick.product.hargaJual) {
                card += `💳 *Metode Bayar:* Potong Saldo Otomatis (Instan)\n\n`;
            } else {
                card += `💳 *Metode Bayar:* QRIS Otomatis (BCA, DANA, GoPay, OVO, ShopeePay)\n\n`;
            }
            card += `👉 Balas *1* atau *YA* untuk BAYAR SEKARANG\n👉 Balas *2* atau *B* untuk BATAL\n\n`;
            card += `⚖️ _Membayar berarti menyetujui S&K Layanan. Info: ketik .snk_`;
            return sock.sendMessage(sender, { text: card });
        }
    }

    // 1. MAIN MENU
    if (['MENU', 'HALO', 'P', 'YY', 'MM', 'JJ', 'KK', 'PP', '#', 'START', 'INFO', 'BOT'].includes(txt)) {
        session.step = S.PILIH_KATEGORI;
        let t = `╭── 🛍️ *${db.store.namaToko || 'DIGITAL STORE'}* ──\n│\n`;
        t += `├ *1.* 🌐 Pulsa Reguler (Prabayar)\n`;
        t += `├ *2.* 📶 Paket Data Internet\n`;
        t += `├ *3.* 💸 Topup E-Money & E-Wallet\n`;
        t += `├ *4.* ⚡ Token Listrik PLN (Prabayar)\n`;
        t += `├ *5.* 📑 Tagihan PPOB Pascabayar\n`;
        t += `├ *6.* 📂 Produk Digital (Akun / Aplikasi)\n`;
        t += `├ *7.* 🔄 Produk Berlangganan (Auto-Order)\n`;
        t += `├ *8.* 💰 Isi Saldo (Deposit QRIS)\n`;
        t += `├ *9.* 👤 Profil & Cek Saldo\n`;
        t += `├ *10.* 🧾 Riwayat Transaksi\n`;
        t += `├ *11.* 📖 Bantuan & Panduan\n│\n`;
        t += `╰───────────────────────────\n\n`;
        t += `👇 Balas dengan *ANGKA (1 - 11)* untuk memilih menu.`;
        return sock.sendMessage(sender, { text: t });
    }

    // ========================================
// DEPOSIT SYSTEM
// ========================================


// ========================================
// DYNAMIC DEPOSIT SYSTEM
// ========================================

if (txt === 'DEPOSIT') {

    session.step = S.INPUT_DEPOSIT;

    return sock.sendMessage(sender, {

        text:
`💰 *DEPOSIT SALDO*

Masukkan nominal deposit.

📌 Minimal: Rp1.000
📌 Maksimal: Rp300.000

Contoh:
10000`
    });
}

if (session.step === S.INPUT_DEPOSIT) {

    const amount =
        parseInt(
            txt.replace(/[^0-9]/g, '')
        );

    if (isNaN(amount)) {

        return sock.sendMessage(sender, {
            text: '❌ Nominal tidak valid.'
        });
    }

    if (amount < 1000) {

        return sock.sendMessage(sender, {
            text: '❌ Minimal deposit Rp1.000'
        });
    }

    if (amount > 500000) {

        return sock.sendMessage(sender, {
            text: '❌ Maksimal deposit Rp500.000'
        });
    }

    // 🛡️ ANTI-DOS FLOOD GUARD: Batasi 1 Deposit Pending per User
    const canonicalSender = db.normalizeJid ? db.normalizeJid(sender) : sender;
    const pendingDep = (db.deposits || []).find(d => 
        (d.buyer === sender || d.buyer === canonicalSender) &&
        d.status === 'pending' &&
        Date.now() - d.createdAt < 5 * 60 * 1000
    );

    if (pendingDep) {
        session.step = S.IDLE;
        return sock.sendMessage(sender, {
            text: `⚠️ *DEPOSIT AKTIF DITEMUKAN*\n\nAnda masih memiliki tagihan deposit aktif yang belum kadaluarsa (ID: \`${pendingDep.id}\`).\nSelesaikan pembayaran atau tunggu 5 menit hingga kadaluarsa sebelum membuat deposit baru.`
        });
    }

    const unique = Math.floor(Math.random() * 300);
    const finalAmount = amount + unique;
    const depositId = 'DEP-' + Date.now();

    // Notifikasi instan sebelum generate barcode QRIS (agar user tidak merasa jeda)
    await sock.sendMessage(sender, {
        text: "⏳ *MENYIAPKAN QRIS...*\nSedang membuat barcode deposit saldo, mohon tunggu sebentar ya..."
    }).catch(() => {});

    const qris = await api.createQris(depositId, finalAmount);

    if (!qris || qris.status !== 'Success') {
        return sock.sendMessage(sender, {
            text: '❌ Gagal membuat QRIS deposit.'
        });
    }

    if (!db.deposits) db.deposits = [];

    const finalAmountNum = (qris.data && qris.data.total_bayar) ? Number(qris.data.total_bayar) : finalAmount;
    db.deposits.push({
        id: depositId,
        buyer: canonicalSender,
        amount: amount,
        finalAmount: finalAmountNum,
        status: 'pending',
        createdAt: Date.now()
    });

    if (db.saveDeposits) db.saveDeposits();
    else db.saveUsers();

    session.step = S.IDLE;

    let qrPayload = { url: `https://quickchart.io/qr?size=500&margin=2&text=${encodeURIComponent(qris.data.qr_string)}` };
    try {
        const QRCode = require('qrcode');
        const qrBuf = await QRCode.toBuffer(qris.data.qr_string, { width: 500, margin: 2 });
        qrPayload = qrBuf;
    } catch (_) {}

    await sock.sendMessage(sender, {
        image: qrPayload,
        caption: `💰 *TAGIHAN DEPOSIT SALDO (QRIS)*

• Nominal Masuk : *${formatRupiah(amount)}*
• Total Bayar   : *Rp ${finalAmountNum.toLocaleString('id-ID')}* _(Tepat)_
• Biaya / Unik  : Rp ${(finalAmountNum - amount).toLocaleString('id-ID')}
• ID Tagihan    : \`${depositId}\`

⏳ Batas Waktu  : *5 Menit* (Otomatis Masuk)

💡 *Cara Bayar Mudah:*
1. Simpan / Screenshot gambar QR di atas.
2. Buka m-Banking (BCA, Mandiri, BRI, BNI) atau E-Wallet (DANA, GoPay, OVO, ShopeePay).
3. Pilih menu *Scan QRIS* lalu unggah foto dari galeri HP Anda.

_Saldo akun akan bertambah otomatis dalam beberapa detik setelah pembayaran lunas!_

⚖️ _Membayar berarti menyetujui S&K Layanan. Dilarang menggunakan dana ilegal / hasil kejahatan. Info: ketik .snk_`
    });

    const checker = setInterval(async () => {
        const check = await api.checkQris(depositId, finalAmount);
        const dep = (db.deposits || []).find(d => d.id === depositId);

        if (!dep) {
            clearInterval(checker);
            return;
        }

        if (dep.status !== 'pending') {
            clearInterval(checker);
            return;
        }

        // EXPIRED
        if (Date.now() - dep.createdAt > 5 * 60 * 1000) {
            dep.status = 'expired';
            if (db.saveDeposits) db.saveDeposits();
            clearInterval(checker);

            return sock.sendMessage(sender, {
                text:
`❌ DEPOSIT EXPIRED

ID:
${depositId}`
            });
        }

        // PAID
        if (check === 'PAID') {
            dep.status = 'paid';
            clearInterval(checker);

            const user = db.getUser ? db.getUser(sender) : (db.users[sender] || (db.users[sender] = { saldo: 0 }));
            user.saldo = (user.saldo || 0) + amount;
            if (!Array.isArray(user.history)) user.history = [];
            const dateStr = new Date().toLocaleDateString('id-ID');
            user.history.push(`[${dateStr}] 🟢 Deposit QRIS (+Rp ${amount.toLocaleString('id-ID')})`);

            if (db.saveDeposits) db.saveDeposits();
            db.saveUsers();

            const realJid = db.normalizeJid ? db.normalizeJid(sender) : sender;

            await sock.sendMessage(sender, {
                text:
`✅ DEPOSIT BERHASIL

💰 Saldo Masuk:
Rp ${amount.toLocaleString('id-ID')}

🧾 ID:
${depositId}`
            });

            for (const owner of config.owner) {
                await sock.sendMessage(owner, {
                    text:
`💰 DEPOSIT MASUK

User:
${realJid}

Nominal:
Rp ${amount.toLocaleString('id-ID')}

ID:
${depositId}`
                }).catch(()=>{});
            }
        }
    }, 3000);

    return;
}

if (txt === 'PROFIL') {
        session.step = S.IDLE;
        const u = db.getUser(sender);
        let displayNo = u.phone || '';
        if (displayNo.startsWith('62')) displayNo = '0' + displayNo.slice(2);
        if (!displayNo && !sender.includes('@lid')) displayNo = sender.split('@')[0].split(':')[0];
        const namePart = u.name ? `\n👤 Nama: *${u.name}*` : '';
        return sock.sendMessage(sender, { 
            text: `👤 *PROFIL PENGGUNA*${namePart}\n📱 Nomor HP: *${displayNo || '-'}*\n💰 Saldo: *${formatRupiah(u.saldo || 0)}*\n\n_Ketik *MENU* untuk belanja, atau ketik *DEPOSIT* untuk isi saldo._` 
        });
    }

    if (txt === 'B' || (txt === '0' && session.step !== S.PILIH_CYCLES_SUBS)) {
        session.step = S.IDLE;
        return sock.sendMessage(sender, { text: "🚫 Aksi dibatalkan. Ketik *MENU* untuk kembali belanja." });
    }

    // 2. PILIH KATEGORI (1-11)
    if (session.step === S.PILIH_KATEGORI || (session.step === S.IDLE && /^(1[0-1]|[1-9])$/.test(txt))) {
        if (txt === '1' || txt === '2') {
            session.tempTipe = txt === '1' ? 'Pulsa' : 'Data';
            session.step = S.INPUT_TARGET_PULSA;

            // Deteksi nomor pengirim untuk kemudahan Fast Order
            const u = db.getUser ? db.getUser(sender) : null;
            let senderPhone = u?.phone || '';
            if (!senderPhone && !sender.includes('@lid')) {
                senderPhone = sender.split('@')[0].split(':')[0];
            }
            if (senderPhone.startsWith('62')) senderPhone = '0' + senderPhone.slice(2);
            const isValidSender = senderPhone && senderPhone.startsWith('08') && senderPhone.length >= 10;
            session.tempSenderPhone = isValidSender ? senderPhone : null;

            let msg = session.tempTipe === 'Data' ? `📶 *PAKET DATA INTERNET*\n\n` : `📱 *PULSA REGULER*\n\n`;
            if (isValidSender) {
                msg += `Silakan masukkan *Nomor HP Tujuan*:\n_Contoh: 08123456789_\n\n` +
                       `👉 Atau balas *1* untuk mengisi ke nomor sendiri (*${senderPhone}*).\n\n`;
            } else {
                msg += `Silakan masukkan *Nomor HP Tujuan*:\n_Contoh: 08123456789_\n\n`;
            }

            if (session.tempTipe === 'Data') {
                msg += `💡 *Tips:* Bisa langsung sertakan kuota/harga (contoh: *08123456789 2gb* atau *1 50k*)\n\n`;
            }
            msg += `Ketik *0* atau *B* untuk batal.`;
            return sock.sendMessage(sender, { text: msg });
        } else if (txt === '3') {
            session.tempTipe = 'E-Money';
            session.step = S.PILIH_BRAND_EMONEY;
            const brands = [...new Set(db.ppob.filter(p => p.kategori === 'E-Money').map(p => p.brand))];
            if (brands.length === 0) return sock.sendMessage(sender, { text: `❌ Sistem belum menarik data E-Money. Ketik .sync emoney` });
            
            session.tempBrands = brands;
            let t = `💸 *PILIH PROVIDER E-MONEY*\n\n`;
            brands.forEach((b, i) => t += `*${i+1}.* ${b}\n`);
            t += `\nBalas angka (*1 - ${brands.length}*) pilihan Anda.\nKetik *0* atau *B* untuk batal.`;
            return sock.sendMessage(sender, { text: t });
        } else if (txt === '4') {
            session.tempTipe = 'PLN';
            session.step = S.INPUT_TARGET_PULSA;
            return sock.sendMessage(sender, {
                text: `⚡ *TOKEN LISTRIK PLN (PRABAYAR)*\n\nSilakan masukkan *Nomor Meteran / ID Pelanggan PLN* (11-12 Digit):\n_Contoh: 123456789012_\n\nKetik *0* atau *B* untuk batal.`
            });
        } else if (txt === '5') {
            session.step = S.PILIH_KATEGORI_PASCA;
            let t = `📑 *PILIH KATEGORI TAGIHAN PASCABAYAR*\n\n`;
            t += `*1.* ⚡ PLN Pascabayar (Listrik Bulanan)\n`;
            t += `*2.* 🏥 BPJS (Kesehatan & Ketenagakerjaan)\n`;
            t += `*3.* 💧 PDAM (Air Bersih Daerah)\n`;
            t += `*4.* 📱 HP Pascabayar (Halo, Matrix, XL, Three, Smartfren)\n`;
            t += `*5.* 🌐 Internet & TV Kabel (Indihome, Biznet, MyRepublic, dll)\n`;
            t += `*6.* 🏢 Angsuran Kredit / Multifinance (Adira, OTO, Home Credit, WOM)\n`;
            t += `*7.* 🏛️ PBB (Pajak Bumi & Bangunan)\n\n`;
            t += `Balas *Angka (1 - 7)* kategori tagihan Anda.\nKetik *0* atau *B* untuk batal.`;
            return sock.sendMessage(sender, { text: t });
        } else if (txt === '6') {
            session.step = S.PILIH_PRODUK_DIGITAL;
            let t = `📂 *PRODUK DIGITAL (AKUN / APLIKASI)*\n\n`;
            if (!db.menu || db.menu.length === 0) return sock.sendMessage(sender, { text: `❌ Belum ada produk digital tersedia saat ini.` });
            session.tempDigitalList = [...db.menu];
            db.menu.forEach((m, idx) => t += `*${idx + 1}.* ${m.nama}\n   💰 ${formatRupiah(m.harga)} | 📦 Stok: ${m.stok}\n\n`);
            t += `⚠️ *Catatan S&K:* Akun promo seller (max 1 device, garansi First Login saja). Ketik *.snkdigital* untuk info lengkap.\n\n`;
            t += `Balas *Angka (1 - ${db.menu.length})* produk pilihan Anda.\nKetik *0* atau *B* untuk batal.`;
            return sock.sendMessage(sender, { text: t });
        } else if (txt === '7') {
            session.step = S.PILIH_SUB_MENU;
            let t = `🔄 *LAYANAN PRODUK BERLANGGANAN (AUTO-ORDER)*\n\n`;
            t += `Beli produk secara rutin tanpa repot order manual berkala. Saldo akun Anda akan terpotong otomatis setiap jatuh tempo.\n\n`;
            t += `*PILIH MENU LANGGANAN:*\n`;
            t += `*1.* 📋 Beli Produk Berlangganan Baru\n`;
            t += `*2.* 📑 Cek / Kelola Langganan Aktif Saya\n`;
            t += `*3.* ⏹️ Batalkan Langganan\n\n`;
            t += `Balas *Angka (1 - 3)* untuk memilih.\nKetik *0* atau *B* untuk batal.`;
            return sock.sendMessage(sender, { text: t });
        } else if (txt === '8') {
            session.step = S.INPUT_DEPOSIT;
            return sock.sendMessage(sender, {
                text: `💰 *DEPOSIT SALDO OTOMATIS (QRIS)*\n\nMasukkan nominal deposit yang diinginkan:\n📌 Minimal: Rp1.000\n📌 Maksimal: Rp500.000\n\n_Contoh: 10000_\nKetik *0* atau *B* untuk batal.`
            });
        } else if (txt === '9') {
            session.step = S.IDLE;
            const u = db.getUser(sender);
            let displayNo = u.phone || '';
            if (displayNo.startsWith('62')) displayNo = '0' + displayNo.slice(2);
            if (!displayNo && !sender.includes('@lid')) displayNo = sender.split('@')[0].split(':')[0];
            const namePart = u.name ? `\n👤 Nama: *${u.name}*` : '';
            return sock.sendMessage(sender, {
                text: `👤 *PROFIL PENGGUNA*${namePart}\n📱 Nomor HP: *${displayNo || '-'}*\n💰 Saldo: *${formatRupiah(u.saldo || 0)}*\n\n_Ketik *MENU* untuk belanja, atau balas *8* untuk isi saldo._`
            });
        } else if (txt === '10') {
            session.step = S.IDLE;
            const canonical = db.normalizeJid(sender);
            const userOrders = (db.orders || [])
                .filter(o => o.buyer === canonical || o.buyer === sender)
                .slice(-5)
                .reverse();
            if (userOrders.length === 0) {
                return sock.sendMessage(sender, { text: "📦 Anda belum memiliki riwayat transaksi.\nKetik *MENU* untuk mulai bertransaksi." });
            }
            let t = `🧾 *5 TRANSAKSI TERAKHIR ANDA*\n\n`;
            userOrders.forEach((o, i) => {
                const dateStr = o.timestamp ? new Date(o.timestamp).toLocaleString('id-ID') : '-';
                const icon = o.status === 'success' ? '✅' : o.status === 'failed' ? '❌' : '⏳';
                t += `*${i+1}.* ${icon} *${o.item || o.sku}*\n`;
                t += `   Inv: \`${o.id}\`\n`;
                t += `   Target: ${o.target || '-'}\n`;
                t += `   Total: ${formatRupiah(o.baseAmount || o.total || 0)}\n`;
                t += `   Status: *${String(o.status).toUpperCase()}*\n`;
                if (o.sn) t += `   SN/Token: \`${o.sn}\`\n`;
                t += `   Waktu: ${dateStr}\n\n`;
            });
            return sock.sendMessage(sender, { text: t });
        } else if (txt === '11') {
            session.step = S.IDLE;
            let t = `📖 *PANDUAN LENGKAP TRANSAKSI*\n\n`;
            t += `*Cara Berbelanja via Menu Angka:*\n`;
            t += `1. Ketik *MENU* untuk membuka katalog layanan.\n`;
            t += `2. Balas angka layanan yang diinginkan (1 - 7).\n`;
            t += `3. Masukkan nomor HP / ID Pelanggan tujuan.\n`;
            t += `4. Pilih produk / nominal dengan membalas angka.\n`;
            t += `5. Konfirmasi: Balas *1* untuk Bayar, *2* untuk Batal.\n\n`;
            t += `*Shortcut Cepat (Opsional):*\n`;
            t += `• *.beli [SKU] [NoHP]* : Beli instan\n`;
            t += `• *.harga [Operator]* : Cek daftar harga & SKU\n`;
            t += `• *.langganan* : Menu produk berlangganan otomatis\n`;
            t += `• *.batallangganan [ID]* : Berhenti berlangganan\n`;
            t += `• *.transfer [NoHP] [Nominal]* : Kirim saldo ke sesama member\n`;
            t += `• *.status [Invoice]* : Cek status / token transaksi\n`;
            t += `• *.struk [Invoice]* : Kirim file PDF struk pembayaran resmi\n`;
            t += `• *.kasbon* : Buku kasbon hutang warung\n`;
            t += `• *B* atau *0* : Batalkan transaksi kapan saja\n\n`;
            t += `🏪 *${db.store.namaToko || 'DIGITAL STORE'}* - Aman, Cepat, dan Otomatis.`;
            return sock.sendMessage(sender, { text: t });
        }
    }

    // 2B. ALUR PASCABAYAR: PILIH KATEGORI (1-7)
    if (session.step === S.PILIH_KATEGORI_PASCA) {
        if (txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Transaksi dibatalkan. Ketik *MENU* untuk kembali." });
        }
        const pascaProducts = db.postpaid || [];
        let selectedCategory = '';
        let targetLabel = 'ID Pelanggan';
        let matched = [];

        if (txt === '1') {
            selectedCategory = 'PLN PASCABAYAR';
            targetLabel = 'ID Pelanggan PLN (12 Digit)';
            matched = pascaProducts.filter(p => p.brand && p.brand.toUpperCase().includes('PLN PASCABAYAR'));
        } else if (txt === '2') {
            selectedCategory = 'BPJS';
            targetLabel = 'Nomor Virtual Account / Kartu BPJS';
            matched = pascaProducts.filter(p => p.brand && p.brand.toUpperCase().includes('BPJS'));
        } else if (txt === '3') {
            selectedCategory = 'PDAM';
            targetLabel = 'Nomor Pelanggan PDAM';
            matched = pascaProducts.filter(p => p.brand && p.brand.toUpperCase().includes('PDAM'));
        } else if (txt === '4') {
            selectedCategory = 'HP PASCABAYAR';
            targetLabel = 'Nomor HP Pascabayar';
            matched = pascaProducts.filter(p => p.brand && (
                p.brand.toUpperCase().includes('HP PASCABAYAR') || 
                p.brand.toUpperCase().includes('TELKOMSEL') || 
                p.brand.toUpperCase().includes('INDOSAT') || 
                p.brand.toUpperCase().includes('TRI') || 
                p.brand.toUpperCase().includes('XL') || 
                p.brand.toUpperCase().includes('BY.U')
            ));
        } else if (txt === '5') {
            selectedCategory = 'INTERNET & TV KABEL';
            targetLabel = 'Nomor Pelanggan / ID Internet';
            matched = pascaProducts.filter(p => p.brand && (
                p.brand.toUpperCase().includes('INTERNET') || 
                p.brand.toUpperCase().includes('TV')
            ));
        } else if (txt === '6') {
            selectedCategory = 'MULTIFINANCE';
            targetLabel = 'Nomor Kontrak / Perjanjian Kredit';
            matched = pascaProducts.filter(p => p.brand && p.brand.toUpperCase().includes('MULTIFINANCE'));
        } else if (txt === '7') {
            selectedCategory = 'PBB';
            targetLabel = 'Nomor Objek Pajak (NOP)';
            matched = pascaProducts.filter(p => p.brand && p.brand.toUpperCase().includes('PBB'));
        } else {
            return sock.sendMessage(sender, { text: "❌ Pilihan salah. Balas dengan angka *1 - 7*, atau *0* untuk batal." });
        }

        if (matched.length === 0) {
            matched = pascaProducts.filter(p => (p.name && p.name.toUpperCase().includes(selectedCategory)) || (p.category && p.category.toUpperCase().includes(selectedCategory)));
        }

        const defaultSkuMap = {
            'PLN PASCABAYAR': 'post685486',
            'BPJS': 'post685476',
            'PDAM': 'post685472',
            'HP PASCABAYAR': 'post716439',
            'INTERNET & TV KABEL': 'post716445',
            'MULTIFINANCE': 'post716486',
            'PBB': 'post685474'
        };

        if (matched.length <= 1) {
            const defaultSku = defaultSkuMap[selectedCategory] || 'post685486';
            const product = matched[0] || { sku: defaultSku, brand: selectedCategory, name: selectedCategory };
            session.tempPostpaidProduct = product;
            session.tempPostpaidCategory = selectedCategory;
            session.step = S.INPUT_TARGET_PASCA;
            return sock.sendMessage(sender, {
                text: `📑 *TAGIHAN ${product.name.toUpperCase()}*\n\nSilakan masukkan *${targetLabel}*:\n_Contoh: 512345678901_\n\nKetik *0* atau *B* untuk batal.`
            });
        } else {
            session.allMatchedPostpaid = matched;
            session.tempPostpaidList = matched.slice(0, 25);
            session.step = S.PILIH_PRODUK_PASCA;
            let t = `📑 *PILIH LAYANAN ${selectedCategory}*\n\n`;
            session.tempPostpaidList.forEach((p, idx) => {
                t += `*${idx + 1}.* ${p.name}\n`;
            });
            if (matched.length > 25) {
                t += `\n_Menampilkan 25 dari ${matched.length} layanan._\n_Tips: Anda juga dapat mengetik nama daerah/layanan untuk mencari (contoh: *malang* atau *adira*)._\n`;
            }
            t += `\nBalas *Angka (1 - ${session.tempPostpaidList.length})* pilihan Anda.\nKetik *0* atau *B* untuk batal.`;
            return sock.sendMessage(sender, { text: t });
        }
    }

    if (session.step === S.PILIH_PRODUK_PASCA) {
        if (txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Transaksi dibatalkan. Ketik *MENU* untuk kembali." });
        }

        const idx = parseInt(txt, 10) - 1;
        if (!isNaN(idx) && session.tempPostpaidList && session.tempPostpaidList[idx]) {
            const product = session.tempPostpaidList[idx];
            session.tempPostpaidProduct = product;
            session.step = S.INPUT_TARGET_PASCA;
            return sock.sendMessage(sender, {
                text: `📑 *TAGIHAN ${product.name.toUpperCase()}*\n\nSilakan masukkan *Nomor / ID Pelanggan*:\n_Contoh: 1234567890_\n\nKetik *0* atau *B* untuk batal.`
            });
        }

        // Fitur Smart Search Nama Layanan / Wilayah (misal: "malang", "kediri", "adira")
        const query = txt.toLowerCase().trim();
        const searchPool = session.allMatchedPostpaid || session.tempPostpaidList || [];
        const filtered = searchPool.filter(p => p.name && p.name.toLowerCase().includes(query));

        if (filtered.length === 0) {
            return sock.sendMessage(sender, { text: `❌ Layanan dengan kata kunci "*${txt}*" tidak ditemukan.\nSilakan balas angka pada daftar atau coba kata kunci lain.` });
        }

        if (filtered.length === 1) {
            const product = filtered[0];
            session.tempPostpaidProduct = product;
            session.step = S.INPUT_TARGET_PASCA;
            return sock.sendMessage(sender, {
                text: `📑 *TAGIHAN ${product.name.toUpperCase()}*\n\nSilakan masukkan *Nomor / ID Pelanggan*:\n_Contoh: 1234567890_\n\nKetik *0* atau *B* untuk batal.`
            });
        }

        session.tempPostpaidList = filtered.slice(0, 25);
        let t = `🔍 *HASIL PENCARIAN:* "*${txt}*"\n\n`;
        session.tempPostpaidList.forEach((p, i) => {
            t += `*${i + 1}.* ${p.name}\n`;
        });
        t += `\nBalas *Angka (1 - ${session.tempPostpaidList.length})* pilihan Anda.\nKetik *0* atau *B* untuk batal.`;
        return sock.sendMessage(sender, { text: t });
    }

    if (session.step === S.INPUT_TARGET_PASCA) {
        if (txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Transaksi dibatalkan. Ketik *MENU* untuk kembali." });
        }
        const target = txt.replace(/[^0-9a-zA-Z]/g, '');
        if (!target || target.length < 5) {
            return sock.sendMessage(sender, { text: "❌ Nomor ID Pelanggan tidak valid. Silakan periksa kembali." });
        }
        const product = session.tempPostpaidProduct || { sku: 'post685486', name: 'PLN Pascabayar', brand: 'PLN PASCABAYAR' };
        session.tempTarget = target;

        await sock.sendMessage(sender, { text: "⏳ *INQUIRY:* Sedang mengecek rincian tagihan ke server..." });

        const postpaid = require('../lib/postpaid');
        const refId = `INQ-${Date.now()}`;
        try {
            const inq = await postpaid.inquiry(product.sku, target, refId);
            if (!inq || !inq.data || inq.data.status === 'Gagal') {
                session.step = S.IDLE;
                return sock.sendMessage(sender, {
                    text: `❌ *TAGIHAN TIDAK DITEMUKAN / GAGAL*\n\nPesan: ${inq?.data?.message || 'Nomor ID Pelanggan salah atau tagihan sudah terbayar lunas.'}\n\nKetik *MENU* untuk kembali.`
                });
            }

            const data = inq.data;
            const customerName = data.customer_name || '-';
            const adminFee = Number(data.admin) || 2500;
            const billAmount = Number(data.price || data.selling_price || 0);

            // Validasi jika tagihan Rp 0 (sudah lunas)
            if (billAmount <= 0) {
                session.step = S.IDLE;
                return sock.sendMessage(sender, {
                    text: `ℹ️ *TAGIHAN SUDAH LUNAS / BELUM TERBIT*\n\n` +
                          `📦 Layanan: *${product.name}*\n` +
                          `👤 Pelanggan: *${customerName}* (\`${target}\`)\n` +
                          `💵 Tagihan: *Rp 0*\n\n` +
                          `Tagihan Anda untuk periode ini telah lunas atau belum terbit dari pihak biller.\n` +
                          `Ketik *MENU* untuk kembali.`
                });
            }

            const desc = data.desc || {};
            const tarif = desc.tarif || '';
            const daya = desc.daya ? `${desc.daya} VA` : '';
            const lembar = Number(desc.lembar_tagihan) || (Array.isArray(desc.detail) ? desc.detail.length : 1);
            
            let totalPokok = 0;
            let totalDenda = 0;
            if (Array.isArray(desc.detail) && desc.detail.length > 0) {
                desc.detail.forEach(d => {
                    totalPokok += (Number(d.nilai_tagihan) || 0);
                    totalDenda += (Number(d.denda) || 0);
                });
            }
            const pokokDisplay = totalPokok > 0 ? totalPokok : Math.max(0, billAmount - adminFee);

            const pascaProfit = (config.profit && typeof config.profit.pasca === 'number') ? config.profit.pasca : 1500;
            const totalAmount = billAmount + pascaProfit;
            const period = data.periode || data.period || '-';

            session.tempInquiryRef = refId;
            session.tempItem = {
                sku: product.sku,
                nama: `${product.name} (${customerName})`,
                cleanName: product.name,
                hargaJual: totalAmount,
                isPasca: true,
                inquiryRef: refId,
                customerName: customerName,
                billAmount: billAmount,
                adminFee: adminFee,
                pascaProfit: pascaProfit,
                period: period,
                tarif: tarif,
                daya: daya,
                lembar: lembar
            };
            session.tempQty = 1;
            session.step = S.CONFIRM;

            const user = db.getUser(sender);
            const userSaldo = Number(user.saldo) || 0;

            let invoiceText = `🧾 *RINCIAN TAGIHAN PASCABAYAR*\n\n`;
            invoiceText += `📦 Layanan: *${product.name}*\n`;
            invoiceText += `🎯 ID Pelanggan: *${target}*\n`;
            invoiceText += `👤 Nama Pelanggan: *${customerName}*\n`;
            if (tarif || daya) {
                invoiceText += `⚡ Tarif / Daya: *${[tarif, daya].filter(Boolean).join(' / ')}*\n`;
            }
            invoiceText += `📅 Periode: *${period}*${lembar > 1 ? ` (${lembar} Bulan)` : ''}\n`;
            invoiceText += `────────────────────────\n`;
            invoiceText += `💵 Tagihan Pokok: *${formatRupiah(pokokDisplay)}*\n`;
            if (totalDenda > 0) {
                invoiceText += `⚠️ Denda: *${formatRupiah(totalDenda)}*\n`;
            }
            invoiceText += `🏦 Admin Biller / Bank: *${formatRupiah(adminFee)}*\n`;
            invoiceText += `🏪 Biaya Layanan Loket: *${formatRupiah(pascaProfit)}*\n`;
            invoiceText += `────────────────────────\n`;
            invoiceText += `💰 *TOTAL BAYAR: ${formatRupiah(totalAmount)}*\n\n`;
            invoiceText += `💵 Saldo Dompet Anda: ${formatRupiah(userSaldo)}\n`;
            invoiceText += userSaldo >= totalAmount ? `_Saldo Anda mencukupi (Potong Otomatis)._\n\n` : `_Pembayaran via QRIS Otomatis._\n\n`;
            invoiceText += `Balas *1* untuk BAYAR SEKARANG\nBalas *2* untuk BATAL\n\n`;
            invoiceText += `⚖️ _Membayar berarti menyetujui S&K Layanan. Info: ketik .snk_`;

            return sock.sendMessage(sender, { text: invoiceText });
        } catch (err) {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: `❌ *ERROR SERVER:* Gagal memproses inquiry tagihan (${err.message}). Silakan coba beberapa saat lagi.` });
        }
    }

    // 3. ALUR PULSA/DATA (Auto Detect -> Sort -> Group -> Paginate)
    if (session.step === S.INPUT_TARGET_PULSA) {
        if (txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Transaksi dibatalkan. Ketik *MENU* untuk kembali belanja." });
        }

        let searchKeyword = '';
        let rawInput = text.trim();

        // Opsi Cepat: Balas "1" untuk menggunakan nomor sendiri
        if (session.tempSenderPhone && (rawInput === '1' || rawInput.startsWith('1 ') || rawInput.startsWith('1.'))) {
            let extra = '';
            if (rawInput.startsWith('1 ')) extra = rawInput.slice(2).trim();
            else if (rawInput.startsWith('1.')) extra = rawInput.slice(2).trim();
            rawInput = session.tempSenderPhone;
            if (extra) searchKeyword = extra;
        }

        if (session.tempTipe === 'Data') {
            if (!searchKeyword) {
                if (rawInput.includes('.')) {
                    const parts = rawInput.split('.');
                    rawInput = parts[0];
                    searchKeyword = parts.slice(1).join('.').trim();
                } else if (rawInput.includes(' ')) {
                    const parts = rawInput.split(/\s+/);
                    rawInput = parts[0];
                    searchKeyword = parts.slice(1).join(' ').trim();
                }
            }
        }

        const phone = rawInput.replace(/[^0-9]/g, '');
        if (session.tempTipe === 'PLN') {
            if (phone.length < 11 || phone.length > 12) {
                return sock.sendMessage(sender, { text: `❌ Nomor Meter / ID Pelanggan PLN harus 11 atau 12 digit.` });
            }
        } else {
            if (phone.length < 10 || phone.length > 14) {
                return sock.sendMessage(sender, { text: `❌ Nomor HP tidak valid (harus 10 - 14 digit).` });
            }
        }
        let operator = '';

        if (session.tempTipe === 'PLN') {
            operator = 'PLN';
        } else {
            operator = detectOperator(phone);

            if (operator === 'UNKNOWN')
                return sock.sendMessage(sender, {
                    text: `❌ Operator tidak dikenali.`
                });
        }
        
        session.tempTarget = phone;
        session.tempOp = operator;
        
        const produkRaw = db.ppob.filter(p => {
            if (session.tempTipe === 'PLN') {
                return p.kategori === 'PLN';
            }
            return p.kategori === session.tempTipe && p.brand === operator;
        });
        if (produkRaw.length === 0) return sock.sendMessage(sender, { text: `❌ Produk ${session.tempTipe} untuk ${operator} sedang kosong.` });
        
        // Memparsing dan Menyortir Data
        let parsedProducts = produkRaw.map(p => { return { ...p, ...parseProduct(p.nama, operator) }; });
        
        parsedProducts.sort((a, b) => {
            if (a.groupName < b.groupName) return -1;
            if (a.groupName > b.groupName) return 1;
            if (a.validityDays !== b.validityDays) return a.validityDays - b.validityDays;
            return a.hargaJual - b.hargaJual;
        });

        // Simpan seluruh katalog lengkap operator untuk fitur search & reset
        session.tempAllProducts = [...parsedProducts];

        // SMART DATA
        if (session.tempTipe === 'Data') {
            session.tempSearchKeyword = searchKeyword || '';

            if (searchKeyword) {
                const filtered = filterSmartProducts(parsedProducts, searchKeyword);
                if (filtered && filtered.length > 0) {
                    parsedProducts = filtered;
                    session.tempSmartMode = false;
                } else {
                    session.tempSmartMode = false;
                }
            } else {
                parsedProducts = parsedProducts
                    .sort((a, b) => a.hargaJual - b.hargaJual)
                    .slice(0, 5);
                session.tempSmartMode = true;
            }
        }

        session.tempList = parsedProducts;
        session.tempPage = 0; // Mulai dari Halaman 1
        session.step = S.PILIH_PRODUK_PULSA;
        
        return showProductList(sock, sender, session);
    }

    // 4. ALUR E-MONEY
    if (session.step === S.PILIH_BRAND_EMONEY) {
        const idx = parseInt(txt) - 1;
        if (isNaN(idx) || !session.tempBrands[idx]) return sock.sendMessage(sender, { text: `❌ Pilihan salah.` });
        session.tempBrand = session.tempBrands[idx];
        session.step = S.INPUT_TARGET_EMONEY;
        // MENCUCI OTAK BOT DARI TRANSAKSI SEBELUMNYA
        delete session.tempOp;
        delete session.tempSmartMode;
        return sock.sendMessage(sender, { text: `💸 *${session.tempBrand}*\n\nSilakan masukkan Nomor Akun / HP Anda:` });
    }

    if (session.step === S.INPUT_TARGET_EMONEY) {
        session.tempTarget = txt.replace(/[^0-9]/g, '');
        const produkRaw = db.ppob.filter(p => p.kategori === 'E-Money' && p.brand === session.tempBrand);
        
        let parsedProducts = produkRaw.map(p => { return { ...p, ...parseProduct(p.nama, session.tempBrand) }; });
        parsedProducts.sort((a, b) => {
            if (a.groupName < b.groupName) return -1;
            if (a.groupName > b.groupName) return 1;
            return a.hargaJual - b.hargaJual;
        });

        session.tempAllProducts = [...parsedProducts];
        session.tempList = parsedProducts;
        session.tempPage = 0;
        session.step = S.PILIH_PRODUK_EMONEY;
        
        return showProductList(sock, sender, session);
    }

    // 5. TANGKAP INPUT PRODUK (PULSA/DATA/EMONEY) & SMART FILTER / PAGINASI
    if (session.step === S.PILIH_PRODUK_PULSA || session.step === S.PILIH_PRODUK_EMONEY) {
        const upperTxt = txt.trim().toUpperCase();
        const isResetCmd = ['ALL', 'SEMUA', 'RESET'].includes(upperTxt);
        const isNextCmd = ['Z', 'N', 'NEXT', 'L', 'LANJUT', '00', '>', 'SELANJUTNYA', 'BERIKUTNYA'].includes(upperTxt) || isResetCmd;
        const pageMatch = upperTxt.match(/^(?:HAL(?:AMAN)?\.?\s*)(\d+)$/i);

        // 1. Paginasi & Navigasi Halaman
        if (pageMatch) {
            const targetP = parseInt(pageMatch[1], 10) - 1;
            const maxPage = Math.floor(((session.tempList || []).length - 1) / 10);
            if (targetP >= 0 && targetP <= maxPage) {
                session.tempPage = targetP;
                return showProductList(sock, sender, session);
            }
        }

        if (isNextCmd) {
            if ((session.tempSmartMode || session.tempSearchKeyword || isResetCmd) && session.tempAllProducts) {
                session.tempList = session.tempAllProducts;
                session.tempPage = 0;
                session.tempSmartMode = false;
                delete session.tempSearchKeyword;
                return showProductList(sock, sender, session);
            }

            const maxPage = Math.floor((session.tempList.length - 1) / 10);
            if (session.tempPage >= maxPage) {
                session.tempPage = 0;
            } else {
                session.tempPage += 1;
            }
            return showProductList(sock, sender, session);
        }

        // 2. Pencarian & Filter Cerdas (Jika bukan angka pemilihan produk)
        if (!/^\d+$/.test(txt.trim())) {
            const rawSearch = txt.trim();
            const sourceProducts = session.tempAllProducts || session.tempList;
            const hasil = filterSmartProducts(sourceProducts, rawSearch);

            if (!hasil || hasil.length === 0) {
                return sock.sendMessage(sender, {
                    text: `⚠️ Paket "*${rawSearch}*" tidak ditemukan pada katalog ${session.tempOp || session.tempBrand || ''}.\n\n` +
                          `💡 *Tips:* Coba kata kunci kuota/harga lain (contoh: *2gb*, *30hari*, *50k*) atau ketik *SEMUA* untuk melihat seluruh katalog.`
                });
            }

            session.tempList = hasil;
            session.tempPage = 0;
            session.tempSearchKeyword = rawSearch;
            session.tempSmartMode = false;

            return showProductList(sock, sender, session);
        }

        // 3. Pemilihan Produk dengan Angka
        const idx = parseInt(txt.trim(), 10) - 1;
        if (isNaN(idx) || !session.tempList[idx]) {
            return sock.sendMessage(sender, {
                text: `❌ Pilihan tidak valid. Balas nomor produk (*1 - ${session.tempList.length}*), ketik kata kunci paket (cth: *2gb*, *50k*), atau ketik *LANJUT* untuk halaman berikutnya.`
            });
        }
        
        session.tempItem = session.tempList[idx];
        session.step = S.CONFIRM;
        return showInvoice(sock, sender, session);
    }

    // 6. ALUR DIGITAL PRODUK (Manual Menu)
    if (session.step === S.PILIH_PRODUK_DIGITAL) {
        const id = parseInt(txt);
        const item = db.menu.find(m => m.id === id);
        if (!item) return sock.sendMessage(sender, { text: `❌ ID Produk salah.` });
        if (item.stok <= 0) return sock.sendMessage(sender, { text: `❌ Stok Habis.` });
        session.tempItem = item;
        session.step = S.QTY_DIGITAL;
        return sock.sendMessage(sender, { text: `🛒 *${item.nama}*\nBerapa jumlah yang ingin dibeli?` });
    }

    if (session.step === S.QTY_DIGITAL) {
        const qty = parseInt(txt);
        if (isNaN(qty) || qty <= 0 || qty > session.tempItem.stok) return sock.sendMessage(sender, { text: `❌ Jumlah tidak valid / melebihi stok.` });
        session.tempQty = qty;
        session.step = S.CONFIRM;
        return showInvoice(sock, sender, session);
    }

    // 7. CHECKOUT (CONFIRM)
    if (session.step === S.CONFIRM) {
        if (txt === '1' || txt === 'Y' || txt === 'YA' || txt === 'BAYAR' || txt === 'OK') {
            session.step = S.IDLE;
            await processCheckout(sock, sender, session);
            return;
        } else if (txt === '2' || txt === 'B' || txt === '0' || txt === 'BATAL') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Pesanan dibatalkan. Ketik *MENU* untuk kembali belanja." });
        } else {
            return sock.sendMessage(sender, { text: "⚠️ Balas *1* atau *YA* untuk BAYAR SEKARANG, atau *2* / *B* untuk BATAL." });
        }
    }

    // ========================================
    // 🔄 ALUR PRODUK BERLANGGANAN (AUTO-ORDER)
    // ========================================

    // 1. SUB-MENU LANGGANAN
    if (session.step === S.PILIH_SUB_MENU) {
        if (txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Batal. Ketik *MENU* untuk kembali ke menu utama." });
        }

        if (txt === '1') {
            // Katalog Berlangganan Aktif
            const catalog = subLib.getCatalog(true);
            if (catalog.length === 0) {
                session.step = S.IDLE;
                return sock.sendMessage(sender, {
                    text: `❌ *PRODUK LANGGANAN BELUM TERSEDIA*\n\nSaat ini belum ada produk berlangganan yang diaktifkan oleh Admin.\nSilakan hubungi Admin atau ketik *MENU* untuk berbelanja produk reguler.`
                });
            }

            session.tempSubsCatalog = catalog;
            session.step = S.PILIH_PRODUK_SUBS;

            let t = `🔄 *KATALOG PRODUK BERLANGGANAN*\n\n`;
            t += `Pilih produk yang ingin Anda beli secara otomatis dan berkala:\n\n`;
            catalog.forEach((item, idx) => {
                const typeLabel = item.type === 'digital' ? 'Akun Digital' : 'PPOB';
                t += `*${idx + 1}.* *${item.nama}*\n`;
                t += `   • Jenis : ${typeLabel}\n`;
                t += `   • Harga : *${formatRupiah(item.hargaJual)}* / order\n\n`;
            });
            t += `👉 Balas *Angka (1 - ${catalog.length})* produk pilihan Anda.\nKetik *0* atau *B* untuk batal.`;
            return sock.sendMessage(sender, { text: t });

        } else if (txt === '2') {
            // Cek Langganan Saya
            session.step = S.IDLE;
            const mySubs = subLib.getUserSubscriptions(sender);
            const activeSubs = mySubs.filter(s => s.status === 'active' || s.status === 'paused');

            if (activeSubs.length === 0) {
                return sock.sendMessage(sender, {
                    text: `📑 *STATUS LANGGANAN ANDA*\n\nAnda belum memiliki kontrak langganan aktif saat ini.\nKetik *.langganan* untuk mulai berlangganan produk secara berkala.`
                });
            }

            let t = `📑 *DAFTAR LANGGANAN AKTIF ANDA (${activeSubs.length})*\n\n`;
            activeSubs.forEach((s, idx) => {
                const statusStr = s.status === 'active' ? '🟢 AKTIF' : '⏸️ DIJEDA (Saldo Kurang)';
                const cycleStr = subLib.formatCycles(s.maxCycles, s.currentCycle);
                const nextStr = s.nextRunAt ? new Date(s.nextRunAt).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '-';

                t += `*${idx + 1}.* \`${s.id}\`\n`;
                t += `   • Produk       : *${s.productName}*\n`;
                t += `   • Tujuan       : \`${s.target}\`\n`;
                t += `   • Biaya/Order  : *${formatRupiah(s.price)}*\n`;
                t += `   • Interval     : *${subLib.formatInterval(s.intervalDays)}*\n`;
                t += `   • Siklus       : *${cycleStr}*\n`;
                t += `   • Jadwal Nanti : *${nextStr}*\n`;
                t += `   • Status       : *${statusStr}*\n\n`;
            });

            t += `💡 *Tips:* Ketik \`.batallangganan [ID_LANGGANAN]\` jika ingin membatalkan.\nContoh: \`.batallangganan ${activeSubs[0].id}\``;
            return sock.sendMessage(sender, { text: t });

        } else if (txt === '3') {
            // Batalkan Langganan
            const mySubs = subLib.getUserSubscriptions(sender).filter(s => s.status === 'active' || s.status === 'paused');
            if (mySubs.length === 0) {
                session.step = S.IDLE;
                return sock.sendMessage(sender, {
                    text: `📑 Anda belum memiliki kontrak langganan aktif untuk dibatalkan.`
                });
            }

            session.step = S.IDLE;
            let t = `⏹️ *PEMBATALAN LANGGANAN*\n\n`;
            t += `Ketik perintah di bawah untuk membatalkan langganan yang Anda inginkan:\n\n`;
            mySubs.forEach((s, idx) => {
                t += `*${idx + 1}.* *${s.productName}* (\`${s.target}\`)\n`;
                t += `   👉 Ketik: \`.batallangganan ${s.id}\`\n\n`;
            });
            return sock.sendMessage(sender, { text: t });

        } else {
            return sock.sendMessage(sender, {
                text: `⚠️ Balas dengan *1* untuk Beli Langganan Baru, *2* untuk Cek Langganan Saya, atau *3* untuk Batalkan.\nKetik *0* atau *B* untuk batal.`
            });
        }
    }

    // 2. PILIH PRODUK LANGGANAN DARI KATALOG
    if (session.step === S.PILIH_PRODUK_SUBS) {
        if (txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Batal. Ketik *MENU* untuk kembali ke menu utama." });
        }

        const idx = parseInt(txt, 10);
        const catalog = session.tempSubsCatalog || [];

        if (isNaN(idx) || idx < 1 || idx > catalog.length) {
            return sock.sendMessage(sender, {
                text: `⚠️ Pilihan tidak valid. Silakan balas angka (*1 - ${catalog.length}*) sesuai nomor produk di atas.\nKetik *0* atau *B* untuk batal.`
            });
        }

        const selected = catalog[idx - 1];
        session.tempSubProduct = selected;
        session.step = S.INPUT_TARGET_SUBS;

        let prompt = `🎯 *INPUT TUJUAN / PENERIMA*\n\n`;
        prompt += `Produk Dipilih: *${selected.nama}*\n`;
        prompt += `Harga per Order: *${formatRupiah(selected.hargaJual)}*\n\n`;

        if (selected.type === 'digital') {
            prompt += `Silakan masukkan *Nomor WhatsApp* atau *Email* Anda untuk pengiriman detail kredensial akun:\n`;
            prompt += `_Contoh: 08123456789 atau nama@email.com_\n\n`;
        } else {
            prompt += `Silakan masukkan *Nomor HP / No. Meter PLN / ID Pelanggan* tujuan:\n`;
            prompt += `_Contoh: 08123456789 atau 123456789012_\n\n`;
        }
        prompt += `Ketik *0* atau *B* untuk batal.`;
        return sock.sendMessage(sender, { text: prompt });
    }

    // 3. INPUT TARGET TUJUAN
    if (session.step === S.INPUT_TARGET_SUBS) {
        if (txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Batal. Ketik *MENU* untuk kembali ke menu utama." });
        }

        const target = rawTrim;
        if (!target || target.length < 4) {
            return sock.sendMessage(sender, {
                text: `⚠️ Nomor tujuan atau email tidak valid (terlalu pendek). Silakan masukkan tujuan yang benar:\nKetik *0* atau *B* untuk batal.`
            });
        }

        session.tempSubTarget = target;
        session.step = S.PILIH_INTERVAL_SUBS;

        let t = `⏱️ *MASUKKAN INTERVAL PEMBELIAN (JUMLAH HARI)*\n\n`;
        t += `Berapa hari sekali pesanan *${session.tempSubProduct.nama}* ingin dibeli secara otomatis?\n\n`;
        t += `Silakan ketik angka jumlah hari secara langsung:\n`;
        t += `• Ketik *1* untuk *Setiap Hari* (1 hari sekali / harian)\n`;
        t += `• Ketik *3* untuk *Setiap 3 Hari*\n`;
        t += `• Ketik *7* untuk *Setiap Minggu* (7 hari sekali)\n`;
        t += `• Ketik *14* untuk *Setiap 2 Minggu* (14 hari sekali)\n`;
        t += `• Ketik *30* untuk *Setiap Bulan* (30 hari sekali)\n`;
        t += `• Atau ketik angka hari lainnya bebas sesuai kebutuhan Anda (1 - 365).\n\n`;
        t += `👉 Ketik *angka hari* (contoh: *1* atau *7* atau *30*).\nKetik *B* untuk batal.`;
        return sock.sendMessage(sender, { text: t });
    }

    // 4. MASUKKAN INTERVAL HARI
    if (session.step === S.PILIH_INTERVAL_SUBS) {
        if (txt === 'B' || txt === 'BATAL') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Batal. Ketik *MENU* untuk kembali ke menu utama." });
        }

        const cleanNum = txt.replace(/[^0-9]/g, '');
        const days = parseInt(cleanNum, 10);

        if (isNaN(days) || days < 1 || days > 365) {
            return sock.sendMessage(sender, {
                text: `⚠️ Jumlah hari tidak valid. Silakan ketik angka hari antara 1 sampai 365 hari.\n\nContoh:\n• Ketik *1* untuk beli setiap 1 hari sekali (tiap hari)\n• Ketik *7* untuk seminggu sekali\n• Ketik *30* untuk sebulan sekali\n\nKetik *B* untuk batal.`
            });
        }

        session.tempSubInterval = days;
        session.step = S.PILIH_CYCLES_SUBS;

        let t = `🔢 *MASUKKAN JUMLAH PEMBELIAN (SIKLUS)*\n\n`;
        t += `Berapa kali pesanan ini akan dibeli secara otomatis?\n\n`;
        t += `Silakan ketik angka jumlah pembelian yang Anda inginkan:\n`;
        t += `• Ketik angka (contoh: *3*, *5*, *10*, *12*, dst)\n`;
        t += `• Atau ketik *0* jika ingin *Tanpa Batas* (terus berjalan otomatis sampai Anda batalkan sendiri).\n\n`;
        t += `👉 Ketik *angka jumlah siklus* (contoh: *5* atau ketik *0* untuk tanpa batas).\nKetik *B* untuk batal.`;
        return sock.sendMessage(sender, { text: t });
    }

    // 5. MASUKKAN JUMLAH PEMBELIAN (SIKLUS)
    if (session.step === S.PILIH_CYCLES_SUBS) {
        if (txt === 'B' || txt === 'BATAL') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Batal. Ketik *MENU* untuk kembali ke menu utama." });
        }

        let cycles = null;
        if (txt === '0' || txt === 'BEBAS' || txt === 'UNLIMITED') {
            cycles = 0; // 0 = unlimited / berkelanjutan
        } else {
            const cleanNum = txt.replace(/[^0-9]/g, '');
            if (cleanNum !== '') {
                cycles = parseInt(cleanNum, 10);
            }
        }

        if (cycles === null || isNaN(cycles) || cycles < 0 || cycles > 365) {
            return sock.sendMessage(sender, {
                text: `⚠️ Jumlah pembelian tidak valid. Silakan ketik angka (misal: *3*, *5*, *10*) atau ketik *0* untuk tanpa batas.\n\nKetik *B* untuk batal.`
            });
        }

        session.tempSubCycles = cycles;
        session.step = S.CONFIRM_SUBS;

        const u = db.getUser ? db.getUser(sender) : (db.users[sender] || { saldo: 0 });
        const userSaldo = Number(u.saldo) || 0;
        const harga = Number(session.tempSubProduct.hargaJual) || 0;
        const intervalStr = subLib.formatInterval(session.tempSubInterval);
        const cycleStr = subLib.formatCycles(cycles);

        let t = `📋 *KONFIRMASI LANGGANAN (AUTO-ORDER)*\n\n`;
        t += `Mohon tinjau rincian langganan otomatis Anda di bawah ini:\n\n`;
        t += `• *Produk*          : *${session.tempSubProduct.nama}*\n`;
        t += `• *Tujuan*          : \`${session.tempSubTarget}\`\n`;
        t += `• *Harga / Order*   : *${formatRupiah(harga)}*\n`;
        t += `• *Interval Waktu*  : Setiap *${intervalStr}*\n`;
        t += `• *Total Pembelian* : *${cycleStr}*\n`;
        t += `• *Saldo Akun Anda* : *${formatRupiah(userSaldo)}*\n\n`;
        t += `💳 *Metode Pembayaran:* Auto-Debit Saldo Akun\n\n`;
        t += `⚠️ *Ketentuan Layanan Auto-Order:*\n`;
        t += `1. Pembayaran siklus pertama sebesar *${formatRupiah(harga)}* akan dipotong langsung dari saldo akun Anda sekarang.\n`;
        t += `2. Siklus berikutnya akan dipotong otomatis setiap *${session.tempSubInterval} hari* selama saldo Anda mencukupi.\n`;
        t += `3. Anda bebas berhenti berlangganan kapan saja melalui perintah *.batallangganan* tanpa denda.\n\n`;
        t += `👉 Balas *1* untuk *SETUJU & AKTIFKAN SEKARANG*\n`;
        t += `👉 Balas *2* atau *B* untuk *BATAL*`;
        return sock.sendMessage(sender, { text: t });
    }

    // 6. KONFIRMASI & EKSEKUSI PEMBUATAN LANGGANAN
    if (session.step === S.CONFIRM_SUBS) {
        if (txt === '2' || txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Pendaftaran langganan dibatalkan. Ketik *MENU* untuk kembali berbelanja." });
        }

        if (txt === '1') {
            const cleanBuyer = db.normalizeJid ? db.normalizeJid(sender) : sender;
            const buyerUser = db.getUser(cleanBuyer);
            const actualSaldo = Number(buyerUser?.saldo) || 0;
            const harga = Number(session.tempSubProduct.hargaJual) || 0;

            if (actualSaldo < harga) {
                session.step = S.IDLE;
                return sock.sendMessage(sender, {
                    text: `❌ *SALDO AKUN TIDAK MENCUKUPI*\n\n` +
                          `• Saldo Anda saat ini : *${formatRupiah(actualSaldo)}*\n` +
                          `• Biaya Siklus 1      : *${formatRupiah(harga)}*\n\n` +
                          `Silakan lakukan deposit saldo terlebih dahulu via menu *8* (Deposit QRIS) atau ketik *.deposit*, kemudian ulangi aktivasi langganan.`
                });
            }

            const oid = `INV-${Date.now()}`;
            const deduct = db.deductSaldo(cleanBuyer, harga, oid, `[LANGGANAN #1] ${session.tempSubProduct.nama}`);
            if (!deduct || !deduct.success) {
                session.step = S.IDLE;
                return sock.sendMessage(sender, {
                    text: `❌ *GAGAL MEMPROSES TRANSAKSI*\nAlasan: ${deduct?.reason || 'Pemotongan saldo gagal'}`
                });
            }

            let buyerPhone = buyerUser.phone || '';
            if (!buyerPhone && !sender.includes('@lid')) {
                buyerPhone = sender.split('@')[0].split(':')[0];
            }
            if (buyerPhone.startsWith('0')) buyerPhone = '62' + buyerPhone.slice(1);

            const newSub = subLib.createSubscription({
                buyer: cleanBuyer,
                buyerPhone: buyerPhone,
                catalogId: session.tempSubProduct.id,
                sku: session.tempSubProduct.sku,
                productType: session.tempSubProduct.type,
                productName: session.tempSubProduct.nama,
                target: session.tempSubTarget,
                price: harga,
                intervalDays: session.tempSubInterval,
                maxCycles: session.tempSubCycles,
                firstOrderId: oid
            });

            const order = {
                id: oid,
                buyer: cleanBuyer,
                sender: cleanBuyer,
                item: session.tempSubProduct.nama,
                sku: session.tempSubProduct.sku,
                target: session.tempSubTarget,
                qty: 1,
                price: harga,
                baseAmount: harga,
                total: harga,
                method: 'Saldo Akun (Auto-Debit Langganan)',
                status: 'processing',
                isPpob: session.tempSubProduct.type === 'ppob',
                isSubscription: true,
                subscriptionId: newSub.id,
                cycle: 1,
                timestamp: Date.now()
            };

            if (!db.orders) db.orders = [];
            db.orders.push(order);
            db.saveOrders();

            session.step = S.IDLE;

            const nextDateStr = newSub.nextRunAt 
                ? new Date(newSub.nextRunAt).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) 
                : '-';
            const cycleStr = subLib.formatCycles(newSub.maxCycles, 1);

            let successMsg = `🎉 *LANGGANAN BERHASIL DIAKTIFKAN!*\n\n` +
                `Selamat, pesanan otomatis Anda telah terdaftar di sistem kami:\n\n` +
                `• *ID Langganan* : \`${newSub.id}\`\n` +
                `• *Produk*       : *${newSub.productName}*\n` +
                `• *Tujuan*       : \`${newSub.target}\`\n` +
                `• *Interval*     : Setiap *${subLib.formatInterval(newSub.intervalDays)}*\n` +
                `• *Siklus*       : *${cycleStr}*\n` +
                `• *Inv Siklus 1* : \`${oid}\`\n`;

            if (newSub.nextRunAt) {
                successMsg += `• *Perpanjangan 2*: *${nextDateStr}*\n`;
            }

            successMsg += `• *Sisa Saldo*   : *${formatRupiah(deduct.remainingSaldo)}*\n\n` +
                `⏳ *Status:* Siklus ke-1 sedang kami proses dan segera dikirimkan.\n` +
                `💡 *Penghentian:* Anda dapat membatalkan langganan kapan saja dengan mengetik:\n\`.batallangganan ${newSub.id}\``;

            await sock.sendMessage(sender, { text: successMsg });

            // Eksekusi pesanan siklus pertama via handleSuccessPayment
            const paymentHandler = global.handleSuccessPayment;
            if (typeof paymentHandler === 'function') {
                try {
                    await paymentHandler(sock, order, true);
                } catch (e) {
                    console.error('[SUBS INITIAL EXECUTION ERROR]', e.message);
                }
            }

            // Notifikasi ke Telegram Admin
            if (global.botTg && config.telegram?.chatId) {
                global.botTg.sendMessage(config.telegram.chatId,
                    `🔄 *[KONTRAK LANGGANAN BARU DIAKTIFKAN]*\n\n` +
                    `• ID Langganan : \`${newSub.id}\`\n` +
                    `• Invoice 1    : \`${oid}\`\n` +
                    `• Produk       : *${newSub.productName}*\n` +
                    `• Target       : \`${newSub.target}\`\n` +
                    `• Biaya/Siklus : *${formatRupiah(harga)}*\n` +
                    `• Interval     : *${subLib.formatInterval(newSub.intervalDays)}*\n` +
                    `• Siklus       : *${cycleStr}*\n` +
                    `• Pembeli      : \`+${buyerPhone}\``,
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
            }

            return;
        } else {
            return sock.sendMessage(sender, {
                text: `⚠️ Balas *1* untuk SETUJU & AKTIFKAN, atau *2* untuk BATAL.`
            });
        }
    }
}

async function showInvoice(sock, sender, session) {
    const isPpob = !!session.tempItem.sku;
    const qty = isPpob ? 1 : (session.tempQty || 1);
    const total = (isPpob ? session.tempItem.hargaJual : session.tempItem.harga) * qty;
    const user = db.getUser(sender);
    const saldo = Number(user.saldo) || 0;
    
    let t = `🧾 *KONFIRMASI PESANAN*\n\n`;
    t += `📦 Produk : *${session.tempItem.cleanName || session.tempItem.nama}*\n`;
    if (isPpob) t += `🎯 Tujuan : *${session.tempTarget}*\n`;
    else t += `📊 Jumlah : *${qty}*\n`;
    
    t += `💰 Total  : *${formatRupiah(total)}*\n`;
    t += `💵 Saldo  : ${formatRupiah(saldo)}\n\n`;
    
    if (saldo >= total) {
        t += `💳 *Metode Bayar:* Potong Saldo Otomatis (Instan)\n\n`;
    } else {
        t += `💳 *Metode Bayar:* QRIS Otomatis (BCA, DANA, GoPay, OVO, ShopeePay)\n\n`;
    }
    t += `👉 Balas *1* untuk BAYAR SEKARANG\n👉 Balas *2* untuk BATAL\n\n`;
    if (!isPpob) {
        t += legal.getTermsDigitalShort();
    } else {
        t += `⚖️ _Membayar berarti menyetujui S&K Layanan (salah no tujuan tanggung jawab pembeli). Info: ketik .snk_`;
    }
    
    await sock.sendMessage(sender, { text: t });
}

exports.handleUser = handleUser;

exports.S = {
    IDLE: 0,
    PILIH_KATEGORI: 1,
    INPUT_TARGET_PULSA: 2,
    PILIH_PRODUK_PULSA: 3,
    PILIH_BRAND_EMONEY: 4,
    INPUT_TARGET_EMONEY: 5,
    PILIH_PRODUK_EMONEY: 6,
    PILIH_PRODUK_DIGITAL: 7,
    QTY_DIGITAL: 8,
    CONFIRM: 9,
    INPUT_DEPOSIT: 10,
    PILIH_KATEGORI_PASCA: 11,
    INPUT_TARGET_PASCA: 12,
    PILIH_PRODUK_PASCA: 13,
    PILIH_SUB_MENU: 14,
    PILIH_PRODUK_SUBS: 15,
    INPUT_TARGET_SUBS: 16,
    PILIH_INTERVAL_SUBS: 17,
    PILIH_CYCLES_SUBS: 18,
    CONFIRM_SUBS: 19
};

module.exports = {
    handleUser,
    S
};

