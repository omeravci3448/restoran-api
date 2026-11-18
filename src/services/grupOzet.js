const { query } = require('../config/db');
const { PAKET } = require('./paketServis');
const L = require('./lisansDurumu');
const IG = require('./isGunu');

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
// GUN SINIRI Raporlarla AYNI (services/isGunu.js): her sube KENDI is gununu kullanir (Istanbul saati, subenin
// kapanis saatinde doner; varsayilan 00:00). Tarihler is gunudur: 02:00'de kapanan subede 21 Ekim 01:30'daki satis
// 20 Ekim'e yazilir, 00:00'da kapanan subede 21 Ekim'e.
// Donem: ?donem=bugun|dun|hafta|ay|gecenAy (her subenin KENDI bugunune gore; gece 01:30'da 02:00'de kapanan sube
// icin "bugun" hala onceki is gunudur) ya da ?bas=YYYY-MM-DD&bit=YYYY-MM-DD (ayni is gunleri, her sube kendi saatiyle).
// Yalniz TOPLAM rakamlar: musteri adi / telefon / adres hic okunmaz.

const EN_COK_GUN = 93;
const DONEM_KODLARI = ['bugun', 'dun', 'hafta', 'ay', 'gecenAy'];

function hata(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }

// Is gununun basi (dahil), SQLite CURRENT_TIMESTAMP biciminde UTC metin. saat: kapanis saati (0-6)
const gunBasiUtc = (gun, saat = 0) => IG.gunBasiUtc(gun, saat);
const gunEkle = IG.gunEkle;
const gunSayisiOf = (bas, bit) => Math.round((Date.parse(`${bit}T00:00:00Z`) - Date.parse(`${bas}T00:00:00Z`)) / 86400000) + 1;

// Goreli donem -> is gunu araligi (bugun: subenin icinde bulunulan is gunu). Hafta pazartesi baslar.
function goreliAralik(kod, bugun) {
    if (kod === 'dun') { const d = gunEkle(bugun, -1); return { bas: d, bit: d }; }
    if (kod === 'hafta') {
        const g = new Date(`${bugun}T00:00:00Z`).getUTCDay();
        return { bas: gunEkle(bugun, -((g + 6) % 7)), bit: bugun };
    }
    if (kod === 'ay') return { bas: bugun.slice(0, 8) + '01', bit: bugun };
    if (kod === 'gecenAy') {
        const gecenSon = gunEkle(bugun.slice(0, 8) + '01', -1);
        return { bas: gecenSon.slice(0, 8) + '01', bit: gecenSon };
    }
    return { bas: bugun, bit: bugun };
}

// ?bas&bit (is gunleri, ikisi de dahil) ya da ?donem=kod. Ikisi de bos: bugun. saat: subenin kapanis saati.
function donemCoz(basHam, bitHam, simdi = new Date(), { kod: kodHam, saat = 0 } = {}) {
    let bas = String(basHam || '').trim();
    let bit = String(bitHam || '').trim();
    let kod = 'ozel';
    if (!bas && !bit) {
        kod = String(kodHam || '').trim() || 'bugun';
        if (!DONEM_KODLARI.includes(kod)) throw hata(400, 'Dönem geçersiz.');
        ({ bas, bit } = goreliAralik(kod, IG.isGunu(simdi, saat)));
    } else {
        if (!bas) bas = bit;
        if (!bit) bit = bas;
        if (!IG.gecerliGun(bas) || !IG.gecerliGun(bit)) throw hata(400, 'Tarih biçimi geçersiz (YYYY-AA-GG).');
        if (bit < bas) throw hata(400, 'Bitiş tarihi başlangıçtan önce olamaz.');
    }
    const gunSayisi = gunSayisiOf(bas, bit);
    if (gunSayisi > EN_COK_GUN) throw hata(400, `En fazla ${EN_COK_GUN} günlük bir aralık seçebilirsiniz.`);
    const a = IG.aralikUtc(bas, bit, saat);
    return { kod, bas, bit, gunSayisi, basUtc: a.basUtc, bitUtc: a.bitUtc, saatDilimi: 'Europe/Istanbul' };
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
        `SELECT t.id, t.business_name, t.business_code, t.is_active, t.license_end_date, t.gun_donumu_saat
           FROM sube_grup_uyeleri u JOIN tenants t ON t.id = u.tenant_id
          WHERE u.grup_id = ?
          ORDER BY t.business_name COLLATE NOCASE`, [String(grupId)]);
    return r.rows;
}

