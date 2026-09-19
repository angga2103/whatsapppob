#!/usr/bin/env bash
# ==============================================================================
# 🤖 BOT PPOB & TOKO DIGITAL WHATSAPP - COMMAND LINE MANAGER (botwa)
# Pintasan Resmi CLI untuk Manajemen Bot via Terminal SSH VPS
# ==============================================================================

# Deteksi direktori instalasi bot
APP_DIR="/var/www/bot-ppob"
if [ ! -f "$APP_DIR/index.js" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    if [ -f "$SCRIPT_DIR/index.js" ]; then
        APP_DIR="$SCRIPT_DIR"
    else
        APP_DIR="$(pwd)"
    fi
fi

cd "$APP_DIR" || exit 1
export DOTENV_CONFIG_QUIET=true

# Warna Terminal
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Helper Jeda Menu (Hanya aktif di mode interaktif)
pause_menu() {
    if [ -t 0 ] && [ -z "$DIRECT_CMD" ]; then
        echo ""
        read -p "Tekan [ENTER] untuk kembali ke menu..."
    fi
}

# Helper Deteksi Nama Proses PM2 Aktif
get_pm2_process_name() {
    local pname=$(node -e "
        try {
            const { execSync } = require('child_process');
            const raw = execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString();
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
                const proc = list.find(p => 
                    p.name === 'bot-ppob' || 
                    p.name === 'bot-kasir' || 
                    p.name === 'index' ||
                    (p.pm2_env && p.pm2_env.pm_exec_path && p.pm2_env.pm_exec_path.includes('index.js')) ||
                    (p.pm2_env && p.pm2_env.status === 'online')
                );
                if (proc && proc.name) {
                    console.log(proc.name);
                    process.exit(0);
                }
            }
        } catch (_) {}
        console.log('bot-ppob');
    " 2>/dev/null)
    echo "${pname:-bot-ppob}"
}

# Helper Status Bot (PM2 & Direct Node)
get_pm2_status() {
    local st=""
    if command -v pm2 &> /dev/null; then
        st=$(node -e "
            try {
                const { execSync } = require('child_process');
                const raw = execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString();
                const list = JSON.parse(raw);
                if (Array.isArray(list)) {
                    const proc = list.find(p => 
                        p.name === 'bot-ppob' || 
                        p.name === 'bot-kasir' || 
                        p.name === 'index' ||
                        (p.pm2_env && p.pm2_env.pm_exec_path && p.pm2_env.pm_exec_path.includes('index.js')) ||
                        (p.pm2_env && p.pm2_env.status === 'online')
                    );
                    if (proc && proc.pm2_env) {
                        const status = proc.pm2_env.status || 'unknown';
                        const name = proc.name || 'bot-ppob';
                        const mem = proc.monit?.memory ? (proc.monit.memory / 1024 / 1024).toFixed(1) + 'MB' : '';
                        console.log(status + '|' + name + '|' + mem);
                        process.exit(0);
                    }
                }
            } catch (_) {}
            console.log('');
        " 2>/dev/null)
    fi

    if [ -n "$st" ]; then
        local status=$(echo "$st" | cut -d'|' -f1)
        local pname=$(echo "$st" | cut -d'|' -f2)
        local mem=$(echo "$st" | cut -d'|' -f3)
        if [ "$status" == "online" ]; then
            if [ -n "$mem" ]; then
                echo -e "${GREEN}● ONLINE (PM2: $pname | RAM: $mem)${NC}"
            else
                echo -e "${GREEN}● ONLINE (PM2: $pname)${NC}"
            fi
            return
        elif [ -n "$status" ]; then
            echo -e "${YELLOW}● $status (PM2: $pname)${NC}"
            return
        fi
    fi

    # Fallback 2: Cek proses node langsung (misal: dijalankan manual node index.js)
    local node_pid=$(pgrep -f "node.*index\.js" 2>/dev/null | head -n 1)
    if [ -n "$node_pid" ]; then
        echo -e "${GREEN}● ONLINE (PID: $node_pid)${NC}"
        return
    fi

    echo -e "${RED}● STOPPED / OFFLINE${NC}"
}

# Helper Status Bot WhatsApp
get_whatsapp_status() {
    local res=$(node -e "
        try {
            const fs = require('fs');
            let st = {};
            if (fs.existsSync('./system/bot-status.json')) {
                try { st = JSON.parse(fs.readFileSync('./system/bot-status.json', 'utf8')); } catch(_) {}
            }
            const wa = st.whatsapp || {};
            const hasCreds = fs.existsSync('./session_bot/creds.json');
            if (wa.connected && wa.status === 'online') {
                const phone = wa.phone ? '+' + wa.phone : 'Terhubung';
                console.log('ONLINE|' + phone);
            } else if (wa.status === 'connecting' || wa.status === 'reconnecting') {
                console.log('CONNECTING|Menghubungkan...');
            } else if (hasCreds) {
                console.log('READY|Sesi tersimpan (Siap)');
            } else {
                console.log('OFFLINE|Belum Login / Scan QR');
            }
        } catch (_) {
            console.log('UNKNOWN|Periksa log');
        }
    " 2>/dev/null)

    local line=$(echo "$res" | grep -F "|" | tail -n 1)
    local code=$(echo "$line" | cut -d'|' -f1 | tr -d '\r\n')
    local desc=$(echo "$line" | cut -d'|' -f2- | tr -d '\r\n')

    if [ "$code" == "ONLINE" ]; then
        echo -e "${GREEN}● ONLINE ($desc)${NC}"
    elif [ "$code" == "CONNECTING" ]; then
        echo -e "${YELLOW}● MENGHUBUNGKAN ($desc)${NC}"
    elif [ "$code" == "READY" ]; then
        echo -e "${YELLOW}● SIAP ($desc)${NC}"
    elif [ "$code" == "OFFLINE" ]; then
        echo -e "${RED}● OFFLINE ($desc)${NC}"
    else
        echo -e "${YELLOW}● $code ($desc)${NC}"
    fi
}

# Helper Status Bot Telegram
get_telegram_status() {
    local res=$(node -e "
        try {
            const fs = require('fs');
            let st = {};
            if (fs.existsSync('./system/bot-status.json')) {
                try { st = JSON.parse(fs.readFileSync('./system/bot-status.json', 'utf8')); } catch(_) {}
            }
            let token = '';
            if (fs.existsSync('./database/settings.json')) {
                try {
                    const s = JSON.parse(fs.readFileSync('./database/settings.json', 'utf8'));
                    token = s.telegram?.token || '';
                } catch(_) {}
            }
            if (!token && fs.existsSync('./.env')) {
                try {
                    const m = fs.readFileSync('./.env', 'utf8').match(/^TELEGRAM_TOKEN=(.*)$/m);
                    if (m) token = m[1].trim();
                } catch(_) {}
            }
            const tg = st.telegram || {};
            const hasToken = Boolean(token && token.includes(':') && !token.startsWith('8470095940'));

            if (!hasToken) {
                console.log('DISABLED|Token belum diatur');
            } else if (tg.status === 'conflict') {
                console.log('CONFLICT|409 Conflict (Ganda/Zombie)');
            } else if (tg.status === 'unauthorized') {
                console.log('UNAUTHORIZED|401 Token Tidak Valid');
            } else if (tg.status === 'online' || tg.active) {
                const u = tg.username ? '@' + tg.username : 'Aktif';
                console.log('ONLINE|' + u + ' (Polling OK)');
            } else if (tg.status === 'restarting') {
                console.log('RESTARTING|Sedang Restart...');
            } else if (tg.lastError) {
                console.log('ERROR|' + tg.lastError.slice(0, 25));
            } else {
                console.log('OFFLINE|Tidak Aktif / Menunggu');
            }
        } catch (_) {
            console.log('UNKNOWN|Periksa log');
        }
    " 2>/dev/null)

    local line=$(echo "$res" | grep -F "|" | tail -n 1)
    local code=$(echo "$line" | cut -d'|' -f1 | tr -d '\r\n')
    local desc=$(echo "$line" | cut -d'|' -f2- | tr -d '\r\n')

    if [ "$code" == "ONLINE" ]; then
        echo -e "${GREEN}● ONLINE ($desc)${NC}"
    elif [ "$code" == "RESTARTING" ]; then
        echo -e "${YELLOW}● RESTART ($desc)${NC}"
    elif [ "$code" == "CONFLICT" ]; then
        echo -e "${RED}● KONFLIK ($desc)${NC}"
    elif [ "$code" == "UNAUTHORIZED" ]; then
        echo -e "${RED}● UNAUTHORIZED ($desc)${NC}"
    elif [ "$code" == "DISABLED" ]; then
        echo -e "${YELLOW}● NONAKTIF ($desc)${NC}"
    else
        echo -e "${RED}● OFFLINE (${desc:-Tidak Aktif})${NC}"
    fi
}

show_header() {
    clear
    echo -e "${CYAN}====================================================================${NC}"
    echo -e "${BOLD}     🤖 BOT PPOB & TOKO DIGITAL WHATSAPP - COMMAND CENTER CLI${NC}"
    echo -e "${CYAN}====================================================================${NC}"
    echo -e " 📁 Direktori    : ${BOLD}$APP_DIR${NC}"
    echo -e " ⚡ Status PM2   : $(get_pm2_status)"
    echo -e " 📱 Bot WhatsApp : $(get_whatsapp_status)"
    echo -e " ✈️ Bot Telegram : $(get_telegram_status)"
    echo -e " 🕒 Waktu VPS    : $(date '+%d/%m/%Y %H:%M:%S WIB')"
    echo -e "${CYAN}--------------------------------------------------------------------${NC}"
}

# 1. Status Bot & Sistem
cmd_status() {
    echo -e "\n${BOLD}📊 MEMERIKSA STATUS SISTEM & STATUS KEDUA BOT...${NC}\n"
    echo -e " 📱 WhatsApp Bot : $(get_whatsapp_status)"
    echo -e " ✈️ Telegram Bot : $(get_telegram_status)"
    echo ""
    if command -v pm2 &> /dev/null; then
        echo -e "${BOLD}📋 Daftar Seluruh Proses PM2:${NC}"
        pm2 list
    fi
    echo ""
    echo -e "${BOLD}🔍 Pengecekan Proses Node.js di Sistem:${NC}"
    local node_procs=$(ps aux 2>/dev/null | grep -E "node.*(index|pairing)" | grep -v grep)
    if [ -n "$node_procs" ]; then
        echo "$node_procs"
    else
        echo "✓ Tidak ada proses node liar di luar sistem."
    fi
    echo ""
    echo -e "${BOLD}💾 Pemakaian RAM Server:${NC}"
    free -h
    echo ""
    echo -e "${BOLD}💽 Pemakaian Disk Storage:${NC}"
    df -h / | awk 'NR==1 || NR==2'
    echo ""
    node -e "
        try {
            const fs = require('fs');
            const hasSession = fs.existsSync('./session_bot/creds.json');
            console.log('📱 Sesi WhatsApp :', hasSession ? '🟢 Terdaftar (session_bot/creds.json)' : '🔴 Belum Terhubung');
            if (fs.existsSync('./system/bot-status.json')) {
                const st = JSON.parse(fs.readFileSync('./system/bot-status.json', 'utf8'));
                if (st.whatsapp?.phone) console.log('📞 Nomor WA Aktif:', '+' + st.whatsapp.phone);
                if (st.telegram?.username) console.log('✈️ User Telegram :', '@' + st.telegram.username + ' (' + (st.telegram.status || 'unknown') + ')');
                if (st.telegram?.adminId) console.log('👤 Admin Chat ID :', st.telegram.adminId);
            }
            if (fs.existsSync('./system/status.json')) {
                const st = JSON.parse(fs.readFileSync('./system/status.json', 'utf8'));
                console.log('⚡ Modus Operasi :', st.mode || 'normal');
            }
        } catch (_) {}
    " 2>/dev/null
    echo ""
    pause_menu
}

# 2. Restart Bot Total (PM2 Proses)
cmd_restart() {
    echo -e "\n${YELLOW}🔄 Merestart proses bot total (PM2 bot-ppob)...${NC}"
    rm -f /usr/local/bin/bot-ppob /usr/bin/bot-ppob 2>/dev/null || true
    # 1. Bersihkan proses PM2 yang duplikat jika ada (selain bot-ppob)
    node -e "
        try {
            const { execSync } = require('child_process');
            const raw = execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString();
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
                list.forEach(p => {
                    if (p.name !== 'bot-ppob' && (p.name === 'bot-kasir' || p.name === 'index' || (p.pm2_env && p.pm2_env.pm_exec_path && p.pm2_env.pm_exec_path.includes('index.js')))) {
                        console.log('Menghapus proses PM2 ganda: ' + p.name);
                        try { execSync('pm2 delete ' + p.name, { stdio: 'ignore' }); } catch(_) {}
                    }
                });
            }
        } catch (_) {}
    " 2>/dev/null

    # 2. Matikan proses node di luar PM2 yang mungkin nyangkut (zombie)
    local cur_pm2_pid=$(node -e "
        try {
            const { execSync } = require('child_process');
            const raw = execSync('pm2 jlist', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
            const list = JSON.parse(raw);
            const p = list.find(x => x.name === 'bot-ppob');
            if (p && p.pid) console.log(p.pid);
        } catch (_) {}
    " 2>/dev/null)

    for pid in $(pgrep -f "node.*(index|pairing_bridge)\.js" 2>/dev/null); do
        if [ "$pid" != "$cur_pm2_pid" ] && [ -n "$pid" ]; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    done

    # 3. Reset webhook & drop pending updates Telegram agar koneksi fresh
    node -e "
        const https = require('https');
        const fs = require('fs');
        let token = '';
        try {
            const s = JSON.parse(fs.readFileSync('./database/settings.json', 'utf8'));
            token = s.telegram?.token || '';
        } catch(_) {}
        if (!token && fs.existsSync('./.env')) {
            const m = fs.readFileSync('./.env', 'utf8').match(/^TELEGRAM_TOKEN=(.*)$/m);
            if (m) token = m[1].trim();
        }
        if (token && token.includes(':') && !token.startsWith('8470095940')) {
            https.get('https://api.telegram.org/bot' + token + '/deleteWebhook?drop_pending_updates=true', res => {
                res.on('data', () => {});
            }).on('error', () => {});
        }
    " 2>/dev/null

    cd "$APP_DIR" || exit 1
    pm2 restart bot-ppob 2>/dev/null || pm2 start index.js --name bot-ppob
    pm2 save 2>/dev/null || true
    echo -e "${GREEN}✅ Seluruh sistem bot berhasil direstart secara bersih!${NC}"
    sleep 2
}

# 3. Restart Bot WhatsApp Saja
cmd_restart_wa() {
    echo -e "\n${CYAN}====================================================================${NC}"
    echo -e "${BOLD}   📱 RESTART KONEKSI BOT WHATSAPP SAJA${NC}"
    echo -e "   (Menghubungkan ulang Baileys socket tanpa menghentikan Telegram)"
    echo -e "${CYAN}====================================================================${NC}\n"
    mkdir -p "$APP_DIR/system"
    touch "$APP_DIR/system/.restart-wa"
    echo -e "Mengirim sinyal restart socket ke Bot WhatsApp..."
    sleep 3
    echo -e "${GREEN}✅ Sinyal restart dikirim.${NC}"
    echo -e "Status WhatsApp: $(get_whatsapp_status)"
    pause_menu
}

# 4. Restart Bot Telegram Saja
cmd_restart_tg() {
    echo -e "\n${CYAN}====================================================================${NC}"
    echo -e "${BOLD}   ✈️ RESTART BOT TELEGRAM SAJA${NC}"
    echo -e "   (Mereset long-polling Telegram tanpa memutus koneksi WhatsApp)"
    echo -e "${CYAN}====================================================================${NC}\n"
    node -e "
        const https = require('https');
        const fs = require('fs');
        let token = '';
        try {
            const s = JSON.parse(fs.readFileSync('./database/settings.json', 'utf8'));
            token = s.telegram?.token || '';
        } catch(_) {}
        if (!token && fs.existsSync('./.env')) {
            const m = fs.readFileSync('./.env', 'utf8').match(/^TELEGRAM_TOKEN=(.*)$/m);
            if (m) token = m[1].trim();
        }
        if (token && token.includes(':') && !token.startsWith('8470095940')) {
            https.get('https://api.telegram.org/bot' + token + '/deleteWebhook?drop_pending_updates=false', res => {
                res.on('data', () => {});
            }).on('error', () => {});
        }
    " 2>/dev/null
    mkdir -p "$APP_DIR/system"
    touch "$APP_DIR/system/.restart-tg"
    echo -e "Mengirim sinyal restart polling ke Bot Telegram..."
    sleep 3
    echo -e "${GREEN}✅ Sinyal restart dikirim.${NC}"
    echo -e "Status Telegram: $(get_telegram_status)"
    pause_menu
}

# 8. Diagnostik & Tes Koneksi Telegram
cmd_test_tg() {
    echo -e "\n${CYAN}====================================================================${NC}"
    echo -e "${BOLD}       ✈️ DIAGNOSTIK & TES KONEKSI BOT TELEGRAM${NC}"
    echo -e "${CYAN}====================================================================${NC}\n"
    node -e "
        const https = require('https');
        const fs = require('fs');
        let token = '', chatId = '';
        try {
            const s = JSON.parse(fs.readFileSync('./database/settings.json', 'utf8'));
            token = s.telegram?.token || '';
            chatId = s.telegram?.chatId || '';
        } catch(_) {}
        if (!token && fs.existsSync('./.env')) {
            const env = fs.readFileSync('./.env', 'utf8');
            const mT = env.match(/^TELEGRAM_TOKEN=(.*)$/m);
            const mC = env.match(/^TELEGRAM_CHAT_ID=(.*)$/m);
            if (mT) token = mT[1].trim();
            if (mC) chatId = mC[1].trim();
        }

        if (!token || !token.includes(':') || token.startsWith('8470095940')) {
            console.log('❌ Token Telegram belum diatur atau tidak valid di settings.json / .env!');
            process.exit(0);
        }

        console.log('🔑 Token               : ' + token.slice(0, 6) + '••••' + token.slice(-4));
        console.log('👤 Admin Chat ID       : ' + (chatId || '(Belum diatur)'));
        console.log('\n📡 Menghubungi Server Telegram API (getMe)...');

        https.get('https://api.telegram.org/bot' + token + '/getMe', res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ok) {
                        console.log('✅ Token Valid! Bot: @' + json.result.username + ' (' + json.result.first_name + ')');
                        console.log('   ID Bot Telegram     : ' + json.result.id);
                        console.log('   Grup Diizinkan      : ' + (json.result.can_join_groups ? 'Ya' : 'Tidak'));

                        // Cek Webhook
                        https.get('https://api.telegram.org/bot' + token + '/getWebhookInfo', wRes => {
                            let wData = '';
                            wRes.on('data', c => wData += c);
                            wRes.on('end', () => {
                                try {
                                    const wJson = JSON.parse(wData);
                                    if (wJson.ok) {
                                        console.log('🌐 Webhook URL         : ' + (wJson.result.url || '(Kosong - Polling Mode Siap)'));
                                        console.log('📬 Pending Update Count: ' + (wJson.result.pending_update_count || 0) + ' pesan');
                                    }
                                } catch(_) {}

                                if (chatId) {
                                    console.log('\n✉️ Mengirim Pesan Uji Coba ke Admin (' + chatId + ')...');
                                    const payload = JSON.stringify({
                                        chat_id: chatId,
                                        text: '🔔 *TES KONEKSI BOT TELEGRAM*\n\n✅ Halo Admin! Bot Telegram terhubung dengan baik ke server VPS.\nWaktu: ' + new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB',
                                        parse_mode: 'Markdown'
                                    });
                                    const req = https.request({
                                        hostname: 'api.telegram.org',
                                        path: '/bot' + token + '/sendMessage',
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                                    }, sRes => {
                                        let sData = '';
                                        sRes.on('data', sc => sData += sc);
                                        sRes.on('end', () => {
                                            try {
                                                const sJson = JSON.parse(sData);
                                                if (sJson.ok) {
                                                    console.log('✅ Pesan uji coba berhasil masuk ke Telegram Anda!');
                                                } else {
                                                    console.log('⚠️ Gagal kirim pesan ke Admin: ' + (sJson.description || 'Unknown error'));
                                                }
                                            } catch(_) {}
                                        });
                                    });
                                    req.on('error', e => console.log('⚠️ Error kirim pesan: ' + e.message));
                                    req.write(payload);
                                    req.end();
                                } else {
                                    console.log('ℹ️ Admin Chat ID belum diset di .env sehingga pesan tes tidak dikirim.');
                                }
                            });
                        });
                    } else {
                        console.log('❌ Token Gagal / Ditolak Telegram: ' + (json.description || 'Unknown error'));
                    }
                } catch(err) {
                    console.log('❌ Gagal memproses respon Telegram: ' + err.message);
                }
            });
        }).on('error', err => {
            console.log('❌ Gagal koneksi ke api.telegram.org: ' + err.message);
        });
    " 2>/dev/null
    echo ""
    pause_menu
}

