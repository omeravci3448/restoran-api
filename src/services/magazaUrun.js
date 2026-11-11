const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../config/db');
const H = require('./magazaHesap');
const R = require('./magazaResim');

// --- Magaza urunleri (root yonetir, isletme yalniz YAYINDAKI urunleri gorur) ---
//
// Taslak urun isletme uclarindan HIC donmez: liste, ayrinti, sepet ve siparis hepsi
// "yayin = 'YAYINDA' AND silindi_at IS NULL" kosuluyla okur.
// Silme: siparislerde gecen urun YUMUSAK silinir (silindi_at), satiri ve resimleri kalir;
// siparis kalemleri zaten kendi kopyasini tasir. Hic siparise girmemis urun ve resim
// dosyalari tamamen silinir.

const STOK = ['STOKTA', 'SIPARIS_UZERINE', 'TUKENDI'];
const YAYIN = ['TASLAK', 'YAYINDA'];
const EN_FAZLA_RESIM = 12;

function hata(status, message, code) { const e = new Error(message); e.status = status; if (code) e.code = code; return e; }
const simdi = () => new Date().toISOString();

function jsonDizi(s) {
    try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

// Isletmenin gordugu stok durumu. Adet takibi varsa (stok_adedi dolu) 0'da kendiliginden TUKENDI;
// elle "Tukendi" secilmisse adet ne olursa olsun TUKENDI. maksAdet: tek sipariste en fazla.
function etkinStok(u) {
    const takip = u.stok_adedi !== null && u.stok_adedi !== undefined;
    const tedarikGun = u.stok_durumu === 'SIPARIS_UZERINE' && u.tedarik_gun ? Number(u.tedarik_gun) : null;
    if (u.stok_durumu === 'TUKENDI' || (takip && Number(u.stok_adedi) <= 0)) {
        return { durum: 'TUKENDI', tedarikGun: null, maksAdet: 0 };
    }
    const maks = takip ? Math.min(Number(u.stok_adedi), H.EN_FAZLA_ADET) : H.EN_FAZLA_ADET;
    return { durum: u.stok_durumu === 'SIPARIS_UZERINE' ? 'SIPARIS_UZERINE' : 'STOKTA', tedarikGun, maksAdet: maks };
}

async function resimHaritasi(urunIdler) {
    const harita = new Map();
    if (!urunIdler.length) return harita;
    const yer = urunIdler.map(() => '?').join(',');
    const r = await query(
        `SELECT id, urun_id, yol, sira, kapak FROM magaza_urun_resimleri
          WHERE urun_id IN (${yer}) ORDER BY urun_id, sira, created_at`, urunIdler);
    for (const x of r.rows) {
        if (!harita.has(x.urun_id)) harita.set(x.urun_id, []);
        harita.get(x.urun_id).push({ id: x.id, yol: x.yol, sira: x.sira, kapak: !!x.kapak });
    }
    return harita;
}
// Kapak: isaretli olan, yoksa siradaki ilk resim
const kapakOf = (resimler) => (resimler || []).find(r => r.kapak) || (resimler || [])[0] || null;
// Isletmenin galerisi: kapak once, sonra sira
const galeri = (resimler) => {
    const k = kapakOf(resimler);
    return k ? [k, ...resimler.filter(r => r.id !== k.id)] : [];
};

async function kapakHaritasi(urunIdler) {
    const h = await resimHaritasi(urunIdler);
    const out = new Map();
    for (const [id, l] of h) { const k = kapakOf(l); if (k) out.set(id, k.yol); }
    return out;
}

function rootSatir(u, resimler, siparisSayisi) {
    const st = etkinStok(u);
    return {
        id: u.id, ad: u.ad, kategori: u.kategori || '', kisaAciklama: u.kisa_aciklama || '',
        uzunAciklama: u.uzun_aciklama || '', ozellikler: jsonDizi(u.ozellikler),
        fiyatKurus: u.fiyat_kurus, kdvOrani: u.kdv_orani, fiyatKdvDahilKurus: H.kdvDahilBirim(u.fiyat_kurus, u.kdv_orani),
        stokDurumu: u.stok_durumu, stokAdedi: u.stok_adedi, tedarikGun: u.tedarik_gun,
        etkinStok: st.durum, yayin: u.yayin, sira: u.sira,
        resimler: resimler || [], kapak: kapakOf(resimler)?.yol || null,
        siparisSayisi: Number(siparisSayisi || 0),
        createdAt: u.created_at, updatedAt: u.updated_at,
    };
}

async function kategoriler(sadeceYayinda) {
    const r = await query(
        `SELECT DISTINCT kategori FROM magaza_urunler
          WHERE silindi_at IS NULL AND kategori IS NOT NULL AND kategori != ''
          ${sadeceYayinda ? "AND yayin = 'YAYINDA'" : ''} ORDER BY kategori`);
    return r.rows.map(x => x.kategori);
}

// --- Root ---
async function rootListe() {
    const r = await query(
        `SELECT u.*, (SELECT COUNT(DISTINCT k.siparis_id) FROM magaza_siparis_kalemleri k WHERE k.urun_id = u.id) AS siparis_sayisi
           FROM magaza_urunler u WHERE u.silindi_at IS NULL ORDER BY u.sira, u.created_at`);
    const resim = await resimHaritasi(r.rows.map(x => x.id));
    return { urunler: r.rows.map(u => rootSatir(u, resim.get(u.id), u.siparis_sayisi)), kategoriler: await kategoriler(false) };
}

async function rootTek(id) {
    const r = await query(
        `SELECT u.*, (SELECT COUNT(DISTINCT k.siparis_id) FROM magaza_siparis_kalemleri k WHERE k.urun_id = u.id) AS siparis_sayisi
           FROM magaza_urunler u WHERE u.id = ? AND u.silindi_at IS NULL`, [id]);
    if (!r.rows.length) return null;
    const resim = await resimHaritasi([id]);
    return rootSatir(r.rows[0], resim.get(id), r.rows[0].siparis_sayisi);
}

// Gelen alanlari denetler; yalniz GELEN alanlar sutun listesine girer (kismi guncelleme).
function alanlar(g = {}) {
    const has = (k) => Object.prototype.hasOwnProperty.call(g, k);
    const s = {};
    if (has('ad')) {
        s.ad = H.metin(g.ad, 120);
        if (s.ad.length < 2) throw hata(400, 'Ürün adı en az 2 karakter olmalı.');
    }
    if (has('kategori')) s.kategori = H.metin(g.kategori, 60) || null;
    if (has('kisaAciklama')) s.kisa_aciklama = H.metin(g.kisaAciklama, 240) || null;
    if (has('uzunAciklama')) s.uzun_aciklama = H.metin(g.uzunAciklama, 8000) || null;
    if (has('ozellikler')) {
        if (g.ozellikler != null && !Array.isArray(g.ozellikler)) throw hata(400, 'Teknik özellikler liste olmalı.');
        const l = (g.ozellikler || [])
            .map(x => ({ ad: H.metin(x && x.ad, 80), deger: H.metin(x && x.deger, 300) }))
            .filter(x => x.ad || x.deger);
        if (l.length > 40) throw hata(400, 'En fazla 40 teknik özellik satırı girilebilir.');
        if (l.some(x => !x.ad || !x.deger)) throw hata(400, 'Her teknik özellik satırında ad ve değer birlikte yazılmalı.');
        s.ozellikler = JSON.stringify(l);
    }
    if (has('fiyat')) {
        const k = H.tlKurus(g.fiyat);
        if (k === null || k < 0 || k > 1000000000) throw hata(400, 'Fiyat geçersiz (KDV hariç, TL).');
        s.fiyat_kurus = k;
    }
    if (has('kdvOrani')) {
        const o = Number(g.kdvOrani);
        if (!Number.isFinite(o) || o < 0 || o > 100) throw hata(400, 'KDV oranı 0 ile 100 arasında olmalı.');
        s.kdv_orani = Math.round(o * 100) / 100;
    }
    if (has('stokDurumu')) {
        if (!STOK.includes(g.stokDurumu)) throw hata(400, 'Stok durumu geçersiz.');
        s.stok_durumu = g.stokDurumu;
    }
    if (has('stokAdedi')) {
        if (g.stokAdedi === '' || g.stokAdedi === null) s.stok_adedi = null;
        else {
            const n = Number(g.stokAdedi);
            if (!Number.isInteger(n) || n < 0 || n > 1000000) throw hata(400, 'Stok adedi 0 ya da pozitif tam sayı olmalı (boş = takip yok).');
            s.stok_adedi = n;
        }
    }
    if (has('tedarikGun')) {
        if (g.tedarikGun === '' || g.tedarikGun === null) s.tedarik_gun = null;
        else {
            const n = Number(g.tedarikGun);
            if (!Number.isInteger(n) || n < 1 || n > 365) throw hata(400, 'Tedarik süresi 1 ile 365 gün arasında olmalı.');
            s.tedarik_gun = n;
        }
    }
    if (has('yayin')) {
        if (!YAYIN.includes(g.yayin)) throw hata(400, 'Yayın durumu geçersiz.');
        s.yayin = g.yayin;
    }
    return s;
}

// Yayindaki urunde ad ve fiyat sart (0 TL'lik urun yayina cikmasin).
function yayinDenetle(son) {
    if (son.yayin === 'YAYINDA') {
        if (!son.ad || String(son.ad).trim().length < 2) throw hata(400, 'Yayına almak için ürün adı gerekli.');
        if (!(Number(son.fiyat_kurus) > 0)) throw hata(400, 'Yayına almak için fiyat girin.');
    }
}

async function olustur(g) {
    const s = alanlar(g);
    if (!s.ad) throw hata(400, 'Ürün adı zorunlu.');
    const son = { yayin: 'TASLAK', fiyat_kurus: 0, kdv_orani: 20, stok_durumu: 'STOKTA', ...s };
    yayinDenetle(son);
    const sira = Number((await query('SELECT COALESCE(MAX(sira), 0) + 1 AS s FROM magaza_urunler WHERE silindi_at IS NULL')).rows[0].s) || 1;
    const id = uuidv4(), z = simdi();
    await query(
        `INSERT INTO magaza_urunler (id, ad, kategori, kisa_aciklama, uzun_aciklama, ozellikler, fiyat_kurus, kdv_orani,
                                     stok_durumu, stok_adedi, tedarik_gun, yayin, sira, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, son.ad, son.kategori || null, son.kisa_aciklama || null, son.uzun_aciklama || null, son.ozellikler || '[]',
            son.fiyat_kurus, son.kdv_orani, son.stok_durumu, son.stok_adedi ?? null, son.tedarik_gun ?? null,
            son.yayin, sira, z, z]);
    return rootTek(id);
}

async function guncelle(id, g) {
    const mevcut = (await query('SELECT * FROM magaza_urunler WHERE id = ? AND silindi_at IS NULL', [id])).rows[0];
    if (!mevcut) throw hata(404, 'Ürün bulunamadı.');
    const s = alanlar(g);
    yayinDenetle({ ...mevcut, ...s });
    const k = Object.keys(s);
    if (k.length) {
        await query(`UPDATE magaza_urunler SET ${k.map(x => x + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`,
            [...k.map(x => s[x]), simdi(), id]);
    }
    return rootTek(id);
}

async function sil(id) {
    const u = (await query('SELECT id FROM magaza_urunler WHERE id = ? AND silindi_at IS NULL', [id])).rows[0];
    if (!u) throw hata(404, 'Ürün bulunamadı.');
    const kullanildi = (await query('SELECT 1 FROM magaza_siparis_kalemleri WHERE urun_id = ? LIMIT 1', [id])).rows.length > 0;
    if (kullanildi) {
        // Siparislerde geciyor: satir + resimler kalir (eski siparislerin gorunumu bozulmasin)
        await query("UPDATE magaza_urunler SET silindi_at = ?, yayin = 'TASLAK', updated_at = ? WHERE id = ?", [simdi(), simdi(), id]);
        return { silindi: true, yumusak: true };
    }
    const resimler = (await query('SELECT yol FROM magaza_urun_resimleri WHERE urun_id = ?', [id])).rows;
    await query('DELETE FROM magaza_urun_resimleri WHERE urun_id = ?', [id]);
    await query('DELETE FROM magaza_urunler WHERE id = ?', [id]);
    for (const r of resimler) await R.sil(r.yol);
    return { silindi: true, yumusak: false };
}

// ids: istenen sira (silinmemis urunlerin kimlikleri). Listede olmayanlar sona kalir.
async function sirala(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 2000) throw hata(400, 'Sıra listesi geçersiz.');
    const tum = (await query('SELECT id FROM magaza_urunler WHERE silindi_at IS NULL ORDER BY sira, created_at')).rows.map(x => x.id);
    const gecerli = ids.map(String).filter((x, i, a) => tum.includes(x) && a.indexOf(x) === i);
    const yeni = [...gecerli, ...tum.filter(x => !gecerli.includes(x))];
    await tx(async () => {
        for (let i = 0; i < yeni.length; i++) await query('UPDATE magaza_urunler SET sira = ? WHERE id = ?', [i + 1, yeni[i]]);
    });
    return rootListe();
}

// --- Resimler ---
async function resimEkle(urunId, dataUrl) {
    const u = (await query('SELECT id FROM magaza_urunler WHERE id = ? AND silindi_at IS NULL', [urunId])).rows[0];
    if (!u) throw hata(404, 'Ürün bulunamadı.');
    const sayi = Number((await query('SELECT COUNT(*) AS c FROM magaza_urun_resimleri WHERE urun_id = ?', [urunId])).rows[0].c) || 0;
    if (sayi >= EN_FAZLA_RESIM) throw hata(409, `Bir ürüne en fazla ${EN_FAZLA_RESIM} resim eklenebilir.`);
    const { yol, boyut } = await R.kaydet(dataUrl);            // tur + boyut denetimi burada (400 / 413)
    const sira = Number((await query('SELECT COALESCE(MAX(sira), 0) + 1 AS s FROM magaza_urun_resimleri WHERE urun_id = ?', [urunId])).rows[0].s) || 1;
    await query('INSERT INTO magaza_urun_resimleri (id, urun_id, yol, sira, kapak, boyut, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), urunId, yol, sira, sayi === 0 ? 1 : 0, boyut, simdi()]);   // ilk resim kapak olur
    await query('UPDATE magaza_urunler SET updated_at = ? WHERE id = ?', [simdi(), urunId]);
    return rootTek(urunId);
}

async function resimSil(urunId, resimId) {
    const r = (await query('SELECT * FROM magaza_urun_resimleri WHERE id = ? AND urun_id = ?', [resimId, urunId])).rows[0];
    if (!r) throw hata(404, 'Resim bulunamadı.');
    await query('DELETE FROM magaza_urun_resimleri WHERE id = ?', [resimId]);
    // Siparis kalemi bu resmi kapak olarak tasiyorsa dosya kalir (eski siparis gorunumu bozulmasin)
    const kullanimda = (await query('SELECT 1 FROM magaza_siparis_kalemleri WHERE kapak_yol = ? LIMIT 1', [r.yol])).rows.length > 0;
    if (!kullanimda) await R.sil(r.yol);
    if (r.kapak) {
        const ilk = (await query('SELECT id FROM magaza_urun_resimleri WHERE urun_id = ? ORDER BY sira, created_at LIMIT 1', [urunId])).rows[0];
        if (ilk) await query('UPDATE magaza_urun_resimleri SET kapak = 1 WHERE id = ?', [ilk.id]);
    }
    return rootTek(urunId);
}

async function resimSirala(urunId, ids) {
    if (!Array.isArray(ids) || !ids.length) throw hata(400, 'Sıra listesi geçersiz.');
    const tum = (await query('SELECT id FROM magaza_urun_resimleri WHERE urun_id = ? ORDER BY sira, created_at', [urunId])).rows.map(x => x.id);
    if (!tum.length) throw hata(404, 'Ürünün resmi yok.');
    const gecerli = ids.map(String).filter((x, i, a) => tum.includes(x) && a.indexOf(x) === i);
    const yeni = [...gecerli, ...tum.filter(x => !gecerli.includes(x))];
    await tx(async () => {
        for (let i = 0; i < yeni.length; i++) await query('UPDATE magaza_urun_resimleri SET sira = ? WHERE id = ?', [i + 1, yeni[i]]);
    });
    return rootTek(urunId);
}

async function resimKapak(urunId, resimId) {
    const r = (await query('SELECT id FROM magaza_urun_resimleri WHERE id = ? AND urun_id = ?', [resimId, urunId])).rows[0];
    if (!r) throw hata(404, 'Resim bulunamadı.');
    await query('UPDATE magaza_urun_resimleri SET kapak = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE urun_id = ?', [resimId, urunId]);
    return rootTek(urunId);
}

// --- Isletme (yalniz YAYINDA ve silinmemis) ---
function isletmeSatir(u, resimler) {
    const st = etkinStok(u);
    return {
        id: u.id, ad: u.ad, kategori: u.kategori || '', kisaAciklama: u.kisa_aciklama || '',
        fiyatKurus: u.fiyat_kurus, kdvOrani: u.kdv_orani, fiyatKdvDahilKurus: H.kdvDahilBirim(u.fiyat_kurus, u.kdv_orani),
        stok: { durum: st.durum, tedarikGun: st.tedarikGun }, maksAdet: st.maksAdet,
        kapak: kapakOf(resimler)?.yol || null,
    };
}

async function isletmeListe() {
    const r = await query("SELECT * FROM magaza_urunler WHERE silindi_at IS NULL AND yayin = 'YAYINDA' ORDER BY sira, created_at");
    const resim = await resimHaritasi(r.rows.map(x => x.id));
    return { urunler: r.rows.map(u => isletmeSatir(u, resim.get(u.id))), kategoriler: await kategoriler(true) };
}

async function isletmeDetay(id) {
    const u = (await query("SELECT * FROM magaza_urunler WHERE id = ? AND silindi_at IS NULL AND yayin = 'YAYINDA'", [String(id)])).rows[0];
    if (!u) return null;
    const resimler = (await resimHaritasi([u.id])).get(u.id) || [];
    return {
        ...isletmeSatir(u, resimler),
        uzunAciklama: u.uzun_aciklama || '', ozellikler: jsonDizi(u.ozellikler),
        resimler: galeri(resimler).map(x => ({ id: x.id, yol: x.yol })),
    };
}

module.exports = {
    STOK, YAYIN, EN_FAZLA_RESIM, etkinStok, kapakHaritasi,
    rootListe, rootTek, olustur, guncelle, sil, sirala,
    resimEkle, resimSil, resimSirala, resimKapak,
    isletmeListe, isletmeDetay,
};
