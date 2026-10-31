const { query } = require('../config/db');
const push = require('../services/pushBildirim');

// Telefon bildirimi (Web Push) - garson uygulamasinin "Bildirimler" paneli kullanir.

const OLAY_AD = { garson: 'garson çağrısı', qr: 'QR siparişi' };

// Acik anahtar + bu kullanicinin hangi olaylar icin bildirim alacagi (rol ayarina gore)
exports.durum = async (req, res) => {
    const [anahtar, olaylar] = await Promise.all([push.acikAnahtar(), push.alacagiOlaylar(req.user)]);
    res.json({ publicKey: anahtar, olaylar, rol: req.user.role });
};

exports.abone = async (req, res) => {
    const s = req.body && req.body.subscription;
    const hata = push.abonelikDogrula(s);
    if (hata) return res.status(400).json({ message: hata });
    await push.aboneKaydet(req.user, s, req.headers['user-agent']);
    res.json({ ok: true, olaylar: await push.alacagiOlaylar(req.user) });
};

// Bu cihazin aboneligini kaldir (bildirimi kapat / cikis). Yalniz kendi satiri silinir.
exports.iptal = async (req, res) => {
    const ep = req.body && typeof req.body.endpoint === 'string' ? req.body.endpoint : '';
    if (!ep) return res.status(400).json({ message: 'Bildirim adresi eksik.' });
    await query('DELETE FROM push_abonelikleri WHERE endpoint = ? AND user_id = ?', [ep, req.user.id]);
    res.json({ ok: true });
};

// Deneme bildirimi: yalniz bu kullanicinin cihazlarina. Kisa aralikla tekrar basilirsa reddedilir.
const sonDeneme = new Map(); // userId -> zaman
exports.deneme = async (req, res) => {
    const once = sonDeneme.get(req.user.id) || 0;
    if (Date.now() - once < 10000) return res.status(429).json({ message: 'Biraz bekleyip tekrar deneyin.' });
    sonDeneme.set(req.user.id, Date.now());
    const r = await query('SELECT * FROM push_abonelikleri WHERE user_id = ? AND tenant_id = ?', [req.user.id, req.user.tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Bu hesapta bildirimi açık bir cihaz yok.' });
    const olaylar = await push.alacagiOlaylar(req.user);
    const gonderilen = await push.abonelikleriGonder(r.rows, {
        olay: 'deneme',
        baslik: 'Deneme bildirimi',
        govde: olaylar.length
            ? `Bildirimler çalışıyor. Bu hesap şunlar için bildirim alır: ${olaylar.map((o) => OLAY_AD[o]).join(', ')}.`
            : 'Bildirimler çalışıyor, ama rolünüz için bildirim kapalı. Yöneticiniz POS Ayarlar > Telefon Bildirimleri\'nden açabilir.',
        etiket: 'deneme',
        url: '/garson/',
    }, { TTL: 60 });
    res.json({ ok: gonderilen > 0, cihaz: gonderilen });
};
