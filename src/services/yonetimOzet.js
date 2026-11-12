const { query } = require('../config/db');
const L = require('./lisansDurumu');
const M = require('./lisansModul');

// --- Root paneli: Genel Bakis ve Isletme Ayrintisi ---
//
// ISLETME SINIFI (tek yer; genel bakis, isletme listesi ve duyuru hedeflemesi bunu kullanir):
//   odemeli : onayli havale/EFT odemesi ya da islenmis SofraMix POS odemesi var, ya da paket TIER_MUSTERI
//             (root denemeyi elle uzatti) / TIER_SOFRAMIX. Kayit formundan gelip (masa kademesi) lisansi
//             deneme suresinden belirgin uzun olan da odemelidir (root elle uzatmis demektir).
//   deneme  : odemesiz; TIER_DENEME ya da kayit formundan gelen kademe paketi (lisans suresi deneme kadar)
//   kurum   : odemesiz geri kalan (TIER_KURUM belediye isletmeleri, suresiz lisanslar)
// Durum lisans makinesinden (lisansDurumu.hesapla): AKTIF | SALT_OKUNUR | KAPALI; is_active = 0 da KAPALI sayilir.
//
// CIRO GOSTERILMEZ: isletmenin satis tutarlari onun ticari bilgisi. Kullanim ozetinde yalniz ADET var.

const OZEL_TIER_AD = {
    TIER_DENEME: 'Deneme', TIER_KURUM: 'Kurum lisansı', TIER_MUSTERI: 'Müşteri (elle uzatıldı)', TIER_SOFRAMIX: 'SofraMix POS paketi',
};

// Isletme satirina eklenen odeme sayaclari (t = tenants takma adi)
const ODEME_ALANLARI = `
    (SELECT COUNT(*) FROM lisans_odemeleri o WHERE o.tenant_id = t.id AND o.durum = 'onaylandi') AS havale_adedi,
    (SELECT COUNT(*) FROM pos_provizyon v WHERE v.tenant_id = t.id AND v.durum = 'islendi') AS provizyon_adedi`;

async function katalogTierleri() {
    const r = await query("SELECT kod, ad FROM lisans_katalog WHERE tur = 'TIER'");
    return new Map(r.rows.map((x) => [x.kod, x.ad]));
}
function tierAdi(tierler, kod) {
    if (!kod) return '-';
    return OZEL_TIER_AD[kod] || (tierler && tierler.get(kod)) || kod;
}

const tarihCoz = (s) => {
    if (!s) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
    return isNaN(d.getTime()) ? null : d;
};

// t: { license_tier, license_end_date, created_at, havale_adedi, provizyon_adedi }
// tierler: katalog paket kodlari (Map ya da Set); esikGun: kayit formu denemesinin en uzun suresi
function sinifla(t, tierler, esikGun) {
    const tier = t.license_tier || '';
    if (Number(t.havale_adedi || 0) + Number(t.provizyon_adedi || 0) > 0) return 'odemeli';
    if (tier === 'TIER_MUSTERI' || tier === 'TIER_SOFRAMIX') return 'odemeli';
    if (tier === 'TIER_DENEME') return 'deneme';
    if (tierler && tierler.has(tier)) {
        const c = tarihCoz(t.created_at), b = tarihCoz(t.license_end_date);
        if (!c || !b) return 'kurum';
        return (b.getTime() - c.getTime()) / 86400000 <= esikGun ? 'deneme' : 'odemeli';
    }
    return 'kurum';
}
function esikGunu() {
    return Math.max(31, require('./yonetimAyar').denemeGun() + 7);
}

// Lisans durumu + isletme acik mi: AKTIF | SALT_OKUNUR | KAPALI
function durumu(t) {
    const d = L.hesapla(t.license_end_date);
    return { durum: Number(t.is_active) ? d.durum : L.DURUM.KAPALI, lisansDurum: d.durum, kalanGun: d.kalanGun };
}

// Istanbul gunu / ay / yil baslangici (ISO, UTC). Turkiye yaz saati uygulamiyor: +03:00 sabit.
function istanbulParcalari(simdi = new Date()) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(simdi).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
    return { yil: p.year, ay: p.month, gun: p.day, bugun: `${p.year}-${p.month}-${p.day}` };
}
function donemBaslangiclari(simdi = new Date()) {
    const p = istanbulParcalari(simdi);
    return {
        ay: new Date(`${p.yil}-${p.ay}-01T00:00:00+03:00`).toISOString(),
        yil: new Date(`${p.yil}-01-01T00:00:00+03:00`).toISOString(),
        bugun: p.bugun,
    };
}

