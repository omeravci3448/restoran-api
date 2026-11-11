// --- Moduler lisans: moduller, bagimliliklar, QR menu ozellikleri ---
//
// Patron karari (2026-11-11). Ayri "paket turu" yok; isletmenin yapabildigi lisanstaki modullerden turetilir.
//   BASE         "Adisyon ve Kasa": masa/adisyon, tahsilat, raporlar, paket servis, mutfak ve musteri ekrani.
//                Fiyati secilen masa kademesinin fiyatidir. Yoksa panel "menu kipi"ndedir (Menu, Masalar,
//                Masa Plakalari, Ayarlar, Lisans) ve POS'a ozgu uclar 403 MODULE_NOT_LICENSED doner.
//   MENU_DIGITAL "QR Menu": misafir masadaki karekodla menuyu gorur.
//   QR_SIPARIS   "Masadan Siparis": misafir QR menuden siparis verir. MENU_DIGITAL + BASE ister.
//   GARSON       "Garson": QR menude garson cagir + garson telefon uygulamasi. MENU_DIGITAL ya da BASE'den
//                en az birini ister. BASE yoksa garson uygulamasi yalniz cagrilari gosterir.
//   STOK, MARKETPLACE: eskisi gibi; ikisi de adisyona dayanir (BASE ister).
// "Hesabi gor" BASE ister. Isletme anahtarlari (qr_siparis_acik, qr_garson_acik, qr_hesap_acik) kalir:
// etkin ozellik = modul VAR ve anahtar ACIK. 'ALL' butun modulleri kapsar.

const AD = {
    BASE: 'Adisyon ve Kasa',
    MENU_DIGITAL: 'QR Menü',
    QR_SIPARIS: 'Masadan Sipariş',
    GARSON: 'Garson',
    STOK: 'Stok + Tedarikçi',
    MARKETPLACE: 'Pazaryeri Entegrasyonu',
    FINANSAL_RAPORLAMA: 'Maliyet ve Kâr Raporu',
};

// hepsi: hepsi gerekli; biri: en az biri gerekli (eksikse ILKI eklenir)
const BAGIMLILIK = {
    QR_SIPARIS: { hepsi: ['MENU_DIGITAL', 'BASE'] },
    GARSON: { biri: ['MENU_DIGITAL', 'BASE'] },
    STOK: { hepsi: ['BASE'] },
    MARKETPLACE: { hepsi: ['BASE'] },
};

function modulListesi(v) {
    if (Array.isArray(v)) return v.map(String);
    try { const j = JSON.parse(v || '[]'); return Array.isArray(j) ? j.map(String) : []; } catch (_) { return []; }
}

function varMi(moduller, m) {
    const l = modulListesi(moduller);
    return l.includes(m) || l.includes('ALL');
}

// Secime bagimliliklari ekler (sabit noktaya kadar). Sira korunur, tekrar yok.
// Doner: { moduller, eklenen }
function bagimliliklariTamamla(secim) {
    const l = Array.from(new Set(modulListesi(secim).filter(Boolean)));
    const eklenen = [];
    let degisti = true;
    while (degisti) {
        degisti = false;
        for (const m of l.slice()) {
            const b = BAGIMLILIK[m];
            if (!b) continue;
            for (const g of b.hepsi || []) {
                if (!varMi(l, g)) { l.push(g); eklenen.push(g); degisti = true; }
            }
            if (b.biri && !b.biri.some((g) => varMi(l, g))) { l.push(b.biri[0]); eklenen.push(b.biri[0]); degisti = true; }
        }
    }
    return { moduller: l, eklenen };
}

// Modulun bagimliliklari verilen listede karsilaniyor mu (eklemeden yalniz bakar)
function bagimlilikSaglaniyor(m, liste) {
    const b = BAGIMLILIK[m];
    if (!b) return true;
    if (b.hepsi && !b.hepsi.every((g) => varMi(liste, g))) return false;
    if (b.biri && !b.biri.some((g) => varMi(liste, g))) return false;
    return true;
}

// 0/'0'/false kapali; 1/NULL/undefined acik
function acikMi(v) {
    return !(v === 0 || v === '0' || v === false);
}

// Misafirin QR menude kullanabildigi ozellikler (sunucu ayni sonuca gore 403 doner).
// t: tenants satiri (license_modules + uc anahtar). Menunun kendisi MENU_DIGITAL ister (publicController).
function qrOzellikleri(t) {
    const m = t && t.license_modules;
    return {
        siparis: varMi(m, 'QR_SIPARIS') && varMi(m, 'BASE') && acikMi(t && t.qr_siparis_acik),
        garson: varMi(m, 'GARSON') && varMi(m, 'MENU_DIGITAL') && acikMi(t && t.qr_garson_acik),
        hesap: varMi(m, 'BASE') && acikMi(t && t.qr_hesap_acik),
    };
}

// Hangi anahtarin modulu lisansta var (Ayarlar'da anahtar pasif mi)
function anahtarModulleri(t) {
    const m = t && t.license_modules;
    return {
        siparis: varMi(m, 'QR_SIPARIS') && varMi(m, 'BASE'),
        garson: varMi(m, 'GARSON') && varMi(m, 'MENU_DIGITAL'),
        hesap: varMi(m, 'BASE'),
    };
}

// Plakadaki ve toplu karekod sayfasindaki alt cumle
function okutunMetni(t) {
    return qrOzellikleri(t).siparis ? 'Menü ve sipariş için okutun' : 'Menü için okutun';
}

// Adisyon ve Kasa yoksa panel menu kipinde
function menuKipiMi(moduller) {
    return !varMi(moduller, 'BASE');
}

module.exports = { AD, BAGIMLILIK, modulListesi, varMi, bagimliliklariTamamla, bagimlilikSaglaniyor, acikMi, qrOzellikleri, anahtarModulleri, okutunMetni, menuKipiMi };
