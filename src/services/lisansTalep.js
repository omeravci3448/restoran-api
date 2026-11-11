const { query } = require('../config/db');
const K = require('./lisansKatalog');
const M = require('./lisansModul');
const { fiyatla, yuvarla, hata } = require('./lisansFiyat');

// --- Lisans talebi: deneme -> paket -> yukseltme (Patron karari 2026-11-11) ---
//
// Tur talep aninda belirlenir ve teklif KILITLENIR (lisans_odemeleri'ne yazilir, onayda yeniden hesaplanmaz):
//   ilk        Deneme surumundeki isletmenin ilk alimi. Secim serbest. Onayda lisans ONAY GUNUNDEN baslar,
//              1 yil (kalan deneme gunleri eklenmez).
//   yenileme   Bitise 30 gun ya da daha az kaldiysa ya da lisans bittiyse: eski davranis, onayda 1 yil mevcut
//              bitisin uzerine eklenir (bitmisse onay gunu + 1 yil). Secim serbest: modul cikarma ve kucuk pakete
//              gecis YALNIZ burada. Donem icinde ayni secim de erken yenileme sayilir.
//   yukseltme  Donem icinde (30 gunden fazla kaldi) yalniz modul ekleme ya da daha buyuk masa paketi.
//              Odenecek = yeni secimin yillik toplami (kiraci indirimi uygulanmis) - kalan sure kredisi, en az 0.
//              Onayda moduller ve paket degisir, yeni 1 yil ONAY GUNUNDEN baslar.
// Kredi = donemi suren son onayli odemenin yillik degeri x kalan gun / o donemin gun sayisi
//         (yillik deger: yukseltme kaydinda yeni_toplam, digerlerinde tutar).
//         Bu donem icin onayli odeme yoksa: mevcut paketin BUGUNKU katalog fiyati (indirimli) x kalan gun / 365.
// ONAYA KADAR lisans, moduller ve bitis tarihi HIC DEGISMEZ: talep yalniz lisans_odemeleri'ne kayit acar.
// SofraMix kanali bu akisa girmez (licenseController: WRONG_CHANNEL).

const GUN_MS = 86400000;
const YIL_GUN = 365;
const YENILEME_ESIGI_GUN = 30;

// SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) ya da ISO metni -> Date (gecersizse null)
function tarihOku(s) {
    if (!s) return null;
    const m = String(s);
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m) ? m.replace(' ', 'T') + 'Z' : m);
    return Number.isNaN(d.getTime()) ? null : d;
}

// Bitise kalan gun (lisansDurumu ile ayni yuvarlama: yukari). Tarih yoksa null (sinirsiz), bittiyse 0.
function kalanGunHesapla(bitis, simdi = new Date()) {
    const b = tarihOku(bitis);
    if (!b) return null;
    const fark = b.getTime() - simdi.getTime();
    return fark > 0 ? Math.ceil(fark / GUN_MS) : 0;
}

const TL = (n) => Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' TL';
const TARIH = (s) => {
    const d = s instanceof Date ? s : tarihOku(s);
    return d ? d.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul' }) : '-';
};
const sinir = (x) => (x == null ? Infinity : Number(x));   // masa siniri: null = sinirsiz
const modulAdi = (tam, m) => ((tam.find((x) => x.tur === 'MODUL' && x.kod === m) || {}).ad) || M.AD[m] || m;
const tierAdi = (tam, k) => (k ? (((tam.find((x) => x.tur === 'TIER' && x.kod === k) || {}).ad) || k) : '-');

