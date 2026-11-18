const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const Oz = require('../services/yonetimOzet');
const YG = require('../services/yonetimGunlugu');
const YA = require('../services/yonetimAyar');
const D = require('../services/duyuru');

// --- Root paneli: Genel Bakis, Isletme Ayrintisi, Sistem Ayarlari, Duyurular, Yonetim Gunlugu ---
// Uclar /api/root/yonetim altinda, protectRoot ARKASINDA (rootRoutes.js tek satir). Her degisiklik yonetim
// gunlugune yazilir (services/yonetimGunlugu.js).

// 4xx hatalari sunucu gunlugunu kirletmeden cevaplanir; digerleri genel hata yakalayiciya gider.
const sar = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
        if (e.status && e.status < 500) return res.status(e.status).json({ message: e.message, ...(e.code ? { code: e.code } : {}) });
        throw e;
    }
};
function hata(status, message) { const e = new Error(message); e.status = status; return e; }

// --- A. Genel Bakis ---
exports.genelBakis = sar(async (_req, res) => res.json(await Oz.genelBakis()));

// --- B. Isletme ayrintisi ---
exports.isletme = sar(async (req, res) => {
    const d = await Oz.isletmeAyrinti(String(req.params.id || ''));
    if (!d) throw hata(404, 'İşletme bulunamadı.');
    res.json(d);
});

async function isletmeVar(id) {
    const t = (await query('SELECT id, business_name FROM tenants WHERE id = ?', [String(id || '')])).rows[0];
    if (!t) throw hata(404, 'İşletme bulunamadı.');
    return t;
}

