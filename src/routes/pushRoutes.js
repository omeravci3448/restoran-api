const router = require('express').Router();
const { protect, requireAnyModule } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/pushController');

// Telefon bildirimi (Web Push) - her rol kendi cihazini abone eder; kimin alacagina
// isletmenin bildirim_roller ayari karar verir (gonderimde, services/pushBildirim.js).
// Bildirim olaylari garson cagrisi (GARSON) ve QR siparisi (BASE): ikisinden biri olmadan telefon bildirimi yok
const bildirimModulu = requireAnyModule('BASE', 'GARSON');
router.get('/durum', protect, bildirimModulu, ctrl.durum);
router.post('/abone', protect, bildirimModulu, ctrl.abone);
router.post('/iptal', protect, ctrl.iptal);   // cikista abonelik her zaman silinebilsin
router.post('/deneme', protect, bildirimModulu, ctrl.deneme);

module.exports = router;
