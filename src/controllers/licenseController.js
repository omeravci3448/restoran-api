const { query } = require('../config/db');
const hub = require('../services/hubService');
const { v4: uuidv4 } = require('uuid');

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

exports.quote = async (req, res) => {
    const { tier, modules = [] } = req.body || {};
    const K = require('../services/lisansKatalog');
    const data = await K.musteriKatalogu();
    const tenantId = req.user && req.user.tenantId;
    const tenantRow = tenantId
        ? await query('SELECT discount_rate FROM tenants WHERE id = ?', [tenantId])
        : { rows: [] };

    const tierRow = data.tiers.find(t => t.name === tier);
    if (!tierRow) return res.status(400).json({ message: 'Geçersiz paket.' });

    const breakdown = [{ name: tier, displayName: tierRow.displayName, type: 'TIER', price: tierRow.price }];
    let subtotal = Number(tierRow.price);

    // Ucretsiz moduller otomatik ekleniyor (musteri secmese de dahil).
    const moduleNames = Array.from(new Set([
        ...modules,
        ...data.modules.filter(m => Number(m.price) === 0).map(m => m.name),
    ]));

    const bilinmeyen = [];
    for (const m of moduleNames) {
        const row = data.modules.find(x => x.name === m);
        if (!row) { bilinmeyen.push(m); continue; }
        breakdown.push({ name: row.name, displayName: row.displayName, type: 'MODULE', price: row.price });
        subtotal += Number(row.price);
    }
    // Sessizce dusurmuyoruz: musteri sectigini sandigi bir seyin hesaba
    // girmedigini bilmeli.
    if (bilinmeyen.length) {
        return res.status(400).json({ message: 'Şu an satışta olmayan bir seçenek var: ' + bilinmeyen.join(', ') });
    }

    const discountRate = Number(tenantRow.rows[0]?.discount_rate || 0);
    const discountAmount = Math.round((subtotal * discountRate / 100) * 100) / 100;
    const total = Math.max(0, subtotal - discountAmount);

    res.json({
        currency: 'TRY', tier, modules: moduleNames,
        subtotal, discountRate, discountAmount, total, breakdown,
    });
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
            mesaj: 'Deneme sürümündesiniz. Paketi satın aldığınızda lisansınız 1 yıl uzar; kayıtlarınız '
                 + 've ayarlarınız olduğu gibi kalır. Ödeme havale/EFT ile yapılır, onaylanınca otomatik açılır.',
        };
    }
    return { kanal: 'yerel' };
}

// Arayuz hangi odeme yolunu cizecegini buradan ogreniyor.
exports.yenilemeKanali = async (req, res) => {
    res.json(await yenilemeKanali(req.user.tenantId));
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
    const K = require('../services/lisansKatalog');
    const data = await K.musteriKatalogu();
    const tierRow = data.tiers.find(t => t.name === tier);
    if (!tierRow) return res.status(400).json({ message: 'Geçersiz paket.' });

    const modulAdlari = Array.from(new Set([
        ...modules,
        ...data.modules.filter(m => Number(m.price) === 0).map(m => m.name),
    ]));
    let toplam = Number(tierRow.price);
    for (const m of modulAdlari) {
        const row = data.modules.find(x => x.name === m);
        if (!row) return res.status(400).json({ message: 'Şu an satışta olmayan bir seçenek var: ' + m });
        toplam += Number(row.price);
    }
    const t = (await query('SELECT discount_rate FROM tenants WHERE id = ?', [req.user.tenantId])).rows[0];
    const indirim = Number(t?.discount_rate || 0);
    toplam = Math.max(0, Math.round((toplam - (toplam * indirim / 100)) * 100) / 100);

    // Ayni kiracinin bekleyen bildirimi varsa ikincisi acilmiyor: iki bildirim
    // onaylanirsa lisans iki kez uzar.
    const bekleyen = await query(
        "SELECT id FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'beklemede'", [req.user.tenantId]);
    if (bekleyen.rows.length) {
        return res.status(409).json({ message: 'Onay bekleyen bir ödeme bildiriminiz var.', id: bekleyen.rows[0].id });
    }

    const id = uuidv4();
    await query(
        `INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, aciklama)
         VALUES (?, ?, ?, ?, ?, 'beklemede', ?)`,
        [id, req.user.tenantId, tier, JSON.stringify(modulAdlari), toplam,
            String(customerNote || '').slice(0, 300)]);

    const A = require('../services/sistemAyar');
    isletmeAdi(req.user.tenantId).then(i => rootaBildir('Yeni ödeme bildirimi: ' + i.ad, [
        ['İşletme', i.ad + ' (kod ' + i.kod + ')'], ['E-posta', i.eposta], ['Telefon', i.tel],
        ['Paket', tier], ['Modüller', modulAdlari.join(', ')], ['Tutar', Number(toplam).toLocaleString('tr-TR') + ' TL (yıllık)'],
    ])).catch(() => {});
    res.status(201).json({
        id, tier, modules: modulAdlari, total: toplam, status: 'PENDING_PAYMENT',
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
// Yeni odeme bildirimi / "odemeyi yaptim" geldiginde Patron'a e-posta (root ayari bildirim_eposta,
// yoksa ROOT_EMAIL). Best-effort: posta gitmese de musteri akisi bozulmaz; root panelinde zaten gorunur.
async function rootaBildir(konu, satirlar) {
    try {
        const A = require('../services/sistemAyar');
        const alici = (await A.oku('bildirim_eposta', '')) || process.env.ROOT_EMAIL || '';
        if (!alici) return;
        const { sendMail } = require('../services/emailService');
        const panel = (process.env.POS_PANEL_URL || 'https://restoran.mdayazilim.com').replace(/\/+$/, '');
        const html = '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:520px;padding:16px;border:1px solid #e5e7eb;border-radius:12px">'
            + '<h2 style="color:#E2622A;margin:0 0 10px">' + konu + '</h2>'
            + satirlar.map(([k, v]) => '<div style="margin:2px 0"><b>' + k + ':</b> ' + String(v == null ? '' : v) + '</div>').join('')
            + '<p style="margin-top:14px"><a href="' + panel + '/1453" style="background:#E2622A;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none">Root paneli &gt; Ödeme Bildirimleri</a></p></div>';
        sendMail({ to: alici, subject: '[MDA POS] ' + konu, html }).catch(() => {});
    } catch (_) { /* bildirim yan is */ }
}
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
        `SELECT id, tier, moduller, tutar, durum, aciklama, admin_note, donem_bitis, created_at, islenen_at, odeme_bildirildi_at
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