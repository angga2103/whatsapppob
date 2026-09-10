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

        console.log('[BACKUP] Membersihkan file backup lama...');
        // Pembersihan aman lintas platform (Windows & Linux)
        try {
            const currentFiles = fs.readdirSync('.');
            for (const f of currentFiles) {
                if (/^AUTO-BACKUP-[\w.-]+\.zip$/.test(f)) {
                    fs.unlinkSync(f);
                }
            }
        } catch (_) {}

        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const filename = `AUTO-BACKUP-${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
        const zipPath = path.resolve('.', filename);

        console.log('[BACKUP] Membuat file backup baru (Terproteksi dari file rahasia)...');

        if (process.platform === 'win32') {
            // PowerShell zip creation on Windows
            const script = `
                $exclude = @('.env*', 'session_bot*', 'node_modules*', 'logs*', '*.log', '*.zip', '*.tar.gz', '.git*', 'backup*', 'archive_legacy*', 'scratch*');
                $files = Get-ChildItem -Path '.' -Exclude $exclude;
                Compress-Archive -Path $files -DestinationPath '${filename}' -Force;
            `;
            spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
        } else {
            // Linux zip command with strict exclusions
            const excludeArgs = [
                '-r', zipPath, '.',
                '-x', 'node_modules/*',
                '-x', '.env*',
                '-x', 'session_bot/*',
                '-x', 'logs/*',
                '-x', '*.log',
                '-x', '*.zip',
                '-x', '*.tar.gz',
                '-x', '.git/*',
                '-x', 'backup/*',
                '-x', 'backup-full/*',
                '-x', 'backup-source/*',
                '-x', 'archive_legacy/*',
                '-x', 'scratch/*'
            ];
            spawnSync('zip', excludeArgs, { stdio: 'ignore' });
        }

        if (!fs.existsSync(zipPath)) {
            console.log('[BACKUP ERROR] File zip backup gagal dibuat.');
            return;
        }

        const stat = fs.statSync(zipPath);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
        console.log(`[BACKUP] Ukuran File: ${sizeMB} MB`);
        console.log('[BACKUP] Upload ke Telegram Command Center...');

        const form = new FormData();
        form.append('chat_id', config.telegram.chatId);
        form.append('document', fs.createReadStream(zipPath));
        
        const caption = `🛡️ *SMARTDATA COMMAND CENTER* 🛡️\n\n` +
        `📦 *File:* ${filename}\n` +
        `📁 *Size:* ${sizeMB} MB\n` +
        `🕒 *Waktu:* ${now.toLocaleString('id-ID')}\n\n` +
        `🔒 *Keamanan:* File rahasia (.env & credentials) telah dieksklusi demi keamanan.\n\n` +
        `*🛠️ PANDUAN RESTORE:*\n` +
        `Gunakan tombol di bawah jika ingin merestore data ke server.`;

        form.append('caption', caption);
        form.append('parse_mode', 'Markdown');
        form.append('reply_markup', JSON.stringify({
            inline_keyboard: [
                [{ text: '🔄 RESTORE KE SERVER', callback_data: 'cmd_restore' }]
            ]
        }));

        await axios.post(
            `https://api.telegram.org/bot${config.telegram.token}/sendDocument`,
            form,
            { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 300000 }
        );

        console.log('[BACKUP] SELESAI & TERKIRIM KE TELEGRAM');
    } catch (err) {
        console.log('[BACKUP ERROR]', err.message);
    }
}

runBackup();

module.exports = { runBackup };
