const { query, tx } = require('../config/db');

// --- KVKK: paket musteri bilgisinin silinmesi ---
// 1) SIPARIS: musteri adi / telefonu / adresi yalniz siparisi teslim etmek icin tutulur. Siparis kapandiktan
//    ya da iptal edildikten SAKLAMA_GUN gun sonra silinir: siparis, kalemler, tutar ve odemeler KALIR
//    (mali kayit), musteri_silindi_at damgasi atilir. Paket siparisinin serbest notu da silinir
//    (adres tarifi / isim icerebilir).
// 2) PAZARYERI OLAY KUTUSU (marketplace_events.payload): platformun ham siparisi (ad, telefon, adres, not)
//    burada da duruyor. Islenmis olayin yuku, ilgili siparisin kisisel bilgisi silinince (30 gun / platform
//    silmesi / Musteriyi unut) ya da olay SAKLAMA_GUN gunden eskiyse ve siparis acik degilse bosaltilir.
// 3) MUSTERI DEFTERI (paket_musterileri, Patron karari 2026-11-03): siparislerdeki silme deftere dokunmaz;
//    musteri DEFTER_SAKLAMA_GUN gun siparis vermezse kayit silinir.
// 4) "Musteriyi unut" (KVKK silme talebi): defter kaydi + o telefondaki ACIK OLMAYAN siparislerin kisisel
//    bilgisi ve olay yukleri hemen silinir. Acik siparis teslim icin bilgisini korur, kapaninca 1. kural isler.
const SAKLAMA_GUN = 30;
const DEFTER_SAKLAMA_GUN = 365;
const ARALIK_MS = 60 * 60 * 1000;   // saatte bir
const BOS_YUK = '{"kvkk":"silindi"}';
const ISLENMIS = "('done', 'failed', 'ignored')";   // 'pending' olay henuz islenmedi: yuku gerekli

// Paket Servis kanallari: telefon (PAKET_SERVIS) + esleme tablosundaki pazaryerleri (marketplace/paketEsleme.js)
const kanallar = () => require('./paketServis').paketKanallariSql();
const silmeSet = () => `musteri_ad = NULL, musteri_tel = NULL, musteri_adres = NULL,
                   note = CASE WHEN channel IN (${kanallar()}) THEN NULL ELSE note END,
                   musteri_silindi_at = COALESCE(musteri_silindi_at, CURRENT_TIMESTAMP)`;
// Olayin siparisi (ayni kiraci + kanal + platform siparis no)
const OLAY_SIPARISI = `o.tenant_id = marketplace_events.tenant_id AND o.channel = marketplace_events.channel_code
                       AND o.external_ref = marketplace_events.external_order_id`;

async function olaylariTemizle() {
    const a = await query(
        `UPDATE marketplace_events SET payload = ?
          WHERE state IN ${ISLENMIS} AND payload != ?
            AND EXISTS (SELECT 1 FROM orders o WHERE ${OLAY_SIPARISI} AND o.musteri_silindi_at IS NOT NULL)`,
        [BOS_YUK, BOS_YUK]);
    const b = await query(
        `UPDATE marketplace_events SET payload = ?
          WHERE state IN ${ISLENMIS} AND payload != ?
            AND received_at < datetime('now', ?)
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE ${OLAY_SIPARISI} AND o.status = 'OPEN')`,
        [BOS_YUK, BOS_YUK, `-${SAKLAMA_GUN} days`]);
    return (a.changes || 0) + (b.changes || 0);
}

// Tek siparisin olay yuklerini hemen bosalt (platform silmesi / maskelemesi, Musteriyi unut)
async function siparisOlaylariniTemizle(tenantId, kanal, externalRef) {
    if (!externalRef) return 0;
    const r = await query(
        `UPDATE marketplace_events SET payload = ?
          WHERE tenant_id = ? AND channel_code = ? AND external_order_id = ? AND state IN ${ISLENMIS} AND payload != ?`,
        [BOS_YUK, tenantId, kanal, String(externalRef), BOS_YUK]);
    return r.changes || 0;
}

async function temizle() {
    const r = await query(
        `UPDATE orders SET ${silmeSet()}
          WHERE musteri_silindi_at IS NULL
            AND status IN ('CLOSED', 'CANCELLED')
            AND COALESCE(closed_at, opened_at) < datetime('now', ?)
            AND (channel IN (${kanallar()})
                 OR musteri_ad IS NOT NULL OR musteri_tel IS NOT NULL OR musteri_adres IS NOT NULL)`,
        [`-${SAKLAMA_GUN} days`]);
    await olaylariTemizle();
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
        // Ayni telefondan gelen pazaryeri (SofraMix) siparisinin yerel kopyasi ve olay yuku de silinir.
        const adaylar = (await query(
            `SELECT id, status, musteri_tel, channel, external_ref FROM orders
              WHERE tenant_id = ? AND musteri_tel IS NOT NULL AND channel IN (${kanallar()})`, [tenantId])).rows
            .filter((o) => telNorm(o.musteri_tel) === m.tel_norm);
        const kapali = adaylar.filter((o) => o.status !== 'OPEN');
        const ids = kapali.map((o) => o.id);
        for (let i = 0; i < ids.length; i += 200) {
            const parca = ids.slice(i, i + 200);
            await query(`UPDATE orders SET ${silmeSet()} WHERE id IN (${parca.map(() => '?').join(',')})`, parca);
        }
        for (const o of kapali) await siparisOlaylariniTemizle(tenantId, o.channel, o.external_ref);
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

module.exports = {
    SAKLAMA_GUN, DEFTER_SAKLAMA_GUN, BOS_YUK, temizle, olaylariTemizle, siparisOlaylariniTemizle, defterTemizle, musteriyiUnut, baslat,
};
