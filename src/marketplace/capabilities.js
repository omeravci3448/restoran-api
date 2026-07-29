// Yetenek beyanı (capability) — bu mimarinin temel taşı.
//
// Platformlar birbirine benzemiyor: Yemeksepeti Hat A'da klasik "kabul/ret" YOK
// (sipariş RECEIVED gelir, ileri taşınır ya da iptal edilir), Trendyol'da menüye
// ürün OLUŞTURMA yok (sadece fiyat/durum güncelleme), Migros'un dokümanı elimizde yok.
// Bu yüzden "hepsi aynı API'yi konuşur" varsayımı yerine her adaptör NE YAPABİLDİĞİNİ
// beyan eder; çekirdek yalnızca beyan edileni çağırır, arayüz butonları buna göre açılır.

const DEFAULTS = {
    ingress: 'polling',        // 'webhook' | 'polling' | 'hybrid'
    acceptReject: false,       // klasik kabul/ret var mı
    prepTimeOnAccept: false,   // kabulde hazırlık süresi gönderiliyor mu
    markPreparing: false,
    markReady: false,
    markDispatched: false,     // yalnız restoran-kuryeli modelde anlamlı
    markDelivered: false,
    partialCancel: false,      // kalem bazlı iptal
    menuRead: false,
    menuWrite: false,          // ürün/kategori OLUŞTURMA (çoğu platformda YOK)
    priceUpdate: false,
    itemAvailability: false,
    categoryAvailability: false,
    stockQuantity: false,      // gerçek adet mi yoksa sadece aktif/pasif mi
    storeOpenClose: false,
    settlements: false,        // komisyon/hakediş çekilebiliyor mu
    asyncJobs: false,          // batch iş takibi gerekiyor mu
    sandbox: false,
    credentialScope: 'unknown', // 'chain' | 'supplier' | 'store' | 'unknown'
};

// Bilinmeyen anahtar = yazım hatası; sessizce yutma.
function buildCapabilities(partial = {}) {
    const unknown = Object.keys(partial).filter((k) => !(k in DEFAULTS));
    if (unknown.length) throw new Error(`Bilinmeyen capability alanı: ${unknown.join(', ')}`);
    return { ...DEFAULTS, ...partial };
}

module.exports = { DEFAULTS, buildCapabilities };
