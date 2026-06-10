const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const { saveDataUrl } = require('../services/imageService');

exports.list = async (req, res) => {
    const { categoryId, q, lowStock } = req.query;
    const w = ['p.tenant_id = ?'];
    const p = [req.user.tenantId];
    if (categoryId) { w.push('p.category_id = ?'); p.push(categoryId); }
    if (q) { w.push('p.name LIKE ?'); p.push(`%${q}%`); }
    if (lowStock === '1') {
        w.push('p.tracks_stock = 1');
        w.push('p.low_stock_threshold > 0');
        w.push('p.stock_qty <= p.low_stock_threshold');
    }
    const r = await query(
        `SELECT p.*, c.name AS category_name
           FROM products p LEFT JOIN categories c ON c.id = p.category_id
          WHERE ${w.join(' AND ')}
          ORDER BY p.sort_order, p.name`, p);
    res.json(r.rows);
};

exports.create = async (req, res) => {
    const {
        categoryId, name, description, price, cost, imageUrl,
        tracksStock, stockQty, stockUnit, lowStockThreshold, isAvailable, sortOrder, taxRate
    } = req.body;
    if (!name || price == null) return res.status(400).json({ message: 'Ad ve fiyat zorunlu.' });
    const id = uuidv4();
    // Görsel data URL ise dosyaya kaydet, image_url'e dosya yolunu yaz
    const storedImage = await saveDataUrl(req.user.tenantId, imageUrl);
    // Restoran varsayılanı: stok takibi YOK (tracksStock gönderilmezse 0).
    await query(
        `INSERT INTO products (id, tenant_id, category_id, name, description, price, cost, image_url,
            tracks_stock, stock_qty, stock_unit, low_stock_threshold, is_available, sort_order, tax_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.tenantId, categoryId || null, name, description || null, price, cost || 0, storedImage || null,
            tracksStock ? 1 : 0, stockQty || 0, stockUnit || 'adet', lowStockThreshold || 0,
            isAvailable === false ? 0 : 1, sortOrder || 0, taxRate ?? null]);
    res.status(201).json({ id, name });
};

exports.update = async (req, res) => {
    const f = req.body;
    // Görsel üç durum: gönderilmedi (undefined → dokunma) | boş '' (kaldır → NULL) | data URL/yol (kaydet)
    const imageProvided = f.imageUrl !== undefined;
    let newImage = null;
    if (imageProvided) {
        newImage = f.imageUrl === '' ? null : await saveDataUrl(req.user.tenantId, f.imageUrl);
    }
    await query(
        `UPDATE products SET
            category_id = COALESCE(?, category_id),
            name = COALESCE(?, name),
            description = COALESCE(?, description),
            price = COALESCE(?, price),
            cost = COALESCE(?, cost),
            image_url = CASE WHEN ? = 1 THEN ? ELSE image_url END,
            tracks_stock = COALESCE(?, tracks_stock),
            stock_unit = COALESCE(?, stock_unit),
            low_stock_threshold = COALESCE(?, low_stock_threshold),
            is_available = COALESCE(?, is_available),
            sort_order = COALESCE(?, sort_order),
            tax_rate = COALESCE(?, tax_rate)
         WHERE id = ? AND tenant_id = ?`,
        [f.categoryId, f.name, f.description, f.price, f.cost,
            imageProvided ? 1 : 0, newImage,
            f.tracksStock == null ? null : (f.tracksStock ? 1 : 0),
            f.stockUnit, f.lowStockThreshold,
            f.isAvailable == null ? null : (f.isAvailable ? 1 : 0),
            f.sortOrder, f.taxRate,
            req.params.id, req.user.tenantId]);
    res.json({ message: 'Güncellendi.' });
};

// Akıllı silme:
// - Geçmiş siparişlerde bu ürün varsa soft delete (is_available = 0) — kayıtlar korunur
// - Hiç sipariş kaydı yoksa hard delete (tamamen silinir)
// Frontend ?force=1 ile zorlanırsa yine soft delete'e döner (asla referans kıramayız)
exports.remove = async (req, res) => {
    const p = await query('SELECT id FROM products WHERE id = ? AND tenant_id = ?',
        [req.params.id, req.user.tenantId]);
    if (!p.rows.length) return res.status(404).json({ message: 'Ürün yok.' });

    const used = await query('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1',
        [req.params.id]);

    if (used.rows.length) {
        await query('UPDATE products SET is_available = 0 WHERE id = ?', [req.params.id]);
        return res.json({ mode: 'SOFT', message: 'Geçmiş satışlarda kullanıldığı için menüden kaldırıldı, kayıtlar korundu.' });
    }
    await query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ mode: 'HARD', message: 'Tamamen silindi.' });
};
