const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

// Bekleyen garson çağrılarını listele (personel uygulaması için)
exports.pending = async (req, res) => {
    const r = await query(
        `SELECT w.*, t.code AS table_code, t.name AS table_name, t.section
           FROM waiter_calls w JOIN tables t ON t.id = w.table_id
          WHERE w.tenant_id = ? AND w.status = 'PENDING'
          ORDER BY w.created_at`,
        [req.user.tenantId]);
    res.json(r.rows);
};

exports.handle = async (req, res) => {
    await query(
        `UPDATE waiter_calls
            SET status = 'HANDLED', handled_at = CURRENT_TIMESTAMP, handled_by = ?
          WHERE id = ? AND tenant_id = ?`,
        [req.user.id, req.params.id, req.user.tenantId]);
    res.json({ message: 'Tamamlandı.' });
};

// Public — masadan çağrı (QR menüsünden çağırılır, auth gerekmez)
exports.publicCall = async (req, res) => {
    const { tenantSlug, qrToken } = req.params;
    const reason = (req.body && req.body.reason) || 'GENERIC';
    const t = await query(
        `SELECT tb.id AS table_id, tb.tenant_id
           FROM tables tb JOIN tenants te ON te.id = tb.tenant_id
          WHERE te.slug = ? AND tb.qr_token = ?`,
        [tenantSlug, qrToken]);
    if (!t.rows.length) return res.status(404).json({ message: 'Masa bulunamadı.' });

    const id = uuidv4();
    await query(
        `INSERT INTO waiter_calls (id, tenant_id, table_id, reason) VALUES (?, ?, ?, ?)`,
        [id, t.rows[0].tenant_id, t.rows[0].table_id, reason]);
    res.status(201).json({ id });
};
