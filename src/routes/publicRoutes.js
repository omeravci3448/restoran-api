const router = require('express').Router();
const ctrl = require('../controllers/publicController');

// QR menü erişimi — auth gerekmez, masa QR token'ı ile çalışır
router.get('/m/:tenantSlug/:qrToken/menu', ctrl.menu);
router.get('/m/:tenantSlug/:qrToken/bill', ctrl.bill);
router.post('/m/:tenantSlug/:qrToken/orders', ctrl.placeOrder);
router.post('/m/:tenantSlug/:qrToken/waiter', ctrl.callWaiter);

module.exports = router;
