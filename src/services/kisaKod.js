const crypto = require('crypto');
const { query } = require('../config/db');

// --- Kisa karekod: https://restoran.mdayazilim.com/q/<KOD> ---
//
// Eski adres /m/<slug>/<qr_token> (~85 karakter) yogun bir karekod uretiyor; plakada kucuk basildiginda
// zor okunuyordu. Kisa adres ~44 karakter: ayni alanda daha iri moduller, daha yuksek hata duzeltme.
//
// Kurallar:
//  - Her masaya 8 karakterlik, SISTEM GENELINDE tekil kod (UNIQUE indeks). 8 hane (inceleme O2): tahmin edilmesi
//    pratikte imkansiz (24^8 ~ 110 milyar), henuz basili plaka olmadigi icin degisim bedava.
//  - Karisan karakterler yok: 0/O, 1/I/L, 2/Z, 5/S, 8/B cikarildi, G de yok (6 ile karismasin).
//  - Kod kendiliginden DEGISMEZ: qr_token yenilense de plakadaki adres calisir. Yalniz isletme yoneticisi
//    (yonetici sifresiyle) ya da root "Kisa kodu yenile" der; o zaman basili plakanin karekodu calismaz.
//  - Pasif (silinmis) masanin kodu cozulmez (404); masa geri acilirsa ayni kod yine calisir.
//  - Eski /m/<slug>/<qr_token> adresleri sonsuza dek calismaya devam eder (basili karekodlar var).

const ALFABE = 'ACDEFHJKMNPQRTUVWXY34679';
const UZUNLUK = 8;
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

// Masaya yeni kod yaz. yalnizBossa: kodu olmayan masaya (yoksa verir, varsa onu doner); degilse ZORLA yeniler.
// Cakismada yeniden dener.
async function kodYaz(tableId, yalnizBossa) {
    for (let i = 0; i < 12; i++) {
        const kod = uret();
        try {
            const r = await query(
                yalnizBossa ? 'UPDATE tables SET kisa_kod = ? WHERE id = ? AND kisa_kod IS NULL' : 'UPDATE tables SET kisa_kod = ? WHERE id = ?',
                [kod, tableId]);
            if (r.changes) return kod;
            const m = await query('SELECT kisa_kod FROM tables WHERE id = ?', [tableId]);
            return m.rows.length ? m.rows[0].kisa_kod : null;
        } catch (e) {
            if (!String(e.message).includes('UNIQUE')) throw e;
        }
    }
    throw new Error('Kısa karekod üretilemedi.');
}

// Masaya kod ata (yoksa). Zaten varsa onu doner.
const masayaAta = (tableId) => kodYaz(tableId, true);
// "Kisa kodu yenile": eski kod artik cozulmez, basili plakanin karekodu calismaz
const yenile = (tableId) => kodYaz(tableId, false);

