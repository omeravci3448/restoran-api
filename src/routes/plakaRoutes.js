const router = require('express').Router();
const ctrl = require('../controllers/plakaController');
const { protect, requireRole, requireManagerPin } = require('../middleware/authMiddleware');

// Masa Plakalari: isletme sahibi ve mudur. Sadece QR Menu paketinde de ACIK (orada plakalar ucretli).
router.use(protect);
router.use(requireRole('OWNER', 'MANAGER'));
router.get('/durum', ctrl.durum);
router.get('/onizleme', ctrl.onizleme);
router.get('/talepler', ctrl.liste);
// Talep, iptal ve "odemeyi yaptim": lisans satin almadaki gibi yonetici sifresi (ayarlanmissa) istenir
router.post('/talepler', requireManagerPin, ctrl.olustur);
router.post('/talepler/:id/iptal', requireManagerPin, ctrl.iptal);
// Destek oturumunda plaka odeme bildirimi yok (isletmenin kendi beyani; ucretli talep plakaController.olustur'da)
router.post('/talepler/:id/odeme', require('../services/destekOturumu').destekYasak(require('../services/destekOturumu').BEYAN_MESAJI), requireManagerPin, ctrl.odemeYaptim);

module.exports = router;
