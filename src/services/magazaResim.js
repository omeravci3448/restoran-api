const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UPLOADS_DIR } = require('./imageService');

// --- Magaza urun resimleri ---
// Resim istemcide (root arayuzu, canvas) uzun kenari en cok 1600 px, ~0,85 kaliteye kucultulup
// data URL olarak TEK TEK yuklenir (sunucuda sharp yok; buyuk govde HTTP/3'te takiliyor).
// Sunucu iki seyi denetler:
//   - tur: yalniz JPG / PNG / WebP. Bildirilen tur ile dosyanin ilk baytlari (imza) uyusmali;
//     "png" diye gonderilen bir SVG/HTML dosyasi diske hic yazilmaz.
//   - boyut: cozulmus dosya en cok 2 MB.
// Dosya /uploads/magaza/<zaman>-<rastgele>.<uzanti> olarak yazilir; ad tahmin edilemez, /uploads
// statik sunumu nosniff ile verir.

const KLASOR = path.join(UPLOADS_DIR, 'magaza');
const ONEK = '/uploads/magaza/';
const EN_FAZLA_BAYT = 2 * 1024 * 1024;

function hata(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

function imzaTuru(buf) {
    if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
    if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
    if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
    return null;
}

// data URL -> { buf, uzanti }. Hata: 400 (tur) / 413 (boyut).
function cozumle(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        throw hata(400, 'Resim verisi gelmedi. JPG, PNG ya da WebP bir dosya seçin.', 'RESIM_TUR');
    }
    const virgul = dataUrl.indexOf(',');
    const bas = virgul > 0 ? dataUrl.slice(0, virgul) : '';
    const m = /^data:image\/(png|jpe?g|webp);base64$/i.exec(bas);
    if (!m) throw hata(400, 'Yalnız JPG, PNG ya da WebP resim yüklenebilir.', 'RESIM_TUR');
    // Cozmeden once kaba sinir: base64 4/3 buyutur
    if (dataUrl.length - virgul - 1 > Math.ceil(EN_FAZLA_BAYT * 4 / 3) + 16) {
        throw hata(413, 'Resim 2 MB sınırını aşıyor. Daha küçük bir resim seçin.', 'RESIM_BOYUT');
    }
    const buf = Buffer.from(dataUrl.slice(virgul + 1), 'base64');
    if (!buf.length) throw hata(400, 'Resim boş.', 'RESIM_TUR');
    if (buf.length > EN_FAZLA_BAYT) throw hata(413, 'Resim 2 MB sınırını aşıyor. Daha küçük bir resim seçin.', 'RESIM_BOYUT');
    const bildirilen = m[1].toLowerCase().startsWith('jp') ? 'jpg' : m[1].toLowerCase();
    const gercek = imzaTuru(buf);
    if (!gercek) throw hata(400, 'Dosyanın içeriği geçerli bir JPG, PNG ya da WebP resmi değil.', 'RESIM_TUR');
    if (gercek !== bildirilen) throw hata(400, 'Dosya türü ile içeriği uyuşmuyor.', 'RESIM_TUR');
    return { buf, uzanti: gercek };
}

async function kaydet(dataUrl) {
    const { buf, uzanti } = cozumle(dataUrl);
    await fs.promises.mkdir(KLASOR, { recursive: true }).catch(() => {});
    const ad = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${uzanti}`;
    await fs.promises.writeFile(path.join(KLASOR, ad), buf);
    return { yol: ONEK + ad, boyut: buf.length };
}

// Yalniz magaza klasorundeki dosya silinir (yol disaridan gelse bile klasor disina cikilamaz).
async function sil(yol) {
    if (!yol || typeof yol !== 'string' || !yol.startsWith(ONEK)) return;
    const ad = path.basename(yol);
    if (!/^[\w.-]+$/.test(ad)) return;
    await fs.promises.unlink(path.join(KLASOR, ad)).catch(() => {});
}

module.exports = { KLASOR, ONEK, EN_FAZLA_BAYT, cozumle, kaydet, sil, imzaTuru };