# 9. Diagnostik & Cek Sesi WhatsApp
cmd_test_wa() {
    echo -e "\n${CYAN}====================================================================${NC}"
    echo -e "${BOLD}       📱 DIAGNOSTIK & STATUS LENGKAP BOT WHATSAPP${NC}"
    echo -e "${CYAN}====================================================================${NC}\n"
    node -e "
        const fs = require('fs');
        console.log('1. Direktori Sesi (session_bot) : ' + (fs.existsSync('./session_bot') ? '✅ Ada' : '❌ Tidak Ada'));
        const credsExists = fs.existsSync('./session_bot/creds.json');
        if (credsExists) {
            const sz = fs.statSync('./session_bot/creds.json').size;
            console.log('2. File Sesi Kredensial (creds) : ✅ Ada (' + sz + ' bytes)');
        } else {
            console.log('2. File Sesi Kredensial (creds) : ❌ Belum Ada / Belum Scan QR/Pairing');
        }

        let st = {};
        if (fs.existsSync('./system/bot-status.json')) {
            try { st = JSON.parse(fs.readFileSync('./system/bot-status.json', 'utf8')); } catch(_) {}
        }
        const wa = st.whatsapp || {};
        console.log('3. Status Koneksi              : ' + (wa.connected ? '🟢 TERHUBUNG (ONLINE)' : '🔴 TERPUTUS (' + (wa.status || 'offline') + ')'));
        console.log('4. Nomor HP Bot WhatsApp       : ' + (wa.phone ? '+' + wa.phone : '(Belum Terdeteksi)'));
        if (wa.updatedAt) {
            console.log('5. Terakhir Diperbarui         : ' + new Date(wa.updatedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB');
        }
    " 2>/dev/null
    echo ""
    pause_menu
}

# 3. Stop Bot
cmd_stop() {
    echo -e "\n${RED}⏹️ Menghentikan proses bot...${NC}"
    pm2 stop bot-ppob 2>/dev/null || pm2 stop all 2>/dev/null || true
    echo -e "${GREEN}✅ Bot dihentikan.${NC}"
    sleep 2
}

# 4. Start Bot
cmd_start() {
    echo -e "\n${GREEN}▶️ Menjalankan proses bot (index.js via PM2)...${NC}"
    rm -f /usr/local/bin/bot-ppob /usr/bin/bot-ppob 2>/dev/null || true
    cd "$APP_DIR" || exit 1
    pm2 restart bot-ppob 2>/dev/null || pm2 start index.js --name bot-ppob
    pm2 save 2>/dev/null || true
    echo -e "${GREEN}✅ Bot berhasil dijalankan!${NC}"
    sleep 2
}

# 5. Lihat Log Real-Time
cmd_logs() {
    local PNAME=$(get_pm2_process_name)
    echo -e "\n${CYAN}📜 Menampilkan Log Real-Time ($PNAME) (Tekan Ctrl+C untuk keluar)...${NC}\n"
    sleep 1
    pm2 logs "$PNAME" --lines 50 2>/dev/null || pm2 logs --lines 50
}

# 6. Backup Data Manual Sekarang
cmd_backup() {
    echo -e "\n${CYAN}📦 Menjalankan Backup Data & Mengirim ke Telegram...${NC}"
    node lib/backup/backup-telegram.js
    if [ $? -eq 0 ]; then
        echo -e "\n${GREEN}✅ Proses backup selesai. File arsip telah dikirim ke bot Telegram Anda!${NC}"
    else
        echo -e "\n${RED}❌ Proses backup mengalami kendala. Silakan periksa pesan log di atas.${NC}"
    fi
    pause_menu
}

# 7. Restore Data dari Backup Terakhir
cmd_restore() {
    echo -e "\n${YELLOW}🔄 MEMULIHKAN DATA DARI BACKUP TERAKHIR...${NC}"
    local backup_file=$(ls -t AUTO-BACKUP-*.zip 2>/dev/null | head -n 1)
    if [ -z "$backup_file" ]; then
        echo -e "${RED}❌ Tidak ditemukan file AUTO-BACKUP-*.zip di folder $APP_DIR!${NC}"
        pause_menu
        return
    fi

    echo -e "File backup ditemukan: ${BOLD}$backup_file${NC}"
    read -p "Yakin ingin menimpa database & sesi saat ini dengan file ini? (y/N): " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        echo -e "${CYAN}Mengekstrak $backup_file...${NC}"
        if command -v unzip &> /dev/null; then
            unzip -o "$backup_file" -d "$APP_DIR"
        else
            apt-get update && apt-get install -y unzip
            unzip -o "$backup_file" -d "$APP_DIR"
        fi
        local PNAME=$(get_pm2_process_name)
        echo -e "${GREEN}✅ Ekstraksi selesai. Merestart bot ($PNAME)...${NC}"
        pm2 restart "$PNAME" 2>/dev/null || pm2 restart all 2>/dev/null || pm2 start index.js --name bot-ppob
        echo -e "${GREEN}✅ Restore berhasil!${NC}"
    else
        echo -e "${YELLOW}Restore dibatalkan.${NC}"
    fi
    pause_menu
}

# 13. Ganti Token Telegram & Chat ID Admin (Solusi jika bot tersuspend Telegram)
cmd_change_telegram() {
    echo -e "\n${CYAN}====================================================================${NC}"
    echo -e "${BOLD}   🔑 GANTI TOKEN BOT TELEGRAM & CHAT ID ADMIN${NC}"
    echo -e "   (Menghapus kredensial bot lama & beralih 100% ke bot baru)"
    echo -e "${CYAN}====================================================================${NC}\n"

    # Tampilkan token saat ini secara bersih
    local cur_token=""
    local cur_chat=""
    local cur_info=$(node -e "
        try {
            const fs = require('fs');
            let token = '', chatId = '';
            if (fs.existsSync('./database/settings.json')) {
                try {
                    const s = JSON.parse(fs.readFileSync('./database/settings.json', 'utf8'));
                    token = s.telegram?.token || '';
                    chatId = s.telegram?.chatId || '';
                } catch(_) {}
            }
            if (!token && fs.existsSync('./.env')) {
                const env = fs.readFileSync('./.env', 'utf8');
                const mT = env.match(/^TELEGRAM_TOKEN=(.*)$/m);
                const mC = env.match(/^TELEGRAM_CHAT_ID=(.*)$/m);
                if (mT) token = mT[1].trim();
                if (mC) chatId = mC[1].trim();
            }
            const masked = token.length > 10 ? token.slice(0, 6) + '••••' + token.slice(-4) : '(belum ada)';
            console.log(token + '|' + masked + '|' + chatId);
        } catch(_) {
            console.log('||');
        }
    " 2>/dev/null)

    local line=$(echo "$cur_info" | grep -F "|" | tail -n 1)
    cur_token=$(echo "$line" | cut -d'|' -f1 | tr -d '\r\n')
    local masked_token=$(echo "$line" | cut -d'|' -f2 | tr -d '\r\n')
    cur_chat=$(echo "$line" | cut -d'|' -f3 | tr -d '\r\n')

    echo -e " Token Aktif Saat Ini : ${BOLD}${masked_token:-Belum diatur}${NC}"
    echo -e " Chat ID Saat Ini     : ${BOLD}${cur_chat:-Belum diatur}${NC}"
    echo ""
    echo -e "${YELLOW}Silakan masukkan kredensial Bot Telegram yang baru:${NC}"
    read -p "Masukkan Token Bot Baru (dari @BotFather): " NEW_TOKEN
    read -p "Masukkan Chat ID Admin Baru (dari @userinfobot): " NEW_CHAT_ID

    NEW_TOKEN=$(echo "$NEW_TOKEN" | tr -d '[:space:]')
    NEW_CHAT_ID=$(echo "$NEW_CHAT_ID" | tr -d '[:space:]')

    if [ -z "$NEW_TOKEN" ] || [ -z "$NEW_CHAT_ID" ]; then
        echo -e "${RED}❌ Token dan Chat ID tidak boleh kosong! Batal menyimpan.${NC}"
        pause_menu
        return
    fi

    if [[ ! "$NEW_TOKEN" =~ : ]]; then
        echo -e "${RED}❌ Format Token tidak valid! Token harus mengandung tanda titik dua ':' (contoh: 123456789:ABCDefgh...)${NC}"
        pause_menu
        return
    fi

    # 1. Putuskan koneksi dan antrean pesan di bot lama jika token berbeda
    if [ -n "$cur_token" ] && [ "$cur_token" != "$NEW_TOKEN" ] && [[ "$cur_token" =~ : ]]; then
        echo -e "\n${YELLOW}Memutus webhook & antrean pesan bot lama...${NC}"
        node -e "
            const https = require('https');
            const oldToken = process.argv[1];
            try {
                https.get('https://api.telegram.org/bot' + oldToken + '/deleteWebhook?drop_pending_updates=true', res => {
                    res.on('data', () => {});
                }).on('error', () => {});
            } catch(_) {}
        " "$cur_token" 2>/dev/null
    fi

    echo -e "${CYAN}1. Memperbarui database/settings.json, settings.backup.json, dan .env...${NC}"
    node -e "
        const fs = require('fs');
        const newToken = (process.argv[1] || '').trim();
        const newChatId = (process.argv[2] || '').trim();

        // 1. Update settings.json
        const sPath = './database/settings.json';
        let s = {};
        try { s = JSON.parse(fs.readFileSync(sPath, 'utf8')); } catch(_) {}
        if (!s.telegram) s.telegram = {};
        s.telegram.token = newToken;
        s.telegram.chatId = newChatId;
        fs.writeFileSync(sPath, JSON.stringify(s, null, 2), 'utf8');

        // 2. Update settings.backup.json
        const bPath = './database/settings.backup.json';
        let b = {};
        try { b = JSON.parse(fs.readFileSync(bPath, 'utf8')); } catch(_) {}
        if (!b.telegram) b.telegram = {};
        b.telegram.token = newToken;
        b.telegram.chatId = newChatId;
        fs.writeFileSync(bPath, JSON.stringify(b, null, 2), 'utf8');

        // 3. Update .env
        const envPath = './.env';
        let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        if (/^TELEGRAM_TOKEN=/m.test(env)) {
            env = env.replace(/^TELEGRAM_TOKEN=.*/m, 'TELEGRAM_TOKEN=' + newToken);
        } else {
            env += '\nTELEGRAM_TOKEN=' + newToken;
        }
        if (/^TELEGRAM_CHAT_ID=/m.test(env)) {
            env = env.replace(/^TELEGRAM_CHAT_ID=.*/m, 'TELEGRAM_CHAT_ID=' + newChatId);
        } else {
            env += '\nTELEGRAM_CHAT_ID=' + newChatId;
        }
        fs.writeFileSync(envPath, env.trim() + '\n', 'utf8');

        // 4. Reset cache bot-status.json agar info bot lama tidak tersisa
        const stPath = './system/bot-status.json';
        if (fs.existsSync(stPath)) {
            try {
                let st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
                if (st.telegram) {
                    st.telegram.status = 'restarting';
                    st.telegram.username = '';
                    st.telegram.botName = '';
                    st.telegram.adminId = newChatId;
                    st.telegram.tokenMasked = newToken.length > 10 ? newToken.slice(0, 6) + '••••' + newToken.slice(-4) : '';
                    st.telegram.lastError = null;
                }
                fs.writeFileSync(stPath, JSON.stringify(st, null, 2), 'utf8');
            } catch(_) {}
        }
        console.log('✓ Token lama dihapus dan seluruh konfigurasi tersinkronisasi ke bot baru!');
    " "$NEW_TOKEN" "$NEW_CHAT_ID"

    # 2. Hapus git stash lama agar tidak menimpa pengaturan baru
    git stash clear 2>/dev/null || true

    # 3. Uji Kirim Pesan ke Bot Telegram Baru
    echo -e "${YELLOW}2. Menguji koneksi ke Bot Telegram baru...${NC}"
    node -e "
        const https = require('https');
        const token = process.argv[1];
        const chatId = process.argv[2];

        const payload = JSON.stringify({
            chat_id: chatId,
            text: '🚀 *TEST KONEKSI BOT TELEGRAM BARU*\n\n✅ Berhasil! Bot PPOB WhatsApp Anda kini terhubung ke bot Telegram ini melalui CLI Server (botwa)!\n\nWaktu: ' + new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB',
            parse_mode: 'Markdown'
        });

        const req = https.request({
            hostname: 'api.telegram.org',
            path: '/bot' + token + '/sendMessage',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j.ok) {
                        console.log('✅ Pesan uji coba BERHASIL masuk ke Telegram Anda!');
                    } else {
                        console.log('⚠️ Telegram API merespon: ' + (j.description || d));
                    }
                } catch(_) {
                    console.log('⚠️ Respon Telegram:', d);
                }
            });
        });
        req.on('error', e => console.log('❌ Gagal menghubungi Telegram: ' + e.message));
        req.write(payload);
        req.end();
    " "$NEW_TOKEN" "$NEW_CHAT_ID"

    local PNAME=$(get_pm2_process_name)
    echo -e "\n${CYAN}3. Merestart bot ($PNAME) agar bot baru segera aktif...${NC}"
    pm2 restart "$PNAME" 2>/dev/null || pm2 start index.js --name bot-ppob
    pm2 save 2>/dev/null || true
    echo -e "${GREEN}✅ SELESAI! Token bot lama telah dihapus dan digantikan 100% oleh bot baru.${NC}"
    pause_menu
}

