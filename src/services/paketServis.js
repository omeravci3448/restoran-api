const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const ES = require('../marketplace/paketEsleme');

// --- PAKET SERVIS: ortak kurallar ---
// Paket Servis ekranina iki kaynak duser:
//   1) Telefon siparisi: kasada acilir, channel = 'PAKET_SERVIS', masasiz. Gunluk artan no (Paket 3).
//      Akis: HAZIRLANIYOR -> (adrese) YOLDA / (gel-al) HAZIR -> TESLIM -> odeme -> hesap kapanir.
//   2) Pazaryeri siparisi: cekme dongusu (services/siparisCekici.js) yazar, channel = adaptor kodu.
//      Hangi pazaryerinin listeye dusecegi, asamasi, dugmeleri, uyarisi ve odeme yontemi ADAPTOR
//      KODUNDAN BAGIMSIZ: marketplace/paketEsleme.js'teki satirdan okunur (bugun yalniz SofraMix).
// Temel pakette: lisans modulu (MARKETPLACE) ISTEMEZ.

// Kanal kodu: elle acilan pazaryeri kanalinin ADI orders.channel'a yazildigi icin (ornek "Paket") onunla
// cakismayacak bir kod; ayrica pazaryeri kanal adi olarak ayrilmis (marketplaceController).
const PAKET = 'PAKET_SERVIS';
const paketKanaliMi = (kanal) => kanal === PAKET || !!ES.satir(kanal);

// Musteri adi/telefon/adres yalniz Paket Servis uclarindan doner; genel siparis uclari (/api/orders,
// /api/marketplace/orders) her role acik oldugu icin bu alanlari CIKARIR.
const KISISEL_ALANLAR = ['musteri_ad', 'musteri_tel', 'musteri_adres'];
function kisiselAlanlariCikar(o) {
    if (!o) return o;
    const k = { ...o };
    for (const a of KISISEL_ALANLAR) delete k[a];
    return k;
}

// Teslimat ucreti siparise OZEL KALEM olarak yazilir (product_id NULL, source bu deger): toplam, kalem
// bazli odeme ve ciro kendiliginden dogru olur. Mutfak ekranina dusmez, "En cok satan"a girmez,
// masadaki +/- ile degismez (yalniz "Bilgileri duzenle").
const TESLIMAT_KAYNAK = 'TESLIMAT_UCRETI';
const TESLIMAT_KALEM_ADI = 'Teslimat ücreti';

// Telefon -> musteri defteri anahtari: yalniz rakam, son 10 hane (0 / +90 oneki duser). 7 haneden kisa = yok.
function telNorm(tel) {
    const d = String(tel || '').replace(/\D/g, '');
    if (d.length >= 10) return d.slice(-10);
    return d.length >= 7 ? d : null;
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const TL = (n) => Number(n || 0).toLocaleString('tr-TR') + ' TL';

// Odeme sekli: telefon siparisinde kasiyer secer (asagidaki tablo); pazaryerinde platform bildirir
// (esleme satirinin odeme tablosu). Teslimde otomatik odeme kaydi POS yontemini buradan alir.
const TELEFON_ODEME_TABLO = {
    kapida_nakit: { pos: 'NAKIT', etiket: 'Kapıda nakit' },
    kapida_kart: { pos: 'KREDI_KARTI', etiket: 'Kapıda kart' },
};
const TELEFON_ODEME = Object.keys(TELEFON_ODEME_TABLO);
function odemeBilgisi(kanal, kod) {
    const tablo = kanal === PAKET ? TELEFON_ODEME_TABLO : ((ES.satir(kanal) || {}).odeme || {});
    return Object.prototype.hasOwnProperty.call(tablo, String(kod || '')) ? tablo[kod] : null;
}
const posYontemi = (kanal, kod) => (odemeBilgisi(kanal, kod) || {}).pos || 'DIGER';

// --- Gun siniri: Istanbul ---
// Paket numarasi "bugunun kacinci paketi" sorusuna cevap verir; gun Turkiye saatiyle doner.
function istanbulGunu(d = new Date()) {
    try {
        const p = {};
        for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value;
        if (p.year && p.month && p.day) return `${p.year}-${p.month}-${p.day}`;
    } catch (_) { /* ICU yoksa asagidaki yol */ }
    return new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 10);   // Turkiye 2016'dan beri sabit UTC+3
}
// Istanbul gununun basi, SQLite CURRENT_TIMESTAMP biciminde (UTC 'YYYY-MM-DD HH:MM:SS')
function istanbulGunBasiUtc(d = new Date()) {
    const ms = Date.parse(istanbulGunu(d) + 'T00:00:00+03:00');
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}
// Platformun ms zamani -> SQLite UTC metni (yoksa null)
function sqlZamani(ms) {
    const n = Number(ms);
    if (!ms || !Number.isFinite(n)) return null;
    return new Date(n).toISOString().slice(0, 19).replace('T', ' ');
}

