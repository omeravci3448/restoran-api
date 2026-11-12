const jwt = require('jsonwebtoken');
const D = require('../services/destekOturumu');
const YG = require('../services/yonetimGunlugu');

// --- Destek Oturumu uclari ---
// Root tarafi (/api/root/yonetim/destek, protectRoot arkasinda): ac, liste, kapat.
// Isletme tarafi (/api/destek): giris jetonunu JWT'ye cevir (acik uc), oturum bilgisi ve kapat (destek JWT'si).
// Tasarim notlari: services/destekOturumu.js

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const sar = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) {
        if (e.status && e.status < 500) return res.status(e.status).json({ message: e.message, ...(e.code ? { code: e.code } : {}) });
        throw e;
    }
};

// --- Root ---
exports.ac = sar(async (req, res) => {
    const b = req.body || {};
    const o = await D.ac({ tenantId: b.tenantId, sebep: b.sebep, rootId: req.root.id });
    await YG.kaydet(req, {
        islem: 'destek_ac', tenantId: o.isletme.id, hedefTur: 'destek_oturumu', hedefId: o.id,
        ozet: `Destek oturumu açıldı (${o.sureDk} dk)` + (String(b.sebep || '').trim() ? `: ${String(b.sebep).trim().slice(0, 200)}` : '')
            + (o.kapatilanEski ? '; aynı işletmede açık kalan önceki oturum kapatıldı' : ''),
        ayrinti: { sureDk: o.sureDk, sebep: String(b.sebep || '').trim().slice(0, 200) || null },
    });
    // Jeton YALNIZ bu cevapta doner; veritabaninda ozeti durur
    res.status(201).json(o);
});

exports.liste = sar(async (req, res) => {
    const q = req.query || {};
    res.json(await D.liste({ durum: q.durum === 'acik' ? 'acik' : null, tenantId: q.tenantId || null, limit: q.limit }));
});

exports.kapatRoot = sar(async (req, res) => {
    const r = await D.kapat(req.params.id, 'ROOT_KAPATTI');
    if (!r.oturum) return res.status(404).json({ message: 'Oturum bulunamadı.' });
    if (!r.kapandi) {
        req._yonetimGunluguYazildi = true;
        return res.status(409).json({ message: 'Bu oturum zaten kapalı.', oturum: D.bicimle(r.oturum) });
    }
    await YG.kaydet(req, { islem: 'destek_kapat', tenantId: r.oturum.tenant_id, hedefTur: 'destek_oturumu', hedefId: r.oturum.id,
        ozet: 'Destek oturumu yönetim panelinden kapatıldı' });
    res.json({ ok: true, oturum: D.bicimle(r.oturum) });
});

// --- Isletme tarafi ---
// Acik uc: tek kullanimlik jeton -> destek JWT'si
exports.giris = sar(async (req, res) => {
    res.json(await D.girisJetonu(req.params.jeton));
});

// Destek JWT'si dogrulayici: lisans kapisindan GECMEZ (salt-okunur ya da kapali lisansta da serit oturumu
// gosterip kapatabilsin). Yalniz destek jetonunu kabul eder; isletme kullanicisinin jetonu 403.
exports.destekKimligi = sar(async (req, res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Token gerekli.' });
    let p;
    try { p = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ code: 'DESTEK_OTURUMU_BITTI', message: 'Destek oturumu sona erdi.' }); }
    if (!p.destek || !p.destek.oturumId) return res.status(403).json({ message: 'Bu uç yalnız destek oturumunda kullanılır.' });
    req.destekJeton = p;
    next();
});

exports.oturum = sar(async (req, res) => {
    const k = await D.kimlik(req.destekJeton);
    if (k.hata) return res.status(k.hata.status).json(k.hata.body);
    const bitis = k.u.destek.bitis;
    res.json({
        id: k.u.destek.oturumId, isletme: k.u.business_name, tenantId: k.u.tenant_id, baslangic: k.u.destek.baslangic, bitis,
        kalanSn: Math.max(0, Math.floor((new Date(bitis).getTime() - Date.now()) / 1000)),
    });
});

exports.kapat = sar(async (req, res) => {
    const id = req.destekJeton.destek.oturumId;
    const r = await D.kapat(id, 'DESTEK_KAPATTI');
    if (r.kapandi && r.oturum) {
        // Yonetim gunlugu: kapatan root (oturumu acan); istek root jetonuyla gelmedigi icin oturumdaki root_id yazilir
        await YG.kaydet({ root: r.oturum.root_id ? { id: r.oturum.root_id } : null }, {
            islem: 'destek_kapat', tenantId: r.oturum.tenant_id, hedefTur: 'destek_oturumu', hedefId: id,
            ozet: `Destek oturumu kapatıldı (destek şeridinden; ${Number(r.oturum.islem_sayisi || 0)} değişiklik)`,
        });
    }
    res.json({ ok: true, zatenKapali: !r.kapandi });
});
