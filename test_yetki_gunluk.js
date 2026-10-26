// Iptal / odeme silme yetkisi (yalniz OWNER/MANAGER) + islem gunlugu + garson siparisinde kasaya bildirim.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');

const PORT = 45967, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const GIZLI = 'test-gizli-anahtar-1234567890';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

function govde(x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: 779101, isletme_slug: 'yetki-test', isletme_adi: 'Yetki Test Lokanta',
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: '', unvan: '', vergi_dairesi: '', vergi_no: '',
        yetkili_ad: 'Yetki Sahibi', yetkili_email: 'yetki-sahibi@ornek.test', yetkili_tel: '05321112244',
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
    const t = await query("SELECT id FROM tenants WHERE business_name = 'Yetki Test Lokanta'");
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['payments', 'islem_gunlugu', 'orders', 'tables', 'products', 'categories', 'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('temizle', tb, e.message));
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM deneme_kayitlari WHERE soframix_business_id = '779101'");
    await query("DELETE FROM deneme_devir_nonce WHERE isletme_no = '779101'");
}

(async () => {
    initDb(); await uyu(900); await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               JWT_SECRET: 'yetki-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== Hazirlik: sahip + kasiyer + garson, masa, urun ===');
    const r = await fetch(baglanti(govde()), { redirect: 'manual' });
    const jeton = (r.headers.get('location') || '').split('/deneme-giris/')[1];
    const sahip = (await js('/api/public/deneme-giris/' + jeton, { method: 'POST' })).d;
    const me = (await js('/api/auth/me', { token: sahip.token })).d;
    const kas = await js('/api/auth/staff', { token: sahip.token, body: { email: 'kasiyer@ornek.test', password: 'kasiyer123', name: 'Kasiyer Ali', role: 'CASHIER' } });
    const gar = await js('/api/auth/staff', { token: sahip.token, body: { email: 'garson@ornek.test', password: 'garson123', name: 'Garson Veli', role: 'WAITER' } });
    ok('kasiyer ve garson olusturuldu', kas.status === 201 && gar.status === 201, [kas.status, gar.status]);
    const kasiyer = (await js('/api/auth/login', { body: { email: 'kasiyer@ornek.test', businessCode: me.businessCode, password: 'kasiyer123' } })).d;
    const garson = (await js('/api/auth/login', { body: { email: 'garson@ornek.test', businessCode: me.businessCode, password: 'garson123' } })).d;
    ok('kasiyer ve garson giris', !!kasiyer.token && !!garson.token);
    const masa = (await js('/api/tables', { token: sahip.token, body: { code: 'M1', name: 'M1', section: 'Salon' } })).d;
    const kat = (await js('/api/categories', { token: sahip.token, body: { name: 'Corbalar' } })).d;
    const urun = (await js('/api/products', { token: sahip.token, body: { name: 'Mercimek', price: 90, categoryId: kat.id, isAvailable: true } })).d;
    ok('masa + urun', !!masa.id && !!urun.id, [masa, urun]);

    console.log('\n=== 1) Siparis iptali: kasiyer 403, sahip 200 + cancelled_by + gunluk ===');
    const sip = (await js('/api/orders', { token: kasiyer.token, body: { tableId: masa.id } })).d;
    const kalem = await js('/api/orders/' + sip.id + '/items', { token: kasiyer.token, body: { productId: urun.id, qty: 2 } });
    ok('kasiyer siparis acip kalem ekleyebilir', kalem.status === 201, kalem);
    ok('kasiyer iptal edemez (403)', (await js('/api/orders/' + sip.id + '/cancel', { token: kasiyer.token, method: 'POST' })).status === 403);
    ok('garson iptal edemez (403)', (await js('/api/orders/' + sip.id + '/cancel', { token: garson.token, method: 'POST' })).status === 403);
    const ipt = await js('/api/orders/' + sip.id + '/cancel', { token: sahip.token, method: 'POST' });
    ok('sahip iptal eder (200)', ipt.status === 200, ipt);
    const o1 = (await query('SELECT status, cancelled_by FROM orders WHERE id = ?', [sip.id])).rows[0];
    ok('cancelled_by = sahip', o1.status === 'CANCELLED' && o1.cancelled_by === me.id, o1);
    const g1 = (await query("SELECT * FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'siparis_iptal'", [me.tenantId])).rows;
    ok('gunlukte iptal kaydi (kim + masa + tutar)', g1.length === 1 && g1[0].user_name && g1[0].detay.includes('M1') && g1[0].detay.includes('180'), g1);

    console.log('\n=== 2) Odeme silme: kasiyer 403, sahip 200 + gunluk ===');
    const sip2 = (await js('/api/orders', { token: kasiyer.token, body: { tableId: masa.id } })).d;
    await js('/api/orders/' + sip2.id + '/items', { token: kasiyer.token, body: { productId: urun.id, qty: 1 } });
    const od = await js('/api/payments', { token: kasiyer.token, body: { orderId: sip2.id, amount: 50, method: 'NAKIT' } });
    ok('kasiyer odeme alabilir', od.status === 201 || od.status === 200, od);
    const odId = (await query('SELECT id FROM payments WHERE order_id = ?', [sip2.id])).rows[0].id;
    ok('kasiyer odeme silemez (403)', (await js('/api/payments/' + odId, { token: kasiyer.token, method: 'DELETE' })).status === 403);
    const sil = await js('/api/payments/' + odId, { token: sahip.token, method: 'DELETE' });
    ok('sahip siler (200)', sil.status === 200, sil);
    const g2 = (await query("SELECT * FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'odeme_sil'", [me.tenantId])).rows;
    ok('gunlukte odeme silme kaydi', g2.length === 1 && g2[0].detay.includes('50'), g2);

    console.log('\n=== 3) Rapor ucu: islem gunlugu (yonetici sifresi arkasinda) ===');
    await js('/api/auth/manager-set', { token: sahip.token, body: { pin: 'yonetici6' } });
    const rp = await fetch(TABAN + '/api/reports/islem-gunlugu', { headers: { Authorization: 'Bearer ' + sahip.token, 'x-manager-pin': 'yonetici6' } });
    const rpd = await rp.json();
    ok('sahip gunlugu okur (2 kayit)', rp.status === 200 && Array.isArray(rpd) && rpd.length === 2, [rp.status, rpd && rpd.length]);
    ok('kasiyer gunlugu okuyamaz (403)', (await fetch(TABAN + '/api/reports/islem-gunlugu', { headers: { Authorization: 'Bearer ' + kasiyer.token, 'x-manager-pin': 'yonetici6' } })).status === 403);

    console.log('\n=== 4) Garson siparisi -> kasaya tek new_order olayi (2,5 sn toplanir) ===');
    const olaylar = [];
    const ac = new AbortController();
    fetch(TABAN + '/api/realtime/stream?token=' + encodeURIComponent(sahip.token), { signal: ac.signal, headers: { Authorization: 'Bearer ' + sahip.token } })
        .then(async (res) => { const rd = res.body.getReader(); const td = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; olaylar.push(td.decode(value)); } }).catch(() => {});
    await uyu(800);
    const sip3 = (await js('/api/orders', { token: garson.token, body: { tableId: masa.id } })).d;
    await js('/api/orders/' + sip3.id + '/items', { token: garson.token, body: { productId: urun.id, qty: 1 } });
    await js('/api/orders/' + sip3.id + '/items', { token: garson.token, body: { productId: urun.id, qty: 2 } });
    await uyu(3500);
    const metin = olaylar.join('');
    const sayi = (metin.match(/event: new_order/g) || []).length;
    ok('tek new_order olayi geldi', sayi === 1, { sayi, metin: metin.slice(0, 300) });
    ok('olayda garson adi + 3 kalem + masa', /"source":"WAITER"/.test(metin) && /Garson Veli/.test(metin) && /"addedItems":3/.test(metin) && /"tableName":"M1"/.test(metin), metin.slice(0, 400));
    ac.abort();

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
