const router = require('express').Router();
const { protect } = require('../middleware/authMiddleware');
const D = require('../services/duyuru');

// Isletme paneli: bu kullanicinin bugun gormesi gereken duyurular (root yazar: /api/root/yonetim/duyurular).
// Yalniz okuma; salt-okunur lisansta da calisir. Kapatma tarayicida (localStorage) tutulur.
router.get('/', protect, async (req, res) => {
    res.json(await D.isletmeIcin(req.user));
});

module.exports = router;
