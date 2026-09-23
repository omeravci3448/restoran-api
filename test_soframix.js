// SofraMix adaptoru - sozlesme testi. HICBIR ANAHTAR/AG GEREKTIRMEZ.
// Calistir:  node test_soframix.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');

const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const { getAdapter } = require('./src/marketplace/registry');
const { KIND } = require('./src/marketplace/errors');
const ingest = require('./src/marketplace/core/ingest');
const M = require('./src/marketplace/adapters/soframix/mapping');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };
async function throws(n, fn, kind) {
    try { await fn(); fail++; console.log('  FAIL ' + n + ' :: hata bekleniyordu'); }
    catch (e) {
        if (kind && e.kind !== kind) { fail++; console.log('  FAIL ' + n + ' :: kind=' + e.kind); }
        else { pass++; console.log('  OK  ' + n); }
    }
}

// —— Gercek SofraMix yanit sekli (api/src/routes/common.js orderWithItems) ——
const SIPARIS = {
    id: 4101, code: 'SMX-4101', status: 'yeni',
    delivery_type: 'isletme_kurye', payment_method: 'kapida_nakit', payment_status: 'bekliyor',
    customer_name: 'Deneme Musteri', customer_phone: '05550001122',
    address_json: JSON.stringify({ district: 'Merkez', full_address: 'Gazlıgöl Cad. 12/3', note: 'Zili calmayin' }),
    customer_note: 'Acisiz olsun',
    items_total_kurus: 28550, delivery_fee_kurus: 2000, total_kurus: 30550,
    kampanya_id: null, kampanya_indirim_kurus: 0, kampanya_baslik: '',
    created_at: '2026-09-22 17:40:00', confirmed_at: null,
    items: [
        { id: 900, product_id: 55, name: 'Adana Kebap', qty: 1,
          unit_price_kurus: 18550, total_kurus: 18550, note: 'ekmek az',
          options_json: JSON.stringify([
              { grup: 'Porsiyon', secenek: 'Buyuk boy', fark_kurus: 4000 },
              { grup: 'Aci', secenek: 'Acili', fark_kurus: 0 },
          ]) },
        { id: 901, product_id: 60, name: 'Ayran', qty: 2,
          unit_price_kurus: 5000, total_kurus: 10000, note: '', options_json: '[]' },
    ],
};
const kopya = (o) => JSON.parse(JSON.stringify(o));

