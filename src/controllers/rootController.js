const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const totp = require('../services/totp');
const YG = require('../services/yonetimGunlugu');   // yonetim gunlugu: root'un yaptigi her degisiklik

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

// ——— Yonetim APK'si: cihaz jetonu ———
// Parola + authenticator ile BIR kez girilir; sonra telefon icin uzun omurlu rastgele bir jeton
// uretilir. Ham jeton yalniz telefonda (Keystore ile sifreli, parmak iziyle acilir) saklanir;
// sunucuda SHA-256 ozeti durur. Jetonla giris normal 8 saatlik root oturumu verir (cihazId ile).
const cihazDenemeleri = new Map(); // ip -> { sayi, sifirlanma }
function cihazKisitliMi(ip) { const k = cihazDenemeleri.get(ip); return !!(k && Date.now() < k.sifirlanma && k.sayi >= 10); }
function cihazBasarisiz(ip) {
    const k = cihazDenemeleri.get(ip);
    if (!k || Date.now() >= k.sifirlanma) cihazDenemeleri.set(ip, { sayi: 1, sifirlanma: Date.now() + 15 * 60 * 1000 });
    else k.sayi++;
}
const ozet = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

exports.cihazKaydet = async (req, res) => {
    const ad = String((req.body || {}).ad || 'Telefon').slice(0, 80);
    const ham = crypto.randomBytes(48).toString('base64url');
    const bildirim = crypto.randomBytes(32).toString('base64url');
    const id = uuidv4();
    await query('INSERT INTO root_cihazlar (id, root_id, ad, token_hash, bildirim_hash) VALUES (?, ?, ?, ?, ?)',
        [id, req.root.id, ad, ozet(ham), ozet(bildirim)]);
    res.status(201).json({ id, ad, cihazJetonu: ham, bildirimJetonu: bildirim });
};

