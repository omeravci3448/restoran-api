const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const { signToken } = require('../middleware/authMiddleware');
const hubService = require('../services/hubService');
const { sendOTP } = require('../services/emailService');

// ——— Yardımcılar ———

const sixDigit = () => String(Math.floor(100000 + Math.random() * 900000));

// 5 haneli random sayı (10000-99999), mevcut tenant'larda çakışmadığını garanti eder
async function newBusinessCode() {
    for (let i = 0; i < 30; i++) {
        const code = String(10000 + Math.floor(Math.random() * 90000));
        const exists = await query('SELECT 1 FROM tenants WHERE business_code = ?', [code]);
        if (!exists.rows.length) return code;
    }
    throw new Error('İşyeri kodu üretilemedi (çok fazla çakışma — 5 haneyi 6 haneye çıkarmak gerek).');
}

const slugify = (s) => (s || '').toLowerCase()
    .replace(/[ığüşöç]/g, m => ({ 'ı': 'i', 'ğ': 'g', 'ü': 'u', 'ş': 's', 'ö': 'o', 'ç': 'c' }[m]))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// ——— ADIM 1: Kayıt formu gönder, OTP yolla ———
exports.requestRegistration = async (req, res) => {
    const f = req.body || {};
    if (!f.businessName || !f.email || !f.password) {
        return res.status(400).json({ message: 'İşletme adı, e-posta ve şifre zorunlu.' });
    }
    if (String(f.password).length < 6) {
        return res.status(400).json({ message: 'Şifre en az 6 karakter olmalı.' });
    }
    // KVKK açık rıza zorunlu (kayıt için)
    if (!f.kvkkConsent) {
        return res.status(400).json({ message: 'Devam etmek için KVKK Aydınlatma Metni\'ni onaylamanız gerekir.' });
    }

    // Bu e-posta zaten kayıtlıysa engelle
    const existing = await query('SELECT 1 FROM users WHERE email = ?', [f.email]);
    if (existing.rows.length) return res.status(409).json({ message: 'Bu e-posta zaten kayıtlı. Giriş yap veya farklı e-posta kullan.' });

    // Aynı e-posta için varsa eski pending kaydı temizle
    await query('DELETE FROM pending_registrations WHERE email = ?', [f.email]);

    const otp = sixDigit();
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const pendingId = uuidv4();

    // Form datayı serialize et — verify aşamasında tenant oluştururken kullanılacak
    const formData = {
        businessName: f.businessName,
        email: f.email,
        password: f.password,  // verify aşamasına kadar saklanır, sonra hash'lenir ve silinir
        phone: f.phone || null,
        address: f.address || null,
        billingName: f.billingName || f.businessName,
        billingAddress: f.billingAddress || f.address || null,
        billingTaxId: f.billingTaxId || null,
        billingTaxOffice: f.billingTaxOffice || null,
        tier: f.tier || 'TIER_1_5',
        modules: Array.isArray(f.modules) ? f.modules : ['BASE'],
        referredBy: f.referredBy ? String(f.referredBy).toUpperCase().trim() : null,
        kvkkConsent: true,
        kvkkConsentVersion: f.kvkkConsentVersion || '1.0'
    };

    await query(
        `INSERT INTO pending_registrations (id, email, form_data, otp_code, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [pendingId, f.email, JSON.stringify(formData), otp, expires]
    );

    const result = await sendOTP(f.email, otp, f.businessName);
    res.status(201).json({
        pendingId,
        email: f.email,
        message: 'Doğrulama kodu e-postanıza gönderildi.',
        devOtp: result.dev ? otp : undefined  // SMTP yoksa dev için OTP geri döner
    });
};

// ——— ADIM 2: OTP doğrula → tenant oluştur, hub'a gönder, JWT döndür ———
exports.verifyRegistration = async (req, res) => {
    const { pendingId, otp } = req.body || {};
    if (!pendingId || !otp) return res.status(400).json({ message: 'pendingId ve OTP zorunlu.' });

    const pRes = await query('SELECT * FROM pending_registrations WHERE id = ?', [pendingId]);
    if (!pRes.rows.length) return res.status(404).json({ message: 'Kayıt bulunamadı veya süresi doldu.' });

    const p = pRes.rows[0];
    if (new Date(p.expires_at) < new Date()) {
        await query('DELETE FROM pending_registrations WHERE id = ?', [pendingId]);
        return res.status(410).json({ message: 'Doğrulama kodu süresi doldu. Tekrar kayıt başlatın.' });
    }
    if (Number(p.attempts) >= 5) {
        await query('DELETE FROM pending_registrations WHERE id = ?', [pendingId]);
        return res.status(429).json({ message: 'Çok fazla hatalı deneme. Tekrar kayıt başlatın.' });
    }
    if (String(otp).trim() !== p.otp_code) {
        await query('UPDATE pending_registrations SET attempts = attempts + 1 WHERE id = ?', [pendingId]);
        return res.status(400).json({ message: 'Doğrulama kodu hatalı.' });
    }

    const form = JSON.parse(p.form_data);
    const tenantId = uuidv4();
    const userId = uuidv4();
    const slug = slugify(form.businessName) + '-' + crypto.randomBytes(2).toString('hex');
    const bizCode = await newBusinessCode();
    const refCode = 'MDA' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const hash = await bcrypt.hash(form.password, 10);

    // Demo lisans — 7 gün boyunca TÜM modüller açık (müşteri her şeyi denesin).
    // Demo sonunda satın alırken hangi modülleri tuttuğu lisansla belirlenir.
    // Tier'ın MASA LİMİTİ yine geçerli (kayıttaki paket seçimi sınırlar).
    const demoEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    // Hub erişilemezse bile demoda tüm modüller açık olsun diye bilinen liste (fallback)
    const DEMO_FALLBACK_MODULES = ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK', 'MARKETPLACE', 'FINANSAL_RAPORLAMA'];
    // Hub erişilemezse masa limiti yine uygulansın diye bilinen tier limitleri (fallback).
    // null = sınırsız (TIER_20_PLUS). Bilinmeyen tier → güvenli küçük default (5).
    const FALLBACK_TIER_LIMITS = { TIER_1_5: 5, TIER_6_10: 10, TIER_11_20: 20, TIER_20_PLUS: null };
    let modules = Array.isArray(form.modules) ? form.modules : [];
    let tableLimit;
    try {
        const catalog = await hubService.getModulesAndTiers();
        const allModuleNames = (catalog.modules || []).map(m => m.name);
        modules = Array.from(new Set([...modules, ...allModuleNames]));
        const tierRow = catalog.tiers.find(t => t.name === form.tier);
        // Hub tier'ı bulduysa onu kullan; bulamadıysa fallback
        tableLimit = tierRow ? (tierRow.tableLimit ?? null)
            : (form.tier in FALLBACK_TIER_LIMITS ? FALLBACK_TIER_LIMITS[form.tier] : 5);
    } catch (_) {
        // Hub erişilemedi → tüm modüller + fallback masa limiti (sınırsız masa açığı kapatıldı)
        modules = Array.from(new Set([...modules, ...DEMO_FALLBACK_MODULES]));
        tableLimit = form.tier in FALLBACK_TIER_LIMITS ? FALLBACK_TIER_LIMITS[form.tier] : 5;
    }

    await tx(async () => {
        await query(
            `INSERT INTO tenants
                (id, slug, business_code, business_name, owner_email, phone, address,
                 billing_name, billing_address, billing_tax_id, billing_tax_office,
                 referral_code, referred_by, discount_rate,
                 license_tier, license_modules, license_end_date, license_table_limit,
                 kvkk_consent_at, kvkk_consent_version, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1)`,
            [tenantId, slug, bizCode, form.businessName, form.email, form.phone, form.address,
                form.billingName, form.billingAddress, form.billingTaxId, form.billingTaxOffice,
                refCode, form.referredBy,
                form.tier, JSON.stringify(modules), demoEnd, tableLimit,
                new Date().toISOString(), form.kvkkConsentVersion || '1.0']
        );
        await query(
            `INSERT INTO users (id, tenant_id, email, password_hash, name, role)
             VALUES (?, ?, ?, ?, ?, 'OWNER')`,
            [userId, tenantId, form.email, hash, form.businessName]
        );
        await query('DELETE FROM pending_registrations WHERE id = ?', [pendingId]);
    });

    // Hub'a tam senkron — fatura/vergi/modules/referans dahil
    // Başarısız olsa bile kayıt devam etmiş olur — arka planda
    hubService.syncWithHub({
        customerEmail: form.email,
        businessName: form.businessName,
        businessType: form.tier,
        phone: form.phone,
        billingName: form.billingName,
        billingAddress: form.billingAddress,
        billingTaxId: form.billingTaxId,
        billingTaxOffice: form.billingTaxOffice,
        referralCode: refCode,
        referredBy: form.referredBy,
        modules
    }).then(async (hubResp) => {
        // Hub indirim oranı döndürürse tenant'a yaz
        if (hubResp && hubResp.discountRate != null) {
            await query('UPDATE tenants SET discount_rate = ? WHERE id = ?',
                [hubResp.discountRate, tenantId]);
        }
    }).catch(() => {});

    const token = signToken(userId);
    res.status(201).json({
        token, tenantId,
        businessName: form.businessName,
        businessCode: bizCode,
        referralCode: refCode,
        licenseTier: form.tier,
        modules,
        licenseEndDate: demoEnd,
        message: '7 günlük demo aktif. İşyeri kodunuzu kaydedin.'
    });
};

// ——— OTP'yi tekrar gönder ———
exports.resendOtp = async (req, res) => {
    const { pendingId } = req.body || {};
    const r = await query('SELECT * FROM pending_registrations WHERE id = ?', [pendingId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Kayıt bulunamadı.' });
    const p = r.rows[0];
    const newOtp = sixDigit();
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await query('UPDATE pending_registrations SET otp_code = ?, expires_at = ?, attempts = 0 WHERE id = ?',
        [newOtp, expires, pendingId]);
    const result = await sendOTP(p.email, newOtp, JSON.parse(p.form_data).businessName);
    res.json({ message: 'Yeni kod gönderildi.', devOtp: result.dev ? newOtp : undefined });
};

// ——— GİRİŞ: email + işyeri kodu + şifre ———
exports.login = async (req, res) => {
    const { email, businessCode: bizCode, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: 'E-posta ve şifre gerekli.' });

    // İşyeri kodu opsiyonel — verilirse o tenant'a, verilmezse en son kayıt olan tenant'a giriş
    let sql = `SELECT u.*, t.business_code, t.is_active AS tenant_active
                 FROM users u JOIN tenants t ON t.id = u.tenant_id
                WHERE u.email = ?`;
    const params = [email];
    if (bizCode) {
        sql += ' AND t.business_code = ?';
        params.push(String(bizCode).toUpperCase().trim());
    }
    sql += ' ORDER BY u.created_at DESC LIMIT 1';

    const r = await query(sql, params);
    if (!r.rows.length) {
        return res.status(401).json({ message: bizCode ? 'E-posta veya işyeri kodu hatalı.' : 'Hatalı kullanıcı veya şifre.' });
    }
    const u = r.rows[0];

    // Aynı e-postaya birden fazla tenant varsa kullanıcıyı bilgilendir
    if (!bizCode) {
        const multi = await query('SELECT COUNT(*) AS c FROM users WHERE email = ?', [email]);
        if (Number(multi.rows[0].c) > 1) {
            return res.status(400).json({
                code: 'MULTI_TENANT',
                message: 'Bu e-postaya birden çok işletme bağlı. Lütfen işyeri kodunu da girin.'
            });
        }
    }

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ message: 'Hatalı kullanıcı veya şifre.' });
    if (!u.tenant_active) return res.status(403).json({ message: 'İşletme pasif. Lisans yöneticisiyle iletişime geçin.' });

    // Arka planda hub ile uzlaştır (self-healing): kayıt sırasında hub erişilemediyse
    // müşteri hub'da hiç oluşmamış olabilir. Login'de tekrar sync ederek hub'da
    // müşteri + abonelik kaydını garantiye al, sonra lisansı tazele.
    (async () => {
        try {
            const t = (await query(
                `SELECT business_name, owner_email, phone, billing_name, billing_address,
                        billing_tax_id, billing_tax_office, referral_code, referred_by,
                        license_tier, license_modules
                   FROM tenants WHERE id = ?`, [u.tenant_id])).rows[0];
            if (t) {
                let mods = [];
                try { mods = JSON.parse(t.license_modules || '[]'); } catch (_) {}
                await hubService.syncWithHub({
                    customerEmail: t.owner_email,
                    businessName: t.business_name,
                    businessType: t.license_tier,
                    phone: t.phone,
                    billingName: t.billing_name,
                    billingAddress: t.billing_address,
                    billingTaxId: t.billing_tax_id,
                    billingTaxOffice: t.billing_tax_office,
                    referralCode: t.referral_code,
                    referredBy: t.referred_by,
                    modules: mods
                });
            }
        } catch (_) { /* hub erişilemezse sessiz geç */ }
        hubService.refreshTenantLicense(u.tenant_id, email).catch(() => {});
    })();
    hubService.pingActivity(email);

    const token = signToken(u.id);
    res.json({
        token, userId: u.id, role: u.role, name: u.name,
        tenantId: u.tenant_id, businessCode: u.business_code
    });
};

exports.me = async (req, res) => {
    res.json({
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        role: req.user.role,
        tenantId: req.user.tenantId,
        businessName: req.user.businessName,
        licenseTier: req.user.licenseTier,
        modules: req.user.modules
    });
};

exports.createStaff = async (req, res) => {
    const { email, password, name, role } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'E-posta ve şifre gerekli.' });
    const allowedRoles = ['CASHIER', 'WAITER', 'MANAGER'];
    const finalRole = allowedRoles.includes(role) ? role : 'CASHIER';
    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    try {
        await query(
            'INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)',
            [id, req.user.tenantId, email, hash, name || email, finalRole]
        );
        res.status(201).json({ id, email, name: name || email, role: finalRole });
    } catch (e) {
        if (String(e.message).includes('UNIQUE')) return res.status(409).json({ message: 'Bu e-posta bu işletmede zaten kayıtlı.' });
        throw e;
    }
};

exports.listStaff = async (req, res) => {
    const r = await query(
        'SELECT id, email, name, role, is_active, created_at FROM users WHERE tenant_id = ? ORDER BY created_at DESC',
        [req.user.tenantId]
    );
    res.json(r.rows);
};

// ——— YÖNETİCİ ŞİFRESİ (manager PIN) ———
// Rapor/Ayar/Lisans sayfalarını kasiyerlerden korur.

exports.managerStatus = async (req, res) => {
    const r = await query('SELECT manager_pin FROM tenants WHERE id = ?', [req.user.tenantId]);
    res.json({ isSet: !!r.rows[0]?.manager_pin });
};

// Yönetici şifresi deneme sınırı (tenant başına, bellek içi — tek container yeterli)
const mgrAttempts = new Map(); // tenantId → { count, resetAt }
function mgrRateLimited(tenantId) {
    const now = Date.now();
    const rec = mgrAttempts.get(tenantId);
    if (rec && now < rec.resetAt && rec.count >= 8) return true;
    return false;
}
function mgrRecordFail(tenantId) {
    const now = Date.now();
    const rec = mgrAttempts.get(tenantId);
    if (!rec || now >= rec.resetAt) mgrAttempts.set(tenantId, { count: 1, resetAt: now + 5 * 60 * 1000 });
    else rec.count++;
}
function mgrReset(tenantId) { mgrAttempts.delete(tenantId); }

exports.managerSet = async (req, res) => {
    const { pin, currentPin } = req.body || {};
    if (!pin || String(pin).length < 6) {
        return res.status(400).json({ message: 'Yönetici şifresi en az 6 haneli olmalı.' });
    }
    const r = await query('SELECT manager_pin FROM tenants WHERE id = ?', [req.user.tenantId]);
    const existing = r.rows[0]?.manager_pin;
    // Zaten ayarlıysa değiştirmek için mevcut şifre gerekir (kasiyer ele geçiremesin)
    if (existing) {
        const ok = currentPin && await bcrypt.compare(String(currentPin), existing);
        if (!ok) return res.status(403).json({ message: 'Mevcut yönetici şifresi hatalı.' });
    }
    const hash = await bcrypt.hash(String(pin), 10);
    await query('UPDATE tenants SET manager_pin = ? WHERE id = ?', [hash, req.user.tenantId]);
    res.json({ ok: true });
};

exports.managerVerify = async (req, res) => {
    const { pin } = req.body || {};
    if (mgrRateLimited(req.user.tenantId)) {
        return res.status(429).json({ message: 'Çok fazla hatalı deneme. Birkaç dakika sonra tekrar deneyin.' });
    }
    const r = await query('SELECT manager_pin FROM tenants WHERE id = ?', [req.user.tenantId]);
    const hash = r.rows[0]?.manager_pin;
    if (!hash) return res.json({ ok: true, notSet: true }); // henüz ayarlanmamış
    const ok = pin && await bcrypt.compare(String(pin), hash);
    if (!ok) {
        mgrRecordFail(req.user.tenantId);
        return res.status(403).json({ ok: false, message: 'Yönetici şifresi hatalı.' });
    }
    mgrReset(req.user.tenantId);
    res.json({ ok: true });
};