async function ozet(grup, { bas, bit, donem: kod } = {}, simdi = new Date()) {
    const genel = donemCoz(bas, bit, simdi, { kod });   // dogrulama (hatali istek subelere bakmadan 400)
    const sb = await subeler(grup.id);
    const ids = sb.map((x) => x.id);
    const harita = new Map(sb.map((x) => [x.id, bosMetrik()]));
    const son = new Map();
    // Her subenin donemi kendi kapanis saatiyle (is gunu araligi)
    const subeDonem = new Map(sb.map((x) => {
        const saat = IG.saatNorm(x.gun_donumu_saat);
        return [x.id, { saat, ...donemCoz(bas, bit, simdi, { kod, saat }) }];
    }));
    // (tenant_id = ? AND kapanis araligi) OR ... : tek sorguda her sube kendi araligiyla
    const aralikKosulu = (k) => '(' + ids.map(() => `(${k}tenant_id = ? AND ${k}closed_at >= ? AND ${k}closed_at < ?)`).join(' OR ') + ')';
    const aralikParam = () => ids.flatMap((id) => { const d = subeDonem.get(id); return [id, d.basUtc, d.bitUtc]; });
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
              WHERE status = 'CLOSED' AND ${aralikKosulu('')}
              GROUP BY tenant_id`, aralikParam());
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
                AND o.status = 'CLOSED' AND ${aralikKosulu('o.')}
              GROUP BY p.tenant_id, p.method`, [...ids, ...aralikParam()]);
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
    // Lisans: subenin panelde gordugu ETKIN durum (odeme korumasi dahil: havale bildirildi, onay bekliyor -> AKTIF).
    const OK = require('./odemeKorumasi');
    const durumlar = new Map();
    for (const t of sb) durumlar.set(t.id, await OK.etkinDurum(t.id, t.license_end_date, simdi));
    const liste = sb.map((t) => {
        const m = harita.get(t.id);
        topla(toplam, m);
        const d = durumlar.get(t.id) || L.hesapla(t.license_end_date, simdi);
        const sd = subeDonem.get(t.id);
        return {
            tenantId: t.id, ad: t.business_name, isyeriKodu: t.business_code, aktif: !!Number(t.is_active),
            gunDonumuSaat: sd.saat, donem: { bas: sd.bas, bit: sd.bit },
            lisans: { durum: d.durum, bitis: d.bitis ? d.bitis.toISOString() : null, kalanGun: d.kalanGun,
                odemeKorumasi: d.odemeKorumasi ? d.odemeKorumasi.bitis : null },
            sonIslem: son.get(t.id) || null,
            ...bitir(m),
        };
    });
    // Grubun donemi: subelerin is gunu araliklarini kapsar (gun icinde hepsi ayni; yalniz gece 00:00-06:00 arasinda,
    // farkli kapanis saatli subelerde "bugun" bir gun kayabilir)
    let gBas = genel.bas, gBit = genel.bit;
    if (sb.length) {
        const ds = [...subeDonem.values()];
        gBas = ds.reduce((m, d) => (d.bas < m ? d.bas : m), ds[0].bas);
        gBit = ds.reduce((m, d) => (d.bit > m ? d.bit : m), ds[0].bit);
    }
    return {
        grup: { id: grup.id, ad: grup.ad },
        donem: { kod: genel.kod, bas: gBas, bit: gBit, gunSayisi: gunSayisiOf(gBas, gBit), saatDilimi: genel.saatDilimi,
            gunDonumu: 'sube' },
        olusturma: simdi.toISOString(),
        toplam: { ...bitir(toplam), subeSayisi: liste.length },
        subeler: liste,
    };
}

module.exports = { ozet, donemCoz, kullanicininGrubu, subeler, gunBasiUtc, EN_COK_GUN, DONEM_KODLARI };
