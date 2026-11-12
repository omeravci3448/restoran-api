const { query } = require('../config/db');

// --- Yonetim Gunlugu: root'un yaptigi her degisiklik ---
// Iki katman:
//  1) Uclardaki ACIK kayit cagrilari (kaydet / isletmeFarki / katalogFarki): ne degisti, once -> sonra.
//  2) Yedek ara katman (rootAraKatmani, rootRoutes'ta router.use): acik kayit YAZMAYAN her basarili root
//     yazma istegi (POST/PUT/PATCH/DELETE) yine de tek satir yazar. Yarin eklenecek bir uc (orn. Magaza) da
//     kendiliginden gunluge duser; acik kayit yazildiysa yedek ikinci kez yazmaz.
// Kayit BEST-EFFORT: gunluk yazilamazsa asil islem bozulmaz (hata sunucu gunlugune duser).
// Sifre, jeton, PIN ve uzun gorsel verisi ayrintiya YAZILMAZ. IP kaydedilmez.

const ISLEM_AD = {
    isletme_olustur: 'Yeni işletme',
    isletme_duzenle: 'İşletme bilgisi',
    isletme_kapat: 'İşletme kapatıldı',
    isletme_ac: 'İşletme açıldı',
    lisans_uzat: 'Lisans uzatma',
    modul_degisiklik: 'Modül / paket değişikliği',
    indirim: 'İndirim oranı',
    hediye_hakki: 'Hediye plaka hakkı',
    odeme_onay: 'Ödeme onayı',
    odeme_red: 'Ödeme reddi',
    sifre_ver: 'Yönetici şifresi verildi',
    sifre_baglantisi: 'Şifre bağlantısı',
    soframix_bagla: 'SofraMix bağlantısı',
    provizyon: 'SofraMix ödemeleri',
    katalog: 'Katalog fiyat / görünürlük',
    sistem_ayari: 'Sistem ayarı',
    plaka_durum: 'Plaka talebi durumu',
    plaka_not: 'Plaka talebi notu',
    plaka_ayar: 'Plaka ayarları',
    plaka_kural: 'Hediye plaka kuralı',
    kisa_kod: 'Masa kısa kodu',
    duyuru: 'Duyuru',
    isletme_notu: 'İç not',
    destek_ac: 'Destek oturumu açıldı',
    destek_kapat: 'Destek oturumu kapatıldı',
    destek_pin: 'Destek: yönetici şifresi atlandı',
    cihaz: 'Yönetim cihazı',
    magaza: 'Mağaza',
    diger: 'Diğer',
};

// Ayrintiya yazilmayacak alanlar (ad parcasi eslesirse)
const GIZLI = /(sifre|şifre|parola|password|pin|jeton|token|secret|gizli|kek|otp|^code$|kod_ozet|hash)/i;
function temizle(v, derinlik = 0) {
    if (v == null) return v;
    if (typeof v === 'string') return v.length > 300 ? `[uzun metin: ${v.length} karakter]` : v;
    if (typeof v !== 'object') return v;
    if (derinlik > 4) return '[...]';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => temizle(x, derinlik + 1));
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = GIZLI.test(k) ? '[gizli]' : temizle(x, derinlik + 1);
    return o;
}

// Hedefin isletmesini bul (cagri yeri tenantId vermediyse)
const HEDEF_ISLETME = {
    lisans_odemesi: 'SELECT tenant_id FROM lisans_odemeleri WHERE id = ?',
    plaka_talebi: 'SELECT tenant_id FROM plaka_talepleri WHERE id = ?',
    masa: 'SELECT tenant_id FROM tables WHERE id = ?',
    destek_oturumu: 'SELECT tenant_id FROM destek_oturumlari WHERE id = ?',
};

