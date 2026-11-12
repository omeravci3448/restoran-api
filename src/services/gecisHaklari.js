const { query, tx } = require('../config/db');
const M = require('./lisansModul');

// --- Eski musteri hakki (moduler lisansa gecis oncesi haklar) ---
//
// KARAR (2026-11-12, canli kopya provasindan sonra): moduler lisansa gecis (db.js, gecis_moduler_lisans_v1) aninda
// her isletmenin gecis SONRASI modul listesi saklanir (gecis_haklari.moduller_sonra). Gecis aninda deneme
// olmayan isletmede bu listedeki ESKI HAKLAR onayda (lisansModul.korunacakModuller) odeme gecmisinden bagimsiz
// korunur ve ucrete girmez. Bagimlilik kurali aynen gecerli (Masadan Siparis yalniz Adisyon ve Kasa + QR Menu
// varken, Stok ve Pazaryeri yalniz Adisyon ve Kasa varken).
//
// ESKI HAK = gecis sonrasi listedeki moduller, su ikisi HARIC (hak.hesapla):
//   - BASE (Adisyon ve Kasa): fiyati masa paketinin fiyatidir. Hak sayilsaydi masa paketi ucretsiz kalirdi; her
//     yenilemede eskisi gibi secilip odenir.
//   - Gecisten ONCE de lisansta olan ve gecis aninda satista (gorunur) ve UCRETLI olan moduller (QR Menu, Garson):
//     isletme bunlari eskiden de satin aliyordu, yenilemede yine secilir ve odenir.
// Boylece gecisin ekledigi Masadan Siparis ve Garson, satistan kalkmis Stok ve Pazaryeri, katalogda olmayan eski
// kodlar ucretsiz korunur; Masadan Siparis sonradan satisa acilsa (gorunur + fiyatli) da hak sahibinde ucretsiz
// kalir, yeni musteride ucretlidir.
//
// Gecis aninda DENEME olan isletmeye (yonetimOzet.sinifla 'deneme': TIER_DENEME ya da kayit formu denemesi) hak
// verilmez: satir yazilir (gecis sonrasi liste gorunsun) ama hak listesi bostur.
// Root isletme bazinda hakki kaldirabilir (kaldirildi_at); kaldirilan hak bir daha korunmaz.
//
// Gecis canlida bu kodla calisir: haklar gecisin KENDI isleminde yazilir (gecisAnindaYaz). Gecisin daha once
// calistigi ortamlar (gelistirme ve test veritabanlari) icin acilista bir kez doldurulur (doldur): gecisten once
// acilmis isletmelere o anki liste yazilir; gecis oncesi liste bilinmedigi icin o anki satistaki ucretli moduller
// "eskiden satin alinmis" sayilir (hak disi).

const ISARET = 'gecis_haklari_v1';
const GECIS_ISARETI = 'gecis_moduler_lisans_v1';

// Saf hesap. once: gecis oncesi liste (bilinmiyorsa null: sonra kullanilir), sonra: gecis sonrasi liste,
// deneme: gecis aninda deneme miydi, ucretliGorunur: gecis aninda satista ve ucretli modul kodlari (Set).
function hesapla({ once, sonra, deneme, ucretliGorunur }) {
    if (deneme) return [];
    const s = M.modulListesi(sonra);
    const o = once == null ? s : M.modulListesi(once);
    const ucretli = ucretliGorunur instanceof Set ? ucretliGorunur : new Set(ucretliGorunur || []);
    const hak = [];
    for (const m of s) {
        if (m === 'ALL' || m === 'BASE' || hak.includes(m)) continue;
        if (o.includes(m) && ucretli.has(m)) continue;
        hak.push(m);
    }
    return hak;
}

async function ucretliGorunurModuller() {
    const r = await query("SELECT kod FROM lisans_katalog WHERE tur = 'MODUL' AND gorunur = 1 AND COALESCE(fiyat, 0) > 0");
    return new Set(r.rows.map((x) => String(x.kod)));
}

