const router = require('express').Router();
const ctrl = require('../controllers/marketplaceController');
const kur = require('../controllers/channelSetupController');
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

// --- Kanal kurulumu (anahtar + menu aktarimi) - yalniz yonetici ---
const yonetici = requireRole('OWNER', 'MANAGER');
router.get('/adapters', kur.adapters);
router.get('/channels/:id/status', kur.channelStatus);
router.post('/channels/:id/credentials', yonetici, kur.saveCredentials);
router.post('/channels/:id/menu/pull', yonetici, kur.pullMenu);
router.get('/products/:productId/links', kur.productLinks);

module.exports = router;
