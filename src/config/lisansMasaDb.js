// --- Lisans masa siniri (Patron karari 2026-11-18) ---
// db.js initDb icinden TEK satirla cagrilir (db.serialize kuyrugunda): require('./lisansMasaDb').lisansMasaKolonlari(db)
//
//   tables.pasif_sebep                    'lisans': masa lisans siniri yuzunden pasife alindi (services/masaSiniri.js).
//                                         NULL: aktif masa ya da isletmenin sildigi masa (eski anlam aynen).
//                                         Lisans pasifi masanin kodu ve kisa karekodu DEGISMEZ; Masalar sayfasindan
//                                         yeniden aktif edilince ayni karekod calisir.
//   lisans_odemeleri.masa_uyari_onay_at   satin almada "aktif masa sayiniz paketin sinirinin uzerinde" uyarisinin
//                                         "Okudum, anladim" ile onaylandigi an (uyari yoksa NULL)
//   lisans_odemeleri.masa_uyari_aktif     o andaki aktif masa sayisi (uyari yoksa NULL)

function lisansMasaKolonlari(db) {
    db.run('ALTER TABLE tables ADD COLUMN pasif_sebep TEXT', [], () => {});
    db.run('ALTER TABLE lisans_odemeleri ADD COLUMN masa_uyari_onay_at TEXT', [], () => {});
    db.run('ALTER TABLE lisans_odemeleri ADD COLUMN masa_uyari_aktif INTEGER', [], () => {});
    db.run("CREATE INDEX IF NOT EXISTS idx_tables_lisans_pasif ON tables(tenant_id) WHERE pasif_sebep = 'lisans'", [], () => {});
}

module.exports = { lisansMasaKolonlari };
