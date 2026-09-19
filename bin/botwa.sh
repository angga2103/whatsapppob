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

# Warna Terminal
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

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

show_header() {
    clear
    echo -e "${CYAN}====================================================================${NC}"
    echo -e "${BOLD}     🤖 BOT PPOB & TOKO DIGITAL WHATSAPP - COMMAND CENTER CLI${NC}"
    echo -e "${CYAN}====================================================================${NC}"
    echo -e " 📁 Direktori : ${BOLD}$APP_DIR${NC}"
    echo -e " ⚡ Status Bot : $(get_pm2_status)"
    echo -e " 🕒 Waktu VPS  : $(date '+%d/%m/%Y %H:%M:%S WIB')"
    echo -e "${CYAN}--------------------------------------------------------------------${NC}"
}

# 1. Status Bot & Sistem
cmd_status() {
    echo -e "\n${BOLD}📊 MEMERIKSA STATUS SISTEM & BOT...${NC}\n"
    local PNAME=$(get_pm2_process_name)
    if command -v pm2 &> /dev/null; then
        pm2 status "$PNAME" 2>/dev/null || pm2 list
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
            const hasSession = fs.existsSync('./session_bot');
            console.log('📱 Sesi WhatsApp :', hasSession ? '🟢 Terdaftar (session_bot)' : '🔴 Belum Terhubung');
            if (fs.existsSync('./system/status.json')) {
                const st = JSON.parse(fs.readFileSync('./system/status.json', 'utf8'));
                console.log('⚡ Status Modus   :', st.mode || 'normal');
            }
        } catch (_) {}
    " 2>/dev/null
    echo ""
    read -p "Tekan [ENTER] untuk kembali ke menu..."
}

# 2. Restart Bot
cmd_restart() {
    local PNAME=$(get_pm2_process_name)
    echo -e "\n${YELLOW}🔄 Merestart proses bot ($PNAME)...${NC}"
    pm2 restart "$PNAME" 2>/dev/null || pm2 restart all 2>/dev/null || pm2 start index.js --name bot-ppob
    pm2 save 2>/dev/null || true
    echo -e "${GREEN}✅ Bot berhasil direstart!${NC}"
    sleep 2
}

# 3. Stop Bot
cmd_stop() {
    local PNAME=$(get_pm2_process_name)
    echo -e "\n${RED}⏹️ Menghentikan proses bot ($PNAME)...${NC}"
    pm2 stop "$PNAME" 2>/dev/null || pm2 stop all 2>/dev/null || true
    echo -e "${GREEN}✅ Bot dihentikan.${NC}"
    sleep 2
}

# 4. Start Bot
cmd_start() {
    local PNAME=$(get_pm2_process_name)
    echo -e "\n${GREEN}▶️ Menjalankan proses bot ($PNAME)...${NC}"
    pm2 start "$PNAME" 2>/dev/null || pm2 start index.js --name bot-ppob
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
    echo -e "\n${GREEN}✅ Proses backup selesai. Silakan cek pesan di bot Telegram Anda!${NC}"
    read -p "Tekan [ENTER] untuk kembali ke menu..."
}

# 7. Restore Data dari Backup Terakhir
cmd_restore() {
    echo -e "\n${YELLOW}🔄 MEMULIHKAN DATA DARI BACKUP TERAKHIR...${NC}"
    local backup_file=$(ls -t AUTO-BACKUP-*.zip 2>/dev/null | head -n 1)
    if [ -z "$backup_file" ]; then
        echo -e "${RED}❌ Tidak ditemukan file AUTO-BACKUP-*.zip di folder $APP_DIR!${NC}"
        read -p "Tekan [ENTER] untuk kembali..."
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
        echo -e "${GREEN}✅ Ekstraksi selesai. Merestart bot...${NC}"
        pm2 restart bot-ppob
        echo -e "${GREEN}✅ Restore berhasil!${NC}"
    else
        echo -e "${YELLOW}Restore dibatalkan.${NC}"
    fi
    read -p "Tekan [ENTER] untuk kembali ke menu..."
}

