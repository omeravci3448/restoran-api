const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const ctrl = require('../controllers/rootController');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Root kapısı.
//
// Kiracı jetonu buradan GEÇEMEZ: jetonun içinde scope='root' aranıyor, kiracı
// jetonlarında o alan hiç yok. Tersi de doğru (authMiddleware.protect
// payload.userId arar, root jetonunda userId yoktur) - iki dünya birbirine
// karışmaz.
async function protectRoot(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Token gerekli.' });

    let p;
    try { p = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token geçersiz.' }); }
    if (p.scope !== 'root' || !p.rootId) {
        return res.status(403).json({ message: 'Bu alan yalnızca ekosistem yöneticisine açıktır.' });
    }
    const r = await query('SELECT id, email, name FROM root_users WHERE id = ? AND is_active = 1', [p.rootId]);
    if (!r.rows.length) return res.status(401).json({ message: 'Yetki geçersiz.' });
    req.root = r.rows[0];
    next();
}

router.post('/login', ctrl.login);
router.post('/totp/kurulum', ctrl.totpKur);   // authenticator ilk kurulum (kisa omurlu jetonla)

router.get('/me', protectRoot, ctrl.me);
router.get('/tenants', protectRoot, ctrl.listTenants);
router.post('/tenants', protectRoot, ctrl.createTenant);
router.patch('/tenants/:id', protectRoot, ctrl.updateTenant);
router.post('/tenants/:id/owner-password', protectRoot, ctrl.resetOwnerPassword);

module.exports = router;
