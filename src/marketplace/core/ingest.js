const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../../config/db');
const { toTL } = require('../money');
const paket = require('../../services/paketServis');
const PaketEsleme = require('../paketEsleme');
const kvkk = require('../../services/paketKvkk');
const bus = require('../../services/eventBus');

// ——— Sipariş alım boru hattı (INBOX → normalize → orders) ———
//
// TEK EN ÖNEMLİ ÖZELLİK: İDEMPOTENCY. Platformlar aynı olayı defalarca gönderir
// (Yemeksepeti webhook'u 10sn içinde cevap alamazsa 10sn arayla 5 kez tekrar dener;
// polling'de de aynı sipariş her turda yeniden görünür). Aynı olay 6 kez gelse bile
// TEK sipariş oluşmalı ve mükerrer kalem yazılmamalı.
//
// İki katmanlı koruma:
//   1) marketplace_events UNIQUE(channel_id, event_key) → aynı olay ikinci kez işlenmez
//   2) orders UNIQUE(tenant_id, channel, external_ref)  → aynı sipariş ikinci kez açılmaz

// Olayı kutuya yaz. Zaten varsa {duplicate:true} döner ve İŞLENMEZ.
async function recordEvent({ tenantId, channelId, channelCode, source, rawEvent }) {
    const id = uuidv4();
    try {
        await query(
            `INSERT INTO marketplace_events
                (id, tenant_id, channel_id, channel_code, source, event_key, external_order_id,
                 platform_status, occurred_at, payload, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [id, tenantId, channelId, channelCode, source, rawEvent.eventKey, rawEvent.externalOrderId,
                rawEvent.platformStatus, rawEvent.occurredAt, JSON.stringify(rawEvent.payload)]);
        return { id, duplicate: false };
    } catch (e) {
        // UNIQUE ihlali = bu olayı zaten görmüşüz (retry/duplicate)
        if (/UNIQUE|constraint/i.test(e.message)) {
            const r = await query('SELECT id FROM marketplace_events WHERE channel_id = ? AND event_key = ?',
                [channelId, rawEvent.eventKey]);
            return { id: r.rows[0]?.id || null, duplicate: true };
        }
        throw e;
    }
}

// Kiracı izolasyonu bekçisi.
// Bir kiracının anahtarı platformdaki TÜM şubelerini kapsıyor (Trendyol supplierId,
// Yemeksepeti chain token). Gelen olaydaki mağaza bizde eşlenmemişse sipariş
// SESSİZCE BAŞKA KİRACIYA DÜŞMEKTENSE kaybolsun — 'ignored' işaretlenir.
async function resolveStoreLink({ channelId, externalStoreId }) {
    if (!externalStoreId) return null;
    const r = await query(
        `SELECT * FROM marketplace_store_links
          WHERE channel_id = ? AND external_store_id = ? AND is_active = 1 LIMIT 1`,
        [channelId, String(externalStoreId)]);
    return r.rows[0] || null;
}

// Teslim/iptal sonrasi isler (mutfaktan dusur, eksik odemeyi tamamla). Best-effort: hata siparis
// kaydini bozmaz, loglanir (olay 'failed' olursa tekrar islenmez, yari kalmis siparis daha kotu).
async function sonrakiIsler(orderId, s) {
    try {
        if (s === 'DISPATCHED' || s === 'DELIVERED') await paket.mutfakKalemleriniKapat(orderId);
        if (s === 'DELIVERED') await paket.otoOdemeYaz(orderId);
    } catch (e) { console.error('[ingest] teslim sonrasi isler:', e.message); }
}

// KVKK: islenen olayin ham yukunu bosalt (olay kaydi ve tekrar-koruma anahtari kalir; yuk islendikten
// sonra hicbir yerde okunmuyor).
async function yukuBosalt(eventId) {
    if (eventId) await query('UPDATE marketplace_events SET payload = ? WHERE id = ?', [kvkk.BOS_YUK, eventId]);
}

// Normalize edilmiş siparişi orders/order_items'a yaz (UPSERT).
// Var olan sipariş: durum ve tutarlar güncellenir, kalemler YENİDEN yazılmaz.
//
// Paket Servis (marketplace/paketEsleme.js'te satiri olan pazaryeri; bugun SofraMix): musteri
// adi/telefon/adres ve odeme sekli de yazilir (yeni sipariste ve guncellemede). Platform adresi
// maskeli/silinmis gonderirse yerel kopya da silinir; KVKK silmesi yapilmis siparise (musteri_silindi_at)
// kisisel veri bir daha yazilmaz.
// Teslim (DELIVERED): kapanis zamani yazilir (raporlar closed_at'e bakar) + odeme kaydi eksikse
// platformun odeme yontemiyle tamamlanir (tek sefer: kalan uzerinden).
async function upsertOrder({ tenantId, channelCode, normalized, eventId }) {
    const n = normalized;
    const s = n.status;
    const esleme = PaketEsleme.satir(channelCode);
    const kisisel = !!(esleme && esleme.musteri);
    const m = kisisel ? paket.musteriBilgisi(n) : { silindi: false, ad: null, tel: null, adres: null };
    const odemeKodu = esleme && n.payment && n.payment.methodCode ? String(n.payment.methodCode).slice(0, 40) : null;
    const zaman = paket.sqlZamani(n.platformModifiedAt);
    const existing = await query(
        'SELECT id, status, channel_status_raw, musteri_silindi_at FROM orders WHERE tenant_id = ? AND channel = ? AND external_ref = ?',
        [tenantId, channelCode, n.externalOrderId]);

    if (existing.rows.length) {
        const orderId = existing.rows[0].id;
        const yereldeAcik = existing.rows[0].status === 'OPEN';
        // Platform durumu yalniz ILERI gider. Kasadan "yola cikti" denildikten hemen sonra, ondan once
        // cekilmis eski bir olay islenirse durum geri gitmesin (ekranda dugmeler geri gelirdi).
        // Sira esleme satirinin normalize sozlugunden (satiri olmayan kanalda eski davranis).
        const geri = paket.geriMi(channelCode, existing.rows[0].channel_status_raw, n.platformStatusRaw);
        // Yerel durum, tutar, kapanis zamani ve damgalar YALNIZ siparis yerelde ACIKKEN degisir. Yerelde kapanmis /
        // iptal edilmis siparise gelen olay (ornek: kapanis zamani bos eski SofraMix kaydi platformda guncellendi)
        // kapanisi bugune cekmez, ciroyu/odemeyi degistirmez. Kosul SQL'de (SET ifadeleri ESKI satiri gorur).
        if (!geri) await query(
            `UPDATE orders SET
                status = CASE WHEN status <> 'OPEN' THEN status
                              WHEN ? IN ('CANCELLED','REJECTED') THEN 'CANCELLED'
                              WHEN ? = 'DELIVERED' THEN 'CLOSED' ELSE status END,
                closed_at = CASE WHEN status = 'OPEN' AND ? IN ('CANCELLED','REJECTED','DELIVERED') THEN COALESCE(closed_at, ?, CURRENT_TIMESTAMP) ELSE closed_at END,
                yola_cikti_at = CASE WHEN status = 'OPEN' AND ? = 'DISPATCHED' THEN COALESCE(yola_cikti_at, ?, CURRENT_TIMESTAMP) ELSE yola_cikti_at END,
                hazir_at = CASE WHEN status = 'OPEN' AND ? = 'READY' THEN COALESCE(hazir_at, ?, CURRENT_TIMESTAMP) ELSE hazir_at END,
                teslim_at = CASE WHEN status = 'OPEN' AND ? = 'DELIVERED' THEN COALESCE(teslim_at, ?, CURRENT_TIMESTAMP) ELSE teslim_at END,
                channel_status_raw = ?, channel_sub = COALESCE(?, channel_sub),
                platform_modified_at = ?, raw_payload_id = COALESCE(?, raw_payload_id),
                total = CASE WHEN status = 'OPEN' THEN COALESCE(?, total) ELSE total END,
                subtotal = CASE WHEN status = 'OPEN' THEN COALESCE(?, subtotal) ELSE subtotal END,
                is_address_masked = CASE WHEN ? = 1 THEN 1 ELSE is_address_masked END,
                odeme_sekli = COALESCE(?, odeme_sekli)
              WHERE id = ?`,
            [s, s, s, zaman, s, zaman, s, zaman, s, zaman,
                n.platformStatusRaw, n.subChannel, n.platformModifiedAt, eventId,
                toTL(n.money?.grandTotalKurus), toTL(n.money?.grandTotalKurus),
                n.isAddressMasked ? 1 : 0, odemeKodu, orderId]);
        let silinmis = !!existing.rows[0].musteri_silindi_at;
        if (kisisel && !silinmis) {
            if (m.silindi) {
                // Platform musteriyi sildi/maskeledi: yerel kopya, serbest not ve onceki olay yukleri de silinir
                await query(`UPDATE orders SET musteri_ad = NULL, musteri_tel = NULL, musteri_adres = NULL, note = NULL,
                                    musteri_silindi_at = CURRENT_TIMESTAMP WHERE id = ?`, [orderId]);
                await kvkk.siparisOlaylariniTemizle(tenantId, channelCode, n.externalOrderId);
                silinmis = true;
            } else if (yereldeAcik) {
                // Bilgi yalniz teslim edilecek (ACIK) sipariste tazelenir; kapanmis siparise yeniden yazilmaz
                await query('UPDATE orders SET musteri_ad = ?, musteri_tel = ?, musteri_adres = ? WHERE id = ?',
                    [m.ad, m.tel, m.adres, orderId]);
            }
        }
        // Kisisel bilgisi silinmis siparise (30 gun / platform silmesi / Musteriyi unut) yeni olay geldi: bu
        // olayin ham yuku de (platform hala tam bilgiyle gonderiyor olabilir) olay kutusunda durmasin.
        if (kisisel && silinmis) await yukuBosalt(eventId);
        // Mutfaktan dusurme / eksik odeme: yalniz yerelde ACIK siparis kapanirken (bir kez)
        if (!geri && yereldeAcik) await sonrakiIsler(orderId, s);
        return { orderId, created: false };
    }

    const orderId = uuidv4();
    // POS kapaliyken teslim/iptal olmus siparis ilk kez goruluyorsa ACIK acilmaz (eskiden hep OPEN aciliyordu
    // ve oyle kaliyordu: ayni olay bir daha gelmez).
    const yerel = ['CANCELLED', 'REJECTED'].includes(s) ? 'CANCELLED' : s === 'DELIVERED' ? 'CLOSED' : 'OPEN';
    const simdi = paket.sqlZamani(Date.now());
    const an = zaman || simdi;
    await tx(async () => {
        await query(
            `INSERT INTO orders
                (id, tenant_id, table_id, channel, external_ref, status, subtotal, total, note,
                 channel_sub, channel_status_raw, delivery_mode, is_test, is_address_masked,
                 external_order_no, platform_modified_at, raw_payload_id,
                 closed_at, yola_cikti_at, hazir_at, teslim_at,
                 musteri_ad, musteri_tel, musteri_adres, musteri_silindi_at, odeme_sekli)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [orderId, tenantId, channelCode, n.externalOrderId, yerel,
                toTL(n.money?.grandTotalKurus) || 0, toTL(n.money?.grandTotalKurus) || 0,
                kisisel && m.silindi ? null : (n.customerNote || null), n.subChannel, n.platformStatusRaw, n.deliveryMode,
                n.isTest ? 1 : 0, n.isAddressMasked ? 1 : 0, n.externalOrderNo,
                n.platformModifiedAt, eventId,
                yerel === 'OPEN' ? null : an,
                s === 'DISPATCHED' ? an : null, s === 'READY' ? an : null, s === 'DELIVERED' ? an : null,
                m.ad, m.tel, m.adres, kisisel && m.silindi ? simdi : null, odemeKodu]);

        for (const it of n.items || []) {
            await query(
                `INSERT INTO order_items
                    (id, order_id, product_id, product_name, qty, unit, unit_price, total, status, note, source,
                     external_item_id, external_product_id, modifiers_json, is_cancelled)
                 VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, 'NEW', ?, 'MARKETPLACE', ?, ?, ?, ?)`,
                [uuidv4(), orderId, it.name, it.quantity,
                    toTL(it.unitPriceKurus) || 0, toTL(it.lineTotalKurus) || 0, it.note || null,
                    it.externalItemId || null, it.externalProductId || null,
                    JSON.stringify({ modifiers: it.modifiers || [], extras: it.extras || [], removed: it.removed || [] }),
                    it.isCancelled ? 1 : 0]);
        }
    });
    await sonrakiIsler(orderId, s);
    if (kisisel && m.silindi) await yukuBosalt(eventId);   // ilk gorulen siparis zaten maskeli: ham yuk de tutulmaz
    // Kasaya canli uyari (SSE + ses + kart): yalniz Paket Servis ekranina dusen ACIK siparis. Ayri olay adi
    // ('paket_siparis'): garson uygulamasi 'new_order'i "QR siparisi" diye caliyor, ona karismasin.
    // Kisisel veri olaya KONMAZ (mutfak tableti / garson telefonu da bu akisi dinliyor).
    if (esleme && yerel === 'OPEN') {
        try {
            const normal = paket.hamNormal(channelCode, n.platformStatusRaw);
            bus.emit(tenantId, 'paket_siparis', {
                orderId, kaynak: 'PAZARYERI', kaynakAd: paket.kanalAdi(channelCode),
                etiket: paket.paketEtiketi({ channel: channelCode, external_order_no: n.externalOrderNo, external_ref: n.externalOrderId }),
                orderTotal: toTL(n.money?.grandTotalKurus) || 0, addedItems: (n.items || []).length,
                durum: n.platformStatusRaw,   // gelis anindaki durum: kasada zil bu durumdan cikilinca susar
                onayBekliyor: normal === 'NEW',
                dikkat: (esleme.dikkat || []).includes(normal),
            });
        } catch (_) { /* uyari best-effort */ }
    }
    return { orderId, created: true };
}

