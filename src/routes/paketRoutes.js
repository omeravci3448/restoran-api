const router = require('express').Router();
const ctrl = require('../controllers/paketController');
const { protect, requireRole } = require('../middleware/authMiddleware');

// Paket Servis: TEMEL PAKET - requireModule YOK (SofraMix siparisi MARKETPLACE modulu olmadan da
// burada gorunur ve yonetilir). Kasa rolleri (sahip, mudur, kasiyer); mutfak (KITCHEN) ve garson (WAITER)
// GOREMEZ (Patron karari: garsonda paket yok). Salt-okunur lisansta yazma istekleri protect'te durur
// (okuma serbest). Iptal kurali denetleyicide (sahip/mudur; bos telefon siparisi istisna).
router.use(protect);
router.use(requireRole('OWNER', 'MANAGER', 'CASHIER'));
router.get('/', ctrl.liste);
router.post('/', ctrl.olustur);
// Musteri defteri (/:id'den ONCE): telefonla bul (telefon GOVDEDE, adreste degil) + KVKK "Musteriyi unut"
// (yalniz sahip/mudur, gunluge yazilir)
router.post('/musteri/bul', ctrl.musteriBul);
router.post('/musteri/:id/unut', requireRole('OWNER', 'MANAGER'), ctrl.musteriUnut);
router.get('/:id', ctrl.getir);
router.put('/:id', ctrl.guncelle);
router.post('/:id/aksiyon', ctrl.aksiyon);
router.post('/:id/iptal', ctrl.iptal);
// Takilan pazaryeri siparisini platforma gitmeden kapat (sebep zorunlu, gunluk)
router.post('/:id/yerel-kapat', requireRole('OWNER', 'MANAGER'), ctrl.yerelKapat);

module.exports = router;
