/**
 * Receipt Generator Library (Struk Kasir Thermal 58mm & 80mm + HTML Web Receipt)
 * Mendukung kustomisasi Nama Warung dan Kustom Harga Struk untuk Reseller/Warung
 */

const PDFDocument = require('pdfkit');
const { formatRupiah } = require('./utils');

/**
 * Format string agar pas di lebar tertentu (center alignment)
 */
function padCenter(str, width = 32) {
    const s = String(str || '').trim();
    if (s.length >= width) return s.slice(0, width);
    const leftPad = Math.floor((width - s.length) / 2);
    const rightPad = width - s.length - leftPad;
    return ' '.repeat(leftPad) + s + ' '.repeat(rightPad);
}

/**
 * Format baris key-value (kiri rata kiri, kanan rata kanan)
 */
function padRow(left, right, width = 32) {
    const l = String(left || '');
    const r = String(right || '');
    const totalLen = l.length + r.length;
    if (totalLen >= width) {
        return `${l}\n${' '.repeat(Math.max(0, width - r.length))}${r}`;
    }
    const spaces = width - totalLen;
    return l + ' '.repeat(spaces) + r;
}

/**
 * Membuat teks struk monospace yang siap cetak di Printer Bluetooth Thermal 58mm (32 kolom)
 * @param {Object} order - Objek transaksi
 * @param {Object} warungProfile - Kustomisasi warung (storeName, footer, customPrice)
 * @param {number} width - Lebar kolom printer (default: 32 untuk 58mm)
 */
function generateTextReceipt(order, warungProfile = {}, width = 32) {
    if (!order) return '';

    const storeName = warungProfile.storeName || order.storeName || 'LOKET PEMBAYARAN PPOB';
    const footerMsg = warungProfile.footer || 'Terima kasih atas kunjungan Anda';
    const finalPrice = Number(warungProfile.customPrice || order.customPrice || order.baseAmount || order.total || 0);

    const d = order.timestamp || order.doneAt ? new Date(Number(order.timestamp || order.doneAt)) : new Date();
    const dateStr = d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB';

    const inv = order.id || order.oid || order.ref_id || '-';
    const item = order.item || order.sku || 'Produk Digital';
    const target = order.target || '-';
    const sn = order.sn || order.rawSn || order.token || '-';

    const doubleLine = '='.repeat(width);
    const singleLine = '-'.repeat(width);

    let lines = [];
    lines.push(doubleLine);
    lines.push(padCenter(storeName.toUpperCase(), width));
    lines.push(padCenter('STRUK BUKTI PEMBAYARAN', width));
    lines.push(doubleLine);

    lines.push(padRow('Tanggal :', dateStr, width));
    lines.push(padRow('Waktu   :', timeStr, width));
    lines.push(padRow('No. Reff:', inv, width));
    lines.push(singleLine);

    lines.push(padRow('Produk  :', item, width));
    lines.push(padRow('ID/No.  :', target, width));

    if (sn && sn !== '-') {
        // Jika token PLN, pisahkan agar mudah dibaca
        if (/^\d{20}$/.test(sn.replace(/\s+/g, ''))) {
            const cleanToken = sn.replace(/\s+/g, '');
            const formattedToken = cleanToken.match(/.{1,4}/g).join('-');
            lines.push(singleLine);
            lines.push(padCenter('TOKEN LISTRIK PLN', width));
            lines.push(padCenter(formattedToken, width));
            lines.push(singleLine);
        } else {
            lines.push(padRow('SN/Ket  :', sn, width));
        }
    }

    lines.push(singleLine);
    lines.push(padRow('Status  :', 'LUNAS / BERHASIL', width));
    lines.push(padRow('Total   :', formatRupiah(finalPrice), width));
    lines.push(doubleLine);
    lines.push(padCenter(footerMsg, width));
    lines.push(padCenter('Simpan struk ini sebagai bukti sah', width));
    lines.push(doubleLine);

    return lines.join('\n');
}

