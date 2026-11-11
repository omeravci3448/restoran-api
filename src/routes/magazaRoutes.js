const router = require('express').Router();
const ctrl = require('../controllers/magazaController');
const { protect, requireRole, requireManagerPin } = require('../middleware/authMiddleware');

// MDA Yazilim Magazasi - isletme tarafi (/api/magaza). Root tarafi: magazaRootRoutes.js.
// Yalniz isletme sahibi ve mudur. /durum yonetici sifresi istemez (kenar cubugu menuyu cizebilsin);
// geri kalan her uc yonetici sifresi ister (Lisans / Paket sayfasiyla ayni kural).
const yetki = [protect, requireRole('OWNER', 'MANAGER')];
const yonetici = [...yetki, requireManagerPin];

router.get('/durum', ...yetki, ctrl.durum);

// Magaza kapaliyken kapanan uclar
router.get('/urunler', ...yonetici, ctrl.magazaAcik, ctrl.urunler);
router.get('/urunler/:id', ...yonetici, ctrl.magazaAcik, ctrl.urun);
router.post('/sepet', ...yonetici, ctrl.magazaAcik, ctrl.sepet);
router.get('/hazirlik', ...yonetici, ctrl.magazaAcik, ctrl.hazirlik);
router.post('/siparisler', ...yonetici, ctrl.magazaAcik, ctrl.siparisOlustur);

// Siparislerim: magaza kapali olsa da calisir (odemesi beklenen siparis izlenebilmeli)
router.get('/siparisler', ...yonetici, ctrl.siparisler);
router.get('/siparisler/:id', ...yonetici, ctrl.siparis);
router.post('/siparisler/:id/odeme-bildir', ...yonetici, ctrl.odemeBildir);
router.post('/siparisler/:id/iptal', ...yonetici, ctrl.iptal);

module.exports = router;
