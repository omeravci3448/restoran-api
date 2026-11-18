// --- Is gunu (gun donumu) : raporlarin, panelin, paket servisin ve grup ozetinin TEK gun siniri ---
// Turkiye 2016'dan beri yaz saati uygulamiyor: Istanbul = sabit UTC+3.
// Varsayilan: is gunu Istanbul saatiyle 00:00'dan 00:00'a. Gece yarisindan sonra kapanan isletme Ayarlar'da
// kapanis saatini (tenants.gun_donumu_saat, 0-6) secer; gun o saatte doner. Ornek: 2 -> 20 Ekim is gunu
// 20 Ekim 02:00 ile 21 Ekim 02:00 (Istanbul) arasidir; 21 Ekim 01:30'daki satis 20 Ekim'e yazilir.
// Veritabanindaki zamanlar SQLite CURRENT_TIMESTAMP biciminde UTC metindir ('YYYY-MM-DD HH:MM:SS').

const SAAT_MS = 3600000;
const GUN_MS = 86400000;
const IST_SAAT = 3;
const EN_GEC_SAAT = 6;
const GUN_RE = /^\d{4}-\d{2}-\d{2}$/;
const AY_RE = /^\d{4}-\d{2}$/;

// Kapanis saati: 0-6 tam sayi; gecersiz / bos -> 0
function saatNorm(h) {
    const n = Number(h);
    return Number.isInteger(n) && n >= 0 && n <= EN_GEC_SAAT ? n : 0;
}

// Bir anin (Date / ms / ISO) is gunu: YYYY-MM-DD
function isGunu(an = new Date(), saat = 0) {
    const ms = an instanceof Date ? an.getTime() : (typeof an === 'number' ? an : Date.parse(an));
    return new Date(ms + (IST_SAAT - saatNorm(saat)) * SAAT_MS).toISOString().slice(0, 10);
}

function gecerliGun(g) {
    if (typeof g !== 'string' || !GUN_RE.test(g)) return false;
    const d = new Date(`${g}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === g;
}
function gecerliAy(a) { return typeof a === 'string' && AY_RE.test(a) && gecerliGun(`${a}-01`); }

function gunEkle(gun, n) {
    return new Date(Date.parse(`${gun}T00:00:00Z`) + n * GUN_MS).toISOString().slice(0, 10);
}
const sqlMetni = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// Is gununun basi (dahil), SQLite UTC metni
function gunBasiUtc(gun, saat = 0) {
    return sqlMetni(Date.parse(`${gun}T00:00:00Z`) + (saatNorm(saat) - IST_SAAT) * SAAT_MS);
}
// [bas, bit] is gunleri (ikisi de dahil) -> { basUtc (dahil), bitUtc (haric) }
function aralikUtc(bas, bit = bas, saat = 0) {
    return { basUtc: gunBasiUtc(bas, saat), bitUtc: gunBasiUtc(gunEkle(bit, 1), saat) };
}
// 'YYYY-MM' ayinin is gunleri -> { basUtc, bitUtc }
function ayAraligiUtc(ay, saat = 0) {
    const bas = `${ay}-01`;
    const [y, m] = ay.split('-').map(Number);
    const sonraki = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    return { basUtc: gunBasiUtc(bas, saat), bitUtc: gunBasiUtc(sonraki, saat) };
}
// SQLite date() kaydirmasi: date(zaman, ?) -> o zamanin is gunu. Parametre olarak verilir (SQL'e gomulmez).
function sqlKaydirma(saat = 0) {
    const n = IST_SAAT - saatNorm(saat);
    return `${n >= 0 ? '+' : ''}${n} hours`;
}

// Isletmenin kapanis saati (tenants.gun_donumu_saat). Okunamazsa 0.
async function isletmeSaati(tenantId) {
    try {
        const { query } = require('../config/db');
        const r = await query('SELECT gun_donumu_saat FROM tenants WHERE id = ?', [tenantId]);
        return saatNorm(r.rows[0] && r.rows[0].gun_donumu_saat);
    } catch (_) { return 0; }
}

module.exports = {
    EN_GEC_SAAT, saatNorm, isGunu, gecerliGun, gecerliAy, gunEkle, gunBasiUtc, aralikUtc, ayAraligiUtc, sqlKaydirma, isletmeSaati,
};