(async () => {
    initDb(); await sleep(900);
    const smx = getAdapter('soframix');
    const ctx = { tenantId: 'X', credentials: { apiBase: 'https://test.soframix.com.tr', apiKey: 'K' },
                  storeLink: { externalStoreId: '7' }, http: async () => ({ ok: true, status: 200, text: async () => '{}' }) };

    console.log('\n=== 1) Yetenek beyani (Patron kararlarini yansitiyor mu?) ===');
    const c = smx.capabilities;
    ok('menuRead ACIK (SofraMixten cekilebilir)', c.menuRead === true);
    ok('menuWrite KAPALI (fiyat POStan itilmez)', c.menuWrite === false);
    ok('priceUpdate KAPALI', c.priceUpdate === false);
    ok('itemAvailability KAPALI (stok bitince paket kapanmaz)', c.itemAvailability === false);
    ok('partialCancel KAPALI (SofraMixte kalem iptali yok)', c.partialCancel === false);
    ok('prepTimeOnAccept KAPALI (SofraMixte alan yok, uydurmuyoruz)', c.prepTimeOnAccept === false);
    // SIPARIS YONU BILEREK KAPALI: SofraMix'in makine anahtari yalnizca
    // GET /api/business/menu ucunu aciyor, digerleri panel oturumu istiyor ve
    // GET disi her yontem 403 doner. true beyan etmek arayuzde calismayan
    // dugmeler acmak demekti (kasiyer "Hazir" der, siparis oldugu yerde kalir).
    ok('ingress polling (webhook/hibrit iddia edilmiyor)', c.ingress === 'polling', c.ingress);
    ok('acceptReject KAPALI (makine anahtari yazma yapamiyor)', c.acceptReject === false);
    ok('markReady KAPALI', c.markReady === false);
    ok('markDelivered KAPALI', c.markDelivered === false);
    ok('storeOpenClose KAPALI', c.storeOpenClose === false);
    ok('menuRead ACIK (tek gercekten calisan yon)', c.menuRead === true);

    console.log('\n=== 2) Siparis normalize ===');
    const ev = smx._toRawEvent(SIPARIS);
    const { order: n, unmapped } = await smx.normalizeOrder(ctx, ev);
    ok('dis siparis no', n.externalOrderId === '4101');
    ok('fise basilacak kod', n.externalOrderNo === 'SMX-4101');
    ok('durum yeni -> NEW', n.status === 'NEW');
    ok('teslimat: isletme kuryesi', n.deliveryMode === 'RESTAURANT_COURIER');
    ok('odeme: kapida nakit -> ON_DELIVERY/NAKIT',
        n.payment.settlement === 'ON_DELIVERY' && n.payment.posMethod === 'NAKIT');
    ok('toplam kurus', n.money.grandTotalKurus === 30550);
    ok('teslimat ucreti ayri', n.money.deliveryFeeKurus === 2000);
    ok('eslenmeyen alan yok', unmapped.length === 0, unmapped);

    console.log('\n--- Saat dilimi tuzagi (SofraMix UTC, Z eki YOK) ---');
    ok('created_at dogru UTC ms', n.placedAt === Date.parse('2026-09-22T17:40:00Z'), n.placedAt);

    console.log('\n--- Secenekler METNE cevriliyor (POSta modellenmiyor) ---');
    ok('2 kalem', n.items.length === 2);
    ok('secenek metni uretildi', n.items[0].secenekMetni === 'Buyuk boy, Acili', n.items[0].secenekMetni);
    ok('mutfak notu = secenek + musteri notu',
        n.items[0].note === 'Buyuk boy, Acili | ekmek az', n.items[0].note);
    ok('seceneksiz kalemde not bos', n.items[1].note === null);
    ok('secenek kimlikleri POSa TASINMIYOR', n.items[0].modifiers.length === 0);

    console.log('\n=== 3) Gel-al dali (hazir) vs adres dali (yolda) ===');
    const gelAl = kopya(SIPARIS); gelAl.id = 4102; gelAl.delivery_type = 'gel_al'; gelAl.status = 'hazir';
    const g = (await smx.normalizeOrder(ctx, smx._toRawEvent(gelAl))).order;
    ok('gel-al -> PICKUP', g.deliveryMode === 'PICKUP');
    ok('hazir -> READY', g.status === 'READY');
    ok('hazirlaniyor sonrasi gel-alda hazir', M.hazirlaniyorSonrasi('gel_al') === 'hazir');
    ok('hazirlaniyor sonrasi adreste yolda', M.hazirlaniyorSonrasi('isletme_kurye') === 'yolda');

    console.log('\n=== 4) Kampanyali siparis (POS yeniden HESAPLAMAZ) ===');
    const kmp = kopya(SIPARIS); kmp.id = 4103;
    kmp.kampanya_baslik = '2 alana 1 bedava'; kmp.kampanya_indirim_kurus = 5000; kmp.total_kurus = 25550;
    const k = (await smx.normalizeOrder(ctx, smx._toRawEvent(kmp))).order;
    ok('kampanya basligi tasindi', k.campaign.title === '2 alana 1 bedava');
    ok('indirim tutari SofraMixten aynen alindi', k.campaign.discountKurus === 5000);
    ok('toplam SofraMixin dedigi', k.money.grandTotalKurus === 25550);

    console.log('\n=== 5) Anonimlestirilmis adres (KVKK imhasi) - cokmemeli ===');
    const anon = kopya(SIPARIS); anon.id = 4104;
    anon.address_json = JSON.stringify({ district: 'Merkez', silindi: true });
    const a = (await smx.normalizeOrder(ctx, smx._toRawEvent(anon))).order;
    ok('cokmedi, maskeli isaretlendi', a.isAddressMasked === 1 && a.address.isMasked === 1);
    const bozuk = kopya(SIPARIS); bozuk.id = 4105; bozuk.address_json = 'BOZUK-JSON{';
    const b = (await smx.normalizeOrder(ctx, smx._toRawEvent(bozuk))).order;
    ok('bozuk adres JSONu coktermedi', b.address === null);

    console.log('\n=== 6) Bilinmeyen durum - cokme YOK, raporlanir ===');
    const bilinmez = kopya(SIPARIS); bilinmez.id = 4106; bilinmez.status = 'yeni_bir_durum';
    const r = await smx.normalizeOrder(ctx, smx._toRawEvent(bilinmez));
    ok('unmapped raporlandi', r.unmapped.some((u) => u.includes('yeni_bir_durum')), r.unmapped);
    ok('guvenli varsayilana dustu', r.order.status === 'NEW');
    ok('ham deger saklandi', r.order.platformStatusRaw === 'yeni_bir_durum');

    console.log('\n=== 7) SofraMix gecis matrisi (POS arayuzu bunu yansitmali) ===');
    ok('yeni iptal edilebilir', M.iptalEdilebilir('yeni') === true);
    ok('onaylandi iptal edilebilir', M.iptalEdilebilir('onaylandi') === true);
    ok('YOLDA iptal EDILEMEZ', M.iptalEdilebilir('yolda') === false);
    ok('HAZIR iptal EDILEMEZ', M.iptalEdilebilir('hazir') === false);
    ok('yoldayken teslim-edilemedi bildirilebilir', M.teslimEdilemediBildirilebilir('yolda') === true);
    ok('yeniyken teslim-edilemedi bildirilemez', M.teslimEdilemediBildirilebilir('yeni') === false);

    await throws('yolda iken iptal sunucuya GITMEDEN reddedildi',
        () => smx.cancelOrder(ctx, { externalOrderId: '4101', platformStatus: 'yolda', note: 'musteri vazgecti' }),
        KIND.CONFLICT);
    await throws('kisa iptal sebebi reddedildi',
        () => smx.cancelOrder(ctx, { externalOrderId: '4101', platformStatus: 'yeni', note: 'x' }),
        KIND.VALIDATION);
    await throws('kisa teslim-edilemedi sebebi reddedildi',
        () => smx.reportUndeliverable(ctx, { externalOrderId: '4101', note: 'yok' }),
        KIND.VALIDATION);

    console.log('\n=== 8) Istek sekli (ag YOK, gonderilen govde dogrulaniyor) ===');
    let son = null;
    const ctxY = Object.assign({}, ctx, {
        http: async (url, opts) => { son = { url, opts }; return { ok: true, status: 200, text: async () => '{}' }; },
    });
    await smx.acceptOrder(ctxY, { externalOrderId: '4101' });
    ok('kabul dogru uca gitti', son.url.endsWith('/api/business/orders/4101/status'), son.url);
    ok('kabul govdesi onaylandi', JSON.parse(son.opts.body).status === 'onaylandi');
    ok('makine anahtari basligi var', son.opts.headers['X-Smx-Anahtar'] === 'K');
    await smx.markDelivered(ctxY, { externalOrderId: '4101' });
    ok('teslim govdesi', JSON.parse(son.opts.body).status === 'teslim');
    await smx.cancelOrder(ctxY, { externalOrderId: '4101', platformStatus: 'yeni', note: 'urun kalmadi' });
    ok('iptalde sebep gonderildi', JSON.parse(son.opts.body).reason === 'urun kalmadi');

    console.log('\n=== 9) Menuyu SofraMixten cek (fiyat 0 + PASIF) ===');
    const menuCtx = Object.assign({}, ctx, {
        http: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
            categories: [{ id: 3, name: 'Kebaplar', sort: 1 }],
            products: [{ id: 55, category_id: 3, name: 'Adana Kebap', description: 'Zirh kiyma',
                         price_kurus: 22000, image_url: '/uploads/b7-abc.webp', sort: 0 }],
        }) }),
    });
    const menu = await smx.pullMenu(menuCtx);
    ok('kategori geldi', menu.kategoriler[0].name === 'Kebaplar');
    ok('urun geldi', menu.urunler[0].name === 'Adana Kebap');
    ok('GORSEL geldi', menu.urunler[0].imageUrl === '/uploads/b7-abc.webp');
    ok('FIYAT 0 geldi (isletme salon fiyatini girecek)', menu.urunler[0].priceKurus === 0);
    ok('urun PASIF geldi (0 TL kazara satilmasin)', menu.urunler[0].isActive === false);
    ok('SofraMix fiyati bilgi olarak duruyor', menu.urunler[0].platformPriceKurus === 22000);

    console.log('\n=== 10) Boru hatti: idempotency (ayni olay 5 kez -> 1 siparis) ===');
    const tid = 'SMXT-' + uuid().slice(0, 6), chId = uuid();
    await query('INSERT INTO tenants (id, slug, business_name) VALUES (?,?,?)', [tid, 's-' + tid, 'SMX Test']);
    await query('INSERT INTO marketplace_channels (id, tenant_id, name, adapter_code) VALUES (?,?,?,?)',
        [chId, tid, 'SofraMix', 'soframix']);
    const ictx = { tenantId: tid, channelId: chId, credentials: {}, storeLink: { externalStoreId: '7' } };
    const r1 = await ingest.processEvent({ adapter: smx, ctx: ictx, channelId: chId,
        channelCode: 'soframix', rawEvent: ev, source: 'poll' });
    ok('siparis olusturuldu', r1.created === true);
    let dup = 0;
    for (let i = 0; i < 5; i++) {
        const rr = await ingest.processEvent({ adapter: smx, ctx: ictx, channelId: chId,
            channelCode: 'soframix', rawEvent: ev, source: 'webhook' });
        if (rr.skipped === 'duplicate') dup++;
    }
    ok('5 tekrar -> 5 duplicate', dup === 5, dup);
    const say = (await query('SELECT COUNT(*) c FROM orders WHERE tenant_id=? AND external_ref=?', [tid, '4101'])).rows[0].c;
    ok('YINE TEK siparis', say === 1, say);
    const kal = (await query('SELECT * FROM order_items WHERE order_id=? ORDER BY product_name', [r1.orderId])).rows;
    ok('kalemler mukerrer yazilmadi', kal.length === 2, kal.length);
    ok('mutfak notunda secenek var', (kal[0].note || '').includes('Buyuk boy'), kal[0].note);
    const ord = (await query('SELECT * FROM orders WHERE id=?', [r1.orderId])).rows[0];
    ok('kanal soframix', ord.channel === 'soframix');
    ok('fis numarasi yazildi', ord.external_order_no === 'SMX-4101');
    ok('toplam TLye cevrildi', ord.total === 305.5, ord.total);

    await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id=?)', [tid]);
    await query('DELETE FROM orders WHERE tenant_id=?', [tid]);
    await query('DELETE FROM marketplace_events WHERE channel_id=?', [chId]);
    await query('DELETE FROM marketplace_channels WHERE tenant_id=?', [tid]);
    await query('DELETE FROM tenants WHERE id=?', [tid]);

    console.log('\n' + '='.repeat(52));
    console.log('SONUC: ' + pass + ' gecti, ' + fail + ' kaldi  (test verisi temizlendi)');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('COKTU:', e); process.exit(1); });
