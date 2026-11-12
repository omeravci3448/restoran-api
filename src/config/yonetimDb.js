// --- Yonetim (root) paneli tablolari ---
// Yonetim gunlugu, isletme ic notlari, duyurular ve destek oturumlari. db.js initDb icinden TEK satirla
// cagrilir (db.serialize kuyrugunda): require('./yonetimDb').yonetimTablolari(db)
//
// IP KAYDEDILMEZ (Patron'un genel karari): ne gunlukte ne destek oturumunda IP sutunu var.

// Ilk duyuru taslagi: PASIF tohumlanir, Patron root panelinden acar. Isaret sistem_ayarlari'nda: Patron
// taslagi silerse bir sonraki acilista geri gelmez.
const TOHUM_ISARETI = 'tohum_duyuru_plaka_v1';
const TOHUM_DUYURU = {
    id: 'tohum-plaka-kampanyasi',
    baslik: 'Masa plakası kampanyası',
    metin: 'Seçili yıllık paketlerde masa sayısı kadar karekodlu metal plaka hediye. Ayrıntı için Masa Plakaları sayfasına bakın.',
    baglanti: '/plakalar',
    baglanti_metni: 'Masa Plakaları',
};

function yonetimTablolari(db) {
    // Kullanim ozeti icin: son giris ani (her oturum acilisinda yazilir, bkz authMiddleware.signToken)
    db.run('ALTER TABLE users ADD COLUMN son_giris_at TEXT', [], () => {});

    // - YONETIM GUNLUGU: root'un yaptigi her degisiklik (lisans, odeme, modul, katalog, ayar, duyuru, destek...) -
    // ozet: insanin okuyacagi tek satir; ayrinti: JSON (once/sonra degerleri). Sifre/jeton gibi alanlar YAZILMAZ.
    // isletme_adi: yazildigi andaki ad (kopya): isletme sonradan silinse de kayit okunur kalsin.
    db.run(`CREATE TABLE IF NOT EXISTS yonetim_gunlugu (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        root_id TEXT,
        cihaz_id TEXT,
        islem TEXT NOT NULL,
        tenant_id TEXT,
        isletme_adi TEXT,
        hedef_tur TEXT,
        hedef_id TEXT,
        ozet TEXT,
        ayrinti TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_yonetim_gunlugu_zaman ON yonetim_gunlugu(created_at)', [], () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_yonetim_gunlugu_tenant ON yonetim_gunlugu(tenant_id, created_at)', [], () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_yonetim_gunlugu_islem ON yonetim_gunlugu(islem, created_at)', [], () => {});

    // - ISLETME IC NOTLARI: yalniz root gorur ("Aradim, persembe donecek") -
    // Silme yumusak (silindi_at): yanlislikla silinen not gunlukten geri okunabilsin.
    db.run(`CREATE TABLE IF NOT EXISTS isletme_notlari (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        metin TEXT NOT NULL,
        root_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        silindi_at TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_isletme_notlari ON isletme_notlari(tenant_id, created_at)', [], () => {});

    // - DUYURULAR: isletme panelinin ustundeki sakin serit -
    // hedef: tum | adisyon (Adisyon ve Kasa olanlar) | menu (yalniz QR menu kipi) | deneme | odemeli
    // kimler: yonetici (sahip + mudur) | herkes (panele giren her rol)
    // baslangic / bitis: 'YYYY-MM-DD' (Istanbul gunu, ikisi de dahil); bos = sinirsiz
    db.run(`CREATE TABLE IF NOT EXISTS duyurular (
        id TEXT PRIMARY KEY,
        baslik TEXT NOT NULL,
        metin TEXT,
        baglanti TEXT,
        baglanti_metni TEXT,
        hedef TEXT NOT NULL DEFAULT 'tum',
        kimler TEXT NOT NULL DEFAULT 'yonetici',
        baslangic TEXT,
        bitis TEXT,
        aktif INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`INSERT INTO duyurular (id, baslik, metin, baglanti, baglanti_metni, hedef, kimler, aktif)
            SELECT ?, ?, ?, ?, ?, 'tum', 'yonetici', 0
             WHERE NOT EXISTS (SELECT 1 FROM sistem_ayarlari WHERE anahtar = ?)
               AND NOT EXISTS (SELECT 1 FROM duyurular WHERE id = ?)`,
        [TOHUM_DUYURU.id, TOHUM_DUYURU.baslik, TOHUM_DUYURU.metin, TOHUM_DUYURU.baglanti, TOHUM_DUYURU.baglanti_metni,
            TOHUM_ISARETI, TOHUM_DUYURU.id], () => {});
    db.run('INSERT OR IGNORE INTO sistem_ayarlari (anahtar, deger) VALUES (?, datetime(\'now\'))', [TOHUM_ISARETI], () => {});

    // - DESTEK OTURUMLARI (Patron karari: her zaman yazma izinli) -
    // Root "Destek oturumu ac" der: 60 sn omurlu, tek kullanimlik giris jetonu uretilir (yalniz SHA-256 ozeti
    // burada). Jeton JWT'ye cevrildigi an oturum baslar (baslangic_at) ve sure ayardan (destek_oturumu_dk) sayilir.
    // Her istekte authMiddleware.protect bu satira bakar: bitis_at dolu ya da sure gecmisse 401.
    // kapanis_nedeni: DESTEK_KAPATTI | ROOT_KAPATTI | SURE_DOLDU | JETON_KULLANILMADI | YENI_OTURUM
    // Tum zamanlar ISO metni (toISOString): metin karsilastirmasi dogru calissin.
    db.run(`CREATE TABLE IF NOT EXISTS destek_oturumlari (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        root_id TEXT,
        sebep TEXT,
        sure_dk INTEGER NOT NULL,
        jeton_ozet TEXT UNIQUE,
        jeton_son_at TEXT NOT NULL,
        jeton_kullanildi_at TEXT,
        baslangic_at TEXT,
        planlanan_bitis_at TEXT,
        bitis_at TEXT,
        kapanis_nedeni TEXT,
        islem_sayisi INTEGER NOT NULL DEFAULT 0,
        son_islem_at TEXT,
        pin_atlandi_at TEXT,
        created_at TEXT NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_destek_tenant ON destek_oturumlari(tenant_id, created_at)', [], () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_destek_acik ON destek_oturumlari(bitis_at, created_at)', [], () => {});

    // Kuyrugun sonunda: ayarlara bagli sabitlerin (deneme gunu, salt-okunur gun...) onbellegi yuklensin
    db.run('SELECT 1', [], () => {
        require('../services/yonetimAyar').yukle().catch((e) => console.error('[yonetim] ayar yukleme:', e.message));
    });
}

module.exports = { yonetimTablolari, TOHUM_ISARETI, TOHUM_DUYURU };
