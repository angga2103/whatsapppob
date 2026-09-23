/**
 * Mutex Concurrency Lock Library
 * Mencegah race condition, double-spending, dan transaksi ganda serentak.
 */

class Mutex {
    constructor() {
        this.locks = new Map();
    }

    /**
     * Mengunci eksekusi berdasarkan kunci (key) tertentu.
     * @param {string} key - Identifier unik (misal: sender JID atau Order ID)
     * @param {number} timeoutMs - Batas maksimal tunggu sebelum auto-release (default: 15 detik)
     * @returns {Promise<Function>} - Fungsi unlock yang harus dipanggil setelah operasi selesai
     */
    async acquire(key, timeoutMs = 15000) {
        const cleanKey = String(key || 'global');
        const start = Date.now();

        while (this.locks.has(cleanKey)) {
            if (Date.now() - start > timeoutMs) {
                console.warn(`[MUTEX TIMEOUT] Kunci ${cleanKey} kedaluwarsa setelah ${timeoutMs}ms. Melepas paksa.`);
                this.locks.delete(cleanKey);
                break;
            }
            await new Promise(r => setTimeout(r, 50));
        }

        this.locks.set(cleanKey, Date.now());

        let released = false;
        return () => {
            if (!released) {
                released = true;
                this.locks.delete(cleanKey);
            }
        };
    }

    /**
     * Membungkus eksekusi fungsi async di dalam penguncian mutex secara otomatis.
     * @param {string} key - Identifier unik
     * @param {Function} asyncFn - Fungsi async yang akan dijalankan
     * @param {number} timeoutMs - Batas tunggu
     */
    async withLock(key, asyncFn, timeoutMs = 15000) {
        const unlock = await this.acquire(key, timeoutMs);
        try {
            return await asyncFn();
        } finally {
            unlock();
        }
    }
}

const globalMutex = new Mutex();

module.exports = {
    Mutex,
    globalMutex,
    acquire: (key, timeoutMs) => globalMutex.acquire(key, timeoutMs),
    withLock: (key, asyncFn, timeoutMs) => globalMutex.withLock(key, asyncFn, timeoutMs)
};
