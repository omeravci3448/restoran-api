const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/pushController');

// Telefon bildirimi (Web Push) - her rol kendi cihazini abone eder; kimin alacagina
// isletmenin bildirim_roller ayari karar verir (gonderimde, services/pushBildirim.js).
router.get('/durum', protect, ctrl.durum);
router.post('/abone', protect, ctrl.abone);
router.post('/iptal', protect, ctrl.iptal);
router.post('/deneme', protect, ctrl.deneme);

module.exports = router;
