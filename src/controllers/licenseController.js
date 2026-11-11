const { query, tx } = require('../config/db');
const hub = require('../services/hubService');
const { v4: uuidv4 } = require('uuid');
const { rootaBildir } = require('../services/rootBildirim');
const { fiyatla } = require('../services/lisansFiyat');
const { AD: MODUL_AD } = require('../services/lisansModul');
const LT = require('../services/lisansTalep');

// Hub erişilemezse kayıt formu yine çalışsın diye yedek katalog.
// Kayıt formu fiyat GÖSTERMEZ (sadece ad + masa limiti) — bu yüzden fiyatların
// yedekte 0 olması sorun değil; gerçek fiyatlar Lisans sayfasında hub'dan gelir.
const FALLBACK_CATALOG = {
    appId: 'dama-restoran',
    tiers: [
        { name: 'TIER_1_5', displayName: '1-5 Masa', price: 0, tableLimit: 5 },
        { name: 'TIER_6_10', displayName: '6-10 Masa', price: 0, tableLimit: 10 },
        { name: 'TIER_11_20', displayName: '11-20 Masa', price: 0, tableLimit: 20 },
        { name: 'TIER_20_PLUS', displayName: '20+ Masa (Sınırsız)', price: 0, tableLimit: null }
    ],
    modules: [
        { name: 'BASE', displayName: 'Temel (Dahil)', price: 0 },
        { name: 'MENU_DIGITAL', displayName: 'Dijital QR Menü', price: 0 },
        { name: 'GARSON', displayName: 'Garson Mobil Uygulaması', price: 0 },
        { name: 'STOK', displayName: 'Stok + Tedarikçi', price: 0 },
        { name: 'MARKETPLACE', displayName: 'Pazaryeri', price: 0 }
    ],
    categories: []
};

// TEŞHİS: hub bağlantısını sunucu tarafından dener ve hükmü Türkçe söyler.
// Tarayıcıdan açılır: GET /api/license/hub-status — API key SIZDIRMAZ.
exports.hubStatus = async (_req, res) => {
    const axios = require('axios');
    const target = `${hub.HUB_URL}/api/subscriptions/modules-pricing?appId=dama-restoran`;
    try {
        const r = await axios.get(target, { timeout: 8000, validateStatus: () => true });
        const ct = String(r.headers['content-type'] || '');
        const isJson = ct.includes('application/json');
        const looksHtml = typeof r.data === 'string' && /<html|<!doctype/i.test(r.data);
        let verdict;
        if (r.status === 200 && isJson && Array.isArray(r.data?.tiers) && r.data.tiers.length) {
            verdict = '✅ SORUN YOK — hub API doğru cevap veriyor, ' + r.data.tiers.length + ' paket geliyor.';
        } else if (looksHtml || (r.status === 200 && !isJson)) {
            verdict = '❌ YANLIŞ ADRES — HUB_URL hub PANELİNE (frontend/nginx) işaret ediyor, API\'ye değil. ' +
                'Coolify\'da restoran-api env\'inde HUB_URL\'i hub API adresine çevirin (büyük ihtimalle https://hub-api.mdayazilim.com) ve restart edin.';
        } else if (r.status === 401) {
            verdict = '❌ HUB ESKİ KOD — modules-pricing PIN istiyor. Hub\'ı son commit ile yeniden deploy edin.';
        } else if (r.status === 200 && isJson) {
            verdict = '⚠️ Hub cevap veriyor ama paket listesi BOŞ — hub DB\'sinde dama-restoran tier kayıtları yok (Fiyatlandırma sayfasından kontrol edin).';
        } else {
            verdict = '⚠️ BEKLENMEDİK CEVAP — HTTP ' + r.status + '. Hub loglarına bakın.';
        }
        res.json({ hubUrl: hub.HUB_URL, target, httpStatus: r.status, contentType: ct, verdict });
    } catch (e) {
        res.json({
            hubUrl: hub.HUB_URL, target, error: e.code || e.message,
            verdict: '❌ ULAŞILAMADI — DNS/ağ hatası veya hub kapalı (' + (e.code || e.message) + '). HUB_URL adresini ve hub\'ın ayakta olduğunu kontrol edin.'
        });
    }
};

