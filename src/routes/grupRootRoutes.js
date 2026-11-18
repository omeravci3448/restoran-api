const router = require('express').Router();
const ctrl = require('../controllers/rootGrupController');

// Root: sube gruplari. rootRoutes.js icinde TEK satirla ve protectRoot ARKASINDA baglanir:
//   router.use('/gruplar', protectRoot, require('./grupRootRoutes'));
// Ikinci kilit: req.root yoksa (yanlis yere baglanirsa) hicbir uc calismaz.
router.use((req, res, next) => (req.root ? next() : res.status(401).json({ message: 'Bu alan yalnızca ekosistem yöneticisine açıktır.' })));

router.get('/', ctrl.liste);
router.post('/', ctrl.olustur);                              // { ad }
router.patch('/:id', ctrl.adDegistir);                       // { ad }
router.delete('/:id', ctrl.sil);
router.post('/:id/uyeler', ctrl.uyeEkle);                    // { tenantId }
router.delete('/:id/uyeler/:tenantId', ctrl.uyeCikar);
router.get('/:id/adaylar', ctrl.adaylar);                    // uye isletmelerin sahip / mudur kullanicilari
router.post('/:id/yoneticiler', ctrl.yoneticiEkle);          // { eposta, tenantId? } ya da { userId }
router.delete('/:id/yoneticiler/:userId', ctrl.yoneticiCikar);

module.exports = router;
