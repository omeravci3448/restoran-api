const router = require('express').Router();
const ctrl = require('../controllers/reportController');
const { protect, requireManagerPin, requireRole } = require('../middleware/authMiddleware');

router.use(protect);
router.use(requireRole('OWNER', 'MANAGER')); // kasiyer rol olarak engellenir (PIN kurulmamış olsa bile)
router.use(requireManagerPin);                // + yönetici şifresi katmanı
router.get('/day', ctrl.daySummary);     // ?date=YYYY-MM-DD (default: bugün)
router.get('/month', ctrl.monthSummary); // ?month=YYYY-MM (default: bu ay)
router.get('/z', ctrl.zReport);

module.exports = router;
