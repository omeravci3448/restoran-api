const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const totp = require('../services/totp');

// --- EKOSİSTEM YÖNETİMİ (root) ---
//
// Belediyenin birden çok işletmesi var. Her işletme ayrı bir "kiracı"dır:
// kendi menüsü, masaları, karekodları, personeli ve raporu. Root kullanıcı
// yeni işletme açar, adını/limitlerini yönetir, gerektiğinde kapatır.
//
// GÜVENLİK - root kiracılardan TAMAMEN ayrıdır:
//  - Ayrı tablo (root_users), ayrı giriş ucu, ayrı JWT kapsamı ('root').
//  - Kiracı jetonuyla root ucuna girilemez: protectRoot scope='root' arar.
//  - Root jetonuyla kiracı ucuna girilemez: authMiddleware.protect payload.userId
//    arar, root jetonunda userId yoktur.
//  - Root parolası ortam değişkeninden kurulur; env yoksa root kullanıcı HİÇ
//    oluşmaz ve panel kapalı kalır (güvenli varsayılan).

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_OMRU = '8h';

// --- Bootstrap ---
// ROOT_EMAIL + ROOT_PASSWORD verilmişse root kullanıcıyı oluşturur/günceller.
// Verilmemişse hiçbir şey yapmaz: root panel kullanılamaz, bu bilinçli.
async function ensureRootUser() {
    const email = (process.env.ROOT_EMAIL || '').trim().toLowerCase();
    const sifre = process.env.ROOT_PASSWORD || '';
    if (!email || !sifre) return { kuruldu: false, sebep: 'ROOT_EMAIL/ROOT_PASSWORD tanımlı değil' };
    if (sifre.length < 10) {
        console.warn('[root] ROOT_PASSWORD 10 karakterden kısa - root kullanıcı kurulmadı.');
        return { kuruldu: false, sebep: 'parola çok kısa' };
    }
    const hash = await bcrypt.hash(sifre, 10);
    const v = await query('SELECT id FROM root_users WHERE email = ?', [email]);
    if (v.rows.length) {
        await query('UPDATE root_users SET password_hash = ?, is_active = 1 WHERE id = ?', [hash, v.rows[0].id]);
    } else {
        await query('INSERT INTO root_users (id, email, password_hash, name) VALUES (?, ?, ?, ?)',
            [uuidv4(), email, hash, 'Ekosistem Yöneticisi']);
    }
    return { kuruldu: true, email };
}

// --- Giriş ---
// Deneme sınırı: root parolası ekosistemin ana anahtarı, kaba kuvvet denemesi
// pahalıya patlamalı. Bellek içi sayaç (tek konteyner yeterli).
const denemeler = new Map(); // email -> { sayi, sifirlanma }
function kisitliMi(email) {
    const k = denemeler.get(email);
    return !!(k && Date.now() < k.sifirlanma && k.sayi >= 5);
}
function basarisiz(email) {
    const k = denemeler.get(email);
    if (!k || Date.now() >= k.sifirlanma) denemeler.set(email, { sayi: 1, sifirlanma: Date.now() + 15 * 60 * 1000 });
    else k.sayi++;
}

// Kullanıcı bulunamasa bile bcrypt çalıştırılır: cevap süresinden "bu e-posta
// kayıtlı mı" anlaşılmasın (zamanlama sızıntısı).
const SAHTE_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

