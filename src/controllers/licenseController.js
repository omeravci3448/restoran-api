const { query } = require('../config/db');
const hub = require('../services/hubService');

// Hub erişilemezse kayıt formu yine çalışsın diye yedek katalog.
// Kayıt formu fiyat GÖSTERMEZ (sadece ad + masa limiti) — bu yüzden fiyatların
// yedekte 0 olması sorun değil; gerçek fiyatlar Lisans sayfasında hub'dan gelir.
const FALLBACK_CATALOG = {
    appId: 'dama-restoran',
    tiers: [
        { name: 'TIER_1_5', displayName: '1-5 Masa', price: 0, tableLimit: 5 },
        { name: 'TIER_6_10', displayName: '6-10 Masa', price: 0, tableLimit: 10 },
        { name: 'TIER_11_20', displayName: '11-20 Masa', price: 0, tableLimit: 20 },
        { name: 'TIER_20_PLUS', displayName: '20+ Masa (Sınırsız)', price: 0, tableLimit: null }
    ],
    modules: [
        { name: 'BASE', displayName: 'Temel (Dahil)', price: 0 },
        { name: 'MENU_DIGITAL', displayName: 'Dijital QR Menü', price: 0 },
        { name: 'GARSON', displayName: 'Garson Mobil Uygulaması', price: 0 },
        { name: 'STOK', displayName: 'Stok + Tedarikçi', price: 0 },
        { name: 'MARKETPLACE', displayName: 'Pazaryeri', price: 0 }
    ],
    categories: []
};

// Hub'dan tüm modül + tier fiyatlarını çek. Hub erişilemezse yedek katalog
// döndür (kayıt akışı asla paketsiz kalmasın). fromHub=false → frontend isterse uyarabilir.
exports.catalog = async (_req, res) => {
    try {
        const data = await hub.getModulesAndTiers();
        if (data && Array.isArray(data.tiers) && data.tiers.length) {
            return res.json({ ...data, fromHub: true });
        }
        // Hub döndü ama boş → yedek
        return res.json({ ...FALLBACK_CATALOG, fromHub: false });
    } catch (e) {
        // Hub erişilemedi → yedek katalog (kayıt yine çalışsın)
        return res.json({ ...FALLBACK_CATALOG, fromHub: false });
    }
};

