const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

exports.list = async (req, res) => {
    const r = await query(
        'SELECT * FROM categories WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order, name',
        [req.user.tenantId]);
    res.json(r.rows);
};

exports.create = async (req, res) => {
    const { name, sortOrder } = req.body;
    if (!name) return res.status(400).json({ message: 'Ad zorunlu.' });
    const id = uuidv4();
    await query('INSERT INTO categories (id, tenant_id, name, sort_order) VALUES (?, ?, ?, ?)',
        [id, req.user.tenantId, name, sortOrder || 0]);
    res.status(201).json({ id, name });
};

exports.update = async (req, res) => {
    const { name, sortOrder, isActive } = req.body;
    await query(
        `UPDATE categories SET
            name = COALESCE(?, name),
            sort_order = COALESCE(?, sort_order),
            is_active = COALESCE(?, is_active)
         WHERE id = ? AND tenant_id = ?`,
        [name, sortOrder, isActive, req.params.id, req.user.tenantId]);
    res.json({ message: 'Güncellendi.' });
};

// Akıllı silme:
// - İçinde ürün varsa silme, uyarı dön
// - Hiç ürün yoksa hard delete
exports.remove = async (req, res) => {
    const c = await query('SELECT id FROM categories WHERE id = ? AND tenant_id = ?',
        [req.params.id, req.user.tenantId]);
    if (!c.rows.length) return res.status(404).json({ message: 'Kategori yok.' });

    const used = await query('SELECT COUNT(*) AS c FROM products WHERE category_id = ?',
        [req.params.id]);
    const count = Number(used.rows[0].c);

    if (count > 0) {
        // İçinde ürün varsa sadece pasif yap
        await query('UPDATE categories SET is_active = 0 WHERE id = ?', [req.params.id]);
        return res.status(409).json({
            mode: 'SOFT',
            productCount: count,
            message: `Bu kategoride ${count} ürün var. Önce ürünleri silmeniz veya başka kategoriye taşımanız gerekir. Kategori menüden gizlendi.`
        });
    }
    await query('DELETE FROM categories WHERE id = ?', [req.params.id]);
    res.json({ mode: 'HARD', message: 'Kategori silindi.' });
};
