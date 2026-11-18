const { query } = require('../config/db');
const { PAKET, istanbulGunu } = require('./paketServis');
const L = require('./lisansDurumu');

// --- Sube grubu ozeti (grup yoneticisi ana ekrani) ---
// Her sube icin ve toplamda: ciro, kasaya giren (tahsilat, odeme yontemine gore), adisyon sayisi, ortalama adisyon,
// paket servis (telefon + pazaryeri), masa siparisi, su an acik adisyonlar, lisans durumu, son islem zamani.
//
// TANIMLAR Raporlar sayfasiyla (controllers/reportController.js daySummary / monthSummary) AYNI:
//  - Ciro / adisyon: status = 'CLOSED' siparislerin total toplami / adedi, kapanis zamanina (closed_at) gore.
//  - Masa siparisi = channel 'DINE_IN'; telefon paketi = 'PAKET_SERVIS'; pazaryeri = channel NOT IN (ikisi)
//    (raporun dine_in_revenue / paket_revenue / marketplace_revenue ayrimi). Paket servis = telefon + pazaryeri.
//  - Tahsilat: donemde KAPANAN siparislerin payments kayitlari, yontemine gore (raporun byPayment'i).
//    nakit = NAKIT, kart = KREDI_KARTI, diger = geri kalan her yontem (yemek karti, havale, online...).
// TEK FARK: gun siniri. Raporlar UTC takvim gunu kullanir (substr(closed_at, 1, 10)); grup ozeti Istanbul takvim
// gunu kullanir (00:00-24:00 Turkiye saati). Gun ortasindaki satislar iki ekranda ayni; 00:00-03:00 (Turkiye)
// arasinda kapanan siparis raporda bir onceki gune, burada kendi gunune yazilir.
// Yalniz TOPLAM rakamlar: musteri adi / telefon / adres hic okunmaz.

const EN_COK_GUN = 93;
const GUN_RE = /^\d{4}-\d{2}-\d{2}$/;

