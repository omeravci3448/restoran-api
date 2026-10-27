const router = require('express').Router();
const ctrl = require('../controllers/mutfakController');
const { protect } = require('../middleware/authMiddleware');

// Mutfak ekrani (KDS). Okuma her role acik (garson "hazir" rozeti icin de okur);
// hazirlaniyor/hazir isaretleme mutfak rolleri (OWNER/MANAGER/CASHIER/KITCHEN), servis edildi herkes.
router.use(protect);
router.get('/kuyruk', ctrl.kuyruk);
router.post('/kalem/:itemId/durum', ctrl.kalemDurum);
router.post('/siparis/:orderId/durum', ctrl.siparisDurum);

module.exports = router;
