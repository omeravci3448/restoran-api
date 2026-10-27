const fs = require('fs');
const path = require('path');
const { query } = require('../config/db');
const { saveDataUrl, UPLOADS_DIR } = require('../services/imageService');

exports.getProfile = async (req, res) => {
    const r = await query(
        `SELECT id, slug, business_code, business_name, owner_email, phone, address, logo_url,
                billing_name, billing_address, billing_tax_id, billing_tax_office,
                referral_code, referred_by, discount_rate,
                currency, tax_rate,
                license_tier, license_modules, license_end_date, show_cost_analytics, qr_onay_gerekli, mutfak_ekrani,
                is_active, created_at
           FROM tenants WHERE id = ?`,
        [req.user.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Bulunamadı.' });
    const t = r.rows[0];
    try { t.license_modules = t.license_modules ? JSON.parse(t.license_modules) : []; } catch (_) { t.license_modules = []; }
    t.show_cost_analytics = t.show_cost_analytics == null ? 1 : Number(t.show_cost_analytics);
    res.json(t);
};

// KVKK — hesap kapatma / veri silme talebi.
// Hard-delete YAPMAZ: mali kayıtlar (sipariş/ödeme) VUK gereği yasal saklama
// yükümlülüğüne tabidir. Bu yüzden hesap deaktive edilir, talep zamanı kaydedilir,
// hub'a bildirilir. Kişisel verilerin silinmesi/anonimleştirilmesi yasal saklama
// süresi sonunda veya işletme politikasına göre yapılır.
exports.requestClosure = async (req, res) => {
    const { confirmText } = req.body || {};
    if (confirmText !== 'KAPAT') {
        return res.status(400).json({ message: 'Onay için kutuya KAPAT yazmalısınız.' });
    }
    await query(
        'UPDATE tenants SET closure_requested_at = ?, is_active = 0 WHERE id = ?',
        [new Date().toISOString(), req.user.tenantId]
    );
    try {
        const hub = require('../services/hubService');
        const t = await query('SELECT owner_email FROM tenants WHERE id = ?', [req.user.tenantId]);
        if (t.rows[0]?.owner_email) hub.pingActivity(t.rows[0].owner_email);
    } catch (_) {}
    res.json({ ok: true, message: 'Hesap kapatma talebiniz alındı ve erişim durduruldu.' });
};

// Logo: Ayarlar > Logo'dan data URL gelir, urun gorselleri gibi diske yazilir (base64 DB'de degil).
// logoUrl alani hic gelmezse dokunulmaz, '' gelirse kaldirilir. Eski dosya best-effort silinir.
async function logoHazirla(tenantId, logoUrl) {
    if (logoUrl === undefined) return { degis: 0, yol: null };
    if (!logoUrl) return { degis: 1, yol: null };
    if (typeof logoUrl !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/i.test(logoUrl)) {
        const e = new Error('Logo PNG, JPG veya WebP dosyası olmalı.'); e.status = 400; throw e;
    }
    return { degis: 1, yol: await saveDataUrl(tenantId, logoUrl) };
}
function eskiLogoyuSil(tenantId, eski, yeni) {
    const onek = `/uploads/${tenantId}/`;
    if (!eski || eski === yeni || !eski.startsWith(onek)) return;
    const dosya = path.join(UPLOADS_DIR, tenantId, path.basename(eski));
    fs.promises.unlink(dosya).catch(() => {});
}

exports.updateProfile = async (req, res) => {
    const f = req.body || {};
    let logo;
    try { logo = await logoHazirla(req.user.tenantId, f.logoUrl); }
    catch (e) { return res.status(e.status || 500).json({ message: e.message || 'Logo kaydedilemedi.' }); }
    let eskiLogo = null;
    if (logo.degis) {
        const e = await query('SELECT logo_url FROM tenants WHERE id = ?', [req.user.tenantId]);
        eskiLogo = e.rows[0] ? e.rows[0].logo_url : null;
    }
    await query(
        `UPDATE tenants
            SET business_name = COALESCE(?, business_name),
                phone = COALESCE(?, phone),
                address = COALESCE(?, address),
                billing_name = COALESCE(?, billing_name),
                billing_address = COALESCE(?, billing_address),
                billing_tax_id = COALESCE(?, billing_tax_id),
                billing_tax_office = COALESCE(?, billing_tax_office),
                currency = COALESCE(?, currency),
                tax_rate = COALESCE(?, tax_rate),
                show_cost_analytics = COALESCE(?, show_cost_analytics),
                stock_module_on = COALESCE(?, stock_module_on),
                stock_out_blocks_sale = COALESCE(?, stock_out_blocks_sale),
                qr_onay_gerekli = COALESCE(?, qr_onay_gerekli),
                mutfak_ekrani = COALESCE(?, mutfak_ekrani),
                logo_url = CASE WHEN ? = 1 THEN ? ELSE logo_url END
          WHERE id = ?`,
        [f.businessName, f.phone, f.address,
            f.billingName, f.billingAddress, f.billingTaxId, f.billingTaxOffice,
            f.currency, f.taxRate,
            f.showCostAnalytics == null ? null : (f.showCostAnalytics ? 1 : 0),
            f.stockModuleOn == null ? null : (f.stockModuleOn ? 1 : 0),
            f.stockOutBlocksSale == null ? null : (f.stockOutBlocksSale ? 1 : 0),
            f.qrOnayGerekli == null ? null : (f.qrOnayGerekli ? 1 : 0),
            f.mutfakEkrani == null ? null : (f.mutfakEkrani ? 1 : 0),
            logo.degis, logo.yol,
            req.user.tenantId]
    );
    if (logo.degis) eskiLogoyuSil(req.user.tenantId, eskiLogo, logo.yol);
    res.json({ message: 'Güncellendi.', logoUrl: logo.degis ? logo.yol : undefined });
};