# 8. Ganti Token Telegram & Chat ID Admin (Solusi jika bot tersuspend Telegram)
cmd_change_telegram() {
    echo -e "\n${CYAN}====================================================================${NC}"
    echo -e "${BOLD}   🔑 GANTI TOKEN BOT TELEGRAM & CHAT ID ADMIN${NC}"
    echo -e "   (Sangat berguna jika bot lama disuspend/banned oleh Telegram)"
    echo -e "${CYAN}====================================================================${NC}\n"

    # Tampilkan token saat ini
    node -e "
        const cfg = require('./config');
        const token = cfg.telegram?.token || '';
        const masked = token.length > 10 ? token.slice(0, 6) + '****' + token.slice(-4) : '(belum ada)';
        console.log('Token Saat Ini   :', masked);
        console.log('Chat ID Saat Ini :', cfg.telegram?.chatId || '(belum ada)');
    "

    echo ""
    echo -e "${YELLOW}Silakan masukkan kredensial Bot Telegram yang baru:${NC}"
    read -p "Masukkan Token Bot Baru (dari @BotFather): " NEW_TOKEN
    read -p "Masukkan Chat ID Admin Baru (dari @userinfobot): " NEW_CHAT_ID

    if [ -z "$NEW_TOKEN" ] || [ -z "$NEW_CHAT_ID" ]; then
        echo -e "${RED}❌ Token dan Chat ID tidak boleh kosong! Batal menyimpan.${NC}"
        read -p "Tekan [ENTER] untuk kembali..."
        return
    fi

    echo -e "\n${CYAN}Menyimpan ke konfigurasi dan .env...${NC}"
    node -e "
        const fs = require('fs');
        const path = require('path');

        const newToken = '$NEW_TOKEN'.trim();
        const newChatId = '$NEW_CHAT_ID'.trim();

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
        console.log('✓ File settings.json, settings.backup.json, dan .env berhasil diperbarui!');
    "

    echo -e "${YELLOW}Menguji koneksi ke Bot Telegram baru...${NC}"
    node -e "
        const axios = require('axios');
        axios.post('https://api.telegram.org/bot$NEW_TOKEN/sendMessage', {
            chat_id: '$NEW_CHAT_ID',
            text: '🚀 *TEST KONEKSI TELEGRAM BERHASIL*\n\nBot PPOB WhatsApp Anda berhasil dihubungkan ke bot Telegram ini melalui CLI Server (botwa)!',
            parse_mode: 'Markdown'
        }).then(() => {
            console.log('✅ Pesan tes berhasil diterima di Telegram!');
        }).catch(err => {
            console.log('⚠️ Gagal kirim tes: ' + err.message);
        });
    "

    echo -e "${GREEN}Merestart bot untuk mengaktifkan Telegram baru...${NC}"
    pm2 restart bot-ppob
    echo -e "${GREEN}✅ Selesai! Bot Telegram baru Anda kini aktif sepenuhnya.${NC}"
    read -p "Tekan [ENTER] untuk kembali ke menu..."
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

    if [ "$gw_opt" == "1" ]; then
        read -p "Masukkan Digiflazz Username : " DIGI_USER
        read -p "Masukkan Digiflazz Key/Secret: " DIGI_KEY
        if [ -n "$DIGI_USER" ] && [ -n "$DIGI_KEY" ]; then
            node -e "
                const fs = require('fs');
                ['./database/settings.json', './database/settings.backup.json'].forEach(f => {
                    let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(_){}
                    s.digiflazz = { username: '$DIGI_USER'.trim(), key: '$DIGI_KEY'.trim() };
                    fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
                });
                console.log('✓ Digiflazz berhasil diperbarui!');
            "
            pm2 restart bot-ppob
            echo -e "${GREEN}✅ Kredensial Digiflazz tersimpan dan bot direstart.${NC}"
        fi
    elif [ "$gw_opt" == "2" ]; then
        read -p "Masukkan Paymentkita Merchant ID: " PK_ID
        read -p "Masukkan Paymentkita Secret Key : " PK_SECRET
        if [ -n "$PK_ID" ] && [ -n "$PK_SECRET" ]; then
            node -e "
                const fs = require('fs');
                ['./database/settings.json', './database/settings.backup.json'].forEach(f => {
                    let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(_){}
                    s.paymentkita = { merchantId: '$PK_ID'.trim(), secret: '$PK_SECRET'.trim() };
                    s.paymentGateway = 'paymentkita';
                    fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
                });
                console.log('✓ Paymentkita berhasil diperbarui!');
            "
            pm2 restart bot-ppob
            echo -e "${GREEN}✅ Kredensial Paymentkita tersimpan dan bot direstart.${NC}"
        fi
    elif [ "$gw_opt" == "3" ]; then
        read -p "Masukkan Pakasir Project Slug: " PAKA_PROJ
        read -p "Masukkan Pakasir API Key     : " PAKA_KEY
        if [ -n "$PAKA_PROJ" ] && [ -n "$PAKA_KEY" ]; then
            node -e "
                const fs = require('fs');
                ['./database/settings.json', './database/settings.backup.json'].forEach(f => {
                    let s = {}; try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(_){}
                    s.pakasir = { project: '$PAKA_PROJ'.trim(), key: '$PAKA_KEY'.trim() };
                    s.paymentGateway = 'pakasir';
                    fs.writeFileSync(f, JSON.stringify(s, null, 2), 'utf8');
                });
                console.log('✓ Pakasir berhasil diperbarui!');
            "
            pm2 restart bot-ppob
            echo -e "${GREEN}✅ Kredensial Pakasir tersimpan dan bot direstart.${NC}"
        fi
    fi
    read -p "Tekan [ENTER] untuk kembali ke menu..."
}