// Magaza (ayri klonda yazildi, birlestirmeden sonra gelecek): tablo varsa okunur, yoksa null.
let magazaOnbellek = { var: null, zaman: 0 };
async function magazaVarMi() {
    if (Date.now() - magazaOnbellek.zaman < 60000 && magazaOnbellek.var !== null) return magazaOnbellek.var;
    try {
        const r = await query("SELECT 1 AS v FROM sqlite_master WHERE type = 'table' AND name = 'magaza_siparisler'");
        magazaOnbellek = { var: r.rows.length > 0, zaman: Date.now() };
    } catch (_) { magazaOnbellek = { var: false, zaman: Date.now() }; }
    return magazaOnbellek.var;
}

// Butun isletmeler + sinif + durum (genel bakis ve duyuru hedefleme icin)
async function isletmeler() {
    const r = await query(
        `SELECT t.id, t.business_name, t.business_code, t.phone, t.owner_email, t.parent_org, t.license_tier,
                t.license_modules, t.license_end_date, t.is_active, t.created_at, t.kvkk_consent_at,
                (SELECT 1 FROM deneme_kayitlari d WHERE d.tenant_id = t.id LIMIT 1) AS deneme_kaydi,
                ${ODEME_ALANLARI}
           FROM tenants t`);
    const tierler = await katalogTierleri();
    const esik = esikGunu();
    return {
        tierler,
        liste: r.rows.map((t) => ({ ...t, sinif: sinifla(t, tierler, esik), ...durumu(t) })),
    };
}

async function tek(sql, p = []) { return (await query(sql, p)).rows[0] || {}; }

async function gelir(baslangic, magaza) {
    const lisans = await tek(`SELECT COALESCE(SUM(tutar), 0) AS t, COUNT(*) AS n FROM lisans_odemeleri
                               WHERE durum = 'onaylandi' AND datetime(islenen_at) >= datetime(?)`, [baslangic]);
    const smx = await tek(`SELECT COALESCE(SUM(tutar_kurus), 0) AS k, COUNT(*) AS n FROM pos_provizyon
                            WHERE durum = 'islendi' AND datetime(onay_tarihi) >= datetime(?)`, [baslangic]);
    const plaka = await tek(`SELECT COALESCE(SUM(tutar), 0) AS t, COUNT(*) AS n FROM plaka_talepleri
                              WHERE tutar > 0 AND odeme_alindi_at IS NOT NULL AND durum NOT IN ('IPTAL', 'REDDEDILDI')
                                AND datetime(odeme_alindi_at) >= datetime(?)`, [baslangic]);
    let mg = null;
    if (magaza) {
        try {
            const x = await tek(`SELECT COALESCE(SUM(genel_toplam_kurus), 0) AS k, COUNT(*) AS n FROM magaza_siparisler
                                  WHERE odeme_alindi_at IS NOT NULL AND durum NOT IN ('IPTAL', 'REDDEDILDI')
                                    AND datetime(odeme_alindi_at) >= datetime(?)`, [baslangic]);
            mg = { tutar: Number(x.k || 0) / 100, adet: Number(x.n || 0) };
        } catch (_) { mg = null; }
    }
    const out = {
        lisans: { tutar: Number(lisans.t || 0), adet: Number(lisans.n || 0) },
        sofraMix: { tutar: Number(smx.k || 0) / 100, adet: Number(smx.n || 0) },
        plaka: { tutar: Number(plaka.t || 0), adet: Number(plaka.n || 0) },
        magaza: mg,
    };
    out.toplam = Math.round((out.lisans.tutar + out.sofraMix.tutar + out.plaka.tutar + (mg ? mg.tutar : 0)) * 100) / 100;
    return out;
}

