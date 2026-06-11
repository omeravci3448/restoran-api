const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100; // 2 ondalık

// ——————————————————————————————————————————————————————————
// PAZARYERİ KANAL CONFIG (Yemeksepeti/Trendyol/Getir vb.)
// Entegrasyon yok; her kanalın komisyon % + sabit işlem ücreti burada tutulur,
// manuel sipariş girişinde otomatik uygulanır.
// ——————————————————————————————————————————————————————————
exports.listChannels = async (req, res) => {
    const r = await query(
        `SELECT id, name, commission_rate, fixed_fee, is_active
           FROM marketplace_channels WHERE tenant_id = ? ORDER BY name`,
        [req.user.tenantId]);
    res.json(r.rows);
};

exports.createChannel = async (req, res) => {
    const name = String(req.body.name || '').trim();
    const commissionRate = Number(req.body.commissionRate || 0);
    const fixedFee = Number(req.body.fixedFee || 0);
    if (!name) return res.status(400).json({ message: 'Kanal adı zorunlu.' });
    if (name.toUpperCase() === 'DINE_IN') return res.status(400).json({ message: 'Bu ad ayrılmıştır.' });
    if (commissionRate < 0 || commissionRate > 100) return res.status(400).json({ message: 'Komisyon %0–100 arası olmalı.' });
    if (fixedFee < 0) return res.status(400).json({ message: 'İşlem ücreti negatif olamaz.' });
    // Aynı isim mükerrer olmasın
    const dup = await query('SELECT id FROM marketplace_channels WHERE tenant_id = ? AND name = ?', [req.user.tenantId, name]);
    if (dup.rows.length) return res.status(409).json({ message: 'Bu isimde bir kanal zaten var.' });
    const id = uuidv4();
    await query(
        `INSERT INTO marketplace_channels (id, tenant_id, name, commission_rate, fixed_fee, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [id, req.user.tenantId, name, r2(commissionRate), r2(fixedFee)]);
    res.status(201).json({ id, name, commission_rate: r2(commissionRate), fixed_fee: r2(fixedFee), is_active: 1 });
};

exports.updateChannel = async (req, res) => {
    const { id } = req.params;
    const exist = await query('SELECT id FROM marketplace_channels WHERE id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    if (!exist.rows.length) return res.status(404).json({ message: 'Kanal bulunamadı.' });
    const b = req.body;
    if (b.commissionRate != null && (Number(b.commissionRate) < 0 || Number(b.commissionRate) > 100))
        return res.status(400).json({ message: 'Komisyon %0–100 arası olmalı.' });
    if (b.fixedFee != null && Number(b.fixedFee) < 0)
        return res.status(400).json({ message: 'İşlem ücreti negatif olamaz.' });
    await query(
        `UPDATE marketplace_channels
            SET name = COALESCE(?, name),
                commission_rate = COALESCE(?, commission_rate),
                fixed_fee = COALESCE(?, fixed_fee),
                is_active = COALESCE(?, is_active)
          WHERE id = ? AND tenant_id = ?`,
        [b.name != null ? String(b.name).trim() : null,
         b.commissionRate != null ? r2(b.commissionRate) : null,
         b.fixedFee != null ? r2(b.fixedFee) : null,
         b.isActive != null ? (b.isActive ? 1 : 0) : null,
         id, req.user.tenantId]);
    res.json({ message: 'Güncellendi.' });
};

exports.deleteChannel = async (req, res) => {
    const { id } = req.params;
    // Config satırını siler. Geçmiş siparişler kendi kanal adını + dondurulmuş
    // komisyonunu sakladığı için rapor geçmişi bozulmaz.
    await query('DELETE FROM marketplace_channels WHERE id = ? AND tenant_id = ?', [id, req.user.tenantId]);
    res.json({ message: 'Silindi.' });
};

// ——————————————————————————————————————————————————————————
// MANUEL PAZARYERİ SİPARİŞ GİRİŞİ
// Entegrasyon yokken siparişi elle gir: kanal seç → ürünleri tek tek ekle
// (menüden seçilirse maliyet otomatik), komisyon kanal config'inden hesaplanır,
// kurye/zarar gibi ekstra maliyetler eklenir → net kâr çıkar.
// ——————————————————————————————————————————————————————————
exports.ingest = async (req, res) => {
    const {
        channelId,
        externalRef,
        items = [],
        extraCost = 0,
        extraCostNote,
        note,
        paidVia
    } = req.body;

    if (!channelId) return res.status(400).json({ message: 'Kanal seçin.' });
    const chRow = await query(
        'SELECT * FROM marketplace_channels WHERE id = ? AND tenant_id = ?',
        [channelId, req.user.tenantId]);
    if (!chRow.rows.length) return res.status(400).json({ message: 'Geçersiz kanal. Önce Ayarlar > Pazaryeri Kanalları\'ndan ekleyin.' });
    const channel = chRow.rows[0];

    const validItems = items.filter(it => Number(it.qty) > 0 && (it.productId || (it.name && String(it.name).trim())));
    if (!validItems.length) return res.status(400).json({ message: 'En az 1 ürün gerekli.' });

    const ref = (externalRef && String(externalRef).trim()) || ('MAN-' + Date.now());

    // Idempotency: aynı kanal + dış referans tekrar girilirse mükerrer kayıt açma
    const dup = await query(
        'SELECT id FROM orders WHERE tenant_id = ? AND channel = ? AND external_ref = ?',
        [req.user.tenantId, channel.name, ref]);
    if (dup.rows.length) return res.status(200).json({ id: dup.rows[0].id, deduped: true });

    // Ürünleri çöz (menüden seçildiyse ad/fiyat fallback için)
    const resolved = [];
    let subtotal = 0;
    for (const it of validItems) {
        const qty = Number(it.qty);
        let name = it.name && String(it.name).trim();
        let price = Number(it.price);
        if (it.productId) {
            const p = await query('SELECT name, price FROM products WHERE id = ? AND tenant_id = ?',
                [it.productId, req.user.tenantId]);
            if (p.rows.length) {
                if (!name) name = p.rows[0].name;
                if (!(price >= 0) || Number.isNaN(price)) price = Number(p.rows[0].price);
            }
        }
        price = Number(price) || 0;
        const total = r2(qty * price);
        subtotal += total;
        resolved.push({ productId: it.productId || null, name: name || 'Ürün', qty, price, total });
    }
    subtotal = r2(subtotal);

    // Kesintiler — komisyon kanal config'inden, server-side (client'a güvenme)
    const commission = r2(subtotal * Number(channel.commission_rate || 0) / 100);
    const platformFee = r2(channel.fixed_fee || 0);
    const extra = r2(extraCost);

    const orderId = uuidv4();
    await tx(async () => {
        await query(
            `INSERT INTO orders
                (id, tenant_id, table_id, channel, external_ref, status, note,
                 commission_amount, platform_fee, extra_cost, extra_cost_note, opened_by)
             VALUES (?, ?, NULL, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)`,
            [orderId, req.user.tenantId, channel.name, ref, note || null,
             commission, platformFee, extra, extraCostNote || null, req.user.id]);

        for (const it of resolved) {
            await query(
                `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price, total, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [uuidv4(), orderId, it.productId, it.name, it.qty, it.price, it.total, channel.name]);
        }

        await query('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?',
            [subtotal, subtotal, orderId]);

        // Pazaryeri siparişleri genelde platform üzerinden önceden ödenir
        if (paidVia === 'PLATFORM' || paidVia === undefined) {
            await query(
                `INSERT INTO payments (id, tenant_id, order_id, method, amount, ref, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [uuidv4(), req.user.tenantId, orderId, channel.name, subtotal, ref, req.user.id]);
            await query("UPDATE orders SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);
        }
    });

    res.status(201).json({ id: orderId, channel: channel.name, externalRef: ref, subtotal, commission, platformFee, extraCost: extra });
};

// Pazaryeri siparişlerini net kâr ile listele
exports.list = async (req, res) => {
    const { channel, from, to } = req.query;
    const w = ['o.tenant_id = ?', "o.channel != 'DINE_IN'"];
    const p = [req.user.tenantId];
    if (channel) { w.push('o.channel = ?'); p.push(channel); }
    if (from) { w.push('o.opened_at >= ?'); p.push(from); }
    if (to) { w.push('o.opened_at <= ?'); p.push(to); }
    const r = await query(
        `SELECT o.*,
                (SELECT COALESCE(SUM(oi.qty * COALESCE(pr.cost, 0)), 0)
                   FROM order_items oi LEFT JOIN products pr ON pr.id = oi.product_id
                  WHERE oi.order_id = o.id) AS product_cost
           FROM orders o WHERE ${w.join(' AND ')}
          ORDER BY o.opened_at DESC LIMIT 200`, p);
    const rows = r.rows.map(o => {
        const productCost = Number(o.product_cost || 0);
        const commission = Number(o.commission_amount || 0);
        const fee = Number(o.platform_fee || 0);
        const extra = Number(o.extra_cost || 0);
        const netProfit = r2(Number(o.total || 0) - productCost - commission - fee - extra);
        return { ...o, product_cost: r2(productCost), net_profit: netProfit };
    });
    res.json(rows);
};
