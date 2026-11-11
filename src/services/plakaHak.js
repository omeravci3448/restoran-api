const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const A = require('./sistemAyar');
const M = require('./lisansModul');

// --- Masa plakasi: ayarlar, hediye kurallari, hediye hakki, hediye/ucretli dagilimi ---
//
// HEDIYE (Patron, 2026-11-11 - "odeme yapmamis isletmeye vermek zarar"):
//   1) Onayli YILLIK odeme sart (deneme ASLA): lisans_odemeleri'nde tutari > 0 olan 'onaylandi' kayit ve en az
//      ~1 yillik sure (onay_gun >= 360; eski kayitta donem_bitis - islenen_at >= 360 gun) ya da tutari > 0 olan
//      islenmis SofraMix yillik odemesi (pos_provizyon). 0 TL onaylanan kayit hediye hakki vermez.
//   2) VE en az bir AKTIF "hediye plaka kurali"na uyma (root panelinden): gerekli moduller (lisans hepsini
//      icermeli), istege bagli en az yillik odeme tutari, en cok plaka. Uyan kurallardan en buyuk siniri gecer.
//   Root isletme bazinda elle gecersiz kilar: tenants.plaka_hediye_hakki NULL = otomatik, 1 = ver, 0 = kaldir.
//   Elle verilen hak her seyin onune gecer (Patron'un bilincli karari).
// ADET: en kucuk(aktif masa, lisans masa siniri, kuralin en cok degeri). Isletme basina 1 set: iptal ya da reddedilmemis bir
//   hediye talebi varsa hak kullanilmistir; reddedilen/iptal edilen talep hakki geri verir.
// Ek ve yedek plakalar, kurala uymayan isletmelerin plakalari UCRETLI. Birim fiyat girilmemisse ucretli
// talep kapalidir.

const OLCULER = ['80x80', '70x70', '100x70'];
const DURUMLAR = ['ALINDI', 'ODEME_BEKLENIYOR', 'ODEME_ALINDI', 'HAZIRLANIYOR', 'KARGODA', 'TESLIM_EDILDI', 'IPTAL', 'REDDEDILDI'];
const DURUM_AD = {
    ALINDI: 'Alındı', ODEME_BEKLENIYOR: 'Ödeme bekleniyor', ODEME_ALINDI: 'Ödeme alındı',
    HAZIRLANIYOR: 'Hazırlanıyor', KARGODA: 'Kargoya verildi', TESLIM_EDILDI: 'Teslim edildi',
    IPTAL: 'İptal edildi', REDDEDILDI: 'Reddedildi',
};
const VARSAYILAN_EN_COK = 25;

const hata = (status, message) => Object.assign(new Error(message), { status });

