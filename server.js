require('dotenv').config();
require('express-async-errors'); // async route handler hatalarını error middleware'e taşır (Express 4)
const express = require('express');
const cors = require('cors');
const { initDb, query } = require('./src/config/db');
const hubService = require('./src/services/hubService');

// Tek bir DB hatası (örn SQLITE_BUSY) tüm servisi düşürmesin — logla, ayakta kal
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// Server start'ta: tüm tenant'ların license_table_limit'i hub'dan tazele
// (eski seed'lerde NULL kalabilir, ya da hub'da tier limiti değişebilir)
async function backfillTableLimits() {
    try {
        const r = await query('SELECT id, license_tier FROM tenants WHERE license_tier IS NOT NULL');
        if (!r.rows.length) return;
        const cat = await hubService.getModulesAndTiers();
        for (const t of r.rows) {
            const tier = cat.tiers.find(x => x.name === t.license_tier);
            if (tier !== undefined) {
                await query('UPDATE tenants SET license_table_limit = ? WHERE id = ?',
                    [tier.tableLimit ?? null, t.id]);
            }
        }
        console.log('[mda-restoran] tier limit backfill tamamlandı:', r.rows.length, 'tenant güncellendi');
    } catch (e) {
        console.log('[mda-restoran] tier limit backfill atlandı (hub erişimi yok):', e.message);
    }
}

const app = express();

// CORS — JWT Bearer token ile auth yapıldığı için cookie/CSRF riski yok.
// CORS_ORIGINS env'i verilirse allowlist olarak çalışır (virgülle ayrılmış),
// verilmezse gelen origin'i yansıtır (QR menü herkese açık erişilir olmalı).
const allowList = (process.env.CORS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin: (origin, cb) => {
        if (!origin || allowList.length === 0 || allowList.includes(origin)) {
            return cb(null, true);
        }
        return cb(null, false);
    }
}));
app.use(express.json({ limit: '4mb' }));

// Yüklenen ürün görselleri — public statik servis (görseller gizli değil).
// Tarayıcı cache'lesin diye uzun max-age.
const { UPLOADS_DIR } = require('./src/services/imageService');
app.use('/uploads', express.static(UPLOADS_DIR, {
    maxAge: '7d',
    immutable: true,
    setHeaders: (res) => {
        // MIME-sniffing kapalı — yüklenen dosyalar tarayıcıda script olarak yorumlanmasın
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
}));

// Sağlık
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Modüller
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/tenant', require('./src/routes/tenantRoutes'));
app.use('/api/license', require('./src/routes/licenseRoutes'));
app.use('/api/tables', require('./src/routes/tableRoutes'));
app.use('/api/categories', require('./src/routes/categoryRoutes'));
app.use('/api/products', require('./src/routes/productRoutes'));
app.use('/api/orders', require('./src/routes/orderRoutes'));
app.use('/api/payments', require('./src/routes/paymentRoutes'));
app.use('/api/stock', require('./src/routes/stockRoutes'));
app.use('/api/suppliers', require('./src/routes/supplierRoutes'));
app.use('/api/marketplace', require('./src/routes/marketplaceRoutes'));
app.use('/api/reports', require('./src/routes/reportRoutes'));
app.use('/api/waiter', require('./src/routes/waiterRoutes'));
app.use('/api/public', require('./src/routes/publicRoutes')); // QR menü için public erişim

// 404
app.use((_req, res) => res.status(404).json({ message: 'Endpoint bulunamadı.' }));

// Genel hata yakalama
app.use((err, _req, res, _next) => {
    console.error('[ERR]', err);
    // Gövde çok büyük (örn küçültülmemiş dev görsel) → dostça 413
    if (err.type === 'entity.too.large' || err.status === 413) {
        return res.status(413).json({ message: 'Gönderilen veri çok büyük. Görseli küçültüp tekrar deneyin.' });
    }
    res.status(err.status || 500).json({ message: err.message || 'Sunucu hatası.' });
});

initDb();
const PORT = process.env.PORT || 5400;
app.listen(PORT, () => {
    console.log(`[mda-restoran] backend ${PORT} portunda — ${process.env.NODE_ENV || 'dev'}`);
    // 5sn sonra backfill — DB init bitsin
    setTimeout(() => { backfillTableLimits(); }, 5000);
});
