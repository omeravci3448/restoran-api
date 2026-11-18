// --- Sube gruplari (cok subeli isletme, grup yoneticisi ekrani) ---
// db.js initDb icinden TEK satirla cagrilir (db.serialize kuyrugunda): require('./grupDb').grupTablolari(db)
//
// sube_gruplari          : grubun kendisi (ad). Root panelinden kurulur.
// sube_grup_uyeleri      : gruptaki isletmeler. Bir isletme EN FAZLA bir grupta olur (tenant_id UNIQUE).
// sube_grup_yoneticileri : grubu goren kullanicilar. Yalniz uye isletmelerin OWNER / MANAGER kullanicilari
//                          (root ekler); kullanicinin isletmesi gruptan cikarsa yoneticiligi de silinir.
// Grup ekrani yalniz toplam rakam gosterir (ciro, tahsilat, adet); musteri adi / telefon / adres hic okunmaz.

function grupTablolari(db) {
    db.run(`CREATE TABLE IF NOT EXISTS sube_gruplari (
        id TEXT PRIMARY KEY,
        ad TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS sube_grup_uyeleri (
        grup_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_sube_grup_uyeleri_grup ON sube_grup_uyeleri(grup_id)', [], () => {});
    db.run(`CREATE TABLE IF NOT EXISTS sube_grup_yoneticileri (
        grup_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(grup_id, user_id)
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_sube_grup_yoneticileri_user ON sube_grup_yoneticileri(user_id)', [], () => {});
    // Grup ozeti: isletme + durum + kapanis zamani araligi (rapor sorgulariyla ayni kosullar)
    db.run('CREATE INDEX IF NOT EXISTS idx_orders_tenant_durum_kapanis ON orders(tenant_id, status, closed_at)', [], () => {});
}

module.exports = { grupTablolari };
