// --- PAKET SERVIS: pazaryeri esleme tablosu (adaptor basina BIR satir) ---
//
// Patron yonu (2026-11-03): isletme pazaryeri panelini hic acmadan her seyi POS'tan yonetsin; ileride
// baska pazaryerleri eklenince onlar da Paket Servis listesine dussun. Bu yuzden liste, asama, izinli
// dugmeler, uyari ve odeme hesabi adaptor koduna gore if/else ile DEGIL, bu tablodan okunur.
//
// Yeni pazaryeri eklemek = buraya o adaptorun satirini eklemek (adaptorun kendi mapping.js'inden
// beslenir). Satiri olmayan adaptorun siparisi Paket Servis'e DUSMEZ (Pazaryeri ekraninda kalir).
// Bugun yalniz SofraMix satiri dolu. Trendyol GO bilerek baglanmadi.
//
// Satir alanlari:
//   ad          : ekranda/rozette gorunen kanal adi
//   durumNormal : platform ham durumu -> normalize durum (NEW, ACCEPTED, PREPARING, DISPATCHED, READY,
//                 DELIVERED, CANCELLED, REJECTED). Asama ve aksiyon bu ortak sozluk uzerinden hesaplanir.
//   gecisler    : platformun KILITLI gecis matrisi (ham durum -> gidilebilecek ham durumlar). Dugmeler
//                 bundan cizilir, sunucu da istegi bununla denetler.
//   yalnizGelAl / yalnizAdrese : hedef normalize durumun teslimat sekline bagli oldugu durumlar
//   reddetDurum : bu normalize durumdayken iptal dugmesinin adi "Reddet" (henuz kabul edilmemis)
//   dikkat      : kasada zil + kartta vurgu: bu normalize durumlardaki (el surulmemis) siparis
//   teslimEdilemedi : "Teslim edilemedi" bildiriminin acik oldugu normalize durumlar (adaptorde
//                 reportUndeliverable varsa)
//   takmaHam    : eski surumlerin yerelde yazdigi, platformda olmayan ham degerlerin karsiligi
//   odeme       : platform odeme kodu -> { pos: POS odeme yontemi, etiket }
//   musteri     : musteri adi/telefon/adres Paket Servis icin saklansin mi (KVKK: 30 gun)
const SMX = require('./adapters/soframix/mapping');

const ESLEME = {
    soframix: {
        ad: 'SofraMix',
        durumNormal: SMX.STATUS_TO_NORMALIZED,
        gecisler: SMX.IZINLI_GECISLER,
        yalnizGelAl: ['READY'],          // SofraMix'te 'hazir' yalniz gel-al
        yalnizAdrese: ['DISPATCHED'],    // 'yolda' yalniz adrese teslim
        reddetDurum: ['NEW'],
        dikkat: ['NEW', 'ACCEPTED'],
        teslimEdilemedi: ['DISPATCHED', 'READY'],
        takmaHam: { teslim_edilemedi: { GEL_AL: 'hazir', ADRES: 'yolda' } },
        odeme: {
            kapida_nakit: { pos: SMX.PAYMENT.kapida_nakit.posMethod, etiket: 'Kapıda nakit' },
            kapida_kart: { pos: SMX.PAYMENT.kapida_kart.posMethod, etiket: 'Kapıda kart' },
            online_iyzico: { pos: SMX.PAYMENT.online_iyzico.posMethod, etiket: 'Online ödendi' },
        },
        musteri: true,
    },
    // trendyolgo: { ... }  -> Trendyol GO baglaninca satiri buraya; baska yere dokunmak gerekmez.
};

// --- Kasadan pazaryerine yazilabilen islemler (adaptor metodu + gereken yetenek) ---
// normal: islemin hedefledigi normalize durum (yerel ham durum esleme satirindan bulunur).
// ham: esleme satiri OLMAYAN kanalda (Pazaryeri ekrani, eski davranis) yerelde yazilan ham durum.
const AKSIYONLAR = {
    kabul:            { metod: 'acceptOrder',         yetenek: 'acceptReject',   normal: 'ACCEPTED',   ham: 'onaylandi' },
    hazirlaniyor:     { metod: 'markPreparing',       yetenek: 'markPreparing',  normal: 'PREPARING',  ham: 'hazirlaniyor' },
    hazir:            { metod: 'markReady',           yetenek: 'markReady',      normal: 'READY',      ham: 'hazir' },
    yolda:            { metod: 'markDispatched',      yetenek: 'markDispatched', normal: 'DISPATCHED', ham: 'yolda' },
    teslim:           { metod: 'markDelivered',       yetenek: 'markDelivered',  normal: 'DELIVERED',  ham: 'teslim' },
    iptal:            { metod: 'cancelOrder',         yetenek: 'acceptReject',   normal: 'CANCELLED',  ham: 'iptal', sebepGerekli: true },
    // Platformda durum DEGISMEZ (karari platform verir); yerelde yalniz damga tutulur.
    teslim_edilemedi: { metod: 'reportUndeliverable', yetenek: 'markDelivered',  normal: null,         ham: null, sebepGerekli: true },
};

// Kanal kodlari SQL'e gomulur: yalniz guvenli karakterler (adaptor kodlari zaten boyle)
const KOD_DESENI = /^[a-z0-9_]+$/;
const kodlar = () => Object.keys(ESLEME).filter((k) => KOD_DESENI.test(k));
const satir = (kanal) => (Object.prototype.hasOwnProperty.call(ESLEME, kanal || '') ? ESLEME[kanal] : null);

module.exports = { ESLEME, AKSIYONLAR, kodlar, satir };
