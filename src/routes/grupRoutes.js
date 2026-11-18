const router = require('express').Router();
const ctrl = require('../controllers/grupController');
const { protect, requireRole, requireManagerPin } = require('../middleware/authMiddleware');
const { destekYasak } = require('../services/destekOturumu');

// Sube grubu (/api/grup): grup yoneticisi diger subelerin toplam rakamlarini gorur.
// Destek oturumunda KAPALI: destek tek isletmeye acilir, gruptaki diger isletmelere uzanmamali.
router.use(protect);
router.use(destekYasak('Şube grubu ekranı destek oturumunda açılmaz.'));
// Yalniz isletme sahibi (grup yoneticisi yalniz OWNER olabilir; eski kayitta kalan mudur yoneticiligi de gecmez)
router.use(requireRole('OWNER'));
router.get('/ben', ctrl.ben);
router.get('/ozet', requireManagerPin, ctrl.ozet);   // ?bas=YYYY-MM-DD&bit=YYYY-MM-DD (Istanbul gunleri, en fazla 93 gun)

module.exports = router;
