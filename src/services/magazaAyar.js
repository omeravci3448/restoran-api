const crypto = require('crypto');
const { query } = require('../config/db');
const A = require('./sistemAyar');
const H = require('./magazaHesap');

// --- Magaza ayarlari (root paneli > Magaza > Magaza Ayarlari) ---
// sistem_ayarlari tablosunda durur. Varsayilan: magaza KAPALI. Yayina alinan kod, Patron urunleri
// girip magazayi acana kadar isletmelere bos bir sayfa gostermesin.
// Satici bilgileri (unvan, adres, vergi dairesi, VKN, telefon, e-posta) dolmadan magaza ACILAMAZ: alicinin
// sozlesme kurulmadan once saticiyi tam taniyabilmesi gerekir. Bu bilgiler satis kosullarinin BASINA eklenir.
// VKN 10 hane istenir: sahis isletmesinde "vergi kimlik no" alanina cogu zaman TC kimlik no yazilir; vergi
// dairesinin verdigi 10 haneli numara istenerek kisinin TC numarasinin metne girmesi onlenir.
// Odeme bilgisi (IBAN) lisans odemesiyle ORTAK anahtarlardan okunur: iban, iban_sahibi, banka_adi,
// odeme_aciklama. Bildirim e-postasi da ortak: bildirim_eposta (rootBildirim.js okur).

const ANAHTAR = {
    acik: 'magaza_acik',
    kargoUcret: 'magaza_kargo_ucret_kurus',
    kargoEsik: 'magaza_kargo_esik_kurus',
    kosullar: 'magaza_satis_kosullari',
    otomatikIptalGun: 'magaza_otomatik_iptal_gun',
};
// [alan, anahtar, gorunen ad, en uzun]
const SATICI_ALANLARI = [
    ['unvan', 'magaza_satici_unvan', 'unvan', 200],
    ['adres', 'magaza_satici_adres', 'adres', 500],
    ['vergiDairesi', 'magaza_satici_vergi_dairesi', 'vergi dairesi', 80],
    ['vkn', 'magaza_satici_vkn', 'vergi kimlik numarası', 10],
    ['telefon', 'magaza_satici_telefon', 'telefon', 30],
    ['eposta', 'magaza_satici_eposta', 'e-posta', 120],
];
const KOSULLAR_EN_UZUN = 20000;
// Odeme bildirimi yapilmamis siparis bu kadar gun sonra kendiliginden iptal olur (magazaZamanlayici.js); 0 = kapali.
// Sure siparis olusurken siparise yazilir (otomatik_iptal_at); ayar sonradan degisse de mevcut siparise uygulanmaz.
const VARSAYILAN_OTOMATIK_IPTAL_GUN = 7;

