const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');

// Sipariş toplamlarını yeniden hesaplayıp orders satırını günceller
async function recomputeTotals(orderId) {
    const it = await query('SELECT qty, unit_price FROM order_items WHERE order_id = ?', [orderId]);
    const sub = it.rows.reduce((s, r) => s + Number(r.qty) * Number(r.unit_price), 0);
    // KDV/discount basit tutuluyor — KDV ürün satışına dahil kabul ediliyor (gross)
    const tx_total = 0;
    const total = sub - 0;
    await query('UPDATE orders SET subtotal = ?, tax_total = ?, total = ? WHERE id = ?',
        [sub, tx_total, total, orderId]);
    return { sub, total };
}

// Aktif (OPEN) sipariş listesi
exports.list = async (req, res) => {
    const { status, channel, from, to } = req.query;
    const w = ['o.tenant_id = ?'];
    const p = [req.user.tenantId];
    if (status) { w.push('o.status = ?'); p.push(status); }
    if (channel) { w.push('o.channel = ?'); p.push(channel); }
    if (from) { w.push('o.opened_at >= ?'); p.push(from); }
    if (to) { w.push('o.opened_at <= ?'); p.push(to); }
    const r = await query(
        `SELECT o.*, t.code AS table_code, t.name AS table_name
           FROM orders o LEFT JOIN tables t ON t.id = o.table_id
          WHERE ${w.join(' AND ')}
          ORDER BY o.opened_at DESC
          LIMIT 200`, p);
    res.json(r.rows);
};

exports.get = async (req, res) => {
    const o = await query(
        `SELECT o.*, t.code AS table_code, t.name AS table_name
           FROM orders o LEFT JOIN tables t ON t.id = o.table_id
          WHERE o.id = ? AND o.tenant_id = ?`,
        [req.params.id, req.user.tenantId]);
    if (!o.rows.length) return res.status(404).json({ message: 'Sipariş yok.' });
    const items = await query('SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at', [req.params.id]);
    const pays = await query('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at', [req.params.id]);
    res.json({ ...o.rows[0], items: items.rows, payments: pays.rows });
};

// Yeni sipariş aç — masa için 1 aktif sipariş prensibi (aynı masada açık varsa onu döndür)
exports.open = async (req, res) => {
    const { tableId, channel = 'DINE_IN', externalRef, note } = req.body;
    if (channel === 'DINE_IN') {
        if (!tableId) return res.status(400).json({ message: 'Masa ID gerekli.' });
        const exist = await query(
            "SELECT * FROM orders WHERE tenant_id = ? AND table_id = ? AND status = 'OPEN' LIMIT 1",
            [req.user.tenantId, tableId]);
        if (exist.rows.length) return res.json(exist.rows[0]);
    }
    const id = uuidv4();
    await query(
        `INSERT INTO orders (id, tenant_id, table_id, channel, external_ref, note, opened_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.tenantId, tableId || null, channel, externalRef || null, note || null, req.user.id]);
    if (tableId) await query("UPDATE tables SET status = 'OCCUPIED' WHERE id = ?", [tableId]);
    res.status(201).json({ id, tableId, channel, status: 'OPEN' });
};

exports.addItem = async (req, res) => {
    const { productId, qty = 1, note, unitPriceOverride } = req.body;
    const o = await query("SELECT * FROM orders WHERE id = ? AND tenant_id = ?",
        [req.params.id, req.user.tenantId]);
    if (!o.rows.length) return res.status(404).json({ message: 'Sipariş yok.' });
    if (o.rows[0].status !== 'OPEN') return res.status(409).json({ message: 'Sipariş kapalı, ekleme yapılamaz.' });

    const p = await query('SELECT * FROM products WHERE id = ? AND tenant_id = ?',
        [productId, req.user.tenantId]);
    if (!p.rows.length) return res.status(404).json({ message: 'Ürün yok.' });
    const prod = p.rows[0];

    const unit = unitPriceOverride != null ? Number(unitPriceOverride) : Number(prod.price);
    const total = Number(qty) * unit;
    const itemId = uuidv4();

    await query(
        `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit, unit_price, total, note, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemId, req.params.id, prod.id, prod.name, qty, prod.stock_unit || null, unit, total, note || null, req.body.source || 'STAFF']);

    await recomputeTotals(req.params.id);
    res.status(201).json({ id: itemId, productId, qty, unit, total });
};

exports.removeItem = async (req, res) => {
    const r = await query(
        `DELETE FROM order_items
          WHERE id = ? AND order_id IN (SELECT id FROM orders WHERE id = ? AND tenant_id = ?)`,
        [req.params.itemId, req.params.id, req.user.tenantId]);
    if (!r.changes) return res.status(404).json({ message: 'Kalem yok.' });
    await recomputeTotals(req.params.id);
    res.json({ message: 'Silindi.' });
};

