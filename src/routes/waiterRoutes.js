const router = require('express').Router();
const ctrl = require('../controllers/waiterController');
const { protect, requireModule } = require('../middleware/authMiddleware');

router.use(protect);
router.use(requireModule('GARSON'));
router.get('/calls', ctrl.pending);
router.post('/calls/:id/handle', ctrl.handle);

module.exports = router;
