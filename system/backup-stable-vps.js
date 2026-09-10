const fs = require('fs');
const { execSync } = require('child_process');

const DATE = new Date()
.toISOString()
.slice(0,10);

const RELEASE_DIR = './stable-release';

try {

    fs.mkdirSync(RELEASE_DIR,{
        recursive:true
    });

    const FILE =
        `${RELEASE_DIR}/STABLE-VPS-${DATE}.zip`;

    execSync(
        `
zip -rq ${FILE} \
database \
handlers \
lib \
session_bot \
system \
config.js \
index.js \
package.json
`,
        { stdio:'inherit' }
    );

    const readme =
`STABLE VPS SNAPSHOT

Tanggal:
${DATE}

Isi:
- Database
- Session WhatsApp
- System Monitoring
- Watchdog
- Heartbeat
- Backup Engine
- Daily Report
- Config
- Source Bot

Node:
${process.version}
`;

    fs.writeFileSync(
        `${RELEASE_DIR}/README-${DATE}.txt`,
        readme
    );

    console.log('✅ Backup VPS Selesai');
    console.log(FILE);

} catch(err){

    console.log(
        '❌ Backup Gagal'
    );

    console.log(err.message);
}
