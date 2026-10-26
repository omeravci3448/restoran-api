const router = require('express').Router();
const ctrl = require('../controllers/paymentController');
const { protect, requireRole } = require('../middleware/authMiddleware');

router.get('/methods', ctrl.methods);
router.use(protect);
router.post('/', ctrl.add);
router.post('/by-items', ctrl.payByItems);   // kalem seçerek tahsilat
router.get('/order/:orderId', ctrl.listForOrder);
router.delete('/:id', requireRole('OWNER', 'MANAGER'), ctrl.remove);   // odeme silme yalniz sahip/mudur, gunluge yazilir

module.exports = router;
