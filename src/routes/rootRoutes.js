const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const ctrl = require('../controllers/rootController');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Root kapısı.
//
// Kiracı jetonu buradan GEÇEMEZ: jetonun içinde scope='root' aranıyor, kiracı
// jetonlarında o alan hiç yok. Tersi de doğru (authMiddleware.protect
// payload.userId arar, root jetonunda userId yoktur) - iki dünya birbirine
// karışmaz.
async function protectRoot(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Token gerekli.' });

    let p;
    try { p = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token geçersiz.' }); }
    if (p.scope !== 'root' || !p.rootId) {
        return res.status(403).json({ message: 'Bu alan yalnızca ekosistem yöneticisine açıktır.' });
    }
    const r = await query('SELECT id, email, name FROM root_users WHERE id = ? AND is_active = 1', [p.rootId]);
    if (!r.rows.length) return res.status(401).json({ message: 'Yetki geçersiz.' });
    req.root = r.rows[0];
    req.rootCihazId = p.cihazId || null;   // oturum cihaz jetonuyla acildiysa (APK) hangi cihaz
    next();
}

router.use(require('../services/yonetimGunlugu').rootAraKatmani);   // yonetim gunlugu: acik kayit yazmayan basarili yazmalar
router.post('/login', ctrl.login);
router.post('/totp/kurulum', ctrl.totpKur);   // authenticator ilk kurulum (kisa omurlu jetonla)

router.get('/me', protectRoot, ctrl.me);
// MDA Yazilim magazasi: urunler, siparisler, ayarlar. Yazmalar icin acik yonetim gunlugu satiri (magaza dosyalarina dokunmadan)
router.use('/magaza', protectRoot, require('../services/magazaYonetimGunlugu').araKatman, require('./magazaRootRoutes'));
// Yonetim APK'si (parmak izi): cihaz jetonu kaydet / jetonla giris / liste / unut
router.post('/cihaz/giris', ctrl.cihazGiris);                 // acik uc: jeton + IP sinirlayici
router.post('/cihaz/kaydet', protectRoot, ctrl.cihazKaydet);
router.get('/cihaz', protectRoot, ctrl.cihazListe);
router.post('/cihaz/unut', protectRoot, ctrl.cihazUnut);
router.post('/cihaz/bildirim-durumu', ctrl.cihazBildirimDurumu);          // acik uc: dar yetkili bildirim jetonu (telefon arka plani)
router.post('/cihaz/bildirim-jetonu', protectRoot, ctrl.cihazBildirimJetonu);
router.get('/tenants', protectRoot, ctrl.listTenants);
router.post('/tenants', protectRoot, ctrl.createTenant);
router.patch('/tenants/:id', protectRoot, ctrl.updateTenant);
router.post('/tenants/:id/owner-password', protectRoot, ctrl.resetOwnerPassword);
router.post('/tenants/:id/lisans-uzat', protectRoot, ctrl.lisansUzat);

// SofraMix POS ödemeleri — lisansın nereden uzadığının ve faturanın dayanağı
router.get('/provizyon', protectRoot, ctrl.provizyonListe);
router.get('/provizyon/ozet', protectRoot, ctrl.provizyonOzet);
router.post('/provizyon/cek', protectRoot, ctrl.provizyonCek);
router.post('/provizyon/:odemeId/tekrar', protectRoot, ctrl.provizyonTekrarDene);
router.post('/provizyon/tenant/:tenantId/posta', protectRoot, ctrl.provizyonPostaYenile);
router.post('/tenants/:tenantId/soframix-bagla', protectRoot, ctrl.soframixBagla);

// Paketler, fiyatlar ve odeme bildirimleri - hub kaldirildi, kaynak burasi
router.get('/katalog', protectRoot, ctrl.katalogListe);
router.patch('/katalog/:id', protectRoot, ctrl.katalogGuncelle);
router.put('/ayarlar', protectRoot, ctrl.ayarGuncelle);
router.get('/lisans-odemeleri', protectRoot, ctrl.lisansOdemeleri);
router.post('/lisans-odemeleri/:id/onayla', protectRoot, ctrl.lisansOdemeOnayla);
router.post('/lisans-odemeleri/:id/reddet', protectRoot, ctrl.lisansOdemeReddet);

// Masa plakasi talepleri (hediye + ucretli): liste, durum, not, baski dosyasi, ayarlar
const plaka = require('../controllers/rootPlakaController');
router.get('/plaka/sayac', protectRoot, plaka.sayac);
router.get('/plaka/ayarlar', protectRoot, plaka.ayarlar);
router.put('/plaka/ayarlar', protectRoot, plaka.ayarYaz);
router.get('/plaka/hak/:tenantId', protectRoot, plaka.hak);
router.get('/plaka/kurallar', protectRoot, plaka.kurallar);
router.get('/plaka/kurallar/onizleme', protectRoot, plaka.kuralOnizleme);
router.post('/plaka/kurallar', protectRoot, plaka.kuralEkle);
router.patch('/plaka/kurallar/:id', protectRoot, plaka.kuralGuncelle);
router.delete('/plaka/kurallar/:id', protectRoot, plaka.kuralSil);
router.get('/plaka/talepler', protectRoot, plaka.liste);
router.get('/plaka/talepler/:id', protectRoot, plaka.getir);
router.get('/plaka/talepler/:id/baski.pdf', protectRoot, plaka.baski);
router.post('/plaka/talepler/:id/durum', protectRoot, plaka.durum);
router.post('/plaka/talepler/:id/not', protectRoot, plaka.not);
router.post('/masalar/:id/kisa-kod-yenile', protectRoot, plaka.masaKisaKodYenile);

// Yonetim: genel bakis, isletme ayrintisi + ic notlar, sistem ayarlari, duyurular, yonetim gunlugu, destek oturumlari
router.use('/yonetim', protectRoot, require('./yonetimRootRoutes'));

module.exports = router;
