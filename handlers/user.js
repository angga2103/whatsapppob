const { searchProducts } = require('../lib/search');
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

async function showProductList(sock, sender, session) {
    const perPage = 10;
    const total = session.tempList.length;
    const maxPage = Math.ceil(total / perPage) - 1;
    
    if (session.tempPage > maxPage) session.tempPage = 0; // Kembali ke awal jika kelewatan
    
    const start = session.tempPage * perPage;
    const end = start + perPage;
    const pageItems = session.tempList.slice(start, end);
    
    let t = `📱 *KATALOG ${session.tempOp || session.tempBrand}*\n`;
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
    
    t += `\n👇 Ketik angka untuk pilih produk.`;

    if (session.tempSmartMode) {

        t += `\n\n➡️ Ketik *Z* untuk melihat seluruh katalog ${session.tempOp}.`;

    }

    else if (maxPage > 0) {

        t += `\n➡️ Ketik *Z* untuk melihat halaman selanjutnya.`;

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
        t += `• *.beli [SKU] [NoHP]* : Transaksi cepat instan\n`;
        t += `• *.harga [Operator]* : Cek daftar harga & SKU\n`;
        t += `• *.deposit* : Isi saldo akun via QRIS otomatis\n`;
        t += `• *.profil* : Cek saldo dompet Anda\n`;
        t += `• *.riwayat* : Cek 5 transaksi terakhir\n`;
        t += `• *.status [Invoice]* : Cek status transaksi / token\n`;
        t += `• *.transfer [NoHP] [Nominal]* : Kirim saldo ke member\n`;
        t += `• *B* : Batalkan transaksi yang sedang berjalan\n\n`;
        t += `🏪 *${db.store.namaToko || 'DIGITAL STORE'}* - Aman, Cepat, dan Otomatis.`;
        return sock.sendMessage(sender, { text: t });
    }

    // FAST ORDER: .beli [SKU] [NoHP]
    if (['.BELI', '!BELI', 'BELI'].includes(cmdFirst)) {
        const sku = (parts[1] || '').trim();
        const target = (parts[2] || '').trim().replace(/[^0-9]/g, '');
        if (!sku || !target) {
            return sock.sendMessage(sender, {
                text: `🛒 *FORMAT TRANSAKSI INSTAN:*\n.beli [SKU] [Nomor_Tujuan]\n\nContoh:\n• .beli S10 081234567890\n• .beli PLN20 123456789012\n\n_Ketik *.harga [operator]* untuk melihat daftar SKU._`
            });
        }
        const product = (db.ppob || []).find(p => p.sku && p.sku.toUpperCase() === sku.toUpperCase())
                     || (db.menu || []).find(m => m.id == sku || (m.nama && m.nama.toUpperCase().includes(sku.toUpperCase())));
        if (!product) {
            return sock.sendMessage(sender, {
                text: `❌ Produk dengan SKU *${sku}* tidak ditemukan.\nKetik *.harga* untuk melihat daftar produk aktif.`
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
        let t = `╭── 🛍️ *${db.store.namaToko || 'GARUDATEL STORE'}* ──\n│\n`;
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

    db.deposits.push({
        id: depositId,
        buyer: canonicalSender,
        amount: amount,
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
        
        let realJid = sender;
        if (sender.includes('@lid')) {
            let pPhone = (db.users[sender] && db.users[sender].phone) ? String(db.users[sender].phone).replace(/[^0-9]/g, '') : sender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
            if (pPhone.startsWith('0')) pPhone = '62' + pPhone.slice(1);
            let findMain = Object.entries(db.users).find(([j, u]) => !j.includes('@lid') && (u.phone === pPhone || j.startsWith(pPhone)));
            if (findMain) realJid = findMain[0];
        }
        
        let p = db.users[realJid] || db.users[sender] || {};
        return sock.sendMessage(sender, { text: `👤 *PROFIL*\n📱 HP: ${p.phone || realJid.split('@')[0].replace(/[^0-9]/g, '')}\n💰 Saldo: *${typeof formatRupiah !== 'undefined' ? formatRupiah(p.saldo || 0) : 'Rp ' + (p.saldo || 0).toLocaleString('id-ID')}*\n\n_Ketik *DEPOSIT* untuk isi saldo._` });
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
                    text: `📶 *PAKET DATA INTERNET*\n\nSilakan masukkan *Nomor HP Tujuan*:\n_Contoh: 08123456789_\n\nKetik *0* atau *B* untuk batal.`
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
            t += `*1.* ⚡ PLN Pascabayar (Tagihan Listrik Bulanan)\n`;
            t += `*2.* 🏥 BPJS Kesehatan\n`;
            t += `*3.* 💧 PDAM (Air Minum Daerah)\n`;
            t += `*4.* 🏢 PBB (Pajak Bumi & Bangunan)\n`;
            t += `*5.* ⚡ PLN Non-Taglis\n`;
            t += `*6.* 📱 HP Pascabayar & Internet Kabel\n\n`;
            t += `Balas *Angka (1 - 6)* kategori tagihan Anda.\nKetik *0* atau *B* untuk batal.`;
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
            return sock.sendMessage(sender, {
                text: `👤 *PROFIL PENGGUNA*\n📱 Nomor: ${u.phone || sender.split('@')[0]}\n💰 Saldo: *${formatRupiah(u.saldo || 0)}*\n\n_Ketik *MENU* untuk belanja, atau balas *7* untuk isi saldo._`
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
            t += `🏪 *${db.store.namaToko || 'GARUDATEL STORE'}* - Aman, Cepat, dan Otomatis.`;
            return sock.sendMessage(sender, { text: t });
        }
    }

    // 2B. ALUR PASCABAYAR: PILIH KATEGORI (1-6)
    if (session.step === S.PILIH_KATEGORI_PASCA) {
        if (txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Transaksi dibatalkan. Ketik *MENU* untuk kembali." });
        }
        const pascaProducts = db.postpaid || [];
        let selectedCategory = '';
        let targetLabel = 'ID Pelanggan';

        if (txt === '1') {
            selectedCategory = 'PLN PASCABAYAR';
            targetLabel = 'ID Pelanggan PLN (12 Digit)';
        } else if (txt === '2') {
            selectedCategory = 'BPJS KESEHATAN';
            targetLabel = 'Nomor Virtual Account / Kartu BPJS';
        } else if (txt === '3') {
            selectedCategory = 'PDAM';
            targetLabel = 'Nomor Pelanggan PDAM';
        } else if (txt === '4') {
            selectedCategory = 'PBB';
            targetLabel = 'Nomor Objek Pajak (NOP)';
        } else if (txt === '5') {
            selectedCategory = 'PLN NONTAGLIS';
            targetLabel = 'Nomor Registrasi PLN Non-Taglis';
        } else if (txt === '6') {
            selectedCategory = 'HP PASCABAYAR';
            targetLabel = 'Nomor HP Pascabayar';
        } else {
            return sock.sendMessage(sender, { text: "❌ Pilihan salah. Balas dengan angka *1 - 6*, atau *0* untuk batal." });
        }

        let matched = pascaProducts.filter(p => p.brand && p.brand.toUpperCase().includes(selectedCategory));
        if (matched.length === 0) {
            matched = pascaProducts.filter(p => (p.name && p.name.toUpperCase().includes(selectedCategory)) || (p.category && p.category.toUpperCase().includes(selectedCategory)));
        }

        if (matched.length <= 1) {
            const product = matched[0] || { sku: (selectedCategory === 'BPJS KESEHATAN' ? 'post685476' : selectedCategory === 'PLN PASCABAYAR' ? 'plnpost' : 'post685472'), brand: selectedCategory, name: selectedCategory };
            session.tempPostpaidProduct = product;
            session.tempPostpaidCategory = selectedCategory;
            session.step = S.INPUT_TARGET_PASCA;
            return sock.sendMessage(sender, {
                text: `📑 *TAGIHAN ${selectedCategory}*\n\nSilakan masukkan *${targetLabel}*:\n_Contoh: 512345678901_\n\nKetik *0* atau *B* untuk batal.`
            });
        } else {
            session.tempPostpaidList = matched.slice(0, 15);
            session.step = S.PILIH_PRODUK_PASCA;
            let t = `💧 *PILIH WILAYAH ${selectedCategory}*\n\n`;
            session.tempPostpaidList.forEach((p, idx) => {
                t += `*${idx + 1}.* ${p.name}\n`;
            });
            t += `\nBalas angka (*1 - ${session.tempPostpaidList.length}*) pilihan Anda.\nKetik *0* atau *B* untuk batal.`;
            return sock.sendMessage(sender, { text: t });
        }
    }

    if (session.step === S.PILIH_PRODUK_PASCA) {
        if (txt === 'B' || txt === '0') {
            session.step = S.IDLE;
            return sock.sendMessage(sender, { text: "🚫 Transaksi dibatalkan. Ketik *MENU* untuk kembali." });
        }
        const idx = parseInt(txt) - 1;
        if (isNaN(idx) || !session.tempPostpaidList || !session.tempPostpaidList[idx]) {
            return sock.sendMessage(sender, { text: "❌ Pilihan tidak valid. Balas angka yang tertera di menu." });
        }
        const product = session.tempPostpaidList[idx];
        session.tempPostpaidProduct = product;
        session.step = S.INPUT_TARGET_PASCA;
        return sock.sendMessage(sender, {
            text: `📑 *${product.name.toUpperCase()}*\n\nSilakan masukkan *Nomor / ID Pelanggan*:\n_Contoh: 1234567890_\n\nKetik *0* atau *B* untuk batal.`
        });
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
        const product = session.tempPostpaidProduct || { sku: 'plnpost', name: 'PLN Pascabayar', brand: 'PLN' };
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
            const totalAmount = billAmount;
            const period = data.period || '-';

            session.tempItem = {
                sku: product.sku,
                nama: `${product.name} (${customerName})`,
                cleanName: product.name,
                hargaJual: totalAmount,
                isPasca: true
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
            invoiceText += `📑 Biaya Admin: *${formatRupiah(adminFee)}*\n`;
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

        if (
            session.tempTipe === 'Data' &&
            rawInput.includes('.')
        ) {
            const parts = rawInput.split('.');
            rawInput = parts[0];
            searchKeyword = parts.slice(1).join('.').trim();
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

        // SMART DATA
        if (session.tempTipe === 'Data') {

            session.tempSearchKeyword = searchKeyword;


            if (searchKeyword) {

                const keyword =
                    searchKeyword.toLowerCase().trim();

                if (keyword.endsWith('gb')) {

                    const target =
                        parseFloat(
                            keyword.replace('gb','')
                        );

                    parsedProducts =
                        parsedProducts
                        .filter(
                            p => p.quotaGb > 0
                        )
                        .sort(
                            (a,b)=>
                                Math.abs(a.quotaGb-target)
                                -
                                Math.abs(b.quotaGb-target)
                        )
                        .slice(0,10);

                }

                else if (
                    keyword.endsWith('k')
                ) {

                    const target =
                        parseInt(
                            keyword.replace('k','')
                        ) * 1000;

                    parsedProducts =
                        parsedProducts
                        .sort(
                            (a,b)=>
                                Math.abs(a.hargaJual-target)
                                -
                                Math.abs(b.hargaJual-target)
                        )
                        .slice(0,10);

                }

                else if (
                    keyword.endsWith('h')
                ) {

                    const target =
                        parseInt(
                            keyword.replace('h','')
                        );

                    parsedProducts =
                        parsedProducts
                        .filter(
                            p => p.validityDays > 0
                        )
                        .sort(
                            (a,b)=>
                                Math.abs(a.validityDays-target)
                                -
                                Math.abs(b.validityDays-target)
                        )
                        .slice(0,10);

                }

                else {

                    parsedProducts =
                        parsedProducts.filter(p => {

                            const gabung =
                                (
                                    (p.nama || '') +
                                    ' ' +
                                    (p.cleanName || '') +
                                    ' ' +
                                    (p.groupName || '')
                                ).toLowerCase();

                            return gabung.includes(
                                keyword
                            );

                        }).slice(0,10);

                }

            } else {

                parsedProducts =
                    parsedProducts
                    .sort(
                        (a,b)=>
                            a.hargaJual-b.hargaJual
                    )
                    .slice(0,5);

                session.tempSmartMode = true;

            }
        }

        session.tempAllProducts =
            produkRaw.map(p => ({
                ...p,
                ...parseProduct(
                    p.nama,
                    operator
                )
            }));

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

        session.tempList = parsedProducts;
        session.tempPage = 0;
        session.step = S.PILIH_PRODUK_EMONEY;
        
        return showProductList(sock, sender, session);
    }

    

// ========================================
// SMART SEARCH PRODUK
// ========================================

if (
    session.step === S.PILIH_PRODUK_PULSA ||
    session.step === S.PILIH_PRODUK_EMONEY
) {

    // MODE SEARCH
    if (
        !/^\d+$/.test(txt) &&
        txt !== 'Z'
    ) {

        const keyword = txt.toLowerCase();

        let sourceProducts =
            session.tempAllProducts ||
            session.tempList;

        // SMART SEARCH GB
        if (keyword.endsWith('gb')) {

            const targetGb =
                parseFloat(
                    keyword.replace('gb','')
                );

            const hasilGb =
                sourceProducts
                    .filter(
                        p => p.quotaGb > 0
                    )
                    .sort(
                        (a,b)=>
                            Math.abs(a.quotaGb-targetGb)
                            -
                            Math.abs(b.quotaGb-targetGb)
                    )
                    .slice(0,10);

            if (hasilGb.length > 0) {
                session.tempList = hasilGb;
                session.tempPage = 0;
                return showProductList(sock, sender, session);
            }
        }

        // SMART SEARCH HARI
        if (keyword.endsWith('h')) {

            const targetHari =
                parseInt(
                    keyword.replace('h','')
                );

            const hasilHari =
                sourceProducts
                    .filter(
                        p => p.validityDays > 0
                    )
                    .sort(
                        (a,b)=>
                            Math.abs(a.validityDays-targetHari)
                            -
                            Math.abs(b.validityDays-targetHari)
                    )
                    .slice(0,10);

            if (hasilHari.length > 0) {
                session.tempList = hasilHari;
                session.tempPage = 0;
                return showProductList(sock, sender, session);
            }
        }

        // SMART SEARCH HARGA
        if (keyword.endsWith('k')) {

            const targetHarga =
                parseInt(
                    keyword.replace('k','')
                ) * 1000;

            const hasilHarga =
                [...sourceProducts]
                    .sort(
                        (a,b)=>
                            Math.abs(a.hargaJual-targetHarga)
                            -
                            Math.abs(b.hargaJual-targetHarga)
                    )
                    .slice(0,10);

            if (hasilHarga.length > 0) {
                session.tempList = hasilHarga;
                session.tempPage = 0;
                return showProductList(sock, sender, session);
            }
        }

let hasil = sourceProducts.filter(p => {

            const nama = p.nama.toLowerCase();
            const clean = (p.cleanName || '').toLowerCase();
            const group = (p.groupName || '').toLowerCase();

            return (
                nama.includes(keyword) ||
                clean.includes(keyword) ||
                group.includes(keyword)
            );

        });

        // MULTI KEYWORD
        if (hasil.length === 0) {

            const words = keyword.split(' ');

            hasil = sourceProducts.filter(p => {

                const gabung = (
                    p.nama + ' ' +
                    (p.cleanName || '') + ' ' +
                    (p.groupName || '')
                ).toLowerCase();

                return words.every(w =>
                    gabung.includes(w)
                );

            });

        }

        // SORT
        hasil.sort((a, b) => {

            const aExact =
                a.nama.toLowerCase().includes(keyword)
                ? 1 : 0;

            const bExact =
                b.nama.toLowerCase().includes(keyword)
                ? 1 : 0;

            if (aExact !== bExact)
                return bExact - aExact;

            return a.hargaJual - b.hargaJual;

        });

        if (hasil.length === 0) {

            return sock.sendMessage(sender, {
                text:
`⚠️ Paket "${txt}" tidak tersedia pada katalog ${session.tempOp || session.tempBrand} saat ini.

Contoh pencarian:
• 30gb  → cari kuota
• 30h   → cari masa aktif
• 25k   → cari harga

Atau ketik Z untuk melihat katalog lengkap.`
            });

        }

        session.tempList = hasil;
        session.tempPage = 0;

        return showProductList(
            sock,
            sender,
            session
        );

    }

}


// 5. TANGKAP INPUT (PULSA & EMONEY) & LOGIKA NEXT (Z)
    if (session.step === S.PILIH_PRODUK_PULSA || session.step === S.PILIH_PRODUK_EMONEY) {
        if (txt === 'Z') {

            if (
                session.tempSmartMode &&
                session.tempAllProducts
            ) {

                session.tempList =
                    session.tempAllProducts;

                session.tempPage = 0;

                session.tempSmartMode = false;

                return showProductList(
                    sock,
                    sender,
                    session
                );
            }

            session.tempPage += 1;

            return showProductList(
                sock,
                sender,
                session
            );
        }
        
        const idx = parseInt(txt) - 1;
        if (isNaN(idx) || !session.tempList[idx]) return sock.sendMessage(sender, { text: `❌ Pilihan salah. Ketik *Z* untuk ganti halaman.` });
        
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

