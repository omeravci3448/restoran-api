const router = require('express').Router();
const ctrl = require('../controllers/tenantController');
const { protect, requireRole, requireManagerPin } = require('../middleware/authMiddleware');

router.get('/me', protect, ctrl.getProfile); // okuma açık (her sayfa işletme adını okur)
router.put('/me', protect, requireManagerPin, requireRole('OWNER', 'MANAGER'), ctrl.updateProfile);
router.post('/close', protect, requireManagerPin, requireRole('OWNER', 'MANAGER'), ctrl.requestClosure);

module.exports = router;
