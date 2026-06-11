const router = require('express').Router();
const ctrl = require('../controllers/marketplaceController');
const { protect, requireModule, requireRole } = require('../middleware/authMiddleware');

router.use(protect);
router.use(requireModule('MARKETPLACE'));

// Sipariş — kasiyer de girebilir
router.get('/orders', ctrl.list);
router.post('/ingest', ctrl.ingest);

// Kanal config — okuma herkese (sipariş girişinde dropdown), değiştirme yöneticiye
router.get('/channels', ctrl.listChannels);
router.post('/channels', requireRole('OWNER', 'MANAGER'), ctrl.createChannel);
router.put('/channels/:id', requireRole('OWNER', 'MANAGER'), ctrl.updateChannel);
router.delete('/channels/:id', requireRole('OWNER', 'MANAGER'), ctrl.deleteChannel);

module.exports = router;
