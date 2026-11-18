const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const lisans = require('../services/lisansDurumu');
const { AD: MODUL_AD } = require('../services/lisansModul');
const destek = require('../services/destekOturumu');   // root destek oturumu (JWT'de destek claim'i)

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// JWT doğrula + tenant'ı yükle + lisans tarihini kontrol et
async function protect(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Token gerekli.' });

    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token geçersiz.' }); }

    let u;
    if (payload.destek) {
        // Destek oturumu (root): kullanici satiri yok; oturum + isletme satiri. Kapali / suresi gecmis oturum 401.
        const d = await destek.kimlik(payload);
        if (d.hata) return res.status(d.hata.status).json(d.hata.body);
        u = d.u;
    } else {
        const userRes = await query(
            `SELECT u.*, t.id as tenant_id, t.business_name, t.license_end_date,
                    t.license_modules, t.license_tier, t.license_table_limit,
                    t.is_active as tenant_active
               FROM users u JOIN tenants t ON t.id = u.tenant_id
              WHERE u.id = ?`,
            [payload.userId]
        );
        if (!userRes.rows.length) return res.status(401).json({ message: 'Kullanıcı bulunamadı.' });
        u = userRes.rows[0];
    }

    if (!u.is_active) return res.status(403).json({ message: 'Kullanıcı pasif.' });
    if (!u.tenant_active) return res.status(403).json({ code: 'TENANT_INACTIVE', message: 'İşletme pasif (lisans).' });

    // Lisans kapisi — ani kapatma YOK, kademeli (bkz services/lisansDurumu.js):
    //   AKTIF -> (bitis) -> SALT_OKUNUR 3 gun -> (3. gunun sonunda 00:00) -> KAPALI
    // POS bir kasa programi; gun ortasinda kapanmasi isletmeyi satistan alikoyar.
    // Odeme korumasi (services/odemeKorumasi.js): "odemeyi yaptim" sonrasi onay beklerken N gun AKTIF sayilir.
    const ld = await require('../services/odemeKorumasi').etkinDurum(u.tenant_id, u.license_end_date);
    // KAPALI: yalniz lisans yenilemesi (bkz lisansDurumu.kapalidaGecerMi). Arayuz bu kodla Lisans sayfasina doner.
    // Destek oturumu (karar 2026-11-12): KAPALI isletmede okuma (GET) serbest, Patron kapanmis hesaba bakabilsin;
    // yazma yalniz isletmenin kendisine acik uclarda (lisans + bekleyen magaza siparisi). Salt-okunurda destek de
    // salt-okunur (asagidaki kural ayni).
    const okumaIstegi = ['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase());
    if (ld.durum === lisans.DURUM.KAPALI && !lisans.kapalidaGecerMi(req) && !(u.destek && okumaIstegi)) {
        return res.status(403).json({
            code: 'LICENSE_EXPIRED',
            message: 'Lisansınızın süresi doldu. Yenilemek için Lisans sayfasına gidin.',
            bitis: ld.bitis, toleransBitis: ld.toleransBitis,
        });
    }
    if (ld.durum === lisans.DURUM.SALT_OKUNUR && !lisans.saltOkunurdaGecerMi(req)) {
        return res.status(403).json({
            code: 'LICENSE_READONLY',
            message: 'Lisansınızın süresi doldu. Şu an yalnızca görüntüleme yapabilirsiniz; '
                   + 'satış ve kayıt işlemleri için paketinizi yenileyin.',
            kalanGun: ld.kalanGun, toleransBitis: ld.toleransBitis,
        });
    }

    let modules = [];
    try { modules = u.license_modules ? JSON.parse(u.license_modules) : []; } catch (_) {}

    req.user = {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        tenantId: u.tenant_id,
        businessName: u.business_name,
        licenseTier: u.license_tier,
        licenseTableLimit: u.license_table_limit, // null = sınırsız
        modules,
        lisansDurum: ld.durum,
        lisansBitis: ld.bitis,
        lisansKalanGun: ld.kalanGun,
        lisansToleransBitis: ld.toleransBitis,
        lisansAktifBitis: ld.aktifBitis || null,
        odemeKorumasi: ld.odemeKorumasi || null,   // { bitis }: lisans bitti ama odeme onay bekliyor, program acik
    };
    if (u.destek) {
        // Destek oturumu: giris bilgisi / personel / hesap kapatma 403; her basarili yazma Islem Gunlugu'ne "MDA Destek"
        req.user.destek = u.destek;
        const yasak = destek.yasakMi(req);
        if (yasak) return res.status(403).json(yasak);
        destek.istekKaydi(req, res);
    }
    next();
}

// Belirli bir modülün lisansta açık olmasını ister (örn requireModule('STOK')).
// POS'a ozgu uclar requireModule('BASE') ile korunur: "Adisyon ve Kasa" olmayan (yalniz QR menu) isletme
// menu, urun, kategori, masa, ayar, logo, lisans ve plaka uclarini kullanir; siparis/odeme/rapor... 403.
function requireModule(moduleName) {
    return requireAnyModule(moduleName);
}

// Verilen modullerden EN AZ BIRI lisansta olmali (orn. telefon bildirimi: BASE ya da GARSON)
function requireAnyModule(...moduller) {
    return (req, res, next) => {
        const mods = req.user?.modules || [];
        if (mods.includes('ALL') || moduller.some((m) => mods.includes(m))) return next();
        const ad = moduller.map((m) => MODUL_AD[m] || m).join(' ya da ');
        return res.status(403).json({
            code: 'MODULE_NOT_LICENSED',
            module: moduller[0],
            modules: moduller,
            message: `${ad} modülü lisansınızda yok. Lisans / Paket sayfasından ekleyebilirsiniz.`
        });
    };
}

// Belirli rolleri ister
function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
            return res.status(403).json({ message: 'Bu işlem için yetkiniz yok.' });
        }
        next();
    };
}

