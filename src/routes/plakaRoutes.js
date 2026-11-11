const router = require('express').Router();
const ctrl = require('../controllers/plakaController');
const { protect, requireRole } = require('../middleware/authMiddleware');

// Masa Plakalari: isletme sahibi ve mudur. Sadece QR Menu paketinde de ACIK (orada plakalar ucretli).
router.use(protect);
router.use(requireRole('OWNER', 'MANAGER'));
router.get('/durum', ctrl.durum);
router.get('/onizleme', ctrl.onizleme);
router.get('/talepler', ctrl.liste);
router.post('/talepler', ctrl.olustur);
router.post('/talepler/:id/iptal', ctrl.iptal);
router.post('/talepler/:id/odeme', ctrl.odemeYaptim);

module.exports = router;