// Isletmeler icin hak satirlarini yazar (INSERT OR IGNORE: ilk yazilan kalir; kaldirilmis hak geri gelmez).
// Islem (tx) ICINDE cagrilir. onceHarita: Map(tenantId -> gecis oncesi ham license_modules) ya da null (bilinmiyor).
// yalnizGecistenOnce: true ise yalniz gecis isaretinden once acilmis isletmeler.
async function yaz({ onceHarita = null, kaynak = 'gecis', yalnizGecistenOnce = false } = {}) {
    const Oz = require('./yonetimOzet');
    const tierler = await Oz.katalogTierleri();
    const esik = Oz.esikGunu();
    const ucretli = await ucretliGorunurModuller();
    const sinir = yalnizGecistenOnce
        ? ` WHERE t.created_at <= COALESCE((SELECT deger FROM sistem_ayarlari WHERE anahtar = '${GECIS_ISARETI}'), '0000')`
        : '';
    const r = await query(
        `SELECT t.id, t.license_tier, t.license_modules, t.license_end_date, t.created_at, ${Oz.ODEME_ALANLARI}
           FROM tenants t${sinir}`);
    let yazilan = 0;
    for (const t of r.rows) {
        const sinif = Oz.sinifla(t, tierler, esik);
        const sonra = M.modulListesi(t.license_modules);
        const once = onceHarita ? (onceHarita.has(t.id) ? onceHarita.get(t.id) : null) : null;
        const hak = hesapla({ once: onceHarita ? M.modulListesi(once) : null, sonra, deneme: sinif === 'deneme', ucretliGorunur: ucretli });
        const s = await query(
            `INSERT OR IGNORE INTO gecis_haklari (tenant_id, moduller_once, moduller_sonra, hak, sinif, kademe, kaynak)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [t.id, onceHarita ? (once == null ? null : String(once)) : null, JSON.stringify(sonra), JSON.stringify(hak),
                sinif, t.license_tier || null, kaynak]);
        yazilan += s.changes || 0;
    }
    await query("INSERT OR IGNORE INTO sistem_ayarlari (anahtar, deger) VALUES (?, datetime('now'))", [ISARET]);
    return yazilan;
}

// Gecis zaten calismis, haklar henuz yazilmamis ortam: bir kez doldurur (isaretle). Doner: yazilan satir sayisi.
async function doldur() {
    return tx(async () => {
        const g = await query('SELECT 1 AS v FROM sistem_ayarlari WHERE anahtar = ?', [GECIS_ISARETI]);
        const h = await query('SELECT 1 AS v FROM sistem_ayarlari WHERE anahtar = ?', [ISARET]);
        if (!g.rows.length || h.rows.length) return 0;
        return yaz({ onceHarita: null, kaynak: 'sonradan', yalnizGecistenOnce: true });
    });
}

async function satir(tenantId) {
    try {
        return (await query('SELECT * FROM gecis_haklari WHERE tenant_id = ?', [String(tenantId || '')])).rows[0] || null;
    } catch (_) { return null; }   // tablo yoksa (cok eski veritabani) hak yok
}

// Onayda korunacak eski haklar: satir var, kaldirilmamis. (Deneme isletmede hak listesi zaten bos.)
async function aktifHak(tenantId) {
    const s = await satir(tenantId);
    if (!s || s.kaldirildi_at) return [];
    return M.modulListesi(s.hak);
}

// Root isletme ayrintisi icin
async function bilgi(tenantId) {
    const s = await satir(tenantId);
    if (!s) return null;
    const ad = (k) => M.AD[k] || k;
    const hak = M.modulListesi(s.hak);
    return {
        hak, hakAdlari: hak.map(ad), gecisSonrasi: M.modulListesi(s.moduller_sonra).map(ad),
        sinif: s.sinif, kademe: s.kademe, kaynak: s.kaynak, yazildi: s.yazildi_at,
        kaldirildi: s.kaldirildi_at || null, kaldiran: s.kaldiran || null,
    };
}

// Root hakki kaldirir. Doner: { degisti, hak }
async function kaldir(tenantId, kaldiran) {
    const s = await satir(tenantId);
    if (!s || s.kaldirildi_at) return { degisti: false, hak: s ? M.modulListesi(s.hak) : [] };
    const u = await query(
        "UPDATE gecis_haklari SET kaldirildi_at = datetime('now'), kaldiran = ? WHERE tenant_id = ? AND kaldirildi_at IS NULL",
        [kaldiran ? String(kaldiran).slice(0, 120) : null, String(tenantId)]);
    return { degisti: (u.changes || 0) > 0, hak: M.modulListesi(s.hak) };
}

module.exports = { ISARET, hesapla, yaz, doldur, aktifHak, bilgi, kaldir };
