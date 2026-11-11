const crypto = require('crypto');
const { query } = require('../config/db');

// --- Kisa karekod: https://restoran.mdayazilim.com/q/<KOD> ---
//
// Eski adres /m/<slug>/<qr_token> (~85 karakter) yogun bir karekod uretiyor; plakada kucuk basildiginda
// zor okunuyordu. Kisa adres ~40 karakter: ayni alanda daha iri moduller, daha yuksek hata duzeltme.
//
// Kurallar:
//  - Her masaya 6 karakterlik, SISTEM GENELINDE tekil kod (UNIQUE indeks).
//  - Karisan karakterler yok: 0/O, 1/I/L, 2/Z, 5/S, 8/B cikarildi, G de yok (6 ile karismasin).
//    24 karakter, 6 hane: ~191 milyon kod.
//  - Kod bir kez verilir ve DEGISMEZ: qr_token yenilense de plakadaki adres calismaya devam eder.
//  - Pasif (silinmis) masanin kodu cozulmez (404); masa geri acilirsa ayni kod yine calisir.
//  - Eski /m/<slug>/<qr_token> adresleri sonsuza dek calismaya devam eder (basili karekodlar var).

const ALFABE = 'ACDEFHJKMNPQRTUVWXY34679';
const UZUNLUK = 6;
const DESEN = new RegExp('^[' + ALFABE + ']{' + UZUNLUK + '}$');

function uret() {
    const b = crypto.randomBytes(UZUNLUK);
    let s = '';
    for (let i = 0; i < UZUNLUK; i++) s += ALFABE[b[i] % ALFABE.length];
    return s;
}

// Kullanicidan gelen kodu normalle (kucuk harf, bosluk); gecersizse null
function normalle(kod) {
    const s = String(kod || '').trim().toUpperCase();
    return DESEN.test(s) ? s : null;
}

function kamuAdresi() {
    return (process.env.QR_PUBLIC_BASE || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
}

function kisaAdres(kod) {
    return kamuAdresi() + '/q/' + kod;
}

// Masaya kod ata (yoksa). Cakismada yeniden dener. Zaten varsa onu doner.
async function masayaAta(tableId) {
    for (let i = 0; i < 12; i++) {
        const kod = uret();
        try {
            const r = await query('UPDATE tables SET kisa_kod = ? WHERE id = ? AND kisa_kod IS NULL', [kod, tableId]);
            if (r.changes) return kod;
            const m = await query('SELECT kisa_kod FROM tables WHERE id = ?', [tableId]);
            return m.rows.length ? m.rows[0].kisa_kod : null;
        } catch (e) {
            if (!String(e.message).includes('UNIQUE')) throw e;
        }
    }
    throw new Error('Kısa karekod üretilemedi.');
}

// Kodu olmayan masalara kod ver. tenantId verilirse yalniz o isletme.
async function eksikleriDoldur(tenantId) {
    let toplam = 0;
    for (let tur = 0; tur < 50; tur++) {
        const r = await query(
            tenantId
                ? 'SELECT id FROM tables WHERE kisa_kod IS NULL AND tenant_id = ? LIMIT 200'
                : 'SELECT id FROM tables WHERE kisa_kod IS NULL LIMIT 200',
            tenantId ? [tenantId] : []);
        if (!r.rows.length) break;
        for (const x of r.rows) { await masayaAta(x.id); toplam++; }
    }
    return toplam;
}

// /q/<KOD> cozumu: yalniz AKTIF masa + AKTIF isletme
async function coz(kod) {
    const k = normalle(kod);
    if (!k) return null;
    const r = await query(
        `SELECT te.slug, t.qr_token
           FROM tables t JOIN tenants te ON te.id = t.tenant_id
          WHERE t.kisa_kod = ? AND t.is_active = 1 AND te.is_active = 1`, [k]);
    return r.rows[0] ? { slug: r.rows[0].slug, token: r.rows[0].qr_token } : null;
}

// Kaba kuvvetle kod taramaya karsi IP basina sinir (bellek ici, tek konteyner yeterli).
// 10 dakikada en cok 300 sorgu ve 30 bos (bulunamayan) sorgu.
const sayac = new Map(); // ip -> { bas, toplam, bos }
const PENCERE = 10 * 60 * 1000;
function sinirli(ip) {
    const s = Date.now();
    let k = sayac.get(ip);
    if (!k || s - k.bas > PENCERE) { k = { bas: s, toplam: 0, bos: 0 }; sayac.set(ip, k); }
    if (sayac.size > 20000) sayac.clear();
    return k.toplam >= 300 || k.bos >= 30;
}
function say(ip, bulundu) {
    const k = sayac.get(ip);
    if (!k) return;
    k.toplam++;
    if (!bulundu) k.bos++;
}

module.exports = { ALFABE, UZUNLUK, uret, normalle, kisaAdres, kamuAdresi, masayaAta, eksikleriDoldur, coz, sinirli, say };
