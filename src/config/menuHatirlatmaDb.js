// --- Lisans yenileme hatirlatmalari + isletme duzeyi menu karekodu ---
// db.js initDb icinden TEK satirla cagrilir (db.serialize kuyrugunda):
//   require('./menuHatirlatmaDb').menuHatirlatmaTablolari(db)

function menuHatirlatmaTablolari(db) {
    // Lisans yenileme hatirlatmasi (services/lisansHatirlatma.js). Her (isletme, tur, bitis tarihi) icin EN FAZLA
    // bir kez gonderilir: UNIQUE indeks bunun tek kapisi. Lisans uzayinca bitis degisir, yeni donemin
    // hatirlatmalari yeniden gonderilebilir. alicilar: gonderildigi adresler (virgulle), denetim icin.
    db.run(`CREATE TABLE IF NOT EXISTS lisans_hatirlatmalari (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        tur TEXT NOT NULL,
        bitis TEXT NOT NULL,
        alicilar TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_lisans_hatirlatma ON lisans_hatirlatmalari(tenant_id, tur, bitis)', [], () => {});

    // Isletme duzeyi menu karekodu (yalniz QR menu kullanan isletme: masa yok, tek menu, tek karekod).
    // Adres /q/<KOD>; kod masa kisa koduyla ayni alfabe ve uzunlukta (services/kisaKod.js), ayni adres uzayinda.
    db.run('ALTER TABLE tenants ADD COLUMN menu_kisa_kod TEXT', [], () => {});
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_menu_kisa_kod ON tenants(menu_kisa_kod) WHERE menu_kisa_kod IS NOT NULL', [], () => {});
}

module.exports = { menuHatirlatmaTablolari };
