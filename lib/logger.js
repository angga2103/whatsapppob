const fs = require('fs');

function addLog(text, file = 'admin.log') {

    if (!fs.existsSync('./logs')) {
        fs.mkdirSync('./logs');
    }

    const time = new Date().toLocaleString('id-ID');

    const finalText =
`[${time}]
${text}

`;

    fs.appendFileSync('./logs/' + file, finalText);
}

module.exports = {
    addLog
};
