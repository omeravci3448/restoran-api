const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const bus = require('../services/eventBus');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Canlı olay akışı (SSE). EventSource header gönderemediği için token query'den alınır.
// Kasada bu bağlantı sürekli açık kalır; garson çağrısı / QR sipariş olunca anında olay gelir.
exports.stream = async (req, res) => {
    const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).end(); }

    let row;
    try {
        if (payload.destek) {
            // Destek oturumu: kullanici satiri yok; oturum acik olmali (kapaninca akis da kesilir, asagida)
            const d = await require('../services/destekOturumu').kimlik(payload);
            row = d.hata ? null : { tenant_id: d.u.tenant_id, tenant_active: d.u.tenant_active, license_end_date: d.u.license_end_date, license_modules: d.u.license_modules };
            if (!row) return res.status(401).end();
        } else {
        const r = await query(
            `SELECT t.id AS tenant_id, t.is_active AS tenant_active, t.license_end_date, t.license_modules
               FROM users u JOIN tenants t ON t.id = u.tenant_id
              WHERE u.id = ?`,
            [payload.userId]);
        row = r.rows[0];
        }
    } catch (_) { return res.status(500).end(); }

    if (!row || !row.tenant_active) return res.status(403).end();
    // Canli olaylar QR siparisi / adisyon (BASE) ve garson cagrisi (GARSON): ikisi de yoksa akis yok
    const { varMi } = require('../services/lisansModul');
    if (!varMi(row.license_modules, 'BASE') && !varMi(row.license_modules, 'GARSON')) return res.status(403).end();
    // Lisans: istegin etkin durumu (Istanbul gun sonu + odeme korumasi; protect ve QR menuyle ayni kural).
    // Yalniz KAPALI'da reddedilir: salt-okunur donemde de QR garson cagrisi ve acik hesap kapatma surer.
    try {
        const ld = await require('../services/odemeKorumasi').etkinDurum(row.tenant_id, row.license_end_date);
        if (ld.durum === 'KAPALI') return res.status(403).end();
    } catch (_) { return res.status(500).end(); }
    const tenantId = row.tenant_id;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // proxy ara-belleklemesini kapat
    });
    res.write('retry: 5000\n\n');        // kopunca 5 sn'de bir yeniden bağlan
    res.write('event: ready\ndata: {}\n\n');
    bus.addClient(tenantId, res);

    // 25 sn'de bir yorum satırı — bağlantı (proxy/tarayıcı) zaman aşımına uğramasın
    const keepAlive = setInterval(() => {
        try { res.write(': ka\n\n'); } catch (_) {}
    }, 25000);

    // Destek oturumu kapatilir ya da suresi dolarsa akis da kapanir (30 sn'de bir bakilir)
    const destekDenetim = payload.destek ? setInterval(async () => {
        try {
            const d = await require('../services/destekOturumu').kimlik(payload);
            if (d.hata) { clearInterval(destekDenetim); clearInterval(keepAlive); bus.removeClient(tenantId, res); res.end(); }
        } catch (_) { /* bir sonraki turda yeniden denenir */ }
    }, 30000) : null;

    req.on('close', () => {
        clearInterval(keepAlive);
        if (destekDenetim) clearInterval(destekDenetim);
        bus.removeClient(tenantId, res);
    });
};
