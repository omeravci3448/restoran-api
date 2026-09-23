const crypto = require('crypto');

// ——— TOTP (Google Authenticator / Microsoft Authenticator uyumlu) ———
// RFC 4226 (HOTP) + RFC 6238 (TOTP). DIS BAGIMLILIK YOK - Node'un kendi crypto'su yeter.
// Kurulu paket eklemedik cunku sunucu Alpine/musl uzerinde calisiyor ve her yeni
// bagimlilik konteyner acilisinda surpriz cikarabiliyor.
//
// Varsayilanlar authenticator uygulamalarinin bekledigi degerler:
//   algoritma SHA1, 6 hane, 30 saniyelik pencere.

const BASAMAK = 6;
const PENCERE_SN = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// --- base32 (RFC 4648, dolgusuz) ---
function b32Kodla(buf) {
    let bit = 0, deger = 0, cikti = '';
    for (const bayt of buf) {
        deger = (deger << 8) | bayt; bit += 8;
        while (bit >= 5) { cikti += B32[(deger >>> (bit - 5)) & 31]; bit -= 5; }
    }
    if (bit > 0) cikti += B32[(deger << (5 - bit)) & 31];
    return cikti;
}

function b32Coz(s) {
    let bit = 0, deger = 0;
    const cikti = [];
    for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
        const i = B32.indexOf(ch);
        if (i < 0) continue;
        deger = (deger << 5) | i; bit += 5;
        if (bit >= 8) { cikti.push((deger >>> (bit - 8)) & 255); bit -= 8; }
    }
    return Buffer.from(cikti);
}

// 20 bayt (160 bit) rastgele sir - SHA1 blok boyutuna uygun, standart uzunluk.
const sirUret = () => b32Kodla(crypto.randomBytes(20));

// Belirli bir zaman adimi icin kodu hesapla.
function kodUret(sirB32, adim) {
    const anahtar = b32Coz(sirB32);
    const msg = Buffer.alloc(8);
    // 64-bit big-endian sayac. 2038 sonrasi icin ust 32 bit de yaziliyor.
    msg.writeUInt32BE(Math.floor(adim / 0x100000000), 0);
    msg.writeUInt32BE(adim >>> 0, 4);
    const h = crypto.createHmac('sha1', anahtar).update(msg).digest();
    const ofs = h[h.length - 1] & 0x0f;
    const sayi = ((h[ofs] & 0x7f) << 24) | ((h[ofs + 1] & 0xff) << 16)
               | ((h[ofs + 2] & 0xff) << 8) | (h[ofs + 3] & 0xff);
    return String(sayi % 10 ** BASAMAK).padStart(BASAMAK, '0');
}

const suankiAdim = () => Math.floor(Date.now() / 1000 / PENCERE_SN);

// Dogrulama. pencere=1 -> onceki/sonraki 30 sn de kabul (telefon saati kaymasi payi).
// Donen deger: eslesen ADIM (tekrar saldirisini engellemek icin kaydedilir) ya da null.
function dogrula(sirB32, kod, pencere = 1) {
    const temiz = String(kod || '').replace(/\D/g, '');
    if (temiz.length !== BASAMAK) return null;
    const simdi = suankiAdim();
    for (let d = -pencere; d <= pencere; d++) {
        const beklenen = kodUret(sirB32, simdi + d);
        // Sabit zamanli karsilastirma - kod tahmininde zamanlama sizintisi olmasin.
        const a = Buffer.from(beklenen), b = Buffer.from(temiz);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return simdi + d;
    }
    return null;
}

// Authenticator uygulamasinin okudugu baglanti (QR'a gomulur ya da elle girilir).
function otpauthUri({ sir, hesap, kurum = 'MDA Restoran POS' }) {
    const etiket = encodeURIComponent(`${kurum}:${hesap}`);
    const p = new URLSearchParams({ secret: sir, issuer: kurum, algorithm: 'SHA1',
        digits: String(BASAMAK), period: String(PENCERE_SN) });
    return `otpauth://totp/${etiket}?${p.toString()}`;
}

module.exports = { sirUret, kodUret, dogrula, otpauthUri, suankiAdim, b32Kodla, b32Coz, BASAMAK, PENCERE_SN };
