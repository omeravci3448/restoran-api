const { query, tx } = require('../config/db');
const hub = require('../services/hubService');
const { v4: uuidv4 } = require('uuid');
const { rootaBildir } = require('../services/rootBildirim');
const { fiyatla } = require('../services/lisansFiyat');
const { AD: MODUL_AD } = require('../services/lisansModul');
const LT = require('../services/lisansTalep');
const { kdvHesapla, kayitKdv, kdvMetni } = require('../services/lisansKdv');
const OK = require('../services/odemeKorumasi');
const FB = require('../services/faturaBilgisi');

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
            verdict = '✅ SORUN YOK - hub API doğru cevap veriyor, ' + r.data.tiers.length + ' paket geliyor.';
        } else if (looksHtml || (r.status === 200 && !isJson)) {
            verdict = '❌ YANLIŞ ADRES - HUB_URL hub PANELİNE (frontend/nginx) işaret ediyor, API\'ye değil. ' +
                'Coolify\'da restoran-api env\'inde HUB_URL\'i hub API adresine çevirin (büyük ihtimalle https://hub-api.mdayazilim.com) ve restart edin.';
        } else if (r.status === 401) {
            verdict = '❌ HUB ESKİ KOD - modules-pricing PIN istiyor. Hub\'ı son commit ile yeniden deploy edin.';
        } else if (r.status === 200 && isJson) {
            verdict = '⚠️ Hub cevap veriyor ama paket listesi BOŞ - hub DB\'sinde dama-restoran tier kayıtları yok (Fiyatlandırma sayfasından kontrol edin).';
        } else {
            verdict = '⚠️ BEKLENMEDİK CEVAP - HTTP ' + r.status + '. Hub loglarına bakın.';
        }
        res.json({ hubUrl: hub.HUB_URL, target, httpStatus: r.status, contentType: ct, verdict });
    } catch (e) {
        res.json({
            hubUrl: hub.HUB_URL, target, error: e.code || e.message,
            verdict: '❌ ULAŞILAMADI - DNS/ağ hatası veya hub kapalı (' + (e.code || e.message) + '). HUB_URL adresini ve hub\'ın ayakta olduğunu kontrol edin.'
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
        if (payload.destek) {
            // Destek oturumu: teklif o isletmenin indirimi ve donemiyle hesaplansin (oturum aciksa)
            const d = await require('../services/destekOturumu').kimlik(payload);
            if (!d.hata) req.user = { id: null, tenantId: d.u.tenant_id, role: 'OWNER' };
        } else {
        const u = (await query('SELECT id, tenant_id, role FROM users WHERE id = ? AND is_active = 1', [payload.userId])).rows[0];
        if (u) req.user = { id: u.id, tenantId: u.tenant_id, role: u.role };
        }
    } catch (_) { /* anonim devam */ }
    next();
};

// Moduler fiyat (services/lisansFiyat.js): masa kademesi + acikca secilen moduller (bagimliliklar
// kendiliginden eklenir). Adisyon ve Kasa (BASE) fiyati kademenin fiyatidir; secilmezse kademe fiyati yok.
// Oturumlu kiracida teklif TURU de hesaplanir (services/lisansTalep.js): ilk / yenileme / yukseltme, kalan sure
// kredisi ve odenecek tutar. Donem icinde modul cikarma ya da kucuk pakete gecis 409 DONEM_ICI_AZALTMA.
// Oturumsuz (kayit sayfasi) yalniz fiyat.
// KDV (2026-11-18): fiyatlar KDV haric; araToplam = odenecek (oturumsuzda total), kdvTutari, genelToplam = havale tutari.
function teklifCevabi(tier, f) {
    const kdv = f.genelToplam != null
        ? { araToplam: f.araToplam, kdvOrani: f.kdvOrani, kdvTutari: f.kdvTutari, genelToplam: f.genelToplam }
        : kdvHesapla(f.total);
    return {
        currency: 'TRY', tier, modules: f.modules, eklenenBagimliliklar: f.eklenenBagimliliklar,
        korunanModuller: f.korunanModuller || [], eskiHakModuller: f.eskiHakModuller || [], tableLimit: f.tableLimit,
        subtotal: f.subtotal, discountRate: f.discountRate, discountAmount: f.discountAmount, total: f.total, breakdown: f.breakdown,
        ...(f.tur ? {
            tur: f.tur, kalanGun: f.kalanGun, krediTutari: f.krediTutari, krediKaynak: f.krediKaynak,
            odenecek: f.odenecek, aciklama: f.aciklama, donemTutari: f.donemTutari, uzunDonem: !!f.uzunDonem,
            aktifMasa: f.aktifMasa, masaUyarisi: !!f.masaUyarisi,
        } : {}),
        araToplam: kdv.araToplam, kdvOrani: kdv.kdvOrani, kdvTutari: kdv.kdvTutari, genelToplam: kdv.genelToplam,
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
        res.json(teklifCevabi(f.tier, f));   // yalniz QR menu: tier null (masa kademesi yok)
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
    const t = (await query('SELECT parent_org, license_tier, kvkk_consent_at FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) return { kanal: 'yerel' };
    if (t.parent_org === 'SofraMix' || t.license_tier === 'TIER_SOFRAMIX') {
        // SofraMix isletme oturum cerezi yalniz isletme.soframix.com.tr alan adinda gecerli: varsayilan o adres.
        return {
            kanal: 'soframix',
            url: (process.env.SOFRAMIX_PANEL_URL || 'https://isletme.soframix.com.tr').replace(/\/+$/, '') + '/isletme/pos',
            mesaj: 'POS paketiniz SofraMix üzerinden sağlanıyor. Paket değişikliği ve yenileme SofraMix işletme '
                 + 'panelinizden yapılır.',
        };
    }
    // Dogrudan (SofraMix disi) deneme hesabi POS icinden paket satin alir: ayni havale/EFT akisi,
    // root onayinda lisans 1 yil uzar ve kiraci "musteri"ye doner (rootController). Deneme oldugu
    // bilgisi arayuzde "Paketi Satin Al" metni ve kisa aciklama icin tasinir.
    // Ilk alim YALNIZ deneme sinifinda (TIER_DENEME ya da kayit formu denemesi; lisansTalep.denemeSinifiMi): onay
    // gununden 1 yil. Odeme kaydi olmayan ama deneme olmayan isletme normal yenileme yapar (bitisin uzerine).
    if (await LT.denemeSinifiMi(tenantId)) {
        return {
            ilkAlim: true,
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
        // Bekleyen bildirim (lisans seridi: "odemeniz incelemede"; son 30 gunde red varsa koruma yok, program kapali kalir)
        try {
            const b = (await query("SELECT * FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'beklemede' LIMIT 1", [req.user.tenantId])).rows[0];
            if (b) {
                const kb = b.odeme_bildirildi_at ? await OK.kayitKorumaBitisi(b).catch(() => null) : null;
                yk.bekleyenOdeme = { id: b.id, bildirildi: !!b.odeme_bildirildi_at, korumaBitis: kb ? kb.toISOString() : null,
                    redVar: !!(await OK.sonRed(req.user.tenantId, b.odeme_bildirildi_at).catch(() => null)) };
            }
        } catch (_) { /* serit bilgisi olmadan da calisir */ }
    }
    if (yk.kanal === 'soframix') yk.paket = await require('../services/soframixPaket').kiraciPaketBilgisi(req.user.tenantId).catch(() => null);
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
    // Arayuz bu cevapla "bekleyen bildirimi goster / iptal edip bu secimle devam et" sorar (BEKLEYEN_BILDIRIM).
    const bekleyenCevabi = async (bekleyenId) => {
        const b = (await query('SELECT * FROM lisans_odemeleri WHERE id = ?', [bekleyenId])).rows[0] || {};
        const k = kayitKdv(b);
        const tam = await require('../services/lisansKatalog').tamKatalog().catch(() => []);
        return res.status(409).json({
            code: 'BEKLEYEN_BILDIRIM', message: 'Onay bekleyen bir ödeme bildiriminiz var.', id: bekleyenId,
            tier: b.tier || null, tierAd: LT.tierAdi(tam, b.tier), tutar: Number(b.tutar) || 0, genelToplam: k.genelToplam,
            kdvVar: k.kdvVar, odemeBildirildi: !!b.odeme_bildirildi_at,
        });
    };
    const once = await query("SELECT id FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'beklemede'", [req.user.tenantId]);
    if (once.rows.length) return bekleyenCevabi(once.rows[0].id);

    // Fatura bilgisi ilk satin almada BIR KEZ zorunlu (kayitliysa sorulmaz). Eksikse arayuz formu gosterir.
    const fatura = await FB.oku(req.user.tenantId);
    if (!fatura.tamam) {
        return res.status(400).json({ code: 'FATURA_BILGISI_EKSIK', eksik: fatura.eksik,
            message: 'Satın alma için fatura bilgilerinizi tamamlayın.' });
    }

    // Masa siniri (2026-11-18): aktif masa sayisi secilen paketin sinirinin uzerindeyse musteri uyariyi okuyup
    // onaylamali ("Okudum, anladim"); onayda tum masalar pasife alinir (services/masaSiniri.js). Onay kayda yazilir.
    if (tk.masaUyarisi && req.body.masaUyarisiOnay !== true) {
        return res.status(400).json({ code: 'MASA_UYARISI_ONAY_GEREKLI', aktifMasa: tk.aktifMasa, sinir: tk.tableLimit,
            message: masaUyariMetni(tk.aktifMasa, tk.tableLimit) });
    }
    const masaOnayAt = tk.masaUyarisi ? new Date().toISOString() : null;

    // Kontrol + kayit tek islemde (es zamanli iki istek ikisi birden gecemesin).
    const id = uuidv4();
    const kayit = await tx(async () => {
        const bekleyen = await query(
            "SELECT id FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'beklemede'", [req.user.tenantId]);
        if (bekleyen.rows.length) return { bekleyenId: bekleyen.rows[0].id };
        await query(
            `INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, aciklama, tur, yeni_toplam, kredi_tutari,
                                           kalan_gun, kredi_kaynak, onceki_tier, onceki_moduller, onceki_bitis,
                                           kdv_orani, kdv_tutari, genel_toplam, masa_uyari_onay_at, masa_uyari_aktif)
             VALUES (?, ?, ?, ?, ?, 'beklemede', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, req.user.tenantId, tk.tier, JSON.stringify(tk.odenenModuller), tk.odenecek, String(customerNote || '').slice(0, 300),
                tk.tur, tk.yeniToplam, tk.krediTutari, tk.kalanGun, tk.krediKaynak,
                tk.onceki.tier, JSON.stringify(tk.onceki.moduller), tk.onceki.bitis,
                tk.kdvOrani, tk.kdvTutari, tk.genelToplam, masaOnayAt, tk.masaUyarisi ? tk.aktifMasa : null]);
        return {};
    });
    if (kayit.bekleyenId) return bekleyenCevabi(kayit.bekleyenId);

    const A = require('../services/sistemAyar');
    const TUR_AD = { ilk: 'İlk satın alma (deneme sonrası)', yenileme: 'Yenileme', yukseltme: 'Yükseltme (dönem içi)' };
    const kdvSatir = { tutar: tk.odenecek, kdv_orani: tk.kdvOrani, kdv_tutari: tk.kdvTutari, genel_toplam: tk.genelToplam };
    isletmeAdi(req.user.tenantId).then(i => rootaBildir('Yeni paket talebi (ödeme henüz bildirilmedi): ' + i.ad, [
        ['İşletme', i.ad + ' (kod ' + i.kod + ')'], ['Havale açıklaması', 'MDA-' + i.kod], ['E-posta', i.eposta], ['Telefon', i.tel],
        ['Tür', TUR_AD[tk.tur] || tk.tur],
        ['Masa paketi', tk.tierRow ? tk.tierRow.displayName + ' (' + tk.tier + ')' : 'Yok (yalnız QR Menü)'], ['Modüller', tk.odenenModuller.map((m) => MODUL_AD[m] || m).join(', ')],
        ...(tk.korunanModuller.length ? [['Korunan (ücretsiz)', tk.korunanModuller.map((m) => (m === 'ALL' ? 'Tüm modüller' : MODUL_AD[m] || m)).join(', ')]] : []),
        ['Yıllık toplam (KDV hariç)', LT.TL(tk.yeniToplam)],
        ...(tk.tur === 'yukseltme' ? [['Kalan süre kredisi', tk.kalanGun + ' gün, ' + LT.TL(tk.krediTutari)
            + (tk.krediKaynak === 'katalog' ? ' (bu dönem için onaylı ödeme yok: katalog fiyatından)' : ' (son onaylı ödemeden)')]] : []),
        ['Ödenecek', kdvMetni(kdvSatir)], ['Havale tutarı', LT.TL(tk.genelToplam)],
        ...(tk.masaUyarisi ? [['Masa sınırı', `Aktif ${tk.aktifMasa} masa, paket sınırı ${tk.tableLimit}. Onayda açık hesabı olmayan masalar pasife alınır (müşteri uyarıyı onayladı).`]] : []),
        ['Durum', 'Müşteri henüz "ödemeyi yaptım" demedi. Ödeme bildirilince ayrıca e-posta gelir.'],
    ])).catch(() => {});
    res.status(201).json({
        id, tier: tk.tier, modules: tk.modules, odenenModuller: tk.odenenModuller, korunanModuller: tk.korunanModuller,
        total: tk.yeniToplam, odenecek: tk.odenecek, tur: tk.tur,
        araToplam: tk.araToplam, kdvOrani: tk.kdvOrani, kdvTutari: tk.kdvTutari, genelToplam: tk.genelToplam,
        kalanGun: tk.kalanGun, krediTutari: tk.krediTutari, aciklama: tk.aciklama, status: 'PENDING_PAYMENT',
        iban: await A.oku('iban', ''), hesapSahibi: await A.oku('iban_sahibi', ''),
        message: 'Ödeme bildiriminiz oluşturuldu. Havale/EFT sonrası "Ödemeyi yaptım" deyin.',
    });
};

// Satin almada aktif masa sayisi paketin sinirinin uzerindeyse gosterilen uyari (arayuzde ayni metin)
function masaUyariMetni(aktif, sinir) {
    return `Aktif masa sayınız (${aktif}) seçtiğiniz paketin sınırının (${sinir}) üzerinde. Ödemeniz onaylandığında açık hesabı `
        + 'olmayan masalarınız pasife alınır (açık hesaplı masalar hesap kapanana kadar aktif kalır); lisansınızdaki masa sayısı kadar '
        + 'masayı Masalar sayfasından yeniden aktif edebilirsiniz. Aktif ettiğiniz masaların karekodları çalışmaya devam eder.';
}

exports.markPaid = async (req, res) => {
    const r = await query(
        "SELECT * FROM lisans_odemeleri WHERE id = ? AND tenant_id = ?",
        [req.params.id, req.user.tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Ödeme kaydı bulunamadı.' });
    if (r.rows[0].durum !== 'beklemede') return res.status(409).json({ message: 'Bu ödeme zaten sonuçlandırılmış.' });
    // Ilk bildirim ani KORUNUR: tekrar "odemeyi yaptim" demek odeme korumasi penceresini uzatmaz (yalniz not guncellenir)
    await query('UPDATE lisans_odemeleri SET aciklama = ?, odeme_bildirildi_at = COALESCE(odeme_bildirildi_at, CURRENT_TIMESTAMP) WHERE id = ?',
        [String(req.body?.paymentRef || r.rows[0].aciklama || '').slice(0, 300), req.params.id]);
    // Odeme korumasi (onay beklerken program acik): bir sonraki istek hemen gorsun
    await OK.tazele().catch(() => {});
    const o = r.rows[0];
    const k = kayitKdv(o);
    // Root e-postasi yalniz ILK bildirimde (tekrar basildiginda gelen kutusu dolmasin; not root listesinde gorunur)
    if (!o.odeme_bildirildi_at) isletmeAdi(req.user.tenantId).then(i => rootaBildir('Ödeme bildirildi: ' + i.ad + ' - ' + LT.TL(k.genelToplam), [
        ['İşletme', i.ad + ' (kod ' + i.kod + ')'], ['Havale açıklaması', 'MDA-' + i.kod], ['Paket', o.tier || 'Yalnız QR Menü'],
        ...(o.tur === 'yukseltme' ? [['Tür', 'Yükseltme (yıllık toplam ' + LT.TL(o.yeni_toplam) + ', kredi ' + LT.TL(o.kredi_tutari) + ')']] : []),
        ['Tutar', kdvMetni(o)], ['Havale tutarı', LT.TL(k.genelToplam)], ['Gönderen / dekont notu', String(req.body?.paymentRef || '-')],
        ['Yapılacak', 'Hesabı kontrol edip root panelinden onaylayın; lisans otomatik uzar.'],
    ])).catch(() => {});
    res.json({ ok: true, status: 'PAID_DECLARED',
        message: 'Bildiriminiz alındı. Onaylandığında lisansınız uzayacak.' });
};

// --- Fatura bilgisi (services/faturaBilgisi.js) ---
// /api/license altinda: lisans SALT_OKUNUR ya da KAPALI iken de acik (satin almadan once doldurulabilsin).
exports.faturaOku = async (req, res) => res.json(await FB.oku(req.user.tenantId));
exports.faturaYaz = async (req, res) => {
    try { res.json(await FB.yaz(req.user.tenantId, req.body || {})); }
    catch (e) {
        if (e.status) return res.status(e.status).json({ code: e.code, message: e.message, alan: e.alan });
        throw e;
    }
};

// Kayit, arayuzun bekledigi adlarla da doner (status/amount/modules/paid_declared_at); Turkce alanlar korunur.
// Liste ve tekil uc AYNI bicimi vermeli: eskiden liste 'status' vermiyordu, arayuz bekleyen odemeyi bulamiyordu.
// KDV (2026-11-18): amount/tutar = KDV haric; havale_tutari = genel_toplam (eski kayitta KDV yok: tutar, kdv_var false).
// havale_kodu: musterinin havale aciklamasina yazacagi "MDA-{isyeri kodu}". koruma_bitis: bekleyen ve bildirilmis
// kayitta odeme korumasinin bitisi (bkz services/odemeKorumasi.js), yoksa null.
function kaydiHazirla(x, ek = {}) {
    const moduller = guvenliJson(x.moduller);
    const status = x.durum === 'onaylandi' ? 'CONFIRMED'
        : x.durum === 'reddedildi' ? 'REJECTED'
        : x.durum === 'iptal' ? 'CANCELLED'
        : (x.odeme_bildirildi_at ? 'PAID_DECLARED' : 'PENDING_PAYMENT');
    const k = kayitKdv(x);
    return { ...x, moduller, modules: moduller, amount: x.tutar, status, paid_declared_at: x.odeme_bildirildi_at || null,
        kdv_var: k.kdvVar, ara_toplam: k.araToplam, havale_tutari: k.genelToplam, ...ek };
}
async function kayitEkleri(tenantId, x) {
    const t = (await query('SELECT business_code FROM tenants WHERE id = ?', [tenantId])).rows[0] || {};
    const ek = { havale_kodu: t.business_code ? 'MDA-' + t.business_code : null, koruma_bitis: null };
    if (x && x.durum === 'beklemede' && x.odeme_bildirildi_at) {
        const b = await OK.kayitKorumaBitisi({ ...x, tenant_id: tenantId }).catch(() => null);
        ek.koruma_bitis = b ? b.toISOString() : null;
    }
    // Son 30 gunde reddedilmis bildirim: bu bildirimde onay beklerken program acik tutulmaz (musteriye soylenir)
    if (x && x.durum === 'beklemede') ek.koruma_yok_red = !!(await OK.sonRed(tenantId, x.odeme_bildirildi_at).catch(() => null));
    return ek;
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
    await OK.tazele().catch(() => {});   // iptal: odeme korumasi hemen biter
    res.json({ ok: true, status: 'CANCELLED' });
};

exports.purchases = async (req, res) => {
    const r = await query(
        `SELECT id, tier, moduller, tutar, durum, aciklama, admin_note, donem_bitis, created_at, islenen_at, odeme_bildirildi_at,
                tur, yeni_toplam, kredi_tutari, kalan_gun, kdv_orani, kdv_tutari, genel_toplam
           FROM lisans_odemeleri WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`,
        [req.user.tenantId]);
    const out = [];
    for (const x of r.rows) {
        out.push(kaydiHazirla(x, x.durum === 'beklemede' ? await kayitEkleri(req.user.tenantId, x) : {}));
    }
    res.json(out);
};
exports.purchaseStatus = async (req, res) => {
    const r = await query('SELECT * FROM lisans_odemeleri WHERE id = ? AND tenant_id = ?',
        [req.params.id, req.user.tenantId]);
    if (!r.rows.length) return res.status(404).json({ message: 'Bulunamadı.' });
    res.json(kaydiHazirla(r.rows[0], await kayitEkleri(req.user.tenantId, r.rows[0])));
};

function guvenliJson(s) {
    try { return JSON.parse(s || '[]'); } catch (_) { return []; }
}