exports.cihazGiris = async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '?';
    if (cihazKisitliMi(ip)) return res.status(429).json({ message: 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.' });
    const ham = String((req.body || {}).cihazJetonu || '');
    if (ham.length < 32) { cihazBasarisiz(ip); return res.status(401).json({ message: 'Cihaz jetonu geçersiz.' }); }
    const r = await query(
        `SELECT c.id, c.root_id, u.email, u.name FROM root_cihazlar c JOIN root_users u ON u.id = c.root_id
          WHERE c.token_hash = ? AND c.revoked_at IS NULL AND u.is_active = 1`, [ozet(ham)]);
    if (!r.rows.length) { cihazBasarisiz(ip); return res.status(401).json({ message: 'Cihaz jetonu geçersiz ya da iptal edilmiş.' }); }
    const c = r.rows[0];
    cihazDenemeleri.delete(ip);
    await query('UPDATE root_cihazlar SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [c.id]);
    await query('UPDATE root_users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), c.root_id]);
    const token = jwt.sign({ rootId: c.root_id, scope: 'root', cihazId: c.id }, JWT_SECRET, { expiresIn: TOKEN_OMRU });
    res.json({ token, email: c.email, name: c.name, cihazId: c.id });
};

exports.cihazListe = async (req, res) => {
    const r = await query('SELECT id, ad, created_at, last_used_at, revoked_at FROM root_cihazlar WHERE root_id = ? ORDER BY created_at DESC', [req.root.id]);
    res.json(r.rows.map(x => ({ ...x, buCihaz: x.id === req.rootCihazId })));
};

// Belirli cihazi (body.id) ya da bu oturumun cihazini iptal eder.
exports.cihazUnut = async (req, res) => {
    const id = String((req.body || {}).id || req.rootCihazId || '');
    if (!id) return res.status(400).json({ message: 'Cihaz belirtilmedi.' });
    const r = await query('UPDATE root_cihazlar SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND root_id = ? AND revoked_at IS NULL', [id, req.root.id]);
    if (!r.changes) return res.status(404).json({ message: 'Cihaz bulunamadı ya da zaten iptal.' });
    res.json({ ok: true });
};

// ——— Telefon bildirimi (arka plan sorgusu) ———
// Cihaz jetonu telefonda parmak iziyle acilan kasada durur; arka planda calisan bildirim isi ona
// ulasamaz. Bu yuzden cihaza ikinci, DAR yetkili bir "bildirim jetonu" verilir: tek yapabildigi,
// bekleyen odeme bildirimi sayisini ve en yenisinin ozetini sormak. Cihaz unutulunca o da duser.
// Eski (1.0) kabukla kurulmus cihaza sonradan vermek icin ayri uc var (bildirim-jetonu).
exports.cihazBildirimJetonu = async (req, res) => {
    const id = String((req.body || {}).id || req.rootCihazId || '');
    if (!id) return res.status(400).json({ message: 'Cihaz belirtilmedi.' });
    const bildirim = crypto.randomBytes(32).toString('base64url');
    const r = await query('UPDATE root_cihazlar SET bildirim_hash = ? WHERE id = ? AND root_id = ? AND revoked_at IS NULL',
        [ozet(bildirim), id, req.root.id]);
    if (!r.changes) return res.status(404).json({ message: 'Cihaz bulunamadı ya da iptal edilmiş.' });
    res.json({ bildirimJetonu: bildirim });
};

// Telefon 15 dakikada bir sorar. Yanit bilerek kisa: bekleyen sayisi + en yeni olayin ozeti.
// "zaman" olay damgasi: yeni bildirim ya da "odemeyi yaptim" ile ilerler, onay/ret ile geri gider;
// telefon yalniz ILERLEDIGINDE bildirim gosterir (boylece onaylanan kayit sahte bildirim uretmez).
exports.cihazBildirimDurumu = async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '?';
    if (cihazKisitliMi(ip)) return res.status(429).json({ message: 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.' });
    const ham = String((req.body || {}).bildirimJetonu || '');
    if (ham.length < 32) { cihazBasarisiz(ip); return res.status(401).json({ message: 'Bildirim jetonu geçersiz.' }); }
    const c = await query(
        `SELECT c.id FROM root_cihazlar c JOIN root_users u ON u.id = c.root_id
          WHERE c.bildirim_hash = ? AND c.revoked_at IS NULL AND u.is_active = 1`, [ozet(ham)]);
    if (!c.rows.length) { cihazBasarisiz(ip); return res.status(401).json({ message: 'Bildirim jetonu geçersiz ya da iptal edilmiş.' }); }
    cihazDenemeleri.delete(ip);
    const r = await query(
        `SELECT o.tutar, o.created_at, o.odeme_bildirildi_at, t.business_name
           FROM lisans_odemeleri o JOIN tenants t ON t.id = o.tenant_id
          WHERE o.durum = 'beklemede'
          ORDER BY COALESCE(o.odeme_bildirildi_at, o.created_at) DESC`);
    const s = r.rows[0];
    // Yeni restoran kaydi / SofraMix'ten paket alimi (APK 1.4+ okur; eski surum bu alani yok sayar)
    let olay = null;
    try { olay = await require('../services/yeniKayitIzleyici').telefonOzeti((req.body || {}).olaySonId); }
    catch (e) { console.error('[olay] telefon ozeti:', e.message); }
    res.json({
        bekleyen: r.rows.length,
        son: s ? { isletme: s.business_name, tutar: Number(s.tutar) || 0, bildirildi: !!s.odeme_bildirildi_at,
                   zaman: s.odeme_bildirildi_at || s.created_at } : null,
        olay,
    });
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
                t.owner_email, t.phone, t.license_modules, t.license_tier,
                t.license_end_date, t.license_table_limit, t.is_active, t.created_at, t.plaka_hediye_hakki,
                (SELECT COUNT(*) FROM tables   x WHERE x.tenant_id = t.id AND x.is_active = 1)    AS masa_sayisi,
                (SELECT COUNT(*) FROM products x WHERE x.tenant_id = t.id AND x.is_available = 1) AS urun_sayisi,
                (SELECT COUNT(*) FROM users    x WHERE x.tenant_id = t.id AND x.is_active = 1)    AS kullanici_sayisi,
                (SELECT COUNT(*) FROM orders   x WHERE x.tenant_id = t.id AND x.status = 'OPEN')  AS acik_siparis,
                -- Deneme kaydi kiraci SILINSE BILE duruyor; "bu isletme denemeden
                -- mi geldi, ne zaman bitiyor" sorusunun cevabi burada.
                (SELECT d.bitis  FROM deneme_kayitlari d WHERE d.tenant_id = t.id ORDER BY d.created_at DESC LIMIT 1) AS deneme_bitis,
                (SELECT d.kaynak FROM deneme_kayitlari d WHERE d.tenant_id = t.id ORDER BY d.created_at DESC LIMIT 1) AS deneme_kaynak,
                -- Odeme gecmisi: "lisans almis mi, ne zaman, ne kadar".
                (SELECT COUNT(*)      FROM pos_provizyon v WHERE v.tenant_id = t.id AND v.durum = 'islendi') AS odeme_adedi,
                (SELECT v.onay_tarihi FROM pos_provizyon v WHERE v.tenant_id = t.id AND v.durum = 'islendi' ORDER BY v.onay_tarihi DESC LIMIT 1) AS son_odeme_tarihi,
                (SELECT v.tutar_kurus FROM pos_provizyon v WHERE v.tenant_id = t.id AND v.durum = 'islendi' ORDER BY v.onay_tarihi DESC LIMIT 1) AS son_odeme_kurus,
                -- Havale/EFT ile onaylanan lisans odemeleri (Genel Bakis ile ayni sinif: services/yonetimOzet.js)
                (SELECT COUNT(*) FROM lisans_odemeleri o WHERE o.tenant_id = t.id AND o.durum = 'onaylandi') AS havale_adedi,
                (SELECT o.islenen_at FROM lisans_odemeleri o WHERE o.tenant_id = t.id AND o.durum = 'onaylandi' ORDER BY o.islenen_at DESC LIMIT 1) AS havale_son_tarih,
                (SELECT o.tutar FROM lisans_odemeleri o WHERE o.tenant_id = t.id AND o.durum = 'onaylandi' ORDER BY o.islenen_at DESC LIMIT 1) AS havale_son_tutar
           FROM tenants t
          ORDER BY t.is_active DESC, t.business_name`);

    const L = require('../services/lisansDurumu');
    const Oz = require('../services/yonetimOzet');
    const tierler = await Oz.katalogTierleri();
    const esik = Oz.esikGunu();
    res.json(r.rows.map(t => {
        let mods = [];
        try { mods = t.license_modules ? JSON.parse(t.license_modules) : []; } catch (_) {}
        // Durum BURADA hesaplaniyor, arayuzde degil: musterinin yasadigi kural
        // (bitis -> 3 gun salt-okunur -> kapali) tek yerde dursun. Iki ayri yerde
        // hesaplansaydi panel "aktif" derken kasa kapanmis olabilirdi.
        const d = L.hesapla(t.license_end_date);
        // Deneme / odemeli / kurum: Genel Bakis ile ayni tek kural (havale + SofraMix odemesi, elle uzatma)
        const sinif = Oz.sinifla({ ...t, provizyon_adedi: t.odeme_adedi }, tierler, esik);
        const havaleSon = Oz.tarihCoz(t.havale_son_tarih), smxSon = Oz.tarihCoz(t.son_odeme_tarihi);
        const havaleYeni = !!havaleSon && (!smxSon || havaleSon > smxSon);
        return {
            ...t,
            odeme_adedi: Number(t.odeme_adedi || 0) + Number(t.havale_adedi || 0),
            son_odeme_tarihi: havaleYeni ? t.havale_son_tarih : t.son_odeme_tarihi,
            son_odeme_kurus: havaleYeni ? Math.round(Number(t.havale_son_tutar || 0) * 100) : t.son_odeme_kurus,
            sinif,
            license_modules: mods,
            // Adisyon ve Kasa (BASE) yoksa isletme yalniz QR menu kullaniyor (panel menu kipinde)
            menu_kipi: !mods.includes('BASE') && !mods.includes('ALL'),
            lisans_durum: d.durum,
            lisans_kalan_gun: d.kalanGun,
            // Odemesi olan kiraci artik deneme DEGILDIR; tier guncellenmemis olsa
            // bile panelde musteri olarak gorunmeli.
            deneme_mi: sinif === 'deneme',
            odeme_yapmis: sinif === 'odemeli',
            kaynak_etiket: t.parent_org === 'SofraMix' ? 'SofraMix'
                : (t.deneme_kaynak ? 'Tanıtım sayfası' : (t.parent_org || null)),
        };
    }));
};

// --- Lisans uzatma (root) ---
//
// "Duzenle" ekranindan tarih yazmak da mumkun ama gunluk is bu degil: gelen
// para karsiligi "+1 yil" demek. Tarihi elle hesaplatmak hata kaynagi -
// ozellikle lisansi henuz BITMEMIS bir kiracide, bugunden baslatmak musterinin
// odedigi gunleri sessizce silerdi.
exports.lisansUzat = async (req, res) => {
    const { yeniBitis } = require('../services/posProvizyon');
    const t = (await query(
        'SELECT id, business_name, license_end_date, license_tier FROM tenants WHERE id = ?',
        [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ message: 'İşletme bulunamadı.' });

    const b = req.body || {};
    let bitis;
    if (b.bitis) {
        const d = new Date(b.bitis);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'Tarih geçersiz.' });
        bitis = d.toISOString();
    } else {
        const gun = Number(b.gun);
        if (!Number.isFinite(gun) || gun <= 0 || gun > 3650) {
            return res.status(400).json({ message: 'Gün sayısı 1-3650 arasında olmalı.' });
        }
        // Mevcut lisans ileri tarihliyse UZERINE ekler, gecmisse bugunden baslar.
        bitis = yeniBitis(t.license_end_date, gun);
    }

    // Iki kip (2026-11-18, deneme isletmesi icin):
    //   'deneme' : deneme suresini uzatir; paket TIER_DENEME KALIR (odeme sayilmaz, isletme deneme sinifinda kalir,
    //              ilk satin alma yine "ilk alim" olur). Root panelindeki pencerede varsayilan budur.
    //   'lisans' : odeme alindi, lisans verilir: TIER_DENEME -> TIER_MUSTERI (eski davranis; hub disi sayilmaya
    //              devam eder, panelde "Musteri" gorunur).
    // Kip gonderilmezse eski davranis ('lisans'; eski arayuz ve betikler). Deneme olmayan isletmede kip yok sayilir
    // (tarih uzar, paket degismez).
    const mod = b.mod === 'deneme' || b.mod === 'lisans' ? b.mod : null;
    if (b.mod != null && !mod) return res.status(400).json({ message: 'Kip "deneme" ya da "lisans" olmalı.' });
    const denemeMi = t.license_tier === 'TIER_DENEME';
    const denemeUzat = denemeMi && mod === 'deneme' && !b.tier;
    const tier = b.tier ? String(b.tier).slice(0, 40)
        : (denemeMi && !denemeUzat ? 'TIER_MUSTERI' : t.license_tier);

    await query(
        'UPDATE tenants SET license_end_date = ?, license_tier = ?, is_active = 1 WHERE id = ?',
        [bitis, tier, t.id]);
    const ozet = (denemeUzat ? `Deneme süresi uzatıldı: bitiş ${YG.trTarih(t.license_end_date)} -> ${YG.trTarih(bitis)}`
        : `Lisans bitişi ${YG.trTarih(t.license_end_date)} -> ${YG.trTarih(bitis)}` + (denemeMi ? ' (ödeme alındı: lisans verildi)' : ''))
        + (tier !== t.license_tier ? `; paket ${t.license_tier || '-'} -> ${tier}` : '');
    await YG.kaydet(req, { islem: denemeUzat ? 'deneme_uzat' : 'lisans_uzat', tenantId: t.id, ozet,
        ayrinti: { onceki: t.license_end_date, yeni: bitis, gun: b.gun || null, tier, mod: denemeUzat ? 'deneme' : (denemeMi ? 'lisans' : null) } });
    // Lisans durumu ya da paketi degisti: odeme korumasi onbellegi tazelensin
    require('../services/odemeKorumasi').tazele().catch(() => {});

    const tarihMetni = new Date(bitis).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
    res.json({ ok: true, id: t.id, license_end_date: bitis, license_tier: tier, mod: denemeUzat ? 'deneme' : (denemeMi ? 'lisans' : null),
        message: denemeUzat ? `${t.business_name} deneme süresi ${tarihMetni} tarihine uzatıldı.`
            : `${t.business_name} lisansı ${tarihMetni} tarihine uzatıldı.` });
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

const VARSAYILAN_MODULLER = ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON', 'STOK', 'FINANSAL_RAPORLAMA'];
const { bagimliliklariTamamla } = require('../services/lisansModul');

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
    // Secilen modullerin bagimliliklari kendiliginden eklenir (orn. Masadan Siparis -> QR Menu + Adisyon ve Kasa)
    const moduller = bagimliliklariTamamla(Array.isArray(f.modules) && f.modules.length ? f.modules : VARSAYILAN_MODULLER).moduller;
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
    await YG.kaydet(req, { islem: 'isletme_olustur', tenantId, ozet: `${ad} açıldı (işyeri kodu ${kod})`, ayrinti: { kod, slug, eposta, moduller, masaLimiti, bitis } });

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
    const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
    const limitGeldi = has('tableLimit');
    const masaLimiti = limitGeldi ? ((f.tableLimit === '' || f.tableLimit == null) ? null : (Number(f.tableLimit) || null)) : null;
    const t = (await query('SELECT id FROM tenants WHERE id = ?', [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ message: 'İşletme bulunamadı.' });
    const once = await YG.isletmeAnlik(t.id);   // yonetim gunlugu: once -> sonra farki
    // Modul secimi: bagimliliklar kendiliginden eklenir (orn. Masadan Siparis -> QR Menu + Adisyon ve Kasa)
    const moduller = Array.isArray(f.modules) ? bagimliliklariTamamla(f.modules).moduller : null;

    // Plaka hediye hakki (elle): '' / null = otomatik kural, 1 = ver, 0 = kaldir
    if (has('plakaHediyeHakki')) {
        const v = f.plakaHediyeHakki;
        let hak;
        if (v === '' || v === null || v === 'otomatik') hak = null;
        else if (v === 1 || v === '1' || v === true) hak = 1;
        else if (v === 0 || v === '0' || v === false) hak = 0;
        else return res.status(400).json({ message: 'Plaka hediye hakkı otomatik, 1 ya da 0 olmalı.' });
        await query('UPDATE tenants SET plaka_hediye_hakki = ? WHERE id = ?', [hak, t.id]);
    }
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
            moduller ? JSON.stringify(moduller) : null,
            f.licenseEndDate || null,
            limitGeldi ? 1 : 0, masaLimiti,
            f.isActive == null ? null : (f.isActive ? 1 : 0),
            req.params.id]);
    await YG.isletmeFarki(req, t.id, once);
    // Masa siniri elle yazildiysa ve aktif masa uzerindeyse: acik hesabi olmayan masalar pasife alinir (masaSiniri)
    // (yalniz sinir DEGISTIYSE: baska bir alan duzenlenirken ayni sinir yeniden gonderilince masalara dokunulmaz)
    const sinirDegisti = limitGeldi && String(once && once.license_table_limit != null ? once.license_table_limit : '') !== String(masaLimiti == null ? '' : masaLimiti);
    const masa = sinirDegisti && masaLimiti != null
        ? await require('../services/masaSiniri').siniriUygula(t.id, masaLimiti, { kaynak: 'root düzenleme' }).catch(() => null) : null;
    res.json({ ok: true, message: masa && masa.uygulandi ? `Güncellendi. ${masa.pasifeAlinan} masa pasife alındı (lisans sınırı ${masa.sinir}).` : 'Güncellendi.',
        modules: moduller || undefined, masaSiniri: masa && masa.uygulandi ? masa : undefined });
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
    await query('UPDATE users SET password_hash = ?, password_set_at = ? WHERE id = ?',
        [await bcrypt.hash(yeni, 10), new Date().toISOString(), u.rows[0].id]);
    await YG.kaydet(req, { islem: 'sifre_ver', tenantId: req.params.id, ozet: 'İşletme sahibine yeni giriş şifresi verildi (şifre kayda yazılmaz)' });
    res.json({ ok: true, message: 'Yönetici şifresi güncellendi.', email: t.rows[0].owner_email });
};

// --- Yonetici sifresini sifirla (root, 2026-11-18) ---
// Isletme yonetici sifresini (Rapor / Ayarlar / Lisans kilidi) unuttu ve giris sifresiyle de sifirlayamiyor: root
// sifreyi kaldirir; isletme Lisans ya da Ayarlar sayfasina girince yeni yonetici sifresi belirler. Giris sifrelerine
// dokunulmaz. Sifre kayda yazilmaz.
exports.yoneticiSifresiSifirla = async (req, res) => {
    const t = (await query('SELECT id, business_name, manager_pin FROM tenants WHERE id = ?', [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ message: 'İşletme bulunamadı.' });
    await query('UPDATE tenants SET manager_pin = NULL WHERE id = ?', [t.id]);
    await YG.kaydet(req, { islem: 'yonetici_sifresi_sifirla', tenantId: t.id,
        ozet: t.manager_pin ? 'Yönetici şifresi sıfırlandı; işletme yeni şifre belirleyecek' : 'Yönetici şifresi sıfırlandı (zaten belirlenmemişti)' });
    res.json({ ok: true, message: `${t.business_name}: yönetici şifresi sıfırlandı. İşletme, Lisans ya da Ayarlar sayfasına girdiğinde yeni şifre belirleyecek.` });
};

module.exports.ensureRootUser = ensureRootUser;

// ——— POS provizyon (SofraMix odemeleri) ———
// Bu ekran Patron'un "SofraMix bana ne borclu" sorusunun tek dogru cevabidir:
// lisans SADECE burada bir satir olusunca uzar, fatura da ayni satirlara dayanir.

exports.provizyonListe = async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const r = await query(
        `SELECT p.*, t.business_name AS kiraci_adi, t.business_code AS isyeri_kodu,
                a.business_name AS aday_adi, a.business_code AS aday_kodu
           FROM pos_provizyon p
           LEFT JOIN tenants t ON t.id = p.tenant_id
           LEFT JOIN tenants a ON a.id = p.aday_tenant_id
          ORDER BY p.created_at DESC
          LIMIT ?`, [limit]);
    res.json(r.rows);
};

exports.provizyonOzet = async (req, res) => {
    const { donemOzeti, bekleyenElde } = require('../services/posProvizyon');
    const { saglik } = require('../services/posOdemeCekici');
    const bas = req.query.baslangic || new Date(Date.now() - 30 * 86400000).toISOString();
    const bit = req.query.bitis || new Date().toISOString();
    res.json({
        baslangic: bas, bitis: bit,
        ...(await donemOzeti({ baslangic: bas, bitis: bit })),
        bekleyen: await bekleyenElde(),
        baglanti: saglik(),
    });
};

// Elle cozulmus 'elde' odemeyi yeniden dene. Ornek: ayni e-postali ikinci
// isletme silindikten ya da yetkili e-postasi SofraMix'te doldurulduktan sonra.
exports.provizyonTekrarDene = async (req, res) => {
    const r = await query('SELECT * FROM pos_provizyon WHERE odeme_id = ?', [req.params.odemeId]);
    const k = r.rows[0];
    if (!k) return res.status(404).json({ message: 'Odeme bulunamadi.' });
    if (k.durum === 'islendi') return res.status(409).json({ message: 'Bu odeme zaten islenmis.' });
    // Paket secimi (pos_paket) ve root'un onceki kararlari korunarak (services/posProvizyon.kayittanTekrarIsle)
    const s = await require('../services/posProvizyon').kayittanTekrarIsle(k);
    await YG.kaydet(req, { islem: 'provizyon', tenantId: k.tenant_id || null, ozet: `SofraMix ödemesi yeniden denendi (${k.odeme_id}): ${s && s.durum ? s.durum : '-'}` });
    res.json(s);
};

// Aktivasyon postasini yeniden gonder. SMTP gecici olarak calismadiysa ya da
// jetonun 72 saati dolduysa tek cikis yolu buydu - eskiden hic yoktu.
// Root: isletmenin SofraMix kanalini elle tetikleyerek bagla (anahtar sunucudan sunucuya).
// Provizyon/devir aninda baglanamamis ya da isletme kanali bozmus olabilir.
exports.soframixBagla = async (req, res) => {
    const tenantId = req.params.tenantId;
    const t = (await query('SELECT id, business_name FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) return res.status(404).json({ message: 'Isletme bulunamadi.' });
    const no = (await query(
        `SELECT soframix_business_id AS no FROM pos_provizyon WHERE tenant_id = ? AND soframix_business_id IS NOT NULL
          UNION SELECT soframix_business_id FROM deneme_kayitlari WHERE tenant_id = ? AND soframix_business_id IS NOT NULL LIMIT 1`,
        [tenantId, tenantId])).rows[0];
    if (!no) return res.status(400).json({ message: 'Bu isletmenin SofraMix numarasi kayitli degil (SofraMix uzerinden gelmemis).' });
    const oto = require('../services/soframixOtoBaglanti');
    if (!oto.acikMi()) return res.status(503).json({ message: 'Sunucuda SOFRAMIX_PLATFORM_URL/ANAHTAR ya da MARKETPLACE_KEK eksik.' });
    const s = await oto.otoBagla({ tenantId, isletmeNo: no.no, sebep: 'root' });
    await YG.kaydet(req, { islem: 'soframix_bagla', tenantId, ozet: `SofraMix kanalı bağlama: ${s.durum}${s.neden ? ' (' + s.neden + ')' : ''}` });
    res.json({ ...s, isletmeNo: no.no });
};

exports.provizyonPostaYenile = async (req, res) => {
    const { aktivasyonJetonu } = require('../services/posProvizyon');
    const tenantId = req.params.tenantId;
    const t = (await query(
        'SELECT id, business_name, business_code, owner_email, license_end_date FROM tenants WHERE id = ?',
        [tenantId])).rows[0];
    if (!t) return res.status(404).json({ message: 'Isletme bulunamadi.' });
    const u = (await query(
        "SELECT id, email FROM users WHERE tenant_id = ? AND role = 'OWNER' ORDER BY created_at LIMIT 1",
        [tenantId])).rows[0];
    if (!u) return res.status(400).json({ message: 'Bu isletmenin sahip kullanicisi yok.' });
    const alici = String(req.body?.eposta || t.owner_email || u.email || '').trim();
    if (!alici || alici.endsWith('@ornek.local')) {
        return res.status(400).json({ message: 'Gecerli bir e-posta adresi gerekli.' });
    }
    // Eski bekleyen jetonlar kapatilir: tek gecerli baglanti kalsin.
    await query('UPDATE aktivasyon_jetonlari SET kullanildi_at = ? WHERE tenant_id = ? AND kullanildi_at IS NULL',
        [new Date().toISOString(), tenantId]);
    const j = await aktivasyonJetonu(tenantId, u.id);
    const cekici = require('../services/posOdemeCekici');
    const PANEL = (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
    const gitti = await cekici.postaDene(alici, 'MDA Restoran POS hesabiniz hazir',
        `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
            <h2 style="color:#E2622A;margin:0 0 12px">MDA Restoran POS</h2>
            <p style="color:#374151">Merhaba ${t.business_name},</p>
            <p style="color:#374151">Sifrenizi belirlemek icin:</p>
            <p style="margin:20px 0"><a href="${PANEL}/aktivasyon/${j.ham}" style="background:#E2622A;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Sifremi belirle</a></p>
            <p style="color:#374151;font-size:.92rem">Isyeri kodunuz: <b>${t.business_code}</b></p>
        </div>`, tenantId);
    await YG.kaydet(req, { islem: 'sifre_baglantisi', tenantId, ozet: gitti ? `Şifre belirleme bağlantısı ${alici} adresine gönderildi` : 'Şifre belirleme bağlantısı üretildi (e-posta gitmedi, elden iletilecek)' });
    // SMTP calismiyorsa baglantiyi EKRANDA veriyoruz - Patron elden iletebilsin.
    res.json({ gonderildi: gitti, eposta: alici, sonGecerlilik: j.son,
        baglanti: gitti ? undefined : `${PANEL}/aktivasyon/${j.ham}` });
};

// Elle tetikleme: "para gitti ama POS acilmadi" diyen bir isletme icin
// periyodu beklemeden hemen sorgular.
exports.provizyonCek = async (_req, res) => {
    const cekici = require('../services/posOdemeCekici');
    if (!cekici.acikMi()) {
        return res.status(503).json({ message: 'SofraMix baglantisi tanimli degil (SOFRAMIX_PLATFORM_URL/ANAHTAR).' });
    }
    try { const s = await cekici.birTur(); await YG.kaydet(_req, { islem: 'provizyon', ozet: 'SofraMix ödemeleri elle çekildi', ayrinti: s }); res.json(s); }
    catch (e) { res.status(502).json({ message: `SofraMix'e ulasilamadi: ${e.message}` }); }
};

// --- Katalog + ayarlar + odeme bildirimleri (root) ---
//
// Fiyatlar ve paketler artik hub'dan degil BURADAN tanimlaniyor.

exports.katalogListe = async (_req, res) => {
    const K = require('../services/lisansKatalog');
    const A = require('../services/sistemAyar');
    res.json({
        katalog: await K.tamKatalog(),
        ayarlar: await A.hepsi(['iban', 'iban_sahibi', 'banka_adi', 'odeme_aciklama', 'bildirim_eposta']),
    });
};

exports.katalogGuncelle = async (req, res) => {
    const K = require('../services/lisansKatalog');
    const once = (await query('SELECT * FROM lisans_katalog WHERE id = ?', [req.params.id])).rows[0];
    const satir = await K.guncelle(req.params.id, req.body || {});
    if (!satir) return res.status(404).json({ message: 'Satır bulunamadı.' });
    await YG.katalogFarki(req, once, satir);
    res.json(satir);
};

exports.ayarGuncelle = async (req, res) => {
    const A = require('../services/sistemAyar');
    const IZINLI = ['iban', 'iban_sahibi', 'banka_adi', 'odeme_aciklama', 'bildirim_eposta'];
    // Beyaz liste: gelen gövdedeki her anahtarı yazmak, bir gün başka bir
    // ayarın (örn. bir bayrak) buradan ezilmesine kapı açardı.
    const once = await A.hepsi(IZINLI);
    for (const k of IZINLI) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) await A.yaz(k, req.body[k]);
    }
    const sonra = await A.hepsi(IZINLI);
    await YG.ayarFarki(req, IZINLI.filter((k) => once[k] !== sonra[k]).map((k) => ({ anahtar: k, once: once[k], sonra: sonra[k] })));
    res.json(sonra);
};

// Bekleyen kayitlarda onay ekrani icin: talepten sonra lisans elle degisti mi (uyari), onaylanirsa kalkacak
// moduller ve 365 gunluk onayda yeni bitis (ilk/yukseltme: bugun + 365; yenileme: mevcut bitisin uzerine).
exports.lisansOdemeleri = async (req, res) => {
    const LT = require('../services/lisansTalep');
    const M = require('../services/lisansModul');
    const durum = req.query.durum;
    const r = await query(
        `SELECT o.*, t.business_name, t.business_code, t.license_end_date, t.license_tier AS mevcut_tier,
                t.license_modules AS mevcut_moduller, t.license_table_limit AS mevcut_masa_limiti,
                t.billing_name, t.billing_tax_id, t.billing_tax_office, t.billing_address
           FROM lisans_odemeleri o JOIN tenants t ON t.id = o.tenant_id
          ${durum ? 'WHERE o.durum = ?' : ''}
          ORDER BY CASE o.durum WHEN 'beklemede' THEN 0 ELSE 1 END, o.created_at DESC
          LIMIT 200`, durum ? [durum] : []);
    const tam = await require('../services/lisansKatalog').tamKatalog();
    res.json(await Promise.all(r.rows.map(async (x) => {
        const m = M.modulListesi(x.moduller);
        const mevcut = M.modulListesi(x.mevcut_moduller);
        const ek = {};
        if (x.durum === 'beklemede') {
            const t = { id: x.tenant_id, license_tier: x.mevcut_tier, license_modules: x.mevcut_moduller, license_end_date: x.license_end_date };
            // Onayda yazilacak liste: odenen + korunan (o anki lisansa gore; bkz lisansModul.korunacakModuller)
            const onay = await LT.onayModulleri(x, t, tam);
            ek.korunacak_moduller = onay.korunan;
            ek.eski_hak_moduller = onay.eskiHak;   // korunacaklardan eski musteri hakki olanlar (onay penceresinde ayri etiket)
            ek.yeni_moduller_onizleme = onay.moduller;
            ek.lisans_degisiklikleri = LT.lisansDegisiklikleri(x, t, tam);
            ek.kalkacak_moduller = mevcut.filter((k) => !M.varMi(onay.moduller, k));
            // Tur yazilmamis (eski) kayit: deneme sinifindaysa ilk alim, degilse mevcut bitisin uzerine (O1)
            const etkinTur = x.tur || ((await LT.denemeSinifiMi(x.tenant_id)) ? 'ilk' : null);
            ek.etkin_tur = etkinTur;
            ek.yeni_bitis_onizleme = LT.onayBitisi({ tur: etkinTur, mevcutBitis: x.license_end_date, gun: 365 });
            // Odeme kaydi olmayan ama lisansi uzun sure gecerli isletme (elle acilmis/uzatilmis): ilk alim sayildi,
            // kredi yok ve yeni sure onay gununden. Root bilsin (gerekirse reddedip elle cozsun).
            const kalan = LT.kalanGunHesapla(x.license_end_date);
            ek.ilk_alim_kalan_gun = etkinTur === 'ilk' && kalan > 30 ? kalan : null;
            // Odeme korumasi: musteri "odemeyi yaptim" dedi, onay beklerken program acik (bitis)
            const kb = await require('../services/odemeKorumasi').kayitKorumaBitisi(x).catch(() => null);
            ek.koruma_bitis = kb ? kb.toISOString() : null;
            // Masa siniri: onaylanirsa aktif masalar pasife alinacak mi (services/masaSiniri.js; onay penceresi uyarisi)
            const ms = await masaSiniriOnizleme(x, onay.moduller);
            ek.aktif_masa = ms.aktif;
            ek.yeni_masa_limiti = ms.sinir;
            ek.masa_pasife_alinacak = ms.sinir != null && ms.aktif > ms.sinir;
        }
        // KDV (2026-11-18): tutar KDV haric; havale tutari genel toplam. Eski kayitta KDV yok (kdv_var false).
        const kdv = require('../services/lisansKdv');
        const kk = kdv.kayitKdv(x);
        ek.kdv_var = kk.kdvVar;
        ek.havale_tutari = kk.genelToplam;
        ek.kdv_metni = kdv.kdvMetni(x);
        ek.havale_kodu = x.business_code ? 'MDA-' + x.business_code : null;
        ek.fatura_eksik = require('../services/faturaBilgisi').eksikler(x);
        return {
            ...x, moduller: m, mevcut_moduller: mevcut,
            onceki_moduller: x.onceki_moduller == null ? null : M.modulListesi(x.onceki_moduller),
            tier_ad: x.tier ? LT.tierAdi(tam, x.tier) : 'Masa paketi yok (yalnız QR Menü)', onceki_tier_ad: x.onceki_tier ? LT.tierAdi(tam, x.onceki_tier) : null,
            mevcut_tier_ad: LT.tierAdi(tam, x.mevcut_tier), ...ek,
        };
    })));
};

// Onayda yazilacak masa siniri: kademenin siniri (kademe katalogda yoksa mevcut sinir). Adisyon ve Kasa yoksa
// (yalniz QR menu) masa siniri yok: null. Doner { sinir, kademeVar, aktif }
async function masaSiniriOnizleme(o, moduller) {
    const M = require('../services/lisansModul');
    const aktif = await require('../services/masaSiniri').aktifSayi(o.tenant_id);
    if (!M.varMi(moduller, 'BASE')) return { sinir: null, kademeVar: false, menu: true, aktif };
    const kademe = o.tier ? await require('../services/lisansKatalog').tierSatiri(o.tier) : null;
    const mevcut = o.mevcut_masa_limiti !== undefined ? o.mevcut_masa_limiti
        : (await query('SELECT license_table_limit FROM tenants WHERE id = ?', [o.tenant_id])).rows[0]?.license_table_limit;
    const s = kademe ? kademe.masa_limiti : mevcut;
    return { sinir: s == null ? null : Number(s), kademeVar: !!kademe, aktif };
}

// Onay = LISANSIN UZADIGI TEK AN. Bildirimin kendisi lisansa dokunmuyordu.
// Onayda KILITLI teklif uygulanir (yeniden hesaplanmaz): moduller ve paket kayittaki gibi. Yeni bitis tura gore
// (services/lisansTalep.js onayBitisi): ilk ve yukseltme onay gunu + gun; yenileme ve eski kayit mevcut bitisin
// uzerine. Okuma + yazma tek islemde: ayni kayda iki onay lisansi iki kez uzatamaz.
exports.lisansOdemeOnayla = async (req, res) => {
    const LT = require('../services/lisansTalep');
    const M = require('../services/lisansModul');
    const gun = Number(req.body?.gun) > 0 ? Math.min(3650, Math.round(Number(req.body.gun))) : 365;
    const hataNesnesi = (status, message) => Object.assign(new Error(message), { status });
    let sonuc;
    try {
        sonuc = await tx(async () => {
            const o = (await query('SELECT * FROM lisans_odemeleri WHERE id = ?', [req.params.id])).rows[0];
            if (!o) throw hataNesnesi(404, 'Ödeme kaydı bulunamadı.');
            if (o.durum !== 'beklemede') throw hataNesnesi(409, 'Bu ödeme zaten sonuçlandırılmış.');
            const t = (await query('SELECT * FROM tenants WHERE id = ?', [o.tenant_id])).rows[0];
            if (!t) throw hataNesnesi(404, 'İşletme bulunamadı.');

            // Tur yazilmamis (deploy oncesi) kayit: deneme sinifindaysa ilk alim gibi (onay gununden), degilse
            // mevcut bitisin uzerine (guvenlik incelemesi O1: odeme kaydi olmayan musteri gun kaybetmesin)
            const etkinTur = o.tur || ((await LT.denemeSinifiMi(t.id)) ? 'ilk' : null);
            const bitis = LT.onayBitisi({ tur: etkinTur, mevcutBitis: t.license_end_date, gun });
            // Modul listesi de yaziliyor: musteri parasini odedigi modulu goremezse "aldim ama yok" der.
            // Yeni liste = odenen + korunan (satista olmayan mevcut moduller; deneme ise yalniz aktif kanal varsa
            // MARKETPLACE). Korunan hesap BU ANKI lisansa gore: deploy oncesi acilmis kayitlar da Masadan Siparis'i
            // kaybetmez (lisansModul.korunacakModuller).
            const tam = await require('../services/lisansKatalog').tamKatalog();
            const { moduller, eskiHak } = await LT.onayModulleri(o, t, tam);
            // Masa siniri secilen kademeden gelir. Kademe katalogda yoksa (eski kayit) sinira dokunulmaz.
            // Yalniz QR menu (2026-11-18: yeni liste Adisyon ve Kasa icermiyor): masa kademesi yok; paket kodu
            // TIER_MENU, masa siniri NULL (sinirsiz; tek menu, tek karekod). Eski kayitta kademe gelse de ayni.
            const menuPaketi = !M.varMi(moduller, 'BASE');
            const kademe = !menuPaketi && o.tier ? await require('../services/lisansKatalog').tierSatiri(o.tier) : null;
            const tierYaz = menuPaketi ? M.MENU_TIER : (o.tier || null);
            await query(
                `UPDATE tenants SET license_end_date = ?, is_active = 1,
                                    license_tier = COALESCE(?, license_tier),
                                    license_modules = ?,
                                    license_table_limit = CASE WHEN ? = 1 THEN ? ELSE license_table_limit END
                  WHERE id = ?`,
                [bitis, tierYaz, JSON.stringify(moduller), kademe || menuPaketi ? 1 : 0, kademe ? kademe.masa_limiti : null, t.id]);
            // onay_gun: plaka hediyesinin "yillik odeme" olcutu ve sonraki yukseltmenin kredisi bu sayiya bakar
            await query(
                `UPDATE lisans_odemeleri SET durum = 'onaylandi', admin_note = ?, donem_bitis = ?, onay_gun = ?,
                                             islenen_at = CURRENT_TIMESTAMP WHERE id = ? AND durum = 'beklemede'`,
                [String(req.body?.not || '').slice(0, 300), bitis, gun, o.id]);
            return { o, t, bitis, etkinTur, eskiHak };
        });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ message: e.message });
        throw e;
    }
    const { o, t, bitis, etkinTur, eskiHak } = sonuc;
    // Masa siniri (2026-11-18): aktif masa yeni sinirin uzerindeyse acik hesabi olmayan masalar pasife alinir
    const yeniLimit = (await query('SELECT license_table_limit FROM tenants WHERE id = ?', [t.id])).rows[0]?.license_table_limit;
    const masa = await require('../services/masaSiniri').siniriUygula(t.id, yeniLimit, { kaynak: 'ödeme onayı' })
        .catch((e) => { console.error('[masa-siniri] onay:', e.message); return null; });
    const hakOzet = eskiHak && eskiHak.length ? `; eski hak korundu: ${eskiHak.map((m) => require('../services/lisansModul').AD[m] || m).join(', ')}` : '';
    await YG.kaydet(req, { islem: 'odeme_onay', tenantId: t.id, hedefTur: 'lisans_odemesi', hedefId: o.id, ozet: `Ödeme onaylandı (${o.tur || etkinTur || 'eski kayıt'}): ${YG.TL(o.tutar)}; paket ${o.tier || '-'}; lisans ${YG.trTarih(t.license_end_date)} -> ${YG.trTarih(bitis)}${hakOzet}`, ayrinti: { tutar: o.tutar, tur: o.tur, tier: o.tier, moduller: o.moduller, gun, oncekiBitis: t.license_end_date, yeniBitis: bitis, eskiHak } });
    const tarih = LT.TARIH(bitis);
    const message = o.tur === 'yukseltme'
        ? `${t.business_name}: yükseltme onaylandı. Yeni paket bugün başladı, lisans ${tarih} tarihine kadar geçerli.`
        : (etkinTur === 'ilk')
            ? `${t.business_name}: paket onaylandı. Lisans bugün başladı, ${tarih} tarihine kadar geçerli.`
            : `${t.business_name} lisansı ${tarih} tarihine uzatıldı.`;
    // Isletmeye e-posta (SMTP yoksa sessizce atlanir) + odeme korumasi onbellegi
    require('../services/odemeKorumasi').tazele().catch(() => {});
    require('../services/lisansBildirim').onaylandi(t.id, {
        paket: [LT.tierAdi(await require('../services/lisansKatalog').tamKatalog().catch(() => []), o.tier),
            M.modulListesi(o.moduller).map((m) => M.AD[m] || m).join(', ')].filter((x) => x && x !== '-').join(' - ') || 'Lisans paketi',
        bitis,
    }).catch(() => {});
    res.json({ ok: true, license_end_date: bitis, tur: o.tur || etkinTur || null,
        message: masa && masa.uygulandi ? `${message} ${masa.pasifeAlinan} masa pasife alındı (lisans sınırı ${masa.sinir}).` : message,
        masaSiniri: masa && masa.uygulandi ? masa : null });
};

