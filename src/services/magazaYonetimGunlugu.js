const YG = require('./yonetimGunlugu');

// --- Magaza root yazmalari icin ACIK yonetim gunlugu satiri ---
// rootRoutes'ta magaza router'inin ONUNE baglanir (magaza dosyalarina dokunmadan): her basarili yazma
// (urun, resim, siralama, siparis durumu / ic not / fatura, ayarlar) ne yapildigini soyleyen tek satir yazar.
// Yedek ara katman (yonetimGunlugu.rootAraKatmani) bu isteklerde ikinci, genel bir satir yazmaz: bayrak istek
// basinda konur. Yanit govdesinden (urun adi, siparis no, isletme) ozet cikarilir; resim verisi gibi uzun alanlar
// ayrintiya yazilmaz (YG.temizle).

const NO = (x) => (x && x.no ? 'MG-' + x.no : 'sipariş');
const DURUM_AD = {
    ODEME_BEKLENIYOR: 'Ödeme bekleniyor', ODEME_ALINDI: 'Ödeme alındı', HAZIRLANIYOR: 'Hazırlanıyor',
    KARGODA: 'Kargoya verildi', TESLIM_EDILDI: 'Teslim edildi', IPTAL: 'İptal edildi', REDDEDILDI: 'Reddedildi',
};

// [yontem, desen, (req, govde) => { ozet, hedefTur, hedefId, tenantId, ayrinti }]
const KURALLAR = [
    ['POST', /^\/urunler$/, (req, g) => ({ ozet: `Mağaza ürünü eklendi: ${(g && g.ad) || (req.body && req.body.ad) || ''}`, hedefTur: 'magaza_urun', hedefId: g && g.id, ayrinti: { govde: req.body } })],
    ['POST', /^\/urunler\/sirala$/, () => ({ ozet: 'Mağaza ürün sırası değiştirildi' })],
    ['PUT', /^\/urunler\/([^/]+)$/, (req, g, m) => ({ ozet: `Mağaza ürünü güncellendi: ${(g && g.ad) || m[1]}`, hedefTur: 'magaza_urun', hedefId: m[1], ayrinti: { govde: req.body } })],
    ['DELETE', /^\/urunler\/([^/]+)$/, (req, g, m) => ({ ozet: `Mağaza ürünü silindi${g && g.yumusak ? ' (siparişte geçtiği için gizlendi)' : ''}`, hedefTur: 'magaza_urun', hedefId: m[1] })],
    ['POST', /^\/urunler\/([^/]+)\/resimler$/, (req, g, m) => ({ ozet: 'Mağaza ürününe resim eklendi', hedefTur: 'magaza_urun', hedefId: m[1] })],
    ['POST', /^\/urunler\/([^/]+)\/resimler\/sirala$/, (req, g, m) => ({ ozet: 'Mağaza ürün resimlerinin sırası değiştirildi', hedefTur: 'magaza_urun', hedefId: m[1] })],
    ['POST', /^\/urunler\/([^/]+)\/resimler\/[^/]+\/kapak$/, (req, g, m) => ({ ozet: 'Mağaza ürününün kapak resmi değiştirildi', hedefTur: 'magaza_urun', hedefId: m[1] })],
    ['DELETE', /^\/urunler\/([^/]+)\/resimler\/[^/]+$/, (req, g, m) => ({ ozet: 'Mağaza ürün resmi silindi', hedefTur: 'magaza_urun', hedefId: m[1] })],
    ['POST', /^\/siparisler\/([^/]+)\/durum$/, (req, g, m) => {
        const hedef = String((req.body && req.body.durum) || '');
        const ek = hedef === 'KARGODA' ? ` (${String(req.body.kargoFirma || '').trim()} ${String(req.body.kargoTakipNo || '').trim()})`
            : (hedef === 'REDDEDILDI' && req.body.sebep ? ` - sebep: ${String(req.body.sebep).trim().slice(0, 200)}` : '');
        return { ozet: `Mağaza siparişi ${NO(g)}: ${DURUM_AD[hedef] || hedef}${ek}`, hedefTur: 'magaza_siparis', hedefId: m[1], tenantId: g && g.tenantId };
    }],
    ['PATCH', /^\/siparisler\/([^/]+)$/, (req, g, m) => {
        const b = req.body || {};
        const parca = [];
        if (Object.prototype.hasOwnProperty.call(b, 'icNot')) parca.push('iç not');
        if (Object.prototype.hasOwnProperty.call(b, 'faturaKesildi') || Object.prototype.hasOwnProperty.call(b, 'faturaNo')) parca.push('fatura');
        if (Object.prototype.hasOwnProperty.call(b, 'kargoFirma') || Object.prototype.hasOwnProperty.call(b, 'kargoTakipNo')) parca.push('kargo bilgisi');
        return { ozet: `Mağaza siparişi ${NO(g)} güncellendi${parca.length ? ': ' + parca.join(', ') : ''}`, hedefTur: 'magaza_siparis', hedefId: m[1],
            tenantId: g && g.tenantId, ayrinti: { govde: b } };
    }],
    ['PUT', /^\/ayarlar$/, (req) => ({ ozet: 'Mağaza ayarları güncellendi: ' + (Object.keys(req.body || {}).join(', ') || '-'), ayrinti: { govde: req.body } })],
];

function araKatman(req, res, next) {
    const m = (req.method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
    const yol = String(req.path || '/').split('?')[0];
    let kural = null, eslesme = null;
    for (const k of KURALLAR) {
        if (k[0] !== m) continue;
        const e = yol.match(k[1]);
        if (e) { kural = k; eslesme = e; break; }
    }
    // Bilinmeyen yazma (ileride eklenecek uc): yedek ara katman genel "Mağaza" satirini yazar
    if (!kural) return next();
    req._yonetimGunluguYazildi = true;   // yedek ara katman bu istekte yazmasin
    let govde = null;
    const json = res.json.bind(res);
    res.json = (veri) => { govde = veri; return json(veri); };
    res.on('finish', () => {
        if (!req.root || res.statusCode >= 400) return;
        let o;
        try { o = kural[2](req, govde, eslesme) || {}; } catch (_) { o = { ozet: `${m} /magaza${yol}` }; }
        YG.kaydet(req, { islem: 'magaza', tenantId: o.tenantId || null, hedefTur: o.hedefTur || null, hedefId: o.hedefId || null,
            ozet: o.ozet || `${m} /magaza${yol}`, ayrinti: o.ayrinti || null });
    });
    next();
}

module.exports = { araKatman, KURALLAR };
