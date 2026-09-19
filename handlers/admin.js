const db = require('../database/db');
const { formatRupiah } = require('../lib/utils');
const api = require('../lib/api');
const marginHelper = require('../lib/margin');
const analytics = require('../lib/analytics');
const healthCheck = require('../system/health-check');

const maskSecret = (str = '') => (str.length > 8 ? str.slice(0, 4) + '••••' + str.slice(-4) : '••••');

async function handleAdmin(sock, sender, cmd, args, docMsg) {
    const config = require('../config');

    if (cmd === 'admin') {
        const statusToko = db.store.buka ? "🟢 BUKA" : "🔴 TUTUP (Offline)";
        let t = `👑 *COMMAND CENTER*\n🏪 Toko: *${db.store.namaToko || "STORE"}*\nStatus: ${statusToko}\n--------------------------\n`;
        t += `⚙️ *PENGATURAN BOT (IN-CHAT)*\n`;
        t += `• *.settings* (Lihat Semua Pengaturan Aktif)\n`;
        t += `• *.setgateway* [paymentkita/pakasir] (Ganti Payment Gateway)\n`;
        t += `• *.setpayment* Merchant Secret (Update PaymentKita)\n`;
        t += `• *.setpakasir* Project Key (Update Pakasir)\n`;
        t += `• *.setdigi* User Key (Update API Digiflazz)\n`;
        t += `• *.settg* Token ChatID (Update Telegram Alert)\n`;
        t += `• *.settier* [kecil/sedang/besar/premium] Nominal (Margin Prabayar)\n`;
        t += `• *.settier* range BatasKecil BatasSedang BatasBesar\n`;
        t += `• *.setpasca* [nominal] (Biaya Admin Loket Pascabayar)\n`;
        t += `• *.margin* / *.tier* (Ringkasan Skema Margin Auto-Tier)\n`;
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
        t += `• *.setnama* NoHP NamaBaru\n`;
        t += `• *.member* | *.info* 628xxxx\n`;
        t += `• *.topsaldo* | *.toptrx*\n`;
        t += `• *.lunas* (Cek Antrian) | *.resend* INV-xxx\n`;
        t += `• *.health* | *.backup*\n\n`;
        t += `📊 *LAPORAN & LABA BERSIH*\n`;
        t += `• *.stats* / *.omzet* (Ringkasan Laba 1 Hari, 7 Hari, 30 Hari, All-Time)\n`;
        t += `• *.laba* [tanggal] (Cek Laba Hari Tertentu, cth: .laba 19-09-2026 / .laba kemarin)\n`;
        t += `• *.topproduk* (Ranking 10 Produk Paling Laris Dibeli)\n`;
        t += `• *.produkgagal* (Laporan Produk Sering Gagal Digiflazz)\n`;
        t += `• *.toptrx* (Peringkat Member Transaksi Terbanyak)\n`;
        t += `• *.snk* / *.tos* (Syarat & Ketentuan Layanan / Disclaimer Hukum)`;
        return sock.sendMessage(sender, { text: t });
    }
    
    if (cmd === 'toko') {
        const mode = args.trim().toLowerCase();
        const isOpen = ['on', 'buka', 'open'].includes(mode);
        const isClose = ['off', 'tutup', 'close'].includes(mode);

        if (!isOpen && !isClose) {
            return sock.sendMessage(sender, {
                text: '❌ Format salah.\nContoh:\n• .toko on / .toko buka\n• .toko off / .toko tutup'
            });
        }

        db.store.buka = isOpen;

        if (db.saveStore) db.saveStore();
        else if (db.save) db.save();

        return sock.sendMessage(sender, {
            text: db.store.buka
                ? '✅ *TOKO BERHASIL DIBUKA* (Status: Online)'
                : '🔴 *TOKO BERHASIL DITUTUP* (Status: Offline)'
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
        if (isNaN(nominal) || nominal <= 0 || nominal > 50000000) {
            return sock.sendMessage(sender, { text: "❌ Nominal harus berupa angka valid antara Rp1 - Rp50.000.000." });
        }
        let phone = phoneRaw.replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.slice(1);
        if (phone.length < 10 || !phone.startsWith('62')) {
            return sock.sendMessage(sender, { text: "❌ Nomor tujuan tidak valid. Format: 62812xxx (Min 10 digit)." });
        }
        
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

    if (cmd === 'tariksaldo') {
        const [phoneRaw, nomStr] = args.split(' ');
        if (!phoneRaw || !nomStr) return sock.sendMessage(sender, { text: "❌ Format: .tariksaldo 62812xxx 50000" });
        const nominal = parseInt(nomStr);
        if (isNaN(nominal) || nominal <= 0) {
            return sock.sendMessage(sender, { text: "❌ Nominal harus berupa angka valid lebih dari 0." });
        }
        let phone = phoneRaw.replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.slice(1);
        if (phone.length < 10 || !phone.startsWith('62')) {
            return sock.sendMessage(sender, { text: "❌ Nomor tujuan tidak valid. Format: 62812xxx (Min 10 digit)." });
        }

        const targetJid = `${phone}@s.whatsapp.net`;
        const user = db.getUser(targetJid);
        if ((Number(user.saldo) || 0) < nominal) {
            return sock.sendMessage(sender, { text: `❌ Saldo member tidak mencukupi untuk ditarik. Saldo saat ini: ${formatRupiah(user.saldo || 0)}` });
        }
        user.saldo = (Number(user.saldo) || 0) - nominal;
        if (!Array.isArray(user.history)) user.history = [];
        const dateStr = new Date().toLocaleDateString('id-ID');
        user.history.push(`[${dateStr}] 🔴 Penarikan/Koreksi Admin (-Rp ${nominal.toLocaleString('id-ID')})`);
        db.saveUsers();

        await sock.sendMessage(targetJid, { text: `⚠️ Saldo Anda dikoreksi/ditarik Admin sebesar ${formatRupiah(nominal)}. Sisa saldo: ${formatRupiah(user.saldo)}` }).catch(()=>{});
        return sock.sendMessage(sender, { text: `✅ Saldo user ${phone} berhasil ditarik ${formatRupiah(nominal)}. Sisa saldo: ${formatRupiah(user.saldo)}` });
    }

    if (cmd === 'setnama' || cmd === 'editnama') {
        const parts = args.trim().split(/\s+/);
        if (parts.length < 2) {
            return sock.sendMessage(sender, { text: "❌ Format: .setnama [NomorHP] [Nama Baru]\nContoh: .setnama 081775700114 Ansor studio" });
        }
        const phoneRaw = parts[0];
        const newName = parts.slice(1).join(' ').trim();
        let phone = phoneRaw.replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) phone = '62' + phone.slice(1);
        if (phone.length < 10) {
            return sock.sendMessage(sender, { text: "❌ Nomor tujuan tidak valid. Format: 08xxx atau 628xxx." });
        }
        const targetJid = `${phone}@s.whatsapp.net`;
        const user = db.getUser(targetJid);
        const oldName = user.name || '-';
        if (db.setUserName) {
            db.setUserName(phone, newName);
        } else {
            user.name = newName;
            user.customName = true;
            db.saveUsers();
        }

        const displayPhone = phone.startsWith('62') ? '0' + phone.slice(2) : phone;
        return sock.sendMessage(sender, { 
            text: `✅ *NAMA MEMBER BERHASIL DIUBAH!*\n\n📱 Nomor HP: *${displayPhone}* (+${phone})\n👤 Nama Lama: ${oldName}\n👤 Nama Baru: *${newName}*` 
        });
    }

    // --- FITUR CRUD MANUAL (DIJAMIN AKTIF) ---
    if (cmd === 'addmenu') {
        let nama, harga, stok;
        if (args.includes('|')) {
            [nama, harga, stok] = args.split('|').map(s => s ? s.trim() : '');
        } else {
            const parts = args.trim().split(/\s+/);
            if (parts.length >= 2) {
                const lastPart = parts[parts.length - 1];
                const secondLast = parts[parts.length - 2];
                if (!isNaN(parseInt(lastPart)) && !isNaN(parseInt(secondLast)) && parts.length >= 3) {
                    stok = lastPart;
                    harga = secondLast;
                    nama = parts.slice(0, -2).join(' ');
                } else if (!isNaN(parseInt(lastPart))) {
                    harga = lastPart;
                    stok = 0;
                    nama = parts.slice(0, -1).join(' ');
                }
            }
        }
        if (!nama || !harga || isNaN(parseInt(harga))) {
            return sock.sendMessage(sender, { text: "❌ Format salah.\nContoh:\n• .addmenu Netflix Premium 1 Bulan|35000|10\n• .addmenu Canva Pro 1 Bulan 15000 20" });
        }
        const id = db.menu.length ? db.menu[db.menu.length - 1].id + 1 : 1;
        db.menu.push({ id, nama, harga: parseInt(harga), stok: parseInt(stok || 0), dataAkun: [] });
        db.saveMenu(); 
        return sock.sendMessage(sender, { text: `✅ Produk Digital *${nama}* tersimpan (ID: ${id}) dengan harga ${formatRupiah(parseInt(harga))} dan stok ${parseInt(stok || 0)}.` });
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
            return sock.sendMessage(sender, { text: `✅ Berhasil memasukkan ${qty} data ke *${item.nama}*. Stok sekarang: ${item.stok}` });
        }
        return sock.sendMessage(sender, { text: "❌ ID Produk Digital tidak ditemukan." });
    }

    if (cmd === 'cekdata') {
        const idStr = parseInt(args.trim());
        if (isNaN(idStr)) return sock.sendMessage(sender, { text: "❌ Format: .cekdata [ID_Produk]" });
        const item = (db.menu || []).find(m => m.id === idStr);
        if (!item) return sock.sendMessage(sender, { text: "❌ ID Produk tidak ditemukan." });
        if (!item.dataAkun || item.dataAkun.length === 0) {
            return sock.sendMessage(sender, { text: `📦 Produk *${item.nama}* belum memiliki data akun tersimpan.` });
        }
        let t = `📂 *DATA AKUN: ${item.nama}* (Total: ${item.dataAkun.length})\n\n`;
        item.dataAkun.forEach((d, i) => {
            t += `${i + 1}. \`${d}\`\n`;
        });
        return sock.sendMessage(sender, { text: t });
    }

    if (cmd === 'listmenu') {
        if (!db.menu || db.menu.length === 0) {
            return sock.sendMessage(sender, { text: "📦 Belum ada produk digital lokal terdaftar.\nKetik .addmenu untuk menambahkan." });
        }
        let t = "📂 *DAFTAR PRODUK DIGITAL LOKAL*\n\n";
        db.menu.forEach((m) => {
            t += `• *ID ${m.id}*: ${m.nama}\n`;
            t += `  Harga: ${formatRupiah(m.harga)} | Stok: ${m.stok || 0} akun\n\n`;
        });
        t += `_Gunakan .adddata [ID] [Qty] [Teks] untuk isi stok._\n_Gunakan .cekdata [ID] untuk cek akun mentah._`;
        return sock.sendMessage(sender, { text: t });
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

    if (cmd === 'editmenu' || cmd === 'setharga') {
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

    if (cmd === 'stok' || cmd === 'setstok') {
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

    if (cmd === 'refund' || cmd === 'batal') {
        const orderId = args.trim().toUpperCase();
        if (!orderId) return sock.sendMessage(sender, { text: "❌ Format: .refund [ID_INVOICE]\nContoh: .refund INV-1726000000" });
        const order = (db.orders || []).find(o => o.id && o.id.toUpperCase() === orderId);
        if (!order) return sock.sendMessage(sender, { text: `❌ Order ${orderId} tidak ditemukan.` });
        if (order.status === 'success') {
            return sock.sendMessage(sender, { text: `⚠️ Order ${orderId} sudah berstatus SUKSES dan tidak dapat dibatalkan.` });
        }
        if (order.refunded) {
            return sock.sendMessage(sender, { text: `⚠️ Order ${orderId} sudah pernah di-refund sebelumnya.` });
        }
        const refundRes = db.refundOrder(order, 'Dibatalkan Manual oleh Admin');
        if (refundRes.success) {
            await sock.sendMessage(sender, {
                text: `✅ *ORDER DIBATALKAN & DIREFUND*\n\n🧾 Invoice: \`${order.id}\`\n📦 Produk: ${order.item || order.sku}\n💸 Refund: ${formatRupiah(refundRes.amount)}\n👤 Penerima: ${refundRes.buyerJid}\n💰 Saldo Baru Member: ${formatRupiah(refundRes.newSaldo)}`
            });
            await sock.sendMessage(refundRes.buyerJid, {
                text: `❌ *ORDER DIBATALKAN ADMIN*\n\nMohon maaf, pesanan Anda telah dibatalkan oleh Admin.\n\n📦 Produk: ${order.item || order.sku}\n🧾 Invoice: \`${order.id}\`\n💰 Saldo Rp ${refundRes.amount.toLocaleString('id-ID')} telah dikembalikan ke dompet Anda.`
            }).catch(() => {});
        } else {
            return sock.sendMessage(sender, { text: `❌ Gagal refund: ${refundRes.reason}` });
        }
        return;
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

        let displayPhone = user.phone || jid.split('@')[0];
        if (displayPhone.startsWith('62')) displayPhone = '0' + displayPhone.slice(2);
        const namePart = user.name ? `\n👤 Nama:\n${user.name}\n` : '';

        return sock.sendMessage(sender,{
            text:
`👤 *DETAIL MEMBER*
${namePart}
📱 Nomor HP:
${displayPhone}

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
        const days = parseInt(args, 10) || 0;
        const data = analytics.getTopMembers(10, days);
        let text = `👥 *PERINGKAT MEMBER TRANSAKSI TERBANYAK*\n`;
        text += `Periode: *${data.periodLabel}*\n\n`;

        if (data.ranking.length === 0) {
            text += `_Belum ada transaksi sukses tercatat._`;
        } else {
            data.ranking.forEach((m, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                const nameStr = m.name ? ` (${m.name})` : '';
                text += `${medal} *${m.phone}*${nameStr}\n`;
                text += `   • Frekuensi : *${m.trxCount} transaksi*\n`;
                text += `   • Belanja   : *${formatRupiah(m.totalBelanja)}*\n`;
                text += `   • 💰 Laba   : *${formatRupiah(m.totalProfit)}*\n\n`;
            });
        }
        return sock.sendMessage(sender, { text });
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
    

    if (cmd === 'stats' || cmd === 'omzet') {
        const sToday = analytics.getStatsSummary('today');
        const s7d = analytics.getStatsSummary('7d');
        const s30d = analytics.getStatsSummary('30d');
        const sAll = analytics.getStatsSummary('all');
        const users = Object.keys(db.users || {}).length;

        let totalSaldo = 0;
        Object.values(db.users || {}).forEach(u => {
            totalSaldo += Number(u.saldo || 0);
        });

        let text = `📊 *LAPORAN PENJUALAN & LABA BERSIH*\n\n`;

        text += `📅 *HARI INI (${sToday.rangeLabel}):*\n`;
        text += `• Transaksi Sukses : *${sToday.successCount} trx* (Gagal: ${sToday.failedCount})\n`;
        text += `• Omzet Penjualan  : *${formatRupiah(sToday.omzet)}*\n`;
        text += `• 💰 *Laba Bersih*  : *${formatRupiah(sToday.labaBersih)}* _(${sToday.marginPercent}% margin)_\n\n`;

        text += `🗓️ *7 HARI TERAKHIR:*\n`;
        text += `• Transaksi Sukses : *${s7d.successCount} trx*\n`;
        text += `• Omzet Penjualan  : *${formatRupiah(s7d.omzet)}*\n`;
        text += `• 💰 *Laba Bersih*  : *${formatRupiah(s7d.labaBersih)}*\n\n`;

        text += `📆 *30 HARI TERAKHIR (BULAN INI):*\n`;
        text += `• Transaksi Sukses : *${s30d.successCount} trx*\n`;
        text += `• Omzet Penjualan  : *${formatRupiah(s30d.omzet)}*\n`;
        text += `• 💰 *Laba Bersih*  : *${formatRupiah(s30d.labaBersih)}*\n\n`;

        text += `🏆 *KESELURUHAN (ALL-TIME):*\n`;
        text += `• Total Transaksi  : *${sAll.totalOrders} trx*\n`;
        text += `• Sukses / Gagal   : *${sAll.successCount}* / *${sAll.failedCount}* (${sAll.successRate}% rate)\n`;
        text += `• Total Omzet      : *${formatRupiah(sAll.omzet)}*\n`;
        text += `• 💰 *Total Laba*   : *${formatRupiah(sAll.labaBersih)}*\n`;
        text += `• Total Pengguna   : *${users} member* (Saldo: ${formatRupiah(totalSaldo)})\n\n`;

        text += `💡 *Perintah Laporan Lanjutan:*\n`;
        text += `• *.laba 19-09-2026* (Cek laba & produk hari tertentu)\n`;
        text += `• *.topproduk* (10 Produk paling banyak dibeli)\n`;
        text += `• *.produkgagal* (Laporan produk sering gagal Digiflazz)\n`;
        text += `• *.toptrx* (Peringkat member transaksi terbanyak)`;

        return sock.sendMessage(sender, { text });
    }

    if (cmd === 'laba') {
        const queryDate = args.trim() || 'today';
        const dayData = analytics.getDayStats(queryDate);

        if (!dayData.success) {
            return sock.sendMessage(sender, {
                text: `❌ *Format Tanggal Salah!*\n\n${dayData.message}\nContoh yang didukung:\n• *.laba 19-09-2026*\n• *.laba 2026-09-19*\n• *.laba kemarin*`
            });
        }

        let text = `📅 *LAPORAN KEUANGAN TANGGAL: ${dayData.dateFormatted.toUpperCase()}*\n\n`;
        text += `• Total Transaksi   : *${dayData.totalOrders} trx*\n`;
        text += `• Transaksi Sukses  : *${dayData.successCount} trx*\n`;
        text += `• Transaksi Gagal   : *${dayData.failedCount} trx*\n`;
        text += `• Transaksi Pending : *${dayData.pendingCount} trx*\n\n`;
        text += `💵 *Omzet Penjualan* : *${formatRupiah(dayData.omzet)}*\n`;
        text += `💰 *Laba Bersih Toko*: *${formatRupiah(dayData.labaBersih)}* _(${dayData.marginPercent}% margin)_\n\n`;

        text += `📦 *Rincian Produk Terjual:*\n`;
        if (dayData.itemsSold.length === 0) {
            text += `_Tidak ada produk yang berhasil terjual pada tanggal ini._\n`;
        } else {
            dayData.itemsSold.forEach((item, i) => {
                text += `${i + 1}. *${item.name}*\n`;
                text += `   ➥ Terjual: *${item.qty}x* | Omzet: *${formatRupiah(item.omzet)}* | 💰 Laba: *${formatRupiah(item.profit)}*\n`;
            });
        }

        if (queryDate === 'today') {
            text += `\n_💡 Cek tanggal lain: .laba DD-MM-YYYY (contoh: .laba 18-09-2026 atau .laba kemarin)_`;
        }

        return sock.sendMessage(sender, { text });
    }

    if (cmd === 'topproduk' || cmd === 'terlaris') {
        const days = parseInt(args.trim(), 10) || 0;
        const data = analytics.getTopProducts(10, days);

        let text = `🏆 *TOP 10 PRODUK PALING BANYAK DIBELI*\n`;
        text += `Periode: *${data.periodLabel}*\n\n`;

        if (data.ranking.length === 0) {
            text += `_Belum ada transaksi sukses yang tercatat dalam periode ini._`;
        } else {
            data.ranking.forEach((item, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                text += `${medal} *${item.name}*\n`;
                text += `   • Kategori : ${item.category}\n`;
                text += `   • Terjual  : *${item.qty}x*\n`;
                text += `   • Omzet    : *${formatRupiah(item.omzet)}*\n`;
                text += `   • 💰 Laba   : *${formatRupiah(item.profit)}*\n\n`;
            });
        }

        return sock.sendMessage(sender, { text });
    }

    if (cmd === 'produkgagal' || cmd === 'gagal') {
        const days = parseInt(args.trim(), 10) || 0;
        const data = analytics.getFailedProducts(10, days);

        let text = `⚠️ *LAPORAN ANALISA PRODUK GAGAL*\n`;
        text += `Periode: *${data.periodLabel}* | Total Gagal: *${data.totalFailedTrx} trx*\n\n`;

        if (data.ranking.length === 0) {
            text += `_🎉 Luar biasa! Tidak ada transaksi gagal yang tercatat._`;
        } else {
            text += `_Daftar produk dengan frekuensi kegagalan tertinggi (evaluasi Digiflazz):_\n\n`;
            data.ranking.forEach((item, i) => {
                text += `${i + 1}. ❌ *${item.name}*\n`;
                text += `   • Total Gagal : *${item.failCount} kali*\n`;
                text += `   • Penyebab    : _${item.topReasons}_\n\n`;
            });
        }

        return sock.sendMessage(sender, { text });
    }

    // ==========================================
    // ⚙️ PENGATURAN BOT LENGKAP (IN-CHAT ADMIN)
    // ==========================================
    if (cmd === 'settings' || cmd === 'pengaturan') {
        const configData = require('../config');
        const lim = marginHelper.getTierLimits();
        const tier = marginHelper.getProfitTier();
        const activeGw = (configData.paymentGateway || 'paymentkita').toLowerCase();
        let t = `⚙️ *PENGATURAN BOT AKTIF*\n\n`;
        t += `🏪 *TOKO:*\n• Nama: *${db.store.namaToko || "DIGITAL STORE"}*\n• Status: *${db.store.buka ? "🟢 BUKA" : "🔴 TUTUP"}*\n\n`;
        t += `💳 *PAYMENT GATEWAY (AKTIF: ${activeGw.toUpperCase()}):*\n`;
        t += `• PaymentKita: Merchant ID \`${configData.paymentkita.merchantId || '-'}\` | Secret \`${maskSecret(configData.paymentkita.secret)}\`\n`;
        t += `• Pakasir: Project \`${configData.pakasir.project || '-'}\` | Key \`${maskSecret(configData.pakasir.key)}\`\n\n`;
        t += `🔑 *DIGIFLAZZ API:*\n• User: \`${configData.digiflazz.username || '-'}\`\n• Key: \`${maskSecret(configData.digiflazz.key)}\`\n\n`;
        t += `🤖 *TELEGRAM COMMAND CENTER:*\n• Token: \`${maskSecret(configData.telegram.token)}\`\n• Chat ID: \`${configData.telegram.chatId || '-'}\`\n\n`;
        t += `📊 *SKEMA MARGIN AUTOTIER (HARGA MODAL):*\n`;
        t += `• 🟢 Kecil (Rp 0 - ${formatRupiah(lim.kecil)}): *${formatRupiah(tier.kecil)}*\n`;
        t += `• 🟡 Sedang (${formatRupiah(lim.kecil + 1)} - ${formatRupiah(lim.sedang)}): *${formatRupiah(tier.sedang)}*\n`;
        t += `• 🔵 Besar (${formatRupiah(lim.sedang + 1)} - ${formatRupiah(lim.besar)}): *${formatRupiah(tier.besar)}*\n`;
        t += `• 🟣 Premium (> ${formatRupiah(lim.besar)}): *${formatRupiah(tier.premium)}*\n`;
        t += `• 📑 Biaya Admin Pascabayar: *${formatRupiah(configData.profit.pasca)}*\n\n`;
        t += `👑 *DAFTAR OWNER/ADMIN:*\n`;
        configData.owner.forEach((o, i) => t += `${i+1}. ${o}\n`);
        t += `\n_💡 Ketik .admin untuk melihat daftar perintah pengubahan._`;
        return sock.sendMessage(sender, { text: t });
    }

    if (cmd === 'margin' || cmd === 'tier') {
        return sock.sendMessage(sender, { text: marginHelper.getMarginSummaryText() });
    }

    if (cmd === 'setgateway' || cmd === 'gateway') {
        const targetGw = args.trim().toLowerCase();
        if (!['paymentkita', 'pakasir'].includes(targetGw)) {
            return sock.sendMessage(sender, { 
                text: `❌ Pilihan gateway tidak valid.\nFormat: .setgateway [paymentkita|pakasir]\nContoh: .setgateway pakasir` 
            });
        }
        if (!db.settings) db.settings = {};
        db.settings.paymentGateway = targetGw;
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { 
            text: `✅ Payment Gateway aktif berhasil disetel ke: *${targetGw.toUpperCase()}*` 
        });
    }

    if (cmd === 'setdigi') {
        const [user, key] = args.trim().split(/\s+/);
        if (!user || !key || user.length < 3 || key.length < 8) {
            return sock.sendMessage(sender, { text: "❌ Format salah atau kredensial terlalu pendek.\nFormat: .setdigi [username] [api_key]\nContoh: .setdigi myuser 32d4-xxxx" });
        }
        if (!db.settings) db.settings = {};
        db.settings.digiflazz = { username: user, key: key };
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Berhasil memperbarui kredensial Digiflazz!\nUsername: ${user}\nKey: ${maskSecret(key)}` });
    }

    if (cmd === 'setpayment') {
        const [mId, secret] = args.trim().split(/\s+/);
        if (!mId || !secret || mId.length < 3 || secret.length < 8) {
            return sock.sendMessage(sender, { text: "❌ Format salah atau secret terlalu pendek.\nFormat: .setpayment [merchant_id] [secret_key]\nContoh: .setpayment PKM12345 PKSK_xxxx" });
        }
        if (!db.settings) db.settings = {};
        db.settings.paymentkita = { merchantId: mId, secret: secret };
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Berhasil memperbarui kredensial PaymentKita!\nMerchant ID: ${mId}\nSecret: ${maskSecret(secret)}` });
    }

    if (cmd === 'setpakasir') {
        const [project, key] = args.trim().split(/\s+/);
        if (!project || !key || project.length < 2 || key.length < 6) {
            return sock.sendMessage(sender, { 
                text: "❌ Format salah atau kredensial terlalu pendek.\nFormat: .setpakasir [project_slug] [api_key]\nContoh: .setpakasir myproject 98a7bc..." 
            });
        }
        if (!db.settings) db.settings = {};
        db.settings.pakasir = { project, key };
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { 
            text: `✅ Berhasil memperbarui kredensial Pakasir!\nProject: ${project}\nKey: ${maskSecret(key)}` 
        });
    }

    if (cmd === 'settg') {
        const [token, chatId] = args.trim().split(/\s+/);
        if (!token || !chatId || !token.includes(':') || !/^[0-9-]+$/.test(chatId)) {
            return sock.sendMessage(sender, { text: "❌ Format bot token atau Chat ID Telegram tidak valid.\nContoh: .settg 847009:AAEA... 7236113204" });
        }
        if (!db.settings) db.settings = {};
        db.settings.telegram = { token, chatId };
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Berhasil memperbarui konfigurasi Telegram!\nToken: ${maskSecret(token)}\nChat ID: ${chatId}` });
    }

    if (cmd === 'setprofit') {
        const [katRaw, nomStr] = args.trim().split(/\s+/);
        const kat = (katRaw || '').toLowerCase();
        const nom = parseInt(nomStr, 10);
        if (!['pulsa', 'data', 'emoney', 'pln', 'pasca'].includes(kat) || isNaN(nom) || nom < 0 || nom > 500000) {
            return sock.sendMessage(sender, { text: "❌ Format salah. Margin harus antara Rp0 - Rp500.000.\nContoh: .setprofit pasca 1500\nKategori: pulsa, data, emoney, pln, pasca" });
        }
        if (!db.settings) db.settings = {};
        const configData = require('../config');
        if (!db.settings.profit) db.settings.profit = { ...configData.profit };
        db.settings.profit[kat] = nom;
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, { text: `✅ Keuntungan kategori *${kat.toUpperCase()}* disetel menjadi *${formatRupiah(nom)}*.` });
    }

    if (cmd === 'setpasca' || cmd === 'setadminpasca') {
        const nom = parseInt(args.trim().replace(/[^0-9]/g, ''), 10);
        if (isNaN(nom) || nom < 0 || nom > 100000) {
            return sock.sendMessage(sender, {
                text: `❌ Format salah. Biaya admin loket pascabayar harus antara Rp0 - Rp100.000.\nContoh: *.setpasca 2000*`
            });
        }
        if (!db.settings) db.settings = {};
        const configData = require('../config');
        if (!db.settings.profit) db.settings.profit = { ...configData.profit };
        db.settings.profit.pasca = nom;
        if (db.saveSettings) db.saveSettings();
        return sock.sendMessage(sender, {
            text: `✅ *BIAYA ADMIN LOKET PASCABAYAR DIPERBARUI!*\n\n` +
                  `• Fee Admin Loket : *${formatRupiah(nom)}* per transaksi\n` +
                  `• Layanan         : PLN Pasca, PDAM, BPJS, Telkom, dll.\n\n` +
                  `_💡 Catatan: Skema margin pascabayar murni berasal dari Fee Admin Loket Toko + Komisi Biller, terpisah dari skema autotier prabayar._`
        });
    }

    if (cmd === 'settier') {
        const parts = args.trim().split(/\s+/);
        const sub = (parts[0] || '').toLowerCase();

        if (sub === 'pasca') {
            return sock.sendMessage(sender, {
                text: `ℹ️ *PASCABAYAR MENGGUNAKAN FEE ADMIN LOKET*\n\n` +
                      `Pascabayar tidak menggunakan rumus autotier berjenjang karena tagihan nominalnya dinamis.\n\n` +
                      `Gunakan perintah: *.setpasca [nominal]*\n` +
                      `Contoh: *.setpasca 2000*`
            });
        }

        if (sub === 'range' || sub === 'batas') {
            const k = parseInt(parts[1], 10);
            const s = parseInt(parts[2], 10);
            const b = parseInt(parts[3], 10);
            if (isNaN(k) || isNaN(s) || isNaN(b) || k <= 0 || s <= k || b <= s) {
                return sock.sendMessage(sender, {
                    text: `❌ Format batas rentang tidak valid.\nContoh: .settier range 25000 100000 300000\nUrutan harus naik (Kecil < Sedang < Besar).`
                });
            }
            try {
                const res = marginHelper.setTierLimits(k, s, b);
                return sock.sendMessage(sender, {
                    text: `✅ *Batas Rentang Harga Berhasil Diperbarui!*\n\n` +
                          `• Kecil  : ≤ ${formatRupiah(k)}\n` +
                          `• Sedang : ${formatRupiah(k + 1)} - ${formatRupiah(s)}\n` +
                          `• Besar  : ${formatRupiah(s + 1)} - ${formatRupiah(b)}\n` +
                          `• Premium: > ${formatRupiah(b)}\n\n` +
                          `🔄 *${res.updatedCount}* produk PPOB langsung diperbarui ke tier baru!`
                });
            } catch (err) {
                return sock.sendMessage(sender, { text: `❌ Gagal update batas: ${err.message}` });
            }
        }

        const tier = sub;
        const nom = parseInt(parts[1], 10);
        if (!['kecil', 'sedang', 'besar', 'premium'].includes(tier) || isNaN(nom) || nom < 0 || nom > 1000000) {
            return sock.sendMessage(sender, {
                text: `❌ Format salah.\n• Ubah Margin: .settier [kecil/sedang/besar/premium] [nominal]\n  Contoh: .settier kecil 350\n• Ubah Batas Rentang: .settier range [k] [s] [b]\n  Contoh: .settier range 25000 100000 300000`
            });
        }

        try {
            const res = marginHelper.setTierMargin(tier, nom);
            const info = marginHelper.getTierInfo(
                tier === 'kecil' ? 10000 :
                tier === 'sedang' ? 50000 :
                tier === 'besar' ? 150000 : 500000
            );
            return sock.sendMessage(sender, {
                text: `✅ *Margin Tier ${tier.toUpperCase()} Disetel!*\n\n` +
                      `• Rentang Produk : *${info.rangeStr}*\n` +
                      `• Margin Baru    : *${formatRupiah(nom)}*\n` +
                      `• Rekalkulasi    : *${res.updatedCount}* dari ${res.totalCount} produk PPOB langsung diperbarui!`
            });
        } catch (err) {
            return sock.sendMessage(sender, { text: `❌ Gagal update margin: ${err.message}` });
        }
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
        
        const prep = await api.pullAllDigiPrepaid();
        const pascaRes = await api.pullDigiPostpaid();

        let report = "📊 *HASIL SINKRONISASI PPOB:*\n\n";
        if (prep) {
            report += `• PULSA: ${prep.pulsa} produk\n`;
            report += `• DATA: ${prep.data} produk\n`;
            report += `• EMONEY: ${prep.emoney} produk\n`;
            report += `• PLN: ${prep.pln} produk\n`;
        } else {
            report += `• PRABAYAR (PULSA/DATA/EMONEY/PLN): ❌ Gagal\n`;
        }
        report += `• PASCABAYAR: ${pascaRes !== false ? pascaRes + ' produk' : '❌ Gagal'}\n`;
        report += `\n✅ Sinkronisasi katalog selesai dan telah tersimpan ke database.`;
        return sock.sendMessage(sender, { text: report });
    }

    if (cmd === 'snk' || cmd === 'tos' || cmd === 'syarat' || cmd === 'aturan') {
        const legal = require('../lib/legal');
        return sock.sendMessage(sender, { text: legal.getTermsAndConditionsWA() });
    }
}








module.exports = { handleAdmin };