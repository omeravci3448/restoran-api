const { iceAktar } = require('../services/menuIceAktar');
const YG = require('../services/yonetimGunlugu');

// POST /api/root/tenants/:id/menu-ice-aktar  { bicim: 'json'|'csv', veri, mod: 'ekle'|'guncelle', onizleme }
// Root kapisi rootRoutes'ta (protectRoot). Onizleme hicbir sey yazmaz ve gunluge dusmez; aktarma yonetim gunlugune yazilir.
exports.menuIceAktar = async (req, res) => {
    const b = req.body || {};
    const onizleme = b.onizleme === true || b.onizleme === 'true' || b.onizleme === 1;
    if (onizleme) req._yonetimGunluguYazildi = true;   // yedek ara katman onizlemeyi kaydetmesin
    const s = await iceAktar({ tenantId: req.params.id, bicim: b.bicim, veri: b.veri, mod: b.mod, onizleme });
    if (s.kod === 200 && !onizleme) {
        const n = s.govde.sayilar;
        await YG.kaydet(req, {
            islem: 'menu_ice_aktar', tenantId: req.params.id,
            ozet: `Menü içe aktarıldı (${String(b.bicim).toUpperCase()}, ${s.govde.mod === 'guncelle' ? 'güncelle' : 'ekle'}): `
                + `${n.kategoriYeni} yeni kategori, ${n.urunYeni} yeni ürün, ${n.urunGuncellenen} güncellenen, ${n.urunAtlanan} atlanan`
                + (n.fiyatsizPasif ? `, ${n.fiyatsizPasif} fiyatsız ürün pasif` : ''),
            ayrinti: {
                bicim: b.bicim, mod: s.govde.mod, sayilar: n,
                guncellenen: s.govde.guncellenen.slice(0, 50).map((g) => ({ ad: g.ad, kategori: g.kategori, eskiFiyat: g.eskiFiyat, yeniFiyat: g.yeniFiyat })),
            },
        });
    }
    res.status(s.kod).json(s.govde);
};
