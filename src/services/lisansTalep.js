const { query } = require('../config/db');
const K = require('./lisansKatalog');
const M = require('./lisansModul');
const { fiyatla, yuvarla, hata } = require('./lisansFiyat');
const GH = require('./gecisHaklari');
const { kdvHesapla } = require('./lisansKdv');

// --- Lisans talebi: deneme -> paket -> yukseltme (Patron karari 2026-11-11) ---
//
// Tur talep aninda belirlenir ve teklif KILITLENIR (lisans_odemeleri'ne yazilir, onayda yeniden hesaplanmaz):
//   ilk        DENEME SINIFINDAKI isletmenin ilk alimi (guvenlik incelemesi O1, 2026-11-12): TIER_DENEME ya da
//              "Kayit ol" formuyla acilan kademeli deneme (yonetimOzet.isletmeSinifi; yonetim paneliyle ayni kural).
//              Odeme kaydi olmayan ama deneme olmayan isletme (TIER_MUSTERI, root'un actigi) normal yenileme /
//              yukseltme yapar. Secim serbest. Onayda lisans ONAY GUNUNDEN baslar, 1 yil (kalan gun yok, kredi yok).
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
// Kayittaki moduller ODENEN secimdir. Onayda yeni liste = odenen + korunan (satista olmayan mevcut moduller;
// deneme ise yalniz aktif pazaryeri kanali varsa MARKETPLACE). Korunan hesap ONAY ANINDAKI lisansa gore yapilir
// (lisansModul.korunacakModuller): deploy oncesi acilmis bekleyen kayitlar da Masadan Siparis'i kaybetmez.
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
// Katalogda olmayan ozel paket kodlari (deneme, elle musteri, SofraMix, kurum): ham kod gosterilmesin
const OZEL_TIER_AD = { TIER_DENEME: 'Deneme sürümü', TIER_MUSTERI: 'Müşteri paketi', TIER_SOFRAMIX: 'SofraMix paketi', TIER_KURUM: 'Kurum lisansı' };
const tierAdi = (tam, k) => (k === M.MENU_TIER ? 'QR Menü paketi'
    : k ? (((tam.find((x) => x.tur === 'TIER' && x.kod === k) || {}).ad) || OZEL_TIER_AD[k] || k) : '-');

// Satistaki (satin alinabilir) modul kodlari
const satistakiModuller = (tam) => new Set(tam.filter((x) => x.tur === 'MODUL' && Number(x.gorunur) === 1).map((x) => x.kod));

// Isletmenin aktif pazaryeri kanali var mi (siparis cekme dongusunun taradigi kosullar: kanal aktif ve adaptorlu,
// magaza baglantisi aktif, kimlik bilgisi aktif)
async function aktifPazaryeriKanali(tenantId) {
    try {
        const r = await query(
            `SELECT 1 FROM marketplace_channels c
               JOIN marketplace_store_links l ON l.channel_id = c.id AND l.is_active = 1
              WHERE c.tenant_id = ? AND c.is_active = 1 AND c.adapter_code IS NOT NULL AND c.adapter_code <> ''
                AND EXISTS (SELECT 1 FROM marketplace_credentials k WHERE k.channel_id = c.id AND k.status = 'active')
              LIMIT 1`, [tenantId]);
        return r.rows.length > 0;
    } catch (_) { return false; }
}

// Odeme gecmisi var mi: onayli ve tutari > 0 lisans odemesi ya da islenmis SofraMix provizyonu (pos_provizyon).
// Yoksa isletmenin alimi "ilk" sayilir ve satista olmayan modulleri korunmaz (deneme hakki odenmis bir hak degil).
async function odemeGecmisiVar(tenantId) {
    const r = await query(
        `SELECT (SELECT COUNT(*) FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'onaylandi' AND COALESCE(tutar, 0) > 0)
              + (SELECT COUNT(*) FROM pos_provizyon WHERE tenant_id = ? AND durum = 'islendi') AS n`, [tenantId, tenantId]);
    return Number(r.rows[0].n) > 0;
}

