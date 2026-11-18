const { query } = require('../config/db');

// --- Lisans masa siniri (Patron karari 2026-11-18) ---
// Isletmenin aktif masa sayisi yeni lisansin masa sinirinin uzerindeyse (orn. denemede yanlislikla 30 masa acip
// 5 masalik paket satin aldi): onayda TUM aktif masalar pasife alinir; isletme sahibi lisanstaki sayi kadar masayi
// Masalar sayfasindan yeniden aktif eder (bkz fe LisansPasifMasalar). Aktif edilen masanin karekodu calismaya
// devam eder: masa kodu ve kisa kod (kisa_kod) DEGISMEZ (silmeden farki budur).
//
// Istisna: ACIK HESABI ya da kasa onayi bekleyen QR siparisi olan masa aktif kalir (hesabi kapatilabilsin; aksi
// halde Masalar ekranindan kaybolurdu). Bu durumda aktif sayi gecici olarak sinirin uzerinde kalabilir; yeni masa
// acma ve yeniden aktif etme yine sinira tabidir.
//
// Cagrildigi yerler: root odeme onayi (rootController.lisansOdemeOnayla), root isletme duzenleme (masa siniri
// yazildiginda) ve SofraMix provizyonu (birlestirmede baska kol baglar). Sinir null = sinirsiz: hicbir sey yapilmaz.
// Doner: { uygulandi, sinir, aktifOnce, pasifeAlinan, acikKalan }

const SEBEP = 'lisans';

async function aktifSayi(tenantId) {
    const r = await query('SELECT COUNT(*) AS c FROM tables WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    return Number(r.rows[0].c) || 0;
}

const ACIK_ISI_VAR = `(EXISTS (SELECT 1 FROM orders o WHERE o.table_id = tables.id AND o.tenant_id = tables.tenant_id AND o.status = 'OPEN')
        OR EXISTS (SELECT 1 FROM qr_bekleyen_siparisler q WHERE q.table_id = tables.id AND q.tenant_id = tables.tenant_id AND q.durum = 'BEKLIYOR'))`;

async function siniriUygula(tenantId, yeniSinir, { kaynak = 'lisans', user = null } = {}) {
    const sinir = yeniSinir === '' || yeniSinir == null ? null : Number(yeniSinir);
    if (!tenantId || sinir == null || !Number.isFinite(sinir)) return { uygulandi: false, sinir: null };
    const aktifOnce = await aktifSayi(tenantId);
    if (aktifOnce <= sinir) return { uygulandi: false, sinir, aktifOnce, pasifeAlinan: 0, acikKalan: 0 };

    let acikKalan = 0;
    try {
        acikKalan = Number((await query(`SELECT COUNT(*) AS c FROM tables WHERE tenant_id = ? AND is_active = 1 AND ${ACIK_ISI_VAR}`,
            [tenantId])).rows[0].c) || 0;
    } catch (_) { acikKalan = 0; }
    let u;
    try {
        u = await query(`UPDATE tables SET is_active = 0, pasif_sebep = ?
                          WHERE tenant_id = ? AND is_active = 1 AND NOT ${ACIK_ISI_VAR}`, [SEBEP, tenantId]);
    } catch (e) {
        // qr_bekleyen_siparisler yoksa (cok eski veritabani) yalniz acik hesaba bakilir
        u = await query(`UPDATE tables SET is_active = 0, pasif_sebep = ?
                          WHERE tenant_id = ? AND is_active = 1
                            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id = tables.id AND o.status = 'OPEN')`, [SEBEP, tenantId]);
    }
    const pasifeAlinan = Number(u && u.changes) || 0;
    // Pasif masadan bekleyen garson cagrisi kalmasin (masa silmedeki gibi)
    await query(`UPDATE waiter_calls SET status = 'HANDLED', handled_at = CURRENT_TIMESTAMP
                  WHERE tenant_id = ? AND status = 'PENDING'
                    AND table_id IN (SELECT id FROM tables WHERE tenant_id = ? AND pasif_sebep = ? AND is_active = 0)`,
        [tenantId, tenantId, SEBEP]).catch(() => {});
    const detay = `Lisans sınırı ${sinir} masa: ${aktifOnce} aktif masadan ${pasifeAlinan} masa pasife alındı`
        + (acikKalan ? `, açık hesabı olan ${acikKalan} masa aktif kaldı` : '') + ` (${kaynak})`;
    console.log(`[masa-siniri] ${tenantId}: ${detay}`);
    await require('./islemGunlugu').kaydet({ tenantId, user, islem: 'masa_lisans_pasif', hedefTur: 'tenant', hedefId: tenantId, detay });
    return { uygulandi: true, sinir, aktifOnce, pasifeAlinan, acikKalan };
}

// Masalar sayfasi: lisans yuzunden pasif masalar + sinir
async function pasifListe(tenantId) {
    const r = await query(
        `SELECT id, code, name, section, kisa_kod FROM tables
          WHERE tenant_id = ? AND is_active = 0 AND pasif_sebep = ?
          ORDER BY section, LENGTH(code), code`, [tenantId, SEBEP]);
    return r.rows;
}

module.exports = { siniriUygula, pasifListe, aktifSayi, SEBEP };
