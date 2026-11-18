// --- SofraMix paket tablolari (POS tarafi) ---
// db.js initDb icinden TEK satirla cagrilir (db.serialize kuyrugunda):
//   require('./soframixPaketDb').soframixPaketTablolari(db)
//
//  lisans_katalog.smx_fiyat   SofraMix uyelerine ozel yillik fiyat (KDV haric, TL). NULL = normal fiyatla ayni.
//  pos_provizyon.pos_paket    SofraMix'in odemeyle birlikte gonderdigi paket secimi (JSON). NULL = eski odeme
//                             (paket bilgisi yok: varsayilan tam paket davranisi). Root "Yeniden dene" ayni
//                             secimle tekrar isleyebilsin diye saklanir.
//  pos_provizyon.aday_tenant_id  Elde birakilan odemede eslesme adayi (root "Bu isletmeye yaz" icin).
//  pos_provizyon.elde_sebep      Elde birakma sebebi kodu (root ekrani hangi cozumu gosterecegini bilsin).
//  pos_provizyon.root_cozum      Root'un elde odeme icin verdigi kararlar (JSON: yeniIsletme / tenantId / tutarKabul).
// Eski kayitlar etkilenmez: yeni sutunlar bos kalir, davranis eskisiyle ayni.

function soframixPaketTablolari(db) {
    db.run('ALTER TABLE lisans_katalog ADD COLUMN smx_fiyat REAL', [], () => {});
    db.run('ALTER TABLE pos_provizyon ADD COLUMN pos_paket TEXT', [], () => {});
    db.run('ALTER TABLE pos_provizyon ADD COLUMN aday_tenant_id TEXT', [], () => {});
    db.run('ALTER TABLE pos_provizyon ADD COLUMN elde_sebep TEXT', [], () => {});
    db.run('ALTER TABLE pos_provizyon ADD COLUMN root_cozum TEXT', [], () => {});
}

module.exports = { soframixPaketTablolari };
