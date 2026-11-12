// ——— Lisans durum makinesi ———
// Patron karari (2026-09-23): lisans bitince kasa ANINDA kapanmaz.
//   1) Bitise kadar        -> AKTIF
//   2) Bitisten sonra 3 gun -> SALT_OKUNUR (veri gorulur, satis yapilamaz)
//   3) 3. gunun sonunda gece 00:00 -> KAPALI
//
// Neden kademeli: POS bir KASA programi. Gun ortasinda kapanmasi isletmeyi
// satistan alikoyar ve zarar dogrudan bize fatura edilir. Salt-okunur mod
// "odemeni yap" baskisini kurar ama isletmeyi cikmaza sokmaz.
// Veri hicbir asamada SILINMEZ.

const TOLERANS_GUN = Number(process.env.LISANS_TOLERANS_GUN || 3);   // varsayilan; root Sistem Ayarlari'ndan degisebilir
const toleransGun = () => require('./yonetimAyar').toleransGun();     // ayar yoksa TOLERANS_GUN (davranis ayni)

const DURUM = { AKTIF: 'AKTIF', SALT_OKUNUR: 'SALT_OKUNUR', KAPALI: 'KAPALI' };

// Verilen gunun SONU (yerel gece yarisi). "3. gunun sonunda 00:00'da kapansin"
// demek, tolerans gununun bitimindeki gece yarisi demektir.
function gunSonu(tarih) {
    const d = new Date(tarih);
    d.setHours(23, 59, 59, 999);
    return d;
}

// license_end_date -> { durum, bitis, toleransBitis, kalanGun }
function hesapla(licenseEndDate, simdi = new Date()) {
    // Tarih yoksa sinirsiz kabul (eski kayitlar, demo kiracilar)
    if (!licenseEndDate) return { durum: DURUM.AKTIF, bitis: null, toleransBitis: null, kalanGun: null };

    const bitis = new Date(licenseEndDate);
    if (Number.isNaN(bitis.getTime())) {
        return { durum: DURUM.AKTIF, bitis: null, toleransBitis: null, kalanGun: null };
    }

    if (simdi.getTime() <= bitis.getTime()) {
        const kalan = Math.ceil((bitis.getTime() - simdi.getTime()) / 86400000);
        return { durum: DURUM.AKTIF, bitis, toleransBitis: null, kalanGun: kalan };
    }

    // Tolerans penceresi: bitisin uzerine TOLERANS_GUN gun, o gunun SONUNA kadar.
    const tolerans = new Date(bitis);
    tolerans.setDate(tolerans.getDate() + toleransGun());
    const toleransBitis = gunSonu(tolerans);

    if (simdi.getTime() <= toleransBitis.getTime()) {
        const kalan = Math.ceil((toleransBitis.getTime() - simdi.getTime()) / 86400000);
        return { durum: DURUM.SALT_OKUNUR, bitis, toleransBitis, kalanGun: kalan };
    }
    return { durum: DURUM.KAPALI, bitis, toleransBitis, kalanGun: 0 };
}

// Salt-okunur modda hangi istekler gecer?
// Okuma (GET/HEAD) serbest; yazma yalnizca lisans/odeme uclarinda serbest ki
// isletme parasini yatirip kendini kurtarabilsin - aksi halde odeme yapamayan
// bir kilit kurmus oluruz.
const YAZMAYA_IZINLI = [
    '/api/license',      // paket satin alma, havale bildirimi
    '/api/auth',         // giris/cikis/sifre
    '/api/tenant',       // fatura bilgisi duzeltme
    '/api/push/iptal',   // telefon bildirimini kapatma / cikis
    '/api/paket/musteri/bul',   // yalniz OKUMA: telefon adres satirinda gitmesin diye POST govdesiyle
];
// Eslesme YOL SEGMENTI sinirinda: '/api/tenant' kurali '/api/tenants'i, '/api/license' kurali '/api/licensex'i acmaz.
const yolEslesir = (yol, p) => yol === p || yol.startsWith(p + '/') || yol.startsWith(p + '?');
// Istek yolu normallestirilir (buyuk/kucuk harf, mutlak istek satiri, sondaki /; bkz istekYolu.js). Ham yol
// kullanildiginda salt-okunurda "GET /API/magaza/..." magaza kisitini atliyordu (guvenlik incelemesi, dusuk 1).
const { normalYol } = require('./istekYolu');

// MDA Yazilim magazasi, lisans suresi dolmus isletme (SALT_OKUNUR ve KAPALI): YENI siparis ve sepet YOK, urun
// listesi de kapali. Acik olanlar: siparislerim, siparis ayrintisi (havale bilgisiyle), "odemeyi yaptim", iptal ve
// kenar cubugu durumu. Boylece bekleyen siparisinin IBAN'ini gorup odemesini bildirebilir.
const MAGAZA_SURESI_DOLMUS_ACIK = [
    ['GET', /^\/api\/magaza\/durum$/],
    ['GET', /^\/api\/magaza\/siparisler$/],
    ['GET', /^\/api\/magaza\/siparisler\/[^/]+$/],
    ['POST', /^\/api\/magaza\/siparisler\/[^/]+\/(odeme-bildir|iptal)$/],
];
const magazaYolu = (yol) => yolEslesir(yol, '/api/magaza');
function magazadaGecerMi(req) {
    const m = (req.method || 'GET').toUpperCase();
    const yol = normalYol(req);
    return MAGAZA_SURESI_DOLMUS_ACIK.some(([yontem, desen]) =>
        (yontem === m || (yontem === 'GET' && m === 'HEAD')) && desen.test(yol));
}

function saltOkunurdaGecerMi(req) {
    const yol = normalYol(req);
    if (magazaYolu(yol)) return magazadaGecerMi(req);
    const m = (req.method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
    return YAZMAYA_IZINLI.some((p) => yolEslesir(yol, p));
}

// KAPALI (bitis + salt-okunur suresi gecmis): isletme giris yapar ama YALNIZ lisansini yenileyebilir
// (Patron karari 2026-11-12: gelir icin onemli). Acik olanlar: oturum bilgisi, yonetici sifresi kapisi (Lisans
// sayfasi onun arkasinda), lisans uclari (yenileme kanali, teklif, satin alma, gecmis, "odemeyi yaptim", bekleyen
// bildirimi iptal) ve telefon bildirimini kapatma (cikis). Katalog, teklif ve banka bilgisi zaten oturumsuz.
// Magazada yalniz bekleyen siparisi izleme ve odeme bildirme (MAGAZA_SURESI_DOLMUS_ACIK). Geri kalan her sey 403.
const KAPALIDA_ACIK = [
    ['GET', /^\/api\/auth\/me$/],
    ['GET', /^\/api\/auth\/manager-status$/],
    ['POST', /^\/api\/auth\/manager-(verify|set)$/],
    ['*', /^\/api\/license(\/|$)/],
    ['POST', /^\/api\/push\/iptal$/],
];
function kapalidaGecerMi(req) {
    const m = (req.method || 'GET').toUpperCase();
    const yol = normalYol(req);
    return KAPALIDA_ACIK.some(([yontem, desen]) =>
        (yontem === '*' || yontem === m || (yontem === 'GET' && m === 'HEAD')) && desen.test(yol))
        || magazadaGecerMi(req);
}

module.exports = { DURUM, TOLERANS_GUN, hesapla, saltOkunurdaGecerMi, kapalidaGecerMi, magazadaGecerMi, yolEslesir, gunSonu };
