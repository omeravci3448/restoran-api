const { query, tx } = require('../config/db');

// --- KVKK: paket musteri bilgisinin silinmesi ---
// 1) SIPARIS: musteri adi / telefonu / adresi yalniz siparisi teslim etmek icin tutulur. Siparis kapandiktan
//    ya da iptal edildikten SAKLAMA_GUN gun sonra silinir: siparis, kalemler, tutar ve odemeler KALIR
//    (mali kayit), musteri_silindi_at damgasi atilir. Paket siparisinin serbest notu da silinir
//    (adres tarifi / isim icerebilir).
// 2) MUSTERI DEFTERI (paket_musterileri, Patron karari 2026-11-03): siparislerdeki silme deftere dokunmaz;
//    musteri DEFTER_SAKLAMA_GUN gun siparis vermezse kayit silinir.
// 3) "Musteriyi unut" (KVKK silme talebi): defter kaydi + o telefondaki ACIK OLMAYAN siparislerin kisisel
//    bilgisi hemen silinir. Acik siparis teslim icin bilgisini korur, kapaninca 1. kural isler.
const SAKLAMA_GUN = 30;
const DEFTER_SAKLAMA_GUN = 365;
const ARALIK_MS = 60 * 60 * 1000;   // saatte bir

// Paket Servis kanallari: telefon (PAKET) + esleme tablosundaki pazaryerleri (marketplace/paketEsleme.js)
const kanallar = () => require('./paketServis').paketKanallariSql();
const silmeSet = () => `musteri_ad = NULL, musteri_tel = NULL, musteri_adres = NULL,
                   note = CASE WHEN channel IN (${kanallar()}) THEN NULL ELSE note END,
                   musteri_silindi_at = COALESCE(musteri_silindi_at, CURRENT_TIMESTAMP)`;

async function temizle() {
    const r = await query(
        `UPDATE orders SET ${silmeSet()}
          WHERE musteri_silindi_at IS NULL
            AND status IN ('CLOSED', 'CANCELLED')
            AND COALESCE(closed_at, opened_at) < datetime('now', ?)
            AND (channel IN (${kanallar()})
                 OR musteri_ad IS NOT NULL OR musteri_tel IS NOT NULL OR musteri_adres IS NOT NULL)`,
        [`-${SAKLAMA_GUN} days`]);
    return r.changes || 0;
}

async function defterTemizle() {
    const r = await query(
        "DELETE FROM paket_musterileri WHERE COALESCE(son_siparis_at, created_at) < datetime('now', ?)",
        [`-${DEFTER_SAKLAMA_GUN} days`]);
    return r.changes || 0;
}

// "Musteriyi unut": { silinenSiparis, acikSiparis } ya da null (kayit yok / baska kiraci)
async function musteriyiUnut(tenantId, musteriId) {
    const { telNorm } = require('./paketServis');
    return tx(async () => {
        const m = (await query('SELECT id, tel_norm FROM paket_musterileri WHERE id = ? AND tenant_id = ?', [musteriId, tenantId])).rows[0];
        if (!m) return null;
        await query('DELETE FROM paket_musterileri WHERE id = ?', [m.id]);
        // Kisisel bilgisi duran siparisler 30 gunle sinirli; telefon bicimi farkli yazilmis olabilir -> JS'te karsilastir.
        // Ayni telefondan gelen pazaryeri (SofraMix) siparisinin yerel kopyasi da silinir (talep kisinin tum verisi icin).
        const adaylar = (await query(
            `SELECT id, status, musteri_tel FROM orders
              WHERE tenant_id = ? AND musteri_tel IS NOT NULL AND channel IN (${kanallar()})`, [tenantId])).rows
            .filter((o) => telNorm(o.musteri_tel) === m.tel_norm);
        const kapali = adaylar.filter((o) => o.status !== 'OPEN').map((o) => o.id);
        for (let i = 0; i < kapali.length; i += 200) {
            const parca = kapali.slice(i, i + 200);
            await query(`UPDATE orders SET ${silmeSet()} WHERE id IN (${parca.map(() => '?').join(',')})`, parca);
        }
        return { silinenSiparis: kapali.length, acikSiparis: adaylar.length - kapali.length };
    });
}

let zamanlayici = null;
async function tur() {
    try {
        const n = await temizle();
        if (n) console.log(`[paket-kvkk] ${n} paket siparisinde musteri bilgisi silindi (${SAKLAMA_GUN} gun doldu)`);
        const d = await defterTemizle();
        if (d) console.log(`[paket-kvkk] ${d} musteri defter kaydi silindi (${DEFTER_SAKLAMA_GUN} gundur siparis yok)`);
    } catch (e) { console.error('[paket-kvkk] temizlik hatasi:', e.message); }
}

function baslat() {
    if (zamanlayici) return zamanlayici;
    zamanlayici = setInterval(tur, ARALIK_MS);
    if (zamanlayici.unref) zamanlayici.unref();
    const ilk = setTimeout(tur, 30000);   // acilista DB hazir olsun
    if (ilk.unref) ilk.unref();
    return zamanlayici;
}

module.exports = { SAKLAMA_GUN, DEFTER_SAKLAMA_GUN, temizle, defterTemizle, musteriyiUnut, baslat };