// Tek olayı uçtan uca işle.
async function processEvent({ adapter, ctx, channelId, channelCode, rawEvent, source = 'poll' }) {
    const rec = await recordEvent({
        tenantId: ctx.tenantId, channelId, channelCode, source, rawEvent,
    });
    if (rec.duplicate) return { skipped: 'duplicate', eventId: rec.id };

    try {
        const { order, unmapped } = await adapter.normalizeOrder(ctx, rawEvent);
        const res = await upsertOrder({
            tenantId: ctx.tenantId, channelCode, normalized: order, eventId: rec.id,
        });
        await query(
            "UPDATE marketplace_events SET state = 'done', processed_at = CURRENT_TIMESTAMP WHERE id = ?",
            [rec.id]);
        return { ...res, eventId: rec.id, unmapped: unmapped || [] };
    } catch (e) {
        await query(
            "UPDATE marketplace_events SET state = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?",
            [String(e.message).slice(0, 500), rec.id]);
        throw e;
    }
}

// Bir turda gelen tüm olayları işle (polling döngüsünün gövdesi).
async function ingestBatch({ adapter, ctx, channelId, channelCode, events, source = 'poll' }) {
    const out = { created: 0, updated: 0, duplicates: 0, failed: 0, unmapped: [] };
    for (const ev of events) {
        try {
            const r = await processEvent({ adapter, ctx, channelId, channelCode, rawEvent: ev, source });
            if (r.skipped === 'duplicate') out.duplicates++;
            else if (r.created) out.created++;
            else out.updated++;
            if (r.unmapped?.length) out.unmapped.push(...r.unmapped);
        } catch (_) { out.failed++; }
    }
    return out;
}

module.exports = { recordEvent, resolveStoreLink, upsertOrder, processEvent, ingestBatch };