# 10. Reset Sesi & Pairing WhatsApp
cmd_reset_whatsapp() {
    echo -e "\n${RED}====================================================================${NC}"
    echo -e "${BOLD}   📱 RESET SESI & HUBUNGKAN ULANG WHATSAPP${NC}"
    echo -e "${RED}====================================================================${NC}\n"
    read -p "Yakin ingin menghapus sesi WhatsApp saat ini dan login nomor baru? (y/N): " wa_confirm
    if [[ "$wa_confirm" =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Menghentikan bot dan menghapus session_bot/...${NC}"
        pm2 stop bot-ppob 2>/dev/null || true
        rm -rf session_bot/
        echo -e "${GREEN}✓ Sesi WhatsApp lama berhasil dihapus.${NC}"
        echo -e "${CYAN}Menjalankan wizard pairing terminal...${NC}"
        node installer.js
        pm2 restart bot-ppob
    fi
    read -p "Tekan [ENTER] untuk kembali ke menu..."
}

# 11. Update Bot ke Versi Terbaru
cmd_update() {
    echo -e "\n${CYAN}🚀 MEMPERBARUI BOT DARI GITHUB...${NC}"
    git stash 2>/dev/null || true
    git pull origin main
    npm install --no-audit --no-fund
    pm2 restart bot-ppob
    echo -e "\n${GREEN}✅ Pembaruan berhasil diterapkan dan bot telah direstart!${NC}"
    read -p "Tekan [ENTER] untuk kembali ke menu..."
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
    read -p "Tekan [ENTER] untuk kembali ke menu..."
}

# JIKA ADA ARGUMEN BARIS PERINTAH LANGSUNG (Contoh: botwa restart / botwa status / botwa logs)
case "$1" in
    status|stat)
        cmd_status; exit 0 ;;
    restart|reboot)
        cmd_restart; exit 0 ;;
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
    update)
        cmd_update; exit 0 ;;
    clean)
        cmd_clean; exit 0 ;;
esac

# MENU INTERAKTIF NOMOR UTAMA
while true; do
    show_header
    echo -e " ${BOLD}[1]${NC}  📊 Status Bot & Sistem (PM2, RAM, Port, Disk)"
    echo -e " ${BOLD}[2]${NC}  🔄 Restart Bot (pm2 restart bot-ppob)"
    echo -e " ${BOLD}[3]${NC}  ⏹️ Hentikan Bot (Stop)"
    echo -e " ${BOLD}[4]${NC}  ▶️ Jalankan Bot (Start)"
    echo -e " ${BOLD}[5]${NC}  📜 Lihat Log Real-Time (pm2 logs)"
    echo -e "${CYAN}--------------------------------------------------------------------${NC}"
    echo -e " ${BOLD}[6]${NC}  📦 Backup Data Manual Sekarang (Kirim ke Telegram)"
    echo -e " ${BOLD}[7]${NC}  🔄 Restore Data dari Backup Terakhir"
    echo -e "${CYAN}--------------------------------------------------------------------${NC}"
    echo -e " ${BOLD}[8]${NC}  🔑 Ganti Token Telegram & Chat ID (Jika Bot Disuspend)"
    echo -e " ${BOLD}[9]${NC}  💳 Ganti Akun Gateway (Digiflazz & Paymentkita/Pakasir)"
    echo -e " ${BOLD}[10]${NC} 📱 Reset Sesi & Pairing Ulang WhatsApp"
    echo -e " ${BOLD}[11]${NC} 🚀 Update Bot ke Versi Terbaru (Git Pull + Restart)"
    echo -e " ${BOLD}[12]${NC} 🧹 Bersihkan Cache, Log & File Backup Lama"
    echo -e "${CYAN}--------------------------------------------------------------------${NC}"
    echo -e " ${BOLD}[0]${NC}  ❌ Keluar"
    echo -e "${CYAN}====================================================================${NC}"
    read -p " Masukkan pilihan angka Anda [0-12]: " choice

    case "$choice" in
        1) cmd_status ;;
        2) cmd_restart ;;
        3) cmd_stop ;;
        4) cmd_start ;;
        5) cmd_logs ;;
        6) cmd_backup ;;
        7) cmd_restore ;;
        8) cmd_change_telegram ;;
        9) cmd_change_gateway ;;
        10) cmd_reset_whatsapp ;;
        11) cmd_update ;;
        12) cmd_clean ;;
        0) echo -e "\nSampai jumpa! 👋\n"; exit 0 ;;
        *) echo -e "\n${RED}❌ Pilihan tidak valid! Masukkan angka 0-12.${NC}"; sleep 1.5 ;;
    esac
done