# 9. Ganti Kredensial Gateway
cmd_change_gateway() {
    echo -e "\n${CYAN}====================================================================${NC}"
    echo -e "${BOLD}   💳 EDIT KREDENSIAL DIGIFLAZZ & PAYMENT GATEWAY${NC}"
    echo -e "${CYAN}====================================================================${NC}\n"

    echo "Pilih gateway yang ingin diatur:"
    echo "1) Digiflazz (Username & Production/Development Key)"
    echo "2) Paymentkita (Merchant ID & Secret Key)"
    echo "3) Pakasir (Project Name & API Key)"
    echo "0) Batal"
    read -p "Pilihan Anda [0-3]: " gw_opt

    local PNAME=$(get_pm2_process_name)

    if [ "$gw_opt" == "1" ]; then
        read -p "Masukkan Digiflazz Username : " DIGI_USER
        read -p "Masukkan Digiflazz Key/Secret: " DIGI_KEY
        if [ -n "$DIGI_USER" ] && [ -n "$DIGI_KEY" ]; then
            node -e "
                const fs = require('fs');
                const u = (process.argv[1] || '').trim();
                const k = (process.argv[2] || '').trim();
                ['./database/settings.json', './database/settings.backup.json'].forEach(f => {
                    let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(_){}
                    s.digiflazz = { username: u, key: k };
                    fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
                });
                console.log('✓ Digiflazz berhasil diperbarui!');
            " "$DIGI_USER" "$DIGI_KEY"
            pm2 restart "$PNAME" 2>/dev/null || pm2 restart all 2>/dev/null || pm2 start index.js --name bot-ppob
            echo -e "${GREEN}✅ Kredensial Digiflazz tersimpan dan bot ($PNAME) direstart.${NC}"
        fi
    elif [ "$gw_opt" == "2" ]; then
        read -p "Masukkan Paymentkita Merchant ID: " PK_ID
        read -p "Masukkan Paymentkita Secret Key : " PK_SECRET
        if [ -n "$PK_ID" ] && [ -n "$PK_SECRET" ]; then
            node -e "
                const fs = require('fs');
                const m = (process.argv[1] || '').trim();
                const sec = (process.argv[2] || '').trim();
                ['./database/settings.json', './database/settings.backup.json'].forEach(f => {
                    let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(_){}
                    s.paymentkita = { merchantId: m, secret: sec };
                    s.paymentGateway = 'paymentkita';
                    fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
                });
                console.log('✓ Paymentkita berhasil diperbarui!');
            " "$PK_ID" "$PK_SECRET"
            pm2 restart "$PNAME" 2>/dev/null || pm2 restart all 2>/dev/null || pm2 start index.js --name bot-ppob
            echo -e "${GREEN}✅ Kredensial Paymentkita tersimpan dan bot ($PNAME) direstart.${NC}"
        fi
    elif [ "$gw_opt" == "3" ]; then
        read -p "Masukkan Pakasir Project Slug: " PAKA_PROJ
        read -p "Masukkan Pakasir API Key     : " PAKA_KEY
        if [ -n "$PAKA_PROJ" ] && [ -n "$PAKA_KEY" ]; then
            node -e "
                const fs = require('fs');
                const p = (process.argv[1] || '').trim();
                const k = (process.argv[2] || '').trim();
                ['./database/settings.json', './database/settings.backup.json'].forEach(f => {
                    let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(_){}
                    s.pakasir = { project: p, key: k };
                    s.paymentGateway = 'pakasir';
                    fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
                });
                console.log('✓ Pakasir berhasil diperbarui!');
            " "$PAKA_PROJ" "$PAKA_KEY"
            pm2 restart "$PNAME" 2>/dev/null || pm2 restart all 2>/dev/null || pm2 start index.js --name bot-ppob
            echo -e "${GREEN}✅ Kredensial Pakasir tersimpan dan bot ($PNAME) direstart.${NC}"
        fi
    fi
    pause_menu
}

