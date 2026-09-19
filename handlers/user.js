const db = require('../database/db');
const { formatRupiah, detectOperator } = require('../lib/utils');
const api = require('../lib/api');
const config = require('../config');

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
    PILIH_PRODUK_PASCA: 13
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
    
    t += `\n👇 Balas angka pilihan Anda.`;

    if (session.tempSmartMode || session.tempSearchKeyword) {
        t += `\n\n➡️ Ketik *LANJUT* atau *Z* untuk melihat seluruh katalog ${session.tempOp || session.tempBrand || ''}.`;
    } else if (maxPage > 0) {
        t += `\n➡️ Ketik *LANJUT* atau *Z* untuk halaman berikutnya (${session.tempPage + 1}/${maxPage + 1}).`;
    }

    // PANDUAN PENCARIAN & PEMBELIAN CEPAT (SESUAI PERMINTAAN USER)
    if (session.tempTipe === 'Data') {
        t += `\n\n⚡ *Pencarian Cepat Paket Data:*\n`;
        t += `Balas langsung kriteria paket yang Anda inginkan:\n`;
        t += `• Kuota : ketik *2gb*, *10gb*, *500mb*, dll\n`;
        t += `• Masa Aktif : ketik *30hari*, *7hari*, *1hari*, dll\n`;
        t += `• Rentang Harga : ketik *25k*, *50k*, *100k*, dll\n`;
        t += `• Nama Paket : ketik kata kunci (contoh: *combo*, *akrab*)`;
    } else if (session.tempTipe === 'Pulsa' || session.tempTipe === 'E-Money') {
        t += `\n\n⚡ *Pencarian Cepat Nominal:*\n`;
        t += `Ketik nominal yang dicari, contoh: *10k*, *50k*, *100k*`;
    }
    
    await sock.sendMessage(sender, { text: t });
}

