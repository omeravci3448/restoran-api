// --- Tavsiye sistemi ("Tavsiye et, süre kazan", Patron karari 2026-11-18) ---
// db.js initDb icinden TEK satirla cagrilir (db.serialize kuyrugunda):
//   require('./tavsiyeDb').tavsiyeTablolari(db)
// Kural ve akis: services/tavsiye.js.
//
// tenants.referral_code : isletmenin tavsiye kodu (kisa, buyuk harf, karisan karakter yok: I, O, 0, 1 kullanilmaz).
//                         Eski kayitlarda 'MDA' + 8 hex olabilir; onlar gecerli kalir. Kodu olmayan her isletmeye
//                         burada (acilista) kod verilir; sonradan acilan isletme ilk istekte alir (tavsiye.kodVer).
// tenants.referred_by   : kayitta yazilan tavsiye kodu (bilgi amacli; odul tavsiyeler tablosundan yurur).
// tavsiyeler            : tavsiye eden -> tavsiye edilen (edilen basina BIR satir). durum:
//   kayit           tavsiye edilen kayit oldu (deneme)
//   odeme_bekliyor  tavsiye edilen "Ödemeyi yaptım" dedi, onay bekleniyor (okurken tazelenir)
//   odul_bekliyor   tavsiye edilene +30 gun verildi; tavsiye edenin henuz onayli odemesi yok (+60 gun bekliyor)
//   odul_verildi    iki taraf da odulunu aldi
//   iptal           ayni isletme (telefon, e-posta, vergi no ya da ayni sube grubu): odul yok

const crypto = require('crypto');

const KOD_ALFABE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 karakter: I, O, 0, 1 yok
const KOD_UZUNLUK = 6;
// 256 % 32 = 0: her bayt esit olasilikla bir karaktere duser
const tavsiyeKoduUret = () => Array.from(crypto.randomBytes(KOD_UZUNLUK), (b) => KOD_ALFABE[b % KOD_ALFABE.length]).join('');

function tavsiyeTablolari(db) {
    db.run(`CREATE TABLE IF NOT EXISTS tavsiyeler (
        id TEXT PRIMARY KEY,
        tavsiye_eden_id TEXT NOT NULL,
        tavsiye_edilen_id TEXT NOT NULL UNIQUE,
        kod TEXT,
        kaynak TEXT,
        durum TEXT NOT NULL DEFAULT 'kayit',
        iptal_sebep TEXT,
        odeme_kaynak TEXT,
        odeme_ref TEXT,
        odeme_at TEXT,
        edilen_gun INTEGER,
        edilen_onceki_bitis TEXT,
        edilen_yeni_bitis TEXT,
        edilen_odul_at TEXT,
        edilen_goruldu_at TEXT,
        eden_gun INTEGER,
        eden_onceki_bitis TEXT,
        eden_yeni_bitis TEXT,
        eden_odul_at TEXT,
        eden_goruldu_at TEXT,
        son_hata TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_tavsiye_eden ON tavsiyeler(tavsiye_eden_id, durum)', [], () => {});
    db.run('CREATE INDEX IF NOT EXISTS idx_tavsiye_durum ON tavsiyeler(durum, created_at)', [], () => {});
    // Kod tekil (ALTER ile eklenen kolonda UNIQUE yoktu). Var olan cakisma varsa dizin kurulmaz; kod uretimi yine
    // her seferinde tabloya bakar.
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_referral_code ON tenants(referral_code)
             WHERE referral_code IS NOT NULL AND referral_code <> ''`, [], () => {});

    // Kodu olmayan isletmelere kod (bir kez; sonraki acilista bos kayit kalmaz). Cakisma olursa o satir bos kalir,
    // tavsiye.kodVer ilk istekte yeniden dener.
    db.all("SELECT id FROM tenants WHERE referral_code IS NULL OR TRIM(referral_code) = ''", [], (err, satirlar) => {
        if (err || !satirlar || !satirlar.length) return;
        for (const s of satirlar) {
            db.run("UPDATE tenants SET referral_code = ? WHERE id = ? AND (referral_code IS NULL OR TRIM(referral_code) = '')",
                [tavsiyeKoduUret(), s.id], () => {});
        }
    });
}

module.exports = { tavsiyeTablolari, tavsiyeKoduUret, KOD_ALFABE, KOD_UZUNLUK };
