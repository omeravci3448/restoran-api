// Pazaryeri iskeleti — uçtan uca test. HİÇBİR API ANAHTARI GEREKTİRMEZ.
// Çalıştır:  node test_marketplace.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');

const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const { getAdapter, listAdapters, listAvailable } = require('./src/marketplace/registry');
const { toKurus, toTL } = require('./src/marketplace/money');
const { buildCapabilities } = require('./src/marketplace/capabilities');
const { AdapterError, KIND } = require('./src/marketplace/errors');
const BaseAdapter = require('./src/marketplace/adapters/BaseAdapter');
const ingest = require('./src/marketplace/core/ingest');
const cred = require('./src/marketplace/core/credentialStore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log('  OK  ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
};
async function throws(name, fn, kind) {
    try { await fn(); fail++; console.log('  FAIL ' + name + ' :: hata bekleniyordu'); }
    catch (e) {
        if (kind && e.kind !== kind) { fail++; console.log(`  FAIL ${name} :: kind=${e.kind}, beklenen ${kind}`); }
        else { pass++; console.log('  OK  ' + name); }
    }
}

(async () => {
    initDb(); await sleep(1000);

    console.log('\n=== 1) Şema migrasyonu ===');
    const cols = (await query('PRAGMA table_info(orders)')).rows.map((c) => c.name);
    ok('orders yeni kolonlar', ['channel_sub', 'channel_status_raw', 'delivery_mode', 'is_test',
        'external_order_no', 'platform_modified_at', 'seller_revenue'].every((c) => cols.includes(c)),
        cols.filter((c) => c.startsWith('channel') || c === 'delivery_mode'));
    const icols = (await query('PRAGMA table_info(order_items)')).rows.map((c) => c.name);
    ok('order_items yeni kolonlar', ['external_item_id', 'external_product_id', 'modifiers_json', 'is_cancelled']
        .every((c) => icols.includes(c)));
    const tbls = (await query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'marketplace_%'"))
        .rows.map((r) => r.name);
    ok('pazaryeri tabloları (7)', ['marketplace_credentials', 'marketplace_store_links', 'marketplace_events',
        'marketplace_commands', 'marketplace_sync_state', 'marketplace_product_map', 'marketplace_status_map']
        .every((t) => tbls.includes(t)), tbls);
    const idx = (await query("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_orders_channel_ref'")).rows;
    ok('idempotency indeksi kuruldu', idx.length === 1);

    console.log('\n=== 2) Para (kuruş) ===');
    ok('185.50 TL → 18550 kuruş', toKurus(185.5) === 18550);
    ok('0.1+0.2 tuzağı yok', toKurus(0.1) + toKurus(0.2) === toKurus(0.3));
    ok('kuruş → TL geri', toTL(18550) === 185.5);
    ok('3 ondalık yuvarlama (YS)', toKurus(12.345) === 1235, toKurus(12.345));
    ok('null güvenli', toKurus(null) === null && toTL(null) === null);

    console.log('\n=== 3) Yetenek beyanı ===');
    ok('varsayılanlar kapalı', buildCapabilities().acceptReject === false);
    let threw = false; try { buildCapabilities({ yanlisAlan: true }); } catch (_) { threw = true; }
    ok('bilinmeyen capability yakalanıyor', threw);

    console.log('\n=== 4) Adaptör kaydı ===');
    const all = listAdapters();
    ok('5 kanal kayıtlı', all.length === 5, all.map((a) => a.code));
    const avail = listAvailable().map((a) => a.code);
    ok('bağlanabilir: trendyolgo + sandbox', avail.includes('trendyolgo') && avail.includes('sandbox') && avail.length === 2, avail);
    const ys = all.find((a) => a.code === 'yemeksepeti');
    ok('yemeksepeti blocker açıklıyor', ys.available === false && /PGP|onay/i.test(ys.blocker));
    const mig = all.find((a) => a.code === 'migros');
    ok('migros blocker açıklıyor', mig.available === false && /Pos Firması|liste/i.test(mig.blocker));
    await throws('BaseAdapter varsayılan UNSUPPORTED',
        () => new BaseAdapter({ code: 'x', displayName: 'x', capabilities: {} }).acceptOrder(), KIND.UNSUPPORTED);

    console.log('\n=== 5) Trendyol GO adaptörü (ağ YOK, istek şekli doğrulanıyor) ===');
    const tgo = getAdapter('trendyolgo');
    ok('yetenek: menü yazma KAPALI (ürün oluşturma yok)', tgo.capabilities.menuWrite === false);
    ok('yetenek: settlements AÇIK (komisyon çekilebilir)', tgo.capabilities.settlements === true);
    ok('anahtar kapsamı supplier', tgo.capabilities.credentialScope === 'supplier');

    let captured = null;
    const fakeHttp = async (url, opts) => {
        captured = { url, opts };
        return { ok: true, status: 200, text: async () => JSON.stringify({ totalElements: 3, content: [] }) };
    };
    const ctx = {
        tenantId: 'T1', env: 'prod', http: fakeHttp,
        credentials: { supplierId: '4321', apiKey: 'AK', apiSecret: 'AS', executorUser: 'a@b.c' },
        storeLink: { externalStoreId: 'ST-9' },
    };
    await tgo.validateCredentials(ctx);
    ok('prod base URL', captured.url.startsWith('https://api.tgoapis.com/integrator'), captured.url);
    ok('Basic Auth doğru', captured.opts.headers.Authorization === 'Basic ' + Buffer.from('AK:AS').toString('base64'));
    ok('User-Agent zorunlu biçim', captured.opts.headers['User-Agent'] === '4321 - SelfIntegration',
        captured.opts.headers['User-Agent']);

    await tgo.fetchOrders(ctx, { statuses: ['Created'] });
    ok('sipariş servisinde x-agentname var', !!captured.opts.headers['x-agentname']);
    ok('sipariş servisinde x-executor-user var', captured.opts.headers['x-executor-user'] === 'a@b.c');
    ok('storeId sorguya eklendi', captured.url.includes('storeId=ST-9'));

    await tgo.acceptOrder(ctx, { externalOrderId: 'P1', prepTimeMinutes: 20 });
    ok('kabul → /packages/picked', captured.url.endsWith('/packages/picked'));
    ok('kabul gövdesi preparationTime', JSON.parse(captured.opts.body).preparationTime === 20);

    await throws('geçersiz iptal sebebi reddediliyor',
        () => tgo.rejectOrder(ctx, { externalOrderId: 'P1', reasonCode: 999 }), KIND.VALIDATION);
    await tgo.rejectOrder(ctx, { externalOrderId: 'P1', reasonCode: 621, itemIds: ['I-1'] });
    ok('geçerli sebep kabul (621)', JSON.parse(captured.opts.body).reasonId === 621);

    // En tehlikeli tuzak: storeId gönderilmezse TÜM şubelerin fiyatı ezilir
    await throws('fiyat güncellemede storeId zorunlu',
        () => tgo.updatePrices({ ...ctx, storeLink: {} }, { items: [{ externalProductId: 'P', priceKurus: 1000 }] }),
        KIND.VALIDATION);
    const job = await tgo.updatePrices(ctx, { items: [{ externalProductId: 'P-1', priceKurus: 18550 }] });
    ok('fiyat kuruş→TL çevrildi', JSON.parse(captured.opts.body).items[0].price === 185.5);
    ok('asenkron job referansı', job.jobRef !== undefined);

    // 403 ≠ geçersiz anahtar (anahtarı bozuk işaretleme tuzağı)
    const ctx403 = { ...ctx, http: async () => ({ ok: false, status: 403, text: async () => '{}' }) };
    try { await ctx403 && await tgo.validateCredentials(ctx403); } catch (e) {
        ok('403 → VALIDATION (AUTH değil)', e.kind === KIND.VALIDATION, e.kind);
    }
    const ctx401 = { ...ctx, http: async () => ({ ok: false, status: 401, text: async () => '{}' }) };
    try { await tgo.validateCredentials(ctx401); } catch (e) { ok('401 → AUTH', e.kind === KIND.AUTH, e.kind); }
    const ctx429 = { ...ctx, http: async () => ({ ok: false, status: 429, text: async () => '{}' }) };
    try { await tgo.validateCredentials(ctx429); } catch (e) {
        ok('429 → RATE_LIMIT + retryable', e.kind === KIND.RATE_LIMIT && e.retryable === true);
    }

    console.log('\n=== 6) Kimlik bilgisi şifreleme ===');
    const tid = 'MPT-' + uuid().slice(0, 6);
    const chId = uuid();
    await query('INSERT INTO tenants (id, slug, business_name) VALUES (?,?,?)', [tid, 'mp-' + tid, 'MP Test']);
    await query('INSERT INTO marketplace_channels (id, tenant_id, name, adapter_code) VALUES (?,?,?,?)',
        [chId, tid, 'Trendyol GO', 'trendyolgo']);
    const saved = await cred.saveCredentials({
        tenantId: tid, channelId: chId,
        fields: { supplierId: '4321', apiKey: 'GIZLI-KEY', apiSecret: 'COK-GIZLI', executorUser: 'a@b.c' },
    });
    ok('parmak izi maskeli', /^AK-••••/.test(saved.fingerprint), saved.fingerprint);
    const rowRaw = (await query('SELECT cipher_blob FROM marketplace_credentials WHERE id=?', [saved.id])).rows[0];
    ok('DB\'de düz metin YOK', !rowRaw.cipher_blob.includes('COK-GIZLI'));
    let got = null;
    await cred.withCredentials(tid, chId, async (c) => { got = { ...c }; });
    ok('çözülen değer doğru', got.apiSecret === 'COK-GIZLI' && got.supplierId === '4321');
    const masked = await cred.listCredentialsMasked(tid);
    ok('listede secret dönmüyor', masked.length === 1 && masked[0].cipher_blob === undefined);
    const red = cred.redact({ apiKey: 'x', apiSecret: 'y', nested: { password: 'z', ad: 'Ali' } });
    ok('log redaksiyonu', red.apiSecret === '••••' && red.nested.password === '••••' && red.nested.ad === 'Ali');

    console.log('\n=== 7) SİPARİŞ BORU HATTI (sandbox — anahtarsız) ===');
    const sbx = getAdapter('sandbox');
    const sctx = { tenantId: tid, channelId: chId, credentials: {}, storeLink: { externalStoreId: 'SBX-STORE-1' } };
    const { events } = await sbx.fetchOrders(sctx, { scenario: 'basic' });
    ok('sandbox olay üretti', events.length === 1);

    const norm = await sbx.normalizeOrder(sctx, events[0]);
    const n = norm.order;
    ok('normalize: dış sipariş no', n.externalOrderId === 'SBX-1001');
    ok('normalize: durum Created→NEW', n.status === 'NEW');
    ok('normalize: alt kanal', n.subChannel === 'TrendyolGo');
    ok('normalize: platform kuryesi', n.deliveryMode === 'PLATFORM_COURIER');
    ok('normalize: adres maskeli tespit edildi', n.isAddressMasked === 1);
    ok('normalize: toplam kuruş', n.money.grandTotalKurus === 28550, n.money);
    ok('normalize: 2 kalem', n.items.length === 2);
    ok('normalize: ayran adedi 2', n.items[1].quantity === 2);
    ok('normalize: ekstra malzeme', n.items[0].extras[0].name === 'Ekstra lavaş');
    ok('normalize: çıkarılan malzeme', n.items[0].removed[0].name === 'Soğan');

    const r1 = await ingest.processEvent({
        adapter: sbx, ctx: sctx, channelId: chId, channelCode: 'sandbox', rawEvent: events[0], source: 'poll',
    });
    ok('sipariş oluşturuldu', r1.created === true);
    const oRow = (await query('SELECT * FROM orders WHERE id=?', [r1.orderId])).rows[0];
    ok('orders.channel/external_ref yazıldı', oRow.channel === 'sandbox' && oRow.external_ref === 'SBX-1001');
    ok('orders.total TL olarak', oRow.total === 285.5, oRow.total);
    ok('orders.delivery_mode', oRow.delivery_mode === 'PLATFORM_COURIER');
    const its = (await query('SELECT * FROM order_items WHERE order_id=? ORDER BY product_name', [r1.orderId])).rows;
    ok('2 kalem yazıldı', its.length === 2);
    ok('kalem kaynağı MARKETPLACE', its[0].source === 'MARKETPLACE');
    ok('modifiers_json dolu', JSON.parse(its[0].modifiers_json).extras.length === 1);

    console.log('\n--- İDEMPOTENCY: aynı olay 6 kez ---');
    let dupes = 0;
    for (let i = 0; i < 6; i++) {
        const r = await ingest.processEvent({
            adapter: sbx, ctx: sctx, channelId: chId, channelCode: 'sandbox', rawEvent: events[0], source: 'poll',
        });
        if (r.skipped === 'duplicate') dupes++;
    }
    ok('6 tekrar → 6 duplicate', dupes === 6, dupes);
    const cnt = (await query('SELECT COUNT(*) c FROM orders WHERE tenant_id=? AND external_ref=?', [tid, 'SBX-1001'])).rows[0].c;
    ok('YİNE TEK sipariş var', cnt === 1, cnt);
    const icnt = (await query('SELECT COUNT(*) c FROM order_items WHERE order_id=?', [r1.orderId])).rows[0].c;
    ok('kalemler mükerrer yazılmadı', icnt === 2, icnt);

    console.log('\n--- Toplu alım + bilinmeyen durum kodu ---');
    const batch = await sbx.fetchOrders(sctx, { duplicate: true });   // tüm senaryolar, iki kez
    const res = await ingest.ingestBatch({
        adapter: sbx, ctx: sctx, channelId: chId, channelCode: 'sandbox', events: batch.events,
    });
    ok('yeni siparişler oluştu', res.created === 4, res);
    ok('tekrarlar elendi', res.duplicates === 6, res);
    ok('hiç hata yok', res.failed === 0, res);
    ok('bilinmeyen durum "unmapped" olarak raporlandı',
        res.unmapped.some((u) => /SomeNewStatusFromPlatform/.test(u)), res.unmapped);
    const unk = (await query('SELECT status, channel_status_raw FROM orders WHERE external_ref=?', ['SBX-1005'])).rows[0];
    ok('bilinmeyen durumda çökmedi, ham değer saklandı',
        unk && unk.channel_status_raw === 'SomeNewStatusFromPlatform', unk);

    console.log('\n--- Kiracı izolasyonu ---');
    const link = await ingest.resolveStoreLink({ channelId: chId, externalStoreId: 'YOK-BOYLE-MAGAZA' });
    ok('eşlenmemiş mağaza → null (kimseye yazılmaz)', link === null);

    console.log('\n=== 8) Finans (komisyon otomatik) ===');
    const st = await sbx.fetchSettlements(sctx, { from: '2026-07-01', to: '2026-07-10' });
    ok('komisyon verisi geldi', st.settlements[0].commissionAmountKurus === 4283, st.settlements[0]);
    ok('hakediş verisi geldi', st.settlements[0].sellerRevenueKurus === 24267);

    // Temizlik
    await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id=?)', [tid]);
    await query('DELETE FROM orders WHERE tenant_id=?', [tid]);
    await query('DELETE FROM marketplace_events WHERE channel_id=?', [chId]);
    await query('DELETE FROM marketplace_credentials WHERE tenant_id=?', [tid]);
    await query('DELETE FROM marketplace_channels WHERE tenant_id=?', [tid]);
    await query('DELETE FROM tenants WHERE id=?', [tid]);

    console.log(`\n${'='.repeat(50)}\nSONUÇ: ${pass} geçti, ${fail} kaldı  (test verisi temizlendi)`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ÇÖKTÜ:', e); process.exit(1); });
