const { query } = require('../config/db');

// ——— Lisans katalogu (paketler + moduller) ———
//
// Eskiden MDA Hub'dan okunuyordu. Artik POS hub'a BAGLI DEGIL: fiyatlari ve
// paketleri root paneli tanimliyor, katalog POS'un kendi veritabaninda duruyor.
// Hub'a bagimlilik somut bir sorundu: hub kapaliyken musteri fiyat listesini
// bos goruyordu ve sebebini anlayamiyordu.

// Musteriye gosterilecek katalog. gorunur=0 satirlar BURADAN DONMEZ.
async function musteriKatalogu() {
    const r = await query(
        `SELECT tur, kod, ad, aciklama, fiyat, masa_limiti
           FROM lisans_katalog WHERE gorunur = 1 ORDER BY tur DESC, sira, ad`);
    return sekillendir(r.rows);
}

// Root paneli icin: gizliler DAHIL hepsi.
async function tamKatalog() {
    const r = await query(
        `SELECT id, tur, kod, ad, aciklama, fiyat, masa_limiti, gorunur, sira
           FROM lisans_katalog ORDER BY tur DESC, sira, ad`);
    return r.rows;
}

function sekillendir(rows) {
    return {
        appId: 'mda-restoran',
        tiers: rows.filter((x) => x.tur === 'TIER').map((x) => ({
            name: x.kod, displayName: x.ad, description: x.aciklama || '',
            price: Number(x.fiyat) || 0, tableLimit: x.masa_limiti,
        })),
        modules: rows.filter((x) => x.tur === 'MODUL').map((x) => ({
            name: x.kod, displayName: x.ad, description: x.aciklama || '',
            price: Number(x.fiyat) || 0,
        })),
        categories: [],
    };
}

// Bir modul musteriye aciksa true. Gizli modul satin alinamaz ve fiyat
// hesabina GIRMEZ - gizlemek yalnizca "listede gorunmesin" demek olsaydi
// istegi elle gonderen biri yine satin alabilirdi.
async function modulGorunurMu(kod) {
    const r = await query(
        "SELECT gorunur FROM lisans_katalog WHERE tur = 'MODUL' AND kod = ?", [kod]);
    return r.rows.length ? r.rows[0].gorunur === 1 : false;
}

async function guncelle(id, alanlar) {
    const a = alanlar || {};
    const mevcut = (await query('SELECT * FROM lisans_katalog WHERE id = ?', [id])).rows[0];
    if (!mevcut) return null;
    await query(
        `UPDATE lisans_katalog
            SET ad = COALESCE(?, ad),
                aciklama = COALESCE(?, aciklama),
                fiyat = COALESCE(?, fiyat),
                masa_limiti = CASE WHEN ? = 1 THEN ? ELSE masa_limiti END,
                gorunur = COALESCE(?, gorunur),
                sira = COALESCE(?, sira)
          WHERE id = ?`,
        [a.ad != null ? String(a.ad).slice(0, 80) : null,
            a.aciklama != null ? String(a.aciklama).slice(0, 300) : null,
            a.fiyat != null ? Number(a.fiyat) : null,
            Object.prototype.hasOwnProperty.call(a, 'masaLimiti') ? 1 : 0,
            a.masaLimiti === '' || a.masaLimiti == null ? null : Number(a.masaLimiti),
            a.gorunur == null ? null : (a.gorunur ? 1 : 0),
            a.sira != null ? Number(a.sira) : null,
            id]);
    return (await query('SELECT * FROM lisans_katalog WHERE id = ?', [id])).rows[0];
}

module.exports = { musteriKatalogu, tamKatalog, modulGorunurMu, guncelle };
