const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

// ——— 7 gunluk ucretsiz deneme ———
// Patron karari (2026-09-23): her isletme denemeyi YALNIZCA BIR KEZ alabilir.
// Yakalama olcutu:
//   - SofraMix'ten gelenlerde: SofraMix isletme numarasi (kesin olcut)
//   - Diger herkeste: normalize telefon numarasi
// Kayit, kiraci SILINSE BILE durur - yoksa hesabi silip yeniden deneme alinir.

const DENEME_GUN = Number(process.env.DENEME_GUN || 7);

// Telefonu karsilastirilabilir hale getir: rakam disini at, son 10 haneyi al.
// "0532 111 22 33", "+90 532 111 22 33", "532 111 2233" -> "5321112233"
function telefonNormalle(tel) {
    const rakam = String(tel || '').replace(/\D/g, '');
    if (rakam.length < 10) return null;
    return rakam.slice(-10);
}

// Daha once deneme almis mi? Almissa kaydi doner, almamissa null.
async function oncekiDeneme({ telefon, soframixBusinessId }) {
    if (soframixBusinessId) {
        const r = await query('SELECT * FROM deneme_kayitlari WHERE soframix_business_id = ?',
            [String(soframixBusinessId)]);
        if (r.rows.length) return r.rows[0];
    }
    const tn = telefonNormalle(telefon);
    if (tn) {
        const r = await query('SELECT * FROM deneme_kayitlari WHERE telefon_norm = ?', [tn]);
        if (r.rows.length) return r.rows[0];
    }
    return null;
}

// Deneme kaydi olustur. Cagiran taraf ONCE oncekiDeneme ile kontrol etmeli.
// Yine de UNIQUE indeks son emniyet kapisi (es zamanli iki istek).
async function denemeKaydet({ tenantId, telefon, soframixBusinessId, isletmeAdi, kaynak }) {
    const bitis = new Date();
    bitis.setDate(bitis.getDate() + DENEME_GUN);
    const id = uuidv4();
    await query(
        `INSERT INTO deneme_kayitlari
            (id, tenant_id, telefon_norm, soframix_business_id, isletme_adi, kaynak, bitis)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, tenantId || null, telefonNormalle(telefon), soframixBusinessId ? String(soframixBusinessId) : null,
            isletmeAdi || null, kaynak || 'dogrudan', bitis.toISOString()]);
    return { id, bitis };
}

// Son N gunde ayni telefon/isletme adiyla kac demo TALEBI gelmis?
// Patron'un onerisi: periyodik olarak bakip suistimali tespit et.
async function supheliTalepler({ gun = 30 } = {}) {
    const esik = new Date(Date.now() - gun * 86400000).toISOString();
    const r = await query(
        `SELECT telefon, COUNT(*) AS adet, GROUP_CONCAT(DISTINCT isletme) AS isletmeler
           FROM demo_talepleri
          WHERE created_at >= ?
          GROUP BY telefon
         HAVING COUNT(*) > 1
          ORDER BY adet DESC`,
        [esik]);
    return r.rows;
}

module.exports = { DENEME_GUN, telefonNormalle, oncekiDeneme, denemeKaydet, supheliTalepler };
