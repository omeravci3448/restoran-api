const router = require('express').Router();
const ctrl = require('../controllers/licenseController');
const { protect } = require('../middleware/authMiddleware');

// Public — kayıt sayfası ve müşteri için
router.get('/catalog', ctrl.catalog);
router.post('/quote', ctrl.quote);
router.get('/bank-info', ctrl.bankInfo);

// Hub'dan webhook (public — Patron'un Hub'ı çağırır)
router.post('/webhook/purchase', ctrl.webhookPurchase);

// Auth gerekli
router.post('/refresh', protect, ctrl.refresh);
router.post('/purchase', protect, ctrl.purchase);
router.post('/purchases/:id/mark-paid', protect, ctrl.markPaid);
router.get('/purchases', protect, ctrl.purchases);
router.get('/purchases/:id', protect, ctrl.purchaseStatus);

module.exports = router;