// Mevcut tenant'ın lisansını hub'dan tekrar çek
exports.refresh = async (req, res) => {
    const r = await query('SELECT owner_email FROM tenants WHERE id = ?', [req.user.tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Tenant bulunamadı.' });
    const result = await hub.refreshTenantLicense(req.user.tenantId, r.rows[0].owner_email);
    if (!result.ok) return res.status(502).json(result);

    // Yeni tier'ın masa limitini de çek ve tenant'a yaz
    try {
        const cat = await hub.getModulesAndTiers();
        const tierRow = cat.tiers.find(t => t.name === result.payload.category);
        if (tierRow) {
            await query('UPDATE tenants SET license_table_limit = ? WHERE id = ?',
                [tierRow.tableLimit ?? null, req.user.tenantId]);
        }
    } catch (_) {}

    res.json(result.payload);
};

// Sepet hesabı: { tier, modules:[...] } → toplam tutar (mevcut tenant indirimi uygulanır)
exports.quote = async (req, res) => {
    const { tier, modules = [] } = req.body;
    try {
        const [data, tenantRow] = await Promise.all([
            hub.getModulesAndTiers(),
            query('SELECT discount_rate FROM tenants WHERE id = ?', [req.user.tenantId])
        ]);
        const tierRow = data.tiers.find(t => t.name === tier);
        if (!tierRow) return res.status(400).json({ message: 'Geçersiz paket.' });

        const breakdown = [{ name: tier, displayName: tierRow.displayName, type: 'TIER', price: tierRow.price }];
        let subtotal = Number(tierRow.price);

        // Default modülleri otomatik ekle (fiyatı 0 olan)
        const moduleNames = Array.from(new Set([
            ...modules,
            ...data.modules.filter(m => Number(m.price) === 0).map(m => m.name)
        ]));

        for (const m of moduleNames) {
            const row = data.modules.find(x => x.name === m);
            if (!row) continue;
            breakdown.push({ name: row.name, displayName: row.displayName, type: 'MODULE', price: row.price });
            subtotal += Number(row.price);
        }

        const discountRate = Number(tenantRow.rows[0]?.discount_rate || 0);
        const discountAmount = Math.round((subtotal * discountRate / 100) * 100) / 100;
        const total = Math.max(0, subtotal - discountAmount);

        res.json({
            currency: 'TRY', tier, modules: moduleNames,
            subtotal, discountRate, discountAmount, total,
            breakdown
        });
    } catch (e) {
        res.status(502).json({ message: 'Fiyat hesaplanamadı.', error: e.message });
    }
};

// Banka bilgisi (hub'dan canlı çekilir)
exports.bankInfo = async (_req, res) => {
    try {
        const data = await hub.getBankInfo();
        res.json(data);
    } catch (e) {
        res.status(502).json({ message: 'Banka bilgisi alınamadı.', error: e.message });
    }
};

// Yeni satın alma talebi gönder — sepeti hub'a iletir
exports.purchase = async (req, res) => {
    const { tier, modules = [], customerNote } = req.body;
    try {
        // Önce quote ile final fiyatı hesapla (güvenlik — istemci tutara güvenilmez)
        const [data, tenantRow] = await Promise.all([
            hub.getModulesAndTiers(),
            query('SELECT business_name, owner_email, discount_rate FROM tenants WHERE id = ?', [req.user.tenantId])
        ]);
        const tierRow = data.tiers.find(t => t.name === tier);
        if (!tierRow) return res.status(400).json({ message: 'Geçersiz paket.' });

        const allModules = Array.from(new Set([
            ...modules,
            ...data.modules.filter(m => Number(m.price) === 0).map(m => m.name)
        ]));

        let subtotal = Number(tierRow.price);
        for (const m of allModules) {
            const row = data.modules.find(x => x.name === m);
            if (row) subtotal += Number(row.price);
        }
        const discountRate = Number(tenantRow.rows[0]?.discount_rate || 0);
        const total = Math.max(0, subtotal - subtotal * discountRate / 100);

        const tenant = tenantRow.rows[0];
        const webhookBase = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 5400}`;

        const hubResp = await hub.createPurchase({
            customerEmail: tenant.owner_email,
            businessName: tenant.business_name,
            tier,
            modules: allModules,
            amount: total,
            discountRate,
            paymentMethod: 'BANK_TRANSFER',
            externalTenantId: req.user.tenantId,
            webhookUrl: `${webhookBase}/api/license/webhook/purchase`,
            customerNote
        });

        res.status(201).json({
            purchaseId: hubResp.id,
            status: hubResp.status,
            tier, modules: allModules, total, discountRate
        });
    } catch (e) {
        res.status(502).json({ message: 'Satın alma talebi oluşturulamadı.', error: e.response?.data?.message || e.message });
    }
};

// "Ödedim" beyanı — hub'a iletilir, Patron onaya kadar bekler
exports.markPaid = async (req, res) => {
    const { paymentRef } = req.body || {};
    try {
        const r = await hub.declarePaid(req.params.id, paymentRef);
        res.json(r);
    } catch (e) {
        res.status(502).json({ message: 'Ödeme bildirimi gönderilemedi.', error: e.response?.data?.message || e.message });
    }
};

// Bu tenant'ın satın alma geçmişi (hub'dan)
exports.purchases = async (req, res) => {
    try {
        const data = await hub.listPurchases(req.user.tenantId);
        res.json(data);
    } catch (e) {
        res.status(502).json({ message: 'Geçmiş alınamadı.', error: e.message });
    }
};

// Tek bir purchase status'u (polling için)
exports.purchaseStatus = async (req, res) => {
    try {
        const data = await hub.getPurchase(req.params.id);
        res.json(data);
    } catch (e) {
        res.status(502).json({ message: 'Durum alınamadı.', error: e.message });
    }
};

// Hub webhook'u (Patron onayladığında çağrılır)
exports.webhookPurchase = async (req, res) => {
    const { event, tenantId, tier, modules, endDate } = req.body || {};
    if (!tenantId) return res.status(400).json({ message: 'tenantId yok' });

    if (event === 'purchase.confirmed' && tier) {
        try {
            // Yeni tier'ın masa limitini çek
            let tableLimit = null;
            try {
                const cat = await hub.getModulesAndTiers();
                const t = cat.tiers.find(x => x.name === tier);
                tableLimit = t?.tableLimit ?? null;
            } catch (_) {}

            await query(
                `UPDATE tenants
                    SET license_tier = ?,
                        license_modules = ?,
                        license_end_date = ?,
                        license_table_limit = ?,
                        is_active = 1
                  WHERE id = ?`,
                [tier, JSON.stringify(modules || []), endDate, tableLimit, tenantId]
            );
        } catch (e) {
            return res.status(500).json({ message: 'Lisans yansıtılamadı.', error: e.message });
        }
    }
    res.json({ ok: true });
};