exports.updateItem = async (req, res) => {
    const { qty, note, status } = req.body;
    const it = await query(
        `SELECT oi.* FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE oi.id = ? AND o.tenant_id = ?`,
        [req.params.itemId, req.user.tenantId]);
    if (!it.rows.length) return res.status(404).json({ message: 'Kalem yok.' });
    const cur = it.rows[0];
    const newQty = qty != null ? Number(qty) : Number(cur.qty);
    const newTotal = newQty * Number(cur.unit_price);
    await query(
        `UPDATE order_items SET qty = ?, total = ?, note = COALESCE(?, note), status = COALESCE(?, status)
         WHERE id = ?`,
        [newQty, newTotal, note, status, req.params.itemId]);
    await recomputeTotals(req.params.id);
    res.json({ message: 'Güncellendi.' });
};

// Hesabı kapat: ödeme toplamı sipariş toplamına eşit olmalı
// Stoklu ürünler için stok düşümü kaydı oluşturur
exports.close = async (req, res) => {
    const { id } = req.params;
    const o = await query('SELECT * FROM orders WHERE id = ? AND tenant_id = ?',
        [id, req.user.tenantId]);
    if (!o.rows.length) return res.status(404).json({ message: 'Sipariş yok.' });
    if (o.rows[0].status === 'CLOSED') return res.json({ message: 'Zaten kapalı.' });

    const totalRow = await query('SELECT total FROM orders WHERE id = ?', [id]);
    const orderTotal = Number(totalRow.rows[0].total || 0);
    const paid = await query('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE order_id = ?', [id]);
    const paidTotal = Number(paid.rows[0].s);

    if (Math.abs(paidTotal - orderTotal) > 0.01) {
        return res.status(409).json({
            message: 'Ödeme toplamı sipariş toplamıyla eşleşmiyor.',
            orderTotal, paidTotal
        });
    }

    await tx(async () => {
        await query("UPDATE orders SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
        if (o.rows[0].table_id) {
            await query("UPDATE tables SET status = 'EMPTY' WHERE id = ?", [o.rows[0].table_id]);
        }
        // Stoklu ürünler için OUT hareketi
        const items = await query(
            `SELECT oi.product_id, oi.qty, p.tracks_stock, p.stock_qty
               FROM order_items oi JOIN products p ON p.id = oi.product_id
              WHERE oi.order_id = ? AND p.tracks_stock = 1`,
            [id]);
        for (const it of items.rows) {
            await query(
                `INSERT INTO stock_movements (id, tenant_id, product_id, kind, qty, ref_type, ref_id, created_by)
                 VALUES (?, ?, ?, 'OUT', ?, 'ORDER', ?, ?)`,
                [require('uuid').v4(), req.user.tenantId, it.product_id, it.qty, id, req.user.id]);
            await query('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?',
                [it.qty, it.product_id]);
        }
    });

    res.json({ message: 'Sipariş kapatıldı.', orderTotal, paidTotal });
};

exports.cancel = async (req, res) => {
    const { id } = req.params;
    const o = await query('SELECT * FROM orders WHERE id = ? AND tenant_id = ?',
        [id, req.user.tenantId]);
    if (!o.rows.length) return res.status(404).json({ message: 'Sipariş yok.' });
    if (o.rows[0].status === 'CLOSED') return res.status(409).json({ message: 'Kapalı sipariş iptal edilemez.' });
    await query("UPDATE orders SET status = 'CANCELLED', closed_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    if (o.rows[0].table_id) await query("UPDATE tables SET status = 'EMPTY' WHERE id = ?", [o.rows[0].table_id]);
    res.json({ message: 'İptal edildi.' });
};

// Müşterinin QR'dan gönderdiği, henüz görülmemiş sipariş kalemleri — masaya göre.
// Kasada "yeni siparişler" alanında ne ısmarlandığı görünür.
exports.pendingQr = async (req, res) => {
    const r = await query(
        `SELECT oi.id, oi.order_id, oi.product_name, oi.qty, oi.unit_price, oi.total, oi.note, oi.created_at,
                o.table_id, t.name AS table_name, t.code AS table_code, t.section
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN tables t ON t.id = o.table_id
          WHERE o.tenant_id = ? AND o.status = 'OPEN'
            AND oi.source = 'CUSTOMER_QR' AND oi.status = 'NEW'
          ORDER BY oi.created_at`,
        [req.user.tenantId]);
    res.json(r.rows);
};

// "Gördüm/Hazırlanıyor" — bir masanın yeni QR kalemlerini görüldü işaretle (alandan düşsün).
exports.ackPendingQr = async (req, res) => {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ message: 'orderId gerekli.' });
    const r = await query(
        `UPDATE order_items SET status = 'SEEN'
          WHERE source = 'CUSTOMER_QR' AND status = 'NEW'
            AND order_id = ?
            AND order_id IN (SELECT id FROM orders WHERE tenant_id = ?)`,
        [orderId, req.user.tenantId]);
    res.json({ ok: true, updated: r.changes || 0 });
};
