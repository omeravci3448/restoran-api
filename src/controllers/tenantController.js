const { query } = require('../config/db');

exports.getProfile = async (req, res) => {
    const r = await query(
        `SELECT id, slug, business_code, business_name, owner_email, phone, address,
                billing_name, billing_address, billing_tax_id, billing_tax_office,
                referral_code, referred_by, discount_rate,
                currency, tax_rate,
                license_tier, license_modules, license_end_date, show_cost_analytics,
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

exports.updateProfile = async (req, res) => {
    const f = req.body;
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
                show_cost_analytics = COALESCE(?, show_cost_analytics)
          WHERE id = ?`,
        [f.businessName, f.phone, f.address,
            f.billingName, f.billingAddress, f.billingTaxId, f.billingTaxOffice,
            f.currency, f.taxRate,
            f.showCostAnalytics == null ? null : (f.showCostAnalytics ? 1 : 0),
            req.user.tenantId]
    );
    res.json({ message: 'Güncellendi.' });
};
