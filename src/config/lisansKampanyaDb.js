// --- Lisans: lansman kampanyasi, ek sure tanimi ve katalog metin duzeltmeleri ---
// db.js initDb icinden TEK satirla cagrilir (db.serialize kuyrugunda):
//   require('./lisansKampanyaDb').lisansKampanyaTablolari(db)

function lisansKampanyaTablolari(db) {
    // Lansman kampanyasi (services/lansmanKampanya.js): talep aninda kilitlenir. kampanya_orani = uygulanan kampanya
    // indirimi (yuzde; NULL = kampanya yok), kampanya_son_gun = "Odemeyi yaptim" icin son gun (YYYY-MM-DD, Istanbul).
    db.run('ALTER TABLE lisans_odemeleri ADD COLUMN kampanya_orani REAL', [], () => {});
    db.run('ALTER TABLE lisans_odemeleri ADD COLUMN kampanya_son_gun TEXT', [], () => {});

    // Ek sure tanimi (root "Ek süre tanımla (rakipten geçiş)", services/ekSure.js). goruldu_at: isletme Lisans
    // sayfasindaki bir kerelik bildirimi kapatti.
    db.run(`CREATE TABLE IF NOT EXISTS ek_sure_tanimlari (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        gun INTEGER NOT NULL,
        aciklama TEXT,
        onceki_bitis TEXT,
        yeni_bitis TEXT,
        root_id TEXT,
        root_eposta TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        goruldu_at TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_ek_sure_kiraci ON ek_sure_tanimlari(tenant_id, goruldu_at)', [], () => {});

    // Garson aciklamasi (e2e bulgusu): eski metin "Adisyon ve Kasa yoksa uygulama yalniz cagrilari gosterir" diyordu,
    // oysa yeni satista Garson Adisyon ve Kasa ister. Yalniz hala ESKI varsayilan metindeyse degisir (root panelden
    // yazilmis metne dokunulmaz).
    db.run(`UPDATE lisans_katalog SET aciklama = ? WHERE id = 'MODUL-GARSON' AND aciklama = ?`,
        ['QR menüde garson çağır düğmesi ve garson telefon uygulaması.',
            'QR menüde garson çağır düğmesi ve garson telefon uygulaması. Adisyon ve Kasa yoksa uygulama yalnız çağrıları gösterir.'], () => {});
}

module.exports = { lisansKampanyaTablolari };
