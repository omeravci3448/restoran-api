const router = require('express').Router();
const tanitim = require('../controllers/tanitimController');
const ctrl = require('../controllers/publicController');

// QR menü erişimi — auth gerekmez, masa QR token'ı ile çalışır
router.get('/m/:tenantSlug/:qrToken/menu', ctrl.menu);
router.get('/m/:tenantSlug/:qrToken/bill', ctrl.bill);
router.post('/m/:tenantSlug/:qrToken/orders', ctrl.placeOrder);
router.post('/m/:tenantSlug/:qrToken/waiter', ctrl.callWaiter);
// Kisa karekod (plakalar ve toplu karekod PDF'i): /q/<KOD> -> menu adresi
router.get('/q/:kod', ctrl.kisaKodCoz);
router.use('/menu', require('./menuKarekoduRoutes').kamu);   // isletme menu karekodu: yalniz goruntuleme menusu
router.get('/deneme-gun', ctrl.denemeGun);   // "N gun ucretsiz" metinleri icin (Sistem Ayarlari > deneme suresi)
router.get('/lansman', (_req, res, next) => require('../services/lansmanKampanya').herkeseAcik().then((d) => res.json(d)).catch(next));   // tanitim sayfasi kampanya bandi
// Plaka onizlemesinin yazi tipi (baski dosyasindaki Inter ile ayni dosya). Yalniz bu klasor.
router.use('/plaka-yazi', require('express').static(require('../services/plakaCizim').FONT_DIR, {
    maxAge: '30d', immutable: true, index: false,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// Tanitim sayfasi deneme talebi (herkese acik, oran sinirli)
router.post('/demo-talep', tanitim.talep);
// 7 gunluk denemeyi ANINDA baslatir: kiraci acilir, sifre belirleme baglantisi gider.
router.post('/deneme', tanitim.denemeBaslat);
// SofraMix'ten imzali deneme devri (GET: isletme yeni sekmede buraya gelir) + jeton -> JWT degisimi
const devir = require('../controllers/denemeDevirController');
router.get('/soframix-deneme', devir.devir);
router.post('/deneme-giris/:jeton', devir.girisJetonuKullan);
// SofraMix paketleri (herkese acik) + isletmenin lisans durumu (SofraMix sunucusu icin imzali)
const smxPaket = require('../controllers/soframixPaketController');
router.get('/soframix-paketler', smxPaket.paketler);
router.get('/soframix-durum', smxPaket.durum);

module.exports = router;
