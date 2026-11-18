const QRCode = require('qrcode');
const { query } = require('../config/db');
const MK = require('../services/menuKarekodu');
const K = require('../services/kisaKod');

// --- Isletme duzeyi menu karekodu (bkz services/menuKarekodu.js) ---

// GET /api/tenant/menu-karekod (oturum): { kod, adres, menuKipi }. Kod yoksa uretilir.
exports.bilgi = async (req, res) => {
    const kod = await MK.kodAl(req.user.tenantId);
    if (!kod) return res.status(404).json({ message: 'İşletme bulunamadı.' });
    const t = (await query('SELECT license_modules FROM tenants WHERE id = ?', [req.user.tenantId])).rows[0] || {};
    res.json({ kod, adres: K.kisaAdres(kod), menuKipi: require('../services/lisansModul').menuKipiMi(t.license_modules) });
};

// GET /api/tenant/menu-karekod/karekod.png (oturum): indirilecek/yazdirilacak karekod gorseli
exports.png = async (req, res) => {
    const kod = await MK.kodAl(req.user.tenantId);
    if (!kod) return res.status(404).json({ message: 'İşletme bulunamadı.' });
    const png = await QRCode.toBuffer(K.kisaAdres(kod), { width: 720, margin: 2, errorCorrectionLevel: 'Q' });
    res.set('Cache-Control', 'no-store');
    res.type('image/png').send(png);
};

// GET /api/public/menu/:kod (herkese acik): yalniz goruntuleme menusu. Kisa kod cozumuyle ayni oran siniri.
exports.kamuMenu = async (req, res) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
    const bitir = K.denemeBaslat(ip);
    if (!bitir) return res.status(429).json({ code: 'COK_FAZLA_ISTEK', message: 'Çok fazla deneme. Lütfen biraz sonra tekrar deneyin.' });
    let t = null;
    try {
        const k = K.normalle(req.params.kod);
        if (k) {
            t = (await query(
                `SELECT id, business_name, slug, logo_url, license_modules, license_end_date, is_active
                   FROM tenants WHERE menu_kisa_kod = ?`, [k])).rows[0] || null;
        }
    } finally { bitir(!!t); }
    res.set('Cache-Control', 'no-store');
    if (!t || Number(t.is_active) !== 1) {
        return res.status(404).json({ code: 'KISA_KOD_YOK', message: 'Bu karekod geçerli değil. Lütfen personele başvurun.' });
    }
    if (!require('../services/lisansModul').varMi(t.license_modules, 'MENU_DIGITAL')) {
        return res.status(403).json({ code: 'MODULE_NOT_LICENSED', message: 'Dijital menü modülü aktif değil.' });
    }
    if (MK.menuKapaliMi(t)) return res.status(410).json(MK.KAPALI_YANIT);
    const v = await MK.menuVerisi(t.id);
    res.json({
        business: { name: t.business_name, slug: t.slug, logo_url: t.logo_url || null },
        table: { code: null, name: null, section: null },
        salt: true,   // isletme karekodu: yalniz goruntuleme
        ozellikler: { siparis: false, garson: false, hesap: false },
        categories: v.categories,
        products: v.products,
    });
};
