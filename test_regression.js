// Regresyon: pazaryeri migrasyonları MEVCUT akışları bozdu mu?
// En kritik risk: orders üzerindeki yeni UNIQUE indeksin normal masa siparişlerini engellemesi.
const { query, initDb } = require('./src/config/db');
const { v4: uuid } = require('uuid');
const sleep = (m) => new Promise((r) => setTimeout(r, m));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n)) : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };

(async () => {
    initDb(); await sleep(900);
    const tid = 'REG-' + uuid().slice(0, 6), tbl = uuid();
    await query('INSERT INTO tenants (id,slug,business_name) VALUES (?,?,?)', [tid, 'r-' + tid, 'Regresyon']);
    await query('INSERT INTO tables (id,tenant_id,code,name,qr_token) VALUES (?,?,?,?,?)', [tbl, tid, 'M1', 'Masa 1', 'q-' + tid]);

    // 1) Birden fazla normal masa siparişi (external_ref NULL) açılabilmeli
    const ids = [];
    for (let i = 0; i < 3; i++) {
        const id = uuid(); ids.push(id);
        await query("INSERT INTO orders (id,tenant_id,table_id,channel,status,subtotal,total) VALUES (?,?,?,'DINE_IN','OPEN',0,0)", [id, tid, tbl]);
    }
    const c1 = (await query('SELECT COUNT(*) c FROM orders WHERE tenant_id=?', [tid])).rows[0].c;
    ok('3 normal masa siparişi açıldı (yeni indeks engellemedi)', c1 === 3, c1);

    // 2) Şeffaf Menü alanları
    const cid = uuid(), pid = uuid();
    await query('INSERT INTO categories (id,tenant_id,name) VALUES (?,?,?)', [cid, tid, 'K']);
    await query('INSERT INTO products (id,tenant_id,category_id,name,price,allergens,calories,contains_pork) VALUES (?,?,?,?,?,?,?,?)',
        [pid, tid, cid, 'Test', 100, JSON.stringify(['gluten', 'sut']), 450, 1]);
    const p = (await query('SELECT allergens,calories,contains_pork FROM products WHERE id=?', [pid])).rows[0];
    ok('Şeffaf Menü alanları bozulmadı', p.allergens === '["gluten","sut"]' && p.calories === 450 && p.contains_pork === 1, p);

    // 3) Kalem bazlı ödeme alanları
    const oid = ids[0], it = uuid();
    await query('INSERT INTO order_items (id,order_id,product_id,product_name,qty,unit_price,total) VALUES (?,?,?,?,?,?,?)', [it, oid, pid, 'Test', 2, 100, 200]);
    await query('UPDATE order_items SET paid_qty=1 WHERE id=?', [it]);
    const i = (await query('SELECT paid_qty,is_cancelled FROM order_items WHERE id=?', [it])).rows[0];
    ok('paid_qty (parçalı ödeme) çalışıyor', i.paid_qty === 1, i);
    ok('yeni is_cancelled varsayılanı 0', i.is_cancelled === 0, i);

    // 4) Aynı pazaryeri referansı iki kez eklenemez
    const a = uuid(), b = uuid(); let blocked = false;
    await query("INSERT INTO orders (id,tenant_id,channel,external_ref,status,subtotal,total) VALUES (?,?,'trendyolgo','X-1','OPEN',0,0)", [a, tid]);
    try {
        await query("INSERT INTO orders (id,tenant_id,channel,external_ref,status,subtotal,total) VALUES (?,?,'trendyolgo','X-1','OPEN',0,0)", [b, tid]);
    } catch (e) { blocked = /UNIQUE|constraint/i.test(e.message); }
    ok('mükerrer pazaryeri siparişi DB seviyesinde engellendi', blocked);

    // 5) FARKLI kiracıda aynı external_ref serbest olmalı
    const tid2 = 'REG2-' + uuid().slice(0, 6);
    await query('INSERT INTO tenants (id,slug,business_name) VALUES (?,?,?)', [tid2, 'r2-' + tid2, 'Regresyon2']);
    let crossOk = true;
    try {
        await query("INSERT INTO orders (id,tenant_id,channel,external_ref,status,subtotal,total) VALUES (?,?,'trendyolgo','X-1','OPEN',0,0)", [uuid(), tid2]);
    } catch (_) { crossOk = false; }
    ok('farklı kiracı aynı referansı kullanabilir', crossOk);

    for (const t of [tid, tid2]) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id=?)', [t]);
        await query('DELETE FROM orders WHERE tenant_id=?', [t]);
        await query('DELETE FROM products WHERE tenant_id=?', [t]);
        await query('DELETE FROM categories WHERE tenant_id=?', [t]);
        await query('DELETE FROM tables WHERE tenant_id=?', [t]);
        await query('DELETE FROM tenants WHERE id=?', [t]);
    }
    console.log(`\nREGRESYON: ${pass} geçti, ${fail} kaldı`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ÇÖKTÜ:', e.message); process.exit(1); });
