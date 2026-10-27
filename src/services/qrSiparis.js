const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');

// QR menuden gelen kalemleri masanin acik hesabina yazar (acik hesap yoksa acar).
// Dogrudan modda (onay kapali) da, kasa onayinda da AYNI yol kullanilir; "satista degil" ve
// stok engeli kontrolu tek yerde. Yazilamayan urunler `atlanan` ile doner (sessizce kaybolmaz).
// Not: tx yeniden girilemez (yazma kilidi). Zaten bir tx icindeysen hesabaYazIc'i kullan.
async function hesabaYazIc({ tenantId, tableId, items, note, status = 'NEW', addedBy = null }) {
    const tCfg = await query('SELECT stock_out_blocks_sale FROM tenants WHERE id = ?', [tenantId]);
    const stokEngeli = !!(tCfg.rows[0] && tCfg.rows[0].stock_out_blocks_sale);
    const hazir = [], atlanan = [];
    for (const it of items || []) {
        const qty = Math.max(1, Number(it.qty || 1));
        const p = await query('SELECT * FROM products WHERE id = ? AND tenant_id = ? AND is_available = 1', [it.productId, tenantId]);
        if (!p.rows.length) { atlanan.push(it.name || 'bilinmeyen ürün'); continue; }
        const prod = p.rows[0];
        if (prod.tracks_stock && stokEngeli && Number(prod.stock_qty) < qty) { atlanan.push(prod.name); continue; }
        hazir.push({ prod, qty, note: it.note || null });
    }
    const row = (await query("SELECT id FROM orders WHERE tenant_id = ? AND table_id = ? AND status = 'OPEN' LIMIT 1", [tenantId, tableId])).rows[0];
    let orderId = row ? row.id : null;
    if (!hazir.length) return { orderId, added: 0, subAdded: 0, total: 0, atlanan };
    if (!orderId) {
        orderId = uuidv4();
        await query(`INSERT INTO orders (id, tenant_id, table_id, channel, status, note) VALUES (?, ?, ?, 'DINE_IN', 'OPEN', ?)`,
            [orderId, tenantId, tableId, note || null]);
        await query("UPDATE tables SET status = 'OCCUPIED' WHERE id = ?", [tableId]);
    }
    let added = 0, subAdded = 0;
    for (const { prod, qty, note: n } of hazir) {
        const total = qty * Number(prod.price);
        await query(
            `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit, unit_price, total, note, source, status, added_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CUSTOMER_QR', ?, ?)`,
            [uuidv4(), orderId, prod.id, prod.name, qty, prod.stock_unit || null, prod.price, total, n, status, addedBy]);
        added++; subAdded += total;
    }
    const sumRow = await query('SELECT COALESCE(SUM(total),0) AS s FROM order_items WHERE order_id = ?', [orderId]);
    const s = Number(sumRow.rows[0].s);
    await query('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?', [s, s, orderId]);
    return { orderId, added, subAdded, total: s, atlanan };
}

const hesabaYaz = (args) => tx(() => hesabaYazIc(args));

// Onay bekleyen siparis icin kalemleri fiyatlandirir (yalniz satistaki urunler). Hesaba YAZMAZ.
async function kalemleriHazirla(tenantId, items) {
    const kalemler = [];
    let toplam = 0;
    for (const it of items || []) {
        const p = await query('SELECT id, name, price FROM products WHERE id = ? AND tenant_id = ? AND is_available = 1', [it.productId, tenantId]);
        if (!p.rows.length) continue;
        const qty = Math.max(1, Number(it.qty || 1));
        const total = qty * Number(p.rows[0].price);
        kalemler.push({ productId: p.rows[0].id, name: p.rows[0].name, qty, unitPrice: Number(p.rows[0].price), total, note: it.note || null });
        toplam += total;
    }
    return { kalemler, toplam };
}

module.exports = { hesabaYaz, hesabaYazIc, kalemleriHazirla };
