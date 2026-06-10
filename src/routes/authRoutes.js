const router = require('express').Router();
const ctrl = require('../controllers/authController');
const { protect, requireRole } = require('../middleware/authMiddleware');

// İki adımlı kayıt: form → OTP gönder → OTP doğrula → tenant oluştur
router.post('/register/request', ctrl.requestRegistration);
router.post('/register/verify', ctrl.verifyRegistration);
router.post('/register/resend', ctrl.resendOtp);

router.post('/login', ctrl.login);
router.get('/me', protect, ctrl.me);
router.get('/staff', protect, requireRole('OWNER', 'MANAGER'), ctrl.listStaff);
router.post('/staff', protect, requireRole('OWNER', 'MANAGER'), ctrl.createStaff);

// Yönetici şifresi (manager PIN) — rapor/ayar/lisans kilidi
router.get('/manager-status', protect, ctrl.managerStatus);
router.post('/manager-set', protect, ctrl.managerSet);
router.post('/manager-verify', protect, ctrl.managerVerify);

module.exports = router;
