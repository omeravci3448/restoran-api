// --- Magaza tutar hesabi + girdi denetimi (saf fonksiyonlar, veritabani yok) ---
//
// Butun tutarlar KURUS tamsayi. Istemciden gelen fiyat HIC kullanilmaz: birim fiyat ve KDV
// orani her zaman veritabanindan okunur ve burada toplanir.
//
// KDV satir bazinda hesaplanir: satir tutari (adet x KDV haric birim fiyat) uzerinden bulunup
// kurusa yuvarlanir. e-Arsiv faturasi da boyle hesapliyor; boylece isletmenin havaleyle odedigi
// tutar, Patron'un elle kestigi faturanin toplamiyla kurusu kurusuna tutar.
//
// Kargo ucreti KDV DAHIL girilir (alicinin odedigi tutar). Ucretsiz kargo esigi, urunlerin KDV
// dahil toplamiyla karsilastirilir ("X TL ve uzeri siparislerde kargo ucretsiz").

const KARGO_KDV_ORANI = 20;          // kargo/tasima hizmeti KDV'si (faturada ayristirmak icin)
const EN_FAZLA_ADET = 999;           // tek satirda
const EN_FAZLA_KALEM = 50;           // tek sipariste farkli urun

// Oran yuzde (20 = %20). Ondalikli oranlarda da tamsayi aritmetigi: oran x100 -> baz puan.
function kdvHesapla(tutarKurus, oran) {
    const bp = Math.round(Number(oran || 0) * 100);
    return Math.round((Number(tutarKurus) * bp) / 10000);
}

function kdvDahilBirim(birimKurus, oran) {
    return Number(birimKurus) + kdvHesapla(birimKurus, oran);
}

function satirHesapla(birimKurus, adet, oran) {
    const tutar = Number(birimKurus) * Number(adet);
    const kdv = kdvHesapla(tutar, oran);
    return { tutarKurus: tutar, kdvKurus: kdv, toplamKurus: tutar + kdv };
}

// urunlerKdvDahil: urunlerin KDV dahil toplami. ucret 0 ise kargo her zaman ucretsiz.
// esik 0/bos ise esik yok (ucret her sipariste alinir).
function kargoHesapla(urunlerKdvDahilKurus, { ucretKurus = 0, esikKurus = 0 } = {}) {
    const ucret = Math.max(0, Number(ucretKurus) || 0);
    const esik = Math.max(0, Number(esikKurus) || 0);
    if (ucret === 0) return { kargoKurus: 0, ucretsiz: true, sebep: 'UCRETSIZ', eksikKurus: null };
    if (esik > 0 && urunlerKdvDahilKurus >= esik) return { kargoKurus: 0, ucretsiz: true, sebep: 'ESIK', eksikKurus: 0 };
    return { kargoKurus: ucret, ucretsiz: false, sebep: 'UCRETLI', eksikKurus: esik > 0 ? esik - urunlerKdvDahilKurus : null };
}

// satirlar: [{ tutarKurus, kdvKurus }]
function toplamlar(satirlar, kargoAyar) {
    const ara = satirlar.reduce((a, s) => a + s.tutarKurus, 0);
    const kdv = satirlar.reduce((a, s) => a + s.kdvKurus, 0);
    const kargo = satirlar.length ? kargoHesapla(ara + kdv, kargoAyar)
        : { kargoKurus: 0, ucretsiz: false, sebep: 'BOS', eksikKurus: null };
    return { araToplamKurus: ara, kdvKurus: kdv, kargoKurus: kargo.kargoKurus,
             genelToplamKurus: ara + kdv + kargo.kargoKurus, kargo };
}

// KDV dahil tutari haric + KDV olarak ayirir (kargo satiri faturaya boyle yazilir).
function kdvAyir(kdvDahilKurus, oran = KARGO_KDV_ORANI) {
    const haric = Math.round((Number(kdvDahilKurus) * 100) / (100 + Number(oran)));
    return { haricKurus: haric, kdvKurus: Number(kdvDahilKurus) - haric };
}

// TL girdisi (12500 / "12500.5" / "12.500,50") -> kurus. Gecersizse null.
function tlKurus(deger) {
    if (deger === null || deger === undefined || deger === '') return null;
    if (typeof deger === 'number') return Number.isFinite(deger) ? Math.round(deger * 100) : null;
    let s = String(deger).trim().replace(/\s|TL|₺/gi, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes(',')) s = s.replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    return Math.round(Number(s) * 100);
}

const metin = (v, en) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, en);
const rakamlar = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// TC kimlik no: 11 hane, ilk hane 0 degil, 10. ve 11. haneler kontrol hanesi.
function tcknGecerli(v) {
    const s = rakamlar(v);
    if (!/^[1-9]\d{10}$/.test(s)) return false;
    const d = s.split('').map(Number);
    const tek = d[0] + d[2] + d[4] + d[6] + d[8];
    const cift = d[1] + d[3] + d[5] + d[7];
    const on = ((tek * 7 - cift) % 10 + 10) % 10;
    if (on !== d[9]) return false;
    return (d.slice(0, 10).reduce((a, x) => a + x, 0) % 10) === d[10];
}

// Vergi kimlik no: 10 hane (kontrol hanesi algoritmasi uygulanmiyor; yanlis negatif riski
// gecerli bir numarayi reddetmekten iyidir, Patron faturada zaten dogruluyor).
const vknGecerli = (v) => /^\d{10}$/.test(rakamlar(v));

// Telefon: 10-13 hane (0 / +90 onekli yazimlar). Kayit, girildigi gibi (kirpilmis) tutulur.
function telefonGecerli(v) {
    const n = rakamlar(v).length;
    return n >= 10 && n <= 13;
}

module.exports = {
    KARGO_KDV_ORANI, EN_FAZLA_ADET, EN_FAZLA_KALEM,
    kdvHesapla, kdvDahilBirim, satirHesapla, kargoHesapla, toplamlar, kdvAyir, tlKurus,
    metin, rakamlar, tcknGecerli, vknGecerli, telefonGecerli,
};
