const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');

const VALID_CHANNELS = ['YEMEKSEPETI', 'TRENDYOL_YEMEK', 'GETIR'];

// Yemeksepeti / Trendyol Yemek vb. dış sipariş ingest endpoint'i
// İlerleyen aşamada gerçek webhook entegrasyonu yapılır — şu an manuel girdi de destekler
exports.ingest = async (req, res) => {
    const {
        channel,
        externalRef,
        items = [],
        deliveryFee = 0,
        platformFee = 0,
        note,
        paidVia
    } = req.body;

    if (!VALID_CHANNELS.includes(channel)) {
        return res.status(400).json({ message: 'Geçersiz kanal.', valid: VALID_CHANNELS });
    }
    if (!externalRef) return res.status(400).json({ message: 'externalRef zorunlu (idempotency için).' });
    if (!items.length) return res.status(400).json({ message: 'En az 1 kalem gerekli.' });

    // Aynı externalRef daha önce işlendi mi?
    const dup = await query(
        'SELECT id FROM orders WHERE tenant_id = ? AND channel = ? AND external_ref = ?',
        [req.user.tenantId, channel, externalRef]);
    if (dup.rows.length) return res.status(200).json({ id: dup.rows[0].id, deduped: true });

    const orderId = uuidv4();
    let subtotal = 0;

    await tx(async () => {
        await query(
            `INSERT INTO orders (id, tenant_id, table_id, channel, external_ref, status, note, opened_by)
             VALUES (?, ?, NULL, ?, ?, 'OPEN', ?, ?)`,
            [orderId, req.user.tenantId, channel, externalRef, note || null, req.user.id]);

        for (const it of items) {
            const qty = Number(it.qty || 1);
            const price = Number(it.price || 0);
            const total = qty * price;
            subtotal += total;
            // Ürün id'si geçildiyse eşle, geçilmediyse serbest metin satır olarak ekle
            await query(
                `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price, total, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [uuidv4(), orderId, it.productId || null, it.name || 'Ürün', qty, price, total, channel]);
        }

        // Hizmet/teslimat ücretleri ayrı kalem olarak
        if (Number(deliveryFee) > 0) {
            await query(
                `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price, total, source)
                 VALUES (?, ?, NULL, ?, 1, ?, ?, ?)`,
                [uuidv4(), orderId, 'Teslimat Ücreti', deliveryFee, deliveryFee, channel]);
            subtotal += Number(deliveryFee);
        }

        await query('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?',
            [subtotal, subtotal, orderId]);

        // Pazaryeri siparişleri genelde önceden ödenir — paidVia=PLATFORM ise auto-pay kaydı
        if (paidVia === 'PLATFORM' || paidVia === undefined) {
            await query(
                `INSERT INTO payments (id, tenant_id, order_id, method, amount, ref, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [uuidv4(), req.user.tenantId, orderId, channel, subtotal, externalRef, req.user.id]);
            await query("UPDATE orders SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);
        }
    });

    res.status(201).json({ id: orderId, channel, externalRef, subtotal });
};

// Pazaryeri siparişlerini ayrı listele
exports.list = async (req, res) => {
    const { channel, from, to } = req.query;
    const w = ['o.tenant_id = ?', "o.channel != 'DINE_IN'"];
    const p = [req.user.tenantId];
    if (channel) { w.push('o.channel = ?'); p.push(channel); }
    if (from) { w.push('o.opened_at >= ?'); p.push(from); }
    if (to) { w.push('o.opened_at <= ?'); p.push(to); }
    const r = await query(
        `SELECT o.* FROM orders o WHERE ${w.join(' AND ')}
          ORDER BY o.opened_at DESC LIMIT 200`, p);
    res.json(r.rows);
};

exports.channels = (_req, res) => res.json({ channels: VALID_CHANNELS });
