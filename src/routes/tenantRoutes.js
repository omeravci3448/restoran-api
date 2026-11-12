const router = require('express').Router();
const ctrl = require('../controllers/tenantController');
const { protect, requireRole, requireManagerPin } = require('../middleware/authMiddleware');
const { destekYasak, KAPATMA_MESAJI } = require('../services/destekOturumu');

router.get('/me', protect, ctrl.getProfile); // okuma açık (her sayfa işletme adını okur)
router.put('/me', protect, requireManagerPin, requireRole('OWNER', 'MANAGER'), ctrl.updateProfile);
router.post('/close', protect, destekYasak(KAPATMA_MESAJI), requireManagerPin, requireRole('OWNER', 'MANAGER'), ctrl.requestClosure);

module.exports = router;
