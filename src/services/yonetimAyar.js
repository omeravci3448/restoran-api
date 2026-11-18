const { query } = require('../config/db');

// --- Sistem Ayarlari (root paneli > Sistem Ayarlari sekmesi) ---
// Kayit yeri sistem_ayarlari tablosu (anahtar/deger). Banka bilgileri ve bildirim e-postasi eskiden de buradaydi
// (Paketler ve Fiyatlar sekmesi ayni anahtarlari yazar); yeni olanlar eskiden koddaki sabitlerdi:
//   deneme_gun              deneme suresi (gun). Varsayilan: DENEME_GUN ortam degiskeni, yoksa 7.
//   lisans_salt_okunur_gun  lisans bitince salt-okunur gun sayisi. Varsayilan: LISANS_TOLERANS_GUN, yoksa 3.
//   destek_oturumu_dk       destek oturumu suresi (dakika). Varsayilan 120.
// Ayar YOKSA (bos birakilirsa) davranis eskisiyle BIREBIR aynidir. Oncelik: kayitli ayar > ortam degiskeni > sabit.
//
// lisansDurumu.hesapla() senkron ve her istekte cagriliyor: sayisal ayarlar bellekte tutulur. Panelden yazilinca
// hemen, baska yoldan (elle SQL) degisirse en gec 60 sn icinde tazelenir.

const SAYISAL = {
    deneme_gun: { ad: 'Deneme süresi (gün)', en: 1, cok: 90, varsayilan: () => Number(process.env.DENEME_GUN || 7) },
    lisans_salt_okunur_gun: { ad: 'Lisans bitince salt-okunur gün', en: 0, cok: 30, varsayilan: () => Number(process.env.LISANS_TOLERANS_GUN || 3) },
    destek_oturumu_dk: { ad: 'Destek oturumu süresi (dakika)', en: 5, cok: 720, varsayilan: () => 120 },
    // Lisans satisi (2026-11-18): KDV orani (katalog fiyatlari KDV haric) ve odeme korumasi ("odemeyi yaptim"
    // sonrasi onay beklerken programin acik kaldigi gun; 0 = kapali). Bkz services/lisansKdv.js, odemeKorumasi.js
    kdv_orani: { ad: 'KDV oranı (%)', en: 0, cok: 50, varsayilan: () => 20 },
    odeme_koruma_gun: { ad: 'Ödeme bildirimi sonrası açık kalma (gün)', en: 0, cok: 14, varsayilan: () => 3 },
    // SofraMix tam paket fiyati (KDV haric, TL; Paketler ve Fiyatlar sekmesinde). Bos = tam paket sunulmaz.
    smx_tam_paket_fiyat: { ad: 'SofraMix tam paket fiyatı (KDV hariç)', en: 1, cok: 10000000, varsayilan: () => null },
};
// Metin ayarlari: Paketler ve Fiyatlar sekmesiyle ayni anahtarlar ve ayni sinir (sistemAyar.yaz 500'de keser;
// burada kesmek yerine 400 doner)
const METIN = {
    iban: { ad: 'IBAN', sinir: 500 },
    iban_sahibi: { ad: 'Hesap sahibi', sinir: 500 },
    banka_adi: { ad: 'Banka', sinir: 500 },
    odeme_aciklama: { ad: 'Açıklama notu', sinir: 500 },
    bildirim_eposta: { ad: 'Bildirim e-postası', sinir: 200 },
};
const ANAHTARLAR = [...Object.keys(METIN), ...Object.keys(SAYISAL)];

const onbellek = {};          // anahtar -> sayi (kayitli gecerli deger) | null (kayit yok)
let sonYukleme = 0;
let yukleniyor = null;

function sayiCoz(anahtar, ham) {
    const t = SAYISAL[anahtar];
    if (ham == null || String(ham).trim() === '') return null;
    const n = Number(String(ham).trim());
    if (!Number.isInteger(n) || n < t.en || n > t.cok) return null;   // bozuk kayit: varsayilana dus
    return n;
}

async function yukle() {
    if (yukleniyor) return yukleniyor;
    yukleniyor = (async () => {
        const anahtarlar = Object.keys(SAYISAL);
        const r = await query(`SELECT anahtar, deger FROM sistem_ayarlari WHERE anahtar IN (${anahtarlar.map(() => '?').join(', ')})`, anahtarlar);
        const harita = Object.fromEntries(r.rows.map((x) => [x.anahtar, x.deger]));
        for (const a of anahtarlar) onbellek[a] = sayiCoz(a, harita[a]);
        sonYukleme = Date.now();
    })().finally(() => { yukleniyor = null; });
    return yukleniyor;
}

function tazeleGerekirse() {
    if (Date.now() - sonYukleme > 60000 && !yukleniyor) yukle().catch(() => { sonYukleme = Date.now(); });
}

// Senkron: bellekteki deger (yoksa varsayilan). lisansDurumu.hesapla bunu kullanir.
function sayi(anahtar) {
    tazeleGerekirse();
    const v = onbellek[anahtar];
    return v == null ? SAYISAL[anahtar].varsayilan() : v;
}
const toleransGun = () => sayi('lisans_salt_okunur_gun');
const denemeGun = () => sayi('deneme_gun');
const destekSureDk = () => sayi('destek_oturumu_dk');
const kdvOrani = () => sayi('kdv_orani');
const odemeKorumaGun = () => sayi('odeme_koruma_gun');