// Varsayilan satis kosullari (B2B). Patron panelden degistirebilir; bos kaydedilirse bu metne doner.
// Jetonlar okunurken doldurulur: {{OTOMATIK_IPTAL}} otomatik iptal cumlesi (sure ayardan; 0 ise cumle cikar),
// {{KVKK}} aydinlatma metninin adresi. Satici bilgileri metnin basina ayrica eklenir (jeton gerekmez).
const VARSAYILAN_KOSULLAR = [
    'MDA Yazılım Mağaza Satış Koşulları',
    '',
    '1. Kapsam',
    'Bu koşullar, yukarıda bilgileri yer alan satıcı ile MDA Restoran POS paneli üzerinden sipariş veren işletme (alıcı) arasındaki ürün satışlarına uygulanır. Alıcı, ürünleri ticari ya da mesleki faaliyeti için satın alan işletmedir.',
    '',
    '2. Sipariş ve ödeme',
    'Ürün sayfalarındaki fiyatlar Türk lirası cinsindendir ve KDV dahil gösterilir. Ödeme havale/EFT ile yapılır; ödeme açıklamasına sipariş numarası yazılır. Sipariş, ödemenin satıcı hesabına ulaşıp satıcı tarafından onaylanmasıyla kesinleşir. Ödeme bildirimi yapılmamış sipariş alıcı tarafından panelden iptal edilebilir; ödeme bildirildikten sonra iptal için satıcıyla iletişime geçilir. {{OTOMATIK_IPTAL}}',
    '',
    '3. Siparişin reddi ve fiyat hatası',
    'Satıcı; stok, tedarik ya da ödeme sorunu gibi sebeplerle siparişi gerekçesini bildirerek reddedebilir. Ödemesi alınmış sipariş reddedilirse ödenen tutar 7 iş günü içinde alıcının ödeme yaptığı hesaba iade edilir. Ürün fiyatında açık ve bariz bir hata bulunması durumunda satıcı siparişi iptal etme hakkına sahiptir; ödeme alınmışsa tutar aynı süre içinde iade edilir.',
    '',
    '4. Teslimat',
    'Ürünler, siparişte bildirilen teslimat adresine kargo ile gönderilir. Teslimat süresi ürün kartında belirtilen süredir; stokta bulunan ürünler ödemenin onaylanmasının ardından kargoya verilir. Kargo ücreti sipariş özetinde gösterilir. Kargo firması ve takip numarası sipariş ekranında paylaşılır.',
    'Alıcı, teslim sırasında ambalajı ve ürünü kargo görevlisinin yanında kontrol eder. Ambalajı hasarlı ya da açılmış gönderi için kargo görevlisine hasar tespit tutanağı tutturulur ve durum aynı gün satıcıya bildirilir.',
    '',
    '5. Garanti',
    'Ürünlerde üretici veya distribütör garantisi geçerlidir. Garanti süresi ve kapsamı, ürünün garanti belgesinde belirtildiği gibidir.',
    '',
    '6. Ayıplı ürün',
    'Ayıplı çıkan ürün garanti kapsamında değiştirilir ya da onarılır. Alıcı, teslim sırasında fark ettiği hasarı ve ayıbı gecikmeden satıcıya bildirir.',
    '',
    '7. İade',
    'Açılmamış ve kullanılmamış ürün, teslimden itibaren 14 gün içinde iade edilebilir. İade kargo ücreti alıcıya aittir. Ürün bedeli, iade edilen ürün satıcıya ulaşıp kontrol edildikten sonra alıcının bildirdiği hesaba ödenir.',
    '',
    '8. Fatura',
    'Fatura, siparişte bildirilen fatura bilgileriyle düzenlenir. Bu bilgilerin doğruluğundan alıcı sorumludur.',
    '',
    '9. Kişisel veriler',
    'Siparişte paylaşılan bilgiler yalnız teslimat ve faturalama için kullanılır. Teslimat için alıcı adı, telefonu ve adresi kargo firmasıyla paylaşılır. Ayrıntılı bilgi için aydınlatma metni: {{KVKK}}',
    '',
    '10. Uyuşmazlık',
    'Bu koşullardan doğan uyuşmazlıklarda Afyonkarahisar Mahkemeleri ve İcra Daireleri yetkilidir.',
].join('\n');

