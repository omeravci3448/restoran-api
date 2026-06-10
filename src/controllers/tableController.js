const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { query } = require('../config/db');
const hub = require('../services/hubService');

const newToken = () => crypto.randomBytes(16).toString('hex');

// Aktif masa sayısını döndürür (is_active=1)
async function activeTableCount(tenantId) {
    const r = await query('SELECT COUNT(*) AS c FROM tables WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    return Number(r.rows[0].c);
}

// Tier'ın display name'ini hub'dan canlı çek (cache yok — yine de hızlı)
async function fetchTierLabel(tierName) {
    if (!tierName) return '';
    try {
        const cat = await hub.getModulesAndTiers();
        const row = cat.tiers.find(t => t.name === tierName);
        return row?.displayName || tierName;
    } catch (_) { return tierName; }
}

// Verilen kadar daha eklemek lisans sınırını aşıyor mu kontrol eder
// Limit: tenant.license_table_limit (null = sınırsız)
async function checkTableLimit(req, res, addCount = 1) {
    const limit = req.user.licenseTableLimit;
    if (limit == null) return false; // null = sınırsız
    const current = await activeTableCount(req.user.tenantId);
    if (current + addCount > limit) {
        const label = await fetchTierLabel(req.user.licenseTier);
        res.status(403).json({
            code: 'TABLE_LIMIT_REACHED',
            tier: req.user.licenseTier,
            tierLabel: label,
            limit,
            currentCount: current,
            attempted: addCount,
            message: `Lisans paketin (${label}) en fazla ${limit} masaya izin veriyor. Şu an ${current} masan var. Daha fazlası için Lisans sayfasından paketini yükselt.`
        });
        return true;
    }
    return false;
}

exports.list = async (req, res) => {
    const r = await query(
        `SELECT t.*,
                (SELECT id FROM orders o WHERE o.table_id = t.id AND o.status = 'OPEN' LIMIT 1) AS open_order_id,
                (SELECT total FROM orders o WHERE o.table_id = t.id AND o.status = 'OPEN' LIMIT 1) AS open_order_total
           FROM tables t
          WHERE t.tenant_id = ? AND t.is_active = 1
          ORDER BY t.section, t.code`,
        [req.user.tenantId]
    );
    res.json(r.rows);
};

// Ayrı endpoint: yalnızca lisans/limit özetini döndürür
exports.limitInfo = async (req, res) => {
    const limit = req.user.licenseTableLimit;
    const used = await activeTableCount(req.user.tenantId);
    const label = await fetchTierLabel(req.user.licenseTier);
    res.json({
        tier: req.user.licenseTier,
        tierLabel: label,
        limit, // null = sınırsız
        used,
        remaining: limit == null ? null : Math.max(0, limit - used)
    });
};

exports.create = async (req, res) => {
    const { code, name, section, capacity, positionX, positionY } = req.body;
    if (!code || !name) return res.status(400).json({ message: 'Kod ve ad zorunlu.' });
    if (await checkTableLimit(req, res, 1)) return;
    const id = uuidv4();
    try {
        await query(
            `INSERT INTO tables (id, tenant_id, code, name, section, capacity, qr_token, position_x, position_y)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, req.user.tenantId, code, name, section || null, capacity || 4, newToken(), positionX || 0, positionY || 0]
        );
        res.status(201).json({ id, code, name });
    } catch (e) {
        if (String(e.message).includes('UNIQUE')) return res.status(409).json({ message: 'Bu masa kodu zaten kullanılıyor.' });
        throw e;
    }
};

exports.bulkCreate = async (req, res) => {
    const { count, prefix = 'M', section } = req.body;
    if (!count || count < 1 || count > 100) return res.status(400).json({ message: 'count 1-100 arası.' });
    if (await checkTableLimit(req, res, Number(count))) return;
    const created = [];
    for (let i = 1; i <= count; i++) {
        const code = `${prefix}${i}`;
        const id = uuidv4();
        try {
            await query(
                `INSERT INTO tables (id, tenant_id, code, name, section, qr_token)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [id, req.user.tenantId, code, `Masa ${code}`, section || null, newToken()]
            );
            created.push({ id, code });
        } catch (_) { /* zaten varsa atla */ }
    }
    res.status(201).json({ created });
};

exports.update = async (req, res) => {
    const { name, section, capacity, positionX, positionY, isActive } = req.body;
    // Pasif masayı yeniden aktive ediyorsa limit kontrolü gerek
    if (isActive === true || isActive === 1) {
        const cur = await query('SELECT is_active FROM tables WHERE id = ? AND tenant_id = ?',
            [req.params.id, req.user.tenantId]);
        if (cur.rows.length && !cur.rows[0].is_active) {
            if (await checkTableLimit(req, res, 1)) return;
        }
    }
    await query(
        `UPDATE tables
            SET name = COALESCE(?, name),
                section = COALESCE(?, section),
                capacity = COALESCE(?, capacity),
                position_x = COALESCE(?, position_x),
                position_y = COALESCE(?, position_y),
                is_active = COALESCE(?, is_active)
          WHERE id = ? AND tenant_id = ?`,
        [name, section, capacity, positionX, positionY, isActive, req.params.id, req.user.tenantId]
    );
    res.json({ message: 'Güncellendi.' });
};

exports.remove = async (req, res) => {
    await query('UPDATE tables SET is_active = 0 WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenantId]);
    res.json({ message: 'Pasifleştirildi.' });
};

// QR kod PNG döndür (her masa için)
exports.qrPng = async (req, res) => {
    const r = await query(
        'SELECT t.qr_token, te.slug FROM tables t JOIN tenants te ON te.id = t.tenant_id WHERE t.id = ? AND t.tenant_id = ?',
        [req.params.id, req.user.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Masa yok.' });
    const base = req.query.publicBase || process.env.QR_PUBLIC_BASE || 'https://restoran.mdayazilim.com';
    const url = `${base}/m/${r.rows[0].slug}/${r.rows[0].qr_token}`;
    const png = await QRCode.toBuffer(url, { width: 480, margin: 1 });
    res.type('image/png').send(png);
};

exports.regenerateToken = async (req, res) => {
    const token = newToken();
    await query('UPDATE tables SET qr_token = ? WHERE id = ? AND tenant_id = ?',
        [token, req.params.id, req.user.tenantId]);
    res.json({ qrToken: token });
};
