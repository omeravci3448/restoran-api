const router = require('express').Router();
const ctrl = require('../controllers/destekController');

// Destek oturumu, isletme paneli tarafi (/api/destek). Root tarafi: yonetimRootRoutes.js (/api/root/yonetim/destek).
router.post('/giris/:jeton', ctrl.giris);                    // acik uc: 60 sn'lik tek kullanimlik jeton -> destek JWT'si
router.get('/oturum', ctrl.destekKimligi, ctrl.oturum);      // serit: isletme adi + kalan sure
router.post('/kapat', ctrl.destekKimligi, ctrl.kapat);       // serit: "Oturumu kapat"

module.exports = router;
