// --- Genel hata yakalayicinin yaniti (server.js) ---
// Uretimde 500'lu yanitta hatanin ic metni (err.message: SQL, dosya yolu, kutuphane ayrintisi) donmez; genel Turkce
// mesaj doner, tam hata gunluge yazilir (guvenlik incelemesi, dusuk 4). 4xx hatalar bilerek uretilmis kullanici
// mesajidir, oldugu gibi doner. Gelistirmede 500 metni de doner (hata ayiklama).
const GENEL_MESAJ = 'Sunucuda beklenmeyen bir hata oluştu. Lütfen biraz sonra tekrar deneyin.';

function hataYaniti(err, { uretim = process.env.NODE_ENV === 'production' } = {}) {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
        return { durum: 413, govde: { message: 'Gönderilen veri çok büyük. Görseli küçültüp tekrar deneyin.' } };
    }
    const ham = Number(err && (err.status || err.statusCode));
    const durum = ham >= 400 && ham < 600 ? ham : 500;
    if (durum >= 500) return { durum, govde: { message: uretim ? GENEL_MESAJ : ((err && err.message) || 'Sunucu hatası.') } };
    return { durum, govde: { message: (err && err.message) || 'İstek işlenemedi.' } };
}

module.exports = { hataYaniti, GENEL_MESAJ };
