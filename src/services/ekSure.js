const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');

// --- Ek sure tanimi: "Ek süre tanımla (rakipten geçiş)" (Patron karari 2026-11-18) ---
// Baska programdan gecen isletmenin o programda kalan lisans gunleri root tarafindan eklenir.
// Kosul: isletmenin en az bir ONAYLI lisans odemesi ya da islenmis SofraMix POS odemesi (pos_provizyon) olmali; yoksa
// 409 EK_SURE_ODEME_YOK "Ek süre ilk ödeme onaylandıktan sonra tanımlanabilir." (deneme isletmesine bedava sure
// verilmesin; deneme uzatma ayri: Lisansi uzat > deneme kipi).
// Gun: tam sayi >= 1 (isletme basina tavan yok; akil siniri 3650). Not zorunlu (en az 3, en fazla 300 karakter).
// Sure mevcut bitisin UZERINE eklenir; lisans bittiyse simdiden (posProvizyon.yeniBitis). Paket ve moduller degismez.
// Yonetim gunlugune yazilir, isletme sahiplerine e-posta gider (lisansBildirim.ekSure) ve isletmenin Lisans sayfasinda
// bir kez kapatilabilir bildirim gorunur (ek_sure_tanimlari.goruldu_at).

const AKIL_SINIRI_GUN = 3650;
const ODEME_YOK_MESAJI = 'Ek süre ilk ödeme onaylandıktan sonra tanımlanabilir.';
const hata = (status, message, code) => Object.assign(new Error(message), { status, code });
const tarihTR = (iso) => new Date(iso).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric' });
const metin = (gun, bitis) => `Ek lisans süreniz tanımlanmıştır: ${gun} gün. Yeni bitiş tarihiniz: ${tarihTR(bitis)}.`;

async function odemeVar(tenantId) {
    const r = await query(
        `SELECT (SELECT COUNT(*) FROM lisans_odemeleri WHERE tenant_id = ? AND durum = 'onaylandi')
              + (SELECT COUNT(*) FROM pos_provizyon WHERE tenant_id = ? AND durum = 'islendi') AS n`, [tenantId, tenantId]);
    return Number(r.rows[0].n) > 0;
}

// Doner { id, gun, oncekiBitis, yeniBitis, metin }
async function tanimla({ tenantId, gun, not, root = null, req = null }) {
    const g = Number(gun);
    if (!Number.isInteger(g) || g < 1 || g > AKIL_SINIRI_GUN) throw hata(400, `Gün sayısı 1 ile ${AKIL_SINIRI_GUN} arasında tam sayı olmalı.`);
    const n = String(not == null ? '' : not).trim();
    if (n.length < 3) throw hata(400, 'Açıklama zorunludur (örn. "X programı lisans ekranı, 143 gün").');
    if (n.length > 300) throw hata(400, 'Açıklama en fazla 300 karakter olabilir.');
    const t = (await query('SELECT id, business_name, license_end_date FROM tenants WHERE id = ?', [String(tenantId || '')])).rows[0];
    if (!t) throw hata(404, 'İşletme bulunamadı.');
    if (!(await odemeVar(t.id))) throw hata(409, ODEME_YOK_MESAJI, 'EK_SURE_ODEME_YOK');

    const yeniBitis = require('./posProvizyon').yeniBitis(t.license_end_date, g);
    const id = uuidv4();
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [yeniBitis, t.id]);
    await query(
        `INSERT INTO ek_sure_tanimlari (id, tenant_id, gun, aciklama, onceki_bitis, yeni_bitis, root_id, root_eposta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, t.id, g, n, t.license_end_date || null, yeniBitis, root ? root.id || null : null, root ? root.email || null : null]);
    const YG = require('./yonetimGunlugu');
    await YG.kaydet(req, { islem: 'ek_sure', tenantId: t.id, hedefTur: 'isletme', hedefId: t.id,
        ozet: `Ek süre tanımlandı (rakipten geçiş): ${g} gün; lisans ${YG.trTarih(t.license_end_date)} -> ${YG.trTarih(yeniBitis)}. Not: ${n}`,
        ayrinti: { gun: g, not: n, onceki: t.license_end_date || null, yeni: yeniBitis } });
    // Lisans durumu degisti: odeme korumasi onbellegi tazelensin; isletmeye e-posta (SMTP yoksa sessizce atlanir)
    require('./odemeKorumasi').tazele().catch(() => {});
    require('./lisansBildirim').ekSure(t.id, { gun: g, bitis: yeniBitis }).catch(() => {});
    return { id, gun: g, oncekiBitis: t.license_end_date || null, yeniBitis, metin: metin(g, yeniBitis), isletme: t.business_name };
}

// Isletmenin Lisans sayfasi: gorulmemis son ek sure bildirimi (yoksa {}).
async function bildirim(tenantId) {
    const r = (await query(
        `SELECT id, gun, yeni_bitis FROM ek_sure_tanimlari WHERE tenant_id = ? AND goruldu_at IS NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1`, [tenantId])).rows[0];
    return r ? { id: r.id, gun: r.gun, yeniBitis: r.yeni_bitis, metin: metin(r.gun, r.yeni_bitis) } : {};
}

// "Tamam": bu ve daha eski gorulmemis bildirimler kapanir (bir kez gosterilir)
async function goruldu(tenantId, id) {
    const r = (await query('SELECT created_at FROM ek_sure_tanimlari WHERE id = ? AND tenant_id = ?', [String(id || ''), tenantId])).rows[0];
    if (!r) throw hata(404, 'Bildirim bulunamadı.');
    await query('UPDATE ek_sure_tanimlari SET goruldu_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND goruldu_at IS NULL AND created_at <= ?',
        [tenantId, r.created_at]);
    await query('UPDATE ek_sure_tanimlari SET goruldu_at = COALESCE(goruldu_at, CURRENT_TIMESTAMP) WHERE id = ?', [String(id)]);
}

// Express uclari (licenseRoutes): kimlik protect ile
const sar = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
        if (e.status && e.status < 500) return res.status(e.status).json({ message: e.message, ...(e.code ? { code: e.code } : {}) });
        throw e;
    }
};
const bildirimUcu = sar(async (req, res) => res.json(await bildirim(req.user.tenantId)));
const gorulduUcu = sar(async (req, res) => { await goruldu(req.user.tenantId, req.params.id); res.json({ ok: true }); });

module.exports = { tanimla, bildirim, goruldu, bildirimUcu, gorulduUcu, odemeVar, metin, ODEME_YOK_MESAJI, AKIL_SINIRI_GUN };
