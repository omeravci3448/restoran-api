const router = require('express').Router();
const ctrl = require('../controllers/stockController');
const { protect, requireModule } = require('../middleware/authMiddleware');

router.use(protect);
router.use(requireModule('STOK'));
router.get('/movements', ctrl.movements);
router.get('/current', ctrl.currentStock);
router.get('/low', ctrl.lowStock);
router.post('/move', ctrl.move);

module.exports = router;
