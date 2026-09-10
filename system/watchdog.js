const fs = require('fs');
const axios = require('axios');
const config = require('../config');

const HEARTBEAT = './system/heartbeat.json';
const STATUS = './system/status.json';
const STATE = './system/watchdog-state.json';

async function send(msg) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${config.telegram.token}/sendMessage`,
            {
                chat_id: config.telegram.chatId,
                text: msg
            }
        );
    } catch (e) {
        console.log('[WATCHDOG]', e.message);
    }
}

function loadState() {
    if (!fs.existsSync(STATE)) {
        return {
            offlineNotified: false
        };
    }

    return JSON.parse(
        fs.readFileSync(STATE)
    );
}

function saveState(data) {
    fs.writeFileSync(
        STATE,
        JSON.stringify(data, null, 2)
    );
}

async function check() {

    if (!fs.existsSync(HEARTBEAT))
        return;

    const hb =
        JSON.parse(
            fs.readFileSync(HEARTBEAT)
        );

    const status =
        fs.existsSync(STATUS)
        ? JSON.parse(fs.readFileSync(STATUS))
        : { mode: 'unknown' };

    const state = loadState();

    const diff =
        Date.now() - hb.lastSeen;

    const offline =
        diff > 120000;

    if (offline && !state.offlineNotified) {

        const menit =
            Math.floor(diff / 60000);

        try {

            fs.writeFileSync(
                STATUS,
                JSON.stringify({
                    mode:'offline',
                    updatedAt:Date.now()
                },null,2)
            );

        } catch(e) {}

        await send(
`🚨 BOT-KASIR OFFLINE

Durasi:
${menit} menit

Status:
offline

Store:
${hb.store}

Tidak ada tindakan otomatis.

Silakan cek kondisi bot.`
        );

        state.offlineNotified = true;

        saveState(state);

        return;
    }

    if (!offline && state.offlineNotified) {

        try {

            fs.writeFileSync(
                STATUS,
                JSON.stringify({
                    mode:'normal',
                    updatedAt:Date.now()
                },null,2)
            );

        } catch(e) {}

        await send(
`🟢 BOT-KASIR ONLINE KEMBALI

Status:
normal

Heartbeat normal kembali.`
        );

        state.offlineNotified = false;

        saveState(state);
    }
}

setInterval(check, 60000);

console.log('[WATCHDOG TELEGRAM] ACTIVE');