exports.login = async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const sifre = String(req.body?.password || '');
    const kod = String(req.body?.code || '');
    if (!email || !sifre) return res.status(400).json({ message: 'E-posta ve şifre gerekli.' });
    if (kisitliMi(email)) {
        return res.status(429).json({ message: 'Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.' });
    }
    const r = await query('SELECT * FROM root_users WHERE email = ? AND is_active = 1', [email]);
    const hash = r.rows[0]?.password_hash || SAHTE_HASH;
    const ok = await bcrypt.compare(sifre, hash);
    if (!r.rows.length || !ok) {
        basarisiz(email);
        return res.status(401).json({ message: 'E-posta veya şifre hatalı.' });
    }
    const u = r.rows[0];

    // --- Authenticator (TOTP) ikinci kapi ---
    if (u.totp_enabled) {
        if (!kod) {
            // Parola dogru ama kod yok: istemci kod ekranini acsin.
            return res.status(401).json({ needTotp: true, message: 'Authenticator kodunu girin.' });
        }
        const adim = totp.dogrula(u.totp_secret, kod);
        if (adim === null) {
            basarisiz(email);   // yanlis kod da deneme sayar
            return res.status(401).json({ needTotp: true, message: 'Kod geçersiz veya süresi dolmuş.' });
        }
        // Tekrar saldirisi: ayni kod ikinci kez kullanilamaz.
        if (u.totp_last_step != null && Number(adim) <= Number(u.totp_last_step)) {
            basarisiz(email);
            return res.status(401).json({ needTotp: true, message: 'Bu kod zaten kullanıldı, yenisini bekleyin.' });
        }
        await query('UPDATE root_users SET totp_last_step = ? WHERE id = ?', [adim, u.id]);
    } else {
        // Henuz kurulmamis: parola dogru ama panele GIRILEMEZ. Once authenticator
        // baglanacak. Kisa omurlu kurulum jetonu veriyoruz - tam yetki DEGIL.
        const sir = u.totp_secret || totp.sirUret();
        if (!u.totp_secret) await query('UPDATE root_users SET totp_secret = ? WHERE id = ?', [sir, u.id]);
        const kurulumJetonu = jwt.sign({ rootId: u.id, scope: 'root-totp-kurulum' }, JWT_SECRET, { expiresIn: '10m' });
        denemeler.delete(email);
        return res.status(200).json({
            totpKurulumGerekli: true,
            kurulumJetonu,
            sir,                                   // elle girmek isteyen icin
            otpauth: totp.otpauthUri({ sir, hesap: u.email }),
            message: 'Authenticator uygulamanıza ekleyin, sonra ürettiği kodu girin.',
        });
    }

    denemeler.delete(email);
    await query('UPDATE root_users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), u.id]);
    const token = jwt.sign({ rootId: u.id, scope: 'root' }, JWT_SECRET, { expiresIn: TOKEN_OMRU });
    res.json({ token, email: u.email, name: u.name });
};

// --- Authenticator kurulumunu tamamla ---
// Kurulum jetonu + uygulamanin urettigi kod dogrulanirsa TOTP acilir ve
// gercek oturum jetonu verilir.
exports.totpKur = async (req, res) => {
    const auth = req.headers.authorization || '';
    const jeton = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!jeton) return res.status(401).json({ message: 'Kurulum jetonu gerekli.' });
    let p;
    try { p = jwt.verify(jeton, JWT_SECRET); } catch { return res.status(401).json({ message: 'Jeton geçersiz.' }); }
    if (p.scope !== 'root-totp-kurulum' || !p.rootId) return res.status(403).json({ message: 'Yetkisiz.' });

    const r = await query('SELECT * FROM root_users WHERE id = ? AND is_active = 1', [p.rootId]);
    if (!r.rows.length) return res.status(401).json({ message: 'Kullanıcı yok.' });
    const u = r.rows[0];
    if (u.totp_enabled) return res.status(409).json({ message: 'Authenticator zaten kurulu.' });

    const adim = totp.dogrula(u.totp_secret, String(req.body?.code || ''));
    if (adim === null) return res.status(401).json({ message: 'Kod doğrulanamadı. Telefon saatinizin doğru olduğundan emin olun.' });

    await query('UPDATE root_users SET totp_enabled = 1, totp_last_step = ?, last_login_at = ? WHERE id = ?',
        [adim, new Date().toISOString(), u.id]);
    const token = jwt.sign({ rootId: u.id, scope: 'root' }, JWT_SECRET, { expiresIn: TOKEN_OMRU });
    res.json({ token, email: u.email, name: u.name, message: 'Authenticator kuruldu.' });
};

