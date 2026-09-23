const router = require('express').Router();
const ctrl = require('../controllers/licenseController');
const { protect, requireManagerPin, requireRole } = require('../middleware/authMiddleware');

// Public — kayıt sayfası ve müşteri için
router.get('/catalog', ctrl.catalog);
router.post('/quote', ctrl.quote);
router.get('/bank-info', ctrl.bankInfo);
router.get('/hub-status', ctrl.hubStatus); // teşhis: hub bağlantısı sağlıklı mı (tarayıcıdan açılır)

// NOT: Hub webhook'u (POST /webhook/purchase) 2026-09-23'te KALDIRILDI.
// Kimlik dogrulamiyordu: gecerli bir tenantId bilen herkes kendine sinirsiz
// lisans yazabiliyor ve pasiflestirilmis bir kiraciyi (is_active=1) diriltebiliyordu.
// Kaldirmak guvenliydi cunku lisans ZATEN her giriste hub'dan tazeleniyor
// (authController -> hubService.refreshTenantLicense). Tek kayip: satin alma
// sonrasi "aninda" yansima, artik bir sonraki giriste oluyor.
// Disaridan lisans tanimlama (SofraMix provizyonu) icin AYRI ve bastan kilitli
// bir uc acilacak; bu uc geri getirilmeyecek.

// Auth + rol + yönetici şifresi — lisans işlemleri kasiyere kapalı
const mgr = [protect, requireRole('OWNER', 'MANAGER'), requireManagerPin];
router.post('/refresh', ...mgr, ctrl.refresh);
// Yalnizca oturum yeterli: yonetici sifresi ISTENMIYOR, cunku bu uc sadece
// 'odemeyi nereden yapacaksiniz' sorusunu cevapliyor ve lisans sayfasi daha
// ManagerGate'i gecmeden once cizilebilmeli.
router.get('/yenileme-kanali', protect, ctrl.yenilemeKanali);
router.post('/purchase', ...mgr, ctrl.purchase);
router.post('/purchases/:id/mark-paid', ...mgr, ctrl.markPaid);
router.get('/purchases', ...mgr, ctrl.purchases);
router.get('/purchases/:id', ...mgr, ctrl.purchaseStatus);

module.exports = router;
