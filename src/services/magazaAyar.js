const crypto = require('crypto');
const { query } = require('../config/db');
const A = require('./sistemAyar');
const H = require('./magazaHesap');

// --- Magaza ayarlari (root paneli > Magaza > Magaza Ayarlari) ---
// sistem_ayarlari tablosunda durur. Varsayilan: magaza KAPALI. Yayina alinan kod, Patron urunleri
// girip magazayi acana kadar isletmelere bos bir sayfa gostermesin.
// Odeme bilgisi (IBAN) lisans odemesiyle ORTAK anahtarlardan okunur: iban, iban_sahibi, banka_adi,
// odeme_aciklama. Bildirim e-postasi da ortak: bildirim_eposta (rootBildirim.js okur).

const ANAHTAR = {
    acik: 'magaza_acik',
    kargoUcret: 'magaza_kargo_ucret_kurus',
    kargoEsik: 'magaza_kargo_esik_kurus',
    kosullar: 'magaza_satis_kosullari',
    otomatikIptalGun: 'magaza_otomatik_iptal_gun',
};
const KOSULLAR_EN_UZUN = 20000;
// Odeme bildirimi yapilmamis siparis bu kadar gun sonra kendiliginden iptal olur (magazaZamanlayici.js); 0 = kapali.
const VARSAYILAN_OTOMATIK_IPTAL_GUN = 7;

// Varsayilan satis kosullari (B2B). Patron panelden degistirebilir; bos kaydedilirse bu metne doner.
const VARSAYILAN_KOSULLAR = [
    'MDA Yazılım Mağaza Satış Koşulları',
    '',
    '1. Kapsam',
    'Bu koşullar, MDA Yazılım (satıcı) ile MDA Restoran POS paneli üzerinden sipariş veren işletme (alıcı) arasındaki ürün satışlarına uygulanır. Alıcı, ürünleri ticari amaçla satın alan işletmedir.',
    '',
    '2. Sipariş ve ödeme',
    'Ürün sayfalarındaki fiyatlar Türk lirası cinsindendir ve KDV dahil gösterilir. Ödeme havale/EFT ile yapılır; ödeme açıklamasına sipariş numarası yazılır. Sipariş, ödemenin satıcı hesabına ulaşıp satıcı tarafından onaylanmasıyla kesinleşir. Ödemesi henüz yapılmamış sipariş, alıcı tarafından panelden iptal edilebilir.',
    '',
    '3. Teslimat',
    'Ürünler, siparişte bildirilen teslimat adresine kargo ile gönderilir. Teslimat süresi ürün kartında belirtilen süredir; stokta bulunan ürünler ödemenin onaylanmasının ardından kargoya verilir. Kargo ücreti sipariş özetinde gösterilir. Kargo firması ve takip numarası sipariş ekranında paylaşılır.',
    '',
    '4. Garanti',
    'Ürünlerde üretici veya distribütör garantisi geçerlidir. Garanti süresi ve kapsamı, ürünün garanti belgesinde belirtildiği gibidir.',
    '',
    '5. Ayıplı ürün',
    'Ayıplı çıkan ürün garanti kapsamında değiştirilir ya da onarılır. Alıcı, teslim sırasında fark ettiği hasarı ve ayıbı gecikmeden satıcıya bildirir.',
    '',
    '6. İade',
    'Açılmamış ve kullanılmamış ürün, teslimden itibaren 14 gün içinde iade edilebilir. İade kargo ücreti alıcıya aittir. Ürün bedeli, iade edilen ürün satıcıya ulaşıp kontrol edildikten sonra alıcının bildirdiği hesaba ödenir.',
    '',
    '7. Fatura',
    'Fatura, siparişte bildirilen fatura bilgileriyle düzenlenir. Bu bilgilerin doğruluğundan alıcı sorumludur.',
    '',
    '8. Kişisel veriler',
    'Siparişte paylaşılan bilgiler yalnız teslimat ve faturalama için kullanılır.',
].join('\n');

const surumOf = (m) => crypto.createHash('sha256').update(String(m), 'utf8').digest('hex').slice(0, 16);

// sistemAyar.yaz degeri 500 karakterde kesiyor (IBAN gibi kisa ayarlar icin). Sozlesme metni uzun:
// ayni tabloya ayni upsert, kendi sinirimizla.
async function uzunYaz(anahtar, deger) {
    await query(
        `INSERT INTO sistem_ayarlari (anahtar, deger, guncellendi_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger, guncellendi_at = CURRENT_TIMESTAMP`,
        [anahtar, deger == null ? null : String(deger).slice(0, KOSULLAR_EN_UZUN)]);
}

