const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const bus = require('../services/eventBus');

// QR'dan gelen müşteri için bu masanın bağlamını döndür
async function loadTableContext(tenantSlug, qrToken) {
    const r = await query(
        `SELECT te.id AS tenant_id, te.business_name, te.slug, te.license_modules,
                tb.id AS table_id, tb.code AS table_code, tb.name AS table_name, tb.section
           FROM tenants te JOIN tables tb ON tb.tenant_id = te.id
          WHERE te.slug = ? AND tb.qr_token = ? AND te.is_active = 1 AND tb.is_active = 1`,
        [tenantSlug, qrToken]);
    return r.rows[0] || null;
}

function tenantHasModule(ctx, mod) {
    try {
        const arr = JSON.parse(ctx.license_modules || '[]');
        return arr.includes(mod) || arr.includes('ALL');
    } catch (_) { return false; }
}

// Masa bağlamı + menü kategorileri + ürünler
exports.menu = async (req, res) => {
    const { tenantSlug, qrToken } = req.params;
    const ctx = await loadTableContext(tenantSlug, qrToken);
    if (!ctx) return res.status(404).json({ message: 'QR geçersiz veya işletme pasif.' });
    if (!tenantHasModule(ctx, 'MENU_DIGITAL')) {
        return res.status(403).json({ code: 'MODULE_NOT_LICENSED', message: 'Dijital menü modülü aktif değil.' });
    }
    const cats = await query(
        'SELECT id, name, sort_order FROM categories WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order, name',
        [ctx.tenant_id]);
    const prods = await query(
        `SELECT id, category_id, name, description, price, image_url, stock_unit
           FROM products
          WHERE tenant_id = ? AND is_available = 1
          ORDER BY sort_order, name`,
        [ctx.tenant_id]);
    res.json({
        business: { name: ctx.business_name, slug: ctx.slug },
        table: { code: ctx.table_code, name: ctx.table_name, section: ctx.section },
        categories: cats.rows,
        products: prods.rows
    });
};

// Masanın anlık hesabı — müşteri kasaya gitmeden ne ödeyeceğini görsün
exports.bill = async (req, res) => {
    const { tenantSlug, qrToken } = req.params;
    const ctx = await loadTableContext(tenantSlug, qrToken);
    if (!ctx) return res.status(404).json({ message: 'QR geçersiz.' });
    const o = await query(
        "SELECT * FROM orders WHERE tenant_id = ? AND table_id = ? AND status = 'OPEN' LIMIT 1",
        [ctx.tenant_id, ctx.table_id]);
    if (!o.rows.length) return res.json({ items: [], total: 0 });
    const items = await query(
        'SELECT product_name AS name, qty, unit_price, total, status FROM order_items WHERE order_id = ? ORDER BY created_at',
        [o.rows[0].id]);
    res.json({
        orderId: o.rows[0].id,
        openedAt: o.rows[0].opened_at,
        items: items.rows,
        subtotal: o.rows[0].subtotal,
        total: o.rows[0].total
    });
};

// Müşteri kendi siparişini gönderir — STAFF onayı için NEW statüsünde girilir
exports.placeOrder = async (req, res) => {
    const { tenantSlug, qrToken } = req.params;
    const { items = [], note } = req.body;
    if (!items.length) return res.status(400).json({ message: 'Sepet boş.' });

    const ctx = await loadTableContext(tenantSlug, qrToken);
    if (!ctx) return res.status(404).json({ message: 'QR geçersiz.' });

    // Aynı masada açık sipariş varsa onu kullan, yoksa aç
    let orderRow = (await query(
        "SELECT id FROM orders WHERE tenant_id = ? AND table_id = ? AND status = 'OPEN' LIMIT 1",
        [ctx.tenant_id, ctx.table_id])).rows[0];
    let orderId;
    if (orderRow) {
        orderId = orderRow.id;
    } else {
        orderId = uuidv4();
        await query(
            `INSERT INTO orders (id, tenant_id, table_id, channel, status, note)
             VALUES (?, ?, ?, 'DINE_IN', 'OPEN', ?)`,
            [orderId, ctx.tenant_id, ctx.table_id, note || null]);
        await query("UPDATE tables SET status = 'OCCUPIED' WHERE id = ?", [ctx.table_id]);
    }

    let added = 0, subAdded = 0;
    for (const it of items) {
        const p = await query('SELECT * FROM products WHERE id = ? AND tenant_id = ? AND is_available = 1',
            [it.productId, ctx.tenant_id]);
        if (!p.rows.length) continue;
        const prod = p.rows[0];
        const qty = Math.max(1, Number(it.qty || 1));
        const total = qty * Number(prod.price);
        await query(
            `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit, unit_price, total, note, source, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CUSTOMER_QR', 'NEW')`,
            [uuidv4(), orderId, prod.id, prod.name, qty, prod.stock_unit || null, prod.price, total, it.note || null]);
        added++;
        subAdded += total;
    }

    // Toplamları güncelle
    const sumRow = await query('SELECT COALESCE(SUM(total),0) AS s FROM order_items WHERE order_id = ?', [orderId]);
    const s = Number(sumRow.rows[0].s);
    await query('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?', [s, s, orderId]);

    // Kasaya anlık bildirim (yalnızca gerçekten kalem eklendiyse)
    if (added > 0) {
        bus.emit(ctx.tenant_id, 'new_order', {
            orderId, tableId: ctx.table_id, tableName: ctx.table_name,
            tableCode: ctx.table_code, section: ctx.section,
            addedItems: added, addedSubtotal: subAdded, orderTotal: s
        });
    }

    res.status(201).json({ orderId, addedItems: added, addedSubtotal: subAdded, orderTotal: s });
};

// Public garson çağrısı — auth gerekmez, sadece QR token doğrulanır
const waiterCtrl = require('./waiterController');
exports.callWaiter = waiterCtrl.publicCall;
