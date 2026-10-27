const { query } = require('../config/db');
const bus = require('../services/eventBus');

// ——— MUTFAK EKRANI (KDS) ———
// Kalem durumu: NEW/SEEN (bekliyor) -> PREPARING (hazirlaniyor) -> READY (hazir) -> SERVED (servis edildi).
// Istasyon kategoriden gelir (categories.istasyon: MUTFAK | BAR | YOK). YOK = ekrana hic dusmez (sigara vb.).
// Durumlar hesabi/tutari ETKILEMEZ; yalniz akis ve sure olcumu icindir. Kapali/iptal hesap ve iptal
// kalem kuyruga girmez. Olaylar SSE 'item_status' ile kasaya/garsona duser.

const BEKLEYEN = ['NEW', 'SEEN'];
const MUTFAK_ROLLER = ['OWNER', 'MANAGER', 'CASHIER', 'KITCHEN'];
const ETIKET = { NEW: 'bekliyor', SEEN: 'bekliyor', PREPARING: 'hazırlanıyor', READY: 'hazır', SERVED: 'servis edildi' };

// Gecisler: from = izin verilen onceki durumlar, roller = null ise herkes (garson dahil)
const GECIS = {
    PREPARING: { from: ['NEW', 'SEEN', 'READY'], roller: MUTFAK_ROLLER,
        set: "status = 'PREPARING', prep_started_at = COALESCE(prep_started_at, CURRENT_TIMESTAMP), ready_at = NULL" },
    READY: { from: ['NEW', 'SEEN', 'PREPARING'], roller: MUTFAK_ROLLER,
        set: "status = 'READY', prep_started_at = COALESCE(prep_started_at, CURRENT_TIMESTAMP), ready_at = CURRENT_TIMESTAMP" },
    SERVED: { from: ['READY'], roller: null, set: "status = 'SERVED', served_at = CURRENT_TIMESTAMP" },
    NEW: { from: ['PREPARING', 'READY'], roller: MUTFAK_ROLLER, set: "status = 'NEW', prep_started_at = NULL, ready_at = NULL" }, // geri al
};

async function kuyrukSatirlari(tenantId) {
    const r = await query(
        `SELECT oi.id, oi.order_id, oi.product_name, oi.qty, oi.note, oi.status, oi.created_at,
                oi.prep_started_at, oi.ready_at, oi.modifiers_json, oi.source,
                COALESCE(c.istasyon, 'MUTFAK') AS istasyon,
                o.table_id, o.channel, o.opened_at, o.external_ref,
                t.name AS table_name, t.code AS table_code, t.section
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN tables t ON t.id = o.table_id
          WHERE o.tenant_id = ? AND o.status = 'OPEN' AND COALESCE(oi.is_cancelled, 0) = 0
            AND oi.status IN ('NEW', 'SEEN', 'PREPARING', 'READY')
          ORDER BY oi.created_at`, [tenantId]);
    return r.rows;
}

function istasyonSuz(rows, istasyon) {
    const ist = String(istasyon || 'HEPSI').toUpperCase();
    return rows.filter(r => {
        const s = (r.istasyon || 'MUTFAK').toUpperCase();
        if (s === 'YOK') return false;
        return ist === 'HEPSI' || s === ist;
    });
}

function kartla(rows) {
    const map = new Map();
    for (const r of rows) {
        let k = map.get(r.order_id);
        if (!k) {
            k = { orderId: r.order_id, tableId: r.table_id, tableName: r.table_name, tableCode: r.table_code, section: r.section,
                  channel: r.channel, externalRef: r.external_ref, openedAt: r.opened_at, enEski: r.created_at,
                  items: [], bekleyen: 0, hazirlaniyor: 0, hazir: 0 };
            map.set(r.order_id, k);
        }
        let modifiers = null;
        try { modifiers = r.modifiers_json ? JSON.parse(r.modifiers_json) : null; } catch (_) { modifiers = null; }
        k.items.push({ id: r.id, name: r.product_name, qty: r.qty, note: r.note, status: r.status, istasyon: r.istasyon || 'MUTFAK',
                       source: r.source, createdAt: r.created_at, prepStartedAt: r.prep_started_at, readyAt: r.ready_at, modifiers });
        if (BEKLEYEN.includes(r.status)) k.bekleyen++;
        else if (r.status === 'PREPARING') k.hazirlaniyor++;
        else if (r.status === 'READY') k.hazir++;
    }
    // Sira: isi bitmemis (bekleyen/hazirlanan) kartlar once, en eski ustte; hepsi hazir olanlar sona
    return [...map.values()].sort((a, b) => {
        const aa = a.bekleyen + a.hazirlaniyor > 0 ? 0 : 1, bb = b.bekleyen + b.hazirlaniyor > 0 ? 0 : 1;
        if (aa !== bb) return aa - bb;
        return String(a.enEski).localeCompare(String(b.enEski));
    });
}

