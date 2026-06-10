const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// JWT doğrula + tenant'ı yükle + lisans tarihini kontrol et
async function protect(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Token gerekli.' });

    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token geçersiz.' }); }

    const userRes = await query(
        `SELECT u.*, t.id as tenant_id, t.business_name, t.license_end_date,
                t.license_modules, t.license_tier, t.license_table_limit,
                t.is_active as tenant_active
           FROM users u JOIN tenants t ON t.id = u.tenant_id
          WHERE u.id = ?`,
        [payload.userId]
    );
    if (!userRes.rows.length) return res.status(401).json({ message: 'Kullanıcı bulunamadı.' });
    const u = userRes.rows[0];

    if (!u.is_active) return res.status(403).json({ message: 'Kullanıcı pasif.' });
    if (!u.tenant_active) return res.status(403).json({ code: 'TENANT_INACTIVE', message: 'İşletme pasif (lisans).' });

    // Lisans bitiş kontrolü — license_end_date varsa
    if (u.license_end_date) {
        const end = new Date(u.license_end_date);
        if (Date.now() > end.getTime()) {
            return res.status(403).json({ code: 'LICENSE_EXPIRED', message: 'Lisans süresi dolmuş.' });
        }
    }

    let modules = [];
    try { modules = u.license_modules ? JSON.parse(u.license_modules) : []; } catch (_) {}

    req.user = {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        tenantId: u.tenant_id,
        businessName: u.business_name,
        licenseTier: u.license_tier,
        licenseTableLimit: u.license_table_limit, // null = sınırsız
        modules
    };
    next();
}

// Belirli bir modülün lisansta açık olmasını ister (örn requireModule('STOK'))
function requireModule(moduleName) {
    return (req, res, next) => {
        const mods = req.user?.modules || [];
        if (mods.includes(moduleName) || mods.includes('ALL')) return next();
        return res.status(403).json({
            code: 'MODULE_NOT_LICENSED',
            module: moduleName,
            message: `${moduleName} modülü lisansta açık değil.`
        });
    };
}

// Belirli rolleri ister
function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
            return res.status(403).json({ message: 'Bu işlem için yetkiniz yok.' });
        }
        next();
    };
}

// Yönetici şifresi ister — kasiyerlerin rapor/ayar/lisans sayfalarına
// erişmesini engeller. x-manager-pin header'ı tenant.manager_pin (hash) ile
// karşılaştırılır. PIN henüz hiç ayarlanmadıysa erişime izin verir (ilk kurulum
// için; sahip Ayarlar'dan PIN belirleyince koruma devreye girer).
const bcryptMw = require('bcryptjs');
function requireManagerPin(req, res, next) {
    query('SELECT manager_pin FROM tenants WHERE id = ?', [req.user.tenantId])
        .then(async (r) => {
            const hash = r.rows[0]?.manager_pin;
            if (!hash) return next(); // henüz ayarlanmamış → açık (ilk kurulum)
            const pin = req.headers['x-manager-pin'] || '';
            const ok = pin && await bcryptMw.compare(String(pin), hash);
            if (ok) return next();
            return res.status(403).json({ code: 'MANAGER_PIN_REQUIRED', message: 'Yönetici şifresi gerekli.' });
        })
        .catch(() => res.status(500).json({ message: 'Yetki kontrolü hatası.' }));
}

function signToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '12h' });
}

module.exports = { protect, requireModule, requireRole, requireManagerPin, signToken };
