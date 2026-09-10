const fs = require('fs');

function check() {

    const result = {
        session: false,
        database: false,
        heartbeat: false,
        backup: false,
        processing: 0,
        store: 'unknown',
        mode: 'unknown'
    };

    // SESSION
    result.session =
        fs.existsSync('./session_bot');

    try {

        const status =
            require('./status.json');

        if (
            status.mode === 'session_lost'
        ) {
            result.session = false;
        }

        result.mode =
            status.mode || 'unknown';

    } catch {}

    // DATABASE
    result.database =
        fs.existsSync('./database/users.json') &&
        fs.existsSync('./database/orders.json') &&
        fs.existsSync('./database/menu.json');

    // HEARTBEAT
    result.heartbeat =
        fs.existsSync('./system/heartbeat.json');

    // BACKUP
    result.backup =
        fs.existsSync('./backup-full') ||
        fs.existsSync('./backup');

    // ORDERS + STORE
    try {

        const orders = require('../database/orders.json');

        result.processing =
            orders.filter(
                x => x.status === 'processing'
            ).length;

    } catch {}

    try {

        const store =
            require('../database/store.json');

        result.store =
            store.buka ? 'ON' : 'OFF';

    } catch {}

    return result;
}

module.exports = check;