// Isletmenin bugunku lisansi + katalog bilgisi
async function kiraciDurumu(tenantId, simdi = new Date()) {
    const t = (await query(
        `SELECT id, license_tier, license_modules, license_end_date, license_table_limit, discount_rate
           FROM tenants WHERE id = ?`, [tenantId])).rows[0];
    if (!t) throw hata(404, 'İşletme bulunamadı.');
    const tam = await K.tamKatalog();
    const modulSatirlari = tam.filter((x) => x.tur === 'MODUL');
    const katalogKodlari = new Set(modulSatirlari.map((x) => x.kod));
    const gizli = new Set(modulSatirlari.filter((x) => Number(x.gorunur) !== 1).map((x) => x.kod));
    const ham = M.modulListesi(t.license_modules);
    // 'ALL' butun katalog modulleri demek
    const sahip = ham.includes('ALL') ? modulSatirlari.map((x) => x.kod) : ham.filter((m) => m !== 'ALL');
    // Satista olmayan (gizli ya da katalogda olmayan eski kod) ama sahip olunan moduller: alimda korunur
    const korunacak = sahip.filter((m) => gizli.has(m) || !katalogKodlari.has(m));
    const mevcutTier = t.license_tier ? (tam.find((x) => x.tur === 'TIER' && x.kod === t.license_tier) || null) : null;
    // Masa siniri karsilastirmasi: paket katalogdaysa paketin siniri (eski kayitlarda sutun bos kalmis olabilir),
    // degilse sutundaki deger. null = sinirsiz.
    const mevcutLimit = mevcutTier ? mevcutTier.masa_limiti : t.license_table_limit;
    return {
        t, tam, katalogKodlari, gizli, sahip, korunacak, mevcutTier, mevcutLimit: mevcutLimit == null ? null : Number(mevcutLimit),
        deneme: t.license_tier === 'TIER_DENEME', kalanGun: kalanGunHesapla(t.license_end_date, simdi),
    };
}

// 'deneme' | 'yenileme' (bitise <= 30 gun, bitmis ya da tarihsiz) | 'donemIci'
function donemTuru(kd) {
    if (kd.deneme) return 'deneme';
    if (kd.kalanGun == null || kd.kalanGun <= YENILEME_ESIGI_GUN) return 'yenileme';
    return 'donemIci';
}

function yenilemeAcilisi(kd) {
    const b = tarihOku(kd.t.license_end_date);
    return b ? new Date(b.getTime() - YENILEME_ESIGI_GUN * GUN_MS).toISOString() : null;
}

// Lisans sayfasinin sepeti icin: donem durumu ve kilitlenecek mevcut secim
async function donemBilgisi(tenantId, simdi = new Date()) {
    const kd = await kiraciDurumu(tenantId, simdi);
    const durum = donemTuru(kd);
    return {
        durum, kalanGun: kd.kalanGun, yenilemeEsigiGun: YENILEME_ESIGI_GUN,
        bitis: kd.t.license_end_date || null,
        yenilemeAcilis: durum === 'donemIci' ? yenilemeAcilisi(kd) : null,
        mevcut: { tier: kd.t.license_tier || null, masaLimiti: kd.mevcutLimit, moduller: kd.sahip, korunan: kd.korunacak },
    };
}

// Mevcut paketin BUGUNKU katalog fiyati, kiraci indirimi uygulanmis. Gizli ve eski moduller 0 (satilmiyorlar).
// Paket katalogda yoksa (orn. elle musteriye donusturulmus deneme) ayni masa sinirli satistaki paket alinir.
function mevcutPaketDegeri(kd) {
    const { tam, sahip, t } = kd;
    let kademe = kd.mevcutTier;
    if (!kademe) {
        const limit = t.license_table_limit == null ? null : Number(t.license_table_limit);
        kademe = tam.find((x) => x.tur === 'TIER' && Number(x.gorunur) === 1
            && (x.masa_limiti == null ? null : Number(x.masa_limiti)) === limit) || null;
    }
    const tierFiyat = kademe ? (Number(kademe.fiyat) || 0) : 0;
    let toplam = 0;
    for (const m of sahip) {
        const satir = tam.find((x) => x.tur === 'MODUL' && x.kod === m);
        if (!satir || Number(satir.gorunur) !== 1) continue;
        toplam += m === 'BASE' ? tierFiyat : (Number(satir.fiyat) || 0);
    }
    const indirim = Number(t.discount_rate) || 0;
    return Math.max(0, yuvarla(toplam - toplam * indirim / 100));
}

