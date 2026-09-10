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
    INPUT_DEPOSIT: 10
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
        if (!targetNo || isNaN(nom) || nom < 1000) {
            return sock.sendMessage(sender, {
                text: `💸 *FORMAT TRANSFER SALDO:*\n.transfer [Nomor_Tujuan] [Nominal]\n\nContoh:\n.transfer 08123456789 10000\n\n📌 _Minimal transfer Rp1.000 (Tanpa Biaya Admin)_`
            });
        }
        if (targetNo.startsWith('0')) targetNo = '62' + targetNo.slice(1);
        const senderUser = db.getUser ? db.getUser(sender) : (db.users[sender] || (db.users[sender] = { saldo: 0 }));
        if ((senderUser.saldo || 0) < nom) {
            return sock.sendMessage(sender, {
                text: `❌ Saldo Anda tidak mencukupi.\nSaldo Anda: ${formatRupiah(senderUser.saldo || 0)}\nNominal transfer: ${formatRupiah(nom)}`
            });
        }
        const targetJid = targetNo.includes('@') ? targetNo : targetNo + '@s.whatsapp.net';
        const targetUser = db.getUser ? db.getUser(targetJid) : (db.users[targetJid] || (db.users[targetJid] = { saldo: 0, phone: targetNo }));

        senderUser.saldo -= nom;
        targetUser.saldo = (targetUser.saldo || 0) + nom;
        db.saveUsers();

        await sock.sendMessage(sender, {
            text: `✅ *TRANSFER SALDO BERHASIL*\n\n🎯 Tujuan: ${targetNo}\n💰 Nominal: ${formatRupiah(nom)}\n💵 Sisa Saldo: ${formatRupiah(senderUser.saldo)}`
        });

        await sock.sendMessage(targetJid, {
            text: `🎁 *SALDO MASUK*\n\nAnda menerima transfer saldo sebesar *${formatRupiah(nom)}* dari ${senderUser.phone || sender.split('@')[0]}.\n💰 Saldo Baru: ${formatRupiah(targetUser.saldo)}`
        }).catch(()=>{});
        return;
    }

    // 1. MAIN MENU
    if (['MENU', 'HALO', 'P', 'YY', 'MM', 'JJ', 'KK', 'PP', '#'].includes(txt)) {
        session.step = S.PILIH_KATEGORI;
        let t = `╭── 🛍️ *${db.store.namaToko || 'STORE'}* ──\n│\n`;
        t += `├ *1.* 🌐 Pulsa Reguler\n`;
        t += `├ *2.* 📶 Paket Data\n`;
        t += `├ *3.* 💸 Topup E-Money\n`;
        t += `├ *4.* 📂 Produk Digital (Akun/App)\n├ *5.* ⚡ Token PLN\n│\n`;
        t += `│\n╰───────────────────────────\n\n`;
        t += `👇 Balas *Angka* pilihan Anda, atau gunakan shortcut:\n`;
        t += `• *.beli* [SKU] [NoHP] (Beli Cepat)\n`;
        t += `• *.harga* [Operator] (Cek Harga)\n`;
        t += `• *DEPOSIT* | *PROFIL* | *RIWAYAT* | *HELP*`;
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

    if (amount > 300000) {

        return sock.sendMessage(sender, {
            text: '❌ Maksimal deposit Rp300.000'
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
        buyer: sender,
        amount: amount,
        status: 'pending',
        createdAt: Date.now()
    });

    if (db.saveDeposits) db.saveDeposits();
    else db.saveUsers();

    session.step = S.IDLE;

    const qrUrl =
`https://quickchart.io/qr?size=500&margin=2&text=${encodeURIComponent(qris.data.qr_string)}`;

    await sock.sendMessage(sender, {
        image: {
            url: qrUrl
        },
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

    if (txt === 'B') {
        session.step = S.IDLE;
        return sock.sendMessage(sender, { text: "🚫 Aksi dibatalkan. Ketik *MENU* untuk kembali." });
    }

    // 2. PILIH KATEGORI (1,2,3,4)
    if (session.step === S.PILIH_KATEGORI) {
        if (txt === '1' || txt === '2') {
            session.tempTipe = txt === '1' ? 'Pulsa' : 'Data';
            session.step = S.INPUT_TARGET_PULSA;
            if (session.tempTipe === 'Data') {
return sock.sendMessage(sender,{text:`📱 *PAKET DATA*

Masukkan Nomor HP Tujuan.

Contoh:
08123456789

🔎 Opsional:

• 08123456789.30gb
• 08123456789.10k
• 08123456789.30h
• 08123456789.edukasi

💡 Tanpa tambahan kata kunci:
Bot akan menampilkan rekomendasi paket terlebih dahulu.`});
}

return sock.sendMessage(sender,{text:`📱 *${session.tempTipe}*\n\nSilakan masukkan *Nomor HP* Tujuan Anda:\n_Contoh: 08123456789_`});
        } else if (txt === '3') {
            session.tempTipe = 'E-Money';
            session.step = S.PILIH_BRAND_EMONEY;
            const brands = [...new Set(db.ppob.filter(p => p.kategori === 'E-Money').map(p => p.brand))];
            if (brands.length === 0) return sock.sendMessage(sender, { text: `❌ Sistem belum menarik data E-Money.` });
            
            session.tempBrands = brands;
            let t = `💸 *PILIH PROVIDER E-MONEY*\n\n`;
            brands.forEach((b, i) => t += `*${i+1}.* ${b}\n`);
            t += `\nKetik angka pilihan Anda.`;
            return sock.sendMessage(sender, { text: t });
        } else if (txt === '5') {
            session.tempTipe = 'PLN';
            session.step = S.INPUT_TARGET_PULSA;

            return sock.sendMessage(sender, {
                text: `⚡ *TOKEN PLN*

Silakan masukkan *Nomor Meteran / ID Pelanggan PLN*

Contoh:
123456789012`
            });

        } else if (txt === '4') {
            session.step = S.PILIH_PRODUK_DIGITAL;
            let t = `📂 *PRODUK DIGITAL*\n\n`;
            if (db.menu.length === 0) return sock.sendMessage(sender, { text: `❌ Belum ada produk digital.` });
            db.menu.forEach(m => t += `*${m.id}.* ${m.nama}\n🏷️ ${formatRupiah(m.harga)} | 📦 Stok: ${m.stok}\n\n`);
            t += `Ketik angka *ID Produk* pilihan Anda.`;
            return sock.sendMessage(sender, { text: t });
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
    if (session.step === S.CONFIRM && txt === 'Y') {
        session.step = S.IDLE;
        await processCheckout(sock, sender, session); 
    }
}

async function showInvoice(sock, sender, session) {
    const isPpob = !!session.tempItem.sku;
    const qty = isPpob ? 1 : session.tempQty;
    const total = (isPpob ? session.tempItem.hargaJual : session.tempItem.harga) * qty;
    // 🧬 RADAR DOMPET UTAMA KASIR
    let realJid = sender;
    if (sender.includes('@lid')) {
        let pPhone = (db.users[sender] && db.users[sender].phone) ? String(db.users[sender].phone).replace(/[^0-9]/g, '') : sender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        if (pPhone.startsWith('0')) pPhone = '62' + pPhone.slice(1);
        let findMain = Object.entries(db.users).find(([j, u]) => !j.includes('@lid') && (u.phone === pPhone || j.startsWith(pPhone)));
        if (findMain) realJid = findMain[0];
    }
    const saldo = (db.users[realJid] && db.users[realJid].saldo) ? db.users[realJid].saldo : 0;
    
    let t = `🧾 *KONFIRMASI PESANAN*\n\n📦 ${session.tempItem.cleanName || session.tempItem.nama}\n`;
    if (isPpob) t += `🎯 Tujuan: *${session.tempTarget}*\n`;
    else t += `📊 Jumlah: ${qty}\n`;
    
    t += `💵 Total: *${formatRupiah(total)}*\n💰 Saldo Anda: ${formatRupiah(saldo)}\n\n`;
    t += saldo >= total ? `_Saldo mencukupi (Potong Otomatis)._\n\n` : `_Pembayaran via QRIS Otomatis._\n\n`;
    t += `Ketik *Y* untuk Bayar.\nKetik *B* untuk Batal.`;
    
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
    INPUT_DEPOSIT: 10
};


module.exports = {
    handleUser,
    S
};