/**
 * Menghasilkan HTML Web Struk yang siap ditampilkan di browser dan dicetak (window.print())
 */
function generateHtmlReceipt(order, warungProfile = {}) {
    if (!order) return '<h1>Data transaksi tidak ditemukan.</h1>';

    const storeName = warungProfile.storeName || order.storeName || 'LOKET PEMBAYARAN PPOB';
    const footerMsg = warungProfile.footer || 'Terima kasih atas kunjungan Anda';
    const finalPrice = Number(warungProfile.customPrice || order.customPrice || order.baseAmount || order.total || 0);

    const d = order.timestamp || order.doneAt ? new Date(Number(order.timestamp || order.doneAt)) : new Date();
    const dateStr = d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const timeStr = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB';

    const inv = order.id || order.oid || order.ref_id || '-';
    const item = order.item || order.sku || 'Produk Digital / PPOB';
    const target = order.target || '-';
    const sn = order.sn || order.rawSn || order.token || '-';

    let tokenBlock = '';
    if (sn && sn !== '-') {
        if (/^\d{20}$/.test(sn.replace(/\s+/g, ''))) {
            const cleanToken = sn.replace(/\s+/g, '');
            const formattedToken = cleanToken.match(/.{1,4}/g).join(' - ');
            tokenBlock = `
            <div class="token-box">
                <div class="token-title">⚡ STROOM / TOKEN PLN ⚡</div>
                <div class="token-value">${formattedToken}</div>
                <small>Masukkan 20 digit angka di atas ke meteran PLN Anda</small>
            </div>`;
        } else {
            tokenBlock = `
            <div class="row">
                <span class="label">SN / Referensi:</span>
                <span class="value sn-val">${sn}</span>
            </div>`;
        }
    }

    return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Struk Pembayaran - ${inv}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Courier New', Courier, monospace;
            background-color: #f1f5f9;
            color: #1e293b;
            padding: 20px 10px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        .receipt-card {
            background: #ffffff;
            width: 100%;
            max-width: 380px;
            padding: 24px 20px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.08);
            border-radius: 8px;
            border-top: 4px dashed #94a3b8;
            border-bottom: 4px dashed #94a3b8;
        }
        .header { text-align: center; margin-bottom: 16px; }
        .store-name { font-size: 20px; font-weight: bold; margin-bottom: 4px; }
        .receipt-title { font-size: 13px; color: #475569; text-transform: uppercase; letter-spacing: 1px; }
        .divider { border-top: 1px dashed #cbd5e1; margin: 12px 0; }
        .divider-double { border-top: 2px dashed #64748b; margin: 14px 0; }
        .row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 8px; }
        .label { color: #64748b; }
        .value { font-weight: bold; text-align: right; max-width: 60%; word-break: break-word; }
        .total-row { display: flex; justify-content: space-between; font-size: 16px; font-weight: bold; color: #0f172a; margin: 10px 0; }
        .status-badge {
            background-color: #dcfce7;
            color: #15803d;
            font-weight: bold;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 12px;
            display: inline-block;
        }
        .token-box {
            background-color: #f8fafc;
            border: 1px dashed #0284c7;
            border-radius: 6px;
            padding: 12px;
            text-align: center;
            margin: 12px 0;
        }
        .token-title { font-size: 12px; font-weight: bold; color: #0284c7; margin-bottom: 6px; }
        .token-value { font-size: 17px; font-weight: bold; letter-spacing: 1px; color: #0f172a; margin-bottom: 4px; }
        .footer { text-align: center; font-size: 11px; color: #64748b; margin-top: 16px; line-height: 1.5; }
        .actions { margin-top: 20px; display: flex; gap: 10px; width: 100%; max-width: 380px; }
        .btn {
            flex: 1;
            padding: 12px;
            border-radius: 6px;
            border: none;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            text-align: center;
            text-decoration: none;
        }
        .btn-print { background-color: #2563eb; color: #ffffff; }
        .btn-print:hover { background-color: #1d4ed8; }

        @media print {
            body { background: transparent; padding: 0; }
            .receipt-card { box-shadow: none; border-radius: 0; border: none; max-width: 100%; width: 100%; padding: 0; }
            .actions { display: none; }
        }
    </style>
</head>
<body>
    <div class="receipt-card">
        <div class="header">
            <div class="store-name">${escapeHtml(storeName)}</div>
            <div class="receipt-title">STRUK BUKTI PEMBAYARAN</div>
        </div>
        
        <div class="divider"></div>
        <div class="row"><span class="label">Tanggal:</span><span class="value">${dateStr}</span></div>
        <div class="row"><span class="label">Waktu:</span><span class="value">${timeStr}</span></div>
        <div class="row"><span class="label">No. Invoice:</span><span class="value">${escapeHtml(inv)}</span></div>
        
        <div class="divider"></div>
        <div class="row"><span class="label">Produk / Item:</span><span class="value">${escapeHtml(item)}</span></div>
        <div class="row"><span class="label">No. Tujuan / ID:</span><span class="value">${escapeHtml(target)}</span></div>
        <div class="row"><span class="label">Status:</span><span class="status-badge">LUNAS</span></div>
        
        ${tokenBlock}
        
        <div class="divider-double"></div>
        <div class="total-row">
            <span>TOTAL BAYAR</span>
            <span>${formatRupiah(finalPrice)}</span>
        </div>
        <div class="divider-double"></div>
        
        <div class="footer">
            <div>${escapeHtml(footerMsg)}</div>
            <div>Struk ini merupakan bukti pembayaran yang sah dan resmi.</div>
        </div>
    </div>

    <div class="actions">
        <button class="btn btn-print" onclick="window.print()">🖨️ Cetak Struk</button>
        <a href="?pdf=1" class="btn btn-print" style="text-decoration:none; display:inline-block; margin-left: 8px;">📥 Unduh PDF</a>
    </div>
</body>
</html>`;
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Membuat buffer dokumen PDF Struk Kasir Thermal (80mm) yang siap dikirim langsung via WhatsApp
 * @param {Object} order - Objek transaksi
 * @param {Object} warungProfile - Kustomisasi warung (storeName, footer, customPrice)
 * @returns {Promise<Buffer>}
 */
function generatePdfReceiptBuffer(order, warungProfile = {}) {
    return new Promise((resolve, reject) => {
        try {
            if (!order) return reject(new Error('Data transaksi tidak ditemukan.'));

            const storeName = warungProfile.storeName || order.storeName || 'LOKET PEMBAYARAN PPOB';
            const footerMsg = warungProfile.footer || 'Terima kasih atas kunjungan Anda';
            const finalPrice = Number(warungProfile.customPrice || order.customPrice || order.baseAmount || order.total || 0);

            const d = order.timestamp || order.doneAt ? new Date(Number(order.timestamp || order.doneAt)) : new Date();
            const dateStr = d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const timeStr = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB';

            const inv = order.id || order.oid || order.ref_id || '-';
            const item = order.item || order.sku || 'Produk Digital / PPOB';
            const target = order.target || '-';
            const sn = order.sn || order.rawSn || order.token || '-';

            // Hitung tinggi kertas secara dinamis agar pas tanpa sisa putih berlebih
            let estimatedHeight = 350;
            if (sn && sn !== '-') {
                if (/^\d{20}$/.test(sn.replace(/\s+/g, ''))) estimatedHeight += 55;
                else estimatedHeight += 25;
            }

            const doc = new PDFDocument({
                size: [226.77, estimatedHeight], // Standar kertas thermal 80mm
                margins: { top: 14, bottom: 14, left: 14, right: 14 }
            });

            const buffers = [];
            doc.on('data', chunk => buffers.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', err => reject(err));

            const contentWidth = 226.77 - 28;

            // 1. HEADER TOKO
            doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text(storeName.toUpperCase(), { align: 'center', width: contentWidth });
            doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text('STRUK BUKTI PEMBAYARAN RESMI', { align: 'center', width: contentWidth });
            doc.moveDown(0.4);

            // Garis putus-putus pembatas
            const drawDashedLine = (y) => {
                doc.save();
                doc.strokeColor('#94a3b8').lineWidth(0.8).dash(3, { space: 2 });
                doc.moveTo(14, y).lineTo(226.77 - 14, y).stroke();
                doc.restore();
            };

            let curY = doc.y + 2;
            drawDashedLine(curY);
            doc.y = curY + 6;

            // Helper baris key-value
            const drawRow = (label, val, isBold = false) => {
                const rowY = doc.y;
                doc.font('Helvetica').fontSize(8).fillColor('#475569').text(label, 14, rowY, { width: 70 });
                doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#0f172a').text(val, 84, rowY, { align: 'right', width: contentWidth - 70 });
                doc.moveDown(0.3);
            };

            // 2. RINCIAN WAKTU & REFF
            drawRow('Tanggal', dateStr);
            drawRow('Waktu', timeStr);
            drawRow('No. Reff', inv, true);

            curY = doc.y + 2;
            drawDashedLine(curY);
            doc.y = curY + 6;

            // 3. RINCIAN PRODUK & TUJUAN
            drawRow('Produk', item, true);
            drawRow('No. Tujuan', target);

            // 4. JIKA TOKEN LISTRIK / SN
            if (sn && sn !== '-') {
                if (/^\d{20}$/.test(sn.replace(/\s+/g, ''))) {
                    const cleanToken = sn.replace(/\s+/g, '');
                    const formattedToken = cleanToken.match(/.{1,4}/g).join('-');
                    doc.moveDown(0.3);
                    const boxY = doc.y;
                    
                    // Kotak Token PLN
                    doc.save();
                    doc.roundedRect(14, boxY, contentWidth, 38, 4).fillAndStroke('#f8fafc', '#0284c7');
                    doc.restore();

                    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#0284c7').text('⚡ STROOM / TOKEN PLN ⚡', 14, boxY + 4, { align: 'center', width: contentWidth });
                    doc.font('Courier-Bold').fontSize(11).fillColor('#0f172a').text(formattedToken, 14, boxY + 16, { align: 'center', width: contentWidth });
                    doc.font('Helvetica').fontSize(6).fillColor('#64748b').text('Masukkan 20 digit angka di atas ke meteran PLN', 14, boxY + 28, { align: 'center', width: contentWidth });
                    doc.y = boxY + 42;
                } else {
                    drawRow('SN / Ket', sn);
                }
            }

            curY = doc.y + 2;
            drawDashedLine(curY);
            doc.y = curY + 6;

            // 5. STATUS & TOTAL
            drawRow('Status', 'LUNAS / BERHASIL', true);
            doc.moveDown(0.2);

            const totalY = doc.y;
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a').text('TOTAL BAYAR', 14, totalY);
            doc.font('Helvetica-Bold').fontSize(11).fillColor('#15803d').text(formatRupiah(finalPrice), 14, totalY, { align: 'right', width: contentWidth });
            doc.y = totalY + 16;

            curY = doc.y + 2;
            drawDashedLine(curY);
            doc.y = curY + 6;

            // 6. FOOTER
            doc.font('Helvetica').fontSize(7).fillColor('#64748b').text(footerMsg, { align: 'center', width: contentWidth });
            doc.font('Helvetica').fontSize(6.5).fillColor('#94a3b8').text('Simpan struk ini sebagai bukti pembayaran sah', { align: 'center', width: contentWidth });

            doc.end();
        } catch (e) {
            reject(e);
        }
    });
}

module.exports = {
    generateTextReceipt,
    generateHtmlReceipt,
    generatePdfReceiptBuffer
};