// Kalan sure kredisi (yalniz yukseltmede kullanilir)
async function krediHesapla(kd, simdi = new Date()) {
    const kalan = kd.kalanGun || 0;
    if (kalan <= 0) return { krediTutari: 0, kaynak: null, kalanGun: 0, yillikDeger: 0, donemGun: YIL_GUN };
    const r = await query(
        `SELECT id, tutar, yeni_toplam, onay_gun, donem_bitis, islenen_at, created_at
           FROM lisans_odemeleri
          WHERE tenant_id = ? AND durum = 'onaylandi' AND donem_bitis IS NOT NULL
          ORDER BY COALESCE(islenen_at, created_at) DESC`, [kd.t.id]);
    // Donemi suren (bitisi gelmemis) en son onayli odeme
    const ref = r.rows.find((x) => { const b = tarihOku(x.donem_bitis); return b && b.getTime() > simdi.getTime(); });
    if (ref) {
        const ham = ref.yeni_toplam != null ? Number(ref.yeni_toplam) : Number(ref.tutar);
        const deger = Number.isFinite(ham) ? ham : 0;
        let donemGun = Number(ref.onay_gun);
        if (!(donemGun > 0)) {
            // Eski kayit (onay_gun yok): donem_bitis - onay ani
            const b = tarihOku(ref.donem_bitis), i = tarihOku(ref.islenen_at);
            const g = b && i ? Math.round((b.getTime() - i.getTime()) / GUN_MS) : 0;
            donemGun = g > 0 ? g : YIL_GUN;
        }
        return { krediTutari: yuvarla(deger * kalan / donemGun), kaynak: 'odeme', kalanGun: kalan, yillikDeger: deger, donemGun, odemeId: ref.id };
    }
    const deger = mevcutPaketDegeri(kd);
    return { krediTutari: yuvarla(deger * kalan / YIL_GUN), kaynak: 'katalog', kalanGun: kalan, yillikDeger: deger, donemGun: YIL_GUN };
}

function aciklamaYaz({ tur, kd, krediTutari, kalanGun, yeniToplam, degisiyor }) {
    if (tur === 'yukseltme') {
        let s = `Kalan ${kalanGun} gününüz ${TL(krediTutari)} olarak düşüldü. Yeni 1 yıllık süreniz ödemeniz onaylandığı gün başlar; `
            + 'o güne kadar mevcut paketiniz aynen çalışır.';
        if (krediTutari > yeniToplam) {
            s += ' Kalan sürenizin karşılığı yeni paketin yıllık tutarından fazla olduğu için ödenecek tutar 0 TL\'dir; aradaki fark iade edilmez.';
        }
        return s;
    }
    if (tur === 'ilk') {
        return 'Bu tutar 1 yıllık kullanım lisansı içindir. Lisansınız ödemeniz onaylandığı gün başlar ve 1 yıl geçerli olur; '
            + 'kayıtlarınız ve ayarlarınız olduğu gibi kalır.';
    }
    const s = kd.kalanGun > 0
        ? `Bu tutar 1 yıllık kullanım lisansı içindir. Ödemeniz onaylandığında 1 yıl, mevcut bitiş tarihinizin (${TARIH(kd.t.license_end_date)}) üzerine eklenir.`
        : 'Bu tutar 1 yıllık kullanım lisansı içindir. Ödemeniz onaylandığı gün lisansınız 1 yıl uzar.';
    return degisiyor ? s + ' Seçtiğiniz paket ve modüller onay gününden itibaren geçerli olur.' : s;
}

