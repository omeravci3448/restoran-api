const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

exports.list = async (req, res) => {
    const r = await query('SELECT * FROM suppliers WHERE tenant_id = ? ORDER BY name',
        [req.user.tenantId]);
    res.json(r.rows);
};

exports.create = async (req, res) => {
    const { name, contact, phone, email, note } = req.body;
    if (!name) return res.status(400).json({ message: 'Ad zorunlu.' });
    const id = uuidv4();
    await query(
        `INSERT INTO suppliers (id, tenant_id, name, contact, phone, email, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.tenantId, name, contact || null, phone || null, email || null, note || null]);
    res.status(201).json({ id, name });
};

exports.update = async (req, res) => {
    const f = req.body;
    await query(
        `UPDATE suppliers SET
            name = COALESCE(?, name),
            contact = COALESCE(?, contact),
            phone = COALESCE(?, phone),
            email = COALESCE(?, email),
            note = COALESCE(?, note)
         WHERE id = ? AND tenant_id = ?`,
        [f.name, f.contact, f.phone, f.email, f.note, req.params.id, req.user.tenantId]);
    res.json({ message: 'Güncellendi.' });
};

exports.remove = async (req, res) => {
    await query('DELETE FROM suppliers WHERE id = ? AND tenant_id = ?',
        [req.params.id, req.user.tenantId]);
    res.json({ message: 'Silindi.' });
};