// --- Etiketler ---
// Uzun/egik tire metinlere girmesin (arayuz kurali): adaptor adlarinda uzun tire olabiliyor.
const duzTire = (s) => String(s).replace(/[\u2012-\u2015\u2212]/g, '-');

// Rapor, mutfak, rozet icin kanal adi: DINE_IN -> Salon, PAKET -> Paket, esleme satiri -> satirin adi,
// adaptor kodu -> adaptorun adi, elle girilmis pazaryeri kanali -> kendi adi.
function kanalAdi(kanal) {
    if (!kanal || kanal === 'DINE_IN') return 'Salon';
    if (kanal === PAKET) return 'Paket';
    const s = ES.satir(kanal);
    if (s && s.ad) return duzTire(s.ad);
    try {
        const reg = require('../marketplace/registry');
        const a = reg.ADAPTERS[kanal];
        if (a && reg.listAvailable().some((x) => x.code === kanal)) return duzTire(a.displayName);
    } catch (_) { /* kayit okunamadi: ham ad */ }
    return duzTire(kanal);
}

// "Paket 3" / "SofraMix SMX-K7P2QA" / "<Kanal> #4101"
function paketEtiketi(o) {
    if (!o) return '';
    if (o.channel === PAKET) return o.paket_no ? `Paket ${o.paket_no}` : 'Paket';
    const no = o.external_order_no || o.external_ref;
    const ad = kanalAdi(o.channel);
    if (!no) return ad;
    return /^[A-Za-z]/.test(String(no)) ? `${ad} ${no}` : `${ad} #${no}`;
}

const teslimatOf = (o) => (o.delivery_mode === 'PICKUP' ? 'GEL_AL' : 'ADRES');
const TESLIMAT_ETIKET = { ADRES: 'Adrese teslim', GEL_AL: 'Gel-al' };

// --- Asama ---
const ASAMA_ETIKET = {
    YENI: 'Onay bekliyor', ONAYLANDI: 'Onaylandı', HAZIRLANIYOR: 'Hazırlanıyor', YOLDA: 'Yolda',
    HAZIR: 'Hazır, alınmayı bekliyor', TESLIM: 'Teslim edildi', IPTAL: 'İptal edildi', KAPANDI: 'Tamamlandı',
};
// Pazaryeri ortak (normalize) durum sozlugu -> Paket Servis asamasi / kasadaki islem / ilerleme sirasi
const NORMAL_ASAMA = { NEW: 'YENI', ACCEPTED: 'ONAYLANDI', PREPARING: 'HAZIRLANIYOR', DISPATCHED: 'YOLDA', READY: 'HAZIR',
    DELIVERED: 'TESLIM', CANCELLED: 'IPTAL', REJECTED: 'IPTAL' };
const NORMAL_AKSIYON = { ACCEPTED: 'kabul', PREPARING: 'hazirlaniyor', DISPATCHED: 'yolda', READY: 'hazir', DELIVERED: 'teslim',
    CANCELLED: 'iptal', REJECTED: 'iptal' };