// Kodu olmayan (ya da eski bicimde kalmis) masalara kod ver. tenantId verilirse yalniz o isletme.
// Eski bicim: 8 haneye gecmeden once (yalniz gelistirme veritabanlarinda) verilmis kodlar; canlida kisa kod
// ilk kez 8 haneyle veriliyor.
async function eksikleriDoldur(tenantId) {
    await query(
        tenantId
            ? 'UPDATE tables SET kisa_kod = NULL WHERE kisa_kod IS NOT NULL AND LENGTH(kisa_kod) <> ? AND tenant_id = ?'
            : 'UPDATE tables SET kisa_kod = NULL WHERE kisa_kod IS NOT NULL AND LENGTH(kisa_kod) <> ?',
        tenantId ? [UZUNLUK, tenantId] : [UZUNLUK]);
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

// /q/<KOD> cozumu. Doner: { durum: 'gecersiz' | 'yok' | 'pasif' | 'aktif', slug?, token? }
//   gecersiz: bicim tutmuyor; yok: boyle bir kod yok; pasif: kod var ama masa ya da isletme kapali (silinmis
//   masanin plakasi); aktif: menuye yonlendirilir.
async function coz(kod) {
    const k = normalle(kod);
    if (!k) return { durum: 'gecersiz' };
    const r = await query(
        `SELECT te.slug, t.qr_token, t.is_active AS masa_aktif, te.is_active AS isletme_aktif
           FROM tables t JOIN tenants te ON te.id = t.tenant_id
          WHERE t.kisa_kod = ?`, [k]);
    const x = r.rows[0];
    if (!x) return { durum: 'yok' };
    if (Number(x.masa_aktif) !== 1 || Number(x.isletme_aktif) !== 1) return { durum: 'pasif' };
    return { durum: 'aktif', slug: x.slug, token: x.qr_token };
}

// --- Kaba kuvvetle kod taramaya karsi sinir (inceleme O1) ---
// Yalniz BOS denemeler sayilir (bicimi tutmayan ya da var olmayan kod): gecerli kodlar ve silinmis masanin
// plakasi bos sayilmaz. 10 dakikada en cok 30 bos deneme; sinir asilinca o anahtar (gecerli kod dahil) durur,
// yoksa 429 ile 200 arasindaki fark tarama icin ipucu olurdu.
// Ayni anda gelen isteklerin siniri asmamasi icin bekleme (veritabani sorgusu) ONCESINDE "suren istek" sayaci
// artar: anahtar basina en cok 50 eszamanli sorgu. Boylece bos deneme tavani 30 + 50; gecerli okutmalar
// yalniz bu cok yuksek eszamanlilik sinirina tabi (ayni restoran agindan art arda okutmalar etkilenmez).
// Anahtar: IPv4 adresi; IPv6'da /64 on eki (tek abonenin butun adresleri ayni anahtar). Bellek ici.
const sayac = new Map(); // anahtar -> { bas, bos, suren }
const PENCERE = 10 * 60 * 1000;
const BOS_SINIRI = 30;
const ESZAMANLI_SINIR = 50;

function ipAnahtari(ip) {
    let s = String(ip || '?').trim();
    const v4 = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (v4) return v4[1];
    if (!s.includes(':')) return s;
    s = s.split('%')[0].toLowerCase();
    const [bas, son] = s.split('::');
    const a = bas ? bas.split(':') : [];
    const b = son !== undefined && son !== '' ? son.split(':') : [];
    const gruplar = son !== undefined ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
    return gruplar.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

function kayit(anahtar) {
    const s = Date.now();
    let k = sayac.get(anahtar);
    if (!k || s - k.bas > PENCERE) { k = { bas: s, bos: 0, suren: k ? k.suren : 0 }; sayac.set(anahtar, k); }
    if (sayac.size > 20000) {
        for (const [a, v] of sayac) if (s - v.bas > PENCERE && !v.suren) sayac.delete(a);
        if (sayac.size > 20000) sayac.clear();
    }
    return k;
}

// Istek basinda (bekleme ONCESI): sinir asildiysa null. Asilmadiysa "suren" sayaci artar ve bitirme islevi doner;
// bitir(bulundu): suren azalir, kod bulunamadiysa bos deneme sayilir.
function denemeBaslat(ip) {
    const k = kayit(ipAnahtari(ip));
    if (k.bos >= BOS_SINIRI || k.suren >= ESZAMANLI_SINIR) return null;
    k.suren++;
    let bitti = false;
    return (bulundu) => {
        if (bitti) return;
        bitti = true;
        k.suren = Math.max(0, k.suren - 1);
        if (!bulundu) k.bos++;
    };
}

module.exports = {
    ALFABE, UZUNLUK, uret, normalle, kisaAdres, kamuAdresi, masayaAta, yenile, eksikleriDoldur, coz,
    ipAnahtari, denemeBaslat, BOS_SINIRI, ESZAMANLI_SINIR,
};
