const router = require('express').Router();
const ctrl = require('../controllers/licenseController');
const { protect, requireManagerPin, requireRole } = require('../middleware/authMiddleware');

// Public — kayıt sayfası ve müşteri için
router.get('/catalog', ctrl.catalog);
router.post('/quote', ctrl.quote);
router.get('/bank-info', ctrl.bankInfo);

// Hub'dan webhook (public — Patron'un Hub'ı çağırır)
router.post('/webhook/purchase', ctrl.webhookPurchase);

// Auth + rol + yönetici şifresi — lisans işlemleri kasiyere kapalı
const mgr = [protect, requireRole('OWNER', 'MANAGER'), requireManagerPin];
router.post('/refresh', ...mgr, ctrl.refresh);
router.post('/purchase', ...mgr, ctrl.purchase);
router.post('/purchases/:id/mark-paid', ...mgr, ctrl.markPaid);
router.get('/purchases', ...mgr, ctrl.purchases);
router.get('/purchases/:id', ...mgr, ctrl.purchaseStatus);

module.exports = router;