async function handleUser(sock, sender, text, session, processCheckout) {
    const rawTrim = text.trim();
    const txt = rawTrim.toUpperCase();
    const parts = rawTrim.split(/\s+/);
    const cmdFirst = parts[0].toUpperCase();

    // 0. QUICK USER COMMANDS
    if (['.HELP', '!HELP', 'HELP', '.BANTUAN', '!BANTUAN', 'BANTUAN'].includes(txt)) {
        let t = `📖 *PANDUAN TRANSAKSI INSTAN*\n\n`;
        t += `• *MENU* : Buka menu belanja interaktif\n`;
        t += `• *.beli [Kode_Produk] [NoHP]* : Transaksi cepat instan\n`;
        t += `• *.harga [Operator]* : Cek daftar harga & kode produk\n`;
        t += `• *.deposit* : Isi saldo akun via QRIS otomatis\n`;
        t += `• *.profil* : Cek saldo dompet Anda\n`;
        t += `• *.riwayat* : Cek 5 transaksi terakhir\n`;
        t += `• *.status [Invoice]* : Cek status transaksi / token\n`;
        t += `• *.transfer [NoHP] [Nominal]* : Kirim saldo ke member\n`;
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
        t += `├ *7.* 💰 Isi Saldo (Deposit QRIS)\n`;
        t += `├ *8.* 👤 Profil & Cek Saldo\n`;
        t += `├ *9.* 🧾 Riwayat Transaksi\n`;
        t += `├ *10.* 📖 Bantuan & Panduan\n│\n`;
        t += `╰───────────────────────────\n\n`;
        t += `👇 Balas dengan *ANGKA (1 - 10)* untuk memilih menu.`;
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
        caption:
        `💰 *DEPOSIT SALDO*

Nominal:
Rp ${(qris.data && qris.data.total_bayar ? Number(qris.data.total_bayar) : finalAmount).toLocaleString('id-ID')}
_*(Fee/Unik: Rp ${((qris.data && qris.data.total_bayar ? Number(qris.data.total_bayar) : finalAmount) - amount).toLocaleString('id-ID')})*_

🧾 ID:
${depositId}

⏳  Expired:
5 menit

Silakan scan QRIS di atas.`
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

    if (txt === 'B' || txt === '0') {
        session.step = S.IDLE;
        return sock.sendMessage(sender, { text: "🚫 Aksi dibatalkan. Ketik *MENU* untuk kembali belanja." });
    }

    // 2. PILIH KATEGORI (1-10)
    if (session.step === S.PILIH_KATEGORI || (session.step === S.IDLE && /^(10|[1-9])$/.test(txt))) {
        if (txt === '1' || txt === '2') {
            session.tempTipe = txt === '1' ? 'Pulsa' : 'Data';
            session.step = S.INPUT_TARGET_PULSA;
            if (session.tempTipe === 'Data') {
                return sock.sendMessage(sender, {
                    text: `📶 *PAKET DATA INTERNET*\n\nSilakan masukkan *Nomor HP Tujuan*:\n_Contoh: 08123456789_\n\n⚡ *Tips Beli Cepat Langsung Filter:*\nBisa sertakan kata kunci setelah nomor, contoh:\n• _08123456789 2gb_ (Paket ~2GB)\n• _08123456789 30hari_ (Paket 30 Hari)\n• _08123456789 50k_ (Paket ~Rp50.000)\n\nKetik *0* atau *B* untuk batal.`
                });
            }
            return sock.sendMessage(sender, {
                text: `📱 *PULSA REGULER*\n\nSilakan masukkan *Nomor HP Tujuan*:\n_Contoh: 08123456789_\n\nKetik *0* atau *B* untuk batal.`
            });
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
            t += `Balas *Angka (1 - ${db.menu.length})* produk pilihan Anda.\nKetik *0* atau *B* untuk batal.`;
            return sock.sendMessage(sender, { text: t });
        } else if (txt === '7') {
            session.step = S.INPUT_DEPOSIT;
            return sock.sendMessage(sender, {
                text: `💰 *DEPOSIT SALDO OTOMATIS (QRIS)*\n\nMasukkan nominal deposit yang diinginkan:\n📌 Minimal: Rp1.000\n📌 Maksimal: Rp500.000\n\n_Contoh: 10000_\nKetik *0* atau *B* untuk batal.`
            });
        } else if (txt === '8') {
            session.step = S.IDLE;
            const u = db.getUser(sender);
            let displayNo = u.phone || '';
            if (displayNo.startsWith('62')) displayNo = '0' + displayNo.slice(2);
            if (!displayNo && !sender.includes('@lid')) displayNo = sender.split('@')[0].split(':')[0];
            const namePart = u.name ? `\n👤 Nama: *${u.name}*` : '';
            return sock.sendMessage(sender, {
                text: `👤 *PROFIL PENGGUNA*${namePart}\n📱 Nomor HP: *${displayNo || '-'}*\n💰 Saldo: *${formatRupiah(u.saldo || 0)}*\n\n_Ketik *MENU* untuk belanja, atau balas *7* untuk isi saldo._`
            });
        } else if (txt === '9') {
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
        } else if (txt === '10') {
            session.step = S.IDLE;
            let t = `📖 *PANDUAN LENGKAP TRANSAKSI*\n\n`;
            t += `*Cara Berbelanja via Menu Angka:*\n`;
            t += `1. Ketik *MENU* untuk membuka katalog layanan.\n`;
            t += `2. Balas angka layanan yang diinginkan (1 - 6).\n`;
            t += `3. Masukkan nomor HP / ID Pelanggan tujuan.\n`;
            t += `4. Pilih produk / nominal dengan membalas angka.\n`;
            t += `5. Konfirmasi: Balas *1* untuk Bayar, *2* untuk Batal.\n\n`;
            t += `*Shortcut Cepat (Opsional):*\n`;
            t += `• *.beli [SKU] [NoHP]* : Beli instan\n`;
            t += `• *.harga [Operator]* : Cek daftar harga & SKU\n`;
            t += `• *.transfer [NoHP] [Nominal]* : Kirim saldo ke sesama member\n`;
            t += `• *.status [Invoice]* : Cek status / token transaksi\n`;
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

            const pascaProfit = (config.profit && typeof config.profit.pasca === 'number') ? config.profit.pasca : 1500;
            const totalAmount = billAmount + pascaProfit;
            const period = data.period || '-';

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
                period: period
            };
            session.tempQty = 1;
            session.step = S.CONFIRM;

            const user = db.getUser(sender);
            const userSaldo = Number(user.saldo) || 0;

            let invoiceText = `🧾 *RINCIAN TAGIHAN PASCABAYAR*\n\n`;
            invoiceText += `📦 Layanan: *${product.name}*\n`;
            invoiceText += `👤 Nama Pelanggan: *${customerName}*\n`;
            invoiceText += `🎯 ID Pelanggan: *${target}*\n`;
            invoiceText += `📅 Periode: *${period}*\n`;
            invoiceText += `💵 Tagihan: *${formatRupiah(billAmount - adminFee)}*\n`;
            invoiceText += `📑 Biaya Admin & Layanan: *${formatRupiah(adminFee + pascaProfit)}*\n`;
            invoiceText += `────────────────────────\n`;
            invoiceText += `💰 *TOTAL BAYAR: ${formatRupiah(totalAmount)}*\n\n`;
            invoiceText += `💵 Saldo Dompet Anda: ${formatRupiah(userSaldo)}\n`;
            invoiceText += userSaldo >= totalAmount ? `_Saldo Anda mencukupi (Potong Otomatis)._\n\n` : `_Pembayaran via QRIS Otomatis._\n\n`;
            invoiceText += `Balas *1* untuk BAYAR SEKARANG\nBalas *2* untuk BATAL`;

            return sock.sendMessage(sender, { text: invoiceText });
        } catch (err) {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: `❌ *ERROR SERVER:* Gagal memproses inquiry tagihan (${err.message}). Silakan coba beberapa saat lagi.` });
        }
    }

    // 3. ALUR PULSA/DATA (Auto Detect -> Sort -> Group -> Paginate)
    if (session.step === S.INPUT_TARGET_PULSA) {
        let searchKeyword = '';
        let rawInput = text.trim();

        if (session.tempTipe === 'Data') {
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

        const phone = rawInput.replace(/[^0-9]/g, '');
        if (phone.length < 10) return sock.sendMessage(sender, { text: `❌ Nomor tidak valid.` });
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
        const isNextCmd = ['Z', 'N', 'NEXT', 'L', 'LANJUT', '00', '>'].includes(upperTxt) || isResetCmd;

        // 1. Paginasi & Navigasi Halaman
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
                    text:
`⚠️ Paket "${rawSearch}" tidak ditemukan pada katalog ${session.tempOp || session.tempBrand || ''} saat ini.

⚡ *Tips Pencarian Cepat:*
• Kuota : ketik *2gb*, *10gb*, *500mb*
• Masa Aktif : ketik *30hari*, *7hari*, *1hari*
• Rentang Harga : ketik *25k*, *50k*, *100k*
• Nama Paket : ketik kata kunci (contoh: *combo*, *akrab*)

Ketik *LANJUT* atau *SEMUA* untuk melihat katalog lengkap.`
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
                text: `❌ Pilihan tidak valid. Balas nomor produk (1-${session.tempList.length}), ketik pencarian paket (cth: *2gb*, *30hari*, *50k*), atau ketik *LANJUT* / *Z* untuk ganti halaman.`
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
        if (txt === '1' || txt === 'Y') {
            session.step = S.IDLE;
            await processCheckout(sock, sender, session);
            return;
        } else if (txt === '2' || txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Pesanan dibatalkan. Ketik *MENU* untuk kembali belanja." });
        } else {
            return sock.sendMessage(sender, { text: "⚠️ Balas *1* untuk BAYAR SEKARANG, atau *2* untuk BATAL." });
        }
    }
}

async function showInvoice(sock, sender, session) {
    const isPpob = !!session.tempItem.sku;
    const qty = isPpob ? 1 : (session.tempQty || 1);
    const total = (isPpob ? session.tempItem.hargaJual : session.tempItem.harga) * qty;
    const user = db.getUser(sender);
    const saldo = Number(user.saldo) || 0;
    
    let t = `🧾 *KONFIRMASI PESANAN*\n\n📦 ${session.tempItem.cleanName || session.tempItem.nama}\n`;
    if (isPpob) t += `🎯 Tujuan: *${session.tempTarget}*\n`;
    else t += `📊 Jumlah: ${qty}\n`;
    
    t += `💵 Total: *${formatRupiah(total)}*\n💰 Saldo Anda: ${formatRupiah(saldo)}\n\n`;
    t += saldo >= total ? `_Saldo mencukupi (Potong Otomatis)._\n\n` : `_Pembayaran via QRIS Otomatis._\n\n`;
    t += `Balas *1* untuk BAYAR SEKARANG\nBalas *2* untuk BATAL`;
    
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
    PILIH_PRODUK_PASCA: 13
};

module.exports = {
    handleUser,
    S
};