async function genelBakis() {
    const { liste, tierler } = await isletmeler();
    const simdi = Date.now();
    const gunOnce = (g) => simdi - g * 86400000;
    const olusturma = (t) => { const d = tarihCoz(t.created_at); return d ? d.getTime() : 0; };

    const sayilar = { toplam: liste.length, aktifDeneme: 0, odemeliMusteri: 0, kurumDiger: 0, saltOkunur: 0, kapali: 0, yeni7: 0, yeni30: 0 };
    for (const t of liste) {
        if (t.durum === 'KAPALI') sayilar.kapali++;
        else if (t.durum === 'SALT_OKUNUR') sayilar.saltOkunur++;
        else if (t.sinif === 'deneme') sayilar.aktifDeneme++;
        else if (t.sinif === 'odemeli') sayilar.odemeliMusteri++;
        else sayilar.kurumDiger++;
        if (olusturma(t) >= gunOnce(7)) sayilar.yeni7++;
        if (olusturma(t) >= gunOnce(30)) sayilar.yeni30++;
    }
    // Son 90 gunde denemeyle baslayan isletmeler (deneme kaydi ya da kayit formu) kacinin odemeli musteri oldugu
    const kohort = liste.filter((t) => olusturma(t) >= gunOnce(90) && (t.deneme_kaydi || t.kvkk_consent_at));
    const donusen = kohort.filter((t) => t.sinif === 'odemeli').length;
    sayilar.donusum90 = { deneme: kohort.length, musteri: donusen, oran: kohort.length ? Math.round((donusen / kohort.length) * 1000) / 10 : null };

    const magaza = await magazaVarMi();
    const d = donemBaslangiclari();
    const gelirler = { buAy: await gelir(d.ay, magaza), buYil: await gelir(d.yil, magaza), magazaVar: magaza };

    // Yaklasan bitisler: 30 gun icinde bitecek (AKTIF) + suresi dolmus ama salt-okunur donemde olanlar (en ustte)
    const yaklasan = liste
        .filter((t) => Number(t.is_active) && ((t.lisansDurum === 'AKTIF' && t.kalanGun != null && t.kalanGun <= 30) || t.lisansDurum === 'SALT_OKUNUR'))
        .sort((a, b) => (tarihCoz(a.license_end_date) || 0) - (tarihCoz(b.license_end_date) || 0))
        .map((t) => ({
            id: t.id, ad: t.business_name, kod: t.business_code, bitis: t.license_end_date, kalanGun: t.kalanGun,
            lisansDurum: t.lisansDurum, sinif: t.sinif, tier: t.license_tier, tierAd: tierAdi(tierler, t.license_tier),
            moduller: M.modulListesi(t.license_modules).map((k) => M.AD[k] || k), telefon: t.phone || null,
            kanal: t.parent_org === 'SofraMix' || t.license_tier === 'TIER_SOFRAMIX' ? 'SofraMix' : 'Yerel',
        }));

    const odeme = await tek(`SELECT COUNT(*) AS n, SUM(CASE WHEN odeme_bildirildi_at IS NOT NULL THEN 1 ELSE 0 END) AS b
                               FROM lisans_odemeleri WHERE durum = 'beklemede'`);
    const plaka = await tek(`SELECT SUM(CASE WHEN durum = 'ALINDI' THEN 1 ELSE 0 END) AS yeni,
                                    SUM(CASE WHEN durum = 'ODEME_BEKLENIYOR' AND odeme_bildirildi_at IS NOT NULL THEN 1 ELSE 0 END) AS bildirildi,
                                    SUM(CASE WHEN durum = 'ODEME_ALINDI' THEN 1 ELSE 0 END) AS hazirlanacak
                               FROM plaka_talepleri`);
    const destek = await tek(`SELECT COUNT(*) AS n FROM destek_oturumlari WHERE bitis_at IS NULL
                                 AND ((baslangic_at IS NOT NULL AND planlanan_bitis_at > ?) OR (baslangic_at IS NULL AND jeton_son_at > ?))`,
        [new Date().toISOString(), new Date().toISOString()]);
    const bekleyen = {
        odemeBildirimi: Number(odeme.n || 0), odemeYapildiDenen: Number(odeme.b || 0),
        plakaYeni: Number(plaka.yeni || 0), plakaOdemeBildirildi: Number(plaka.bildirildi || 0), plakaHazirlanacak: Number(plaka.hazirlanacak || 0),
        acikDestek: Number(destek.n || 0),
    };

    // Son hareketler: yonetim gunlugu + root olaylari (yeni kayit, SofraMix paket alimi), en yeni 10
    const yg = await query('SELECT id, created_at, islem, ozet, tenant_id, isletme_adi FROM yonetim_gunlugu ORDER BY id DESC LIMIT 10');
    const ro = await query('SELECT id, created_at, tur, baslik, detay, tenant_id FROM root_olaylar ORDER BY id DESC LIMIT 10');
    const { ISLEM_AD } = require('./yonetimGunlugu');
    const OLAY_AD = { yeni_kayit: 'Yeni restoran kaydı', paket_alindi: 'SofraMix paket alımı' };
    const hareketler = [
        ...yg.rows.map((x) => ({ kaynak: 'yonetim', id: 'y' + x.id, zaman: x.created_at, baslik: ISLEM_AD[x.islem] || x.islem,
            isletme: x.isletme_adi || null, detay: x.ozet, tenantId: x.tenant_id })),
        ...ro.rows.map((x) => ({ kaynak: 'olay', id: 'o' + x.id, zaman: x.created_at, baslik: OLAY_AD[x.tur] || x.tur,
            isletme: x.baslik || null, detay: x.detay, tenantId: x.tenant_id })),
    ].sort((a, b) => (tarihCoz(b.zaman) || 0) - (tarihCoz(a.zaman) || 0)).slice(0, 10);

    return { sayilar, gelir: gelirler, yaklasan, bekleyen, sonHareketler: hareketler, uretildi: new Date().toISOString() };
}

