// --- Lisans odemesi: KDV kolonlari (Patron karari 2026-11-18) ---
// db.js initDb icinden TEK satirla cagrilir (db.serialize kuyrugunda): require('./lisansOdemeDb').lisansOdemeKolonlari(db)
//
// Katalog fiyatlari KDV HARIC kalir. tutar = KDV haric odenecek (eski anlam aynen; gelir raporlari KDV haric).
//   kdv_orani    talep anindaki oran (yuzde, orn 20)
//   kdv_tutari   tutar x oran (kurus hassasiyetinde)
//   genel_toplam tutar + kdv_tutari = musterinin havale edecegi tutar (KDV dahil)
// Eski kayitlarda uc kolon da NULL: arayuz "KDV hesaplanmamış" der, havale tutari olarak tutar gosterilir.

function lisansOdemeKolonlari(db) {
    for (const [ad, tip] of [['kdv_orani', 'REAL'], ['kdv_tutari', 'REAL'], ['genel_toplam', 'REAL']]) {
        db.run(`ALTER TABLE lisans_odemeleri ADD COLUMN ${ad} ${tip}`, [], () => {});
    }
    // Odeme korumasi ve son red sorgulari kiraci + durum ile arar
    db.run('CREATE INDEX IF NOT EXISTS idx_lisans_odeme_kiraci ON lisans_odemeleri(tenant_id, durum)', [], () => {});
    // Kuyrugun sonunda: odeme korumasi onbellegi (QR menu gibi senkron yerler ilk istekte de dogru gorsun)
    db.run('SELECT 1', [], () => {
        require('../services/yonetimAyar').yukle()
            .then(() => require('../services/odemeKorumasi').yukle())
            .catch((e) => console.error('[odeme-korumasi] ilk yukleme:', e.message));
    });
}

module.exports = { lisansOdemeKolonlari };
