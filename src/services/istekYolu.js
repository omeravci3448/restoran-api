// --- Guvenlik kararlari ve gunluk etiketleri icin istek yolu (tek yer) ---
// Express rotalari buyuk/kucuk harfe duyarsiz eslestirir ve mutlak istek satirini (POST http://host/api/...) da
// ayni rotaya yonlendirir. Ham req.originalUrl'e bakan kontroller bu bicimlerle atlatilabiliyordu (guvenlik
// incelemesi Y1). Burada istek URL olarak cozulur: yalniz yol, kucuk harf, sondaki / yok, sorgu yok.
function normalYol(req) {
    const ham = String((req && (req.originalUrl || req.url)) || '/');
    let p;
    try { p = new URL(ham, 'http://x').pathname; } catch (_) { p = ham.split('?')[0]; }
    p = String(p || '/').toLowerCase();
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return p || '/';
}

module.exports = { normalYol };
