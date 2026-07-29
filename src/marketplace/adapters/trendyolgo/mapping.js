// Trendyol GO (Uber Eats Trendyol Go - Yemek) eşleme tabloları.
// Eşlemeler koda if/else olarak gömülmez — tablo olarak durur ki doküman değişince
// tek yerden düzeltilsin. Kaynak: developers.tgoapps.com (Temmuz 2026).

// — Sipariş durumu: platform → normalize —
// DİKKAT: "Invoiced" FATURA demek DEĞİL, "hazırlık bitti" demek. İsim tuzağı;
// normalize model bunu kapatıyor, ham değer channel_status_raw'da saklanır.
const STATUS_TO_NORMALIZED = {
    Created: 'NEW',
    Picking: 'ACCEPTED',      // kabul edildi, hazırlanıyor
    Invoiced: 'READY',        // hazırlık bitti, kurye alabilir
    Shipped: 'DISPATCHED',
    Delivered: 'DELIVERED',
    Cancelled: 'CANCELLED',   // müşteri/platform iptali
    UnSupplied: 'REJECTED',   // restoran tedarik edemedi (tam/kısmi)
};

// Normalize → platform (aksiyon gönderirken hangi uca gideceğimiz)
const NORMALIZED_TO_ACTION = {
    ACCEPTED: 'picked',
    READY: 'invoiced',
    DISPATCHED: 'manual-shipped',    // YALNIZ Model 1 (restoran kendi kuryesi)
    DELIVERED: 'manual-delivered',   // YALNIZ Model 1
    REJECTED: 'unsupplied',
};

// Terminal durumlar — bunlara ulaşınca ileri aksiyon gönderilmez
const TERMINAL = new Set(['DELIVERED', 'CANCELLED', 'REJECTED']);

// — Teslimat modeli —
// deliveryType: STORE = restoran kendi kuryesiyle (Model 1), GO = platform kuryesi (Model 2)
// storePickupSelected=true ise müşteri gel-al.
function toDeliveryMode(pkg) {
    if (pkg?.storePickupSelected === true) return 'PICKUP';
    const t = String(pkg?.deliveryType || '').toUpperCase();
    if (t === 'STORE') return 'RESTAURANT_COURIER';
    if (t === 'GO') return 'PLATFORM_COURIER';
    return 'UNKNOWN';
}

// — Ödeme —
const PAYMENT_SETTLEMENT = {
    PAY_WITH_CARD: 'ONLINE',
    PAY_WITH_ON_DELIVERY: 'ON_DELIVERY',
};

// — İptal/tedarik edilemedi sebepleri (unsupplied reasonId) —
// Dokümandan birebir alınan kodlar. Serbest metin GÖNDERİLMEZ.
const UNSUPPLIED_REASONS = [
    { id: 621, label: 'Ürün stokta yok' },
    { id: 622, label: 'Restoran çok yoğun' },
    { id: 623, label: 'Restoran kapalı' },
    { id: 624, label: 'Teknik sorun' },
    { id: 626, label: 'Adres kapsama dışı' },
    { id: 627, label: 'Diğer' },
];
const VALID_UNSUPPLIED_REASON_IDS = new Set(UNSUPPLIED_REASONS.map((r) => r.id));

// — Alt kanal —
// Tek entegrasyonla üç kanal geliyor: Trendyol, TrendyolGo, Galaxy (eski GetirYemek trafiği).
const SUB_CHANNELS = ['Trendyol', 'TrendyolGo', 'Galaxy'];

module.exports = {
    STATUS_TO_NORMALIZED,
    NORMALIZED_TO_ACTION,
    TERMINAL,
    toDeliveryMode,
    PAYMENT_SETTLEMENT,
    UNSUPPLIED_REASONS,
    VALID_UNSUPPLIED_REASON_IDS,
    SUB_CHANNELS,
};
