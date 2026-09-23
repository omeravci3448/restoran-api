const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');

// ——— Sifre belirleme (aktivasyon) ———
// SofraMix'ten POS paketi satin alinip kiraci acildiginda, sahibine tek
// kullanimlik bir baglanti gider. Duz sifre hicbir yerde uretilmez/saklanmaz;
// sahibi kendi belirler.
//
// Jetonun HAM hali DB'de DURMAZ - yalnizca sha256 ozeti durur. DB sizsa bile
// kimse baglantiyi yeniden kuramaz.

// Deneme siniri IKI anahtarla birden tutuluyor: IP ve JETON.
// Yalniz IP'ye baglansaydi X-Forwarded-For sahtelenebildigi icin tek bir jeton
// sinirsiz denenebilirdi; yalniz jetona baglansaydi rastgele jetonlarla DB
// yorulabilirdi. Ikisi birlikte iki delige de kapi koyuyor.
// (server.js'te trust proxy acik - yoksa req.ip herkes icin ayni cikar ve
//  sinir tek kisiye degil TUM SISTEME uygulanirdi.)
const denemeler = new Map();
const IP_SINIR = 30, JETON_SINIR = 10, PENCERE_MS = 15 * 60 * 1000;

function anahtarlar(req) {
    const jeton = String((req.params && req.params.jeton) || '');
    return [['ip:' + req.ip, IP_SINIR], ['jt:' + jeton.slice(0, 16), JETON_SINIR]];
}
function cokMu(req) {
    return anahtarlar(req).some(([a, sinir]) => {
        const k = denemeler.get(a);
        return Boolean(k && Date.now() < k.sifirlanma && k.sayi >= sinir);
    });
}
function say(req) {
    for (const [a] of anahtarlar(req)) {
        const k = denemeler.get(a);
        if (!k || Date.now() >= k.sifirlanma) denemeler.set(a, { sayi: 1, sifirlanma: Date.now() + PENCERE_MS });
        else k.sayi++;
    }
    if (denemeler.size > 20000) denemeler.clear();
}

function ozetle(ham) {
    return crypto.createHash('sha256').update(String(ham || '')).digest('hex');
}

async function jetonBul(ham) {
    if (!ham || String(ham).length < 20) return null;
    const r = await query(
        `SELECT j.*, t.business_name, t.business_code, u.email
           FROM aktivasyon_jetonlari j
           JOIN tenants t ON t.id = j.tenant_id
           JOIN users   u ON u.id = j.user_id
          WHERE j.jeton_ozet = ?`, [ozetle(ham)]);
    const j = r.rows[0];
    if (!j) return null;
    if (j.kullanildi_at) return { ...j, gecersiz: 'kullanildi' };
    if (new Date(j.son_gecerlilik).getTime() < Date.now()) return { ...j, gecersiz: 'suresi_doldu' };
    return j;
}

// GET /api/aktivasyon/:jeton  -> baglantinin gecerli olup olmadigini soyler
exports.kontrol = async (req, res) => {
    if (cokMu(req)) return res.status(429).json({ message: 'Cok fazla deneme. Baglantiniz gecerliyse birkac dakika sonra tekrar deneyin.' });
    say(req);
    const j = await jetonBul(req.params.jeton);
    if (!j) return res.status(404).json({ gecerli: false, message: 'Baglanti gecersiz.' });
    if (j.gecersiz) {
        return res.status(410).json({
            gecerli: false, sebep: j.gecersiz,
            message: j.gecersiz === 'kullanildi'
                ? 'Bu baglanti daha once kullanilmis. Giris ekranindan sifrenizle girebilirsiniz.'
                : 'Baglantinin suresi dolmus. Bizimle iletisime gecin, yenisini gonderelim.',
        });
    }
    res.json({ gecerli: true, isletme: j.business_name, isyeriKodu: j.business_code, eposta: j.email });
};

// POST /api/aktivasyon/:jeton  { sifre }
exports.belirle = async (req, res) => {
    if (cokMu(req)) return res.status(429).json({ message: 'Cok fazla deneme. Baglantiniz gecerliyse birkac dakika sonra tekrar deneyin.' });
    say(req);
    const sifre = String((req.body || {}).sifre || '');
    if (sifre.length < 8) return res.status(400).json({ message: 'Sifre en az 8 karakter olmali.' });

    const j = await jetonBul(req.params.jeton);
    if (!j) return res.status(404).json({ message: 'Baglanti gecersiz.' });
    if (j.gecersiz) return res.status(410).json({ message: 'Baglanti artik gecerli degil.' });

    await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(sifre, 10), j.user_id]);
    // Tek kullanimlik: once isaretle, sonra ayni kiracinin bekleyen diger
    // jetonlarini da kapat (ikinci posta gitmisse eskisi ise yaramasin).
    await query('UPDATE aktivasyon_jetonlari SET kullanildi_at = ? WHERE id = ?', [new Date().toISOString(), j.id]);
    await query(
        'UPDATE aktivasyon_jetonlari SET kullanildi_at = ? WHERE tenant_id = ? AND kullanildi_at IS NULL',
        [new Date().toISOString(), j.tenant_id]);

    res.json({ ok: true, isyeriKodu: j.business_code, eposta: j.email,
        message: 'Sifreniz belirlendi. Isyeri kodunuz ve e-postanizla giris yapabilirsiniz.' });
};
