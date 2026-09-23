// SofraMix esleme tablolari.
// Degerler SofraMix kaynak kodundan BIREBIR dogrulandi (api/src/migrations/001_init.sql,
// api/src/routes/business.js). Uydurma deger YOK.

// — Siparis durumu: SofraMix -> normalize —
const STATUS_TO_NORMALIZED = {
    yeni: 'NEW',
    onaylandi: 'ACCEPTED',
    hazirlaniyor: 'PREPARING',
    yolda: 'DISPATCHED',      // yalniz adrese teslimde
    hazir: 'READY',           // yalniz gel-al'da
    teslim: 'DELIVERED',
    iptal: 'CANCELLED',
};

// — Normalize -> SofraMix (durum yazarken) —
const NORMALIZED_TO_STATUS = {
    ACCEPTED: 'onaylandi',
    PREPARING: 'hazirlaniyor',
    DISPATCHED: 'yolda',
    READY: 'hazir',
    DELIVERED: 'teslim',
    CANCELLED: 'iptal',
    REJECTED: 'iptal',        // SofraMix'te ayri "reddet" durumu yok
};

// — SofraMix'in SUNUCUDA kilitli gecis matrisi (business.js:737-747) —
// POS arayuzu bunu BIREBIR yansitmali; yansitmazsa personel calismayan dugmeye
// basar ve sisteme guvenini kaybeder.
// DIKKAT: 'yolda' ve 'hazir' asamasinda isletme TEK TARAFLI IPTAL EDEMEZ.
const IZINLI_GECISLER = {
    yeni: ['onaylandi', 'iptal'],
    onaylandi: ['hazirlaniyor', 'iptal'],
    hazirlaniyor: ['yolda', 'hazir', 'iptal'],  // gel-al ise 'hazir', degilse 'yolda'
    yolda: ['teslim'],        // iptal YOK -> "Teslim edilemedi" kullanilir
    hazir: ['teslim'],        // iptal YOK
    teslim: [],
    iptal: [],
};

const iptalEdilebilir = (durum) => (IZINLI_GECISLER[durum] || []).includes('iptal');
const teslimEdilemediBildirilebilir = (durum) => durum === 'yolda' || durum === 'hazir';
const TERMINAL = new Set(['teslim', 'iptal']);

// — Teslimat modeli (001_init.sql:94) —
const DELIVERY_TO_MODE = {
    isletme_kurye: 'RESTAURANT_COURIER',
    kurye_firma: 'PLATFORM_COURIER',
    gel_al: 'PICKUP',
};

// — Odeme (001_init.sql:95) —
const PAYMENT = {
    kapida_nakit: { settlement: 'ON_DELIVERY', posMethod: 'NAKIT', label: 'Kapida nakit' },
    kapida_kart: { settlement: 'ON_DELIVERY', posMethod: 'KREDI_KARTI', label: 'Kapida kart' },
    online_iyzico: { settlement: 'ONLINE', posMethod: 'DIGER', label: 'Online (iyzico)' },
};

// Hazirlaniyor'dan sonraki durum teslimat tipine gore dallanir.
const hazirlaniyorSonrasi = (deliveryType) => (deliveryType === 'gel_al' ? 'hazir' : 'yolda');

// SofraMix zaman bicimi: 'YYYY-MM-DD HH:MM:SS', UTC, Z EKI YOK.
// Dogrudan Date()'e verilirse yerel saat sanilir ve 3 saat kayar.
function zamanaMs(s) {
    if (!s) return null;
    const t = Date.parse(String(s).replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? t : null;
}

// Secenekler POS'ta MODELLENMEZ (Patron karari 2026-09-22): SofraMix'in
// options_json'i insan-okur metne cevrilip siparis kalemine DONDURULUR.
// Boylece secenek ID senkronu hic gerekmez ve mutfak dogru bilgiyi gorur.
function seceneklerMetne(optionsJson) {
    let arr = optionsJson;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { return ''; } }
    if (!Array.isArray(arr) || !arr.length) return '';
    return arr.map((o) => (o && (o.secenek || o.ad || o.name)) || '').filter(Boolean).join(', ');
}

module.exports = {
    STATUS_TO_NORMALIZED, NORMALIZED_TO_STATUS, IZINLI_GECISLER, TERMINAL,
    DELIVERY_TO_MODE, PAYMENT,
    iptalEdilebilir, teslimEdilemediBildirilebilir, hazirlaniyorSonrasi,
    zamanaMs, seceneklerMetne,
};