const surumOf = (m) => crypto.createHash('sha256').update(String(m), 'utf8').digest('hex').slice(0, 16);
// Yalniz true / 1 / "1" acik sayilir ("false", "0", "evet" gibi degerler KAPALI).
const acikMi = (v) => v === true || v === 1 || v === '1';
const panelAdresi = () => (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');

function saticiBlogu(s) {
    return [
        'Satıcı bilgileri',
        `Unvan: ${s.unvan}`,
        `Adres: ${s.adres}`,
        `Vergi dairesi: ${s.vergiDairesi} / Vergi kimlik no: ${s.vkn}`,
        `Telefon: ${s.telefon} / E-posta: ${s.eposta}`,
    ].join('\n');
}

// Isletmenin gordugu ve onayladigi tam metin: satici bilgileri + govde (jetonlar doldurulmus).
function metniKur({ satici, govde, gun }) {
    const iptal = gun > 0
        ? `Ödeme bildirimi yapılmayan sipariş, oluşturulduğu andan itibaren ${gun} gün içinde ödemesi satıcı hesabına ulaşmazsa kendiliğinden iptal edilir.`
        : '';
    const g = String(govde)
        .replace(/\{\{OTOMATIK_IPTAL\}\}/g, iptal)
        .replace(/\{\{KVKK\}\}/g, panelAdresi() + '/kvkk')
        .replace(/[ \t]+\n/g, '\n').replace(/[ \t]+$/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return saticiBlogu(satici) + '\n\n' + g;
}

// sistemAyar.yaz degeri 500 karakterde kesiyor (IBAN gibi kisa ayarlar icin). Sozlesme metni uzun:
// ayni tabloya ayni upsert, kendi sinirimizla.
async function uzunYaz(anahtar, deger) {
    await query(
        `INSERT INTO sistem_ayarlari (anahtar, deger, guncellendi_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger, guncellendi_at = CURRENT_TIMESTAMP`,
        [anahtar, deger == null ? null : String(deger).slice(0, KOSULLAR_EN_UZUN)]);
}

async function saticiOku() {
    const s = {};
    for (const [alan, anahtar] of SATICI_ALANLARI) s[alan] = String(await A.oku(anahtar, '') || '').trim();
    return s;
}
const saticiEksikleri = (s) => SATICI_ALANLARI.filter(([alan]) => !s[alan]).map(([, , ad]) => ad);

async function oku() {
    const acikAyar = acikMi(await A.oku(ANAHTAR.acik, '0'));
    const satici = await saticiOku();
    const saticiEksik = saticiEksikleri(satici);
    const kargoUcretKurus = Math.max(0, parseInt(await A.oku(ANAHTAR.kargoUcret, '0'), 10) || 0);
    const kargoEsikKurus = Math.max(0, parseInt(await A.oku(ANAHTAR.kargoEsik, '0'), 10) || 0);
    const gunHam = String(await A.oku(ANAHTAR.otomatikIptalGun, '') || '').trim();
    const gunSayi = gunHam === '' ? VARSAYILAN_OTOMATIK_IPTAL_GUN : parseInt(gunHam, 10);
    const otomatikIptalGun = Number.isInteger(gunSayi) && gunSayi >= 0 ? gunSayi : VARSAYILAN_OTOMATIK_IPTAL_GUN;
    const kayitli = String(await A.oku(ANAHTAR.kosullar, '') || '').trim();
    const kosullarHam = kayitli || VARSAYILAN_KOSULLAR;
    const kosullarMetni = metniKur({ satici, govde: kosullarHam, gun: otomatikIptalGun });
    return {
        // Satici bilgileri eksikse magaza isletmelere KAPALI gorunur (ayar acik isaretli olsa bile)
        acik: acikAyar && saticiEksik.length === 0,
        acikAyar, satici, saticiEksik,
        kargoUcretKurus, kargoEsikKurus, otomatikIptalGun,
        kosullarHam, kosullarMetni, kosullarSurum: surumOf(kosullarMetni), kosullarVarsayilan: !kayitli,
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

function hata(status, message, code, ek) {
    const e = new Error(message); e.status = status; if (code) e.code = code; if (ek) e.ek = ek; return e;
}

// Root guncellemesi: yalniz gelen alanlar yazilir. Beyaz liste - govdedeki baska anahtar yazilmaz.
async function guncelle(g = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(g, k);
    const yazilacak = [];
    if (has('acik')) yazilacak.push([ANAHTAR.acik, acikMi(g.acik) ? '1' : '0']);
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
    // Satici bilgileri
    const saticiGelen = {};
    if (g.satici !== undefined && (g.satici === null || typeof g.satici !== 'object' || Array.isArray(g.satici))) {
        throw hata(400, 'Satıcı bilgileri geçersiz.');
    }
    for (const [alan, anahtar, ad, enUzun] of SATICI_ALANLARI) {
        if (!g.satici || !Object.prototype.hasOwnProperty.call(g.satici, alan)) continue;
        let v = alan === 'vkn' ? H.rakamlar(g.satici[alan]) : H.metin(g.satici[alan], enUzun);
        if (alan === 'vkn' && v) {
            if (!H.vknGecerli(v)) {
                throw hata(400, 'Satıcı vergi kimlik numarası 10 haneli olmalı (şahıs işletmesinde vergi dairesinin verdiği 10 haneli numara; TC kimlik numarası değil).');
            }
        }
        if (alan === 'eposta' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw hata(400, 'Satıcı e-postası geçersiz.');
        if (alan === 'telefon' && v && !H.telefonGecerli(v)) throw hata(400, 'Satıcı telefonu geçersiz.');
        if (v && (alan === 'unvan' || alan === 'vergiDairesi') && v.length < 2) throw hata(400, `Satıcı ${ad} çok kısa.`);
        if (v && alan === 'adres' && v.length < 10) throw hata(400, 'Satıcı adresini açık olarak yazın.');
        saticiGelen[alan] = v;
        yazilacak.push([anahtar, v]);
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
    // Kayit sonrasi durum magaza ACIK ise satici bilgileri tam olmali (kayit hic yapilmaz)
    const sonAcik = has('acik') ? acikMi(g.acik) : acikMi(await A.oku(ANAHTAR.acik, '0'));
    if (sonAcik) {
        const eksik = saticiEksikleri({ ...(await saticiOku()), ...saticiGelen });
        if (eksik.length) {
            throw hata(409, `Mağazayı açmak için önce satıcı bilgilerini doldurun. Eksik: ${eksik.join(', ')}.`, 'SATICI_BILGISI_EKSIK', { eksik });
        }
    }
    // Once hepsi denetlendi, sonra yazilir (yarim kayit olmasin)
    for (const [k, v] of yazilacak) await A.yaz(k, v);
    if (kosullar !== undefined) await uzunYaz(ANAHTAR.kosullar, kosullar);   // bos = varsayilan metin
    if (eposta !== undefined) await A.yaz('bildirim_eposta', eposta);
    return oku();
}

module.exports = {
    ANAHTAR, SATICI_ALANLARI, VARSAYILAN_KOSULLAR, VARSAYILAN_OTOMATIK_IPTAL_GUN,
    oku, guncelle, kargoAyari, odemeBilgisi, surumOf, acikMi, metniKur,
};