async function oku() {
    const acik = (await A.oku(ANAHTAR.acik, '0')) === '1';
    const kargoUcretKurus = Math.max(0, parseInt(await A.oku(ANAHTAR.kargoUcret, '0'), 10) || 0);
    const kargoEsikKurus = Math.max(0, parseInt(await A.oku(ANAHTAR.kargoEsik, '0'), 10) || 0);
    const kayitli = String(await A.oku(ANAHTAR.kosullar, '') || '').trim();
    const kosullarMetni = kayitli || VARSAYILAN_KOSULLAR;
    const gunHam = String(await A.oku(ANAHTAR.otomatikIptalGun, '') || '').trim();
    const gun = gunHam === '' ? VARSAYILAN_OTOMATIK_IPTAL_GUN : parseInt(gunHam, 10);
    return {
        acik, kargoUcretKurus, kargoEsikKurus,
        otomatikIptalGun: Number.isInteger(gun) && gun >= 0 ? gun : VARSAYILAN_OTOMATIK_IPTAL_GUN,
        kosullarMetni, kosullarSurum: surumOf(kosullarMetni), kosullarVarsayilan: !kayitli,
    };
}

const kargoAyari = (a) => ({ ucretKurus: a.kargoUcretKurus, esikKurus: a.kargoEsikKurus });

async function odemeBilgisi() {
    return {
        iban: await A.oku('iban', ''),
        hesapSahibi: await A.oku('iban_sahibi', ''),
        banka: await A.oku('banka_adi', ''),
        aciklama: await A.oku('odeme_aciklama', ''),
    };
}

function hata(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

// Root guncellemesi: yalniz gelen alanlar yazilir. Beyaz liste - govdedeki baska anahtar yazilmaz.
async function guncelle(g = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(g, k);
    const yazilacak = [];
    if (has('acik')) yazilacak.push([ANAHTAR.acik, g.acik ? '1' : '0']);
    if (has('kargoUcret')) {
        const k = g.kargoUcret === '' || g.kargoUcret === null ? 0 : H.tlKurus(g.kargoUcret);
        if (k === null || k < 0 || k > 100000000) throw hata(400, 'Kargo ücreti geçersiz.');
        yazilacak.push([ANAHTAR.kargoUcret, String(k)]);
    }
    if (has('kargoUcretsizEsik')) {
        const k = g.kargoUcretsizEsik === '' || g.kargoUcretsizEsik === null ? 0 : H.tlKurus(g.kargoUcretsizEsik);
        if (k === null || k < 0 || k > 1000000000) throw hata(400, 'Ücretsiz kargo eşiği geçersiz.');
        yazilacak.push([ANAHTAR.kargoEsik, String(k)]);
    }
    if (has('otomatikIptalGun')) {
        const n = g.otomatikIptalGun === '' || g.otomatikIptalGun === null ? 0 : Number(g.otomatikIptalGun);
        if (!Number.isInteger(n) || n < 0 || n > 365) throw hata(400, 'Otomatik iptal süresi 0 ile 365 gün arasında tam sayı olmalı (0 = kapalı).');
        yazilacak.push([ANAHTAR.otomatikIptalGun, String(n)]);
    }
    let kosullar;
    if (has('satisKosullari')) {
        kosullar = String(g.satisKosullari == null ? '' : g.satisKosullari).replace(/\r\n/g, '\n').trim();
        if (kosullar.length > KOSULLAR_EN_UZUN) throw hata(400, 'Satış koşulları metni çok uzun (en fazla 20.000 karakter).');
    }
    let eposta;
    if (has('bildirimEposta')) {
        eposta = String(g.bildirimEposta || '').trim();
        if (eposta && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(eposta)) throw hata(400, 'Bildirim e-postası geçersiz.');
    }
    // Once hepsi denetlendi, sonra yazilir (yarim kayit olmasin)
    for (const [k, v] of yazilacak) await A.yaz(k, v);
    if (kosullar !== undefined) await uzunYaz(ANAHTAR.kosullar, kosullar);   // bos = varsayilan metin
    if (eposta !== undefined) await A.yaz('bildirim_eposta', eposta);
    return oku();
}

module.exports = { ANAHTAR, VARSAYILAN_KOSULLAR, VARSAYILAN_OTOMATIK_IPTAL_GUN, oku, guncelle, kargoAyari, odemeBilgisi, surumOf };
