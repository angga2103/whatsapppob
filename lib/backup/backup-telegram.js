const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { execSync } = require('child_process');
const config = require('../../config');

async function runBackup() {
    try {
        console.log('[BACKUP] Membersihkan file backup lama di VPS...');
        execSync('rm -f AUTO-BACKUP-*.zip', { stdio: 'ignore' }); // Hapus file lama

        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const filename = `AUTO-BACKUP-${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
        const zipPath = `./${filename}`;

        console.log('[BACKUP] Membuat file backup baru...');
        execSync(
            `zip -r ${zipPath} . \\
            -x "node_modules/*" \\
            -x "backup/*" \\
            -x "backup-full/*" \\
            -x "backup-source/*" \\
            -x "*.zip" \\
            -x "*.tar.gz" \\
            -x ".git/*" \\
            -x "session_bot/pre-key-*.json" \\
            -x "session_bot/lid-mapping-*.json" \\
            -x "session_bot/sender-key-*.json" \\
            -x "session_bot/session-*.json" \\
            -x "session_bot/app-state-*.json"`,
            { stdio: 'inherit' }
        );

        const stat = fs.statSync(zipPath);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        console.log(`[BACKUP] Ukuran File: ${sizeMB} MB`);
        console.log('[BACKUP] Upload ke Telegram Command Center...');

        const form = new FormData();
        form.append('chat_id', config.telegram.chatId);
        form.append('document', fs.createReadStream(zipPath));
        
        // Desain Pesan Telegram yang Elegan & Informatif
        const caption = `🛡️ *SMARTDATA COMMAND CENTER* 🛡️\n\n` +
        `📦 *File:* ${filename}\n` +
        `📁 *Size:* ${sizeMB} MB\n` +
        `🕒 *Waktu:* ${now.toLocaleString('id-ID')}\n\n` +
        `*🛠️ PANDUAN INSTALASI DI VPS BARU:*\n` +
        `\`apt update && apt install unzip -y\`\n` +
        `\`unzip ${filename} -d bot-kasir\`\n` +
        `\`cd bot-kasir\`\n` +
        `\`npm install\`\n` +
        `\`node index.js\`\n\n` +
        `✅ _Bot langsung nyala tanpa perlu scan QR lagi!_`;

        form.append('caption', caption);
        form.append('parse_mode', 'Markdown');
        
        // Memunculkan Tombol Inline Restore
        form.append('reply_markup', JSON.stringify({
            inline_keyboard: [
                [{ text: '🔄 RESTORE KE VPS INI', callback_data: 'cmd_restore' }]
            ]
        }));

        await axios.post(
            `https://api.telegram.org/bot${config.telegram.token}/sendDocument`,
            form,
            { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 300000 }
        );

        console.log('[BACKUP] SELESAI & TERKIRIM KE TELEGRAM');
    } catch (err) {
        console.log('[BACKUP ERROR]');
        console.log(err.message);
    }
}

runBackup();