// Yönetici şifresi ister — kasiyerlerin rapor/ayar/lisans sayfalarına
// erişmesini engeller. x-manager-pin header'ı tenant.manager_pin (hash) ile
// karşılaştırılır. PIN henüz hiç ayarlanmadıysa erişime izin verir (ilk kurulum
// için; sahip Ayarlar'dan PIN belirleyince koruma devreye girer).
// Deneme siniri: manager-verify ile AYNI sayac (services/yoneticiSifreSiniri.js); 5 dakikada 8 hatali
// sifreden sonra 429 MANAGER_PIN_LOCKED. Sifre gonderilmeyen istek (baslik yok) deneme sayilmaz.
const bcryptMw = require('bcryptjs');
const YSS = require('../services/yoneticiSifreSiniri');
function requireManagerPin(req, res, next) {
    // Destek oturumunda yonetici sifresi sorulmaz; atlama oturuma ve yonetim gunlugune yazilir (ilk seferinde)
    if (req.user && req.user.destek) { destek.pinAtlandi(req); return next(); }
    query('SELECT manager_pin FROM tenants WHERE id = ?', [req.user.tenantId])
        .then(async (r) => {
            const hash = r.rows[0]?.manager_pin;
            if (!hash) return next(); // henüz ayarlanmamış → açık (ilk kurulum)
            const pin = req.headers['x-manager-pin'] || '';
            if (YSS.kilitliMi(req.user.tenantId)) {
                return res.status(429).json({ code: 'MANAGER_PIN_LOCKED', message: YSS.KILIT_MESAJI });
            }
            if (!pin) return res.status(403).json({ code: 'MANAGER_PIN_REQUIRED', message: 'Yönetici şifresi gerekli.' });
            const bitir = YSS.denemeBaslat(req.user.tenantId);
            if (!bitir) return res.status(429).json({ code: 'MANAGER_PIN_LOCKED', message: YSS.KILIT_MESAJI });
            let ok = false;
            try { ok = await bcryptMw.compare(String(pin), hash); }
            finally { bitir(ok); }
            if (ok) return next();
            return res.status(403).json({ code: 'MANAGER_PIN_REQUIRED', message: 'Yönetici şifresi gerekli.' });
        })
        .catch(() => res.status(500).json({ message: 'Yetki kontrolü hatası.' }));
}

function signToken(userId) {
    // Her oturum acilisi (giris, kayit, deneme devri) buradan gecer: root isletme ayrintisindaki "son giris"
    query('UPDATE users SET son_giris_at = ? WHERE id = ?', [new Date().toISOString(), userId]).catch(() => {});
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '12h' });
}

module.exports = { protect, requireModule, requireAnyModule, requireRole, requireManagerPin, signToken };
