const { v4: uuidv4 } = require('uuid');
const { query, tx } = require('../../config/db');
const { toTL } = require('../money');

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

// Normalize edilmiş siparişi orders/order_items'a yaz (UPSERT).
// Var olan sipariş: durum ve tutarlar güncellenir, kalemler YENİDEN yazılmaz.
async function upsertOrder({ tenantId, channelCode, normalized, eventId }) {
    const n = normalized;
    const existing = await query(
        'SELECT id, status FROM orders WHERE tenant_id = ? AND channel = ? AND external_ref = ?',
        [tenantId, channelCode, n.externalOrderId]);

    if (existing.rows.length) {
        const orderId = existing.rows[0].id;
        await query(
            `UPDATE orders SET
                status = CASE WHEN ? IN ('CANCELLED','REJECTED') THEN 'CANCELLED'
                              WHEN ? = 'DELIVERED' THEN 'CLOSED' ELSE status END,
                channel_status_raw = ?, channel_sub = COALESCE(?, channel_sub),
                platform_modified_at = ?, raw_payload_id = COALESCE(?, raw_payload_id),
                total = COALESCE(?, total), subtotal = COALESCE(?, subtotal)
              WHERE id = ?`,
            [n.status, n.status, n.platformStatusRaw, n.subChannel, n.platformModifiedAt, eventId,
                toTL(n.money?.grandTotalKurus), toTL(n.money?.grandTotalKurus), orderId]);
        return { orderId, created: false };
    }

    const orderId = uuidv4();
    await tx(async () => {
        await query(
            `INSERT INTO orders
                (id, tenant_id, table_id, channel, external_ref, status, subtotal, total, note,
                 channel_sub, channel_status_raw, delivery_mode, is_test, is_address_masked,
                 external_order_no, platform_modified_at, raw_payload_id)
             VALUES (?, ?, NULL, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [orderId, tenantId, channelCode, n.externalOrderId,
                toTL(n.money?.grandTotalKurus) || 0, toTL(n.money?.grandTotalKurus) || 0,
                n.customerNote || null, n.subChannel, n.platformStatusRaw, n.deliveryMode,
                n.isTest ? 1 : 0, n.isAddressMasked ? 1 : 0, n.externalOrderNo,
                n.platformModifiedAt, eventId]);

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