// DENEME SINIFI (karar 2026-11-12, guvenlik incelemesi O1): "ilk alim" turu ve korumasiz onay YALNIZ deneme
// sinifindaki isletmede: TIER_DENEME ya da kayit formu denemesi (yonetimOzet.isletmeSinifi; yonetim paneliyle ayni
// kural, tek yer). Odeme kaydi olmayan ama deneme sinifinda olmayan isletme (TIER_MUSTERI, root'un actigi, kademeli
// ama kaydi yok) normal yenileme / yukseltme yapar: bitisin uzerine eklenir, kredi katalog fiyatindan hesaplanir.
// (Eskiden odeme gecmisine bakiliyordu: odeme kaydi olmayan TIER_20_PLUS ayni paketi yenileyince "ilk" sayilip kalan
// gunlerini kaybediyordu.)
async function denemeSinifiMi(tenantId) {
    return (await require('./yonetimOzet').isletmeSinifi(tenantId)) === 'deneme';
}

// Onayda (ve teklif onizlemesinde) korunacak moduller. t: { id, license_tier, license_modules }
// Deneme sinifinda koruma yok (aktif pazaryeri kanali istisnasi: MARKETPLACE). Eski musteri haklari
// (services/gecisHaklari.js) her durumda korunur.
async function korunanHesapla(t, odenen, tam) {
    const deneme = await denemeSinifiMi(t.id);
    const aktifKanal = deneme ? await aktifPazaryeriKanali(t.id) : false;
    const eskiHak = await GH.aktifHak(t.id);
    return M.korunacakModuller({
        mevcut: t.license_modules, odenen, satinAlinabilir: satistakiModuller(tam), deneme, aktifKanal, eskiHak,
    });
}

// Onayda yazilacak modul listesi: odenen (kayittaki secim) + korunan. eskiHak: korunanlardan eski hak olanlar.
async function onayModulleri(o, t, tam) {
    const odenen = M.modulListesi(o.moduller);
    const korunan = await korunanHesapla(t, odenen, tam);
    const hak = await GH.aktifHak(t.id);
    return { odenen, korunan, moduller: [...odenen, ...korunan], eskiHak: korunan.filter((m) => hak.includes(m)) };
}

// Isletmenin bugunku lisansi + katalog bilgisi
async function kiraciDurumu(tenantId, simdi = new Date()) {
    const t = (await query(
        `SELECT id, license_tier, license_modules, license_end_date, license_table_limit, discount_rate
           FROM tenants WHERE id = ?`, [tenantId])).rows[0];
    if (!t) throw hata(404, 'İşletme bulunamadı.');
    const tam = await K.tamKatalog();
    const modulSatirlari = tam.filter((x) => x.tur === 'MODUL');
    const katalogKodlari = new Set(modulSatirlari.map((x) => x.kod));
    const satista = satistakiModuller(tam);
    const ham = M.modulListesi(t.license_modules);
    // 'ALL' butun katalog modulleri demek
    const sahip = ham.includes('ALL') ? modulSatirlari.map((x) => x.kod) : ham.filter((m) => m !== 'ALL');
    // Sahip olunan ama satista olmayan moduller (gizli ya da katalogda olmayan eski kod): satin alinamaz,
    // istekte gelirse secim sayilmaz; onayda korunur (deneme haric)
    const satistaOlmayan = ham.filter((m) => !satista.has(m));
    const mevcutTier = t.license_tier ? (tam.find((x) => x.tur === 'TIER' && x.kod === t.license_tier) || null) : null;
    // Masa siniri karsilastirmasi: paket katalogdaysa paketin siniri (eski kayitlarda sutun bos kalmis olabilir),
    // degilse sutundaki deger. null = sinirsiz.
    const mevcutLimit = mevcutTier ? mevcutTier.masa_limiti : t.license_table_limit;
    return {
        t, tam, katalogKodlari, satista, sahip, satistaOlmayan, mevcutTier, mevcutLimit: mevcutLimit == null ? null : Number(mevcutLimit),
        deneme: await denemeSinifiMi(t.id), tierDeneme: t.license_tier === 'TIER_DENEME',
        kalanGun: kalanGunHesapla(t.license_end_date, simdi),
        // Eski musteri hakki: lisansta hala olan haklar (ucrete girmez, sepette kaldirilamaz)
        eskiHak: (await GH.aktifHak(t.id)).filter((m) => M.varMi(ham, m)),
    };
}

// GARSON'a zaten sahip (deneme disi) isletme yenilemede Garson'u Adisyon ve Kasa olmadan da secebilir (eski kural)
function garsonBasesizIzinli(kd) {
    return !kd.deneme && kd.sahip.includes('GARSON');
}

