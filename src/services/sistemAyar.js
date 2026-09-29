const { query } = require('../config/db');

// ——— Sistem ayarlari (root paneli tanimlar) ———
// IBAN, hesap sahibi gibi tek-deger ayarlar. Bu bilgiler eskiden MDA Hub'dan
// okunuyordu; POS artik hub'a bagli degil.

async function oku(anahtar, varsayilan = null) {
    const r = await query('SELECT deger FROM sistem_ayarlari WHERE anahtar = ?', [anahtar]);
    return r.rows.length && r.rows[0].deger != null ? r.rows[0].deger : varsayilan;
}

async function hepsi(anahtarlar) {
    const out = {};
    for (const a of anahtarlar) out[a] = await oku(a, '');
    return out;
}

async function yaz(anahtar, deger) {
    await query(
        `INSERT INTO sistem_ayarlari (anahtar, deger, guncellendi_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger, guncellendi_at = CURRENT_TIMESTAMP`,
        [anahtar, deger == null ? null : String(deger).slice(0, 500)]);
}

module.exports = { oku, hepsi, yaz };
