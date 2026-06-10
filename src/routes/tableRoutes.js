const router = require('express').Router();
const ctrl = require('../controllers/tableController');
const { protect, requireRole } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/', ctrl.list);
router.get('/limit-info', ctrl.limitInfo);
router.post('/', requireRole('OWNER', 'MANAGER'), ctrl.create);
router.post('/bulk', requireRole('OWNER', 'MANAGER'), ctrl.bulkCreate);
router.put('/:id', requireRole('OWNER', 'MANAGER'), ctrl.update);
router.delete('/:id', requireRole('OWNER', 'MANAGER'), ctrl.remove);
router.get('/:id/qr.png', ctrl.qrPng);
router.post('/:id/regenerate-qr', requireRole('OWNER', 'MANAGER'), ctrl.regenerateToken);

module.exports = router;
