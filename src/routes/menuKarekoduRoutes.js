const express = require('express');
const ctrl = require('../controllers/menuKarekoduController');
const { protect } = require('../middleware/authMiddleware');

// Isletme duzeyi menu karekodu. Iki yonlendirici:
//   panel -> /api/tenant/menu-karekod   (tenantRoutes.js'te tek satir)
//   kamu  -> /api/public/menu           (publicRoutes.js'te tek satir)
const panel = express.Router();
panel.get('/', protect, ctrl.bilgi);
panel.get('/karekod.png', protect, ctrl.png);

const kamu = express.Router();
kamu.get('/:kod', ctrl.kamuMenu);

module.exports = { panel, kamu };
