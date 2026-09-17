#!/usr/bin/env bash
# Installer Bot PPOB & Toko Digital WhatsApp untuk Linux / VPS

echo "==================================================="
echo "    INSTALLER BOT PPOB & TOKO DIGITAL WHATSAPP"
echo "==================================================="
echo ""

# Pastikan Node.js terpasang (Minimal v18 atau v20+)
if ! command -v node &> /dev/null; then
    echo "⚠️ Node.js belum terdeteksi di server ini."
    echo "Memasang Node.js v20 (LTS) secara otomatis..."
    if command -v apt-get &> /dev/null; then
        apt-get update && apt-get install -y curl
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs build-essential
    else
        echo "[ERROR] Sistem paket tidak didukung. Silakan pasang Node.js v18 atau v20+ terlebih dahulu."
        exit 1
    fi
fi

echo "Versi Node.js: $(node -v)"
echo "Versi NPM: $(npm -v)"
echo ""

if [ ! -d "node_modules" ]; then
    echo "Memasang dependensi npm..."
    npm install
fi

echo "Menjalankan wizard instalasi dan pairing WhatsApp..."
node installer.js

