function normalize(text) {
return text
.toLowerCase()
.replace(/[^a-z0-9 ]/g, ' ')
.replace(/\s+/g, ' ')
.trim();
}

function parseKeyword(q) {

q = normalize(q);

return {

    raw: q,

    harga: (() => {

        const m =
            q.match(/(\d+)\s?(rb|ribu|k)?/);

        if (!m) return null;

        let n = parseInt(m[1]);

        if (m[2]) n *= 1000;

        return n;

    })(),

    hari: (() => {

        const m =
            q.match(/(\d+)\s?(hari|hr)/);

        return m
            ? parseInt(m[1])
            : null;

    })(),

    gb: (() => {

        const m =
            q.match(/(\d+(?:\.\d+)?)\s?gb/);

        return m
            ? parseFloat(m[1])
            : null;

    })(),

    unlimited:
        q.includes('unlimited') ||
        q.includes('unli'),

    murah:
        q.includes('murah'),

    keywords:
        q.split(' ')
};

}

function scoreProduct(product, parsed) {

let score = 0;

const nama =
    normalize(product.nama);

parsed.keywords.forEach(k => {
    if (nama.includes(k))
        score += 10;
});

if (parsed.harga) {

    const diff =
        Math.abs(
            product.hargaJual -
            parsed.harga
        );

    if (diff < 2000)
        score += 50;

    else if (diff < 5000)
        score += 30;

    else if (diff < 10000)
        score += 10;
}

if (parsed.hari) {

    if (
        nama.includes(
            parsed.hari + ' hari'
        )
    ) score += 40;
}

if (parsed.gb) {

    if (
        nama.includes(parsed.gb + ' gb') ||
        nama.includes(parsed.gb + 'gb')
    ) score += 40;
}

if (parsed.unlimited) {

    if (
        nama.includes('unlimited') ||
        nama.includes('unli') ||
        nama.includes('bebas puas')
    ) {
        score += 60;
    }
}

return score;

}

function searchProducts(products, query) {

const parsed =
    parseKeyword(query);

const results =
    products
        .map(p => ({
            ...p,
            score:
                scoreProduct(p, parsed)
        }))
        .filter(p => p.score > 0)
        .sort((a, b) => b.score - a.score);

return results.slice(0, 15);

}

module.exports = {
searchProducts
};
