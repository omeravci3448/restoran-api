const router = require('express').Router();
const ctrl = require('../controllers/marketplaceController');
const { protect, requireModule } = require('../middleware/authMiddleware');

router.get('/channels', ctrl.channels);
router.use(protect);
router.use(requireModule('MARKETPLACE'));
router.get('/orders', ctrl.list);
router.post('/ingest', ctrl.ingest);

module.exports = router;
