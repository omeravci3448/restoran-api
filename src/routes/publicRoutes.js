const router = require('express').Router();
const tanitim = require('../controllers/tanitimController');
const ctrl = require('../controllers/publicController');

// QR menü erişimi — auth gerekmez, masa QR token'ı ile çalışır
router.get('/m/:tenantSlug/:qrToken/menu', ctrl.menu);
router.get('/m/:tenantSlug/:qrToken/bill', ctrl.bill);
router.post('/m/:tenantSlug/:qrToken/orders', ctrl.placeOrder);
router.post('/m/:tenantSlug/:qrToken/waiter', ctrl.callWaiter);

// Tanitim sayfasi deneme talebi (herkese acik, oran sinirli)
router.post('/demo-talep', tanitim.talep);
// 7 gunluk denemeyi ANINDA baslatir: kiraci acilir, sifre belirleme baglantisi gider.
router.post('/deneme', tanitim.denemeBaslat);

module.exports = router;
