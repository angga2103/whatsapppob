const formatRupiah = (angka) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(angka);
const getTanggal = () => new Date().toLocaleDateString('id-ID');

const getTanggalLengkap = (timestamp) => {
    const d = new Date(timestamp);
    const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Ags", "Sep", "Okt", "Nov", "Des"];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const detectOperator = (phone) => {
    if (!phone) return 'UNKNOWN';
    let p = phone.replace(/[^0-9]/g, '');
    if (p.startsWith('62')) p = '0' + p.slice(2);
    const prefix = p.substring(0, 4);
    
    const ops = {
        'TELKOMSEL': ['0811', '0812', '0813', '0821', '0822', '0823', '0852', '0853'],
        'BY.U': ['0851'],
        'INDOSAT': ['0814', '0815', '0816', '0855', '0856', '0857', '0858'],
        'XL': ['0817', '0818', '0819', '0859', '0877', '0878'],
        'AXIS': ['0831', '0832', '0833', '0838'],
        'SMARTFREN': ['0881', '0882', '0883', '0884', '0885', '0886', '0887', '0888', '0889'],
        'TRI': ['0895', '0896', '0897', '0898', '0899']
    };
    
    for (let op in ops) { if (ops[op].includes(prefix)) return op; }
    return 'UNKNOWN';
};

const formatPlnToken = (sn) => {
    if (!sn || typeof sn !== 'string') return null;
    const tokenMatch = sn.match(/(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})/);
    if (!tokenMatch) return null;

    const rawTokenDigits = tokenMatch[1].replace(/[^0-9]/g, '');
    if (rawTokenDigits.length !== 20) return null;

    const tokenFormatted = `${rawTokenDigits.slice(0, 4)}-${rawTokenDigits.slice(4, 8)}-${rawTokenDigits.slice(8, 12)}-${rawTokenDigits.slice(12, 16)}-${rawTokenDigits.slice(16, 20)}`;

    let nama = '';
    let tarif = '';
    let kwh = '';

    const parts = sn.split(/[\/,]/).map(p => p.trim());
    for (let p of parts) {
        if (/kwh/i.test(p)) {
            const num = p.replace(/kwh/i, '').replace(/[^0-9.,]/g, '').trim();
            if (num) kwh = `${num} Kwh`;
        } else if (/va/i.test(p) || /r1|r2|r3|b1|b2|i1|i2/i.test(p)) {
            tarif = p;
        } else if (!nama && p !== tokenMatch[1] && !/^\d+$/.test(p) && p.length > 2) {
            nama = p;
        }
    }

    return {
        token: tokenFormatted,
        nama: nama || null,
        tarif: tarif || null,
        kwh: kwh || null,
        raw: sn
    };
};

module.exports = { formatRupiah, getTanggal, getTanggalLengkap, detectOperator, formatPlnToken };
