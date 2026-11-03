const router = require('express').Router();
const ctrl = require('../controllers/paketController');
const { protect, requireRole } = require('../middleware/authMiddleware');

// Paket Servis: TEMEL PAKET - requireModule YOK (SofraMix siparisi MARKETPLACE modulu olmadan da
// burada gorunur ve yonetilir). Mutfak hesabi (KITCHEN) goremez. Salt-okunur lisansta yazma
// istekleri protect'te durur (okuma serbest). Iptal kurali denetleyicide (sahip/mudur; bos telefon
// siparisi istisna).
router.use(protect);
router.use(requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'));
router.get('/', ctrl.liste);
router.post('/', ctrl.olustur);
// Musteri defteri (/:id'den ONCE): telefonla bul + KVKK "Musteriyi unut" (yalniz sahip/mudur, gunluge yazilir)
router.get('/musteri', ctrl.musteriBul);
router.post('/musteri/:id/unut', requireRole('OWNER', 'MANAGER'), ctrl.musteriUnut);
router.get('/:id', ctrl.getir);
router.put('/:id', ctrl.guncelle);
router.post('/:id/aksiyon', ctrl.aksiyon);
router.post('/:id/iptal', ctrl.iptal);

module.exports = router;
