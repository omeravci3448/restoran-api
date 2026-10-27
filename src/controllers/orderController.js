const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const gunluk = require('../services/islemGunlugu');
const { hesabaYazIc } = require('../services/qrSiparis');

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

// Garson telefonundan gelen kalemleri kasaya SESLI bildirim olarak dusur. Garson urunleri tek tek
// gonderir; her kalemde ayri uyari cikmasin diye siparis basina 2,5 sn toplanip tek olay yayinlanir.
// Kasiyerin kendi ekledigi kalemler (OWNER/MANAGER/CASHIER) bildirim uretmez.
const bus = require('../services/eventBus');
const garsonBirikim = new Map(); // orderId -> { zamanlayici, adet, tutar, tenantId, tableId, by }
function garsonBildirimiTopla({ tenantId, orderId, tableId, adet, tutar, by }) {
    const k = garsonBirikim.get(orderId) || { adet: 0, tutar: 0 };
    k.adet += Number(adet) || 0; k.tutar += Number(tutar) || 0;
    k.tenantId = tenantId; k.tableId = tableId; k.by = by;
    if (k.zamanlayici) clearTimeout(k.zamanlayici);
    k.zamanlayici = setTimeout(async () => {
        garsonBirikim.delete(orderId);
        try {
            const t = tableId ? (await query('SELECT name, code, section FROM tables WHERE id = ?', [tableId])).rows[0] : null;
            const o = (await query('SELECT total FROM orders WHERE id = ?', [orderId])).rows[0];
            bus.emit(tenantId, 'new_order', {
                orderId, tableId, tableName: t && t.name, tableCode: t && t.code, section: t && t.section,
                addedItems: k.adet, addedSubtotal: k.tutar, orderTotal: o ? Number(o.total) : undefined,
                source: 'WAITER', by,
            });
        } catch (e) { console.error('[garson-bildirim]', e.message); }
    }, 2500);
    garsonBirikim.set(orderId, k);
}

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

    // Stok bitince satis engeli — YALNIZCA isletme bunu acikca sectiyse (varsayilan KAPALI).
    // Cogu restoran stok tutmuyor; unutulan bir stok girisi urunu servis ortasinda
    // satistan dusurmemeli. Ayar: tenants.stock_out_blocks_sale
    if (prod.tracks_stock) {
        const t = await query('SELECT stock_out_blocks_sale FROM tenants WHERE id = ?', [req.user.tenantId]);
        if (t.rows[0] && t.rows[0].stock_out_blocks_sale && Number(prod.stock_qty) < Number(qty)) {
            return res.status(409).json({
                code: 'STOCK_OUT',
                message: `"${prod.name}" stokta yok (kalan: ${prod.stock_qty} ${prod.stock_unit || ''}).`
            });
        }
    }

    const unit = unitPriceOverride != null ? Number(unitPriceOverride) : Number(prod.price);
    const total = Number(qty) * unit;
    const itemId = uuidv4();

    await query(
        `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit, unit_price, total, note, source, added_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemId, req.params.id, prod.id, prod.name, qty, prod.stock_unit || null, unit, total, note || null, req.body.source || 'STAFF', req.user.id]);

    await recomputeTotals(req.params.id);
    if (req.user.role === 'WAITER') {
        garsonBildirimiTopla({ tenantId: req.user.tenantId, orderId: req.params.id, tableId: o.rows[0].table_id,
            adet: qty, tutar: total, by: req.user.name || req.user.email });
    }
    res.status(201).json({ id: itemId, productId, qty, unit, total });
};

// Kalem silme / azaltma izni. Herkes icin: hesap acik olmali. Garson icin ek kural: odeme alinmamis
// hesapta, son GARSON_DUZELTME_DK dakikada eklenen kalem ("musteri yanlis verdi, hemen fark etti").
// Daha eskisini kasa duzeltir. Her silme/azaltma islem gunlugune yazilir (kim, masa, urun, tutar).
const GARSON_DUZELTME_DK = 15;
const TL = (n) => Number(n || 0).toLocaleString('tr-TR') + ' TL';
async function kalemDuzeltmeKontrol(req, cur) {
    const o = (await query(
        `SELECT o.status, t.name AS table_name, t.code AS table_code
           FROM orders o LEFT JOIN tables t ON t.id = o.table_id
          WHERE o.id = ? AND o.tenant_id = ?`, [cur.order_id, req.user.tenantId])).rows[0];
    if (!o) return { kod: 404, hata: 'Sipariş yok.' };
    if (o.status !== 'OPEN') return { kod: 409, hata: 'Hesap kapalı, değişiklik yapılamaz.' };
    if (req.user.role === 'WAITER') {
        const p = await query('SELECT COUNT(*) AS c FROM payments WHERE order_id = ?', [cur.order_id]);
        if (Number(p.rows[0].c) > 0) return { kod: 409, hata: 'Bu hesapta ödeme alınmış; düzeltme için kasaya söyleyin.' };
        const yasDk = (Date.now() - Date.parse(String(cur.created_at).replace(' ', 'T') + 'Z')) / 60000;
        if (!(yasDk <= GARSON_DUZELTME_DK)) return { kod: 409, hata: `${GARSON_DUZELTME_DK} dakikadan eski kalemi yalnız kasa düzeltebilir.` };
    }
    return { masa: o.table_name || o.table_code || '-' };
}
async function kalemiBul(req) {
    const it = await query(
        `SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE oi.id = ? AND oi.order_id = ? AND o.tenant_id = ?`,
        [req.params.itemId, req.params.id, req.user.tenantId]);
    return it.rows[0] || null;
}

exports.removeItem = async (req, res) => {
    const cur = await kalemiBul(req);
    if (!cur) return res.status(404).json({ message: 'Kalem yok.' });
    const izin = await kalemDuzeltmeKontrol(req, cur);
    if (izin.hata) return res.status(izin.kod).json({ message: izin.hata });
    await query('DELETE FROM order_items WHERE id = ?', [cur.id]);
    await recomputeTotals(req.params.id);
    gunluk.kaydet({ tenantId: req.user.tenantId, user: req.user, islem: 'kalem_sil', hedefTur: 'order_item', hedefId: cur.id,
        detay: `${izin.masa} · ${cur.product_name} ×${cur.qty} (${TL(cur.total)}) · ${req.user.role}` });
    res.json({ message: 'Silindi.' });
};
exports.updateItem = async (req, res) => {
    const { qty, note, status } = req.body;
    const cur = await kalemiBul(req);
    if (!cur) return res.status(404).json({ message: 'Kalem yok.' });
    const newQty = qty != null ? Number(qty) : Number(cur.qty);
    if (!(newQty > 0)) return res.status(400).json({ message: 'Adet 1 veya daha fazla olmalı; kaldırmak için silin.' });
    const azaliyor = newQty < Number(cur.qty);
    let izin = null;
    if (azaliyor) {
        izin = await kalemDuzeltmeKontrol(req, cur);
        if (izin.hata) return res.status(izin.kod).json({ message: izin.hata });
    }
    const newTotal = newQty * Number(cur.unit_price);
    await query(
        `UPDATE order_items SET qty = ?, total = ?, note = COALESCE(?, note), status = COALESCE(?, status)
         WHERE id = ?`,
        [newQty, newTotal, note, status, cur.id]);
    await recomputeTotals(req.params.id);
    if (azaliyor) {
        gunluk.kaydet({ tenantId: req.user.tenantId, user: req.user, islem: 'kalem_azalt', hedefTur: 'order_item', hedefId: cur.id,
            detay: `${izin.masa} · ${cur.product_name} ×${cur.qty} → ×${newQty} · ${req.user.role}` });
    }
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
    await query("UPDATE orders SET status = 'CANCELLED', closed_at = CURRENT_TIMESTAMP, cancelled_by = ? WHERE id = ?", [req.user.id, id]);
    if (o.rows[0].table_id) await query("UPDATE tables SET status = 'EMPTY' WHERE id = ?", [o.rows[0].table_id]);
    // Kim iptal etti: islem gunlugu (raporlarda yonetici gorur)
    const masa = o.rows[0].table_id ? (await query('SELECT name FROM tables WHERE id = ?', [o.rows[0].table_id])).rows[0] : null;
    await require('../services/islemGunlugu').kaydet({
        tenantId: req.user.tenantId, user: req.user, islem: 'siparis_iptal', hedefTur: 'order', hedefId: id,
        detay: (masa ? masa.name + ' - ' : '') + Number(o.rows[0].total || 0).toLocaleString('tr-TR') + ' TL',
    });
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

// ——— Kasa onayi bekleyen QR siparisleri ———
// Ayarlar > "QR siparisleri kasa onaylamadan hesaba girmesin" acikken public placeOrder buraya yazar.
const QR_BEKLEME_SAAT = 4; // bu kadar beklemis siparis olmus bitmistir; listeden duser (SURESI_DOLDU)
async function masaAdi(tableId) {
    if (!tableId) return '-';
    const r = await query('SELECT name, code FROM tables WHERE id = ?', [tableId]);
    return r.rows[0] ? (r.rows[0].name || r.rows[0].code || '-') : '-';
}
exports.qrBekleyenler = async (req, res) => {
    await query(`UPDATE qr_bekleyen_siparisler SET durum = 'SURESI_DOLDU', karar_at = CURRENT_TIMESTAMP
                  WHERE tenant_id = ? AND durum = 'BEKLIYOR' AND created_at < datetime('now', ?)`,
        [req.user.tenantId, `-${QR_BEKLEME_SAAT} hours`]);
    const r = await query(
        `SELECT b.id, b.table_id, b.kalemler_json, b.not_metni, b.toplam, b.created_at,
                t.name AS table_name, t.code AS table_code, t.section
           FROM qr_bekleyen_siparisler b LEFT JOIN tables t ON t.id = b.table_id
          WHERE b.tenant_id = ? AND b.durum = 'BEKLIYOR'
          ORDER BY b.created_at`, [req.user.tenantId]);
    res.json(r.rows.map(b => {
        let items = []; try { items = JSON.parse(b.kalemler_json); } catch (_) {}
        const { kalemler_json, ...rest } = b;
        return { ...rest, items };
    }));
};
exports.qrOnayla = async (req, res) => {
    let sonuc;
    try {
        sonuc = await tx(async () => {
            // Durum degisimi atomik: iki kasa ayni anda onaylarsa ikincisi 409 alir, kalemler iki kez yazilmaz.
            const u = await query("UPDATE qr_bekleyen_siparisler SET durum = 'ONAYLANDI', karar_veren = ?, karar_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ? AND durum = 'BEKLIYOR'",
                [req.user.id, req.params.id, req.user.tenantId]);
            if (!u.changes) {
                const var_mi = await query('SELECT durum FROM qr_bekleyen_siparisler WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenantId]);
                const e = new Error(var_mi.rows.length ? 'Bu sipariş zaten sonuçlanmış.' : 'Bekleyen sipariş yok.');
                e.status = var_mi.rows.length ? 409 : 404; throw e;
            }
            const b = (await query('SELECT * FROM qr_bekleyen_siparisler WHERE id = ?', [req.params.id])).rows[0];
            let items = []; try { items = JSON.parse(b.kalemler_json); } catch (_) {}
            const r = await hesabaYazIc({ tenantId: req.user.tenantId, tableId: b.table_id, items, note: b.not_metni, status: 'SEEN', addedBy: req.user.id });
            await query('UPDATE qr_bekleyen_siparisler SET order_id = ? WHERE id = ?', [r.orderId, b.id]);
            return { ...r, tableId: b.table_id };
        });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ message: e.message });
        throw e;
    }
    gunluk.kaydet({ tenantId: req.user.tenantId, user: req.user, islem: 'qr_onay', hedefTur: 'qr_siparis', hedefId: req.params.id,
        detay: `${await masaAdi(sonuc.tableId)} · ${sonuc.added} kalem · ${TL(sonuc.subAdded)}` + (sonuc.atlanan.length ? ` · hesaba yazılamadı: ${sonuc.atlanan.join(', ')}` : '') });
    res.json({ orderId: sonuc.orderId, addedItems: sonuc.added, addedSubtotal: sonuc.subAdded, orderTotal: sonuc.total, atlanan: sonuc.atlanan });
};
exports.qrReddet = async (req, res) => {
    const b = (await query('SELECT table_id, toplam, kalemler_json FROM qr_bekleyen_siparisler WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenantId])).rows[0];
    const u = await query("UPDATE qr_bekleyen_siparisler SET durum = 'REDDEDILDI', karar_veren = ?, karar_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ? AND durum = 'BEKLIYOR'",
        [req.user.id, req.params.id, req.user.tenantId]);
    if (!u.changes) return res.status(b ? 409 : 404).json({ message: b ? 'Bu sipariş zaten sonuçlanmış.' : 'Bekleyen sipariş yok.' });
    let adet = 0; try { adet = JSON.parse(b.kalemler_json).length; } catch (_) {}
    gunluk.kaydet({ tenantId: req.user.tenantId, user: req.user, islem: 'qr_red', hedefTur: 'qr_siparis', hedefId: req.params.id,
        detay: `${await masaAdi(b.table_id)} · ${adet} kalem · ${TL(b.toplam)}` });
    res.json({ ok: true });
};
