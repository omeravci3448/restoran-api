const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

// --- DESTEK OTURUMU (Patron karari: her zaman yazma izinli) ---
//
// Akis:
//  1) Root "Destek oturumu ac" der (isteğe bagli sebep). Sunucu 60 sn omurlu, TEK KULLANIMLIK bir giris jetonu
//     uretir; veritabaninda yalniz SHA-256 ozeti durur.
//  2) Root'un tarayicisi yeni sekmede /destek-giris/<jeton> acar; sayfa jetonu POST /api/destek/giris/:jeton ile
//     o isletmeye ait bir JWT'ye cevirir: rol OWNER, ad "MDA Destek", claim destek={oturumId}. JWT'de userId YOK:
//     destek bir isletme kullanicisi degildir, users tablosuna satir eklenmez.
//  3) Her istekte authMiddleware.protect kimlik() ile oturum satirina bakar: kapatilmis ya da suresi gecmisse
//     401 DESTEK_OTURUMU_BITTI. Isletme verisine erisim yalniz oturumun isletmesiyle (req.user.tenantId).
//  4) Sure ayardan (destek_oturumu_dk, varsayilan 120 dk) ve jetonun cevrildigi andan sayilir.
//
// Sinirlar:
//  - YASAK (403 DESTEK_YASAK): sahibin/personelin sifresi, e-postasi, giris bilgileri, yonetici sifresi; personel
//    ekleme/duzenleme/silme; hesap kapatma talebi; telefon bildirimi aboneligi. Hesap ele gecirme izlenimi olmasin.
//  - Yonetici sifresi (requireManagerPin) SORULMAZ; ilk atlama oturuma (pin_atlandi_at) ve yonetim gunlugune yazilir.
//  - Isletme oturumu GORMEZ, bildirim almaz. Ama destek oturumunda yapilan her degisiklik isletmenin Islem Gunlugu'ne
//    kullanici "MDA Destek" olarak yazilir (ozel kayit yazan uclar kendi satirini yazar, digerleri icin genel satir).
//  - IP KAYDEDILMEZ.

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JETON_OMRU_SN = 60;
const DESTEK_ADI = 'MDA Destek';

