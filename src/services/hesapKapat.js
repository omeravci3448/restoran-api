const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

// Hesabi KAPALI yapar: masa (varsa) bosalir, stoklu urunlerde stok duser (OUT hareketi).
// Masadaki "Hesabi Kapat" ile paket siparisinin teslimde kendiliginden kapanmasi AYNI yolu kullanir.
// Odeme toplami = siparis toplami denetimini CAGIRAN yapar. tx ICINDE cagrilmali (tx yeniden girilemez).
// Yalniz ACIK siparis kapanir: iptal edilmis siparis bayat bir odeme penceresinden kapatilamaz, ayni anda
// gelen iki kapatma isteginde ikincisi 409 alir ve stok bir kez duser (degisen satir denetimi).
async function hesabiKapatIc({ orderId, tenantId, userId, tableId }) {
    const u = await query("UPDATE orders SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'OPEN'", [orderId]);
    if (!u.changes) {
        const e = new Error('Sipariş zaten kapanmış ya da iptal edilmiş; ekranı yenileyin.');
        e.status = 409;
        throw e;
    }
    if (tableId) {
        await query("UPDATE tables SET status = 'EMPTY' WHERE id = ?", [tableId]);
    }
    // Stoklu ürünler için OUT hareketi
    const items = await query(
        `SELECT oi.product_id, oi.qty, p.tracks_stock, p.stock_qty
           FROM order_items oi JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ? AND p.tracks_stock = 1`,
        [orderId]);
    for (const it of items.rows) {
        await query(
            `INSERT INTO stock_movements (id, tenant_id, product_id, kind, qty, ref_type, ref_id, created_by)
             VALUES (?, ?, ?, 'OUT', ?, 'ORDER', ?, ?)`,
            [uuidv4(), tenantId, it.product_id, it.qty, orderId, userId || null]);
        await query('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?',
            [it.qty, it.product_id]);
    }
}

module.exports = { hesabiKapatIc };
