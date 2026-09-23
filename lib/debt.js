/**
 * Buku Kasbon / Catat Hutang Warung (Debt & Credit Ledger)
 * Membantu pemilik warung mencatat bon pulsa/token pelanggan mereka.
 */

const db = require('../database/db');
const { formatRupiah } = require('./utils');

function getDebtsList() {
    if (!Array.isArray(db.debts)) db.debts = [];
    return db.debts;
}

/**
 * Menambah catatan kasbon baru
 */
function addDebt(ownerJid, debtorName, amount, note = '', debtorPhone = '') {
    const debts = getDebtsList();
    const cleanAmount = parseInt(String(amount).replace(/[^0-9]/g, ''), 10);
    if (isNaN(cleanAmount) || cleanAmount <= 0) {
        return { success: false, message: 'Nominal kasbon tidak valid.' };
    }

    const cleanOwner = String(ownerJid || '').trim();
    const cleanName = String(debtorName || '').trim();
    if (!cleanName) {
        return { success: false, message: 'Nama penghutang / pelanggan wajib diisi.' };
    }

    const debtId = 'BON-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase();
    const newDebt = {
        id: debtId,
        owner: cleanOwner,
        name: cleanName,
        phone: String(debtorPhone || '').replace(/[^0-9]/g, ''),
        amount: cleanAmount,
        note: String(note || 'Pulsa / Token Listrik').trim(),
        status: 'unpaid',
        createdAt: Date.now(),
        paidAt: null
    };

    debts.push(newDebt);
    if (typeof db.saveDebts === 'function') db.saveDebts();
    else if (typeof db.save === 'function') db.save();

    return {
        success: true,
        debt: newDebt
    };
}

/**
 * Mengambil daftar kasbon milik pengguna warung
 */
function getUserDebts(ownerJid, status = 'unpaid') {
    const debts = getDebtsList();
    const cleanOwner = String(ownerJid || '').trim();

    const filtered = debts.filter(d => {
        if (d.owner !== cleanOwner) return false;
        if (status === 'all') return true;
        return d.status === status;
    });

    const totalNominal = filtered.reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0);

    return {
        count: filtered.length,
        totalAmount: totalNominal,
        items: filtered.sort((a, b) => b.createdAt - a.createdAt)
    };
}

/**
 * Menandai kasbon telah lunas
 */
function markDebtPaid(debtId, ownerJid) {
    const debts = getDebtsList();
    const cleanId = String(debtId || '').trim().toUpperCase();
    const cleanOwner = String(ownerJid || '').trim();

    const debt = debts.find(d => d.id.toUpperCase() === cleanId && d.owner === cleanOwner);
    if (!debt) {
        return { success: false, message: 'Data kasbon tidak ditemukan atau bukan milik akun Anda.' };
    }

    if (debt.status === 'paid') {
        return { success: false, message: 'Kasbon ini sudah berstatus lunas sebelumnya.' };
    }

    debt.status = 'paid';
    debt.paidAt = Date.now();

    if (typeof db.saveDebts === 'function') db.saveDebts();
    else if (typeof db.save === 'function') db.save();

    return { success: true, debt };
}

/**
 * Menghapus catatan kasbon
 */
function deleteDebt(debtId, ownerJid) {
    const debts = getDebtsList();
    const cleanId = String(debtId || '').trim().toUpperCase();
    const cleanOwner = String(ownerJid || '').trim();

    const idx = debts.findIndex(d => d.id.toUpperCase() === cleanId && d.owner === cleanOwner);
    if (idx === -1) {
        return { success: false, message: 'Data kasbon tidak ditemukan.' };
    }

    const removed = debts.splice(idx, 1)[0];
    if (typeof db.saveDebts === 'function') db.saveDebts();
    else if (typeof db.save === 'function') db.save();

    return { success: true, debt: removed };
}

/**
 * Menghasilkan teks pengingat ramah untuk dikirimkan ke pelanggan
 */
function generateReminderMessage(debtId, ownerJid, storeName = 'Warung') {
    const debts = getDebtsList();
    const cleanId = String(debtId || '').trim().toUpperCase();
    const cleanOwner = String(ownerJid || '').trim();

    const debt = debts.find(d => d.id.toUpperCase() === cleanId && d.owner === cleanOwner);
    if (!debt) return null;

    const d = new Date(debt.createdAt);
    const dateStr = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

    let t = `Halo Kak *${debt.name}*,\n\n`;
    t += `Semoga sehat dan sukses selalu ya kak. 🙏\n`;
    t += `Mohon izin mengingatkan secara ramah mengenai catatan transaksi kasbon di *${storeName}*:\n\n`;
    t += `• Rincian : *${debt.note}*\n`;
    t += `• Tanggal : ${dateStr}\n`;
    t += `• Nominal : *${formatRupiah(debt.amount)}*\n\n`;
    t += `Jika sudah ada kelonggaran, bisa diselesaikan ya kak. Terima kasih banyak atas kerja sama dan kepercayaannya! 😊`;

    return t;
}

module.exports = {
    addDebt,
    getUserDebts,
    markDebtPaid,
    deleteDebt,
    generateReminderMessage
};
