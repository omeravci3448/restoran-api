const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
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

// Kalem bazlı tahsilat — müşteri "şunu şunu yedim" der, kasiyer o kalemleri seçer.
// Seçili kalemlerin (kısmi adet olabilir) tutarını hesaplar, paid_qty'yi artırır ve
// tek bir ödeme kaydı yazar. Böylece masada herkes kendi yediğini öder, kalan kalemler
// bir sonraki kişiye görünür. ref'e kalem dökümü gömülür ki ödeme silinince geri alınabilsin.
exports.payByItems = async (req, res) => {
    const { orderId, method, items, note } = req.body;
    if (!orderId || !method) return res.status(400).json({ message: 'orderId ve method zorunlu.' });
    if (!VALID_METHODS.includes(method)) return res.status(400).json({ message: 'Geçersiz ödeme yöntemi.', valid: VALID_METHODS });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ message: 'En az 1 kalem seçin.' });

    const o = await query('SELECT id, total FROM orders WHERE id = ? AND tenant_id = ? AND status = "OPEN"',
        [orderId, req.user.tenantId]);
    if (!o.rows.length) return res.status(404).json({ message: 'Açık sipariş bulunamadı.' });

    const id = uuidv4();
    let amount = 0;
    const applied = [];
    try {
        await tx(async () => {
            for (const sel of items) {
                const qtySel = Number(sel.qty);
                if (!(qtySel > 0)) continue;
                const r = await query(
                    'SELECT id, qty, COALESCE(paid_qty,0) AS paid_qty, unit_price FROM order_items WHERE id = ? AND order_id = ?',
                    [sel.itemId, orderId]);
                if (!r.rows.length) throw new Error('Seçilen kalem bu siparişte yok.');
                const it = r.rows[0];
                const remaining = Number(it.qty) - Number(it.paid_qty);
                if (qtySel > remaining + 1e-6) throw new Error('Seçilen adet, kalemin kalan adedinden fazla.');
                amount = r2(amount + qtySel * Number(it.unit_price));
                await query('UPDATE order_items SET paid_qty = COALESCE(paid_qty,0) + ? WHERE id = ?', [qtySel, it.id]);
                applied.push({ itemId: it.id, qty: qtySel });
            }
            if (!applied.length || amount <= 0) throw new Error('Geçerli kalem seçilmedi.');

            // Aşım koruması (manuel ödemelerle karışık kullanımda da)
            const ex = await query('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE order_id = ?', [orderId]);
            if (Number(ex.rows[0].s) + amount > Number(o.rows[0].total) + 0.01) {
                throw new Error('Ödeme toplamı sipariş toplamını aşıyor.');
            }

            await query(
                `INSERT INTO payments (id, tenant_id, order_id, method, amount, ref, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [id, req.user.tenantId, orderId, method, amount, JSON.stringify({ byItems: applied, note: note || null }), req.user.id]);
        });
    } catch (e) {
        return res.status(409).json({ message: e.message || 'Tahsilat başarısız.' });
    }
    res.status(201).json({ id, orderId, method, amount, items: applied });
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
    // Önce ödemeyi al (kalem dökümü varsa paid_qty'yi geri almak için)
    const p = await query(
        `SELECT p.id, p.ref, p.order_id
           FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.id = ? AND p.tenant_id = ? AND o.status = 'OPEN'`,
        [req.params.id, req.user.tenantId]);
    if (!p.rows.length) return res.status(404).json({ message: 'Silinemedi (kapalı sipariş olabilir).' });

    let byItems = null;
    try {
        const parsed = JSON.parse(p.rows[0].ref || '');
        if (parsed && Array.isArray(parsed.byItems)) byItems = parsed.byItems;
    } catch (_) { /* ref JSON değil (manuel/pazaryeri ödemesi) → kalem geri alma yok */ }

    await tx(async () => {
        await query('DELETE FROM payments WHERE id = ?', [p.rows[0].id]);
        if (byItems) {
            for (const b of byItems) {
                await query(
                    'UPDATE order_items SET paid_qty = MAX(0, COALESCE(paid_qty,0) - ?) WHERE id = ? AND order_id = ?',
                    [Number(b.qty) || 0, b.itemId, p.rows[0].order_id]);
            }
        }
    });
    res.json({ message: 'Silindi.' });
};

exports.methods = (_req, res) => res.json({ methods: VALID_METHODS });