// 'deneme' (odeme gecmisi yok: ilk alim) | 'yenileme' (bitise <= 30 gun, bitmis ya da tarihsiz) | 'donemIci'
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
        mevcut: { tier: kd.t.license_tier || null, masaLimiti: kd.mevcutLimit, moduller: kd.sahip,
                  korunan: kd.deneme ? [] : kd.satistaOlmayan.filter((m) => m !== 'ALL' && kd.katalogKodlari.has(m)),
                  eskiHak: kd.eskiHak, adisyon: M.varMi(kd.sahip, 'BASE'), garsonBasesizIzinli: garsonBasesizIzinli(kd) },
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
        if ((kd.eskiHak || []).includes(m)) continue;   // eski musteri hakki ucretsiz
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

function aciklamaYaz({ tur, kd, krediTutari, kalanGun, yeniToplam, degisiyor, uzunDonem }) {
    if (tur === 'yukseltme') {
        let s = uzunDonem
            ? `Kalan ${kalanGun} gününüz ${TL(krediTutari)} olarak düşüldü. Mevcut bitiş tarihiniz (${TARIH(kd.t.license_end_date)}) `
                + 'korunur: yeni paketiniz ödemeniz onaylandığı gün başlar ve bu tarihe kadar geçerli olur. Tutar, kalan sürenin '
                + `tamamı (${kalanGun} gün) için hesaplanmıştır; o güne kadar mevcut paketiniz aynen çalışır.`
            : `Kalan ${kalanGun} gününüz ${TL(krediTutari)} olarak düşüldü. Yeni 1 yıllık süreniz ödemeniz onaylandığı gün başlar; `
                + 'o güne kadar mevcut paketiniz aynen çalışır.';
        if (krediTutari > yeniToplam) {
            s += ' Kalan sürenizin karşılığı yeni paketin tutarından fazla olduğu için ödenecek tutar 0 TL\'dir; aradaki fark iade edilmez.';
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
    // Lansman kampanyasi yalniz ilk alimda (deneme sinifi) ve birlesmez: indirim = en buyuk(kampanya, kiraci indirimi).
    // Kiraci indirimi buyuk ya da esitse kampanya uygulanmaz (services/lansmanKampanya.js).
    let kampanya = null;
    if (kd.deneme) {
        const u = await require('./lansmanKampanya').uygunluk(tenantId, simdi).catch(() => null);
        if (u && u.uygun && Number(u.yuzde) > (Number(kd.t.discount_rate) || 0)) kampanya = { oran: Number(u.yuzde), sonGun: u.sonGun };
    }
    const f = await fiyatla({ tier, modules, indirimOrani: kampanya ? kampanya.oran : kd.t.discount_rate, yoksay: [...kd.satistaOlmayan, ...kd.eskiHak],
        garsonBasesizIzinli: garsonBasesizIzinli(kd) });
    const donem = donemTuru(kd);
    // Onayda korunacaklar (onizleme; onayda o anki lisansa gore yeniden hesaplanir)
    const korunan = await korunanHesapla(kd.t, f.modules, kd.tam);
    const sonListe = [...f.modules, ...korunan];
    const eskiHakKorunan = korunan.filter((m) => kd.eskiHak.includes(m));
    for (const m of korunan) {
        const satir = kd.tam.find((x) => x.tur === 'MODUL' && x.kod === m);
        const hak = eskiHakKorunan.includes(m);
        if (satir || (hak && M.AD[m])) {
            f.breakdown.push({ name: m, displayName: (satir && satir.ad) || M.AD[m] || m, type: 'MODULE', price: 0, korunan: true,
                ...(hak ? { eskiHak: true } : {}) });
        }
    }
    // Karsilastirma katalogdaki modullerle (katalogda olmayan eski kodlar zaten korunur)
    const karsilastir = kd.sahip.filter((m) => kd.katalogKodlari.has(m));
    const cikan = karsilastir.filter((m) => !M.varMi(sonListe, m));
    const eklenen = f.modules.filter((m) => !kd.sahip.includes(m));
    const yeniLimit = f.tableLimit == null ? null : Number(f.tableLimit);
    // Masa siniri karsilastirmasi yalniz iki tarafta da Adisyon ve Kasa varsa anlamli: yalniz QR menu paketinde
    // masa kademesi yok (QR menuden Adisyon ve Kasa'ya gecis yukseltmedir; tersi modul cikarmadir)
    const ikisindeAdisyon = M.varMi(kd.sahip, 'BASE') && M.varMi(f.modules, 'BASE');
    const limitKuculur = ikisindeAdisyon && sinir(yeniLimit) < sinir(kd.mevcutLimit);
    const limitBuyur = ikisindeAdisyon && sinir(yeniLimit) > sinir(kd.mevcutLimit);

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
    // Yukseltmede mevcut bitis 1 yildan ilerideyse (erken yenileme sonrasi) bitis KORUNUR (onayBitisi: en gec olan):
    // yeni paket o tarihe kadar gecerli olur, bu yuzden tutar da o sureye oranlanir (kredi zaten kalan gunun tamamini
    // kapsiyor). 1 yil ya da daha az kaldiysa eskisi gibi: yillik toplam - kredi.
    const uzunDonem = tur === 'yukseltme' && Number(kredi.kalanGun) > YIL_GUN;
    const donemTutari = uzunDonem ? yuvarla(yeniToplam * Number(kredi.kalanGun) / YIL_GUN) : yeniToplam;
    const odenecek = Math.max(0, yuvarla(donemTutari - krediTutari));
    // KDV (katalog fiyatlari KDV haric): araToplam = odenecek, genelToplam = havale tutari (bkz services/lisansKdv.js)
    const kdv = kdvHesapla(odenecek);
    // Masa siniri (2026-11-18): aktif masa yeni sinirin uzerindeyse satin almada uyari + onay kutusu, root onayinda
    // tum masalar pasife alinir (services/masaSiniri.js). Sinir null = sinirsiz.
    const aktifMasa = await require('./masaSiniri').aktifSayi(tenantId);
    const masaUyarisi = f.tableLimit != null && aktifMasa > Number(f.tableLimit);
    const degisiyor = eklenen.length > 0 || cikan.length > 0 || (kd.t.license_tier || null) !== (f.tier || M.MENU_TIER);
    return {
        ...f, modules: sonListe, odenenModuller: f.modules, korunanModuller: korunan, eskiHakModuller: eskiHakKorunan,
        tur, donem, yeniToplam, krediTutari, odenecek, donemTutari, uzunDonem, aktifMasa, masaUyarisi,
        kampanyaOrani: kampanya ? kampanya.oran : null, kampanyaSonGun: kampanya ? kampanya.sonGun : null,
        araToplam: kdv.araToplam, kdvOrani: kdv.kdvOrani, kdvTutari: kdv.kdvTutari, genelToplam: kdv.genelToplam,
        kalanGun: tur === 'yukseltme' ? kredi.kalanGun : kd.kalanGun,
        krediKaynak: tur === 'yukseltme' ? kredi.kaynak : null,
        krediAyrinti: tur === 'yukseltme' ? { yillikDeger: kredi.yillikDeger, donemGun: kredi.donemGun } : null,
        eklenenModuller: eklenen, cikanModuller: cikan,
        onceki: { tier: kd.t.license_tier || null, moduller: M.modulListesi(kd.t.license_modules), bitis: kd.t.license_end_date || null },
        aciklama: aciklamaYaz({ tur, kd, krediTutari, kalanGun: kredi.kalanGun, yeniToplam: donemTutari, degisiyor, uzunDonem }),
    };
}

// Onayda yeni bitis: ilk ve yukseltmede onay gunu + gun; yenilemede ve eski kayitta (tur yok) mevcut bitisin
// uzerine (bitmisse onay gunu + gun).
// Yukseltmede bitis ASLA geri gitmez (2026-11-18): yeni bitis = en gec(onay gunu + gun, mevcut bitis). Erken yenileme
// ardindan yapilan yukseltme odenmis sureyi kisaltmasin (teklif de bu sureye gore fiyatlanir: teklifHazirla uzunDonem).
function onayBitisi({ tur, mevcutBitis, gun = YIL_GUN, simdi = new Date() }) {
    if (tur === 'yukseltme') {
        const b = tarihOku(mevcutBitis);
        return new Date(Math.max(simdi.getTime() + gun * GUN_MS, b ? b.getTime() : 0)).toISOString();
    }
    if (tur === 'ilk') return new Date(simdi.getTime() + gun * GUN_MS).toISOString();
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
    satistakiModuller, aktifPazaryeriKanali, korunanHesapla, onayModulleri, odemeGecmisiVar, denemeSinifiMi,
};