// Hub'dan tüm modül + tier fiyatlarını çek. Hub erişilemezse yedek katalog
// döndür (kayıt akışı asla paketsiz kalmasın). fromHub=false → frontend isterse uyarabilir.
// Katalog ARTIK HUBDAN GELMIYOR. POS kendi veritabanindaki katalogu doner;
// fiyatlari ve paketleri root paneli tanimlar. Hubdan okundugu surece POS,
// baska bir servisin ayakta olmasina bagimliydi: hub kapaliyken musteri fiyat
// listesini bos goruyor ve sebebini anlayamiyordu.
//
// ⚠ Gizli (gorunur=0) satirlar BURADAN DONMEZ - bkz. lisansKatalog servisi.
exports.catalog = async (_req, res) => {
    const K = require('../services/lisansKatalog');
    res.json(await K.musteriKatalogu());
};

// Mevcut tenant'ın lisansını hub'dan tekrar çek
exports.refresh = async (req, res) => {
    const r = await query('SELECT owner_email FROM tenants WHERE id = ?', [req.user.tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Tenant bulunamadı.' });
    const result = await hub.refreshTenantLicense(req.user.tenantId, r.rows[0].owner_email);
    if (!result.ok) return res.status(502).json(result);

    // Yeni tier'ın masa limitini de çek ve tenant'a yaz
    try {
        const cat = await hub.getModulesAndTiers();
        const tierRow = cat.tiers.find(t => t.name === result.payload.category);
        if (tierRow) {
            await query('UPDATE tenants SET license_table_limit = ? WHERE id = ?',
                [tierRow.tableLimit ?? null, req.user.tenantId]);
        }
    } catch (_) {}

    res.json(result.payload);
};

// Sepet hesabı: { tier, modules:[...] } → toplam tutar (mevcut tenant indirimi uygulanır)
// Fiyat hesabi da YEREL katalogdan. Istemciden gelen tutara asla guvenilmez.
//
// ⚠ GIZLI MODUL FIYATA GIRMEZ. Gizlemek yalnizca "listede gorunmesin" olsaydi,
// istegi elle gonderen biri kapatilmis bir modulu yine satin alabilirdi.
// Katalog gizli satirlari hic dondurmedigi icin burada da bulunamaz.
// Kimlik OPSIYONEL: /quote herkese acik (kayit sayfasi fiyat gosterebilsin) ama giris yapmis
// kullanicida kiraci indirimi uygulanmali. Jeton yoksa/gecersizse anonim devam edilir; lisans
// durumu BURADA kontrol edilmez (suresi dolmus musteri de fiyat gorup yenileyebilmeli).
exports.kimlikOpsiyonel = async (req, _res, next) => {
    try {
        const auth = req.headers.authorization || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (!token) return next();
        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-me');
        const u = (await query('SELECT id, tenant_id, role FROM users WHERE id = ? AND is_active = 1', [payload.userId])).rows[0];
        if (u) req.user = { id: u.id, tenantId: u.tenant_id, role: u.role };
    } catch (_) { /* anonim devam */ }
    next();
};

// Moduler fiyat (services/lisansFiyat.js): masa kademesi + acikca secilen moduller (bagimliliklar
// kendiliginden eklenir). Adisyon ve Kasa (BASE) fiyati kademenin fiyatidir; secilmezse kademe fiyati yok.
// Oturumlu kiracida teklif TURU de hesaplanir (services/lisansTalep.js): ilk / yenileme / yukseltme, kalan sure
// kredisi ve odenecek tutar. Donem icinde modul cikarma ya da kucuk pakete gecis 409 DONEM_ICI_AZALTMA.
// Oturumsuz (kayit sayfasi) yalniz fiyat.
function teklifCevabi(tier, f) {
    return {
        currency: 'TRY', tier, modules: f.modules, eklenenBagimliliklar: f.eklenenBagimliliklar,
        korunanModuller: f.korunanModuller || [], tableLimit: f.tableLimit,
        subtotal: f.subtotal, discountRate: f.discountRate, discountAmount: f.discountAmount, total: f.total, breakdown: f.breakdown,
        ...(f.tur ? {
            tur: f.tur, kalanGun: f.kalanGun, krediTutari: f.krediTutari, krediKaynak: f.krediKaynak,
            odenecek: f.odenecek, aciklama: f.aciklama,
        } : {}),
    };
}
const hataCevabi = (res, e) => res.status(e.status).json({ code: e.code, message: e.message, ...(e.ek || {}) });

exports.quote = async (req, res) => {
    const { tier, modules = [] } = req.body || {};
    const tenantId = req.user && req.user.tenantId;
    try {
        const f = tenantId
            ? await LT.teklifHazirla({ tenantId, tier, modules })
            : await fiyatla({ tier, modules, indirimOrani: 0 });
        res.json(teklifCevabi(tier, f));
    } catch (e) {
        if (e.status) return hataCevabi(res, e);
        throw e;
    }
};

// Yeni satın alma talebi gönder — sepeti hub'a iletir
// Bu kiraci lisansini NEREDEN yeniliyor?
//
// SofraMix'ten gelen isletme parayi SofraMix'e oder (bayi modeli): POS icindeki
// hub satin alma akisi ona ACILMAMALI. Acilsaydi ayni musteri icin iki ayri
// tahsilat kanali ve iki ayri lisans tarihi kaynagi olusur, SofraMix'e
// kesilecek fatura da eksik kalirdi - kimse fark etmeden.
async function yenilemeKanali(tenantId) {
    const t = (await query('SELECT parent_org, license_tier FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) return { kanal: 'yerel' };
    if (t.parent_org === 'SofraMix' || t.license_tier === 'TIER_SOFRAMIX') {
        return {
            kanal: 'soframix',
            url: (process.env.SOFRAMIX_PANEL_URL || 'https://soframix.com.tr').replace(/\/+$/, '') + '/isletme/pos',
            mesaj: 'POS paketiniz SofraMix uzerinden saglaniyor. Yenilemeyi SofraMix isletme '
                 + 'panelinizden yapmaniz gerekiyor.',
        };
    }
    // Dogrudan (SofraMix disi) deneme hesabi POS icinden paket satin alir: ayni havale/EFT akisi,
    // root onayinda lisans 1 yil uzar ve kiraci "musteri"ye doner (rootController). Deneme oldugu
    // bilgisi arayuzde "Paketi Satin Al" metni ve kisa aciklama icin tasinir.
    if (t.license_tier === 'TIER_DENEME') {
        return {
            kanal: 'yerel', deneme: true,
            mesaj: 'Deneme sürümündesiniz. Paketi satın aldığınızda lisansınız ödemenizin onaylandığı gün başlar ve '
                 + '1 yıl geçerli olur; kayıtlarınız ve ayarlarınız olduğu gibi kalır. Ödeme havale/EFT ile yapılır.',
        };
    }
    return { kanal: 'yerel' };
}

// Arayuz hangi odeme yolunu cizecegini buradan ogreniyor.
// Yerel kanalda donem bilgisi de doner: sepet donem icinde mevcut modulleri ve kucuk paketleri kilitler.
exports.yenilemeKanali = async (req, res) => {
    const yk = await yenilemeKanali(req.user.tenantId);
    if (yk.kanal === 'yerel') {
        try { yk.donem = await LT.donemBilgisi(req.user.tenantId); } catch (_) { /* donem bilgisi olmadan da calisir */ }
    }
    res.json(yk);
};



// Banka bilgisi ARTIK YEREL. Root panelinden tanimlaniyor.
exports.bankInfo = async (_req, res) => {
    const A = require('../services/sistemAyar');
    res.json({
        iban: await A.oku('iban', ''),
        hesapSahibi: await A.oku('iban_sahibi', ''),
        banka: await A.oku('banka_adi', ''),
        aciklama: await A.oku('odeme_aciklama', ''),
    });
};

// Satin alma: YEREL bildirim kaydi. Hub'a hicbir cagri yapilmiyor.
//
// ⚠ BU KAYIT LISANSI UZATMAZ. Bildirim tek basina para demek degil; lisans
// yalnizca root panelinde onaylaninca uzuyor. Aksi halde "odedim" diyen herkes
// kendine lisans yazdirabilirdi.
exports.purchase = async (req, res) => {
    const yk = await yenilemeKanali(req.user.tenantId);
    if (yk.kanal !== 'yerel') {
        return res.status(409).json({ code: 'WRONG_CHANNEL', ...yk });
    }
    const { tier, modules = [], customerNote } = req.body || {};
    // Teklif TALEP ANINDA hesaplanir ve kayda KILITLENIR: onayda yeniden hesaplanmaz (katalog fiyati sonradan
    // degisse de musteriye gosterilen tutar gecerli). Lisansa burada DOKUNULMAZ.
    let tk;
    try {
        tk = await LT.teklifHazirla({ tenantId: req.user.tenantId, tier, modules });
    } catch (e) {
        if (e.status) return hataCevabi(res, e);
        throw e;
    }

    // Ayni kiracinin bekleyen bildirimi varsa ikincisi acilmiyor: iki bildirim onaylanirsa lisans iki kez uzar.
    // Kontrol + kayit tek islemde (es zamanli iki istek ikisi birden gecemesin).
    const id = uuidv4();
    const kayit = await tx(async () => {
        const bekleyen = await query(
            "SELECT id FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'beklemede'", [req.user.tenantId]);
        if (bekleyen.rows.length) return { bekleyenId: bekleyen.rows[0].id };
        await query(
            `INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, aciklama, tur, yeni_toplam, kredi_tutari,
                                           kalan_gun, kredi_kaynak, onceki_tier, onceki_moduller, onceki_bitis)
             VALUES (?, ?, ?, ?, ?, 'beklemede', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, req.user.tenantId, tier, JSON.stringify(tk.modules), tk.odenecek, String(customerNote || '').slice(0, 300),
                tk.tur, tk.yeniToplam, tk.krediTutari, tk.kalanGun, tk.krediKaynak,
                tk.onceki.tier, JSON.stringify(tk.onceki.moduller), tk.onceki.bitis]);
        return {};
    });
    if (kayit.bekleyenId) {
        return res.status(409).json({ message: 'Onay bekleyen bir ödeme bildiriminiz var.', id: kayit.bekleyenId });
    }

    const A = require('../services/sistemAyar');
    const TUR_AD = { ilk: 'İlk satın alma (deneme sonrası)', yenileme: 'Yenileme', yukseltme: 'Yükseltme (dönem içi)' };
    isletmeAdi(req.user.tenantId).then(i => rootaBildir('Yeni ödeme bildirimi: ' + i.ad, [
        ['İşletme', i.ad + ' (kod ' + i.kod + ')'], ['E-posta', i.eposta], ['Telefon', i.tel],
        ['Tür', TUR_AD[tk.tur] || tk.tur],
        ['Masa paketi', tk.tierRow.displayName + ' (' + tier + ')'], ['Modüller', tk.modules.map((m) => MODUL_AD[m] || m).join(', ')],
        ['Yıllık toplam', LT.TL(tk.yeniToplam)],
        ...(tk.tur === 'yukseltme' ? [['Kalan süre kredisi', tk.kalanGun + ' gün, ' + LT.TL(tk.krediTutari)
            + (tk.krediKaynak === 'katalog' ? ' (bu dönem için onaylı ödeme yok: katalog fiyatından)' : ' (son onaylı ödemeden)')]] : []),
        ['Ödenecek', LT.TL(tk.odenecek)],
    ])).catch(() => {});
    res.status(201).json({
        id, tier, modules: tk.modules, total: tk.yeniToplam, odenecek: tk.odenecek, tur: tk.tur,
        kalanGun: tk.kalanGun, krediTutari: tk.krediTutari, aciklama: tk.aciklama, status: 'PENDING_PAYMENT',
        iban: await A.oku('iban', ''), hesapSahibi: await A.oku('iban_sahibi', ''),
        message: 'Ödeme bildiriminiz oluşturuldu. Havale/EFT sonrası "Ödemeyi yaptım" deyin.',
    });
};

exports.markPaid = async (req, res) => {
    const r = await query(
        "SELECT * FROM lisans_odemeleri WHERE id = ? AND tenant_id = ?",
        [req.params.id, req.user.tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Ödeme kaydı bulunamadı.' });
    if (r.rows[0].durum !== 'beklemede') return res.status(409).json({ message: 'Bu ödeme zaten sonuçlandırılmış.' });
    await query('UPDATE lisans_odemeleri SET aciklama = ?, odeme_bildirildi_at = CURRENT_TIMESTAMP WHERE id = ?',
        [String(req.body?.paymentRef || r.rows[0].aciklama || '').slice(0, 300), req.params.id]);
    isletmeAdi(req.user.tenantId).then(i => rootaBildir('Müşteri "ödemeyi yaptım" dedi: ' + i.ad, [
        ['İşletme', i.ad + ' (kod ' + i.kod + ')'], ['Paket', r.rows[0].tier],
        ...(r.rows[0].tur === 'yukseltme' ? [['Tür', 'Yükseltme (yıllık toplam ' + LT.TL(r.rows[0].yeni_toplam) + ', kredi ' + LT.TL(r.rows[0].kredi_tutari) + ')']] : []),
        ['Tutar', Number(r.rows[0].tutar).toLocaleString('tr-TR') + ' TL'], ['Referans', String(req.body?.paymentRef || '-')],
        ['Yapılacak', 'Hesabı kontrol edip root panelinden onayla; lisans otomatik uzar.'],
    ])).catch(() => {});
    res.json({ ok: true, status: 'PAID_DECLARED',
        message: 'Bildiriminiz alındı. Onaylandığında lisansınız uzayacak.' });
};

// Kayit, arayuzun bekledigi adlarla da doner (status/amount/modules/paid_declared_at); Turkce alanlar korunur.
// Liste ve tekil uc AYNI bicimi vermeli: eskiden liste 'status' vermiyordu, arayuz bekleyen odemeyi bulamiyordu.
function kaydiHazirla(x) {
    const moduller = guvenliJson(x.moduller);
    const status = x.durum === 'onaylandi' ? 'CONFIRMED'
        : x.durum === 'reddedildi' ? 'REJECTED'
        : x.durum === 'iptal' ? 'CANCELLED'
        : (x.odeme_bildirildi_at ? 'PAID_DECLARED' : 'PENDING_PAYMENT');
    return { ...x, moduller, modules: moduller, amount: x.tutar, status, paid_declared_at: x.odeme_bildirildi_at || null };
}
// Patron'a e-posta: ortak servis services/rootBildirim.js (rootaBildir), degerleri HTML kacislar.
async function isletmeAdi(tenantId) {
    const t = (await query('SELECT business_name, business_code, owner_email, phone FROM tenants WHERE id = ?', [tenantId])).rows[0] || {};
    return { ad: t.business_name || tenantId, kod: t.business_code || '-', eposta: t.owner_email || '-', tel: t.phone || '-' };
}

// Bekleyen bildirimi musteri iptal eder: secimi/tutari degistirmek icin tek yol (ayni anda tek bekleyen kurali).
// Onaylanmis/reddedilmis kayit iptal edilemez. Kayit silinmez, root panelinde 'iptal' olarak gorunur.
exports.cancelPurchase = async (req, res) => {
    const r = await query('SELECT id, durum FROM lisans_odemeleri WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Ödeme kaydı bulunamadı.' });
    if (r.rows[0].durum !== 'beklemede') return res.status(409).json({ message: 'Bu ödeme zaten sonuçlandırılmış; iptal edilemez.' });
    await query("UPDATE lisans_odemeleri SET durum = 'iptal', islenen_at = CURRENT_TIMESTAMP, admin_note = COALESCE(admin_note, 'müşteri iptal etti') WHERE id = ? AND durum = 'beklemede'",
        [req.params.id]);
    res.json({ ok: true, status: 'CANCELLED' });
};

exports.purchases = async (req, res) => {
    const r = await query(
        `SELECT id, tier, moduller, tutar, durum, aciklama, admin_note, donem_bitis, created_at, islenen_at, odeme_bildirildi_at,
                tur, yeni_toplam, kredi_tutari, kalan_gun
           FROM lisans_odemeleri WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`,
        [req.user.tenantId]);
    res.json(r.rows.map(kaydiHazirla));
};
exports.purchaseStatus = async (req, res) => {
    const r = await query('SELECT * FROM lisans_odemeleri WHERE id = ? AND tenant_id = ?',
        [req.params.id, req.user.tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Bulunamadı.' });
    res.json(kaydiHazirla(r.rows[0]));
};

function guvenliJson(s) {
    try { return JSON.parse(s || '[]'); } catch (_) { return []; }
}