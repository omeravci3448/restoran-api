const router = require('express').Router();
const ctrl = require('../controllers/orderController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/', ctrl.list);
router.get('/pending-qr', ctrl.pendingQr);           // kasada "yeni QR siparişleri" alanı
router.post('/pending-qr/ack', ctrl.ackPendingQr);   // "gördüm" → alandan düş
router.post('/', ctrl.open);
router.get('/:id', ctrl.get);
router.post('/:id/items', ctrl.addItem);
router.put('/:id/items/:itemId', ctrl.updateItem);
router.delete('/:id/items/:itemId', ctrl.removeItem);
router.post('/:id/close', ctrl.close);
router.post('/:id/cancel', ctrl.cancel);

module.exports = router;
