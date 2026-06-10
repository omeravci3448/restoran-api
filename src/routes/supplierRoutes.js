const router = require('express').Router();
const ctrl = require('../controllers/supplierController');
const { protect, requireRole, requireModule } = require('../middleware/authMiddleware');

router.use(protect);
router.use(requireModule('STOK'));
router.get('/', ctrl.list);
router.post('/', requireRole('OWNER', 'MANAGER'), ctrl.create);
router.put('/:id', requireRole('OWNER', 'MANAGER'), ctrl.update);
router.delete('/:id', requireRole('OWNER', 'MANAGER'), ctrl.remove);

module.exports = router;
