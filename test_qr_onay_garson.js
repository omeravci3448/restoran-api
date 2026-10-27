// Garson kalem duzeltme kurali (15 dk, odemesiz, acik hesap, gunluk) + QR siparis kasa onayi
// (ayar, bekleyen tablo, SSE, onayla/reddet, hesap gorunumu, atlanan urun, sure dolumu, yaris).
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');

const PORT = 45969, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const GIZLI = 'test-gizli-anahtar-1234567890';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

function govde(x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: 779103, isletme_slug: 'qr-onay-test', isletme_adi: 'QR Onay Test Lokanta',
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: '', unvan: '', vergi_dairesi: '', vergi_no: '',
        yetkili_ad: 'Onay Sahibi', yetkili_email: 'onay-sahibi@ornek.test', yetkili_tel: '05321112266',
        deneme_gun: 7, damga_ms: Date.now(), gecerli_sn: 600, nonce: crypto.randomBytes(12).toString('hex'), ...x,
    };
}
const kanonik = (g) => JSON.stringify(g, Object.keys(g).sort());
function baglanti(g) {
    const u = new URL(TABAN + '/api/public/soframix-deneme');
    u.searchParams.set('v', '1');
    u.searchParams.set('yuk', Buffer.from(kanonik(g), 'utf8').toString('base64url'));
    u.searchParams.set('imza', crypto.createHmac('sha256', GIZLI).update(kanonik(g)).digest('hex'));
    return u.toString();
}
async function js(yol, { token, body, method } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
async function temizle() {
    // Bagimlilik sirasiyla: once cocuk tablolar, en son users ve tenants (FK acik).
    const t = await query("SELECT id FROM tenants WHERE business_name = 'QR Onay Test Lokanta'");
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['payments', 'stock_movements', 'orders', 'waiter_calls', 'qr_bekleyen_siparisler', 'tables', 'products', 'categories',
                          'marketplace_credentials', 'marketplace_store_links', 'marketplace_channels', 'license_cache', 'islem_gunlugu',
                          'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('  temizlik', tb, e.message));
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM deneme_kayitlari WHERE soframix_business_id = '779103'");
    await query("DELETE FROM deneme_devir_nonce WHERE isletme_no = '779103'");
}
const gunlukSay = (tid, islem) => query('SELECT * FROM islem_gunlugu WHERE tenant_id = ? AND islem = ? ORDER BY created_at', [tid, islem]).then(r => r.rows);

(async () => {
    initDb(); await uyu(900); await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               JWT_SECRET: 'qr-onay-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== Hazirlik ===');
    const r = await fetch(baglanti(govde()), { redirect: 'manual' });
    const jeton = (r.headers.get('location') || '').split('/deneme-giris/')[1];
    const sahip = (await js('/api/public/deneme-giris/' + jeton, { method: 'POST' })).d;
    const me = (await js('/api/auth/me', { token: sahip.token })).d;
    const tid = me.tenantId;
    await js('/api/auth/staff', { token: sahip.token, body: { email: 'qr-kasiyer@ornek.test', password: 'kasiyer123', name: 'Kasiyer Ayse', role: 'CASHIER' } });
    await js('/api/auth/staff', { token: sahip.token, body: { email: 'qr-garson@ornek.test', password: 'garson123', name: 'Garson Veli', role: 'WAITER' } });
    const kasiyer = (await js('/api/auth/login', { body: { email: 'qr-kasiyer@ornek.test', businessCode: me.businessCode, password: 'kasiyer123' } })).d;
    const garson = (await js('/api/auth/login', { body: { email: 'qr-garson@ornek.test', businessCode: me.businessCode, password: 'garson123' } })).d;
    const garsonMe = (await js('/api/auth/me', { token: garson.token })).d;
    const kasiyerMe = (await js('/api/auth/me', { token: kasiyer.token })).d;
    const m1 = (await js('/api/tables', { token: sahip.token, body: { code: 'M1', name: 'Masa 1', section: 'Salon' } })).d;
    const m2 = (await js('/api/tables', { token: sahip.token, body: { code: 'M2', name: 'Masa 2', section: 'Salon' } })).d;
    const kat = (await js('/api/categories', { token: sahip.token, body: { name: 'Corbalar' } })).d;
    const u1 = (await js('/api/products', { token: sahip.token, body: { name: 'Mercimek', price: 90, categoryId: kat.id, isAvailable: true } })).d;
    const u2 = (await js('/api/products', { token: sahip.token, body: { name: 'Ezogelin', price: 95, categoryId: kat.id, isAvailable: true } })).d;
    await query(`UPDATE tenants SET license_modules = '["BASE","MENU_DIGITAL","GARSON"]' WHERE id = ?`, [tid]);
    const slug = (await js('/api/tenant/me', { token: sahip.token })).d.slug;
    const q2 = (await query('SELECT qr_token FROM tables WHERE id = ?', [m2.id])).rows[0].qr_token;
    const pub = (yol, body) => js(`/api/public/m/${slug}/${q2}${yol}`, body ? { body } : {});
    ok('isletme + personel + masa + urun hazir', !!kasiyer.token && !!garson.token && !!m1.id && !!u1.id && !!u2.id);

    console.log('\n=== A) Garson kalem duzeltme ===');
    const sip = (await js('/api/orders', { token: garson.token, body: { tableId: m1.id } })).d;
    const k1 = (await js('/api/orders/' + sip.id + '/items', { token: garson.token, body: { productId: u1.id, qty: 2 } })).d;
    const k2 = (await js('/api/orders/' + sip.id + '/items', { token: garson.token, body: { productId: u2.id, qty: 1 } })).d;
    const ab = (await query('SELECT added_by FROM order_items WHERE id = ?', [k1.id])).rows[0];
    ok('kalemde added_by = garson', ab && ab.added_by === garsonMe.id, [ab, garsonMe.id]);
    const az = await js('/api/orders/' + sip.id + '/items/' + k1.id, { token: garson.token, method: 'PUT', body: { qty: 1 } });
    ok('garson adedi 2 -> 1 azaltir (200)', az.status === 200, az);
    const g1 = await gunlukSay(tid, 'kalem_azalt');
    ok('gunluk: kalem_azalt (garson adi + masa + urun)', g1.length === 1 && g1[0].user_name === 'Garson Veli' && /Masa 1/.test(g1[0].detay) && /Mercimek/.test(g1[0].detay) && /×2 → ×1/.test(g1[0].detay), g1);
    const art = await js('/api/orders/' + sip.id + '/items/' + k1.id, { token: garson.token, method: 'PUT', body: { qty: 3 } });
    ok('arttirma serbest ve gunluge yazilmaz', art.status === 200 && (await gunlukSay(tid, 'kalem_azalt')).length === 1, art);
    const sifir = await js('/api/orders/' + sip.id + '/items/' + k1.id, { token: garson.token, method: 'PUT', body: { qty: 0 } });
    ok('qty 0 reddedilir (400)', sifir.status === 400, sifir);
    const sl = await js('/api/orders/' + sip.id + '/items/' + k2.id, { token: garson.token, method: 'DELETE' });
    ok('garson taze kalemi siler (200)', sl.status === 200, sl);
    const g2 = await gunlukSay(tid, 'kalem_sil');
    ok('gunluk: kalem_sil (Ezogelin, 95 TL, WAITER)', g2.length === 1 && /Ezogelin/.test(g2[0].detay) && /95/.test(g2[0].detay) && /WAITER/.test(g2[0].detay), g2);
    const top = (await query('SELECT total FROM orders WHERE id = ?', [sip.id])).rows[0];
    ok('toplam yeniden hesaplandi (3 x 90 = 270)', Number(top.total) === 270, top);

    // 15 dk kurali
    await query("UPDATE order_items SET created_at = datetime('now', '-20 minutes') WHERE id = ?", [k1.id]);
    const eski = await js('/api/orders/' + sip.id + '/items/' + k1.id, { token: garson.token, method: 'DELETE' });
    ok('20 dk onceki kalemi garson silemez (409)', eski.status === 409 && /15 dakika/.test(eski.d.message), eski);
    const eskiAz = await js('/api/orders/' + sip.id + '/items/' + k1.id, { token: garson.token, method: 'PUT', body: { qty: 1 } });
    ok('... azaltamaz da (409)', eskiAz.status === 409, eskiAz);
    const kasaAz = await js('/api/orders/' + sip.id + '/items/' + k1.id, { token: kasiyer.token, method: 'PUT', body: { qty: 2 } });
    ok('kasiyer eski kalemi azaltir (200) + gunluk CASHIER', kasaAz.status === 200 && (await gunlukSay(tid, 'kalem_azalt')).some(x => x.user_name === 'Kasiyer Ayse' && /CASHIER/.test(x.detay)), kasaAz);

    // odeme alinmis hesap
    const k3 = (await js('/api/orders/' + sip.id + '/items', { token: garson.token, body: { productId: u2.id, qty: 1 } })).d;
    const od = await js('/api/payments', { token: kasiyer.token, body: { orderId: sip.id, amount: 50, method: 'NAKIT' } });
    ok('kasiyer kismi odeme aldi', od.status === 201 || od.status === 200, od);
    const odemeli = await js('/api/orders/' + sip.id + '/items/' + k3.id, { token: garson.token, method: 'DELETE' });
    ok('odeme alinmis hesapta garson silemez (409)', odemeli.status === 409 && /ödeme/.test(odemeli.d.message), odemeli);
    const kasaSil = await js('/api/orders/' + sip.id + '/items/' + k3.id, { token: kasiyer.token, method: 'DELETE' });
    ok('kasiyer siler (200)', kasaSil.status === 200, kasaSil);

    // kapali hesap
    await js('/api/orders/' + sip.id + '/cancel', { token: sahip.token, method: 'POST' });
    const kapali = await js('/api/orders/' + sip.id + '/items/' + k1.id, { token: kasiyer.token, method: 'DELETE' });
    ok('iptal edilmis hesapta kalem silinemez (409)', kapali.status === 409, kapali);
    const baskaMasa = await js('/api/orders/' + m2.id + '/items/' + k1.id, { token: kasiyer.token, method: 'DELETE' });
    ok('yanlis siparis id ile kalem bulunamaz (404)', baskaMasa.status === 404, baskaMasa);

    console.log('\n=== B) QR siparis: onay KAPALI (varsayilan) dogrudan hesaba ===');
    const p0 = (await js('/api/tenant/me', { token: sahip.token })).d;
    ok('qr_onay_gerekli varsayilan 0', Number(p0.qr_onay_gerekli) === 0, p0.qr_onay_gerekli);
    const d0 = await pub('/orders', { items: [{ productId: u1.id, qty: 1 }] });
    ok('dogrudan: 201 + orderId, pending yok', d0.status === 201 && d0.d.orderId && !d0.d.pending && d0.d.addedItems === 1, d0);
    const b0 = await pub('/bill');
    ok('hesapta 1 kalem, bekleyen bos', b0.d.items.length === 1 && Array.isArray(b0.d.bekleyen) && b0.d.bekleyen.length === 0, b0.d);
    const d0b = await pub('/orders', { items: [{ productId: 'yok', qty: 1 }] });
    ok('satista olmayan urun: 201 ama 0 kalem + atlanan', d0b.status === 201 && d0b.d.addedItems === 0 && d0b.d.atlanan.length === 1, d0b);

    console.log('\n=== C) QR siparis: onay ACIK ===');
    const ac = await js('/api/tenant/me', { token: sahip.token, method: 'PUT', body: { qrOnayGerekli: true } });
    ok('ayar acildi', ac.status === 200 && Number((await js('/api/tenant/me', { token: sahip.token })).d.qr_onay_gerekli) === 1, ac);
    const kasiyerAyar = await js('/api/tenant/me', { token: kasiyer.token, method: 'PUT', body: { qrOnayGerekli: false } });
    ok('kasiyer ayari degistiremez (403)', kasiyerAyar.status === 403, kasiyerAyar);

    const olaylar = [];
    const abc = new AbortController();
    fetch(TABAN + '/api/realtime/stream?token=' + encodeURIComponent(sahip.token), { signal: abc.signal, headers: { Authorization: 'Bearer ' + sahip.token } })
        .then(async (res) => { const rd = res.body.getReader(); const td = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; olaylar.push(td.decode(value)); } }).catch(() => {});
    await uyu(800);

    const d1 = await pub('/orders', { items: [{ productId: u1.id, qty: 2 }, { productId: u2.id, qty: 1 }], note: 'az tuzlu' });
    ok('bekleyen: 201 + pending:true + bekleyenId', d1.status === 201 && d1.d.pending === true && d1.d.bekleyenId && d1.d.addedItems === 2 && d1.d.addedSubtotal === 275, d1);
    const b1 = await pub('/bill');
    ok('hesap degismedi (1 kalem), bekleyen 2 kalem', b1.d.items.length === 1 && b1.d.bekleyen.length === 2 && b1.d.bekleyen[0].name === 'Mercimek', b1.d);
    const satir = (await query('SELECT * FROM qr_bekleyen_siparisler WHERE id = ?', [d1.d.bekleyenId])).rows[0];
    ok('tabloda BEKLIYOR + not + toplam', satir && satir.durum === 'BEKLIYOR' && satir.not_metni === 'az tuzlu' && Number(satir.toplam) === 275, satir);
    await uyu(600);
    const metin = olaylar.join('');
    ok('SSE: new_order pending:true', /event: new_order/.test(metin) && /"pending":true/.test(metin) && /"addedItems":2/.test(metin), metin.slice(0, 300));
    abc.abort();

    const liste = await js('/api/orders/qr-bekleyen', { token: kasiyer.token });
    ok('kasa listesi: 1 bekleyen, masa adi + 2 kalem', liste.status === 200 && liste.d.length === 1 && liste.d[0].table_name === 'Masa 2' && liste.d[0].items.length === 2 && liste.d[0].not_metni === 'az tuzlu', liste.d);

    const on = await js('/api/orders/qr-bekleyen/' + d1.d.bekleyenId + '/onayla', { token: kasiyer.token, method: 'POST' });
    ok('onayla: 200 + 2 kalem hesaba', on.status === 200 && on.d.addedItems === 2 && on.d.orderId && on.d.atlanan.length === 0, on);
    const b2 = await pub('/bill');
    ok('hesapta 3 kalem, bekleyen bos, toplam 365', b2.d.items.length === 3 && b2.d.bekleyen.length === 0 && Number(b2.d.total) === 365, b2.d);
    const kal = (await query("SELECT status, source, added_by FROM order_items WHERE order_id = ? ORDER BY created_at", [on.d.orderId])).rows;
    ok('onaylanan kalemler CUSTOMER_QR + SEEN + added_by kasiyer', kal.filter(x => x.status === 'SEEN' && x.source === 'CUSTOMER_QR' && x.added_by === kasiyerMe.id).length === 2, kal);
    const satir2 = (await query('SELECT durum, order_id, karar_veren FROM qr_bekleyen_siparisler WHERE id = ?', [d1.d.bekleyenId])).rows[0];
    ok('tablo ONAYLANDI + order_id + karar_veren', satir2.durum === 'ONAYLANDI' && satir2.order_id === on.d.orderId && satir2.karar_veren === kasiyerMe.id, satir2);
    const g3 = await gunlukSay(tid, 'qr_onay');
    ok('gunluk qr_onay (Masa 2, 2 kalem, 275)', g3.length === 1 && /Masa 2/.test(g3[0].detay) && /2 kalem/.test(g3[0].detay) && /275/.test(g3[0].detay), g3);
    ok('ikinci onay 409', (await js('/api/orders/qr-bekleyen/' + d1.d.bekleyenId + '/onayla', { token: kasiyer.token, method: 'POST' })).status === 409);
    ok('bilinmeyen id 404', (await js('/api/orders/qr-bekleyen/yok/onayla', { token: kasiyer.token, method: 'POST' })).status === 404);
    ok('liste bosaldi', (await js('/api/orders/qr-bekleyen', { token: kasiyer.token })).d.length === 0);

    console.log('\n=== D) Reddet ===');
    const d2 = await pub('/orders', { items: [{ productId: u2.id, qty: 3 }] });
    const red = await js('/api/orders/qr-bekleyen/' + d2.d.bekleyenId + '/reddet', { token: sahip.token, method: 'POST' });
    ok('reddet 200', red.status === 200, red);
    const b3 = await pub('/bill');
    ok('hesap degismedi (3 kalem), bekleyen bos', b3.d.items.length === 3 && b3.d.bekleyen.length === 0, b3.d);
    const g4 = await gunlukSay(tid, 'qr_red');
    ok('gunluk qr_red (1 kalem, 285)', g4.length === 1 && /1 kalem/.test(g4[0].detay) && /285/.test(g4[0].detay), g4);
    ok('reddedileni onaylama 409', (await js('/api/orders/qr-bekleyen/' + d2.d.bekleyenId + '/onayla', { token: sahip.token, method: 'POST' })).status === 409);
    ok('reddedileni tekrar reddetme 409', (await js('/api/orders/qr-bekleyen/' + d2.d.bekleyenId + '/reddet', { token: sahip.token, method: 'POST' })).status === 409);

    console.log('\n=== E) Onay aninda satistan kalkan urun + sure dolumu + yigilma ===');
    const d3 = await pub('/orders', { items: [{ productId: u1.id, qty: 1 }, { productId: u2.id, qty: 1 }] });
    await js('/api/products/' + u2.id, { token: sahip.token, method: 'PUT', body: { isAvailable: false } });
    const on3 = await js('/api/orders/qr-bekleyen/' + d3.d.bekleyenId + '/onayla', { token: kasiyer.token, method: 'POST' });
    ok('onayda satistan kalkan urun atlanir, digeri yazilir', on3.status === 200 && on3.d.addedItems === 1 && on3.d.atlanan.length === 1 && on3.d.atlanan[0] === 'Ezogelin', on3);
    const g5 = await gunlukSay(tid, 'qr_onay');
    ok('gunlukte atlanan urun yazili', g5.length === 2 && g5.some(x => /Ezogelin/.test(x.detay)), g5);
    await js('/api/products/' + u2.id, { token: sahip.token, method: 'PUT', body: { isAvailable: true } });
    const d4 = await pub('/orders', { items: [{ productId: u2.id, qty: 1 }] });
    await query("UPDATE qr_bekleyen_siparisler SET created_at = datetime('now', '-5 hours') WHERE id = ?", [d4.d.bekleyenId]);
    const liste2 = await js('/api/orders/qr-bekleyen', { token: kasiyer.token });
    const satir4 = (await query('SELECT durum FROM qr_bekleyen_siparisler WHERE id = ?', [d4.d.bekleyenId])).rows[0];
    ok('5 saatlik bekleyen listeden duser (SURESI_DOLDU)', liste2.d.length === 0 && satir4.durum === 'SURESI_DOLDU', [liste2.d, satir4]);
    for (let i = 0; i < 5; i++) await pub('/orders', { items: [{ productId: u1.id, qty: 1 }] });
    const d5 = await pub('/orders', { items: [{ productId: u1.id, qty: 1 }] });
    ok('6. bekleyen siparis 429 (yigilma freni)', d5.status === 429, d5);
    await query("UPDATE qr_bekleyen_siparisler SET durum = 'REDDEDILDI' WHERE tenant_id = ? AND durum = 'BEKLIYOR'", [tid]);
    const bos = await pub('/orders', { items: [{ productId: 'yok', qty: 1 }] });
    ok('satista olmayan urunle bekleyen acilmaz (400)', bos.status === 400, bos);

    console.log('\n=== F) Ayar kapaninca dogrudan akis geri gelir ===');
    await js('/api/tenant/me', { token: sahip.token, method: 'PUT', body: { qrOnayGerekli: false } });
    const d6 = await pub('/orders', { items: [{ productId: u2.id, qty: 1 }] });
    ok('dogrudan hesaba (pending yok)', d6.status === 201 && !d6.d.pending && d6.d.addedItems === 1, d6);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