exports.me = async (req, res) => {
    res.json({ id: req.root.id, email: req.root.email, name: req.root.name, scope: 'root' });
};

// --- İşletme listesi ---
exports.listTenants = async (_req, res) => {
    const r = await query(
        `SELECT t.id, t.business_code, t.business_name, t.parent_org, t.slug,
                t.owner_email, t.phone, t.license_modules,
                t.license_end_date, t.license_table_limit, t.is_active, t.created_at,
                (SELECT COUNT(*) FROM tables   x WHERE x.tenant_id = t.id AND x.is_active = 1)    AS masa_sayisi,
                (SELECT COUNT(*) FROM products x WHERE x.tenant_id = t.id AND x.is_available = 1) AS urun_sayisi,
                (SELECT COUNT(*) FROM users    x WHERE x.tenant_id = t.id AND x.is_active = 1)    AS kullanici_sayisi,
                (SELECT COUNT(*) FROM orders   x WHERE x.tenant_id = t.id AND x.status = 'OPEN')  AS acik_siparis
           FROM tenants t
          ORDER BY t.is_active DESC, t.business_name`);
    res.json(r.rows.map(t => {
        let mods = [];
        try { mods = t.license_modules ? JSON.parse(t.license_modules) : []; } catch (_) {}
        return { ...t, license_modules: mods };
    }));
};

// --- Yardımcılar ---
const slugify = (s) => String(s || '').toLowerCase()
    .replace(/[ığüşöçİ]/g, m => ({ 'ı': 'i', 'ğ': 'g', 'ü': 'u', 'ş': 's', 'ö': 'o', 'ç': 'c', 'İ': 'i' }[m]))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

async function benzersizSlug(ad) {
    const taban = slugify(ad) || 'isletme';
    for (let i = 0; i < 40; i++) {
        const aday = i === 0 ? taban : `${taban}-${i + 1}`;
        const v = await query('SELECT 1 FROM tenants WHERE slug = ?', [aday]);
        if (!v.rows.length) return aday;
    }
    return `${taban}-${crypto.randomBytes(3).toString('hex')}`;
}

async function benzersizKod() {
    for (let i = 0; i < 40; i++) {
        const kod = String(10000 + Math.floor(Math.random() * 90000));
        const v = await query('SELECT 1 FROM tenants WHERE business_code = ?', [kod]);
        if (!v.rows.length) return kod;
    }
    throw new Error('İşyeri kodu üretilemedi.');
}

const VARSAYILAN_MODULLER = ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK', 'FINANSAL_RAPORLAMA'];