// Teklif: fiyat + tur + kredi + odenecek. Donem icinde azaltma 409 DONEM_ICI_AZALTMA.
async function teklifHazirla({ tenantId, tier, modules, simdi = new Date() }) {
    const kd = await kiraciDurumu(tenantId, simdi);
    const f = await fiyatla({ tier, modules, indirimOrani: kd.t.discount_rate, korunacak: kd.korunacak });
    const donem = donemTuru(kd);
    // Karsilastirma katalogdaki modullerle (katalogda olmayan eski kodlar zaten korunur)
    const karsilastir = kd.sahip.filter((m) => kd.katalogKodlari.has(m));
    const cikan = karsilastir.filter((m) => !f.modules.includes(m));
    const eklenen = f.modules.filter((m) => !kd.sahip.includes(m));
    const yeniLimit = f.tableLimit == null ? null : Number(f.tableLimit);
    const limitKuculur = sinir(yeniLimit) < sinir(kd.mevcutLimit);
    const limitBuyur = sinir(yeniLimit) > sinir(kd.mevcutLimit);

    let tur;
    let kredi = { krediTutari: 0, kaynak: null, kalanGun: kd.kalanGun };
    if (donem === 'deneme') tur = 'ilk';
    else if (donem === 'yenileme') tur = 'yenileme';
    else {
        if (cikan.length || limitKuculur) {
            const acilis = yenilemeAcilisi(kd);
            const parca = [];
            if (cikan.length) parca.push('Dönem içinde modül çıkarılamaz: ' + cikan.map((m) => modulAdi(kd.tam, m)).join(', ') + '.');
            if (limitKuculur) {
                parca.push('Dönem içinde daha küçük masa paketine geçilemez (mevcut sınırınız '
                    + (kd.mevcutLimit == null ? 'sınırsız' : kd.mevcutLimit + ' masa') + ').');
            }
            parca.push(`Bu değişiklikleri yenilemede yapabilirsiniz (${TARIH(acilis)} tarihinden itibaren).`);
            throw hata(409, parca.join(' '), 'DONEM_ICI_AZALTMA',
                { cikanModuller: cikan, mevcutMasaLimiti: kd.mevcutLimit, yenilemeAcilis: acilis });
        }
        if (!eklenen.length && !limitBuyur) tur = 'yenileme';    // ayni secim: erken yenileme
        else { tur = 'yukseltme'; kredi = await krediHesapla(kd, simdi); }
    }

    const yeniToplam = f.total;
    const krediTutari = tur === 'yukseltme' ? kredi.krediTutari : 0;
    const odenecek = Math.max(0, yuvarla(yeniToplam - krediTutari));
    const degisiyor = eklenen.length > 0 || cikan.length > 0 || (kd.t.license_tier || null) !== tier;
    return {
        ...f, tur, donem, yeniToplam, krediTutari, odenecek,
        kalanGun: tur === 'yukseltme' ? kredi.kalanGun : kd.kalanGun,
        krediKaynak: tur === 'yukseltme' ? kredi.kaynak : null,
        krediAyrinti: tur === 'yukseltme' ? { yillikDeger: kredi.yillikDeger, donemGun: kredi.donemGun } : null,
        eklenenModuller: eklenen, cikanModuller: cikan,
        onceki: { tier: kd.t.license_tier || null, moduller: M.modulListesi(kd.t.license_modules), bitis: kd.t.license_end_date || null },
        aciklama: aciklamaYaz({ tur, kd, krediTutari, kalanGun: kredi.kalanGun, yeniToplam, degisiyor }),
    };
}

// Onayda yeni bitis: ilk ve yukseltmede onay gunu + gun; yenilemede ve eski kayitta (tur yok) mevcut bitisin
// uzerine (bitmisse onay gunu + gun).
function onayBitisi({ tur, mevcutBitis, gun = YIL_GUN, simdi = new Date() }) {
    if (tur === 'yukseltme' || tur === 'ilk') return new Date(simdi.getTime() + gun * GUN_MS).toISOString();
    const { yeniBitis } = require('./posProvizyon');
    return yeniBitis(mevcutBitis, gun);
}

// Talepten sonra lisans elle degisti mi? (onay ekranindaki uyari). Eski kayitta (kopya yok) bos liste.
function lisansDegisiklikleri(o, t, tam) {
    if (o.onceki_tier == null && o.onceki_moduller == null && o.onceki_bitis == null) return [];
    const d = [];
    if ((o.onceki_tier || null) !== (t.license_tier || null)) {
        d.push(`Paket: talep anında ${tierAdi(tam, o.onceki_tier)}, şimdi ${tierAdi(tam, t.license_tier)}`);
    }
    const a = M.modulListesi(o.onceki_moduller);
    const b = M.modulListesi(t.license_modules);
    const sonradanEklenen = b.filter((m) => !a.includes(m));
    const sonradanCikan = a.filter((m) => !b.includes(m));
    if (sonradanEklenen.length || sonradanCikan.length) {
        const ad = (l) => l.map((m) => (m === 'ALL' ? 'Tüm modüller' : modulAdi(tam, m))).join(', ');
        d.push('Modüller: ' + [sonradanEklenen.length ? 'sonradan eklenen ' + ad(sonradanEklenen) : '',
            sonradanCikan.length ? 'sonradan çıkan ' + ad(sonradanCikan) : ''].filter(Boolean).join('; '));
    }
    const ta = tarihOku(o.onceki_bitis), tb = tarihOku(t.license_end_date);
    if ((ta ? ta.getTime() : null) !== (tb ? tb.getTime() : null)) {
        d.push(`Bitiş: talep anında ${TARIH(o.onceki_bitis)}, şimdi ${TARIH(t.license_end_date)}`);
    }
    return d;
}

module.exports = {
    YENILEME_ESIGI_GUN, YIL_GUN, tarihOku, kalanGunHesapla, kiraciDurumu, donemTuru, donemBilgisi, mevcutPaketDegeri,
    krediHesapla, teklifHazirla, onayBitisi, lisansDegisiklikleri, TL, TARIH, tierAdi, modulAdi,
};
