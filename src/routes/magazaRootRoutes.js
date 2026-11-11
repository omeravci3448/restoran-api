const router = require('express').Router();
const ctrl = require('../controllers/magazaRootController');

// MDA Yazilim Magazasi - root tarafi. rootRoutes.js icinde TEK satirla ve protectRoot ARKASINDA
// baglanir:  router.use('/magaza', protectRoot, require('./magazaRootRoutes'));
// Ikinci kilit: req.root yoksa (yanlis yere baglanirsa) hicbir uc calismaz.
router.use((req, res, next) => (req.root ? next() : res.status(401).json({ message: 'Bu alan yalnızca ekosistem yöneticisine açıktır.' })));

router.get('/ozet', ctrl.ozet);                               // sekme rozeti: islem bekleyen siparis sayisi

router.get('/urunler', ctrl.urunler);
router.post('/urunler', ctrl.urunEkle);
router.post('/urunler/sirala', ctrl.urunSirala);
router.put('/urunler/:id', ctrl.urunGuncelle);
router.delete('/urunler/:id', ctrl.urunSil);                   // sipariste geciyorsa yumusak silme
router.post('/urunler/:id/resimler', ctrl.resimEkle);          // { veri: data URL } (en cok 2 MB, JPG/PNG/WebP)
router.post('/urunler/:id/resimler/sirala', ctrl.resimSirala);
router.post('/urunler/:id/resimler/:resimId/kapak', ctrl.resimKapak);
router.delete('/urunler/:id/resimler/:resimId', ctrl.resimSil);

router.get('/siparisler', ctrl.siparisler);                    // ?filtre=bekleyen|hazirlanacak|kargoda|teslim|iptal
router.get('/siparisler/:id', ctrl.siparis);
router.post('/siparisler/:id/durum', ctrl.siparisDurum);       // { durum, kargoFirma, kargoTakipNo, sebep }
router.patch('/siparisler/:id', ctrl.siparisGuncelle);         // { icNot, faturaKesildi, faturaNo, kargoFirma, kargoTakipNo }

router.get('/ayarlar', ctrl.ayarlar);
router.put('/ayarlar', ctrl.ayarGuncelle);

module.exports = router;