// --- Yeni işletme aç ---
exports.createTenant = async (req, res) => {
    const f = req.body || {};
    const ad = String(f.businessName || '').trim();
    const eposta = String(f.ownerEmail || '').trim().toLowerCase();
    const sifre = String(f.ownerPassword || '');

    if (!ad) return res.status(400).json({ message: 'İşletme adı zorunlu.' });
    if (!eposta) return res.status(400).json({ message: 'Yönetici e-postası zorunlu.' });
    if (sifre.length < 6) return res.status(400).json({ message: 'Yönetici şifresi en az 6 karakter olmalı.' });

    // İstenen işyeri kodu verildiyse onu kullan, yoksa üret
    let kod = String(f.businessCode || '').trim();
    if (kod) {
        const v = await query('SELECT 1 FROM tenants WHERE business_code = ?', [kod]);
        if (v.rows.length) return res.status(409).json({ message: 'Bu işyeri kodu zaten kullanılıyor.' });
    } else {
        kod = await benzersizKod();
    }

    const slug = await benzersizSlug(ad);
    const tenantId = uuidv4();
    const moduller = Array.isArray(f.modules) && f.modules.length ? f.modules : VARSAYILAN_MODULLER;
    // Masa limiti: boş => sınırsız (belediye işletmelerinde lisans satmıyoruz)
    const masaLimiti = (f.tableLimit === '' || f.tableLimit == null) ? null : (Number(f.tableLimit) || null);
    const bitis = f.licenseEndDate || '2099-12-31T23:59:59.000Z';

    await query(
        `INSERT INTO tenants
            (id, slug, business_code, business_name, parent_org, owner_email, phone, address,
             billing_name, license_tier, license_modules, license_end_date,
             license_table_limit, is_active, show_cost_analytics)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        [tenantId, slug, kod, ad, f.parentOrg || null, eposta, f.phone || null, f.address || null,
            ad, 'TIER_KURUM', JSON.stringify(moduller), bitis, masaLimiti]);

    await query(
        'INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)',
        [uuidv4(), tenantId, eposta, await bcrypt.hash(sifre, 10), ad + ' Yönetimi', 'OWNER']);

    res.status(201).json({
        id: tenantId, businessCode: kod, slug, businessName: ad,
        message: `${ad} açıldı. Giriş: ${eposta} - işyeri kodu ${kod}`
    });
};

// --- İşletme güncelle ---
// slug ve business_code DEĞİŞTİRİLMEZ: slug basılı karekodların içinde geçer,
// kod ise personelin giriş ekranında kullandığı sabittir. Değişselerdi sahadaki
// karekodlar ve personelin giriş alışkanlığı kırılırdı.
exports.updateTenant = async (req, res) => {
    const f = req.body || {};
    const limitGeldi = Object.prototype.hasOwnProperty.call(f, 'tableLimit');
    const masaLimiti = limitGeldi ? ((f.tableLimit === '' || f.tableLimit == null) ? null : (Number(f.tableLimit) || null)) : null;
    await query(
        `UPDATE tenants
            SET business_name = COALESCE(?, business_name),
                parent_org    = COALESCE(?, parent_org),
                owner_email   = COALESCE(?, owner_email),
                phone         = COALESCE(?, phone),
                address       = COALESCE(?, address),
                license_modules     = COALESCE(?, license_modules),
                license_end_date    = COALESCE(?, license_end_date),
                license_table_limit = CASE WHEN ? = 1 THEN ? ELSE license_table_limit END,
                is_active     = COALESCE(?, is_active)
          WHERE id = ?`,
        [f.businessName || null, f.parentOrg || null, f.ownerEmail || null, f.phone || null, f.address || null,
            Array.isArray(f.modules) ? JSON.stringify(f.modules) : null,
            f.licenseEndDate || null,
            limitGeldi ? 1 : 0, masaLimiti,
            f.isActive == null ? null : (f.isActive ? 1 : 0),
            req.params.id]);
    res.json({ ok: true, message: 'Güncellendi.' });
};

// --- Yönetici şifresini sıfırla ---
// İşletme şifresini unuttuğunda root yeni şifre verir. Kiracının kendi
// verisine dokunmaz, yalnız OWNER hesabının parolasını değiştirir.
exports.resetOwnerPassword = async (req, res) => {
    const yeni = String(req.body?.password || '');
    if (yeni.length < 6) return res.status(400).json({ message: 'Şifre en az 6 karakter olmalı.' });
    const t = await query('SELECT owner_email FROM tenants WHERE id = ?', [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ message: 'İşletme bulunamadı.' });
    const u = await query("SELECT id FROM users WHERE tenant_id = ? AND role = 'OWNER' ORDER BY created_at LIMIT 1",
        [req.params.id]);
    if (!u.rows.length) return res.status(404).json({ message: 'Bu işletmede yönetici hesabı yok.' });
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(yeni, 10), u.rows[0].id]);
    res.json({ ok: true, message: 'Yönetici şifresi güncellendi.', email: t.rows[0].owner_email });
};

module.exports.ensureRootUser = ensureRootUser;
