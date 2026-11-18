const router = require('express').Router();
const ctrl = require('../controllers/tableController');
const { protect, requireRole, requireManagerPin } = require('../middleware/authMiddleware');

router.use(protect);
router.get('/', ctrl.list);
router.get('/limit-info', ctrl.limitInfo);
router.get('/karekodlar.pdf', ctrl.karekodlarPdf);   // tum karekodlar, A4 (kisa adresle)
router.get('/lisans-pasif', ctrl.lisansPasifListe);   // lisans siniri yuzunden pasif masalar (services/masaSiniri.js)
router.post('/', requireRole('OWNER', 'MANAGER'), ctrl.create);
router.post('/bulk', requireRole('OWNER', 'MANAGER'), ctrl.bulkCreate);
router.put('/:id', requireRole('OWNER', 'MANAGER'), ctrl.update);
router.delete('/:id', requireRole('OWNER', 'MANAGER'), ctrl.remove);
router.post('/:id/lisans-aktif', requireRole('OWNER', 'MANAGER'), ctrl.lisansAktifEt);   // lisans pasifindeki masayi aktif et
router.get('/:id/qr.png', ctrl.qrPng);
router.post('/:id/regenerate-qr', requireRole('OWNER', 'MANAGER'), ctrl.regenerateToken);
// Kisa kodu yenile: basili plakanin karekodu calismaz olur, bu yuzden yonetici sifresi de istenir
router.post('/:id/kisa-kod-yenile', requireRole('OWNER', 'MANAGER'), requireManagerPin, ctrl.kisaKodYenile);

module.exports = router;