// GET /api/mutfak/kuyruk?istasyon=HEPSI|MUTFAK|BAR  (her rol okur; garson "hazir" rozetleri icin de kullanir)
exports.kuyruk = async (req, res) => {
    const rows = istasyonSuz(await kuyrukSatirlari(req.user.tenantId), req.query.istasyon);
    const kartlar = kartla(rows);
    const sayac = { bekleyen: 0, hazirlaniyor: 0, hazir: 0 };
    for (const k of kartlar) { sayac.bekleyen += k.bekleyen; sayac.hazirlaniyor += k.hazirlaniyor; sayac.hazir += k.hazir; }
    res.json({ kartlar, sayac, sunucuSaati: new Date().toISOString() });
};

function gecisAl(req, res) {
    const durum = String((req.body || {}).durum || '').toUpperCase();
    const g = GECIS[durum];
    if (!g) { res.status(400).json({ message: 'Geçersiz durum.' }); return null; }
    if (g.roller && !g.roller.includes(req.user.role)) { res.status(403).json({ message: 'Bu işlem için yetkiniz yok.' }); return null; }
    return { durum, g };
}

// POST /api/mutfak/kalem/:itemId/durum  { durum }
exports.kalemDurum = async (req, res) => {
    const gs = gecisAl(req, res); if (!gs) return;
    const { durum, g } = gs;
    const it = (await query(
        `SELECT oi.id, oi.order_id, oi.product_name, oi.qty, oi.status, o.status AS order_status, t.name AS table_name, t.code AS table_code
           FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN tables t ON t.id = o.table_id
          WHERE oi.id = ? AND o.tenant_id = ?`, [req.params.itemId, req.user.tenantId])).rows[0];
    if (!it) return res.status(404).json({ message: 'Kalem yok.' });
    if (it.order_status !== 'OPEN') return res.status(409).json({ message: 'Hesap kapalı.' });
    if (!g.from.includes(it.status)) {
        return res.status(409).json({ message: `Bu kalem '${ETIKET[it.status] || it.status}' durumunda; '${ETIKET[durum]}' yapılamaz.` });
    }
    await query(`UPDATE order_items SET ${g.set} WHERE id = ?`, [it.id]);
    bus.emit(req.user.tenantId, 'item_status', {
        orderId: it.order_id, itemId: it.id, name: it.product_name, qty: it.qty, status: durum,
        tableName: it.table_name, tableCode: it.table_code, by: req.user.name || req.user.email,
    });
    res.json({ ok: true, status: durum });
};

// POST /api/mutfak/siparis/:orderId/durum  { durum, istasyon? }  — karttaki uygun kalemlerin hepsi
exports.siparisDurum = async (req, res) => {
    const gs = gecisAl(req, res); if (!gs) return;
    const { durum, g } = gs;
    const o = (await query(
        `SELECT o.id, o.status, t.name AS table_name, t.code AS table_code
           FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.id = ? AND o.tenant_id = ?`,
        [req.params.orderId, req.user.tenantId])).rows[0];
    if (!o) return res.status(404).json({ message: 'Sipariş yok.' });
    if (o.status !== 'OPEN') return res.status(409).json({ message: 'Hesap kapalı.' });
    const ist = (req.body && req.body.istasyon) || req.query.istasyon || 'HEPSI';
    const hedef = istasyonSuz(await kuyrukSatirlari(req.user.tenantId), ist)
        .filter(r => r.order_id === o.id && g.from.includes(r.status));
    if (!hedef.length) return res.json({ ok: true, adet: 0 });
    const ids = hedef.map(r => r.id);
    await query(`UPDATE order_items SET ${g.set} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    bus.emit(req.user.tenantId, 'item_status', {
        orderId: o.id, toplu: true, adet: ids.length, status: durum,
        tableName: o.table_name, tableCode: o.table_code, by: req.user.name || req.user.email,
    });
    res.json({ ok: true, adet: ids.length });
};

exports._ic = { istasyonSuz, kartla, GECIS };
