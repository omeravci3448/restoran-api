const router = require('express').Router();
const ctrl = require('../controllers/paymentController');
const { protect } = require('../middleware/authMiddleware');

router.get('/methods', ctrl.methods);
router.use(protect);
router.post('/', ctrl.add);
router.get('/order/:orderId', ctrl.listForOrder);
router.delete('/:id', ctrl.remove);

module.exports = router;