# 10. Reset Sesi & Pairing WhatsApp
cmd_reset_whatsapp() {
    echo -e "\n${RED}====================================================================${NC}"
    echo -e "${BOLD}   📱 RESET SESI & HUBUNGKAN ULANG WHATSAPP${NC}"
    echo -e "${RED}====================================================================${NC}\n"
    read -p "Yakin ingin menghapus sesi WhatsApp saat ini dan login nomor baru? (y/N): " wa_confirm
    if [[ "$wa_confirm" =~ ^[Yy]$ ]]; then
        local PNAME=$(get_pm2_process_name)
        echo -e "${YELLOW}Menghentikan bot ($PNAME) dan menghapus session_bot/...${NC}"
        pm2 stop "$PNAME" 2>/dev/null || pm2 stop all 2>/dev/null || true
        rm -rf session_bot/
        echo -e "${GREEN}✓ Sesi WhatsApp lama berhasil dihapus.${NC}"
        echo -e "${CYAN}Menjalankan wizard pairing terminal...${NC}"
        node installer.js
        pm2 restart "$PNAME" 2>/dev/null || pm2 restart all 2>/dev/null || pm2 start index.js --name bot-ppob
    fi
    pause_menu
}

# 11. Update Bot ke Versi Terbaru
cmd_update() {
    echo -e "\n${CYAN}🚀 MEMPERBARUI BOT DARI GITHUB...${NC}"
    git stash 2>/dev/null || true
    git pull origin main
    npm install --no-audit --no-fund
    chmod +x "$APP_DIR/bin/botwa.sh" 2>/dev/null || true
    ln -sf "$APP_DIR/bin/botwa.sh" /usr/local/bin/botwa 2>/dev/null || true
    ln -sf "$APP_DIR/bin/botwa.sh" /usr/bin/botwa 2>/dev/null || true
    cmd_restart
    echo -e "\n${GREEN}✅ Pembaruan berhasil diterapkan dan bot telah direstart bersih!${NC}"
    pause_menu
}

