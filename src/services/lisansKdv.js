// --- Lisans KDV hesabi (Patron karari 2026-11-18) ---
// Katalog fiyatlari KDV HARIC. Ekranlarda "X + %20 KDV = Y", havale tutari Y (KDV dahil).
// Hesap KURUS tam sayisiyla yapilir (kayan nokta yuvarlama hatasi olmasin):
//   araToplam  = KDV haric odenecek (indirim ve yukseltme kredisi dusulmus)
//   kdvTutari  = round(araToplam x oran / 100)
//   genelToplam = araToplam + kdvTutari
// Oran root Sistem Ayarlari'ndan (kdv_orani, varsayilan 20).

const kurus = (tl) => Math.round((Number(tl) || 0) * 100);

function kdvOrani() {
    try { return require('./yonetimAyar').kdvOrani(); } catch (_) { return 20; }
}

// araToplamTL: KDV haric tutar (TL). oran verilmezse ayardaki oran.
function kdvHesapla(araToplamTL, oran = kdvOrani()) {
    const o = Number(oran);
    const r = Number.isFinite(o) && o >= 0 ? o : 20;
    const ara = Math.max(0, kurus(araToplamTL));
    const kdv = Math.round(ara * r / 100);
    return { kdvOrani: r, araToplam: ara / 100, kdvTutari: kdv / 100, genelToplam: (ara + kdv) / 100 };
}

const TL = (n) => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' TL';

// Lisans odemesi kaydi -> { kdvVar, araToplam, kdvOrani, kdvTutari, genelToplam }. Eski kayit (KDV kolonlari bos):
// kdvVar false, genelToplam = tutar (musteri o tutari gonderecekti).
function kayitKdv(o) {
    const ara = Number(o && o.tutar) || 0;
    if (!o || o.genel_toplam == null) return { kdvVar: false, araToplam: ara, kdvOrani: null, kdvTutari: null, genelToplam: ara };
    return { kdvVar: true, araToplam: ara, kdvOrani: Number(o.kdv_orani), kdvTutari: Number(o.kdv_tutari) || 0, genelToplam: Number(o.genel_toplam) || 0 };
}

// "11.000 TL + %20 KDV = 13.200 TL" (eski kayitta "11.000 TL (KDV hesaplanmamış)")
function kdvMetni(o) {
    const k = kayitKdv(o);
    if (!k.kdvVar) return TL(k.araToplam) + ' (KDV hesaplanmamış)';
    return `${TL(k.araToplam)} + %${String(k.kdvOrani).replace('.', ',')} KDV = ${TL(k.genelToplam)}`;
}

module.exports = { kdvHesapla, kdvOrani, kayitKdv, kdvMetni, TL, kurus };