const NORMAL_SIRA = { NEW: 0, ACCEPTED: 1, PREPARING: 2, DISPATCHED: 3, READY: 3, DELIVERED: 4, CANCELLED: 4, REJECTED: 4 };

// Platformda gecerli (efektif) ham durum: esleme satirinin "takmaHam" tablosu eski surumlerin yerelde
// yazdigi degerleri cevirir (SofraMix: 'teslim_edilemedi' -> teslimat sekline gore yolda/hazir).
function efektifHam(o, s = ES.satir(o.channel)) {
    const h = o.channel_status_raw;
    const takma = s && s.takmaHam && s.takmaHam[h];
    return takma ? (takma[teslimatOf(o)] || h) : h;
}
const normalOf = (o, s = ES.satir(o.channel)) => (s ? (s.durumNormal || {})[efektifHam(o, s)] || null : null);
const hamNormal = (kanal, ham) => { const s = ES.satir(kanal); return s ? (s.durumNormal || {})[ham] || null : null; };

// Cekme dongusu: platform durumu yalniz ILERI gider; eski bir olay yerel durumu geri almasin
function geriMi(kanal, eskiHam, yeniHam) {
    const a = NORMAL_SIRA[hamNormal(kanal, eskiHam)], b = NORMAL_SIRA[hamNormal(kanal, yeniHam)];
    return a != null && b != null && b < a;
}

function asamaOf(o) {
    if (o.status === 'CANCELLED') return 'IPTAL';
    if (o.status === 'CLOSED') return 'KAPANDI';
    if (o.channel === PAKET) return o.paket_durum || 'HAZIRLANIYOR';
    return NORMAL_ASAMA[normalOf(o)] || 'YENI';
}

// Filtre grubu: hazirlaniyor | yolda | odeme | bugun (kapanan/iptal)
function grupOf(o, asama = asamaOf(o)) {
    if (o.status !== 'OPEN') return 'bugun';
    if (asama === 'YOLDA' || asama === 'HAZIR') return 'yolda';
    if (asama === 'TESLIM') return 'odeme';
    return 'hazirlaniyor';
}

// Yeni gelmis, kimse el surmemis pazaryeri siparisi (esleme satirinin "dikkat" durumlari): kasada zil
// bunun icin calar, kart vurgulanir.
const dikkatMi = (o) => {
    const s = ES.satir(o.channel);
    return !!s && o.status === 'OPEN' && (s.dikkat || []).includes(normalOf(o, s));
};

// --- Izinli aksiyonlar ---
// Arayuz dugmeleri BU listeden cizilir, sunucu da istegi ayni listeyle denetler (tek kural).
// Pazaryerinde: esleme satirinin gecis matrisi (platformun kilitli kurali) + teslimat sekli + adaptorun
// beyan ettigi yetenek. SofraMix: hazirlaniyor'dan sonra gel-al ise 'hazir', degilse 'yolda'; yolda/hazir
// asamasinda iptal YOK -> "Teslim edilemedi" bildirimi var.
const AKSIYON_ETIKET = {
    kabul: 'Onayla', hazirlaniyor: 'Hazırlanıyor', yolda: 'Yola çıktı', hazir: 'Hazır', teslim: 'Teslim edildi',
    iptal: 'İptal et', teslim_edilemedi: 'Teslim edilemedi',
};
// Adaptor bu islemi yapabiliyor mu (yetenek beyani + metod)
function adaptorYapar(kanal, kod) {
    const ak = ES.AKSIYONLAR[kod];
    if (!ak) return false;
    try {
        const a = require('../marketplace/registry').getAdapter(kanal);
        return !!(a.capabilities && a.capabilities[ak.yetenek]) && typeof a[ak.metod] === 'function';
    } catch (_) { return false; }
}

