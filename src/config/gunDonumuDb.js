// --- Is gunu donumu (kapanis saati) ---
// db.js initDb icinden TEK satirla cagrilir (db.serialize kuyrugunda): require('./gunDonumuDb').gunDonumuKolonlari(db)
//
// tenants.gun_donumu_saat: 0-6. 0 = gun Istanbul saatiyle 00:00'da doner (varsayilan). Gece yarisindan sonra
// kapanan isletme kapanis saatini secer (1-6); raporlar, panel, paket servis ve grup ozeti gunu o saatte dondurur.
// Hesap tek yerde: services/isGunu.js

function gunDonumuKolonlari(db) {
    db.run('ALTER TABLE tenants ADD COLUMN gun_donumu_saat INTEGER NOT NULL DEFAULT 0', [], () => {});
}

module.exports = { gunDonumuKolonlari };
