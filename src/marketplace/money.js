// Para dönüşümü — TEK giriş noktası.
// Pazaryeri katmanı içinde para DAİMA integer KURUŞ tutulur (float yuvarlama hatası olmasın).
// mda-restoran'ın mevcut orders/order_items tabloları REAL (TL) kullanıyor; sınırda çeviririz.
// Platformlar farklı hassasiyet gönderiyor: Trendyol 2 ondalık, Yemeksepeti 3 ondalık.

// TL (number|string) → kuruş (integer). null/undefined → null.
function toKurus(tl) {
    if (tl == null || tl === '') return null;
    const n = typeof tl === 'string' ? Number(tl.replace(',', '.')) : Number(tl);
    if (!Number.isFinite(n)) return null;
    // 0.5 yukarı yuvarlama — negatifte de mutlak değere göre (iade/indirim satırları negatif olabilir)
    return Math.sign(n) * Math.round(Math.abs(n) * 100);
}

// kuruş (integer) → TL (number, 2 ondalık). Mevcut REAL kolonlara yazarken kullanılır.
function toTL(kurus) {
    if (kurus == null) return null;
    return Math.round(Number(kurus)) / 100;
}

// Kuruş toplamı — güvenli (float toplama yok)
const sumKurus = (arr) => arr.reduce((s, v) => s + (Number(v) || 0), 0);

// Görüntüleme
const fmtTL = (kurus) => (toTL(kurus) ?? 0).toLocaleString('tr-TR', { minimumFractionDigits: 2 }) + ' ₺';

module.exports = { toKurus, toTL, sumKurus, fmtTL };