function aksiyonlarOf(o) {
    if (o.status !== 'OPEN') return [];
    const a = [];
    const ekle = (kod, ek = {}) => a.push({ kod, etiket: AKSIYON_ETIKET[kod], tur: 'ana', ...ek });
    if (o.channel === PAKET) {
        const asama = o.paket_durum || 'HAZIRLANIYOR';
        if (asama === 'HAZIRLANIYOR') ekle(teslimatOf(o) === 'GEL_AL' ? 'hazir' : 'yolda');
        if (asama === 'YOLDA' || asama === 'HAZIR') ekle('teslim');
        ekle('iptal', { tur: 'tehlikeli', yalnizYonetici: true });
        return a;
    }
    const s = ES.satir(o.channel);
    if (!s) return a;
    const ham = efektifHam(o, s);
    const simdi = (s.durumNormal || {})[ham];
    const gelAl = teslimatOf(o) === 'GEL_AL';
    for (const hedefHam of (s.gecisler || {})[ham] || []) {
        const hedef = (s.durumNormal || {})[hedefHam];
        if ((s.yalnizGelAl || []).includes(hedef) && !gelAl) continue;
        if ((s.yalnizAdrese || []).includes(hedef) && gelAl) continue;
        const kod = NORMAL_AKSIYON[hedef];
        if (!kod || a.some((x) => x.kod === kod) || !adaptorYapar(o.channel, kod)) continue;
        if (kod === 'iptal') {
            ekle('iptal', { etiket: (s.reddetDurum || []).includes(simdi) ? 'Reddet' : 'İptal et', tur: 'tehlikeli', yalnizYonetici: true, sebepZorunlu: true });
        } else ekle(kod);
    }
    if ((s.teslimEdilemedi || []).includes(simdi) && !teslimSorunuVar(o, s) && adaptorYapar(o.channel, 'teslim_edilemedi')) {
        ekle('teslim_edilemedi', { tur: 'ikincil', sebepZorunlu: true });
    }
    return a;
}

// "Teslim edilemedi" bildirilmis mi: yerel damga ya da eski surumun yazdigi ham deger (esleme satiri)
function teslimSorunuVar(o, s = ES.satir(o.channel)) {
    return !!o.teslim_sorunu_at || !!(s && (s.bildirilmisHam || []).includes(o.channel_status_raw));
}

// Kasadan yapilan islemden sonra yerelde yazilacak ham durum: esleme satirindaki gecis matrisinden
// (islemin hedef normalize durumuna giden ham deger). Satir yoksa null (cagiran eski davranisa doner).
function hedefHam(o, kod) {
    const s = ES.satir(o.channel), ak = ES.AKSIYONLAR[kod];
    if (!s || !ak || !ak.normal) return null;
    const dn = s.durumNormal || {};
    const adaylar = [...((s.gecisler || {})[efektifHam(o, s)] || []), ...Object.keys(dn)];
    return adaylar.find((h) => dn[h] === ak.normal) || null;
}

// --- Musteri bilgisi (adaptorun normalize ciktisindan: customer / address) ---
// Platform adresi maskeli/silinmis gonderirse (SofraMix KVKK imhasi: adres {silindi:true}, telefon
// 'silindi-...' yer tutucusu; adaptor bunu customer.isMasked / address.isMasked yapar) yerelde de HICBIR
// kisisel veri tutulmaz.
function musteriBilgisi(n) {
    const c = (n && n.customer) || {};
    const a = (n && n.address) || null;
    const tel = c.phone ? String(c.phone).trim() : '';
    const silindi = !!(n && (n.isAddressMasked || (a && a.isMasked) || c.isMasked || /^silindi-/i.test(tel)));
    if (silindi) return { silindi: true, ad: null, tel: null, adres: null };
    let adres = null;
    if (a) {
        adres = [a.line1, a.district].map((s) => (s == null ? '' : String(s).trim())).filter(Boolean).join(', ') || null;
        const tarif = a.note ? String(a.note).trim() : '';
        if (tarif) adres = (adres ? adres + ' ' : '') + '(Tarif: ' + tarif + ')';
    }
    return {
        silindi: false,
        ad: c.name ? String(c.name).trim().slice(0, 120) : null,
        tel: tel ? tel.slice(0, 30) : null,
        adres: adres ? adres.slice(0, 500) : null,
    };
}

