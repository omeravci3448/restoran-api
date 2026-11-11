const router = require('express').Router();
const ctrl = require('../controllers/mutfakController');
const { protect, requireModule } = require('../middleware/authMiddleware');

// Mutfak ekrani (KDS). Okuma her role acik (garson "hazir" rozeti icin de okur);
// hazirlaniyor/hazir isaretleme mutfak rolleri (OWNER/MANAGER/CASHIER/KITCHEN), servis edildi herkes.
router.use(protect);
router.use(requireModule('BASE'));   // Adisyon ve Kasa (BASE) yoksa: yalniz QR menu isletmesi, POS ucu yok
router.get('/kuyruk', ctrl.kuyruk);
router.post('/kalem/:itemId/durum', ctrl.kalemDurum);
router.post('/siparis/:orderId/durum', ctrl.siparisDurum);

module.exports = router;
