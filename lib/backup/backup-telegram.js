const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { spawnSync } = require('child_process');
const config = require('../../config');

async function runBackup() {
    try {
        if (!config.telegram.token || !config.telegram.chatId) {
            console.log('[BACKUP] Telegram Bot Token atau Chat ID belum disetel. Melewati auto-backup.');
            return;
        }

        console.log('[BACKUP] 🧹 Membersihkan file backup lama di VPS...');
        // Hapus file backup lama agar di VPS hanya tersisa 1 file backup terbaru (replace ke yang baru)
        try {
            const currentFiles = fs.readdirSync('.');
            for (const f of currentFiles) {
                if (/^AUTO-BACKUP-[\w.-]+\.zip$/.test(f)) {
                    try { fs.unlinkSync(f); } catch (_) {}
                }
            }
        } catch (_) {}

        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const filename = `AUTO-BACKUP-${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
        const zipPath = path.resolve('.', filename);

        console.log(`[BACKUP] 📦 Membuat file backup lengkap (${filename})...`);

        // Daftar item penting untuk restore lengkap di VPS baru (termasuk session WA & .env)
        const targetItems = [
            '.env',
            'session_bot',
            'database',
            'handlers',
            'lib',
            'system',
            'bin',
            'index.js',
            'config.js',
            'package.json',
            'package-lock.json',
            'install.sh',
            'installer.js',
            'README.md'
        ].filter(f => fs.existsSync(f));

        if (process.platform === 'win32') {
            // PowerShell zip creation on Windows
            const psCmd = `Compress-Archive -Path ${targetItems.join(', ')} -DestinationPath '${filename}' -Force`;
            spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'ignore' });
        } else {
            // Linux zip command: menyertakan semua file aplikasi, database, dan session WhatsApp
            const excludeArgs = [
                '-r', zipPath, '.',
                '-x', 'node_modules/*',
                '-x', '.git/*',
                '-x', 'logs/*',
                '-x', '*.log',
                '-x', '*.zip',
                '-x', '*.tar.gz',
                '-x', 'system/.update_backup/*',
                '-x', 'archive_legacy/*',
                '-x', 'backup-dev/*',
                '-x', 'stable-release/*',
                '-x', 'scratch/*'
            ];
            const zipRes = spawnSync('zip', excludeArgs, { stdio: 'ignore' });
            // Fallback jika zip gagal, gunakan targetItems langsung
            if (!fs.existsSync(zipPath) || zipRes.status !== 0) {
                spawnSync('zip', ['-r', zipPath, ...targetItems], { stdio: 'ignore' });
            }
        }

        if (!fs.existsSync(zipPath)) {
            console.log('[BACKUP ERROR] File zip backup gagal dibuat.');
            return;
        }

        // Pastikan kembali tidak ada file backup ganda (hanya simpan file zip terbaru ini)
        try {
            const allZips = fs.readdirSync('.').filter(f => /^AUTO-BACKUP-[\w.-]+\.zip$/.test(f));
            for (const z of allZips) {
                if (z !== filename) {
                    try { fs.unlinkSync(z); } catch (_) {}
                }
            }
        } catch (_) {}

        const stat = fs.statSync(zipPath);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        console.log(`[BACKUP] Ukuran File: ${sizeMB} MB`);
        console.log('[BACKUP] 🚀 Mengunggah ke Telegram Command Center...');

        const form = new FormData();
        form.append('chat_id', config.telegram.chatId);
        form.append('document', fs.createReadStream(zipPath));
        
        const caption = `🛡️ *SMARTDATA COMMAND CENTER* 🛡️\n\n` +
        `📦 *File:* \`${filename}\`\n` +
        `💾 *Size:* ${sizeMB} MB\n` +
        `🕒 *Waktu:* ${now.toLocaleString('id-ID')}\n\n` +
        `🛠️ *PANDUAN INSTALASI DI VPS BARU:*\n` +
        `\`\`\`bash\n` +
        `apt update && apt install -y curl unzip git\n` +
        `curl -fsSL https://deb.nodesource.com/setup_20.x | bash -\n` +
        `apt install -y nodejs\n` +
        `npm install -g pm2\n` +
        `unzip ${filename} -d /var/www/bot-ppob\n` +
        `cd /var/www/bot-ppob\n` +
        `npm install --production\n` +
        `pm2 start index.js --name bot-ppob\n` +
        `pm2 save && pm2 startup\n` +
        `\`\`\`\n\n` +
        `✅ *Bot langsung nyala tanpa perlu scan QR lagi!*`;

        form.append('caption', caption);
        form.append('parse_mode', 'Markdown');
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

        console.log('[BACKUP] ✅ SELESAI & TERKIRIM KE TELEGRAM');
        return { success: true, filename, sizeMB };
    } catch (err) {
        console.log('[BACKUP ERROR]', err.message);
        return { success: false, error: err.message };
    }
}

// Jalankan jika dieksekusi langsung
if (require.main === module) {
    runBackup();
}

module.exports = { runBackup };
