const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

function sign(ref){
    return crypto
        .createHash('md5')
        .update(
            config.digiflazz.username +
            config.digiflazz.key +
            ref
        )
        .digest('hex');
}

async function inquiry(code, customerNo, ref){
    try {
        const response = await axios.post(
            'https://api.digiflazz.com/v1/transaction',
            {
                commands:'inq-pasca',
                username:config.digiflazz.username,
                buyer_sku_code:code,
                customer_no:customerNo,
                ref_id:ref,
                sign:sign(ref)
            },
            { timeout: 30000 }
        );
        return response.data;
    } catch (err) {
        console.error('[POSTPAID INQUIRY ERROR]', err.response?.data || err.message);
        return err.response?.data || { data: { status: 'Gagal', message: err.message } };
    }
}

async function pay(code, customerNo, ref){
    try {
        const response = await axios.post(
            'https://api.digiflazz.com/v1/transaction',
            {
                commands:'pay-pasca',
                username:config.digiflazz.username,
                buyer_sku_code:code,
                customer_no:customerNo,
                ref_id:ref,
                sign:sign(ref)
            },
            { timeout: 45000 }
        );
        return response.data;
    } catch (err) {
        console.error('[POSTPAID PAY ERROR]', err.response?.data || err.message);
        return err.response?.data || { data: { status: 'Gagal', message: err.message } };
    }
}

async function status(ref){
    try {
        const response = await axios.post(
            'https://api.digiflazz.com/v1/transaction',
            {
                commands:'status-pasca',
                username:config.digiflazz.username,
                ref_id:ref,
                sign:sign(ref)
            },
            { timeout: 30000 }
        );
        return response.data;
    } catch (err) {
        console.error('[POSTPAID STATUS ERROR]', err.response?.data || err.message);
        return err.response?.data || { data: { status: 'Gagal', message: err.message } };
    }
}

module.exports = {
    inquiry,
    pay,
    status
};
