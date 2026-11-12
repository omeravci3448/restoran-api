// --- MDA YAZILIM MAGAZASI (donanim satisi) TABLOLARI ---
//
// db.js initDb icinden TEK satirla cagrilir: require('./magazaDb').magazaTablolari(db);
// db.serialize() icinde calisir; her ifade idempotent (IF NOT EXISTS). Ileride eklenecek
// sutunlar "ALTER TABLE ... ADD COLUMN" + bos geri cagri ile buraya yazilir (hata yutulur).
//
// - Para KURUS cinsinden tamsayi: KDV ve toplamlarda kayan nokta hatasi olmasin.
// - Siparis satiri urun adini, birim fiyatini ve KDV oranini KOPYALAR: urun sonradan
//   degisse ya da silinse de siparis ve faturasi bozulmaz.
// - Kiraci tablosuna yabanci anahtar YOK: magaza siparisi fatura dayanagidir, kiraci
//   silinse bile kalmalidir (isletme adi ve isyeri kodu siparise kopyalanir).
// - Zaman damgalari ISO metin olarak uygulamadan yazilir (CURRENT_TIMESTAMP bicimi karismasin).

function magazaTablolari(db) {
    // Urunler. Taslak (yayin='TASLAK') urun isletmelere HIC donmez; silinen urun siparislerde
    // geciyorsa satir kalir, yalniz silindi_at damgalanir (yumusak silme).
    db.run(`CREATE TABLE IF NOT EXISTS magaza_urunler (
        id TEXT PRIMARY KEY,
        ad TEXT NOT NULL,
        kategori TEXT,
        kisa_aciklama TEXT,
        uzun_aciklama TEXT,
        ozellikler TEXT,                              -- JSON: [{"ad": "...", "deger": "..."}]
        fiyat_kurus INTEGER NOT NULL DEFAULT 0,       -- KDV HARIC birim fiyat
        kdv_orani REAL NOT NULL DEFAULT 20,
        stok_durumu TEXT NOT NULL DEFAULT 'STOKTA',   -- STOKTA | SIPARIS_UZERINE | TUKENDI
        stok_adedi INTEGER,                           -- NULL = adet takibi yok; 0 = kendiliginden Tukendi
        tedarik_gun INTEGER,                          -- "Siparis uzerine N gun"
        yayin TEXT NOT NULL DEFAULT 'TASLAK',         -- TASLAK | YAYINDA
        sira INTEGER NOT NULL DEFAULT 0,
        silindi_at TEXT,
        created_at TEXT,
        updated_at TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_magaza_urun_liste ON magaza_urunler(silindi_at, yayin, sira)');

    // Urun resimleri: dosya diskte (/uploads/magaza/...), burada yol + sira + kapak isareti.
    db.run(`CREATE TABLE IF NOT EXISTS magaza_urun_resimleri (
        id TEXT PRIMARY KEY,
        urun_id TEXT NOT NULL,
        yol TEXT NOT NULL,
        sira INTEGER NOT NULL DEFAULT 0,
        kapak INTEGER NOT NULL DEFAULT 0,
        boyut INTEGER,
        created_at TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_magaza_resim_urun ON magaza_urun_resimleri(urun_id, sira)');

    // Siparisler. no: insan-okur siparis numarasi (MG-1001), havale aciklamasina yazilir.
    // Fatura alanlari (fatura_*) YALNIZ root uclarinda doner; isletme tarafina hic gitmez.
    db.run(`CREATE TABLE IF NOT EXISTS magaza_siparisler (
        id TEXT PRIMARY KEY,
        no INTEGER NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        isletme_adi TEXT,
        isyeri_kodu TEXT,
        olusturan_kullanici_id TEXT,
        olusturan_ad TEXT,
        durum TEXT NOT NULL DEFAULT 'ODEME_BEKLENIYOR', -- ODEME_BEKLENIYOR | ODEME_ALINDI | HAZIRLANIYOR | KARGODA | TESLIM_EDILDI | IPTAL | REDDEDILDI
        odeme_yontemi TEXT NOT NULL DEFAULT 'HAVALE',   -- ileride: KART (iyzico)
        ara_toplam_kurus INTEGER NOT NULL DEFAULT 0,    -- urunler, KDV haric
        kdv_kurus INTEGER NOT NULL DEFAULT 0,           -- urunlerin KDV'si
        kargo_kurus INTEGER NOT NULL DEFAULT 0,         -- KDV dahil
        genel_toplam_kurus INTEGER NOT NULL DEFAULT 0,
        teslimat_alici TEXT,
        teslimat_telefon TEXT,
        teslimat_adres TEXT,
        fatura_tip TEXT,                                -- KURUMSAL (vergi no) | SAHIS (TC kimlik no)
        fatura_unvan TEXT,
        fatura_vergi_dairesi TEXT,
        fatura_vergi_no TEXT,
        fatura_tc_no TEXT,
        fatura_adres TEXT,
        siparis_notu TEXT,
        kosullar_kabul_at TEXT,                         -- "okudum, kabul ediyorum" ani
        kosullar_surum TEXT,                            -- kabul edilen metnin ozeti
        kosullar_metin TEXT,                            -- kabul edilen metnin kopyasi
        odeme_bildirildi_at TEXT,                       -- isletme "odemeyi yaptim" dedi
        odeme_referans TEXT,
        odeme_alindi_at TEXT,
        hazirlaniyor_at TEXT,
        kargo_firma TEXT,
        kargo_takip_no TEXT,
        kargoya_verildi_at TEXT,
        teslim_at TEXT,
        kapanis_at TEXT,                                -- IPTAL ya da REDDEDILDI ani
        kapatan TEXT,                                   -- ISLETME | ROOT
        kapanis_sebebi TEXT,
        ic_not TEXT,                                    -- yalniz root gorur
        fatura_kesildi_at TEXT,
        fatura_no TEXT,
        created_at TEXT,
        updated_at TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_magaza_siparis_kiraci ON magaza_siparisler(tenant_id, created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_magaza_siparis_durum ON magaza_siparisler(durum, created_at)');

    // Siparis kalemleri: urunun o anki kopyasi. stok_ayrildi: siparis olusurken stoktan ayrilan
    // adet; iptal/redde bu kadar geri doner.
    db.run(`CREATE TABLE IF NOT EXISTS magaza_siparis_kalemleri (
        id TEXT PRIMARY KEY,
        siparis_id TEXT NOT NULL,
        urun_id TEXT,
        urun_adi TEXT NOT NULL,
        kapak_yol TEXT,
        adet INTEGER NOT NULL,
        birim_fiyat_kurus INTEGER NOT NULL,             -- KDV haric
        kdv_orani REAL NOT NULL,
        tutar_kurus INTEGER NOT NULL,                   -- adet x birim, KDV haric
        kdv_kurus INTEGER NOT NULL,
        toplam_kurus INTEGER NOT NULL,
        stok_ayrildi INTEGER NOT NULL DEFAULT 0,
        sira INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(siparis_id) REFERENCES magaza_siparisler(id) ON DELETE CASCADE
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_magaza_kalem_siparis ON magaza_siparis_kalemleri(siparis_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_magaza_kalem_urun ON magaza_siparis_kalemleri(urun_id)');

    // Durum gecmisi: isletmenin "siparislerim" cizelgesi ve "kim ne zaman ne yapti" kaydi.
    db.run(`CREATE TABLE IF NOT EXISTS magaza_siparis_gecmisi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        siparis_id TEXT NOT NULL,
        olay TEXT NOT NULL,                             -- durum adi ya da ODEME_BILDIRIMI, FATURA, NOT
        aciklama TEXT,
        kim TEXT,                                       -- ISLETME | ROOT
        kim_ad TEXT,
        created_at TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_magaza_gecmis_siparis ON magaza_siparis_gecmisi(siparis_id, id)');

    // --- Inceleme turu (2026-11) - sonradan eklenen sutunlar (var olan veritabaninda ALTER, hata yutulur) ---
    // istek_anahtari: istemcinin urettigi tekil anahtar; ayni kiracida ayni anahtarla gelen ikinci istek ilk siparisi
    //   dondurur (cift tiklama / yeniden gonderim ikinci siparis acmasin).
    // otomatik_iptal_at / _gun: siparis olusurken o anki ayardan yazilir; ayar sonradan degisse de geriye donuk uygulanmaz.
    // ticari_beyan_at: "Urunleri ticari ya da mesleki faaliyetim icin satin aliyorum" onayinin ani.
    // iade_*: odemesi alinmis ve reddedilmis sipariste root'un "Iade yapildi" isareti (tarih + not; not isletmeye gitmez).
    for (const sql of [
        'ALTER TABLE magaza_siparisler ADD COLUMN istek_anahtari TEXT',
        'ALTER TABLE magaza_siparisler ADD COLUMN otomatik_iptal_at TEXT',
        'ALTER TABLE magaza_siparisler ADD COLUMN otomatik_iptal_gun INTEGER',
        'ALTER TABLE magaza_siparisler ADD COLUMN ticari_beyan_at TEXT',
        'ALTER TABLE magaza_siparisler ADD COLUMN iade_tarihi TEXT',
        'ALTER TABLE magaza_siparisler ADD COLUMN iade_notu TEXT',
        'ALTER TABLE magaza_siparisler ADD COLUMN iade_isaretlendi_at TEXT',
    ]) db.run(sql, [], () => {});
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_magaza_istek_anahtari ON magaza_siparisler(tenant_id, istek_anahtari)
            WHERE istek_anahtari IS NOT NULL`, [], () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_magaza_otomatik_iptal ON magaza_siparisler(durum, otomatik_iptal_at)', [], () => {});
}

module.exports = { magazaTablolari };