async function kaydet(req, { islem, tenantId = null, hedefTur = null, hedefId = null, ozet = '', ayrinti = null } = {}) {
    if (req) req._yonetimGunluguYazildi = true;
    try {
        let tid = tenantId;
        if (!tid && hedefTur && hedefId && HEDEF_ISLETME[hedefTur]) {
            const r = await query(HEDEF_ISLETME[hedefTur], [String(hedefId)]);
            tid = r.rows[0] ? r.rows[0].tenant_id : null;
        }
        let ad = null;
        if (tid) {
            const t = await query('SELECT business_name FROM tenants WHERE id = ?', [tid]);
            ad = t.rows[0] ? t.rows[0].business_name : null;
        }
        const js = ayrinti == null ? null : JSON.stringify(temizle(ayrinti)).slice(0, 4000);
        await query(
            `INSERT INTO yonetim_gunlugu (root_id, cihaz_id, islem, tenant_id, isletme_adi, hedef_tur, hedef_id, ozet, ayrinti)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req && req.root ? req.root.id : null, req ? (req.rootCihazId || null) : null, String(islem || 'diger').slice(0, 40),
                tid, ad, hedefTur, hedefId == null ? null : String(hedefId), String(ozet || '').slice(0, 500), js]);
    } catch (e) { console.error('[yonetim-gunlugu] yazilamadi:', e.message); }
}

// --- Yedek ara katman (rootRoutes: router.use) ---
// Basarili (status < 400) ve root kimligi olan yazma istegi acik kayit yazmadiysa tek satir yazar.
// Kimliksiz uclar (giris, cihaz girisi, telefon bildirim sorgusu) req.root tasimaz: yazilmaz.
function rootAraKatmani(req, res, next) {
    const m = (req.method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
    res.on('finish', () => {
        if (!req.root || req._yonetimGunluguYazildi || res.statusCode >= 400) return;
        const yol = String(req.originalUrl || '').split('?')[0];   // ic routerlarda baseUrl/path degisir; ozgun adres sabit
        const islem = /\/magaza(\/|$)/.test(yol) ? 'magaza' : (/\/cihaz(\/|$)/.test(yol) ? 'cihaz' : 'diger');
        kaydet(req, { islem, ozet: `${m} ${yol}`, ayrinti: { govde: req.body && Object.keys(req.body).length ? req.body : undefined } });
    });
    next();
}

// --- Bicimleyiciler ---
const trTarih = (s) => {
    if (!s) return '-';
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
    return isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' });
};
const TL = (n) => Number(n || 0).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' TL';
function modulAdlari(v) {
    const M = require('./lisansModul');
    const l = M.modulListesi(v);
    return l.length ? l.map((k) => M.AD[k] || k).join(', ') : '(yok)';
}

// --- Isletme duzenleme farki (rootController.updateTenant: once anlik goruntu, sonra fark) ---
const ISLETME_ALANLARI = [
    ['business_name', 'Ad'], ['parent_org', 'Üst kurum'], ['owner_email', 'Sahip e-postası'], ['phone', 'Telefon'],
    ['address', 'Adres'], ['license_tier', 'Paket'], ['license_modules', 'Modüller'], ['license_end_date', 'Lisans bitişi'],
    ['license_table_limit', 'Masa sınırı'], ['is_active', 'Durum'], ['plaka_hediye_hakki', 'Hediye plaka hakkı'],
    ['discount_rate', 'İndirim oranı'],
];
function alanMetni(k, v) {
    if (k === 'license_modules') return modulAdlari(v);
    if (k === 'license_end_date') return trTarih(v);
    if (k === 'license_table_limit') return v == null ? 'sınırsız' : String(v);
    if (k === 'is_active') return Number(v) ? 'açık' : 'kapalı';
    if (k === 'plaka_hediye_hakki') return v == null ? 'otomatik' : (Number(v) ? 'ver' : 'kaldır');
    if (k === 'discount_rate') return '%' + (Number(v) || 0);
    return v == null || v === '' ? '(boş)' : String(v);
}
async function isletmeAnlik(tenantId) {
    const r = await query(`SELECT ${ISLETME_ALANLARI.map(([k]) => k).join(', ')} FROM tenants WHERE id = ?`, [tenantId]);
    return r.rows[0] || null;
}
function farklar(once, sonra) {
    const out = [];
    for (const [k, ad] of ISLETME_ALANLARI) {
        const a = once ? once[k] : null, b = sonra ? sonra[k] : null;
        const esit = k === 'license_modules'
            ? JSON.stringify(require('./lisansModul').modulListesi(a)) === JSON.stringify(require('./lisansModul').modulListesi(b))
            : String(a == null ? '' : a) === String(b == null ? '' : b);
        if (!esit) out.push({ alan: k, ad, once: a, sonra: b, metin: `${ad}: ${alanMetni(k, a)} -> ${alanMetni(k, b)}` });
    }
    return out;
}
async function isletmeFarki(req, tenantId, once, { islem } = {}) {
    if (req) req._yonetimGunluguYazildi = true;
    if (!once) return;
    const sonra = await isletmeAnlik(tenantId);
    const f = farklar(once, sonra);
    if (!f.length) return;          // hicbir sey degismedi: kayit yok
    const var_ = (k) => f.some((x) => x.alan === k);
    const secilen = islem
        || (var_('is_active') ? (Number(sonra.is_active) ? 'isletme_ac' : 'isletme_kapat')
            : (var_('license_modules') || var_('license_tier') || var_('license_table_limit') || var_('license_end_date')) ? 'modul_degisiklik'
                : var_('plaka_hediye_hakki') && f.length === 1 ? 'hediye_hakki'
                    : var_('discount_rate') && f.length === 1 ? 'indirim' : 'isletme_duzenle');
    await kaydet(req, {
        islem: secilen, tenantId, ozet: f.map((x) => x.metin).join('; '),
        ayrinti: { degisiklikler: f.map(({ alan, once: o, sonra: s }) => ({ alan, once: o, sonra: s })) },
    });
}

// --- Katalog farki (rootController.katalogGuncelle) ---
function katalogFarki(req, once, sonra) {
    if (req) req._yonetimGunluguYazildi = true;
    if (!once || !sonra) return Promise.resolve();
    const alanlar = [['ad', 'ad'], ['aciklama', 'açıklama'], ['fiyat', 'fiyat'], ['masa_limiti', 'masa sınırı'], ['gorunur', 'görünürlük'], ['sira', 'sıra']];
    const m = (k, v) => (k === 'fiyat' ? TL(v) : k === 'gorunur' ? (Number(v) ? 'Satışta' : 'Gizli')
        : k === 'masa_limiti' ? (v == null ? 'sınırsız' : String(v)) : (v == null || v === '' ? '(boş)' : String(v)));
    const f = alanlar.filter(([k]) => String(once[k] == null ? '' : once[k]) !== String(sonra[k] == null ? '' : sonra[k]))
        .map(([k, ad]) => ({ alan: k, once: once[k], sonra: sonra[k], metin: `${ad} ${m(k, once[k])} -> ${m(k, sonra[k])}` }));
    if (!f.length) return Promise.resolve();
    return kaydet(req, {
        islem: 'katalog', hedefTur: 'katalog', hedefId: sonra.id,
        ozet: `${sonra.tur === 'TIER' ? 'Paket' : 'Modül'} "${sonra.ad}": ${f.map((x) => x.metin).join('; ')}`,
        ayrinti: { degisiklikler: f.map(({ alan, once: o, sonra: s }) => ({ alan, once: o, sonra: s })) },
    });
}

// --- Sistem ayari farki (yonetimAyar.yaz ya da eski /api/root/ayarlar) ---
// degisen: [{ anahtar, once, sonra }]
function ayarFarki(req, degisen) {
    if (req) req._yonetimGunluguYazildi = true;
    if (!degisen || !degisen.length) return Promise.resolve();
    const { ETIKET } = require('./yonetimAyar');
    const m = (v) => (v == null || v === '' ? '(varsayılan/boş)' : String(v));
    return kaydet(req, {
        islem: 'sistem_ayari',
        ozet: degisen.map((d) => `${ETIKET[d.anahtar] || d.anahtar}: ${m(d.once)} -> ${m(d.sonra)}`).join('; '),
        ayrinti: { degisiklikler: degisen },
    });
}

// --- Liste (Yonetim Gunlugu sekmesi + Genel Bakis son hareketler) ---
// baslangic / bitis: 'YYYY-MM-DD' (Istanbul gunu, ikisi de dahil)
const gunBasi = (g) => new Date(`${g}T00:00:00+03:00`).toISOString();
const gunSonu = (g) => new Date(new Date(`${g}T00:00:00+03:00`).getTime() + 86400000).toISOString();
async function liste({ baslangic, bitis, islem, tenantId, limit, onceId } = {}) {
    const w = [], p = [];
    const gun = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    if (gun(baslangic)) { w.push('datetime(g.created_at) >= datetime(?)'); p.push(gunBasi(baslangic)); }
    if (gun(bitis)) { w.push('datetime(g.created_at) < datetime(?)'); p.push(gunSonu(bitis)); }
    if (islem) {
        const l = String(islem).split(',').map((s) => s.trim()).filter((s) => /^[a-z_]{2,40}$/.test(s));
        if (l.length) { w.push(`g.islem IN (${l.map(() => '?').join(', ')})`); p.push(...l); }
    }
    if (tenantId) { w.push('g.tenant_id = ?'); p.push(String(tenantId)); }
    if (Number(onceId) > 0) { w.push('g.id < ?'); p.push(Number(onceId)); }
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const r = await query(
        `SELECT g.*, COALESCE(t.business_name, g.isletme_adi) AS isletme, ru.email AS root_eposta
           FROM yonetim_gunlugu g
           LEFT JOIN tenants t ON t.id = g.tenant_id
           LEFT JOIN root_users ru ON ru.id = g.root_id
          ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
          ORDER BY g.id DESC LIMIT ?`, [...p, n + 1]);
    const satirlar = r.rows.slice(0, n).map((x) => {
        let ayr = null; try { ayr = x.ayrinti ? JSON.parse(x.ayrinti) : null; } catch (_) { ayr = null; }
        return { id: x.id, zaman: x.created_at, islem: x.islem, islemAd: ISLEM_AD[x.islem] || x.islem, tenantId: x.tenant_id,
            isletme: x.isletme || null, hedefTur: x.hedef_tur, hedefId: x.hedef_id, ozet: x.ozet, ayrinti: ayr,
            root: x.root_eposta || null, cihaz: !!x.cihaz_id };
    });
    return { kayitlar: satirlar, dahaVar: r.rows.length > n };
}

module.exports = {
    ISLEM_AD, kaydet, rootAraKatmani, isletmeAnlik, isletmeFarki, katalogFarki, ayarFarki, liste, temizle, trTarih, TL, modulAdlari,
};