function hata(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

// Istanbul gununun basi (dahil), SQLite CURRENT_TIMESTAMP biciminde UTC metin. Turkiye 2016'dan beri sabit UTC+3.
function gunBasiUtc(gun) {
    return new Date(Date.parse(`${gun}T00:00:00+03:00`)).toISOString().slice(0, 19).replace('T', ' ');
}
function gunEkle(gun, n) {
    return new Date(Date.parse(`${gun}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
function gecerliGun(g) {
    if (!GUN_RE.test(g)) return false;
    const d = new Date(`${g}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === g;
}

// ?bas=YYYY-MM-DD&bit=YYYY-MM-DD (Istanbul gunleri, ikisi de dahil). Bos: bugun.
function donemCoz(basHam, bitHam, simdi = new Date()) {
    const bugun = istanbulGunu(simdi);
    const bas = String(basHam || '').trim() || bugun;
    const bit = String(bitHam || '').trim() || bas;
    if (!gecerliGun(bas) || !gecerliGun(bit)) throw hata(400, 'Tarih biçimi geçersiz (YYYY-AA-GG).');
    if (bit < bas) throw hata(400, 'Bitiş tarihi başlangıçtan önce olamaz.');
    const gunSayisi = Math.round((Date.parse(`${bit}T00:00:00Z`) - Date.parse(`${bas}T00:00:00Z`)) / 86400000) + 1;
    if (gunSayisi > EN_COK_GUN) throw hata(400, `En fazla ${EN_COK_GUN} günlük bir aralık seçebilirsiniz.`);
    return { bas, bit, gunSayisi, basUtc: gunBasiUtc(bas), bitUtc: gunBasiUtc(gunEkle(bit, 1)), saatDilimi: 'Europe/Istanbul' };
}

const yuvarla = (n) => Math.round(Number(n || 0) * 100) / 100;
// SQLite UTC metni -> ISO (Z ekli). Zaten ISO ise oldugu gibi.
function isoZaman(s) {
    if (!s) return null;
    const m = String(s);
    const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(m) ? m : m.replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function bosMetrik() {
    return {
        ciro: 0, adisyon: 0, ortalamaAdisyon: 0,
        tahsilat: { nakit: 0, kart: 0, diger: 0, toplam: 0, yontemler: [] },
        paket: { adet: 0, tutar: 0, telefon: { adet: 0, tutar: 0 }, pazaryeri: { adet: 0, tutar: 0 } },
        masa: { adet: 0, tutar: 0 },
        acikHesap: { adet: 0, tutar: 0 },
    };
}
function yontemEkle(t, yontem, adet, tutar) {
    const a = Number(adet || 0), v = Number(tutar || 0);
    if (yontem === 'NAKIT') t.nakit += v; else if (yontem === 'KREDI_KARTI') t.kart += v; else t.diger += v;
    t.toplam += v;
    const x = t.yontemler.find((y) => y.yontem === yontem);
    if (x) { x.adet += a; x.tutar += v; } else t.yontemler.push({ yontem, adet: a, tutar: v });
}
function topla(hedef, m) {
    hedef.ciro += m.ciro; hedef.adisyon += m.adisyon;
    for (const y of m.tahsilat.yontemler) yontemEkle(hedef.tahsilat, y.yontem, y.adet, y.tutar);
    hedef.paket.adet += m.paket.adet; hedef.paket.tutar += m.paket.tutar;
    for (const k of ['telefon', 'pazaryeri']) { hedef.paket[k].adet += m.paket[k].adet; hedef.paket[k].tutar += m.paket[k].tutar; }
    hedef.masa.adet += m.masa.adet; hedef.masa.tutar += m.masa.tutar;
    hedef.acikHesap.adet += m.acikHesap.adet; hedef.acikHesap.tutar += m.acikHesap.tutar;
}
function bitir(m) {
    m.ciro = yuvarla(m.ciro);
    m.ortalamaAdisyon = m.adisyon > 0 ? yuvarla(m.ciro / m.adisyon) : 0;
    for (const k of ['nakit', 'kart', 'diger', 'toplam']) m.tahsilat[k] = yuvarla(m.tahsilat[k]);
    m.tahsilat.yontemler = m.tahsilat.yontemler.map((y) => ({ ...y, tutar: yuvarla(y.tutar) })).sort((a, b) => b.tutar - a.tutar);
    m.paket.tutar = yuvarla(m.paket.tutar);
    m.paket.telefon.tutar = yuvarla(m.paket.telefon.tutar);
    m.paket.pazaryeri.tutar = yuvarla(m.paket.pazaryeri.tutar);
    m.masa.tutar = yuvarla(m.masa.tutar);
    m.acikHesap.tutar = yuvarla(m.acikHesap.tutar);
    return m;
}

// Kullanicinin grubu (yonetici oldugu ve KENDI isletmesi hala uyesi olan grup). Yoksa null.
async function kullanicininGrubu(userId, tenantId) {
    if (!userId || !tenantId) return null;
    const r = await query(
        `SELECT g.id, g.ad
           FROM sube_grup_yoneticileri y
           JOIN sube_gruplari g ON g.id = y.grup_id
           JOIN sube_grup_uyeleri u ON u.grup_id = g.id AND u.tenant_id = ?
          WHERE y.user_id = ?
          LIMIT 1`, [String(tenantId), String(userId)]);
    return r.rows[0] || null;
}

async function subeler(grupId) {
    const r = await query(
        `SELECT t.id, t.business_name, t.business_code, t.is_active, t.license_end_date
           FROM sube_grup_uyeleri u JOIN tenants t ON t.id = u.tenant_id
          WHERE u.grup_id = ?
          ORDER BY t.business_name COLLATE NOCASE`, [String(grupId)]);
    return r.rows;
}

async function ozet(grup, { bas, bit } = {}, simdi = new Date()) {
    const donem = donemCoz(bas, bit, simdi);
    const sb = await subeler(grup.id);
    const ids = sb.map((x) => x.id);
    const harita = new Map(sb.map((x) => [x.id, bosMetrik()]));
    const son = new Map();
    if (ids.length) {
        const yer = ids.map(() => '?').join(', ');
        const sip = await query(
            `SELECT tenant_id,
                    COUNT(*) AS adisyon,
                    COALESCE(SUM(total), 0) AS ciro,
                    COALESCE(SUM(CASE WHEN channel = 'DINE_IN' THEN 1 ELSE 0 END), 0) AS masa_adet,
                    COALESCE(SUM(CASE WHEN channel = 'DINE_IN' THEN total ELSE 0 END), 0) AS masa_tutar,
                    COALESCE(SUM(CASE WHEN channel = '${PAKET}' THEN 1 ELSE 0 END), 0) AS tel_adet,
                    COALESCE(SUM(CASE WHEN channel = '${PAKET}' THEN total ELSE 0 END), 0) AS tel_tutar,
                    COALESCE(SUM(CASE WHEN channel NOT IN ('DINE_IN', '${PAKET}') THEN 1 ELSE 0 END), 0) AS pz_adet,
                    COALESCE(SUM(CASE WHEN channel NOT IN ('DINE_IN', '${PAKET}') THEN total ELSE 0 END), 0) AS pz_tutar
               FROM orders
              WHERE tenant_id IN (${yer}) AND status = 'CLOSED' AND closed_at >= ? AND closed_at < ?
              GROUP BY tenant_id`, [...ids, donem.basUtc, donem.bitUtc]);
        for (const s of sip.rows) {
            const m = harita.get(s.tenant_id); if (!m) continue;
            m.ciro = Number(s.ciro || 0); m.adisyon = Number(s.adisyon || 0);
            m.masa = { adet: Number(s.masa_adet || 0), tutar: Number(s.masa_tutar || 0) };
            m.paket.telefon = { adet: Number(s.tel_adet || 0), tutar: Number(s.tel_tutar || 0) };
            m.paket.pazaryeri = { adet: Number(s.pz_adet || 0), tutar: Number(s.pz_tutar || 0) };
            m.paket.adet = m.paket.telefon.adet + m.paket.pazaryeri.adet;
            m.paket.tutar = m.paket.telefon.tutar + m.paket.pazaryeri.tutar;
        }
        const odm = await query(
            `SELECT p.tenant_id, p.method, COUNT(*) AS adet, COALESCE(SUM(p.amount), 0) AS tutar
               FROM payments p JOIN orders o ON o.id = p.order_id
              WHERE p.tenant_id IN (${yer}) AND o.tenant_id = p.tenant_id
                AND o.status = 'CLOSED' AND o.closed_at >= ? AND o.closed_at < ?
              GROUP BY p.tenant_id, p.method`, [...ids, donem.basUtc, donem.bitUtc]);
        for (const p of odm.rows) {
            const m = harita.get(p.tenant_id); if (m) yontemEkle(m.tahsilat, p.method || 'DIGER', p.adet, p.tutar);
        }
        const acik = await query(
            `SELECT tenant_id, COUNT(*) AS adet, COALESCE(SUM(total), 0) AS tutar
               FROM orders WHERE tenant_id IN (${yer}) AND status = 'OPEN' GROUP BY tenant_id`, ids);
        for (const a of acik.rows) {
            const m = harita.get(a.tenant_id); if (m) m.acikHesap = { adet: Number(a.adet || 0), tutar: Number(a.tutar || 0) };
        }
        const sn = await query(
            `SELECT tenant_id, MAX(opened_at) AS acilis, MAX(closed_at) AS kapanis
               FROM orders WHERE tenant_id IN (${yer}) GROUP BY tenant_id`, ids);
        for (const x of sn.rows) {
            const a = isoZaman(x.acilis), k = isoZaman(x.kapanis);
            son.set(x.tenant_id, a && k ? (a > k ? a : k) : (a || k));
        }
    }
    const toplam = bosMetrik();
    const liste = sb.map((t) => {
        const m = harita.get(t.id);
        topla(toplam, m);
        const d = L.hesapla(t.license_end_date, simdi);
        return {
            tenantId: t.id, ad: t.business_name, isyeriKodu: t.business_code, aktif: !!Number(t.is_active),
            lisans: { durum: d.durum, bitis: d.bitis ? d.bitis.toISOString() : null, kalanGun: d.kalanGun },
            sonIslem: son.get(t.id) || null,
            ...bitir(m),
        };
    });
    return {
        grup: { id: grup.id, ad: grup.ad },
        donem: { bas: donem.bas, bit: donem.bit, gunSayisi: donem.gunSayisi, saatDilimi: donem.saatDilimi },
        olusturma: simdi.toISOString(),
        toplam: { ...bitir(toplam), subeSayisi: liste.length },
        subeler: liste,
    };
}

module.exports = { ozet, donemCoz, kullanicininGrubu, subeler, gunBasiUtc, EN_COK_GUN };
