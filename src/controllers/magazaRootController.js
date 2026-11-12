const A = require('../services/sistemAyar');
const MA = require('../services/magazaAyar');
const MU = require('../services/magazaUrun');
const MS = require('../services/magazaSiparis');
const { sar } = require('./magazaController');

// --- MDA Yazilim Magazasi: ROOT uclari (/api/root/magaza) ---
// rootRoutes icinde protectRoot ARKASINA baglanir (magazaRootRoutes.js). Urun ekle/duzenle/sil,
// resim, siralama, siparis durumu, ic not, fatura isareti ve magaza ayarlari.

const rootAd = (req) => (req.root && (req.root.email || req.root.name)) || 'root';

exports.ozet = sar(async (_req, res) => {
    const a = await MA.oku();
    res.json({ acik: a.acik, ...(await MS.sayilar()) });
});

// --- Urunler ---
exports.urunler = sar(async (_req, res) => res.json(await MU.rootListe()));
exports.urunEkle = sar(async (req, res) => res.status(201).json(await MU.olustur(req.body || {})));
exports.urunGuncelle = sar(async (req, res) => res.json(await MU.guncelle(req.params.id, req.body || {})));
exports.urunSil = sar(async (req, res) => res.json(await MU.sil(req.params.id)));
exports.urunSirala = sar(async (req, res) => res.json(await MU.sirala((req.body || {}).sira)));

// --- Resimler (tek istekte tek resim: istemci kucultup data URL gonderir) ---
exports.resimEkle = sar(async (req, res) => res.status(201).json(await MU.resimEkle(req.params.id, (req.body || {}).veri)));
exports.resimSil = sar(async (req, res) => res.json(await MU.resimSil(req.params.id, req.params.resimId)));
exports.resimSirala = sar(async (req, res) => res.json(await MU.resimSirala(req.params.id, (req.body || {}).sira)));
exports.resimKapak = sar(async (req, res) => res.json(await MU.resimKapak(req.params.id, req.params.resimId)));

// --- Siparisler ---
exports.siparisler = sar(async (req, res) => {
    res.json(await MS.rootListe({ filtre: String(req.query.filtre || ''), limit: req.query.limit }));
});

exports.siparis = sar(async (req, res) => {
    const s = await MS.rootAyrinti(req.params.id);
    if (!s) return res.status(404).json({ message: 'Sipariş bulunamadı.' });
    res.json(s);
});

exports.siparisDurum = sar(async (req, res) => {
    const g = req.body || {};
    await MS.durumDegistir({ id: req.params.id, hedef: String(g.durum || ''), govde: g, rootAd: rootAd(req) });
    res.json(await MS.rootAyrinti(req.params.id));
});

exports.siparisGuncelle = sar(async (req, res) => {
    await MS.rootGuncelle({ id: req.params.id, govde: req.body || {}, rootAd: rootAd(req) });
    res.json(await MS.rootAyrinti(req.params.id));
});

// --- Ayarlar ---
async function ayarYaniti() {
    const a = await MA.oku();
    return {
        acik: a.acik,                          // isletmelere gorunen durum (satici bilgisi eksikse kapali)
        acikAyar: a.acikAyar,                  // root'un isaretledigi durum
        satici: a.satici,
        saticiEksik: a.saticiEksik,
        kargoUcretKurus: a.kargoUcretKurus,
        kargoEsikKurus: a.kargoEsikKurus,
        otomatikIptalGun: a.otomatikIptalGun,
        satisKosullari: a.kosullarHam,          // duzenlenen govde (jetonlu); satici bilgisi ayrica eklenir
        kosullarOnizleme: a.kosullarMetni,      // isletmenin gordugu ve onayladigi tam metin
        kosullarVarsayilan: a.kosullarVarsayilan,
        kosullarSurum: a.kosullarSurum,
        varsayilanKosullar: MA.VARSAYILAN_KOSULLAR,
        bildirimEposta: await A.oku('bildirim_eposta', ''),
        odeme: await MA.odemeBilgisi(),        // salt okunur: Paketler ve Fiyatlar sekmesinden duzenlenir
    };
}

exports.ayarlar = sar(async (_req, res) => res.json(await ayarYaniti()));
exports.ayarGuncelle = sar(async (req, res) => {
    await MA.guncelle(req.body || {});
    res.json(await ayarYaniti());
});
