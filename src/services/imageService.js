const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Yüklenen ürün görselleri volume'da dosya olarak tutulur (base64 DB'de DEĞİL).
// Böylece menü JSON'u hafif kalır, QR menü mobil veride hızlı açılır,
// görseller <img> ile tembel yüklenir ve tarayıcıda cache'lenir.
const UPLOADS_DIR = process.env.NODE_ENV === 'production'
    ? '/app/data/uploads'
    : path.resolve(__dirname, '../../uploads');

function ensureDir(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}
ensureDir(UPLOADS_DIR);

// data:image/...;base64,xxxx → dosyaya yaz, public path döndür (/uploads/...)
// Zaten bir yol/URL ise (data URL değilse) olduğu gibi bırakır.
// Çok büyük base64 (resize edilmemiş) gelirse reddeder.
// async — diske yazım event-loop'u bloklamasın (çok-tenant ortamda eş zamanlı yükleme).
async function saveDataUrl(tenantId, imageUrl) {
    if (!imageUrl || typeof imageUrl !== 'string') return imageUrl || null;
    const m = imageUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
    if (!m) return imageUrl; // data URL değil → dokunma (mevcut yol veya http URL)

    const buf = Buffer.from(m[2], 'base64');
    // Güvenlik: istemci ~900px/q0.8 ile küçültüyor (~150KB). 3MB üstü reddet.
    if (buf.length > 3 * 1024 * 1024) {
        const e = new Error('Görsel çok büyük (max 3MB). Lütfen daha küçük bir görsel seçin.');
        e.status = 413;
        throw e;
    }
    const ext = m[1].toLowerCase() === 'png' ? 'png' : (m[1].toLowerCase() === 'webp' ? 'webp' : 'jpg');
    const dir = path.join(UPLOADS_DIR, tenantId);
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    await fs.promises.writeFile(path.join(dir, name), buf);
    return `/uploads/${tenantId}/${name}`;
}

module.exports = { UPLOADS_DIR, saveDataUrl };