function sayiVeyaNull(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

// --- Ayarlar (root): ucretli plaka fiyati, kargo, olcu + maliyet onizlemesi girdileri ---
async function ayarlar() {
    const birim = sayiVeyaNull(await A.oku('plaka_birim_fiyat', ''));
    const kargo = sayiVeyaNull(await A.oku('plaka_kargo_ucreti', ''));
    const olcu = await A.oku('plaka_olcu', '80x80');
    const mBirim = sayiVeyaNull(await A.oku('plaka_maliyet_birim', ''));
    const mKargo = sayiVeyaNull(await A.oku('plaka_maliyet_kargo', ''));
    return {
        birimFiyat: birim != null && birim > 0 ? birim : null,     // KDV dahil; null = ucretli talep kapali
        kargoUcreti: kargo != null && kargo > 0 ? kargo : 0,
        olcu: OLCULER.includes(olcu) ? olcu : '80x80',
        maliyetBirim: mBirim != null && mBirim >= 0 ? mBirim : null,   // plaka basi maliyetimiz (onizleme)
        maliyetKargo: mKargo != null && mKargo >= 0 ? mKargo : null,   // gonderi basi kargo maliyetimiz
    };
}

async function ayarYaz(govde) {
    const g = govde || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(g, k);
    const tutar = async (alan, anahtar, ad, sifirBos) => {
        if (!has(alan)) return;
        const n = sayiVeyaNull(g[alan]);
        if (n !== null && (n < 0 || n > 100000)) throw hata(400, `${ad} 0 ile 100.000 TL arasında olmalı.`);
        await A.yaz(anahtar, n === null || (sifirBos && n === 0) ? '' : String(n));
    };
    await tutar('birimFiyat', 'plaka_birim_fiyat', 'Birim fiyat', true);
    await tutar('kargoUcreti', 'plaka_kargo_ucreti', 'Kargo ücreti', false);
    await tutar('maliyetBirim', 'plaka_maliyet_birim', 'Plaka maliyeti', false);
    await tutar('maliyetKargo', 'plaka_maliyet_kargo', 'Kargo maliyeti', false);
    if (has('olcu')) {
        if (!OLCULER.includes(g.olcu)) throw hata(400, 'Geçersiz plaka ölçüsü.');
        await A.yaz('plaka_olcu', g.olcu);
    }
    return ayarlar();
}

// --- Hediye plaka kurallari ---
function kuralHazirla(x) {
    return {
        id: x.id, ad: x.ad, moduller: M.modulListesi(x.moduller),
        enAzTutar: x.en_az_tutar == null ? null : Number(x.en_az_tutar),
        enCokPlaka: Number(x.en_cok_plaka) || 0, aktif: Number(x.aktif) === 1, sira: Number(x.sira) || 0,
        created_at: x.created_at, updated_at: x.updated_at,
    };
}
async function kurallar({ yalnizAktif = false } = {}) {
    const r = await query(`SELECT * FROM plaka_hediye_kurallari ${yalnizAktif ? 'WHERE aktif = 1' : ''} ORDER BY sira, created_at`);
    return r.rows.map(kuralHazirla);
}
function kuralDogrula(g, mevcut) {
    const k = { ...(mevcut || { ad: '', moduller: [], enAzTutar: null, enCokPlaka: VARSAYILAN_EN_COK, aktif: true, sira: 50 }) };
    const has = (a) => Object.prototype.hasOwnProperty.call(g || {}, a);
    if (has('ad')) k.ad = String(g.ad || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (has('moduller')) {
        if (!Array.isArray(g.moduller)) throw hata(400, 'Modül listesi geçersiz.');
        k.moduller = Array.from(new Set(g.moduller.map(String).filter((m) => /^[A-Z_]{2,30}$/.test(m))));
    }
    if (has('enAzTutar')) {
        const n = sayiVeyaNull(g.enAzTutar);
        if (n !== null && (n < 0 || n > 10000000)) throw hata(400, 'En az ödeme tutarı geçersiz.');
        k.enAzTutar = n === null || n === 0 ? null : n;
    }
    if (has('enCokPlaka')) {
        const n = sayiVeyaNull(g.enCokPlaka);
        if (n === null || !Number.isInteger(n) || n < 1 || n > 500) throw hata(400, 'En çok plaka 1 ile 500 arasında bir tam sayı olmalı.');
        k.enCokPlaka = n;
    }
    if (has('aktif')) k.aktif = !!(g.aktif === true || g.aktif === 1 || g.aktif === '1');
    if (has('sira')) k.sira = Number.isInteger(Number(g.sira)) ? Number(g.sira) : k.sira;
    if (!k.ad) k.ad = k.moduller.length ? k.moduller.map((m) => M.AD[m] || m).join(' + ') : 'Kural';
    if (!k.moduller.length) throw hata(400, 'Kurala en az bir modül ekleyin.');
    return k;
}
async function kuralEkle(g) {
    const k = kuralDogrula(g);
    const id = uuidv4();
    await query(`INSERT INTO plaka_hediye_kurallari (id, ad, moduller, en_az_tutar, en_cok_plaka, aktif, sira)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, k.ad, JSON.stringify(k.moduller), k.enAzTutar, k.enCokPlaka, k.aktif ? 1 : 0, k.sira]);
    return kuralHazirla((await query('SELECT * FROM plaka_hediye_kurallari WHERE id = ?', [id])).rows[0]);
}
async function kuralGuncelle(id, g) {
    const m = (await query('SELECT * FROM plaka_hediye_kurallari WHERE id = ?', [id])).rows[0];
    if (!m) return null;
    const k = kuralDogrula(g, kuralHazirla(m));
    await query(`UPDATE plaka_hediye_kurallari SET ad = ?, moduller = ?, en_az_tutar = ?, en_cok_plaka = ?, aktif = ?, sira = ?,
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [k.ad, JSON.stringify(k.moduller), k.enAzTutar, k.enCokPlaka, k.aktif ? 1 : 0, k.sira, id]);
    return kuralHazirla((await query('SELECT * FROM plaka_hediye_kurallari WHERE id = ?', [id])).rows[0]);
}
async function kuralSil(id) {
    const r = await query('DELETE FROM plaka_hediye_kurallari WHERE id = ?', [id]);
    return !!r.changes;
}

// --- Yillik odeme olcutu ---
// Doner: null (yillik onayli odeme yok) | { kaynak: 'yillik_odeme' | 'soframix', tutar }
// tutar: kuralin "en az yillik odeme" siniri icin; lisans odemesinde donemin yillik degeri (yukseltmede
// yeni_toplam, eski kayitta tutar), SofraMix'te odenen tutar. Ikisi de varsa buyugu.
async function odemeOlcutu(tenantId) {
    let sonuc = null;
    const y = await query(
        `SELECT * FROM lisans_odemeleri
          WHERE tenant_id = ? AND durum = 'onaylandi' AND COALESCE(tutar, 0) > 0
            AND ((onay_gun IS NOT NULL AND onay_gun >= 360)
              OR (onay_gun IS NULL AND donem_bitis IS NOT NULL AND islenen_at IS NOT NULL
                  AND julianday(donem_bitis) - julianday(islenen_at) >= 360))
          ORDER BY islenen_at DESC LIMIT 1`, [tenantId]);
    if (y.rows.length) {
        const x = y.rows[0];
        const deger = x.yeni_toplam != null ? Number(x.yeni_toplam) : Number(x.tutar);
        sonuc = { kaynak: 'yillik_odeme', tutar: Number.isFinite(deger) ? deger : 0 };
    }
    const p = await query(
        `SELECT tutar_kurus FROM pos_provizyon WHERE tenant_id = ? AND durum = 'islendi' AND COALESCE(tutar_kurus, 0) > 0
          ORDER BY COALESCE(onay_tarihi, created_at) DESC LIMIT 1`, [tenantId]);
    if (p.rows.length) {
        const tutar = Number(p.rows[0].tutar_kurus) / 100;
        if (!sonuc || tutar > sonuc.tutar) sonuc = { kaynak: 'soframix', tutar };
    }
    return sonuc;
}

// Isletmenin uydugu aktif kurallar (yillik odeme varsa)
function uyanKurallar(kuralListesi, moduller, odemeTutari) {
    return kuralListesi.filter((k) => k.aktif
        && k.moduller.every((m) => M.varMi(moduller, m))
        && (k.enAzTutar == null || (odemeTutari != null && odemeTutari >= k.enAzTutar)));
}

// Bu isletmenin aktif (iptal/red edilmemis) hediye talebi
async function hediyeTalebi(tenantId) {
    const r = await query(
        `SELECT id, talep_no, created_at, hediye_adet FROM plaka_talepleri
          WHERE tenant_id = ? AND hediye_adet > 0 AND durum NOT IN ('IPTAL', 'REDDEDILDI')
          ORDER BY created_at LIMIT 1`, [tenantId]);
    return r.rows[0] || null;
}

async function aktifMasaSayisi(tenantId) {
    const r = await query('SELECT COUNT(*) AS c FROM tables WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    return Number(r.rows[0].c) || 0;
}

// Hediye durumu. durum:
//   VAR            - hak var, kullanilmadi (adet = verilebilecek plaka)
//   KULLANILDI     - hediye talebi verildi (tarih)
//   YILLIK_PAKETTE - yillik onayli odeme yok (deneme / odeme bekleyen): hediye yillik pakette verilir
//   KURAL_DISI     - yillik odeme var ama paket hicbir aktif hediye kuralina uymuyor: plakalar ucretli
//   KALDIRILDI     - root elle kaldirdi
async function hediyeDurumu(tenantId) {
    const t = (await query('SELECT id, license_modules, license_table_limit, plaka_hediye_hakki FROM tenants WHERE id = ?', [tenantId])).rows[0];
    if (!t) return null;
    const masa = await aktifMasaSayisi(tenantId);
    const kullanilan = await hediyeTalebi(tenantId);
    const tumKurallar = await kurallar({ yalnizAktif: true });
    const elle = t.plaka_hediye_hakki === null || t.plaka_hediye_hakki === undefined ? null : Number(t.plaka_hediye_hakki);

    let hak = false, kaynak, kural = null, sinir = 0, odeme = null;
    if (elle === 1) {
        hak = true; kaynak = 'elle_ver';
        odeme = await odemeOlcutu(tenantId);
        const uyan = uyanKurallar(tumKurallar, t.license_modules, odeme ? odeme.tutar : null);
        const secilen = (uyan.length ? uyan : tumKurallar).slice().sort((a, b) => b.enCokPlaka - a.enCokPlaka)[0];
        kural = uyan.length ? secilen : null;
        sinir = secilen ? secilen.enCokPlaka : VARSAYILAN_EN_COK;
    } else if (elle === 0) {
        kaynak = 'elle_kaldir';
    } else {
        odeme = await odemeOlcutu(tenantId);
        if (!odeme) kaynak = 'odeme_yok';
        else {
            const uyan = uyanKurallar(tumKurallar, t.license_modules, odeme.tutar);
            if (!uyan.length) kaynak = 'kural_disi';
            else {
                hak = true; kaynak = odeme.kaynak;
                kural = uyan.slice().sort((a, b) => b.enCokPlaka - a.enCokPlaka)[0];
                sinir = kural.enCokPlaka;
            }
        }
    }

    let durum;
    if (kullanilan) durum = 'KULLANILDI';
    else if (hak) durum = 'VAR';
    else if (kaynak === 'kural_disi') durum = 'KURAL_DISI';
    else if (kaynak === 'elle_kaldir') durum = 'KALDIRILDI';
    else durum = 'YILLIK_PAKETTE';

    // Adet = en kucuk(aktif masa, lisans masa siniri, kuralin en cok degeri). null masa siniri = sinirsiz.
    const lisansSiniri = t.license_table_limit == null ? Infinity : Number(t.license_table_limit);
    return {
        durum, hak, kaynak,
        adet: durum === 'VAR' ? Math.max(0, Math.min(masa, lisansSiniri, sinir)) : 0,
        lisansMasaSiniri: Number.isFinite(lisansSiniri) ? lisansSiniri : null,
        ustSinir: sinir || null,
        aktifMasa: masa,
        kural: kural ? { id: kural.id, ad: kural.ad, enCokPlaka: kural.enCokPlaka } : null,
        // Kural disi isletmeye "hangi modullerle hediye alinir" bilgisi (en buyuk sinirli aktif kural)
        ornekKural: durum === 'KURAL_DISI' && tumKurallar.length
            ? (({ ad, moduller, enAzTutar, enCokPlaka }) => ({ ad, moduller, modulAdlari: moduller.map((m) => M.AD[m] || m), enAzTutar, enCokPlaka }))(
                tumKurallar.slice().sort((a, b) => b.enCokPlaka - a.enCokPlaka)[0])
            : null,
        kullanildi: kullanilan ? { talepId: kullanilan.id, talepNo: kullanilan.talep_no, tarih: kullanilan.created_at, adet: kullanilan.hediye_adet } : null,
        elle,
    };
}

// Secilen masa sayisi icin hediye/ucretli ayrimi ve tutar (KDV dahil)
function dagit(secilen, hediyeKalan, ay) {
    const hediye = Math.max(0, Math.min(secilen, hediyeKalan));
    const ucretli = Math.max(0, secilen - hediye);
    const birim = ay.birimFiyat;
    const kargo = ucretli > 0 ? (ay.kargoUcreti || 0) : 0;
    const tutar = ucretli > 0 && birim != null ? Math.round((ucretli * birim + kargo) * 100) / 100 : 0;
    return { hediye, ucretli, birimFiyat: birim, kargoUcreti: kargo, tutar, ucretliAcik: birim != null };
}

// --- Kural maliyet onizlemesi (root) ---
// Girdiler: plaka basi maliyetimiz ve gonderi basi kargo maliyetimiz. Her kural icin: su an uyan (aktif, yillik
// odemesi onayli, modulleri tutan, tutar sinirini gecen) isletme sayisi, ortalama aktif masa, isletme basina
// tahmini maliyet = min(masa, en cok) x plaka maliyeti + kargo, ve bunun odedikleri yillik tutarin yuzde kaci
// oldugu (toplam maliyet / toplam odeme). Elle verilen/kaldirilan haklar ve kullanilmis hediyeler hesaba
// KATILMAZ: kuralin kendisinin maliyeti gosterilir.
async function kuralOnizleme({ birimMaliyet, kargoMaliyet }) {
    const bm = Math.max(0, Number(birimMaliyet) || 0);
    const km = Math.max(0, Number(kargoMaliyet) || 0);
    const kl = await kurallar();
    const t = await query(
        `SELECT t.id, t.license_modules, t.license_table_limit,
                (SELECT COUNT(*) FROM tables x WHERE x.tenant_id = t.id AND x.is_active = 1) AS masa
           FROM tenants t WHERE t.is_active = 1`);
    const adaylar = [];
    for (const x of t.rows) {
        const o = await odemeOlcutu(x.id);
        // Hediye adedi lisans masa siniriyla da sinirli (hediyeDurumu ile ayni)
        const masa = Math.min(Number(x.masa) || 0, x.license_table_limit == null ? Infinity : Number(x.license_table_limit));
        if (o) adaylar.push({ moduller: x.license_modules, masa, odeme: o.tutar });
    }
    return {
        birimMaliyet: bm, kargoMaliyet: km, yillikOdemeliIsletme: adaylar.length,
        kurallar: kl.map((k) => {
            const uyan = adaylar.filter((a) => uyanKurallar([{ ...k, aktif: true }], a.moduller, a.odeme).length);
            const n = uyan.length;
            const maliyetler = uyan.map((a) => Math.min(a.masa, k.enCokPlaka) * bm + km);
            const toplamMaliyet = maliyetler.reduce((s, v) => s + v, 0);
            const toplamOdeme = uyan.reduce((s, a) => s + a.odeme, 0);
            const r2 = (v) => Math.round(v * 100) / 100;
            return {
                id: k.id, ad: k.ad, aktif: k.aktif, uyanIsletme: n,
                ortalamaMasa: n ? r2(uyan.reduce((s, a) => s + a.masa, 0) / n) : 0,
                ortalamaMaliyet: n ? r2(toplamMaliyet / n) : 0,
                ortalamaOdeme: n ? r2(toplamOdeme / n) : 0,
                yuzde: toplamOdeme > 0 ? r2(toplamMaliyet / toplamOdeme * 100) : null,
                toplamMaliyet: r2(toplamMaliyet),
            };
        }),
    };
}

module.exports = {
    OLCULER, DURUMLAR, DURUM_AD, VARSAYILAN_EN_COK,
    ayarlar, ayarYaz, kurallar, kuralEkle, kuralGuncelle, kuralSil, kuralOnizleme,
    hediyeDurumu, odemeOlcutu, uyanKurallar, hediyeTalebi, aktifMasaSayisi, dagit,
};
