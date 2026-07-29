// Pazaryeri adaptörlerinin ortak hata tipi.
// Çekirdek (retry/kuyruk) SADECE `kind`'a bakar — HTTP kodunu adaptör yorumlar.
// Örn. Trendyol'da 409 iki farklı anlama gelir (statü güncellemede tekrar denenebilir,
// invoiced'da denenemez); bu ayrımı adaptör yapar, çekirdek değil.

const KIND = {
    AUTH: 'AUTH',                 // kimlik geçersiz → anahtarı 'invalid' işaretle, tekrar deneme
    RATE_LIMIT: 'RATE_LIMIT',     // 429 → bekle, tekrar dene
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',         // durum çakışması (örn. sipariş zaten ilerlemiş)
    VALIDATION: 'VALIDATION',     // gönderdiğimiz veri hatalı → tekrar denemek anlamsız
    UNSUPPORTED: 'UNSUPPORTED',   // adaptör bu yeteneği beyan etmiyor
    TRANSIENT: 'TRANSIENT',       // ağ/5xx → tekrar denenebilir
    PERMANENT: 'PERMANENT',
};

// Varsayılan olarak tekrar denenebilir kabul edilen türler
const RETRYABLE = new Set([KIND.RATE_LIMIT, KIND.TRANSIENT]);

class AdapterError extends Error {
    constructor(kind, message, opts = {}) {
        super(message);
        this.name = 'AdapterError';
        this.kind = KIND[kind] ? kind : KIND.PERMANENT;
        this.httpStatus = opts.httpStatus ?? null;
        this.platformCode = opts.platformCode ?? null;   // platformun kendi hata kodu
        this.raw = opts.raw ?? null;
        // Adaptör açıkça belirtmediyse kind'a göre karar ver
        this.retryable = opts.retryable != null ? !!opts.retryable : RETRYABLE.has(this.kind);
    }

    static unsupported(method) {
        return new AdapterError(KIND.UNSUPPORTED, `Bu kanal "${method}" işlemini desteklemiyor.`, { retryable: false });
    }
}

module.exports = { AdapterError, KIND, RETRYABLE };
