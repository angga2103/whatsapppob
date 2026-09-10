#!/usr/bin/env bash
# Installer Bot PPOB & Toko Digital WhatsApp untuk Linux / VPS

echo "==================================================="
echo "    INSTALLER BOT PPOB & TOKO DIGITAL WHATSAPP"
echo "==================================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js belum terinstall. Silakan pasang Node.js v18 atau v20+ terlebih dahulu."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "Memasang dependensi npm..."
    npm install
fi

echo "Menjalankan wizard instalasi dan pairing WhatsApp..."
node installer.js
