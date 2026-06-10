const axios = require('axios');
const { query } = require('../config/db');

const HUB_URL = process.env.HUB_URL || 'https://hub.mdayazilim.com';
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

async function getModulesAndTiers() {
    const url = `${HUB_URL}/api/subscriptions/modules-pricing?appId=dama-restoran`;
    const { data } = await axios.get(url, { timeout: 8000 });
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
    const modulesJson = JSON.stringify(payload.modules || []);
    await query(
        `UPDATE tenants
            SET license_tier = ?, license_modules = ?, license_end_date = ?, is_active = 1
          WHERE id = ?`,
        [payload.category || payload.type, modulesJson, payload.expires, tenantId]
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
    verifyWithHub, syncWithHub, getModulesAndTiers, pingActivity, refreshTenantLicense,
    getBankInfo, createPurchase, declarePaid, listPurchases, getPurchase
};
