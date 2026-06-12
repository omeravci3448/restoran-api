const router = require('express').Router();
const ctrl = require('../controllers/realtimeController');

// Canlı olay akışı — auth token query'den (EventSource header taşıyamaz)
router.get('/stream', ctrl.stream);

module.exports = router;
