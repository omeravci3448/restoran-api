const router = require('express').Router();
const { protect, requireAnyModule } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/pushController');
const { destekYasak, BILDIRIM_MESAJI } = require('../services/destekOturumu');
const destekte = destekYasak(BILDIRIM_MESAJI);   // destek oturumunda telefon bildirimi acilmaz (guvenlik incelemesi Y1)

// Telefon bildirimi (Web Push) - her rol kendi cihazini abone eder; kimin alacagina
// isletmenin bildirim_roller ayari karar verir (gonderimde, services/pushBildirim.js).
// Bildirim olaylari garson cagrisi (GARSON) ve QR siparisi (BASE): ikisinden biri olmadan telefon bildirimi yok
const bildirimModulu = requireAnyModule('BASE', 'GARSON');
router.get('/durum', protect, bildirimModulu, ctrl.durum);
router.post('/abone', protect, destekte, bildirimModulu, ctrl.abone);
router.post('/iptal', protect, ctrl.iptal);   // cikista abonelik her zaman silinebilsin
router.post('/deneme', protect, destekte, bildirimModulu, ctrl.deneme);

module.exports = router;
