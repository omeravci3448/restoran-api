const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');

// --- Menu ice aktarma ("Kurulumu biz yapiyoruz" hizmeti) ---
// Isletmenin menu fotograflarindan hazirlanan JSON ya da CSV dosyasi root panelinden ice aktarilir.
// Bicim rehberi: docs/menu_ice_aktar.md
//  - onizleme: hicbir sey YAZMAZ; sayilar + yeni / guncellenen / atlanan listeleri + uyarilar + hatalar doner
//  - aktarma: TEK transaction; plan transaction ICINDE taze okunarak yeniden kurulur. Hata olursa hicbir sey yazilmaz.
//  - mod 'ekle': mevcut urunler korunur; ayni kategoride ayni adli urun atlanir
//  - mod 'guncelle': ayni adli urunun fiyati, aciklamasi ve dosyada verilen seffaf menu alanlari guncellenir
//  - HICBIR SEY SILINMEZ; mevcut urunun satista olup olmadigina (is_available) dokunulmaz.
// Fiyati olmayan (ya da 0 olan) YENI urun 0 TL ve PASIF eklenir: kazara bedava satilamaz (SofraMix aktarimindaki kural).

const MAKS_METIN = 2000000;     // ~2 MB
const MAKS_SATIR = 2000;
const MAKS_AD = 150;
const MAKS_ACIKLAMA = 1000;
const MAKS_ICINDEKILER = 2000;
const MAKS_FIYAT = 1000000;
const MAKS_HATA = 50;

// 14 zorunlu alerjen grubu (fe/pos-admin/src/seffafMenu.js ile ayni anahtarlar)
const ALERJEN_KODLARI = ['gluten', 'kabuklu_deniz', 'yumurta', 'balik', 'yer_fistigi', 'soya', 'sut', 'sert_kabuklu',
    'kereviz', 'hardal', 'susam', 'sulfit', 'lupin', 'yumusakca'];
// Es anlamlar: SofraMix kodlari ve Turkce adlar (katlanmis bicimde)
const ALERJEN_ESANLAM = {
    kabuklu: 'kabuklu_deniz', kabuklu_deniz_urunleri: 'kabuklu_deniz', karides: 'kabuklu_deniz',
    yerfistigi: 'yer_fistigi', fistik: 'yer_fistigi',
    sertkabuklu: 'sert_kabuklu', sert_kabuklu_yemisler: 'sert_kabuklu', findik: 'sert_kabuklu', ceviz: 'sert_kabuklu',
    lupen: 'lupin', aci_bakla: 'lupin',
    yumusakcalar: 'yumusakca', midye: 'yumusakca',
    laktoz: 'sut', sut_laktoz: 'sut',
    sulfitler: 'sulfit', kukurt_dioksit: 'sulfit',
    gluten_iceren_tahillar: 'gluten', bugday: 'gluten',
    balik_urunleri: 'balik', soya_fasulyesi: 'soya',
};