# 12. Bersihkan Storage (Log, Cache, dan Backup Lama)
cmd_clean() {
    echo -e "\n${CYAN}🧹 MEMBERSIHKAN STORAGE & FILE SEMENTARA...${NC}"
    # Hapus log PM2 yang menumpuk
    pm2 flush 2>/dev/null || true
    # Hapus file .tmp dan log lokal
    rm -f database/*.tmp 2>/dev/null || true
    rm -f *.log 2>/dev/null || true
    rm -rf logs/* 2>/dev/null || true

    # Hapus backup lama, hanya pertahankan 1 backup zip terbaru
    local latest_backup=$(ls -t AUTO-BACKUP-*.zip 2>/dev/null | head -n 1)
    if [ -n "$latest_backup" ]; then
        for f in AUTO-BACKUP-*.zip; do
            if [ "$f" != "$latest_backup" ] && [ -f "$f" ]; then
                rm -f "$f"
                echo "Dihapus: $f"
            fi
        done
        echo -e "Menyimpan backup terbaru: ${GREEN}$latest_backup${NC}"
    fi

    echo -e "${GREEN}✅ Pembersihan storage selesai!${NC}"
    pause_menu
}

# 13. Perbaiki Konflik Bot Telegram (Kill Zombie & Fix 409 Conflict)
cmd_fix_conflict() {
    echo -e "\n${CYAN}====================================================================${NC}"
    echo -e "${BOLD}   🛠️ PERBAIKI KONFLIK BOT TELEGRAM (KILL ZOMBIE & FIX 409)${NC}"
    echo -e "${CYAN}====================================================================${NC}\n"
    echo -e "${YELLOW}Masalah 409 Conflict terjadi karena token bot Telegram dipakai di 2 proses sekaligus.${NC}"
    echo -e "Mematikan seluruh proses ganda & zombie di VPS, lalu merestart 1 instance bersih...\n"

    echo -e "${CYAN}1. Menghapus symlink rusak /usr/local/bin/bot-ppob...${NC}"
    rm -f /usr/local/bin/bot-ppob /usr/bin/bot-ppob 2>/dev/null || true

    echo -e "${CYAN}2. Menghapus semua proses lama di PM2...${NC}"
    pm2 delete all 2>/dev/null || true

    echo -e "${CYAN}3. Mematikan seluruh proses Node.js background/zombie...${NC}"
    pkill -9 -f "node" 2>/dev/null || true
    sleep 2

    echo -e "${CYAN}3. Mereset koneksi Telegram API (drop pending updates)...${NC}"
    node -e "
        const https = require('https');
        const cfg = require('./config');
        if (cfg.telegram?.token) {
            https.get('https://api.telegram.org/bot' + cfg.telegram.token + '/deleteWebhook?drop_pending_updates=true', (res) => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => console.log('   Response Telegram:', d));
            }).on('error', (e) => console.log('   Gagal reset webhook:', e.message));
        }
    " 2>/dev/null
    sleep 1

    echo -e "${CYAN}4. Menjalankan 1 proses resmi bot-ppob...${NC}"
    cd "$APP_DIR" || exit 1
    pm2 start index.js --name bot-ppob
    pm2 save 2>/dev/null || true

    echo -e "\n${GREEN}✅ SELESAI! Seluruh proses ganda & zombie telah dibersihkan.${NC}"
    echo -e "${CYAN}Silakan cek log dengan perintah 'botwa logs' atau pilih menu [5].${NC}"
    pause_menu
}

# JIKA ADA ARGUMEN BARIS PERINTAH LANGSUNG (Contoh: botwa restart / botwa status / botwa logs)
if [ -n "$1" ]; then
    export DIRECT_CMD=1
    case "$1" in
        status|stat)
            cmd_status; exit 0 ;;
        restart|reboot)
            cmd_restart; exit 0 ;;
        restart-wa|reboot-wa)
            cmd_restart_wa; exit 0 ;;
        restart-tg|reboot-tg|restart-tele)
            cmd_restart_tg; exit 0 ;;
        test-tg|cek-tg|diag-tg)
            cmd_test_tg; exit 0 ;;
        test-wa|cek-wa|diag-wa)
            cmd_test_wa; exit 0 ;;
        stop)
            cmd_stop; exit 0 ;;
        start)
            cmd_start; exit 0 ;;
        logs|log)
            cmd_logs; exit 0 ;;
        backup)
            cmd_backup; exit 0 ;;
        restore)
            cmd_restore; exit 0 ;;
        telegram|tele)
            cmd_change_telegram; exit 0 ;;
        gateway|gw)
            cmd_change_gateway; exit 0 ;;
        reset-wa|pairing)
            cmd_reset_whatsapp; exit 0 ;;
        update)
            cmd_update; exit 0 ;;
        clean)
            cmd_clean; exit 0 ;;
        fix|fix-conflict)
            cmd_fix_conflict; exit 0 ;;
        help|--help|-h)
            echo -e "${BOLD}Panduan Penggunaan Perintah 'botwa':${NC}"
            echo "  botwa               - Buka menu kontrol interaktif"
            echo "  botwa status        - Cek status bot & resource server"
            echo "  botwa restart       - Restart total bot (PM2 bot-ppob)"
            echo "  botwa restart-wa    - Restart koneksi Bot WhatsApp saja"
            echo "  botwa restart-tg    - Restart polling Bot Telegram saja"
            echo "  botwa test-tg       - Diagnostik & tes kirim pesan Telegram"
            echo "  botwa test-wa       - Diagnostik & status sesi WhatsApp"
            echo "  botwa stop          - Hentikan bot WhatsApp"
            echo "  botwa start         - Jalankan bot WhatsApp"
            echo "  botwa logs          - Pantau log real-time"
            echo "  botwa backup        - Backup data sekarang & kirim Telegram"
            echo "  botwa restore       - Pulihkan data dari backup terakhir"
            echo "  botwa telegram      - Ganti Token & Chat ID Telegram"
            echo "  botwa gateway       - Ganti Kredensial Digiflazz / Gateway"
            echo "  botwa reset-wa      - Reset sesi dan pairing ulang WA"
            echo "  botwa update        - Update bot ke commit Git terbaru"
            echo "  botwa clean         - Bersihkan log & backup lama"
            echo "  botwa fix           - Bersihkan proses ganda & fix 409 conflict"
            exit 0 ;;
        *)
            echo -e "${RED}Perintah '$1' tidak dikenal.${NC} Ketik ${BOLD}botwa help${NC} untuk melihat daftar perintah."
            exit 1 ;;
    esac
fi

# MENU INTERAKTIF NOMOR UTAMA
while true; do
    show_header
    echo -e " ${BOLD}[1]${NC}  📊 Status Bot & Sistem (PM2, RAM, Port, Disk)"
    echo -e " ${BOLD}[2]${NC}  🔄 Restart Bot Total (Semua Proses PM2)"
    echo -e " ${BOLD}[3]${NC}  📱 Restart Bot WhatsApp Saja (Reconnect Baileys)"
    echo -e " ${BOLD}[4]${NC}  ✈️ Restart Bot Telegram Saja (Reset Polling)"
    echo -e " ${BOLD}[5]${NC}  ⏹️ Hentikan Bot (Stop)"
    echo -e " ${BOLD}[6]${NC}  ▶️ Jalankan Bot (Start)"
    echo -e " ${BOLD}[7]${NC}  📜 Lihat Log Real-Time (pm2 logs)"
    echo -e "${CYAN}--------------------------------------------------------------------${NC}"
    echo -e " ${BOLD}[8]${NC}  ✈️ Diagnostik & Tes Koneksi Telegram (Kirim Pesan Uji Coba)"
    echo -e " ${BOLD}[9]${NC}  📱 Diagnostik & Cek Sesi WhatsApp"
    echo -e " ${BOLD}[10]${NC} 🛠️ Perbaiki Konflik Bot Telegram (Kill Zombie & Fix 409)"
    echo -e "${CYAN}--------------------------------------------------------------------${NC}"
    echo -e " ${BOLD}[11]${NC} 📦 Backup Data Manual Sekarang (Kirim ke Telegram)"
    echo -e " ${BOLD}[12]${NC} 🔄 Restore Data dari Backup Terakhir"
    echo -e " ${BOLD}[13]${NC} 🔑 Ganti Token Telegram & Chat ID (Jika Bot Disuspend)"
    echo -e " ${BOLD}[14]${NC} 💳 Ganti Akun Gateway (Digiflazz & Paymentkita/Pakasir)"
    echo -e " ${BOLD}[15]${NC} 📱 Reset Sesi & Pairing Ulang WhatsApp"
    echo -e " ${BOLD}[16]${NC} 🚀 Update Bot ke Versi Terbaru (Git Pull + Restart)"
    echo -e " ${BOLD}[17]${NC} 🧹 Bersihkan Cache, Log & File Backup Lama"
    echo -e "${CYAN}--------------------------------------------------------------------${NC}"
    echo -e " ${BOLD}[0]${NC}  ❌ Keluar"
    echo -e "${CYAN}====================================================================${NC}"
    read -p " Masukkan pilihan angka Anda [0-17]: " choice

    case "$choice" in
        1) cmd_status ;;
        2) cmd_restart ;;
        3) cmd_restart_wa ;;
        4) cmd_restart_tg ;;
        5) cmd_stop ;;
        6) cmd_start ;;
        7) cmd_logs ;;
        8) cmd_test_tg ;;
        9) cmd_test_wa ;;
        10) cmd_fix_conflict ;;
        11) cmd_backup ;;
        12) cmd_restore ;;
        13) cmd_change_telegram ;;
        14) cmd_change_gateway ;;
        15) cmd_reset_whatsapp ;;
        16) cmd_update ;;
        17) cmd_clean ;;
        0) echo -e "\nSampai jumpa! 👋\n"; exit 0 ;;
        *) echo -e "\n${RED}❌ Pilihan tidak valid! Masukkan angka 0-17.${NC}"; sleep 1.5 ;;
    esac
done