// Asenkron: veritabanindan taze okur (deneme acilisi gibi seyrek ama kesin olmasi gereken yerler)
async function sayiOku(anahtar) {
    const r = await query('SELECT deger FROM sistem_ayarlari WHERE anahtar = ?', [anahtar]);
    const v = sayiCoz(anahtar, r.rows[0] && r.rows[0].deger);
    onbellek[anahtar] = v;
    return v == null ? SAYISAL[anahtar].varsayilan() : v;
}
const denemeGunOku = () => sayiOku('deneme_gun');
const destekSureDkOku = () => sayiOku('destek_oturumu_dk');

// Kendi upsert'imiz: sistemAyar.yaz 500 karakterde sessizce keser; burada sinir asilirsa yazmadan once 400.
async function ham(anahtar, deger) {
    if (deger == null) {
        await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [anahtar]);
        return;
    }
    await query(
        `INSERT INTO sistem_ayarlari (anahtar, deger, guncellendi_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger, guncellendi_at = CURRENT_TIMESTAMP`,
        [anahtar, String(deger)]);
}

function hata(mesaj) { const e = new Error(mesaj); e.status = 400; return e; }
const EPOSTA_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Govdeyi dogrular ve normalize eder; hata varsa HICBIR sey yazilmadan 400 firlatir.
// Doner: [[anahtar, deger|null]] (null = kaydi sil, varsayilana don)
function dogrula(govde) {
    const g = govde || {};
    const yazilacak = [];
    for (const a of Object.keys(METIN)) {
        if (!Object.prototype.hasOwnProperty.call(g, a)) continue;
        const s = String(g[a] == null ? '' : g[a]).trim();
        if (s.length > METIN[a].sinir) throw hata(`${METIN[a].ad} en fazla ${METIN[a].sinir} karakter olabilir.`);
        if (a === 'iban' && s && !/^TR\d{24}$/i.test(s.replace(/\s+/g, ''))) {
            throw hata('IBAN "TR" ile başlamalı ve 26 karakter olmalı (boşluklar sayılmaz).');
        }
        if (a === 'bildirim_eposta' && s && !EPOSTA_RE.test(s)) throw hata('Bildirim e-postası geçerli bir adres olmalı.');
        yazilacak.push([a, s]);     // metin ayarlari bos da olsa yazilir (eski davranis: bos IBAN = odeme ekrani kapali)
    }
    for (const a of Object.keys(SAYISAL)) {
        if (!Object.prototype.hasOwnProperty.call(g, a)) continue;
        const s = String(g[a] == null ? '' : g[a]).trim();
        if (s === '') { yazilacak.push([a, null]); continue; }
        const t = SAYISAL[a];
        const n = Number(s);
        if (!Number.isInteger(n) || n < t.en || n > t.cok) throw hata(`${t.ad} ${t.en} ile ${t.cok} arasında tam sayı olmalı.`);
        yazilacak.push([a, n]);
    }
    return yazilacak;
}

// Root ekrani: her ayarin kayitli degeri, varsayilani ve etkin degeri
async function hepsi() {
    const r = await query(`SELECT anahtar, deger, guncellendi_at FROM sistem_ayarlari WHERE anahtar IN (${ANAHTARLAR.map(() => '?').join(', ')})`, ANAHTARLAR);
    const h = Object.fromEntries(r.rows.map((x) => [x.anahtar, x]));
    const metin = {};
    for (const a of Object.keys(METIN)) metin[a] = h[a] && h[a].deger != null ? h[a].deger : '';
    const sayisal = {};
    for (const [a, t] of Object.entries(SAYISAL)) {
        const kayitli = sayiCoz(a, h[a] && h[a].deger);
        sayisal[a] = { kayitli, varsayilan: t.varsayilan(), etkin: kayitli == null ? t.varsayilan() : kayitli, en: t.en, cok: t.cok,
            guncellendi: h[a] ? h[a].guncellendi_at : null };
    }
    return { ...metin, sayisal };
}

// Yazar ve degisenleri doner: [{ anahtar, once, sonra }]
async function yaz(govde) {
    const yazilacak = dogrula(govde);
    if (!yazilacak.length) return [];
    const anahtarlar = yazilacak.map(([a]) => a);
    const r = await query(`SELECT anahtar, deger FROM sistem_ayarlari WHERE anahtar IN (${anahtarlar.map(() => '?').join(', ')})`, anahtarlar);
    const once = Object.fromEntries(r.rows.map((x) => [x.anahtar, x.deger]));
    const degisen = [];
    for (const [a, v] of yazilacak) {
        const eski = once[a] == null ? null : String(once[a]);
        const yeni = v == null ? null : String(v);
        if (eski === yeni || (eski == null && yeni === '' && METIN[a])) continue;
        await ham(a, v);
        degisen.push({ anahtar: a, once: eski, sonra: yeni });
    }
    if (degisen.some((d) => SAYISAL[d.anahtar])) await yukle();
    return degisen;
}

const ETIKET = Object.fromEntries([...Object.entries(METIN), ...Object.entries(SAYISAL)].map(([a, t]) => [a, t.ad]));

module.exports = {
    yukle, toleransGun, denemeGun, destekSureDk, kdvOrani, odemeKorumaGun, denemeGunOku, destekSureDkOku, hepsi, yaz, dogrula, ETIKET,
    SAYISAL, METIN,
};