// Ic notlar: yalniz root gorur. Silme yumusak (silindi_at).
exports.notEkle = sar(async (req, res) => {
    const t = await isletmeVar(req.params.id);
    const metin = String((req.body || {}).metin || '').trim();
    if (metin.length < 2) throw hata(400, 'Not boş olamaz.');
    if (metin.length > 1000) throw hata(400, 'Not en fazla 1000 karakter olabilir.');
    const id = uuidv4();
    await query('INSERT INTO isletme_notlari (id, tenant_id, metin, root_id, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [id, t.id, metin, req.root.id]);
    await YG.kaydet(req, { islem: 'isletme_notu', tenantId: t.id, hedefTur: 'not', hedefId: id,
        ozet: 'İç not eklendi: ' + (metin.length > 120 ? metin.slice(0, 117) + '...' : metin) });
    const n = (await query('SELECT id, metin, created_at FROM isletme_notlari WHERE id = ?', [id])).rows[0];
    res.status(201).json({ ...n, yazan: req.root.email || null });
});

exports.notSil = sar(async (req, res) => {
    const t = await isletmeVar(req.params.id);
    const n = (await query('SELECT id, metin FROM isletme_notlari WHERE id = ? AND tenant_id = ? AND silindi_at IS NULL',
        [String(req.params.notId || ''), t.id])).rows[0];
    if (!n) throw hata(404, 'Not bulunamadı.');
    await query('UPDATE isletme_notlari SET silindi_at = CURRENT_TIMESTAMP WHERE id = ?', [n.id]);
    await YG.kaydet(req, { islem: 'isletme_notu', tenantId: t.id, hedefTur: 'not', hedefId: n.id,
        ozet: 'İç not silindi: ' + (n.metin.length > 120 ? n.metin.slice(0, 117) + '...' : n.metin), ayrinti: { metin: n.metin } });
    res.json({ ok: true });
});

// Indirim orani (kiraci indirimi: lisans tekliflerinde toplamdan dusulur, services/lisansFiyat.js)
exports.indirim = sar(async (req, res) => {
    const t = await isletmeVar(req.params.id);
    const ham = (req.body || {}).oran;
    const oran = Number(ham);
    if (ham === '' || ham == null || !Number.isInteger(oran) || oran < 0 || oran > 100) throw hata(400, 'İndirim oranı 0 ile 100 arasında tam sayı olmalı.');
    const once = await YG.isletmeAnlik(t.id);
    await query('UPDATE tenants SET discount_rate = ? WHERE id = ?', [oran, t.id]);
    await YG.isletmeFarki(req, t.id, once, { islem: 'indirim' });
    res.json({ ok: true, indirimOrani: oran, message: `${t.business_name}: indirim oranı %${oran}.` });
});

// Eski musteri hakki (services/gecisHaklari.js): root isletme bazinda kaldirir; bir sonraki onayda korunmaz.
exports.eskiHakKaldir = sar(async (req, res) => {
    const t = await isletmeVar(req.params.id);
    const GH = require('../services/gecisHaklari');
    const s = await GH.bilgi(t.id);
    if (!s) throw hata(404, 'Bu işletmenin geçiş öncesi hak kaydı yok.');
    if (s.kaldirildi) throw hata(409, 'Eski haklar zaten kaldırılmış.');
    const { degisti } = await GH.kaldir(t.id, req.root && (req.root.email || req.root.id));
    if (!degisti) throw hata(409, 'Eski haklar zaten kaldırılmış.');
    await YG.kaydet(req, { islem: 'eski_hak_kaldir', tenantId: t.id, hedefTur: 'isletme', hedefId: t.id,
        ozet: `${t.business_name}: eski müşteri hakları kaldırıldı (${s.hakAdlari.join(', ') || 'boş'}). Sonraki onaylarda korunmaz.`,
        ayrinti: { hak: s.hak } });
    res.json({ ok: true, message: `${t.business_name}: eski müşteri hakları kaldırıldı.` });
});

// Ek sure tanimi (rakipten gecis): yalniz onayli odemesi olan isletmeye (services/ekSure.js; 409 EK_SURE_ODEME_YOK)
exports.ekSure = sar(async (req, res) => {
    const b = req.body || {};
    const s = await require('../services/ekSure').tanimla({ tenantId: String(req.params.id || ''), gun: b.gun, not: b.not, root: req.root, req });
    res.json({ ok: true, ...s, message: `${s.isletme}: ${s.gun} gün ek süre tanımlandı. Yeni bitiş ${new Date(s.yeniBitis).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' })}.` });
});

// --- C. Sistem Ayarlari ---
exports.ayarlar = sar(async (_req, res) => res.json(await YA.hepsi()));
exports.ayarYaz = sar(async (req, res) => {
    const degisen = await YA.yaz(req.body || {});
    await YG.ayarFarki(req, degisen);
    res.json({ ...(await YA.hepsi()), degisen: degisen.map((d) => d.anahtar) });
});

// --- D. Duyurular ---
exports.duyurular = sar(async (_req, res) => {
    res.json({ duyurular: await D.liste(), hedefler: D.HEDEFLER, kimler: D.KIMLER });
});
const dOzet = (d) => `"${d.baslik}" (${d.aktif ? 'aktif' : 'pasif'}, ${d.hedefAd}${d.baslangic || d.bitis ? `, ${d.baslangic || '...'} / ${d.bitis || '...'}` : ''})`;
exports.duyuruEkle = sar(async (req, res) => {
    const d = await D.olustur(req.body || {});
    await YG.kaydet(req, { islem: 'duyuru', hedefTur: 'duyuru', hedefId: d.id, ozet: 'Duyuru eklendi: ' + dOzet(d), ayrinti: { duyuru: d } });
    res.status(201).json(d);
});
exports.duyuruGuncelle = sar(async (req, res) => {
    const { once, sonra } = await D.guncelle(req.params.id, req.body || {});
    const alanlar = ['baslik', 'metin', 'baglanti', 'baglantiMetni', 'hedef', 'kimler', 'baslangic', 'bitis', 'aktif'];
    const f = alanlar.filter((k) => String(once[k]) !== String(sonra[k]));
    if (f.length) {
        const ad = { baslik: 'başlık', metin: 'metin', baglanti: 'bağlantı', baglantiMetni: 'bağlantı metni', hedef: 'hedef',
            kimler: 'görecekler', baslangic: 'başlangıç', bitis: 'bitiş', aktif: 'durum' };
        const aktiflik = f.includes('aktif') ? (sonra.aktif ? 'yayına alındı' : 'pasife alındı') : null;
        await YG.kaydet(req, {
            islem: 'duyuru', hedefTur: 'duyuru', hedefId: sonra.id,
            ozet: `Duyuru ${aktiflik || 'güncellendi'}: "${sonra.baslik}"` + (f.filter((k) => k !== 'aktif').length
                ? ` (${f.filter((k) => k !== 'aktif').map((k) => ad[k]).join(', ')})` : ''),
            ayrinti: { degisiklikler: f.map((k) => ({ alan: k, once: once[k], sonra: sonra[k] })) },
        });
    } else { req._yonetimGunluguYazildi = true; }
    res.json(sonra);
});
exports.duyuruSil = sar(async (req, res) => {
    const d = await D.sil(req.params.id);
    await YG.kaydet(req, { islem: 'duyuru', hedefTur: 'duyuru', hedefId: d.id, ozet: 'Duyuru silindi: ' + dOzet(d), ayrinti: { duyuru: d } });
    res.json({ ok: true });
});

// --- E. Yonetim Gunlugu ---
exports.gunluk = sar(async (req, res) => {
    const q = req.query || {};
    const sonuc = await YG.liste({ baslangic: q.baslangic, bitis: q.bitis, islem: q.islem, tenantId: q.tenantId, limit: q.limit, onceId: q.onceId });
    res.json({ ...sonuc, islemler: YG.ISLEM_AD });
});
