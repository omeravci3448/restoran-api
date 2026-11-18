const router = require('express').Router();
const ctrl = require('../controllers/yonetimController');
const destek = require('../controllers/destekController');

// Root paneli yonetim uclari. rootRoutes.js icinde TEK satirla ve protectRoot ARKASINDA baglanir:
//   router.use('/yonetim', protectRoot, require('./yonetimRootRoutes'));
// Ikinci kilit: req.root yoksa (yanlis yere baglanirsa) hicbir uc calismaz.
router.use((req, res, next) => (req.root ? next() : res.status(401).json({ message: 'Bu alan yalnızca ekosistem yöneticisine açıktır.' })));

router.get('/genel-bakis', ctrl.genelBakis);

router.get('/isletme/:id', ctrl.isletme);
router.post('/isletme/:id/notlar', ctrl.notEkle);
router.delete('/isletme/:id/notlar/:notId', ctrl.notSil);
router.put('/isletme/:id/indirim', ctrl.indirim);
router.post('/isletme/:id/eski-haklar/kaldir', ctrl.eskiHakKaldir);
router.post('/isletme/:id/ek-sure', ctrl.ekSure);   // { gun, not }: rakipten geciste kalan lisans gunleri (services/ekSure.js)

router.get('/ayarlar', ctrl.ayarlar);
router.put('/ayarlar', ctrl.ayarYaz);

router.get('/duyurular', ctrl.duyurular);
router.post('/duyurular', ctrl.duyuruEkle);
router.patch('/duyurular/:id', ctrl.duyuruGuncelle);
router.delete('/duyurular/:id', ctrl.duyuruSil);

router.get('/gunluk', ctrl.gunluk);

router.get('/destek', destek.liste);                 // ?durum=acik&tenantId=
router.post('/destek', destek.ac);                   // { tenantId, sebep } -> 60 sn'lik tek kullanimlik giris jetonu
router.post('/destek/:id/kapat', destek.kapatRoot);

module.exports = router;