// Red: sebep ZORUNLU (en az 5 karakter); musteri Lisans sayfasinda ve e-postada gorur. Red, odeme korumasini HEMEN
// bitirir ve 30 gun icinde yapilan yeni bildirimlere koruma verilmez (services/odemeKorumasi.js).
exports.lisansOdemeReddet = async (req, res) => {
    const not = String(req.body?.not || '').trim();
    if (not.length < 5) return res.status(400).json({ message: 'Red sebebini en az 5 karakterle yazın (müşteri bunu görecek).' });
    const o = (await query('SELECT tenant_id FROM lisans_odemeleri WHERE id = ?', [req.params.id])).rows[0];
    const r = await query(
        `UPDATE lisans_odemeleri SET durum = 'reddedildi', admin_note = ?, islenen_at = CURRENT_TIMESTAMP
          WHERE id = ? AND durum = 'beklemede'`, [not.slice(0, 300), req.params.id]);
    if (!r.changes) return res.status(409).json({ message: 'Bekleyen bir ödeme bulunamadı.' });
    await require('../services/odemeKorumasi').tazele().catch(() => {});
    await YG.kaydet(req, { islem: 'odeme_red', tenantId: o ? o.tenant_id : null, hedefTur: 'lisans_odemesi', hedefId: req.params.id, ozet: 'Ödeme bildirimi reddedildi: ' + not.slice(0, 200) });
    if (o) require('../services/lisansBildirim').reddedildi(o.tenant_id, { sebep: not.slice(0, 300) }).catch(() => {});
    res.json({ ok: true });
};