// --- Teslimde otomatik odeme ---
// Pazaryeri siparisi teslim olunca (POS dugmesi ya da cekme dongusu) odemesi eksikse KALAN tutar
// platformun bildirdigi odeme yontemiyle (esleme satirinin odeme tablosu; bilinmeyen kod DIGER) yazilir.
// Kalan uzerinden calistigi icin tek seferliktir: ikinci cagri 0 bulur. Yalniz KAPALI sipariste
// calisir. tx ICINDE cagrilmali (Ic surum).
async function otoOdemeYazIc(orderId) {
    const o = (await query('SELECT id, tenant_id, status, total, odeme_sekli, channel FROM orders WHERE id = ?', [orderId])).rows[0];
    if (!o || o.status !== 'CLOSED') return 0;
    const odenen = Number((await query('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE order_id = ?', [orderId])).rows[0].s);
    const kalan = r2(Number(o.total || 0) - odenen);
    if (!(kalan > 0.009)) return 0;
    await query(
        `INSERT INTO payments (id, tenant_id, order_id, method, amount, ref, created_by)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [uuidv4(), o.tenant_id, orderId, posYontemi(o.channel, o.odeme_sekli), kalan, 'OTO_TESLIM:' + o.channel]);
    return kalan;
}
const otoOdemeYaz = (orderId) => tx(() => otoOdemeYazIc(orderId));

// Paket yola cikti / teslim edildi: mutfak ekraninda bekleyen kalemleri "servis edildi" yap,
// kart mutfaktan kalksin (yemek dukkandan cikti).
async function mutfakKalemleriniKapat(orderId) {
    const r = await query(
        `UPDATE order_items SET status = 'SERVED', served_at = COALESCE(served_at, CURRENT_TIMESTAMP)
          WHERE order_id = ? AND status IN ('NEW', 'SEEN', 'PREPARING', 'READY')`, [orderId]);
    return r.changes || 0;
}

// --- Musteri defteri (yalniz telefon siparisi) ---
const DEFTER_ADRES_SINIRI = 5;
const adresAnahtari = (a) => String(a || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr');
function adresleriOku(json) {
    try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : []; } catch (_) { return []; }
}
async function defterBul(tenantId, tel) {
    const norm = telNorm(tel);
    if (!norm) return null;
    return (await query('SELECT * FROM paket_musterileri WHERE tenant_id = ? AND tel_norm = ?', [tenantId, norm])).rows[0] || null;
}
// Siparisten deftere yaz. yeniSiparis: siparis sayisi + son siparis zamani ilerler.
// yalnizVarsa: kayit yoksa ACMA (ornek: "Musteriyi unut" sonrasi acik siparisin bilgisi duzeltilince geri gelmesin).
async function defterYaz({ tenantId, tel, ad, adres, yeniSiparis = false, yalnizVarsa = false }) {
    const norm = telNorm(tel);
    if (!norm) return null;
    const v = (await query('SELECT * FROM paket_musterileri WHERE tenant_id = ? AND tel_norm = ?', [tenantId, norm])).rows[0];
    if (!v && yalnizVarsa) return null;
    let adresler = v ? adresleriOku(v.adresler) : [];
    if (adres && String(adres).trim()) {
        const temiz = String(adres).trim();
        adresler = [temiz, ...adresler.filter((a) => adresAnahtari(a) !== adresAnahtari(temiz))].slice(0, DEFTER_ADRES_SINIRI);
    }
    if (v) {
        await query(
            `UPDATE paket_musterileri SET tel = ?, ad = COALESCE(?, ad), adresler = ?,
                    siparis_sayisi = siparis_sayisi + ?, son_siparis_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE son_siparis_at END
              WHERE id = ?`,
            [String(tel).trim().slice(0, 30), ad || null, JSON.stringify(adresler), yeniSiparis ? 1 : 0, yeniSiparis ? 1 : 0, v.id]);
        return v.id;
    }
    const id = uuidv4();
    await query(
        `INSERT INTO paket_musterileri (id, tenant_id, tel_norm, tel, ad, adresler, siparis_sayisi, son_siparis_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [id, tenantId, norm, String(tel).trim().slice(0, 30), ad || null, JSON.stringify(adresler), yeniSiparis ? 1 : 0]);
    return id;
}
// Telefon numarasi duzeltildi: eski numaranin kaydi bu siparisle acildiysa geri al (yazim hatasi defterde kalmasin)
async function defterGeriAl(tenantId, tel) {
    const v = await defterBul(tenantId, tel);
    if (!v) return;
    if (Number(v.siparis_sayisi) <= 1) await query('DELETE FROM paket_musterileri WHERE id = ?', [v.id]);
    else await query('UPDATE paket_musterileri SET siparis_sayisi = siparis_sayisi - 1 WHERE id = ?', [v.id]);
}
const defterGorunum = (v) => (v ? {
    id: v.id, ad: v.ad || null, tel: v.tel || null, adresler: adresleriOku(v.adresler),
    siparisSayisi: Number(v.siparis_sayisi || 0), sonSiparis: v.son_siparis_at || null,
} : null);

// --- Ekran gorunumu ---
async function kalemVeOdemeler(ids) {
    const kalemler = new Map(), odenen = new Map();
    // Acik siparislerin hepsi listelenir (sinir yok): IN listesi 500'luk parcalarla (SQLite degisken siniri)
    for (let i = 0; i < ids.length; i += 500) {
        const parca = ids.slice(i, i + 500);
        const yer = parca.map(() => '?').join(',');
        // Teslimat ucreti kalemi listenin sonunda
        const k = await query(
            `SELECT order_id, product_name, qty, total, note, source, COALESCE(is_cancelled, 0) AS iptal
               FROM order_items WHERE order_id IN (${yer})
              ORDER BY CASE WHEN source = '${TESLIMAT_KAYNAK}' THEN 1 ELSE 0 END, created_at`, parca);
        for (const r of k.rows) {
            if (!kalemler.has(r.order_id)) kalemler.set(r.order_id, []);
            kalemler.get(r.order_id).push({ ad: r.product_name, adet: Number(r.qty), tutar: Number(r.total), not: r.note || null, iptal: !!r.iptal,
                ucret: r.source === TESLIMAT_KAYNAK });
        }
        const p = await query(`SELECT order_id, COALESCE(SUM(amount), 0) AS s FROM payments WHERE order_id IN (${yer}) GROUP BY order_id`, parca);
        for (const r of p.rows) odenen.set(r.order_id, Number(r.s));
    }
    return { kalemler, odenen };
}

function gorunum(o, kalemler, odenen) {
    const asama = asamaOf(o);
    // kaynak: TELEFON | PAZARYERI; rozet metni kanal adindan (kaynakAd)
    const kaynak = o.channel === PAKET ? 'TELEFON' : 'PAZARYERI';
    const musteriVar = !!(o.musteri_ad || o.musteri_tel || o.musteri_adres);
    const toplam = r2(o.total);
    const odenenT = r2(odenen || 0);
    const k = kalemler || [];
    const odeme = o.odeme_sekli ? odemeBilgisi(o.channel, o.odeme_sekli) : null;
    return {
        id: o.id,
        kaynak,
        kaynakAd: kaynak === 'TELEFON' ? 'Telefon' : kanalAdi(o.channel),
        kanal: o.channel,
        etiket: paketEtiketi(o),
        paketNo: o.paket_no || null,
        harici: kaynak === 'PAZARYERI' ? { no: o.external_order_no || null, ref: o.external_ref || null, durum: o.channel_status_raw || null } : null,
        musteri: musteriVar ? { ad: o.musteri_ad || null, tel: o.musteri_tel || null, adres: o.musteri_adres || null } : null,
        musteriSilindi: !!o.musteri_silindi_at,
        not: o.note || null,
        teslimat: teslimatOf(o),
        teslimatEtiket: TESLIMAT_ETIKET[teslimatOf(o)],
        odeme: o.odeme_sekli ? { kod: o.odeme_sekli, etiket: (odeme && odeme.etiket) || 'Diğer' } : null,
        durum: o.status,
        asama,
        asamaEtiket: ASAMA_ETIKET[asama] || asama,
        grup: grupOf(o, asama),
        dikkat: dikkatMi(o),
        kalemler: k,
        urunSayisi: k.filter((x) => !x.ucret).length,                       // teslimat ucreti haric
        teslimatUcreti: r2(k.filter((x) => x.ucret).reduce((s, x) => s + x.tutar, 0)),
        toplam,
        odenen: odenenT,
        kalan: r2(Math.max(0, toplam - odenenT)),
        acilis: o.opened_at || null,
        yolaCikis: o.yola_cikti_at || null,
        hazirAt: o.hazir_at || null,
        teslimAt: o.teslim_at || null,
        kapanis: o.closed_at || null,
        teslimSorunuAt: o.teslim_sorunu_at || null,
        teslimSorunu: kaynak === 'PAZARYERI' && teslimSorunuVar(o),
        aksiyonlar: aksiyonlarOf(o),
        // Platforma gitmeden yerelde kapatma (kanal koptu / siparis platformda takildi): yalniz sahip/mudur
        yerelKapatilabilir: kaynak === 'PAZARYERI' && o.status === 'OPEN',
        duzenlenebilir: o.channel === PAKET && o.status === 'OPEN' && (o.paket_durum || 'HAZIRLANIYOR') === 'HAZIRLANIYOR',
    };
}

async function gorunumler(rows) {
    const { kalemler, odenen } = await kalemVeOdemeler(rows.map((r) => r.id));
    return rows.map((o) => gorunum(o, kalemler.get(o.id), odenen.get(o.id)));
}

// Paket Servis ekranina dusen kanallar (SQL icin): telefon + esleme tablosunda satiri olan pazaryerleri.
// Kodlar paketEsleme'de [a-z0-9_] ile sinirli; dogrudan gomulur.
const paketKanallariSql = () => ["'" + PAKET + "'", ...ES.kodlar().map((k) => "'" + k + "'")].join(', ');
// Liste kosulu (o. takma adli): pazaryeri siparisinde channel_status_raw sarti, elle girilmis bir
// pazaryeri kanali (adaptorsuz, ayni adi tasisa da) karismasin diye.
function paketKosulu() {
    const pz = ES.kodlar().map((k) => "'" + k + "'").join(', ');
    return `o.table_id IS NULL AND (o.channel = '${PAKET}'` + (pz ? ` OR (o.channel IN (${pz}) AND o.channel_status_raw IS NOT NULL)` : '') + ')';
}

// Kiraciya ait, Paket Servis ekranina dusen tek siparis (ham satir)
async function paketSatiri(id, tenantId) {
    const r = await query(`SELECT o.* FROM orders o WHERE o.id = ? AND o.tenant_id = ? AND ${paketKosulu()}`, [id, tenantId]);
    return r.rows[0] || null;
}

module.exports = {
    PAKET, TELEFON_ODEME, TESLIMAT_ETIKET, ASAMA_ETIKET, AKSIYON_ETIKET, KISISEL_ALANLAR, kisiselAlanlariCikar, teslimSorunuVar,
    TESLIMAT_KAYNAK, TESLIMAT_KALEM_ADI, telNorm, defterBul, defterYaz, defterGeriAl, defterGorunum,
    r2, TL, odemeBilgisi, posYontemi, istanbulGunu, istanbulGunBasiUtc, sqlZamani, duzTire, kanalAdi, paketEtiketi,
    paketKanaliMi, paketKanallariSql, paketKosulu, teslimatOf, efektifHam, normalOf, hamNormal, geriMi,
    asamaOf, grupOf, dikkatMi, aksiyonlarOf, hedefHam, musteriBilgisi,
    otoOdemeYazIc, otoOdemeYaz, mutfakKalemleriniKapat, gorunum, gorunumler, paketSatiri,
};
