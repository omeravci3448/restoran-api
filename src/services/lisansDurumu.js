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
// (Eski yardimci; sunucunun saat dilimine bagli. Lisans sinirlari artik gunSonuIstanbul ile hesaplanir.)
function gunSonu(tarih) {
    const d = new Date(tarih);
    d.setHours(23, 59, 59, 999);
    return d;
}

// --- Istanbul gun sinirlari (2026-11-18) ---
// Lisans bitis gunu ISTANBUL takvimine gore sayilir (sunucu UTC'de calissa da): lisans bitis gununun SONUNA
// (Istanbul 23:59:59.999) kadar AKTIF, (bitis gunu + salt-okunur gun) gununun sonuna kadar SALT_OKUNUR, sonra KAPALI.
// Turkiye 2016'dan beri yaz saati uygulamiyor: sabit UTC+3. Kayitli tarihler DEGISTIRILMEZ, yalniz yorumlanir.
const IST_MS = 3 * 3600000;
const GUN_MS = 86400000;
// Istanbul takvim gunu (UTC gece yarisi olarak sayi; gun farki almak icin)
function istanbulGunu(tarih) {
    const t = new Date(tarih).getTime() + IST_MS;
    return Math.floor(t / GUN_MS) * GUN_MS;
}
// Verilen anin Istanbul gununun (+ ekGun) sonu: Istanbul 23:59:59.999
function gunSonuIstanbul(tarih, ekGun = 0) {
    return new Date(istanbulGunu(tarih) + (Number(ekGun) || 0) * GUN_MS + GUN_MS - 1 - IST_MS);
}
// Iki an arasindaki Istanbul takvim gunu farki (b - a); ayni gunse 0
function istanbulGunFarki(a, b) {
    return Math.round((istanbulGunu(b) - istanbulGunu(a)) / GUN_MS);
}

// license_end_date -> { durum, bitis, aktifBitis, toleransBitis, kalanGun }
//   bitis        kayitli bitis ani (oldugu gibi)
//   aktifBitis   bitis gununun sonu (Istanbul): bu ana kadar AKTIF
//   toleransBitis (bitis gunu + salt-okunur gun) gununun sonu (Istanbul): bu ana kadar SALT_OKUNUR
//   kalanGun     AKTIF: bugunden bitis gunune kadar Istanbul takvim gunu (0 = bugun bitiyor); SALT_OKUNUR: tolerans
//                gunune kadar (0 = erisim bugun sona eriyor); KAPALI: 0
function hesapla(licenseEndDate, simdi = new Date()) {
    // Tarih yoksa sinirsiz kabul (eski kayitlar, demo kiracilar)
    if (!licenseEndDate) return { durum: DURUM.AKTIF, bitis: null, toleransBitis: null, kalanGun: null };

    const bitis = new Date(licenseEndDate);
    if (Number.isNaN(bitis.getTime())) {
        return { durum: DURUM.AKTIF, bitis: null, toleransBitis: null, kalanGun: null };
    }

    const aktifBitis = gunSonuIstanbul(bitis);
    // Tolerans penceresi: bitis gununun uzerine salt-okunur gun sayisi, o gunun SONUNA kadar (Istanbul).
    const toleransBitis = gunSonuIstanbul(bitis, toleransGun());
    if (simdi.getTime() <= aktifBitis.getTime()) {
        return { durum: DURUM.AKTIF, bitis, aktifBitis, toleransBitis: null, kalanGun: Math.max(0, istanbulGunFarki(simdi, bitis)) };
    }
    if (simdi.getTime() <= toleransBitis.getTime()) {
        return { durum: DURUM.SALT_OKUNUR, bitis, aktifBitis, toleransBitis, kalanGun: Math.max(0, istanbulGunFarki(simdi, toleransBitis)) };
    }
    return { durum: DURUM.KAPALI, bitis, aktifBitis, toleransBitis, kalanGun: 0 };
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

// Salt-okunurda ACIK HIZMETI BITIRME (2026-11-18): lisans bitmeden acilmis masa hesabi ve paket siparisi tahsil
// edilip kapatilabilir; YENI siparis acilamaz, kaleme dokunulamaz. Bu uclarin hepsi yalniz ACIK siparis uzerinde
// calisir (denetleyiciler status = 'OPEN' arar): odeme ekleme, kalem secerek odeme, hesabi kapatma ve paket
// siparisinde hazir / yola cikti / teslim edildi (pazaryeri siparisinde "kabul" YENI is sayilir, kapali).
// KAPALI'da hicbiri acik degil (kapalidaGecerMi).
const HIZMET_BITIRME = [
    ['POST', /^\/api\/payments$/],
    ['POST', /^\/api\/payments\/by-items$/],
    ['POST', /^\/api\/orders\/[^/]+\/close$/],
    ['POST', /^\/api\/paket\/[^/]+\/aksiyon$/, (req) => ['hazirlaniyor', 'yolda', 'hazir', 'teslim', 'teslim_edilemedi']
        .includes(String((req.body || {}).aksiyon || ''))],
];
function hizmetBitirmeMi(req) {
    const m = (req.method || 'GET').toUpperCase();
    const yol = normalYol(req);
    return HIZMET_BITIRME.some(([yontem, desen, ek]) => yontem === m && desen.test(yol) && (!ek || ek(req)));
}

function saltOkunurdaGecerMi(req) {
    const yol = normalYol(req);
    if (magazaYolu(yol)) return magazadaGecerMi(req);
    const m = (req.method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
    return YAZMAYA_IZINLI.some((p) => yolEslesir(yol, p)) || hizmetBitirmeMi(req);
}

// KAPALI (bitis + salt-okunur suresi gecmis): isletme giris yapar ama YALNIZ lisansini yenileyebilir
// (Patron karari 2026-11-12: gelir icin onemli). Acik olanlar: oturum bilgisi, yonetici sifresi kapisi (Lisans
// sayfasi onun arkasinda), lisans uclari (yenileme kanali, teklif, satin alma, gecmis, "odemeyi yaptim", bekleyen
// bildirimi iptal) ve telefon bildirimini kapatma (cikis). Katalog, teklif ve banka bilgisi zaten oturumsuz.
// Magazada yalniz bekleyen siparisi izleme ve odeme bildirme (MAGAZA_SURESI_DOLMUS_ACIK). Geri kalan her sey 403.
const KAPALIDA_ACIK = [
    ['GET', /^\/api\/auth\/me$/],
    ['GET', /^\/api\/auth\/manager-status$/],
    ['POST', /^\/api\/auth\/manager-(verify|set|reset)$/],   // reset: "yonetici sifremi unuttum" (yalniz sahip)
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

module.exports = { DURUM, TOLERANS_GUN, hesapla, saltOkunurdaGecerMi, kapalidaGecerMi, magazadaGecerMi, yolEslesir, gunSonu,
    gunSonuIstanbul, istanbulGunFarki, hizmetBitirmeMi };
