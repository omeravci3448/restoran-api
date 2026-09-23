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

const TOLERANS_GUN = Number(process.env.LISANS_TOLERANS_GUN || 3);

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
    tolerans.setDate(tolerans.getDate() + TOLERANS_GUN);
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
];

function saltOkunurdaGecerMi(req) {
    const m = (req.method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
    const yol = req.originalUrl || req.url || '';
    return YAZMAYA_IZINLI.some((p) => yol.startsWith(p));
}

module.exports = { DURUM, TOLERANS_GUN, hesapla, saltOkunurdaGecerMi, gunSonu };