const ozet = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const simdiIso = () => new Date().toISOString();
function hata(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

// Suresi gecmis oturumlari ve kullanilmamis jetonlari kapatir (zamanlayici yok; okunurken kapatilir)
async function suresiDolanlariKapat() {
    const s = simdiIso();
    await query(`UPDATE destek_oturumlari SET bitis_at = planlanan_bitis_at, kapanis_nedeni = 'SURE_DOLDU'
                  WHERE bitis_at IS NULL AND baslangic_at IS NOT NULL AND planlanan_bitis_at <= ?`, [s]);
    await query(`UPDATE destek_oturumlari SET bitis_at = jeton_son_at, kapanis_nedeni = 'JETON_KULLANILMADI'
                  WHERE bitis_at IS NULL AND baslangic_at IS NULL AND jeton_son_at <= ?`, [s]);
}

// --- 1) Root: oturum ac ---
async function ac({ tenantId, sebep, rootId }) {
    const t = (await query('SELECT id, business_name, is_active, license_end_date FROM tenants WHERE id = ?', [String(tenantId || '')])).rows[0];
    if (!t) throw hata(404, 'İşletme bulunamadı.');
    const not = String(sebep == null ? '' : sebep).trim();
    if (not.length > 200) throw hata(400, 'Sebep notu en fazla 200 karakter olabilir.');
    await suresiDolanlariKapat();
    const s = simdiIso();
    // Ayni isletmede acik kalmis eski oturum (sekme kapatilmis, "Oturumu kapat" denmemis): yenisi acilinca kapanir
    const eski = await query(`UPDATE destek_oturumlari SET bitis_at = ?, kapanis_nedeni = 'YENI_OTURUM'
                               WHERE tenant_id = ? AND bitis_at IS NULL`, [s, t.id]);
    const sureDk = await require('./yonetimAyar').destekSureDkOku();
    const ham = crypto.randomBytes(32).toString('base64url');
    const id = uuidv4();
    const jetonSon = new Date(Date.now() + JETON_OMRU_SN * 1000).toISOString();
    await query(
        `INSERT INTO destek_oturumlari (id, tenant_id, root_id, sebep, sure_dk, jeton_ozet, jeton_son_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, t.id, rootId || null, not || null, sureDk, ozet(ham), jetonSon, s]);
    const L = require('./lisansDurumu').hesapla(t.license_end_date);
    return {
        id, jeton: ham, gecerlilikSn: JETON_OMRU_SN, jetonSonAt: jetonSon, sureDk, adres: `/destek-giris/${ham}`,
        isletme: { id: t.id, ad: t.business_name, acik: !!Number(t.is_active), lisansDurum: L.durum },
        kapatilanEski: Number(eski.changes || 0),
    };
}

// --- 2) Jetonu JWT'ye cevir (acik uc; jeton 256 bit rastgele, tahmin edilemez) ---
async function girisJetonu(ham) {
    const j = String(ham || '');
    if (j.length < 30 || j.length > 100) throw hata(404, 'Destek bağlantısı geçersiz.');
    const r = (await query('SELECT * FROM destek_oturumlari WHERE jeton_ozet = ?', [ozet(j)])).rows[0];
    if (!r) throw hata(404, 'Destek bağlantısı geçersiz.');
    if (r.jeton_kullanildi_at) throw hata(410, 'Bu destek bağlantısı zaten kullanıldı. Yeni oturumu yönetim panelinden açın.');
    if (r.bitis_at) throw hata(410, 'Bu destek oturumu kapatılmış. Yeni oturumu yönetim panelinden açın.');
    const s = simdiIso();
    if (r.jeton_son_at <= s) {
        await suresiDolanlariKapat();
        throw hata(410, 'Destek bağlantısının süresi doldu (60 saniye). Yeni oturumu yönetim panelinden açın.');
    }
    const planlanan = new Date(Date.now() + Number(r.sure_dk) * 60000).toISOString();
    // Tek kullanim: kosullu guncelleme. Ayni anda iki istek gelirse yalniz biri satiri degistirir.
    const u = await query(
        `UPDATE destek_oturumlari SET jeton_kullanildi_at = ?, baslangic_at = ?, planlanan_bitis_at = ?
          WHERE id = ? AND jeton_kullanildi_at IS NULL AND bitis_at IS NULL AND jeton_son_at > ?`,
        [s, s, planlanan, r.id, s]);
    if (!u.changes) throw hata(410, 'Bu destek bağlantısı zaten kullanıldı. Yeni oturumu yönetim panelinden açın.');
    const t = (await query('SELECT business_name FROM tenants WHERE id = ?', [r.tenant_id])).rows[0] || {};
    // JWT omru oturumdan 5 dk uzun: sure dolunca jeton "gecersiz" degil, anlamli DESTEK_OTURUMU_BITTI ile reddedilsin
    const token = jwt.sign({ destek: { oturumId: r.id }, tenantId: r.tenant_id, role: 'OWNER', name: DESTEK_ADI },
        JWT_SECRET, { expiresIn: Number(r.sure_dk) * 60 + 300 });
    return { token, oturum: { id: r.id, isletme: t.business_name || '', baslangic: s, bitis: planlanan, sureDk: Number(r.sure_dk) } };
}

// --- 3) Her istekte kimlik (authMiddleware.protect cagirir) ---
// Doner: { u } (users JOIN tenants satiri gibi; id NULL) ya da { hata: { status, body } }
const BITTI = (message) => ({ hata: { status: 401, body: { code: 'DESTEK_OTURUMU_BITTI', message } } });
async function kimlik(payload) {
    const id = payload && payload.destek && payload.destek.oturumId;
    if (!id || typeof id !== 'string') return BITTI('Destek oturumu geçersiz.');
    const r = (await query(
        `SELECT d.id, d.tenant_id, d.bitis_at, d.baslangic_at, d.planlanan_bitis_at, d.pin_atlandi_at,
                t.business_name, t.license_end_date, t.license_modules, t.license_tier, t.license_table_limit,
                t.is_active AS tenant_active
           FROM destek_oturumlari d JOIN tenants t ON t.id = d.tenant_id
          WHERE d.id = ?`, [id])).rows[0];
    if (!r) return BITTI('Destek oturumu bulunamadı.');
    if (payload.tenantId && payload.tenantId !== r.tenant_id) return BITTI('Destek oturumu geçersiz.');
    if (r.bitis_at || !r.baslangic_at) return BITTI('Destek oturumu sona erdi.');
    if (!r.planlanan_bitis_at || r.planlanan_bitis_at <= simdiIso()) {
        await suresiDolanlariKapat().catch(() => {});
        return BITTI('Destek oturumunun süresi doldu.');
    }
    return {
        u: {
            id: null, email: null, name: DESTEK_ADI, role: 'OWNER', is_active: 1,
            tenant_id: r.tenant_id, business_name: r.business_name, license_end_date: r.license_end_date,
            license_modules: r.license_modules, license_tier: r.license_tier, license_table_limit: r.license_table_limit,
            tenant_active: r.tenant_active,
            destek: { oturumId: r.id, baslangic: r.baslangic_at, bitis: r.planlanan_bitis_at, pinAtlandi: !!r.pin_atlandi_at },
        },
    };
}

// --- YASAK uclar (destek oturumunda 403) ---
const GIRIS_MESAJI = 'Destek oturumunda giriş bilgileri ve personel hesapları değiştirilemez (şifre, e-posta, yönetici şifresi, '
    + 'personel ekleme, düzenleme ya da silme). Bu işlemleri işletme sahibi kendi hesabından yapar.';
const YASAKLAR = [
    // /api/auth altindaki her yazma: sifre degistir, sifre baglantisi, personel ekle/duzenle, yonetici sifresi belirle.
    // Tek istisna manager-verify (yalniz dogrular, hicbir sey degistirmez).
    { yol: /^\/api\/auth\/(?!manager-verify$)/, mesaj: GIRIS_MESAJI },
    { yol: /^\/api\/tenant\/close$/, mesaj: 'Destek oturumunda hesap kapatma talebi gönderilemez. Bu işlemi işletme sahibi kendi hesabından yapar.' },
    { yol: /^\/api\/push\/(abone|deneme)$/, mesaj: 'Destek oturumunda telefon bildirimi açılamaz.' },
];
const YAZMA = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const yolu = (req) => String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');

function yasakMi(req) {
    if (!YAZMA.has(String(req.method || '').toUpperCase())) return null;
    const y = yolu(req);
    const k = YASAKLAR.find((x) => x.yol.test(y));
    return k ? { code: 'DESTEK_YASAK', message: k.mesaj } : null;
}

// --- Islem Gunlugu: destek oturumundaki her basarili yazma ---
const KONU = [
    [/^\/api\/products/, 'Ürün'], [/^\/api\/categories/, 'Kategori'], [/^\/api\/tables/, 'Masa'], [/^\/api\/orders/, 'Sipariş'],
    [/^\/api\/payments/, 'Ödeme'], [/^\/api\/stock/, 'Stok'], [/^\/api\/suppliers/, 'Tedarikçi'], [/^\/api\/marketplace/, 'Pazaryeri'],
    [/^\/api\/paket/, 'Paket servis'], [/^\/api\/tenant/, 'İşletme ayarları'], [/^\/api\/license/, 'Lisans / paket'],
    [/^\/api\/plaka/, 'Masa plakası'], [/^\/api\/mutfak/, 'Mutfak'], [/^\/api\/waiter/, 'Garson çağrısı'], [/^\/api\/push/, 'Bildirim'],
    [/^\/api\/magaza/, 'Mağaza'], [/^\/api\/auth/, 'Hesap'],
];
const FIIL = { POST: 'kayıt / işlem', PUT: 'güncelleme', PATCH: 'güncelleme', DELETE: 'silme' };
function etiket(req) {
    const y = yolu(req);
    const m = String(req.method || '').toUpperCase();
    const k = (KONU.find(([r]) => r.test(y)) || [null, 'Değişiklik'])[1];
    return `${k}: ${FIIL[m] || m} (${m} ${y})`.slice(0, 300);
}

function istekKaydi(req, res) {
    const m = String(req.method || '').toUpperCase();
    if (!YAZMA.has(m)) return;
    res.on('finish', () => {
        const d = req.user && req.user.destek;
        if (!d || res.statusCode >= 400) return;
        query('UPDATE destek_oturumlari SET islem_sayisi = islem_sayisi + 1, son_islem_at = ? WHERE id = ?', [simdiIso(), d.oturumId])
            .catch((e) => console.error('[destek] sayac:', e.message));
        if (d.gunlukYazildi) return;     // uc kendi ozel kaydini (kullanici "MDA Destek") yazdi
        require('./islemGunlugu').kaydet({
            tenantId: req.user.tenantId, user: req.user, islem: 'destek_degisiklik', hedefTur: 'istek', detay: etiket(req),
        });
    });
}

// --- Yonetici sifresi atlandi (authMiddleware.requireManagerPin) ---
// Ilk atlama oturuma ve yonetim gunlugune yazilir; sonrakiler yalniz sayilmaz (her sayfa istegi atlama yapar).
async function pinAtlandi(req) {
    const d = req.user && req.user.destek;
    if (!d || d.pinAtlandi) return;
    d.pinAtlandi = true;
    try {
        const r = await query('UPDATE destek_oturumlari SET pin_atlandi_at = ? WHERE id = ? AND pin_atlandi_at IS NULL', [simdiIso(), d.oturumId]);
        if (!r.changes) return;
        await require('./yonetimGunlugu').kaydet(null, {
            islem: 'destek_pin', tenantId: req.user.tenantId, hedefTur: 'destek_oturumu', hedefId: d.oturumId,
            ozet: `Destek oturumunda yönetici şifresi soruldu yerine atlandı (${yolu(req)})`,
        });
    } catch (e) { console.error('[destek] pin kaydi:', e.message); }
}

// --- Kapat ---
// kim: 'DESTEK_KAPATTI' (seritteki dugme) | 'ROOT_KAPATTI' (root listesi)
async function kapat(id, kim) {
    const s = simdiIso();
    const r = await query(`UPDATE destek_oturumlari SET bitis_at = ?, kapanis_nedeni = ? WHERE id = ? AND bitis_at IS NULL`,
        [s, kim, String(id || '')]);
    const satir = (await query(
        `SELECT d.*, t.business_name FROM destek_oturumlari d LEFT JOIN tenants t ON t.id = d.tenant_id WHERE d.id = ?`,
        [String(id || '')])).rows[0] || null;
    return { kapandi: !!r.changes, oturum: satir };
}

// --- Liste (root) ---
const NEDEN_AD = {
    DESTEK_KAPATTI: 'Destek şeridinden kapatıldı', ROOT_KAPATTI: 'Yönetim panelinden kapatıldı', SURE_DOLDU: 'Süresi doldu',
    JETON_KULLANILMADI: 'Giriş bağlantısı kullanılmadı', YENI_OTURUM: 'Yeni oturum açılınca kapandı',
};
function bicimle(x) {
    const s = simdiIso();
    const acik = !x.bitis_at && ((x.baslangic_at && x.planlanan_bitis_at > s) || (!x.baslangic_at && x.jeton_son_at > s));
    return {
        id: x.id, tenantId: x.tenant_id, isletme: x.business_name || null, sebep: x.sebep || '', sureDk: Number(x.sure_dk),
        acildi: x.created_at, baslangic: x.baslangic_at, planlananBitis: x.planlanan_bitis_at, bitis: x.bitis_at,
        kapanisNedeni: x.kapanis_nedeni, kapanisAd: NEDEN_AD[x.kapanis_nedeni] || x.kapanis_nedeni || null,
        durum: acik ? (x.baslangic_at ? 'ACIK' : 'GIRIS_BEKLENIYOR') : 'KAPALI',
        islemSayisi: Number(x.islem_sayisi || 0), sonIslem: x.son_islem_at, pinAtlandi: x.pin_atlandi_at, root: x.root_eposta || null,
    };
}
async function liste({ durum, tenantId, limit } = {}) {
    await suresiDolanlariKapat();
    const w = [], p = [];
    if (durum === 'acik') w.push('d.bitis_at IS NULL');
    if (tenantId) { w.push('d.tenant_id = ?'); p.push(String(tenantId)); }
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const r = await query(
        `SELECT d.*, t.business_name, ru.email AS root_eposta
           FROM destek_oturumlari d LEFT JOIN tenants t ON t.id = d.tenant_id LEFT JOIN root_users ru ON ru.id = d.root_id
          ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
          ORDER BY CASE WHEN d.bitis_at IS NULL THEN 0 ELSE 1 END, d.created_at DESC
          LIMIT ?`, [...p, n]);
    return r.rows.map(bicimle);
}

module.exports = {
    DESTEK_ADI, JETON_OMRU_SN, ac, girisJetonu, kimlik, yasakMi, istekKaydi, pinAtlandi, kapat, liste, bicimle,
    suresiDolanlariKapat, etiket, NEDEN_AD,
};
