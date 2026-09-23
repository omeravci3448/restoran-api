const router = require('express').Router();
const ctrl = require('../controllers/aktivasyonController');

// Kimlik gerektirmez - jetonun KENDISI kimliktir (32 bayt rastgele, 72 saat,
// tek kullanimlik, DB'de yalnizca ozeti durur).
router.get('/:jeton', ctrl.kontrol);
router.post('/:jeton', ctrl.belirle);

module.exports = router;
