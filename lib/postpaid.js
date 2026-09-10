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
    const response = await axios.post(
        'https://api.digiflazz.com/v1/transaction',
        {
            commands:'inq-pasca',
            username:config.digiflazz.username,
            buyer_sku_code:code,
            customer_no:customerNo,
            ref_id:ref,
            sign:sign(ref)
        }
    );
    return response.data;
}

async function pay(code, customerNo, ref){
    const response = await axios.post(
        'https://api.digiflazz.com/v1/transaction',
        {
            commands:'pay-pasca',
            username:config.digiflazz.username,
            buyer_sku_code:code,
            customer_no:customerNo,
            ref_id:ref,
            sign:sign(ref)
        }
    );
    return response.data;
}

async function status(ref){
    const response = await axios.post(
        'https://api.digiflazz.com/v1/transaction',
        {
            commands:'status-pasca',
            username:config.digiflazz.username,
            ref_id:ref,
            sign:sign(ref)
        }
    );
    return response.data;
}

module.exports = {
    inquiry,
    pay,
    status
};
