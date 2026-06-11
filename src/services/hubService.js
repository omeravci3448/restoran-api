const axios = require('axios');
const { query } = require('../config/db');

// DİKKAT: hub.mdayazilim.com PANEL (frontend), API ayrı subdomain'de.
// Yanlış adres verilirse nginx HTML döner ve sync/verify sessizce başarısız olur.
// Env'e şemasız ("hub-api.mdayazilim.com") girilirse ERR_INVALID_URL olur —
// normalize edip https:// ekliyoruz, sondaki / işaretlerini temizliyoruz.
function normalizeHubUrl(u) {
    let s = String(u || '').trim().replace(/\/+$/, '');
    if (!s) return 'https://hub-api.mdayazilim.com';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
}
const HUB_URL = normalizeHubUrl(process.env.HUB_URL || 'https://hub-api.mdayazilim.com');
const API_KEY = process.env.APP_API_KEY || 'dm_restoran_b8f4d2a1e3c5';

// Hub'a doğrula → modules array'i + tier (license_type) ile dön
async function verifyWithHub(customerEmail) {
    const url = `${HUB_URL}/api/subscriptions/verify`;
    const { data } = await axios.post(url, { apiKey: API_KEY, customerEmail }, { timeout: 8000 });
    return data; // { active, type, expires, modules, category, appName }
}

async function syncWithHub(payload) {
    const url = `${HUB_URL}/api/subscriptions/sync`;
    const { data } = await axios.post(url, { apiKey: API_KEY, ...payload }, { timeout: 8000 });
    return data;
}

// Modül/tier kataloğu sık değişmez ama her login + her başlangıç backfill'i hub'a gidiyor.
// 60sn'lik in-memory cache: login dalgalarında hub'a giden istek sayısını ezici biçimde düşürür,
// hub yavaşsa o gecikme login akışına yansımaz. Hata olursa cache yazılmaz (eski iyi veri kalır).
let _catCache = { data: null, at: 0 };
const CATALOG_TTL_MS = 60000;
async function getModulesAndTiers() {
    const now = Date.now();
    if (_catCache.data && (now - _catCache.at) < CATALOG_TTL_MS) return _catCache.data;
    const url = `${HUB_URL}/api/subscriptions/modules-pricing?appId=dama-restoran`;
    const { data } = await axios.get(url, { timeout: 8000 });
    _catCache = { data, at: now };
    return data;
}

async function getBankInfo() {
    const { data } = await axios.get(`${HUB_URL}/api/settings/public/bank-info`, { timeout: 8000 });
    return data;
}

// Yeni satın alma talebi gönder
async function createPurchase(payload) {
    const { data } = await axios.post(`${HUB_URL}/api/purchases`,
        { apiKey: API_KEY, ...payload }, { timeout: 10000 });
    return data;
}

// Müşteri "ödedim" dedi
async function declarePaid(purchaseId, paymentRef) {
    const { data } = await axios.post(
        `${HUB_URL}/api/purchases/${purchaseId}/declare-paid`,
        { apiKey: API_KEY, paymentRef },
        { timeout: 10000 }
    );
    return data;
}

// Bir tenant'ın satın alma geçmişi
async function listPurchases(tenantId) {
    const { data } = await axios.get(`${HUB_URL}/api/purchases?tenantId=${tenantId}`, {
        timeout: 8000,
        headers: { 'x-api-key': API_KEY }
    });
    return data;
}

async function getPurchase(id) {
    const { data } = await axios.get(`${HUB_URL}/api/purchases/${id}`, {
        timeout: 5000,
        headers: { 'x-api-key': API_KEY }
    });
    return data;
}

async function pingActivity(customerEmail) {
    try {
        await axios.post(`${HUB_URL}/api/subscriptions/ping`, { apiKey: API_KEY, customerEmail }, { timeout: 5000 });
    } catch (_) { /* sessiz geç */ }
}

// Lisans cevabını cache'le ve tenant'a uygula
async function refreshTenantLicense(tenantId, customerEmail) {
    let payload;
    try {
        payload = await verifyWithHub(customerEmail);
    } catch (e) {
        return { ok: false, reason: 'HUB_UNREACHABLE', error: e.message };
    }
    if (!payload || !payload.active) {
        // Hub "lisans yok / pasif" diyor — ama LOKAL lisans hâlâ ileri tarihliyse
        // tenant'ı pasifleştirme. Bu, ilk demo kayıtlarında hub'a senkron olmadan
        // önceki aralıkta veya hub'da silinmiş bir kayıtta lokal'in kilitlenmemesini sağlar.
        const local = await query('SELECT license_end_date FROM tenants WHERE id = ?', [tenantId]);
        const end = local.rows[0]?.license_end_date;
        if (end && new Date(end) > new Date()) {
            return { ok: false, reason: 'INACTIVE_HUB_LOCAL_VALID', payload, message: 'Hub pasif diyor ama lokal lisans tarihi hâlâ geçerli — pasifleştirilmedi.' };
        }
        await query('UPDATE tenants SET is_active = 0 WHERE id = ?', [tenantId]);
        return { ok: false, reason: 'INACTIVE', payload };
    }
    // NON-DESTRUCTIVE: Hub demo aboneliği genelde modülsüz/tier'sız (license_type='DEMO')
    // döner. Bunu körü körüne yazarsak kayıttaki "tüm modüller + tier masa limiti"
    // silinir (demo bozulur, masa limiti sınırsıza döner). Bu yüzden:
    //  - modules: hub BOŞ döndürürse mevcut yereldeki modülleri KORU (gerçek lisans
    //    dolu modül listesiyle gelince üzerine yazılır → downgrade yine çalışır).
    //  - tier + masa limiti: hub'ın category'si bilinen bir TIER ise güncelle; değilse
    //    (örn 'DEMO') yereldeki tier + limiti KORU.
    const local = (await query(
        'SELECT license_tier, license_modules, license_table_limit FROM tenants WHERE id = ?', [tenantId]
    )).rows[0] || {};

    const hubModules = Array.isArray(payload.modules) ? payload.modules : [];
    const modulesJson = hubModules.length ? JSON.stringify(hubModules) : (local.license_modules || '[]');

    const category = payload.category || payload.type;
    let tierToWrite = local.license_tier;
    let limitToWrite = local.license_table_limit;
    try {
        const cat = await getModulesAndTiers();
        const tierRow = (cat.tiers || []).find(t => t.name === category);
        if (tierRow) { // hub gerçek bir tier döndürdü → tier + limiti güncelle
            tierToWrite = category;
            limitToWrite = tierRow.tableLimit ?? null;
        }
    } catch (_) { /* katalog yoksa yereldeki tier + limiti koru */ }

    await query(
        `UPDATE tenants
            SET license_tier = ?, license_modules = ?, license_end_date = ?,
                license_table_limit = ?, is_active = 1
          WHERE id = ?`,
        [tierToWrite, modulesJson, payload.expires, limitToWrite, tenantId]
    );
    await query(
        `INSERT INTO license_cache (tenant_id, payload, checked_at)
         VALUES (?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET payload=excluded.payload, checked_at=excluded.checked_at`,
        [tenantId, JSON.stringify(payload), new Date().toISOString()]
    );
    return { ok: true, payload };
}

module.exports = {
    HUB_URL,
    verifyWithHub, syncWithHub, getModulesAndTiers, pingActivity, refreshTenantLicense,
    getBankInfo, createPurchase, declarePaid, listPurchases, getPurchase
};