// --- Isletme ayrintisi ---
async function isletmeAyrinti(id) {
    const t = (await query(
        `SELECT t.*, ${ODEME_ALANLARI},
                (SELECT 1 FROM deneme_kayitlari d WHERE d.tenant_id = t.id LIMIT 1) AS deneme_kaydi
           FROM tenants t WHERE t.id = ?`, [id])).rows[0];
    if (!t) return null;
    const tierler = await katalogTierleri();
    const sinif = sinifla(t, tierler, esikGunu());
    const d = durumu(t);
    const moduller = M.modulListesi(t.license_modules);

    let hediye = null;
    try { hediye = await require('./plakaHak').hediyeDurumu(t.id); } catch (_) { hediye = null; }

    const otuzGun = new Date(Date.now() - 30 * 86400000).toISOString();
    const kullanim = {
        aktifMasa: Number((await tek('SELECT COUNT(*) AS n FROM tables WHERE tenant_id = ? AND is_active = 1', [id])).n || 0),
        kullaniciSayisi: Number((await tek('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND is_active = 1', [id])).n || 0),
        sonGiris: (await tek('SELECT MAX(son_giris_at) AS s FROM users WHERE tenant_id = ?', [id])).s || null,
        siparis30: Number((await tek(
            `SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND status != 'CANCELLED' AND COALESCE(is_test, 0) = 0
                AND datetime(opened_at) >= datetime(?)`, [id, otuzGun])).n || 0),
        urunSayisi: Number((await tek('SELECT COUNT(*) AS n FROM products WHERE tenant_id = ? AND is_available = 1', [id])).n || 0),
        kategoriSayisi: Number((await tek('SELECT COUNT(*) AS n FROM categories WHERE tenant_id = ? AND is_active = 1', [id])).n || 0),
    };

    const havale = await query(
        `SELECT id, tur, tier, moduller, tutar, yeni_toplam, kredi_tutari, durum, admin_note, donem_bitis, onay_gun,
                created_at, odeme_bildirildi_at, islenen_at
           FROM lisans_odemeleri WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`, [id]);
    const smx = await query(
        `SELECT odeme_id, tutar_kurus, durum, onay_tarihi, donem_bitis, created_at
           FROM pos_provizyon WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`, [id]);
    const TUR_AD = { ilk: 'İlk alım', yenileme: 'Yenileme', yukseltme: 'Yükseltme' };
    const DURUM_AD = { beklemede: 'Beklemede', onaylandi: 'Onaylandı', reddedildi: 'Reddedildi' };
    const odemeler = [
        ...havale.rows.map((o) => ({
            id: o.id, kaynak: 'Havale/EFT', tur: TUR_AD[o.tur] || 'Lisans', paket: tierAdi(tierler, o.tier),
            moduller: M.modulListesi(o.moduller).map((k) => M.AD[k] || k), tutar: Number(o.tutar || 0),
            kredi: o.kredi_tutari == null ? null : Number(o.kredi_tutari), durum: DURUM_AD[o.durum] || o.durum, durumKod: o.durum,
            tarih: o.islenen_at || o.created_at, talep: o.created_at, odemeBildirildi: o.odeme_bildirildi_at, donemBitis: o.donem_bitis,
            not: o.admin_note || null,
        })),
        ...smx.rows.map((p) => ({
            id: p.odeme_id, kaynak: 'SofraMix', tur: 'POS paketi', paket: null, moduller: [], tutar: Number(p.tutar_kurus || 0) / 100,
            kredi: null, durum: p.durum === 'islendi' ? 'İşlendi' : p.durum, durumKod: p.durum, tarih: p.onay_tarihi || p.created_at,
            talep: p.created_at, odemeBildirildi: null, donemBitis: p.donem_bitis, not: null,
        })),
    ].sort((a, b) => (tarihCoz(b.tarih) || 0) - (tarihCoz(a.tarih) || 0));

    const H = require('./plakaHak');
    const pl = await query(
        `SELECT id, talep_no, durum, hediye_adet, ucretli_adet, tutar, created_at, odeme_alindi_at, kargoya_verildi_at, teslim_at
           FROM plaka_talepleri WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`, [id]);
    const plakalar = pl.rows.map((x) => ({ ...x, durum_ad: H.DURUM_AD[x.durum] || x.durum }));

    let magaza = null;
    if (await magazaVarMi()) {
        try {
            const r = await query(
                `SELECT id, no, durum, genel_toplam_kurus, created_at, odeme_alindi_at FROM magaza_siparisler
                  WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`, [id]);
            magaza = r.rows.map((x) => ({ id: x.id, no: x.no, durum: x.durum, tutar: Number(x.genel_toplam_kurus || 0) / 100,
                tarih: x.created_at, odemeAlindi: x.odeme_alindi_at }));
        } catch (_) { magaza = null; }
    }

    const notlar = (await query(
        `SELECT n.id, n.metin, n.created_at, ru.email AS yazan FROM isletme_notlari n LEFT JOIN root_users ru ON ru.id = n.root_id
          WHERE n.tenant_id = ? AND n.silindi_at IS NULL ORDER BY n.created_at DESC, n.rowid DESC LIMIT 200`, [id])).rows;

    const destek = (await query(
        `SELECT id, sebep, sure_dk, created_at, baslangic_at, planlanan_bitis_at, bitis_at, kapanis_nedeni, islem_sayisi
           FROM destek_oturumlari WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10`, [id])).rows;

    const kanal = t.parent_org === 'SofraMix' || t.license_tier === 'TIER_SOFRAMIX' ? 'SofraMix' : 'Yerel';
    return {
        kimlik: {
            id: t.id, ad: t.business_name, kod: t.business_code, slug: t.slug, sahipEposta: t.owner_email, telefon: t.phone,
            adres: t.address, kayit: t.created_at, kanal, ustKurum: t.parent_org || null,
            fatura: { unvan: t.billing_name || null, vergiDairesi: t.billing_tax_office || null, vergiNo: t.billing_tax_id || null },
            kapanisTalebi: t.closure_requested_at || null,
        },
        lisans: {
            tier: t.license_tier, tierAd: tierAdi(tierler, t.license_tier), moduller, modulAdlari: moduller.map((k) => M.AD[k] || k),
            bitis: t.license_end_date, kalanGun: d.kalanGun, durum: d.durum, lisansDurum: d.lisansDurum, acik: !!Number(t.is_active),
            menuKipi: M.menuKipiMi(moduller), sinif, masaLimiti: t.license_table_limit, indirimOrani: Number(t.discount_rate || 0),
            plakaHediyeHakki: t.plaka_hediye_hakki == null ? null : Number(t.plaka_hediye_hakki), hediye,
        },
        kullanim, odemeler, plakalar, magaza, notlar, destek,
    };
}

module.exports = {
    ODEME_ALANLARI, OZEL_TIER_AD, katalogTierleri, tierAdi, sinifla, esikGunu, durumu, istanbulParcalari, donemBaslangiclari,
    magazaVarMi, isletmeler, genelBakis, isletmeAyrinti, tarihCoz,
};