// Turkce harfleri katlar (karsilastirma ve anahtar okuma icin)
function katla(s) {
    return String(s == null ? '' : s).trim().toLocaleLowerCase('tr-TR')
        .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u')
        .replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u');
}
const kodla = (s) => katla(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
// Ad karsilastirma anahtari: bosluklar sadelesir, Turkce kucuk harf
const adAnahtari = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
const sade = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

function alerjenKodu(ham) {
    const k = kodla(ham);
    if (!k) return null;
    if (ALERJEN_KODLARI.includes(k)) return k;
    if (ALERJEN_ESANLAM[k]) return ALERJEN_ESANLAM[k];
    const bitisik = k.replace(/_/g, '');
    const es = ALERJEN_KODLARI.find((a) => a.replace(/_/g, '') === bitisik);
    return es || null;
}

// Fiyat: sayi ya da "125", "125,50", "1.250", "1.250,00", "125 TL"
function fiyatCoz(v) {
    if (v == null) return { yok: true };
    if (typeof v === 'number') return Number.isFinite(v) ? { deger: Math.round(v * 100) / 100 } : { hata: true };
    let s = String(v).trim();
    if (!s) return { yok: true };
    s = s.replace(/₺/g, '').replace(/\b(tl|try)\b/gi, '').replace(/\s+/g, '');
    if (!/^-?[\d.,]+$/.test(s)) return { hata: true };
    const n = s.lastIndexOf('.'), v2 = s.lastIndexOf(',');
    if (n >= 0 && v2 >= 0) {
        s = v2 > n ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (v2 >= 0) {
        if ((s.match(/,/g) || []).length > 1) return { hata: true };
        s = s.replace(',', '.');
    } else if (n >= 0) {
        // "1.250" ya da "1.250.000" binlik ayiricidir; "12.5" ondaliktir
        if ((s.match(/\./g) || []).length > 1 || /^-?\d{1,3}\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
    }
    const d = Number(s);
    return Number.isFinite(d) ? { deger: Math.round(d * 100) / 100 } : { hata: true };
}

function aktifCoz(v) {
    if (v == null || v === '') return { deger: true };
    if (typeof v === 'boolean') return { deger: v };
    if (typeof v === 'number') return { deger: v !== 0 };
    const k = katla(v);
    if (['1', 'evet', 'e', 'aktif', 'acik', 'var', 'true', 'satista'].includes(k)) return { deger: true };
    if (['0', 'hayir', 'h', 'pasif', 'kapali', 'yok', 'false'].includes(k)) return { deger: false };
    return { deger: true, tanimsiz: true };
}

function tamSayiCoz(v) {
    if (v == null || v === '') return { yok: true };
    const d = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!Number.isFinite(d) || d < 0 || d > 100000) return { hata: true };
    return { deger: Math.round(d) };
}

// --- JSON okuma ---
function jsonOku(metin) {
    let s = String(metin).trim().replace(/^﻿/, '');
    // Kod blogu isaretleri (```json ... ```) varsa ayiklanir
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
    let v;
    try { v = JSON.parse(s); } catch (e) { return { hatalar: ['JSON okunamadı: ' + String(e.message || '').slice(0, 160)] }; }
    if (Array.isArray(v)) v = { urunler: v };
    if (!v || typeof v !== 'object') return { hatalar: ['JSON bir nesne olmalı: {"kategoriler": [...], "urunler": [...]}'] };
    if (v.kategoriler != null && !Array.isArray(v.kategoriler)) return { hatalar: ['"kategoriler" bir liste olmalı.'] };
    if (!Array.isArray(v.urunler)) return { hatalar: ['"urunler" listesi bulunamadı.'] };
    const kategoriler = (v.kategoriler || []).map((k, i) => {
        const o = (k && typeof k === 'object') ? k : { ad: k };
        return { ad: o.ad, sira: o.sira, yer: `${i + 1}. kategori` };
    });
    const urunler = v.urunler.map((u, i) => ({ ...((u && typeof u === 'object') ? u : {}), _bos: !(u && typeof u === 'object'), yer: `${i + 1}. ürün` }));
    return { kategoriler, urunler, kategoriListesiVar: kategoriler.length > 0, hatalar: [] };
}

// --- CSV okuma (noktali virgul, virgul ya da sekme; ilk satir baslik) ---
function csvKayitlari(metin, ayirici) {
    const kayitlar = [];
    let kayit = [], alan = '', tirnak = false, alanBasi = true;
    for (let i = 0; i < metin.length; i++) {
        const c = metin[i];
        if (tirnak) {
            if (c === '"') { if (metin[i + 1] === '"') { alan += '"'; i++; } else tirnak = false; }
            else alan += c;
            continue;
        }
        if (c === '"' && alanBasi) { tirnak = true; alanBasi = false; continue; }
        if (c === ayirici) { kayit.push(alan); alan = ''; alanBasi = true; continue; }
        if (c === '\n') { kayit.push(alan); kayitlar.push(kayit); kayit = []; alan = ''; alanBasi = true; continue; }
        if (c === '\r') continue;
        alan += c; alanBasi = false;
    }
    if (alan !== '' || kayit.length) { kayit.push(alan); kayitlar.push(kayit); }
    return kayitlar;
}
const SUTUN = {
    kategori: 'kategori', kategori_adi: 'kategori',
    urun: 'ad', urun_adi: 'ad', ad: 'ad', adi: 'ad', isim: 'ad',
    fiyat: 'fiyat', fiyat_tl: 'fiyat', fiyati: 'fiyat',
    aciklama: 'aciklama',
    aktif: 'aktif', durum: 'aktif', satista: 'aktif',
    alerjenler: 'alerjenler', alerjen: 'alerjenler',
    icindekiler: 'icindekiler', bilesenler: 'icindekiler',
    kalori: 'kalori', kcal: 'kalori',
    porsiyon: 'porsiyon', porsiyon_gram: 'porsiyon', gramaj: 'porsiyon',
    gorsel: 'gorsel', gorsel_url: 'gorsel', resim: 'gorsel',
};
function csvOku(metin) {
    const s = String(metin).replace(/^﻿/, '');
    const ilk = (s.split('\n')[0] || '');
    const say = (ch) => ilk.split(ch).length - 1;
    const adaylar = [[';', say(';')], [',', say(',')], ['\t', say('\t')]].sort((a, b) => b[1] - a[1]);
    const ayirici = adaylar[0][1] > 0 ? adaylar[0][0] : ';';
    const kayitlar = csvKayitlari(s, ayirici);
    if (!kayitlar.length) return { hatalar: ['CSV boş.'] };
    const baslik = kayitlar[0].map((b) => SUTUN[kodla(b)] || null);
    const uyarilar = [];
    const tanimsiz = kayitlar[0].filter((b, i) => !baslik[i] && String(b).trim());
    if (tanimsiz.length) uyarilar.push('Tanınmayan sütunlar yok sayıldı: ' + tanimsiz.map((x) => String(x).trim()).join(', '));
    const eksik = ['kategori', 'ad', 'fiyat'].filter((k) => !baslik.includes(k));
    if (eksik.length) {
        const ad = { kategori: 'kategori', ad: 'urun', fiyat: 'fiyat' };
        return { hatalar: ['Başlık satırında şu sütunlar yok: ' + eksik.map((k) => ad[k]).join(', ') + '. Beklenen başlık: kategori;urun;fiyat;aciklama;aktif'] };
    }
    const urunler = [];
    for (let i = 1; i < kayitlar.length; i++) {
        const k = kayitlar[i];
        if (k.every((x) => !String(x).trim())) continue;   // bos satir
        const u = { yer: `${i + 1}. satır` };
        baslik.forEach((alan, j) => { if (alan && u[alan] === undefined) u[alan] = k[j] === undefined ? undefined : String(k[j]).trim(); });
        if (u.alerjenler != null) u.alerjenler = String(u.alerjenler).split(/[|,;/]/).map((x) => x.trim()).filter(Boolean);
        urunler.push(u);
    }
    return { kategoriler: [], urunler, kategoriListesiVar: false, hatalar: [], uyarilar };
}

// --- Satir dogrulama: ham satir -> temiz urun ---
function satirDogrula(u, hatalar, uyarilar, bilinmeyenAlerjen) {
    const yer = u.yer;
    if (u._bos) { hatalar.push(`${yer}: ürün bir nesne olmalı.`); return null; }
    const kategori = sade(u.kategori);
    const ad = sade(u.ad != null ? u.ad : u.urun);
    let gecerli = true;
    if (!kategori) { hatalar.push(`${yer}${ad ? ' (' + ad + ')' : ''}: kategori boş.`); gecerli = false; }
    if (!ad) { hatalar.push(`${yer}: ürün adı boş.`); gecerli = false; }
    if (ad.length > MAKS_AD) { hatalar.push(`${yer}: ürün adı en fazla ${MAKS_AD} karakter olabilir.`); gecerli = false; }
    if (kategori.length > MAKS_AD) { hatalar.push(`${yer}: kategori adı en fazla ${MAKS_AD} karakter olabilir.`); gecerli = false; }
    const f = fiyatCoz(u.fiyat);
    if (f.hata) { hatalar.push(`${yer} (${ad || '-'}): fiyat okunamadı ("${String(u.fiyat).slice(0, 30)}").`); gecerli = false; }
    else if (f.deger != null && f.deger < 0) { hatalar.push(`${yer} (${ad || '-'}): fiyat eksi olamaz.`); gecerli = false; }
    else if (f.deger != null && f.deger > MAKS_FIYAT) { hatalar.push(`${yer} (${ad || '-'}): fiyat çok yüksek (${f.deger}).`); gecerli = false; }
    const aciklama = u.aciklama == null ? '' : String(u.aciklama).trim();
    if (aciklama.length > MAKS_ACIKLAMA) { hatalar.push(`${yer} (${ad || '-'}): açıklama en fazla ${MAKS_ACIKLAMA} karakter olabilir.`); gecerli = false; }
    const icindekiler = u.icindekiler == null ? '' : String(u.icindekiler).trim();
    if (icindekiler.length > MAKS_ICINDEKILER) { hatalar.push(`${yer} (${ad || '-'}): içindekiler en fazla ${MAKS_ICINDEKILER} karakter olabilir.`); gecerli = false; }
    if (!gecerli) return null;

    const a = aktifCoz(u.aktif);
    if (a.tanimsiz) uyarilar.push(`${yer} (${ad}): "aktif" değeri anlaşılamadı ("${String(u.aktif).slice(0, 20)}"), aktif kabul edildi.`);

    // Alerjenler: verilmediyse NULL ("isletme beyan etmedi"); bos liste de NULL (urun ekleme ekraniyla ayni)
    let alerjenler;
    if (u.alerjenler != null) {
        const liste = Array.isArray(u.alerjenler) ? u.alerjenler : String(u.alerjenler).split(/[|,;/]/);
        const kodlar = [];
        for (const x of liste) {
            if (!String(x).trim()) continue;
            const k = alerjenKodu(x);
            if (k) { if (!kodlar.includes(k)) kodlar.push(k); } else bilinmeyenAlerjen.add(String(x).trim());
        }
        alerjenler = kodlar.length ? kodlar : null;
    }
    const kal = tamSayiCoz(u.kalori), por = tamSayiCoz(u.porsiyon);
    if (kal.hata) uyarilar.push(`${yer} (${ad}): kalori okunamadı, yok sayıldı.`);
    if (por.hata) uyarilar.push(`${yer} (${ad}): porsiyon gramajı okunamadı, yok sayıldı.`);
    let gorsel = null;
    if (u.gorsel != null && String(u.gorsel).trim()) {
        const g = String(u.gorsel).trim();
        if (/^https:\/\/[^\s"'<>]+$/i.test(g) && g.length <= 1000) gorsel = g;
        else uyarilar.push(`${yer} (${ad}): görsel adresi "https://" ile başlamalı, yok sayıldı.`);
    }
    return {
        yer, kategori, ad, fiyat: f.yok ? null : f.deger, aciklama: aciklama || null, aktif: a.deger,
        alerjenler: alerjenler === undefined ? undefined : alerjenler,
        icindekiler: icindekiler || null, kalori: kal.deger ?? null, porsiyon: por.deger ?? null, gorsel,
    };
}

// --- Plan: ne eklenecek / guncellenecek / atlanacak (DB'ye yazmaz) ---
async function planla(tenantId, okunan, mod) {
    const hatalar = [...(okunan.hatalar || [])];
    const uyarilar = [...(okunan.uyarilar || [])];
    const bilinmeyenAlerjen = new Set();

    if (!hatalar.length && !okunan.urunler.length) hatalar.push('Dosyada ürün yok.');
    if (okunan.urunler && okunan.urunler.length > MAKS_SATIR) hatalar.push(`En fazla ${MAKS_SATIR} ürün aktarılabilir (dosyada ${okunan.urunler.length} var).`);
    const satirlar = hatalar.length ? [] : okunan.urunler.map((u) => satirDogrula(u, hatalar, uyarilar, bilinmeyenAlerjen)).filter(Boolean);
    for (const k of okunan.kategoriler || []) {
        if (!sade(k.ad)) hatalar.push(`${k.yer}: kategori adı boş.`);
        else if (sade(k.ad).length > MAKS_AD) hatalar.push(`${k.yer}: kategori adı en fazla ${MAKS_AD} karakter olabilir.`);
    }

    const mevcutKat = (await query(
        'SELECT id, name, sort_order FROM categories WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order, created_at', [tenantId])).rows;
    const katHarita = new Map();
    for (const k of mevcutKat) if (!katHarita.has(adAnahtari(k.name))) katHarita.set(adAnahtari(k.name), { id: k.id, ad: k.name, mevcut: true });
    let katSira = mevcutKat.reduce((m, k) => Math.max(m, Number(k.sort_order) || 0), 0);

    const yeniKategoriler = [], kullanilanMevcut = [];
    const tanimli = new Set();
    const katEkle = (ad, sira) => {
        const anahtar = adAnahtari(ad);
        const var_ = katHarita.get(anahtar);
        if (var_) { if (var_.mevcut && !kullanilanMevcut.includes(var_.ad)) kullanilanMevcut.push(var_.ad); return var_; }
        const s = Number.isFinite(Number(sira)) && sira !== '' && sira != null ? Math.round(Number(sira)) : ++katSira;
        const yeni = { id: null, ad: sade(ad), mevcut: false, sira: s };
        katHarita.set(anahtar, yeni); yeniKategoriler.push(yeni);
        return yeni;
    };
    for (const k of okunan.kategoriler || []) {
        if (!sade(k.ad)) continue;
        const anahtar = adAnahtari(k.ad);
        if (tanimli.has(anahtar)) { uyarilar.push(`"${sade(k.ad)}" kategorisi listede iki kez var, bir kez alındı.`); continue; }
        tanimli.add(anahtar);
        katEkle(k.ad, k.sira);
    }

    const mevcutUrun = (await query(
        'SELECT id, category_id, name, price, description, allergens, ingredients, calories, portion_grams, sort_order FROM products WHERE tenant_id = ?',
        [tenantId])).rows;
    const urunHarita = new Map();
    const urunSira = new Map();
    for (const p of mevcutUrun) {
        const a = (p.category_id || '') + '|' + adAnahtari(p.name);
        if (!urunHarita.has(a)) urunHarita.set(a, p);
        urunSira.set(p.category_id || '', Math.max(urunSira.get(p.category_id || '') || 0, Number(p.sort_order) || 0));
    }

    const yeni = [], guncellenen = [], atlanan = [];
    const dosyada = new Set();
    const listesizKategori = [];
    let fiyatsizYeni = 0, beyansiz = 0;
    const yeniSira = new Map();
    for (const s of satirlar) {
        if (okunan.kategoriListesiVar && !tanimli.has(adAnahtari(s.kategori)) && !listesizKategori.includes(s.kategori)
            && !katHarita.has(adAnahtari(s.kategori))) listesizKategori.push(s.kategori);
        const kat = katEkle(s.kategori);
        const katAnahtar = adAnahtari(kat.ad);
        const dAnahtar = katAnahtar + '|' + adAnahtari(s.ad);
        if (dosyada.has(dAnahtar)) {
            atlanan.push({ kategori: kat.ad, ad: s.ad, neden: 'Dosyada aynı kategoride aynı adla tekrar ediyor' });
            uyarilar.push(`${s.yer}: "${s.ad}" (${kat.ad}) dosyada iki kez var; ilki alındı.`);
            continue;
        }
        dosyada.add(dAnahtar);
        const var_ = kat.mevcut ? urunHarita.get(kat.id + '|' + adAnahtari(s.ad)) : null;
        if (!var_) {
            const fiyatsiz = s.fiyat == null || s.fiyat === 0;
            if (fiyatsiz) { fiyatsizYeni++; uyarilar.push(`${s.yer} (${s.ad}): fiyat yok; ürün 0 TL ve pasif eklenir, fiyat girilince satışa açılabilir.`); }
            if (s.alerjenler == null) beyansiz++;
            const kk = kat.id || ('yeni:' + katAnahtar);
            const sira = (yeniSira.get(kk) ?? (kat.id ? (urunSira.get(kat.id) || 0) : 0)) + 1;
            yeniSira.set(kk, sira);
            yeni.push({ ...s, kategori: kat.ad, _kat: kat, fiyat: fiyatsiz ? 0 : s.fiyat, aktif: fiyatsiz ? false : s.aktif, sira });
            continue;
        }
        if (mod !== 'guncelle') {
            atlanan.push({ kategori: kat.ad, ad: s.ad, neden: 'Bu kategoride aynı adlı ürün zaten var' });
            continue;
        }
        // guncelle: fiyat, aciklama ve dosyada verilen seffaf menu alanlari
        const deg = {};
        if (s.fiyat == null || s.fiyat === 0) uyarilar.push(`${s.yer} (${s.ad}): fiyat yok; mevcut fiyat korunur.`);
        else if (Number(var_.price) !== s.fiyat) deg.price = { once: Number(var_.price), sonra: s.fiyat };
        if (s.aciklama && s.aciklama !== (var_.description || '')) deg.description = { once: var_.description || null, sonra: s.aciklama };
        if (s.alerjenler !== undefined && s.alerjenler !== null) {
            const yeniJs = JSON.stringify(s.alerjenler);
            if (yeniJs !== (var_.allergens || '')) deg.allergens = { once: var_.allergens || null, sonra: yeniJs };
        }
        if (s.icindekiler && s.icindekiler !== (var_.ingredients || '')) deg.ingredients = { once: var_.ingredients || null, sonra: s.icindekiler };
        if (s.kalori != null && s.kalori !== var_.calories) deg.calories = { once: var_.calories, sonra: s.kalori };
        if (s.porsiyon != null && s.porsiyon !== var_.portion_grams) deg.portion_grams = { once: var_.portion_grams, sonra: s.porsiyon };
        if (!Object.keys(deg).length) { atlanan.push({ kategori: kat.ad, ad: s.ad, neden: 'Değişiklik yok' }); continue; }
        guncellenen.push({
            id: var_.id, kategori: kat.ad, ad: var_.name, degisiklik: deg,
            eskiFiyat: Number(var_.price), yeniFiyat: deg.price ? deg.price.sonra : Number(var_.price),
            aciklamaDegisti: !!deg.description, seffafMenuDegisti: !!(deg.allergens || deg.ingredients || deg.calories || deg.portion_grams),
        });
    }
    if (listesizKategori.length) uyarilar.push('Kategori listesinde olmayan kategoriler ürünlerden alınarak eklendi: ' + listesizKategori.join(', '));
    if (bilinmeyenAlerjen.size) uyarilar.push('Tanınmayan alerjen kodları yok sayıldı: ' + [...bilinmeyenAlerjen].join(', ') + '. Geçerli kodlar: ' + ALERJEN_KODLARI.join(', '));
    if (beyansiz) uyarilar.push(`${beyansiz} yeni üründe alerjen bilgisi yok. Bu "alerjen içermiyor" anlamına gelmez; işletmeyle birlikte tamamlanmalıdır.`);

    const kesik = hatalar.length > MAKS_HATA ? [...hatalar.slice(0, MAKS_HATA), `... ve ${hatalar.length - MAKS_HATA} hata daha`] : hatalar;
    return { yeniKategoriler, kullanilanMevcut, yeni, guncellenen, atlanan, uyarilar, hatalar: kesik, hataSayisi: hatalar.length, fiyatsizYeni };
}

function ozetGovde(plan, { bicim, mod, onizleme }) {
    return {
        onizleme, bicim, mod,
        aktarilabilir: plan.hataSayisi === 0 && (plan.yeni.length + plan.guncellenen.length + plan.yeniKategoriler.length) > 0,
        sayilar: {
            kategoriYeni: plan.yeniKategoriler.length, kategoriMevcut: plan.kullanilanMevcut.length,
            urunYeni: plan.yeni.length, urunGuncellenen: plan.guncellenen.length, urunAtlanan: plan.atlanan.length,
            fiyatsizPasif: plan.fiyatsizYeni,
        },
        kategoriler: { yeni: plan.yeniKategoriler.map((k) => k.ad), mevcut: plan.kullanilanMevcut },
        yeni: plan.yeni.map((u) => ({ kategori: u.kategori, ad: u.ad, fiyat: u.fiyat, aktif: u.aktif })),
        guncellenen: plan.guncellenen.map((g) => ({ kategori: g.kategori, ad: g.ad, eskiFiyat: g.eskiFiyat, yeniFiyat: g.yeniFiyat,
            aciklamaDegisti: g.aciklamaDegisti, seffafMenuDegisti: g.seffafMenuDegisti })),
        atlanan: plan.atlanan,
        uyarilar: plan.uyarilar,
        hatalar: plan.hatalar,
    };
}

async function yaz(tenantId, plan) {
    for (const k of plan.yeniKategoriler) {
        k.id = uuidv4();
        await query('INSERT INTO categories (id, tenant_id, name, sort_order) VALUES (?, ?, ?, ?)', [k.id, tenantId, k.ad, k.sira]);
    }
    for (const u of plan.yeni) {
        // Restoran varsayilani: stok takibi YOK, maliyet 0 (urun ekleme ekraniyla ayni)
        await query(
            `INSERT INTO products (id, tenant_id, category_id, name, description, price, cost, image_url, tracks_stock,
                is_available, sort_order, allergens, ingredients, calories, portion_grams)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?)`,
            [uuidv4(), tenantId, u._kat.id, u.ad, u.aciklama, u.fiyat, u.gorsel, u.aktif ? 1 : 0, u.sira,
                u.alerjenler ? JSON.stringify(u.alerjenler) : null, u.icindekiler, u.kalori, u.porsiyon]);
    }
    for (const g of plan.guncellenen) {
        const alanlar = Object.keys(g.degisiklik);   // yalniz sabit sutun adlari (planla uretir)
        await query(`UPDATE products SET ${alanlar.map((a) => a + ' = ?').join(', ')} WHERE id = ? AND tenant_id = ?`,
            [...alanlar.map((a) => g.degisiklik[a].sonra), g.id, tenantId]);
    }
}

// Giris noktasi. Donus: { kod, govde, plan? }
async function iceAktar({ tenantId, bicim, veri, mod, onizleme }) {
    if (bicim !== 'json' && bicim !== 'csv') return { kod: 400, govde: { message: 'Biçim "json" ya da "csv" olmalı.' } };
    const m = mod == null || mod === '' ? 'ekle' : mod;
    if (m !== 'ekle' && m !== 'guncelle') return { kod: 400, govde: { message: 'Aktarma şekli "ekle" ya da "guncelle" olmalı.' } };
    if (typeof veri !== 'string' || !veri.trim()) return { kod: 400, govde: { message: 'Aktarılacak metin boş.' } };
    if (veri.length > MAKS_METIN) return { kod: 400, govde: { message: 'Dosya çok büyük (en fazla yaklaşık 2 MB).' } };
    const t = (await query('SELECT id, business_name FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) return { kod: 404, govde: { message: 'İşletme bulunamadı.' } };

    const okunan = bicim === 'json' ? jsonOku(veri) : csvOku(veri);
    if (!okunan.urunler) okunan.urunler = [];
    const secenek = { bicim, mod: m };

    if (onizleme) {
        const plan = await planla(tenantId, okunan, m);
        return { kod: 200, govde: ozetGovde(plan, { ...secenek, onizleme: true }) };
    }

    // Yazma: plan transaction ICINDE taze okunur; hata varsa hicbir sey yazilmaz
    let plan;
    try {
        plan = await tx(async () => {
            const p = await planla(tenantId, okunan, m);
            if (p.hataSayisi) return p;
            await yaz(tenantId, p);
            return p;
        });
    } catch (e) {
        console.error('[menu-ice-aktar] yazilamadi:', e.message);
        return { kod: 500, govde: { message: 'Menü aktarılamadı; hiçbir değişiklik yapılmadı. (' + String(e.message || 'bilinmeyen hata').slice(0, 160) + ')' } };
    }
    if (plan.hataSayisi) {
        return { kod: 400, govde: { ...ozetGovde(plan, { ...secenek, onizleme: false }), message: 'Dosyada hata var; hiçbir şey aktarılmadı. Önce önizlemedeki hataları düzeltin.' } };
    }
    return { kod: 200, govde: { ok: true, ...ozetGovde(plan, { ...secenek, onizleme: false }) }, plan, isletmeAdi: t.business_name };
}

module.exports = { iceAktar, fiyatCoz, alerjenKodu, csvOku, jsonOku, ALERJEN_KODLARI };
