const db = require('../database/db');
const { formatRupiah } = require('../lib/utils');
const api = require('../lib/api');
const healthCheck = require('../system/health-check');

const maskSecret = (str = '') => (str.length > 8 ? str.slice(0, 4) + '••••' + str.slice(-4) : '••••');

async function handleAdmin(sock, sender, cmd, args, docMsg) {
    const config = require('../config');

    if (cmd === 'admin') {
        const statusToko = db.store.buka ? "🟢 BUKA" : "🔴 TUTUP (Offline)";
        let t = `👑 *COMMAND CENTER*\n🏪 Toko: *${db.store.namaToko || "STORE"}*\nStatus: ${statusToko}\n--------------------------\n`;
        t += `⚙️ *PENGATURAN BOT (IN-CHAT)*\n`;
        t += `• *.settings* (Lihat Semua Pengaturan Aktif)\n`;
        t += `• *.setdigi* User Key (Update API Digiflazz)\n`;
        t += `• *.setpayment* Merchant Secret (Update PaymentKita)\n`;
        t += `• *.settg* Token ChatID (Update Telegram Alert)\n`;
        t += `• *.setprofit* [pulsa/data/emoney/pln] Nominal\n`;
        t += `• *.settier* [kecil/sedang/besar/premium] Nominal\n`;
        t += `• *.addowner* NoHP | *.delowner* NoHP\n`;
        t += `• *.toko* [on/off] | *.namatoko* Nama Baru\n`;
        t += `• *.sync* (Sinkronisasi Seluruh Produk PPOB)\n\n`;
        t += `⚙️ *KONTROL DATA PRODUK*\n`;
        t += `• *.pullppob* [pulsa/data/emoney/pln/pasca]\n`;
        t += `• *.cekdigi* (Cek Saldo API Digiflazz)\n`;
        t += `• *.addmenu* Nama|Harga|Stok\n`;
        t += `• *.adddata* ID [QTY] Teks\n`;
        t += `• *.delmenu* ID | *.editmenu* ID Harga | *.stok* ID Qty\n\n`;
        t += `⚙️ *PENGGUNA & TRANSAKSI*\n`;
        t += `• *.addsaldo* NoHP Nominal\n`;
        t += `• *.member* | *.info* 628xxxx\n`;
        t += `• *.topsaldo* | *.toptrx*\n`;
        t += `• *.lunas* (Cek Antrian) | *.resend* INV-xxx\n`;
        t += `• *.health* | *.stats* | *.backup*`;
        return sock.sendMessage(sender, { text: t });
    }
    
    if (cmd === 'toko') {

    const mode = args.trim().toLowerCase();

    if (!['on','off'].includes(mode)) {
        return sock.sendMessage(sender,{
            text:'❌ Format:\n.toko on\n.toko off'
        });
    }

    db.store.buka = mode === 'on';

    if (db.saveStore) db.saveStore();
    else if (db.save) db.save();

    return sock.sendMessage(sender,{
        text:
            db.store.buka
            ? '✅ Toko dibuka'
            : '🔴 Toko ditutup'
    });
}

if (cmd === 'namatoko') {

    if (!args.trim()) {
        return sock.sendMessage(sender,{
            text:'❌ Format:\n.namatoko Nama Toko Baru'
        });
    }

    db.store.namaToko = args.trim();

    if (db.saveStore) db.saveStore();
    else if (db.save) db.save();

    return sock.sendMessage(sender,{
        text:'✅ Nama toko berhasil diubah menjadi:\n\n' + db.store.namaToko
    });
}


    
    

    if (cmd === 'backup') {

        const { exec } = require('child_process');

        sock.sendMessage(sender,{
            text:'⏳ Membuat backup dan mengirim ke Telegram...'
        });

        exec(
            'node lib/backup/backup-telegram.js',
            async (err) => {

                if (err) {
                    return sock.sendMessage(sender,{
                        text:'❌ Backup gagal'
                    });
                }

                return sock.sendMessage(sender,{
                    text:`✅ Backup berhasil dikirim ke Telegram

📦 Silakan cek bot Telegram backup.

💾 Session WhatsApp ikut terbackup.`
                });

            }
        );

        return;
    }

    if (cmd === 'pullppob') {
        const cat = args.trim().toLowerCase();
        if (!['pulsa', 'data', 'emoney', 'pln', 'pasca'].includes(cat)) return sock.sendMessage(sender, { text: "❌ Kategori salah. Pilih: pulsa / data / emoney / pln / pasca" });
        await sock.sendMessage(sender, { text: `⏳ Menarik data ${cat} dari Digiflazz...` });
        if (cat === 'pasca') {
            const count = await api.pullDigiPostpaid();
            if (count !== false) return sock.sendMessage(sender,{ text:`✅ Berhasil update ${count} produk PASCABAYAR.` });
            return sock.sendMessage(sender,{ text:'❌ Gagal menarik data pascabayar.' });
        }
        const count = await api.pullDigiProducts(cat);
        if (count !== false) return sock.sendMessage(sender, { text: `✅ Berhasil update ${count} produk ${cat.toUpperCase()} ke database.` });
        else return sock.sendMessage(sender, { text: "❌ Gagal menarik data. Cek API Key atau saldo." });
    }

    if (cmd === 'cekdigi') {
        const saldo = await api.cekSaldoDigi();
        return sock.sendMessage(sender, { text: `💳 *SALDO DIGIFLAZZ*\nSisa Saldo: *${saldo !== 'Error' ? formatRupiah(saldo) : 'Gagal cek'}*` });
    }

    if (cmd === 'addsaldo') {
        const [phoneRaw, nomStr] = args.split(' ');
        if (!phoneRaw || !nomStr) return sock.sendMessage(sender, { text: "❌ Format: .addsaldo 62812xxx 50000" });
        const nominal = parseInt(nomStr);
        if (isNaN(nominal) || nominal <= 0) return sock.sendMessage(sender, { text: "❌ Nominal harus berupa angka positif." });
        let phone = phoneRaw.replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.slice(1);
        
        const targetJid = `${phone}@s.whatsapp.net`;
        const user = db.getUser(targetJid);
        user.saldo = (Number(user.saldo) || 0) + nominal;
        if (!Array.isArray(user.history)) user.history = [];
        const dateStr = new Date().toLocaleDateString('id-ID');
        user.history.push(`[${dateStr}] 🟢 Topup Admin (+Rp ${nominal.toLocaleString('id-ID')})`);
        db.saveUsers();

        await sock.sendMessage(targetJid, { text: `✅ Saldo disesuaikan Admin: ${formatRupiah(nominal)}. Saldo Anda: ${formatRupiah(user.saldo)}` }).catch(()=>{});
        return sock.sendMessage(sender, { text: `✅ Saldo user ${phone} berhasil ditambah ${formatRupiah(nominal)}. Saldo baru: ${formatRupiah(user.saldo)}` });
    }

    // --- FITUR CRUD MANUAL (DIJAMIN AKTIF) ---
    if (cmd === 'addmenu') {
        const [nama, harga, stok] = args.split('|');
        if (!nama || !harga) return sock.sendMessage(sender, { text: "❌ Format: .addmenu Nama|Harga|Stok" });
        const id = db.menu.length ? db.menu[db.menu.length - 1].id + 1 : 1;
        db.menu.push({ id, nama, harga: parseInt(harga), stok: parseInt(stok || 0), dataAkun: [] });
        db.saveMenu(); 
        return sock.sendMessage(sender, { text: `✅ Produk Digital *${nama}* tersimpan (ID: ${id}).` });
    }
    
    if (cmd === 'adddata') {
        const parts = args.split(' ');
        const idStr = parseInt(parts[0]);
        let qty = parseInt(parts[1]);
        let dataTxt = (!isNaN(qty) && parts.length > 2) ? parts.slice(2).join(' ') : parts.slice(1).join(' ');
        if (isNaN(qty)) qty = 1;

        const item = db.menu.find(m => m.id === idStr);
        if (item) {
            if (!item.dataAkun) item.dataAkun = [];
            for(let i=0; i<qty; i++) item.dataAkun.push(dataTxt);
            item.stok = item.dataAkun.length; db.saveMenu();
            return sock.sendMessage(sender, { text: `✅ Berhasil memasukkan ${qty} data ke *${item.nama}*. Stok: ${item.stok}` });
        }
        return sock.sendMessage(sender, { text: "❌ ID Produk Digital tidak ditemukan." });
    }

    if (cmd === 'delmenu') {
        const id = parseInt(args);
        const index = db.menu.findIndex(m => m.id === id);
        if (index === -1) return sock.sendMessage(sender, { text: "❌ ID Produk tidak ditemukan." });
        const namaProduk = db.menu[index].nama;
        db.menu.splice(index, 1);
        db.saveMenu();
        return sock.sendMessage(sender, { text: `✅ Berhasil menghapus produk *${namaProduk}* (ID: ${id}).` });
    }

    if (cmd === 'editmenu') {
        const [idStr, hargaStr] = args.split(' ');
        if (!idStr || !hargaStr) return sock.sendMessage(sender, { text: "❌ Format salah. Contoh: .editmenu 4 15000" });
        const id = parseInt(idStr);
        const harga = parseInt(hargaStr);
        const item = db.menu.find(m => m.id === id);
        if (!item) return sock.sendMessage(sender, { text: "❌ ID Produk tidak ditemukan." });
        item.harga = harga;
        db.saveMenu();
        return sock.sendMessage(sender, { text: `✅ Harga *${item.nama}* berhasil diubah menjadi ${formatRupiah(harga)}.` });
    }

    if (cmd === 'stok') {
        const [idStr, stokStr] = args.split(' ');
        if (!idStr || !stokStr) return sock.sendMessage(sender, { text: "❌ Format salah. Contoh: .stok 4 50" });
        const id = parseInt(idStr);
        const stok = parseInt(stokStr);
        const item = db.menu.find(m => m.id === id);
        if (!item) return sock.sendMessage(sender, { text: "❌ ID Produk tidak ditemukan." });
        item.stok = stok;
        if (!item.dataAkun) item.dataAkun = [];
        db.saveMenu();
        return sock.sendMessage(sender, { text: `✅ Stok *${item.nama}* berhasil diubah menjadi ${stok}.` });
    }

    if (cmd === 'resend') {
        const orderId = args.trim();

        if (!orderId) {
            return sock.sendMessage(sender, {
                text: '❌ Format: .resend INV-XXXXXXXX'
            });
        }

        const order = db.orders.find(o => o.id === orderId);

        if (!order) {
            return sock.sendMessage(sender, {
                text: '❌ Order tidak ditemukan.'
            });
        }

        if (!order.sn) {
            return sock.sendMessage(sender, {
                text: '❌ SN / Token belum tersimpan pada order ini.'
            });
        }

        await sock.sendMessage(order.buyer, {
            text:
`✅ *KIRIM ULANG TRANSAKSI*

📦 Produk: ${order.item}
🎯 Target: ${order.target || '-'}

SN / Token:
${order.sn}`
        });

        return sock.sendMessage(sender, {
            text: '✅ SN berhasil dikirim ulang ke pembeli.'
        });
    }


    if (cmd === 'member') {
        let uniquePhones = new Set();
        let uniqueUsers = [];

        Object.entries(db.users).forEach(([jid, user]) => {
            let p = String(user.phone || jid.split('@')[0].split(':')[0]);
            if (p.startsWith('0')) p = '62' + p.slice(1);
            
            if (p && (p.startsWith('628') || p.startsWith('08'))) {
                if (!uniquePhones.has(p)) {
                    uniquePhones.add(p);
                    uniqueUsers.push(p);
                }
            }
        });

        let text = '👥 *DAFTAR MEMBER*\n\n';

        uniqueUsers.slice(0, 50).forEach((phone, i) => {
            text += (i+1) + '. ' + phone + '\n';
        });

        text += '\n📊 Total Member: ' + uniqueUsers.length;
        text += '\n\nGunakan:\n.info 628xxxx\n.topsaldo\n.toptrx\n\n';

        return sock.sendMessage(sender, {text});
    }
    

    
    if (cmd === 'info') {

        let phoneInput = args.replace(/[^0-9]/g,'');
        if (phoneInput.startsWith('0')) phoneInput = '62' + phoneInput.slice(1);

        if (!phoneInput) {
            return sock.sendMessage(sender,{
                text:'❌ Format: .info 62812xxxx'
            });
        }

        const target = Object.entries(db.users).find(([jid,user])=>{
            let p = user.phone || '';
            if (p.startsWith('0')) p = '62' + p.slice(1);
            return p === phoneInput && !jid.includes('@lid');
        }) || Object.entries(db.users).find(([jid,user])=>{
            let p = user.phone || '';
            if (p.startsWith('0')) p = '62' + p.slice(1);
            return p === phoneInput;
        });

        if (!target) {
            return sock.sendMessage(sender,{
                text:'❌ Member tidak ditemukan.'
            });
        }

        const [jid,user] = target;

        const orders = (db.orders || [])
            .filter(o => o.buyer === jid || o.sender === jid);

        const totalOrder = orders.length;

        const success = orders.filter(o => o.status === 'success').length;
        const failed = orders.filter(o => o.status !== 'success').length;

        let totalBelanja = 0;

        orders.forEach(o=>{

            if(o.status !== 'success') return;

            totalBelanja += Number(
                o.total ||
                o.baseAmount ||
                0
            );
        });

        const firstOrder = [...orders]
    .sort((a,b)=>(a.timestamp||0)-(b.timestamp||0))[0];

let memberSejak = '-';

if(firstOrder){
    memberSejak = new Date(
        firstOrder.timestamp
    ).toLocaleDateString('id-ID');
}

const lastOrder = orders
    .sort((a,b)=>(b.timestamp||0)-(a.timestamp||0))[0];

let lastProduct = '-';
let lastTarget = '-';
let lastDate = '-';

        if(lastOrder){
            lastProduct = lastOrder.item || '-';
            lastTarget = lastOrder.target || '-';

            const trxTime =
    lastOrder.doneAt ||
    lastOrder.timestamp;

lastDate = new Date(
    trxTime
).toLocaleString('id-ID');
        }

        return sock.sendMessage(sender,{
            text:
`👤 *DETAIL MEMBER*

📱 Nomor:
${user.phone || '-'}

🆔 JID:
${jid}

💰 Saldo:
${formatRupiah(user.saldo || 0)}

📦 Total Order:
${totalOrder}

✅ Success:
${success}

❌ Gagal:
${failed}

💵 Total Belanja:
${formatRupiah(totalBelanja)}

📅 Member Sejak:
${memberSejak}

🛒 Produk Terakhir:
${lastProduct}

🎯 Target Terakhir:
${lastTarget}

🕒 Transaksi Terakhir:
${lastDate}`
        });
    }

if (cmd === 'topsaldo') {

        const users = Object.entries(db.users)
        .filter(([jid,u]) => (u.saldo || 0) > 0)
        .sort((a,b)=>(b[1].saldo||0)-(a[1].saldo||0))
        .slice(0,10);

        let text = '🏆 *TOP SALDO*\n\n';

        users.forEach(([jid,u],i)=>{
            text += (i+1)+'. '+(u.phone||'-')+'\n';
            text += '💰 '+formatRupiah(u.saldo||0)+'\n\n';
        });

        return sock.sendMessage(sender,{text});
    }

    if (cmd === 'toptrx') {

        const map = {};

        (db.orders || []).forEach(o=>{

            if(o.status !== 'success') return;

            map[o.buyer] = (map[o.buyer]||0)+1;
        });

        const rows = Object.entries(map)
        .sort((a,b)=>b[1]-a[1])
        .slice(0,10);

        let text = '🔥 *MEMBER TERAKTIF*\n\n';

        rows.forEach(([jid,total],i)=>{

            const u = db.users[jid] || {};
            const phone = u.phone || jid;

            text += (i+1)+'. '+phone+'\n';
            text += '🛒 '+total+' transaksi\n\n';
        });

        return sock.sendMessage(sender,{text});
    }
    
    if (cmd === 'lunas') {

const orders = (db.orders || [])
    .filter(o => o.status === 'processing');

if (!orders.length) {

    return sock.sendMessage(sender,{
        text:'✅ Tidak ada antrian pengiriman.'
    });

}

let text = '📦 *ANTRIAN PENGIRIMAN*\n\n';

orders.forEach((o,i)=>{

    text += `${i+1}.\n`;
    text += `🧾 ${o.id}\n`;
    text += `📦 ${o.item}\n`;
    text += `👤 ${o.buyer}\n`;
    text += `💰 ${formatRupiah(o.baseAmount || 0)}\n`;
    text += `📌 ${String(o.status).toUpperCase()}\n`;

    if (o.timestamp) {

        text += `🕒 ${new Date(
            o.timestamp
        ).toLocaleString('id-ID')}\n`;

    }

    text += '\n';

});

text += `📊 Total Antrian: ${orders.length}`;

return sock.sendMessage(sender,{text});

}
    
    if (cmd === 'health') {

    const h = healthCheck();

    const ok =
        h.session &&
        h.database &&
        h.heartbeat &&
        h.backup;

    let text =
`🩺 *HEALTH CHECK*

WhatsApp : ${h.session ? '✅' : '❌'}
Database : ${h.database ? '✅' : '❌'}
Heartbeat : ${h.heartbeat ? '✅' : '❌'}
Backup : ${h.backup ? '✅' : '❌'}

📦 Processing : ${h.processing}
🏪 Store : ${h.store}

MODE :
${h.mode}

REKOMENDASI :
${h.mode === 'offline'
? 'Jalankan: node index.js'
: h.mode === 'session_lost'
? 'Lakukan pairing ulang WhatsApp'
: h.mode === 'reconnect'
? 'Tunggu reconnect otomatis'
: 'Tidak ada tindakan diperlukan'}

STATUS :
${ok ? '🟢 SIAP OPERASI' : '🔴 PERLU TINDAKAN'}`;

    return sock.sendMessage(sender,{text});
}
    

if (cmd === 'stats') {

        const users = Object.keys(db.users || {}).length;
        const orders = db.orders || [];

        const success = orders.filter(o => o.status === 'success').length;
        const cancel = orders.length - success;

        let omzet = 0;
        orders.forEach(o => {
            if (o.status === 'success') {
                omzet += Number(o.baseAmount || 0);
            }
        });

        let totalSaldo = 0;
        Object.values(db.users || {}).forEach(u => {
            totalSaldo += Number(u.saldo || 0);
        });

        const map = {};

        orders.forEach(o => {
            if (o.status !== 'success') return;
            map[o.buyer] = (map[o.buyer] || 0) + 1;
        });

        const top = Object.entries(map)
            .sort((a,b)=>b[1]-a[1])[0];

        let topMember = '-';

        if(top){
            const u = db.users[top[0]] || {};
            topMember = u.phone || top[0];
        }

        const rate = orders.length
            ? ((success/orders.length)*100).toFixed(2)
            : '0.00';

        return sock.sendMessage(sender,{
            text:
`📊 *STATISTIK TOKO*

👥 Member: ${users}

📦 Total Order: ${orders.length}
✅ Success: ${success}
❌ Cancel: ${cancel}

💵 Omzet:
${formatRupiah(omzet)}

💰 Total Saldo Member:
${formatRupiah(totalSaldo)}

🏆 Top Member:
${topMember}

📈 Success Rate:
${rate}%`
        });
    }

    // ==========================================
    // ⚙️ PENGATURAN BOT LENGKAP (IN-CHAT ADMIN)
    // ==========================================
    if (cmd === 'settings' || cmd === 'pengaturan') {
        const configData = require('../config');
        let t = `⚙️ *PENGATURAN BOT AKTIF*\n\n`;
        t += `🏪 *TOKO:*\n• Nama: *${db.store.namaToko || "DIGITAL STORE"}*\n• Status: *${db.store.buka ? "🟢 BUKA" : "🔴 TUTUP"}*\n\n`;
        t += `🔑 *DIGIFLAZZ API:*\n• User: \`${configData.digiflazz.username}\`\n• Key: \`${maskSecret(configData.digiflazz.key)}\`\n\n`;
        t += `💳 *PAYMENTKITA GATEWAY:*\n• Merchant ID: \`${configData.paymentkita.merchantId}\`\n• Secret: \`${maskSecret(configData.paymentkita.secret)}\`\n\n`;
        t += `🤖 *TELEGRAM COMMAND CENTER:*\n• Token: \`${maskSecret(configData.telegram.token)}\`\n• Chat ID: \`${configData.telegram.chatId}\`\n\n`;
        t += `💰 *KEUNTUNGAN KATEGORI (MARKUP):*\n`;
        t += `• Pulsa: ${formatRupiah(configData.profit.pulsa)}\n`;
        t += `• Data: ${formatRupiah(configData.profit.data)}\n`;
        t += `• E-Money: ${formatRupiah(configData.profit.emoney)}\n`;
        t += `• PLN: ${formatRupiah(configData.profit.pln)}\n\n`;
        t += `📊 *KEUNTUNGAN TIER NOMINAL:*\n`;
        t += `• Kecil (≤ 25rb): ${formatRupiah(configData.profitTier.kecil)}\n`;
        t += `• Sedang (≤ 100rb): ${formatRupiah(configData.profitTier.sedang)}\n`;
        t += `• Besar (≤ 300rb): ${formatRupiah(configData.profitTier.besar)}\n`;
        t += `• Premium (> 300rb): ${formatRupiah(configData.profitTier.premium)}\n\n`;
        t += `👑 *DAFTAR OWNER/ADMIN:*\n`;
        configData.owner.forEach((o, i) => t += `${i+1}. ${o}\n`);
        t += `\n_💡 Ketik .admin untuk melihat daftar perintah pengubahan._`;
        return sock.sendMessage(sender, { text: t });
    }

    if (cmd === 'setdigi') {
        const [user, key] = args.trim().split(/\s+/);
        if (!user || !key) return sock.sendMessage(sender, { text: "❌ Format: .setdigi [username] [api_key]\nContoh: .setdigi myuser 32d4-xxxx" });
        if (!db.settings) db.settings = {};
        db.settings.digiflazz = { username: user, key: key };
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Berhasil memperbarui kredensial Digiflazz!\nUsername: ${user}\nKey: ${maskSecret(key)}` });
    }

    if (cmd === 'setpayment') {
        const [mId, secret] = args.trim().split(/\s+/);
        if (!mId || !secret) return sock.sendMessage(sender, { text: "❌ Format: .setpayment [merchant_id] [secret_key]\nContoh: .setpayment PKM12345 PKSK_xxxx" });
        if (!db.settings) db.settings = {};
        db.settings.paymentkita = { merchantId: mId, secret: secret };
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Berhasil memperbarui kredensial PaymentKita!\nMerchant ID: ${mId}\nSecret: ${maskSecret(secret)}` });
    }

    if (cmd === 'settg') {
        const [token, chatId] = args.trim().split(/\s+/);
        if (!token || !chatId) return sock.sendMessage(sender, { text: "❌ Format: .settg [bot_token] [chat_id]\nContoh: .settg 847009:AAEA... 7236113204" });
        if (!db.settings) db.settings = {};
        db.settings.telegram = { token, chatId };
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Berhasil memperbarui konfigurasi Telegram!\nToken: ${maskSecret(token)}\nChat ID: ${chatId}` });
    }

    if (cmd === 'setprofit') {
        const [katRaw, nomStr] = args.trim().split(/\s+/);
        const kat = (katRaw || '').toLowerCase();
        const nom = parseInt(nomStr);
        if (!['pulsa', 'data', 'emoney', 'pln'].includes(kat) || isNaN(nom) || nom < 0) {
            return sock.sendMessage(sender, { text: "❌ Format: .setprofit [pulsa|data|emoney|pln] [nominal]\nContoh: .setprofit pulsa 750" });
        }
        if (!db.settings) db.settings = {};
        const configData = require('../config');
        if (!db.settings.profit) db.settings.profit = { ...configData.profit };
        db.settings.profit[kat] = nom;
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Keuntungan kategori *${kat.toUpperCase()}* disetel menjadi *${formatRupiah(nom)}*.` });
    }

    if (cmd === 'settier') {
        const [tierRaw, nomStr] = args.trim().split(/\s+/);
        const tier = (tierRaw || '').toLowerCase();
        const nom = parseInt(nomStr);
        if (!['kecil', 'sedang', 'besar', 'premium'].includes(tier) || isNaN(nom) || nom < 0) {
            return sock.sendMessage(sender, { text: "❌ Format: .settier [kecil|sedang|besar|premium] [nominal]\nContoh: .settier kecil 1200" });
        }
        if (!db.settings) db.settings = {};
        const configData = require('../config');
        if (!db.settings.profitTier) db.settings.profitTier = { ...configData.profitTier };
        db.settings.profitTier[tier] = nom;
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Margin tier *${tier.toUpperCase()}* disetel menjadi *${formatRupiah(nom)}*.` });
    }

    if (cmd === 'addowner') {
        let cleanNo = args.trim().replace(/[^0-9]/g, '');
        if (cleanNo.startsWith('0')) cleanNo = '62' + cleanNo.slice(1);
        if (!cleanNo || cleanNo.length < 9) return sock.sendMessage(sender, { text: "❌ Format: .addowner 628123456789" });
        const newJid = cleanNo.includes('@') ? cleanNo : cleanNo + '@s.whatsapp.net';
        const configData = require('../config');
        let owners = Array.isArray(db.settings.owner) ? [...db.settings.owner] : [...configData.owner];
        if (!owners.includes(newJid)) owners.push(newJid);
        if (!db.settings) db.settings = {};
        db.settings.owner = owners;
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Nomor *${cleanNo}* berhasil ditambahkan sebagai Admin/Owner.` });
    }

    if (cmd === 'delowner') {
        let cleanNo = args.trim().replace(/[^0-9]/g, '');
        if (cleanNo.startsWith('0')) cleanNo = '62' + cleanNo.slice(1);
        if (!cleanNo) return sock.sendMessage(sender, { text: "❌ Format: .delowner 628123456789" });
        const configData = require('../config');
        let owners = Array.isArray(db.settings.owner) ? [...db.settings.owner] : [...configData.owner];
        const filtered = owners.filter(o => !o.includes(cleanNo));
        if (filtered.length === 0) return sock.sendMessage(sender, { text: "❌ Tidak bisa menghapus semua owner. Sisakan minimal 1 owner." });
        if (!db.settings) db.settings = {};
        db.settings.owner = filtered;
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Nomor *${cleanNo}* telah dihapus dari daftar Admin.` });
    }

    if (cmd === 'listowner') {
        const configData = require('../config');
        let text = "👑 *DAFTAR OWNER/ADMIN AKTIF*\n\n";
        configData.owner.forEach((o, i) => {
            text += `${i+1}. ${o}\n`;
        });
        return sock.sendMessage(sender, { text });
    }

    if (cmd === 'sync') {
        await sock.sendMessage(sender, { text: "⏳ *SINKRONISASI KATALOG DIGIFLAZZ...*\nMenarik data pulsa, data, emoney, pln, dan pascabayar secara otomatis..." });
        const cats = ['pulsa', 'data', 'emoney', 'pln'];
        let report = "📊 *HASIL SINKRONISASI PPOB:*\n\n";
        for (const c of cats) {
            const res = await api.pullDigiProducts(c);
            report += `• ${c.toUpperCase()}: ${res !== false ? res + ' produk' : '❌ Gagal'}\n`;
        }
        const pascaRes = await api.pullDigiPostpaid();
        report += `• PASCABAYAR: ${pascaRes !== false ? pascaRes + ' produk' : '❌ Gagal'}\n`;
        report += `\n✅ Sinkronisasi katalog selesai dan telah tersimpan ke database.`;
        return sock.sendMessage(sender, { text: report });
    }
}








module.exports = { handleAdmin };