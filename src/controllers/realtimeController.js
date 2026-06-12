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
        const r = await query(
            `SELECT t.id AS tenant_id, t.is_active AS tenant_active, t.license_end_date
               FROM users u JOIN tenants t ON t.id = u.tenant_id
              WHERE u.id = ?`,
            [payload.userId]);
        row = r.rows[0];
    } catch (_) { return res.status(500).end(); }

    if (!row || !row.tenant_active) return res.status(403).end();
    if (row.license_end_date && Date.now() > new Date(row.license_end_date).getTime()) {
        return res.status(403).end();
    }
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

    req.on('close', () => {
        clearInterval(keepAlive);
        bus.removeClient(tenantId, res);
    });
};
