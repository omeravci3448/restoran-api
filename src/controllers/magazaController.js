const { query } = require('../config/db');
const MA = require('../services/magazaAyar');
const MU = require('../services/magazaUrun');
const MS = require('../services/magazaSiparis');

// --- MDA Yazilim Magazasi: ISLETME uclari (/api/magaza) ---
// Yalniz OWNER/MANAGER (deneme hesaplari dahil); /durum disindaki uclar yonetici sifresi ister
// (kasada sahibin oturumu acik kalsa bile kasiyer siparis veremesin, fatura bilgisi goremesin).
// Magaza kapaliyken urun/sepet/siparis-olusturma uclari 403 MAGAZA_KAPALI doner; mevcut
// siparisler izlenmeye, odenmeye ve iptal edilmeye devam eder.
// Fatura bilgileri (unvan, vergi/TC no) siparis olustururken alinir ama bu uclardan HIC geri donmez.

// Hata nesnesi -> JSON (code + ek alanlar). 5xx'ler genel hata yakalayiciya gider.
const sar = (fn) => async (req, res, next) => {
    try { await fn(req, res); }
    catch (e) {
        if (e && e.status && e.status < 500) {
            return res.status(e.status).json({ message: e.message, code: e.code, ...(e.ek || {}) });
        }
        next(e);
    }
};
exports.sar = sar;

const kullanici = (req) => ({ id: req.user.id, ad: req.user.name || req.user.email || null });

exports.magazaAcik = async (req, res, next) => {
    try {
        const a = await MA.oku();
        if (!a.acik) return res.status(403).json({ code: 'MAGAZA_KAPALI', message: 'Mağaza şu anda yeni siparişlere kapalı.' });
        req.magazaAyar = a;
        next();
    } catch (e) { next(e); }
};

// Kenar cubugu: magaza acik mi, izlenecek siparis var mi (kapaliyken de siparislerim gorunsun)
exports.durum = sar(async (req, res) => {
    const a = await MA.oku();
    res.json({ acik: a.acik, aktifSiparis: await MS.aktifSayisi(req.user.tenantId) });
});

exports.urunler = sar(async (req, res) => {
    const a = req.magazaAyar;
    res.json({ ...(await MU.isletmeListe()), kargo: { ucretKurus: a.kargoUcretKurus, esikKurus: a.kargoEsikKurus } });
});

exports.urun = sar(async (req, res) => {
    const u = await MU.isletmeDetay(req.params.id);
    if (!u) return res.status(404).json({ message: 'Ürün bulunamadı ya da satışta değil.' });
    res.json(u);
});

// Sepet hesabi: istemci yalniz { urunId, adet } gonderir; fiyat, KDV, kargo burada hesaplanir.
exports.sepet = sar(async (req, res) => {
    const kalemler = (req.body || {}).kalemler;
    const kargoAyar = MA.kargoAyari(req.magazaAyar);
    if (Array.isArray(kalemler) && !kalemler.length) {
        return res.json({ kalemler: [], sorunlar: [], araToplamKurus: 0, kdvKurus: 0, kargoKurus: 0, genelToplamKurus: 0,
                          kargo: { kargoKurus: 0, ucretsiz: false, sebep: 'BOS', eksikKurus: null } });
    }
    res.json(await MS.sepetCoz(kalemler, { siki: false, kargoAyar }));
});

// Siparis tamamlama ekrani: teslimat ve fatura on dolgu, satis kosullari, odeme yontemleri.
// Teslimat: son siparisteki teslimat, yoksa isletme bilgisi. Fatura: isletmenin Ayarlar'daki fatura
// bilgisi (isletmenin zaten gordugu alanlar); onceki siparisin fatura bilgisi BURADAN DONMEZ.
exports.hazirlik = sar(async (req, res) => {
    const a = req.magazaAyar;
    const t = (await query(
        `SELECT business_name, phone, address, billing_name, billing_address, billing_tax_id, billing_tax_office
           FROM tenants WHERE id = ?`, [req.user.tenantId])).rows[0] || {};
    const son = (await query(
        `SELECT teslimat_alici, teslimat_telefon, teslimat_adres FROM magaza_siparisler
          WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`, [req.user.tenantId])).rows[0];
    const vergi = String(t.billing_tax_id || '').replace(/\D/g, '');
    const odeme = await MA.odemeBilgisi();
    res.json({
        teslimat: son
            ? { alici: son.teslimat_alici || '', telefon: son.teslimat_telefon || '', adres: son.teslimat_adres || '' }
            : { alici: t.business_name || '', telefon: t.phone || '', adres: t.address || '' },
        fatura: {
            tip: vergi.length === 11 ? 'SAHIS' : 'KURUMSAL',
            unvan: t.billing_name || t.business_name || '', vergiDairesi: t.billing_tax_office || '',
            vergiNo: vergi.length === 10 ? vergi : '', tcKimlikNo: vergi.length === 11 ? vergi : '',
            adres: t.billing_address || '',
        },
        kosullar: { metin: a.kosullarMetni, surum: a.kosullarSurum },
        kargo: { ucretKurus: a.kargoUcretKurus, esikKurus: a.kargoEsikKurus },
        odemeYontemleri: Object.entries(MS.ODEME_YONTEMLERI).filter(([, v]) => v.acik).map(([kod, v]) => ({ kod, ad: v.ad })),
        odemeHazir: !!odeme.iban,
    });
});

exports.siparisOlustur = sar(async (req, res) => {
    // Ayni istek anahtariyla ikinci gonderim (cift tiklama, ag tekrari): yeni siparis acilmaz, ilk siparis 200 ile doner
    const r = await MS.siparisOlustur({ tenantId: req.user.tenantId, kullanici: kullanici(req), govde: req.body });
    res.status(r.tekrar ? 200 : 201).json({ ...(await MS.isletmeAyrinti(r.id, req.user.tenantId)), tekrar: !!r.tekrar });
});

exports.siparisler = sar(async (req, res) => {
    res.json(await MS.isletmeListe(req.user.tenantId));
});

exports.siparis = sar(async (req, res) => {
    const s = await MS.isletmeAyrinti(req.params.id, req.user.tenantId);
    if (!s) return res.status(404).json({ message: 'Sipariş bulunamadı.' });
    res.json(s);
});

exports.odemeBildir = sar(async (req, res) => {
    await MS.odemeBildir({ id: req.params.id, tenantId: req.user.tenantId, kullanici: kullanici(req),
                           referans: (req.body || {}).referans });
    res.json(await MS.isletmeAyrinti(req.params.id, req.user.tenantId));
});

exports.iptal = sar(async (req, res) => {
    await MS.isletmeIptal({ id: req.params.id, tenantId: req.user.tenantId, kullanici: kullanici(req),
                            sebep: (req.body || {}).sebep });
    res.json(await MS.isletmeAyrinti(req.params.id, req.user.tenantId));
});
