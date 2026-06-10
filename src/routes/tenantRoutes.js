const router = require('express').Router();
const ctrl = require('../controllers/tenantController');
const { protect, requireRole } = require('../middleware/authMiddleware');

router.get('/me', protect, ctrl.getProfile);
router.put('/me', protect, requireRole('OWNER', 'MANAGER'), ctrl.updateProfile);

module.exports = router;
