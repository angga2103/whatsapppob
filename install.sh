#!/usr/bin/env bash
# ==============================================================================
# ⚡ ONE-CLICK BOOTSTRAP INSTALLER BOT PPOB & TOKO DIGITAL WHATSAPP
# Otomatis: Install Git, Curl, Node.js 20 LTS, Clone/Update Idempoten, dan Setup
# ==============================================================================

set -e
export DEBIAN_FRONTEND=noninteractive

REPO_URL="https://github.com/angga2103/whatsapppob.git"
TARGET_DIR="/var/www/bot-ppob"

# 0. Pulihkan kunci dpkg/apt jika sebelumnya instalasi terputus paksa
if command -v dpkg &> /dev/null; then
    dpkg --configure -a 2>/dev/null || true
fi

echo ""
echo "=================================================================="
echo "    🚀 ONE-CLICK AUTO INSTALLER BOT PPOB WA & DIGITAL STORE"
echo "=================================================================="
echo ""

# 1. Pastikan curl dan git terpasang di sistem
echo "[1/4] Memeriksa dependensi dasar (git, curl)..."
MISSING_PKGS=""
if ! command -v git &> /dev/null; then
    MISSING_PKGS="$MISSING_PKGS git"
fi
if ! command -v curl &> /dev/null; then
    MISSING_PKGS="$MISSING_PKGS curl"
fi

if [ -n "$MISSING_PKGS" ]; then
    echo "Memasang paket prasyarat:$MISSING_PKGS ..."
    if command -v apt-get &> /dev/null; then
        apt-get update -y
        apt-get install -y $MISSING_PKGS build-essential
    elif command -v yum &> /dev/null; then
        yum install -y $MISSING_PKGS
    fi
fi
echo "✓ Dependensi dasar siap."

# 2. Siapkan direktori kerja & repository secara idempoten (Anti-Error Kasus Terputus di Tengah Jalan)
echo ""
echo "[2/4] Menyiapkan direktori bot..."

# Cek apakah script dijalankan dari dalam direktori source code bot
if [ -f "./index.js" ] && [ -f "./package.json" ]; then
    PROJECT_DIR=$(pwd)
    echo "✓ Menjalankan instalasi dari direktori lokal: $PROJECT_DIR"
else
    PROJECT_DIR="$TARGET_DIR"
    mkdir -p /var/www

    if [ -d "$PROJECT_DIR" ]; then
        if [ -d "$PROJECT_DIR/.git" ]; then
            echo "ℹ️ Folder $PROJECT_DIR sudah ada. Memperbarui ke versi terbaru..."
            cd "$PROJECT_DIR"
            git fetch origin main
            git checkout main 2>/dev/null || true
            git pull origin main || true
        else
            echo "⚠️ Folder $PROJECT_DIR ada namun belum lengkap (terputus saat clone sebelumnya)."
            echo "Mengunduh ulang repository secara bersih..."
            if [ -f "$PROJECT_DIR/.env" ]; then
                cp "$PROJECT_DIR/.env" /tmp/.bot_env_backup 2>/dev/null || true
            fi
            rm -rf "$PROJECT_DIR"
            git clone "$REPO_URL" "$PROJECT_DIR"
            cd "$PROJECT_DIR"
            if [ -f /tmp/.bot_env_backup ]; then
                mv /tmp/.bot_env_backup "$PROJECT_DIR/.env"
                rm -f /tmp/.bot_env_backup
            fi
        fi
    else
        echo "Mengunduh repository ke $PROJECT_DIR..."
        git clone "$REPO_URL" "$PROJECT_DIR"
        cd "$PROJECT_DIR"
    fi
fi

# 3. Pastikan Node.js v18 atau v20+ terpasang
echo ""
echo "[3/4] Memeriksa versi Node.js..."
NODE_NEED_INSTALL=0
if ! command -v node &> /dev/null; then
    NODE_NEED_INSTALL=1
else
    NODE_MAJOR=$(node -v 2>/dev/null | cut -d'.' -f1 | tr -d 'v')
    if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
        echo "⚠️ Node.js terdeteksi versi lama ($(node -v)). Diperlukan minimal Node.js v18 atau v20."
        NODE_NEED_INSTALL=1
    fi
fi

if [ "$NODE_NEED_INSTALL" -eq 1 ]; then
    echo "Memasang Node.js v20 (LTS) resmi via NodeSource..."
    if command -v apt-get &> /dev/null; then
        apt-get update -y
        apt-get install -y curl ca-certificates gnupg
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs build-essential
    elif command -v yum &> /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        yum install -y nodejs
    else
        echo "[ERROR] Sistem paket tidak didukung. Silakan pasang Node.js v20 manual."
        exit 1
    fi
fi

echo "✓ Node.js $(node -v) terpasang."
echo "✓ NPM $(npm -v) terpasang."

# 4. Pasang dependensi NPM
echo ""
echo "[4/4] Memeriksa dependensi NPM..."
if [ ! -d "node_modules" ] || [ ! -f "package-lock.json" ]; then
    echo "Memasang dependensi modul project..."
    npm install --no-audit --no-fund
else
    echo "✓ Dependensi node_modules sudah ada. Memperbarui jika ada perubahan..."
    npm install --no-audit --no-fund
fi

# 5. Pasang pintasan perintah sistem 'botwa' (Bisa dipanggil dari direktori mana saja)
if [ -w /usr/local/bin ] 2>/dev/null; then
    rm -f /usr/local/bin/bot-ppob /usr/bin/bot-ppob 2>/dev/null || true
    ln -sf "$PROJECT_DIR/bin/botwa.sh" /usr/local/bin/botwa 2>/dev/null || true
    ln -sf "$PROJECT_DIR/bin/botwa.sh" /usr/bin/botwa 2>/dev/null || true
    chmod +x "$PROJECT_DIR/bin/botwa.sh" /usr/local/bin/botwa /usr/bin/botwa 2>/dev/null || true
    echo "✓ Pintasan perintah sistem 'botwa' berhasil dipasang."
fi

# 6. Jalankan wizard instalasi Telegram Command Center
echo ""
echo "Menjalankan wizard instalasi bot & Telegram Command Center..."
if [ -e /dev/tty ]; then
    node installer.js < /dev/tty
else
    node installer.js
fi
