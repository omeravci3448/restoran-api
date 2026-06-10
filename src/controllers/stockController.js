const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');

// Stoklu ürünlerin tüm hareketleri
exports.movements = async (req, res) => {
    const { productId, kind, from, to } = req.query;
    const w = ['m.tenant_id = ?'];
    const p = [req.user.tenantId];
    if (productId) { w.push('m.product_id = ?'); p.push(productId); }
    if (kind) { w.push('m.kind = ?'); p.push(kind); }
    if (from) { w.push('m.created_at >= ?'); p.push(from); }
    if (to) { w.push('m.created_at <= ?'); p.push(to); }
    const r = await query(
        `SELECT m.*, p.name AS product_name, p.stock_unit
           FROM stock_movements m JOIN products p ON p.id = m.product_id
          WHERE ${w.join(' AND ')}
          ORDER BY m.created_at DESC
          LIMIT 500`, p);
    res.json(r.rows);
};

// Anlık stok durumu (yalnızca stoklu ürünler)
exports.currentStock = async (req, res) => {
    const r = await query(
        `SELECT id, name, stock_qty, stock_unit, low_stock_threshold, cost,
                (stock_qty <= low_stock_threshold AND low_stock_threshold > 0) AS is_low
           FROM products
          WHERE tenant_id = ? AND tracks_stock = 1
          ORDER BY is_low DESC, name`,
        [req.user.tenantId]);
    res.json(r.rows);
};

// Düşen stok
exports.lowStock = async (req, res) => {
    const r = await query(
        `SELECT id, name, stock_qty, stock_unit, low_stock_threshold
           FROM products
          WHERE tenant_id = ? AND tracks_stock = 1
            AND low_stock_threshold > 0
            AND stock_qty <= low_stock_threshold
          ORDER BY name`,
        [req.user.tenantId]);
    res.json(r.rows);
};

// Stok girişi/sayım/manuel çıkış
exports.move = async (req, res) => {
    const { productId, kind, qty, unitCost, note } = req.body;
    if (!productId || !kind || qty == null) return res.status(400).json({ message: 'productId, kind, qty zorunlu.' });
    if (!['IN', 'OUT', 'COUNT'].includes(kind)) return res.status(400).json({ message: 'kind: IN | OUT | COUNT' });

    const p = await query('SELECT * FROM products WHERE id = ? AND tenant_id = ?',
        [productId, req.user.tenantId]);
    if (!p.rows.length) return res.status(404).json({ message: 'Ürün yok.' });
    if (!p.rows[0].tracks_stock) return res.status(400).json({ message: 'Bu ürün stoksuz olarak işaretli.' });

    const id = uuidv4();
    await tx(async () => {
        await query(
            `INSERT INTO stock_movements (id, tenant_id, product_id, kind, qty, unit_cost, note, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, req.user.tenantId, productId, kind, qty, unitCost || 0, note || null, req.user.id]);

        if (kind === 'IN') {
            await query('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [qty, productId]);
        } else if (kind === 'OUT') {
            await query('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', [qty, productId]);
        } else if (kind === 'COUNT') {
            await query('UPDATE products SET stock_qty = ? WHERE id = ?', [qty, productId]);
        }
    });
    res.status(201).json({ id });
};
