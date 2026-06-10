const router = require('express').Router();
const ctrl = require('../controllers/licenseController');
const { protect, requireManagerPin } = require('../middleware/authMiddleware');

// Public — kayıt sayfası ve müşteri için
router.get('/catalog', ctrl.catalog);
router.post('/quote', ctrl.quote);
router.get('/bank-info', ctrl.bankInfo);

// Hub'dan webhook (public — Patron'un Hub'ı çağırır)
router.post('/webhook/purchase', ctrl.webhookPurchase);

// Auth + yönetici şifresi — lisans işlemleri kasiyere kapalı
router.post('/refresh', protect, requireManagerPin, ctrl.refresh);
router.post('/purchase', protect, requireManagerPin, ctrl.purchase);
router.post('/purchases/:id/mark-paid', protect, requireManagerPin, ctrl.markPaid);
router.get('/purchases', protect, requireManagerPin, ctrl.purchases);
router.get('/purchases/:id', protect, requireManagerPin, ctrl.purchaseStatus);

module.exports = router;
