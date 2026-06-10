const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

const VALID_METHODS = ['NAKIT', 'KREDI_KARTI', 'YEMEK_KARTI', 'YEMEKSEPETI', 'TRENDYOL_YEMEK', 'HAVALE', 'DIGER'];

exports.add = async (req, res) => {
    const { orderId, method, amount, ref } = req.body;
    if (!orderId || !method || amount == null) return res.status(400).json({ message: 'orderId, method, amount zorunlu.' });
    if (!VALID_METHODS.includes(method)) return res.status(400).json({ message: 'Geçersiz ödeme yöntemi.', valid: VALID_METHODS });
    if (Number(amount) <= 0) return res.status(400).json({ message: 'Tutar pozitif olmalı.' });

    const o = await query('SELECT id, total FROM orders WHERE id = ? AND tenant_id = ? AND status = "OPEN"',
        [orderId, req.user.tenantId]);
    if (!o.rows.length) return res.status(404).json({ message: 'Açık sipariş bulunamadı.' });

    const existing = await query('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE order_id = ?', [orderId]);
    const already = Number(existing.rows[0].s);
    const orderTotal = Number(o.rows[0].total);
    if (already + Number(amount) > orderTotal + 0.01) {
        return res.status(409).json({
            message: 'Ödeme toplamı sipariş toplamını aşıyor.',
            orderTotal, alreadyPaid: already, attempted: Number(amount)
        });
    }

    const id = uuidv4();
    await query(
        `INSERT INTO payments (id, tenant_id, order_id, method, amount, ref, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.tenantId, orderId, method, amount, ref || null, req.user.id]);
    res.status(201).json({ id, orderId, method, amount });
};

exports.listForOrder = async (req, res) => {
    const r = await query(
        `SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.order_id = ? AND o.tenant_id = ?
          ORDER BY p.created_at`,
        [req.params.orderId, req.user.tenantId]);
    res.json(r.rows);
};

exports.remove = async (req, res) => {
    const r = await query(
        `DELETE FROM payments WHERE id = ? AND tenant_id = ?
           AND order_id IN (SELECT id FROM orders WHERE status = 'OPEN')`,
        [req.params.id, req.user.tenantId]);
    if (!r.changes) return res.status(404).json({ message: 'Silinemedi (kapalı sipariş olabilir).' });
    res.json({ message: 'Silindi.' });
};

exports.methods = (_req, res) => res.json({ methods: VALID_METHODS });
