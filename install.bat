@echo off
title Installer Bot PPOB WhatsApp
cls
echo ===================================================
echo     INSTALLER BOT PPOB & TOKO DIGITAL WHATSAPP
echo ===================================================
echo.
echo Memeriksa dependensi Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js belum terinstall. Silakan download dan install Node.js versi 18 atau 20+ dari https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo Memasang package dependencies...
    npm install
)

echo.
echo Menjalankan wizard konfigurasi dan pairing WhatsApp...
node installer.js
pause
