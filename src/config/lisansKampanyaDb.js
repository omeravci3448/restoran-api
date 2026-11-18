// --- Lisans: lansman kampanyasi, ek sure tanimi ve katalog metin duzeltmeleri ---
// db.js initDb icinden TEK satirla cagrilir (db.serialize kuyrugunda):
//   require('./lisansKampanyaDb').lisansKampanyaTablolari(db)

function lisansKampanyaTablolari(db) {
    // Garson aciklamasi (e2e bulgusu): eski metin "Adisyon ve Kasa yoksa uygulama yalniz cagrilari gosterir" diyordu,
    // oysa yeni satista Garson Adisyon ve Kasa ister. Yalniz hala ESKI varsayilan metindeyse degisir (root panelden
    // yazilmis metne dokunulmaz).
    db.run(`UPDATE lisans_katalog SET aciklama = ? WHERE id = 'MODUL-GARSON' AND aciklama = ?`,
        ['QR menüde garson çağır düğmesi ve garson telefon uygulaması.',
            'QR menüde garson çağır düğmesi ve garson telefon uygulaması. Adisyon ve Kasa yoksa uygulama yalnız çağrıları gösterir.'], () => {});
}

module.exports = { lisansKampanyaTablolari };
