const router = require('express').Router();
const ctrl = require('../controllers/reportController');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/day', ctrl.daySummary);     // ?date=YYYY-MM-DD (default: bugün)
router.get('/month', ctrl.monthSummary); // ?month=YYYY-MM (default: bu ay)
router.get('/z', ctrl.zReport);

module.exports = router;
