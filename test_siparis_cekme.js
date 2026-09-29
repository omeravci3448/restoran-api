// Pazaryeri siparislerini CEKME dongusu testi.
// Once bu dongu HIC YOKTU: adaptorlerin fetchOrders/normalizeOrder'i yazilmisti
// ama uretimde kimse cagirmiyordu, yani siparisler POS'a otomatik hic dusmuyor,
// kasiyer elle giriyordu.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const cred = require('./src/marketplace/core/credentialStore');
const cekici = require('./src/services/siparisCekici');

const uyu = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };

const AD = 'Cekme Testi Lokanta';

async function temizle() {
    const t = await query('SELECT id FROM tenants WHERE business_name = ?', [AD]);
    for (const r of t.rows) {
        for (const tb of ['order_items', 'orders', 'marketplace_events', 'marketplace_sync_state',
            'marketplace_store_links', 'marketplace_credentials', 'marketplace_channels', 'users']) {
            await query(`DELETE FROM ${tb} WHERE tenant_id = ?`, [r.id]).catch(() => {});
        }
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
}

async function kur(adapterCode) {
    const tenantId = uuid();
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, license_end_date, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [tenantId, 'cekme-' + uuid().slice(0, 8), '6' + String(Math.floor(Math.random() * 100000)).padStart(5, '0'),
            AD, new Date(Date.now() + 365 * 86400000).toISOString()]);
    const channelId = uuid();
    await query(
        `INSERT INTO marketplace_channels (id, tenant_id, name, adapter_code, is_active)
         VALUES (?, ?, ?, ?, 1)`, [channelId, tenantId, 'Test Kanal', adapterCode]);
    const k = await cred.saveCredentials({
        tenantId, channelId, scope: 'store', scopeRef: 'SBX-STORE-1', fields: { apiKey: 'x' } });
    await query(
        `INSERT INTO marketplace_store_links (id, tenant_id, channel_id, external_store_id, credential_id, is_active)
         VALUES (?, ?, ?, 'SBX-STORE-1', ?, 1)`, [uuid(), tenantId, channelId, k.id]);
    return { tenantId, channelId };
}

(async () => {
    initDb(); await uyu(900);
    await temizle();

    console.log('=== 1) Bagli kanal taraniyor ===');
    const { tenantId, channelId } = await kur('sandbox');
    const liste = await cekici.taranacaklar();
    ok('kanal tarama listesinde', liste.some(x => x.channel_id === channelId), liste.length);

    console.log('\n=== 2) Ilk tur: siparisler POSa dusuyor ===');
    const t1 = await cekici.birTur();
    ok('olay geldi', t1.gelen > 0, t1);
    ok('yeni siparis acildi', t1.yeni > 0, t1);
    const s1 = await query('SELECT COUNT(*) c FROM orders WHERE tenant_id = ?', [tenantId]);
    ok('siparis tabloda', s1.rows[0].c > 0, s1.rows[0]);

    console.log('\n=== 3) Ikinci tur: MUKERRER siparis acilmiyor ===');
    const t2 = await cekici.birTur();
    const s2 = await query('SELECT COUNT(*) c FROM orders WHERE tenant_id = ?', [tenantId]);
    ok('siparis sayisi artmadi', s2.rows[0].c === s1.rows[0].c, { once: s1.rows[0].c, sonra: s2.rows[0].c });
    ok('mukerrer olarak sayildi', t2.mukerrer > 0 || t2.yeni === 0, t2);

    console.log('\n=== 4) Imlec kaydediliyor ===');
    const im = await cekici.imlecOku({ tenantId, channelId, storeLinkId: null, resource: 'orders' });
    const im2 = (await query(
        "SELECT * FROM marketplace_sync_state WHERE tenant_id = ? AND resource = 'orders'", [tenantId])).rows[0];
    ok('imlec satiri var', !!im2, im2);
    ok('son basarili tur yazildi', !!(im2 && im2.last_ok_at), im2 && im2.last_ok_at);
    ok('hata sayaci sifir', im2 && im2.consecutive_errors === 0, im2 && im2.consecutive_errors);

    console.log('\n=== 4b) Kasadan platforma durum yazma (yeni uc) ===');
    // Provada ortaya cikti: adaptor yazabiliyordu ama POS'ta tetikleyen uc yoktu.
    const ctrl = require('./src/controllers/marketplaceController');
    const { getAdapter } = require('./src/marketplace/registry');
    const sbx = getAdapter('sandbox'); sbx._sent.length = 0;
    const sip = (await query("SELECT id, external_ref, channel_status_raw FROM orders WHERE tenant_id = ? AND channel = 'sandbox' LIMIT 1", [tenantId])).rows[0];
    const cagir = (govde, params) => new Promise((resolve) => {
        const res = { status(c) { this.c = c; return this; }, json(d) { resolve({ status: this.c || 200, data: d }); } };
        ctrl.siparisAksiyon({ params: { id: params }, body: govde, user: { tenantId } }, res).catch(e => resolve({ status: 500, data: { message: e.message } }));
    });
    const a1 = await cagir({ aksiyon: 'kabul' }, sip.id);
    ok('kabul et -> adaptor cagrildi', a1.status === 200 && sbx._sent.some(x => x.action === 'accept'), { a1, sent: sbx._sent });
    const d1 = (await query('SELECT channel_status_raw FROM orders WHERE id = ?', [sip.id])).rows[0];
    ok('yerel durum guncellendi', d1.channel_status_raw === 'onaylandi', d1);
    const a2 = await cagir({ aksiyon: 'hazir' }, sip.id);
    ok('hazir -> markReady cagrildi', a2.status === 200 && sbx._sent.some(x => x.action === 'ready'), a2);
    const a3 = await cagir({ aksiyon: 'iptal' }, sip.id);
    ok('iptal SEBEPSIZ reddedilir', a3.status === 400, a3);
    const a4 = await cagir({ aksiyon: 'ucmus_aksiyon' }, sip.id);
    ok('gecersiz aksiyon 400', a4.status === 400, a4);
    const a5 = await cagir({ aksiyon: 'kabul' }, 'yok-boyle-siparis');
    ok('baska/olmayan siparis 404', a5.status === 404, a5);
    const a6 = await cagir({ aksiyon: 'hazirlaniyor' }, sip.id);
    ok('adaptor desteklemeyen aksiyon 400 (sandbox markPreparing yok)', a6.status === 400, a6);

    console.log('\n=== 5) Adaptorsuz kanal TARANMIYOR ===');
    // adapter_code bos olan kanal yalnizca muhasebe etiketidir; taranirsa her
    // turda "bilinmeyen adaptor" hatasi uretirdi.
    const bosId = uuid();
    await query(
        `INSERT INTO marketplace_channels (id, tenant_id, name, adapter_code, is_active) VALUES (?, ?, ?, '', 1)`,
        [bosId, tenantId, 'Elle Giris']);
    const l2 = await cekici.taranacaklar();
    ok('adaptorsuz kanal listede yok', !l2.some(x => x.channel_id === bosId));

    console.log('\n=== 6) Pasif kanal taranmiyor ===');
    await query('UPDATE marketplace_channels SET is_active = 0 WHERE id = ?', [channelId]);
    ok('pasif kanal listede yok', !(await cekici.taranacaklar()).some(x => x.channel_id === channelId));
    await query('UPDATE marketplace_channels SET is_active = 1 WHERE id = ?', [channelId]);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
