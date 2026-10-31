const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const bus = require('../services/eventBus');
const push = require('../services/pushBildirim');

// Bekleyen garson çağrılarını listele (personel uygulaması için)
exports.pending = async (req, res) => {
    const r = await query(
        `SELECT w.*, t.code AS table_code, t.name AS table_name, t.section
           FROM waiter_calls w JOIN tables t ON t.id = w.table_id
          WHERE w.tenant_id = ? AND w.status = 'PENDING'
          ORDER BY w.created_at`,
        [req.user.tenantId]);
    res.json(r.rows);
};

exports.handle = async (req, res) => {
    await query(
        `UPDATE waiter_calls
            SET status = 'HANDLED', handled_at = CURRENT_TIMESTAMP, handled_by = ?
          WHERE id = ? AND tenant_id = ?`,
        [req.user.id, req.params.id, req.user.tenantId]);
    res.json({ message: 'Tamamlandı.' });
};

// Public — masadan çağrı (QR menüsünden çağırılır, auth gerekmez)
exports.publicCall = async (req, res) => {
    const { tenantSlug, qrToken } = req.params;
    const reason = (req.body && req.body.reason) || 'GENERIC';
    const t = await query(
        `SELECT tb.id AS table_id, tb.tenant_id, tb.name AS table_name, tb.code AS table_code, tb.section
           FROM tables tb JOIN tenants te ON te.id = tb.tenant_id
          WHERE te.slug = ? AND tb.qr_token = ? AND tb.is_active = 1 AND te.is_active = 1`,
        [tenantSlug, qrToken]);
    if (!t.rows.length) return res.status(404).json({ message: 'Masa bulunamadı.' });
    const tb = t.rows[0];

    // Ayni masadan 60 sn icinde ikinci cagri yeni kayit/bildirim uretmez: musteri dugmeye ust
    // uste basinca (ya da biri QR'la oynayinca) personelin telefonu art arda calmasin.
    const yakin = await query(
        `SELECT id FROM waiter_calls
          WHERE tenant_id = ? AND table_id = ? AND status = 'PENDING' AND created_at >= datetime('now', '-60 seconds')
          ORDER BY created_at DESC LIMIT 1`,
        [tb.tenant_id, tb.table_id]);
    if (yakin.rows.length) return res.status(200).json({ id: yakin.rows[0].id, tekrar: true });

    const id = uuidv4();
    await query(
        `INSERT INTO waiter_calls (id, tenant_id, table_id, reason) VALUES (?, ?, ?, ?)`,
        [id, tb.tenant_id, tb.table_id, String(reason).slice(0, 30)]);

    // Kasaya anlık bildirim
    bus.emit(tb.tenant_id, 'waiter_call', {
        id, tableId: tb.table_id, tableName: tb.table_name, tableCode: tb.table_code, section: tb.section, reason
    });
    // Telefonlara (garson uygulamasi kapaliyken de). Musteri metni bildirime girmez: govde sabit.
    const masa = tb.table_name || tb.table_code || 'Masa';
    push.arkadaBildir(tb.tenant_id, 'garson', {
        baslik: `🔔 ${masa} garson çağırıyor`,
        govde: [tb.section, reason === 'BILL' ? 'Hesabı istiyor' : 'Masaya bekleniyor'].filter(Boolean).join(' · '),
        etiket: 'garson-' + tb.table_id,
        url: '/garson/?sekme=cagrilar',
        cagriId: id,
    });

    res.status(201).json({ id });
};
