const fs = require('fs');
const axios = require('axios');
const config = require('../config');

async function runAutoCheckup(sock) {
    let health = {
        whatsapp: false,
        database: false,
        api: false,
        issues: []
    };

    // 1. CEK KESEHATAN WHATSAPP
    try {
        if (sock && sock.user && !sock.authState.creds.loggedOut) {
            health.whatsapp = true;
        } else {
            health.issues.push("🔴 *WhatsApp Disconnected/Suspend*");
        }
    } catch (e) {
        health.issues.push("🔴 *WhatsApp Error:* " + e.message);
    }

    // 2. CEK KESEHATAN DATABASE JSON
    try {
        if (fs.existsSync('./database/users.json') && fs.existsSync('./database/orders.json')) {
            const testReadUsers = JSON.parse(fs.readFileSync('./database/users.json', 'utf8'));
            const testReadOrders = JSON.parse(fs.readFileSync('./database/orders.json', 'utf8'));
            if (typeof testReadUsers === 'object' && typeof testReadOrders === 'object') {
                health.database = true;
            }
        } else {
            health.issues.push("🔴 *Database JSON Hilang*");
        }
    } catch (e) {
        health.issues.push("🔴 *Database Corrupt (Gagal Read/Parse):* " + e.message);
    }

    // 3. CEK KESEHATAN API (PING GATEWAY)
    try {
        // Melakukan ping test ke API Digiflazz (atau Paymentkita)
        const res = await axios.get('https://api.digiflazz.com/', { timeout: 5000 }).catch(e => e.response);
        if (res || res.status === 200 || res.status === 405) { // 405 Method Not Allowed berarti server merespon
            health.api = true;
        } else {
            health.issues.push("🔴 *API Digiflazz Down/Tidak Merespon*");
        }
    } catch (e) {
        health.issues.push("🔴 *Jalur Koneksi API Putus:* " + e.message);
    }

    // 🚨 KEPUTUSAN DIAGNOSTIK & SOLUSI INTERAKTIF
    if (health.issues.length > 0) {
        console.log(`[WATCHDOG] Terdeteksi ${health.issues.length} Masalah Kesehatan Sistem!`);
        
        let reportMsg = `🏥 *UGD MEDICAL CHECKUP ALERT* 🏥\n\n` +
                        `Sistem mendeteksi adanya malfungsi pada komponen vital vps Anda:\n\n` +
                        health.issues.join('\n') + `\n\n` +
                        `🕒 *Waktu:* ${new Date().toLocaleString('id-ID')}\n` +
                        `⚠️ *Rekomendasi:* Segera ambil tindakan penanganan di bawah ini:`;

        let buttons = [];
        
        // Jika Masalahnya ada di WhatsApp, tawarkan tombol Pairing Jarak Jauh
        if (!health.whatsapp) {
            buttons.push([{ text: '📱 TAUTKAN NOMOR BARU', callback_data: 'cmd_pair_new' }]);
        }
        
        // Jika Masalahnya ada di Database corrupt, tawarkan Restore otomatis dari backup zip terakhir
        if (!health.database) {
            buttons.push([{ text: '📦 AUTO RESTORE DATA BACKUP', callback_data: 'cmd_restore' }]);
        }
        
        // Tombol standar untuk membersihkan zombie proses dan merestart bot
        buttons.push([{ text: '🔄 HARD RESTART BOT', callback_data: 'cmd_restore' }]);

        // Kirim Alarm Ke Telegram Command Center Anda
        if (global.botTg) {
            global.botTg.sendMessage(config.telegram.chatId, reportMsg, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            }).catch(e => console.log("Gagal kirim alarm TG:", e.message));
        }
    } else {
        console.log('[WATCHDOG] ❤️ Hasil Scan: Semua Sistem Sehat Walafiat.');
    }
}

module.exports = { runAutoCheckup };
