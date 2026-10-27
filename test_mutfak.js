// Mutfak ekrani (KDS): KITCHEN rolu + personel duzenleme, kategori istasyonu, kuyruk (istasyon suzme,
// siralama, kapali/iptal disarida), durum gecisleri (rol + sira), SSE item_status, toplu islemler, tenant anahtari.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');

const PORT = 45970, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const GIZLI = 'test-gizli-anahtar-1234567890';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

function govde(x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: 779104, isletme_slug: 'mutfak-test', isletme_adi: 'Mutfak Test Lokanta',
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: '', unvan: '', vergi_dairesi: '', vergi_no: '',
        yetkili_ad: 'Mutfak Sahibi', yetkili_email: 'mutfak-sahibi@ornek.test', yetkili_tel: '05321112277',
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
    const t = await query("SELECT id FROM tenants WHERE business_name = 'Mutfak Test Lokanta'");
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['payments', 'stock_movements', 'orders', 'waiter_calls', 'qr_bekleyen_siparisler', 'tables', 'products', 'categories',
                          'marketplace_credentials', 'marketplace_store_links', 'marketplace_channels', 'license_cache', 'islem_gunlugu',
                          'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('  temizlik', tb, e.message));
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM deneme_kayitlari WHERE soframix_business_id = '779104'");
    await query("DELETE FROM deneme_devir_nonce WHERE isletme_no = '779104'");
}
const kalem = (id) => query('SELECT status, prep_started_at, ready_at, served_at FROM order_items WHERE id = ?', [id]).then(r => r.rows[0]);

(async () => {
    initDb(); await uyu(900); await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               JWT_SECRET: 'mutfak-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== Hazirlik + personel ===');
    const r = await fetch(baglanti(govde()), { redirect: 'manual' });
    const jeton = (r.headers.get('location') || '').split('/deneme-giris/')[1];
    const sahip = (await js('/api/public/deneme-giris/' + jeton, { method: 'POST' })).d;
    const me = (await js('/api/auth/me', { token: sahip.token })).d;
    const tid = me.tenantId;
    const giris = async (email, pw) => (await js('/api/auth/login', { body: { email, businessCode: me.businessCode, password: pw } })).d;
    await js('/api/auth/staff', { token: sahip.token, body: { email: 'm-kasiyer@ornek.test', password: 'kasiyer123', name: 'Kasiyer Ayse', role: 'CASHIER' } });
    await js('/api/auth/staff', { token: sahip.token, body: { email: 'm-garson@ornek.test', password: 'garson123', name: 'Garson Veli', role: 'WAITER' } });
    const mk = await js('/api/auth/staff', { token: sahip.token, body: { email: 'm-mutfak@ornek.test', password: 'mutfak123', name: 'Usta Hasan', role: 'KITCHEN' } });
    ok('KITCHEN rolunde personel acilir', mk.status === 201 && mk.d.role === 'KITCHEN', mk);
    const md = await js('/api/auth/staff', { token: sahip.token, body: { email: 'm-mudur@ornek.test', password: 'mudur123', name: 'Mudur Can', role: 'MANAGER' } });
    ok('sahip mudur acar', md.status === 201 && md.d.role === 'MANAGER', md);
    const kasiyer = await giris('m-kasiyer@ornek.test', 'kasiyer123');
    const garson = await giris('m-garson@ornek.test', 'garson123');
    const mutfak = await giris('m-mutfak@ornek.test', 'mutfak123');
    const mudur = await giris('m-mudur@ornek.test', 'mudur123');
    const mutfakMe = (await js('/api/auth/me', { token: mutfak.token })).d;
    ok('mutfak girisi: rol KITCHEN', !!mutfak.token && mutfakMe.role === 'KITCHEN', mutfakMe);
    ok('mutfak personel listesini goremez (403)', (await js('/api/auth/staff', { token: mutfak.token })).status === 403);
    ok('mutfak ayar degistiremez (403)', (await js('/api/tenant/me', { token: mutfak.token, method: 'PUT', body: { mutfakEkrani: true } })).status === 403);
    const mm = await js('/api/auth/staff', { token: mudur.token, body: { email: 'm-mudur2@ornek.test', password: 'mudur123', name: 'Mudur 2', role: 'MANAGER' } });
    ok('mudur mudur acamaz (403)', mm.status === 403, mm);

    console.log('\n=== Kategori istasyonu ===');
    const kCorba = (await js('/api/categories', { token: sahip.token, body: { name: 'Corbalar' } })).d;
    const kIcecek = (await js('/api/categories', { token: sahip.token, body: { name: 'Icecekler', istasyon: 'BAR' } })).d;
    const kSigara = (await js('/api/categories', { token: sahip.token, body: { name: 'Sigara', istasyon: 'YOK' } })).d;
    ok('kategori istasyonla acilir', !!kCorba.id && !!kIcecek.id && !!kSigara.id);
    ok('gecersiz istasyon 400 (create)', (await js('/api/categories', { token: sahip.token, body: { name: 'X', istasyon: 'TAVAN' } })).status === 400);
    ok('gecersiz istasyon 400 (update)', (await js('/api/categories/' + kCorba.id, { token: sahip.token, method: 'PUT', body: { istasyon: 'X' } })).status === 400);
    const kl = (await js('/api/categories', { token: sahip.token })).d;
    ok('listede istasyon: corba MUTFAK, icecek BAR, sigara YOK', kl.find(c => c.id === kCorba.id).istasyon === 'MUTFAK' && kl.find(c => c.id === kIcecek.id).istasyon === 'BAR' && kl.find(c => c.id === kSigara.id).istasyon === 'YOK', kl);
    const corba = (await js('/api/products', { token: sahip.token, body: { name: 'Mercimek', price: 90, categoryId: kCorba.id, isAvailable: true } })).d;
    const ayran = (await js('/api/products', { token: sahip.token, body: { name: 'Ayran', price: 35, categoryId: kIcecek.id, isAvailable: true } })).d;
    const sigara = (await js('/api/products', { token: sahip.token, body: { name: 'Sigara', price: 100, categoryId: kSigara.id, isAvailable: true } })).d;
    const m1 = (await js('/api/tables', { token: sahip.token, body: { code: 'M1', name: 'Masa 1', section: 'Salon' } })).d;
    const m2 = (await js('/api/tables', { token: sahip.token, body: { code: 'M2', name: 'Masa 2', section: 'Bahce' } })).d;
    await query(`UPDATE tenants SET license_modules = '["BASE","MENU_DIGITAL","GARSON"]' WHERE id = ?`, [tid]);

    console.log('\n=== Kuyruk ===');
    const s1 = (await js('/api/orders', { token: garson.token, body: { tableId: m1.id } })).d;
    const i1 = (await js('/api/orders/' + s1.id + '/items', { token: garson.token, body: { productId: corba.id, qty: 2, note: 'az tuzlu' } })).d;
    const i2 = (await js('/api/orders/' + s1.id + '/items', { token: garson.token, body: { productId: ayran.id, qty: 1 } })).d;
    await js('/api/orders/' + s1.id + '/items', { token: garson.token, body: { productId: sigara.id, qty: 1 } });
    const slug = (await js('/api/tenant/me', { token: sahip.token })).d.slug;
    const q2 = (await query('SELECT qr_token FROM tables WHERE id = ?', [m2.id])).rows[0].qr_token;
    const qr = await js(`/api/public/m/${slug}/${q2}/orders`, { body: { items: [{ productId: corba.id, qty: 1 }] } });
    ok('QR siparisi dogrudan hesaba (onay kapali)', qr.status === 201 && qr.d.orderId, qr);
    const i3 = (await query("SELECT id FROM order_items WHERE order_id = ?", [qr.d.orderId])).rows[0].id;
    const kq = await js('/api/mutfak/kuyruk?istasyon=HEPSI', { token: mutfak.token });
    ok('HEPSI: 2 kart, M1 2 kalem (sigara yok), sayac 3 bekliyor', kq.status === 200 && kq.d.kartlar.length === 2
        && kq.d.kartlar[0].tableName === 'Masa 1' && kq.d.kartlar[0].items.length === 2 && kq.d.sayac.bekleyen === 3, kq.d);
    ok('kalemde not + istasyon + createdAt', kq.d.kartlar[0].items[0].note === 'az tuzlu' && kq.d.kartlar[0].items[1].istasyon === 'BAR' && !!kq.d.kartlar[0].items[0].createdAt, kq.d.kartlar[0].items);
    ok('sunucuSaati var', !!kq.d.sunucuSaati);
    const kb = await js('/api/mutfak/kuyruk?istasyon=BAR', { token: mutfak.token });
    ok('BAR: yalniz ayran', kb.d.kartlar.length === 1 && kb.d.kartlar[0].items.length === 1 && kb.d.kartlar[0].items[0].name === 'Ayran', kb.d);
    const km = await js('/api/mutfak/kuyruk?istasyon=MUTFAK', { token: mutfak.token });
    ok('MUTFAK: 2 kart, corbalar', km.d.kartlar.length === 2 && km.d.kartlar.every(k => k.items.every(it => it.name === 'Mercimek')), km.d);
    ok('garson da kuyrugu okur (200)', (await js('/api/mutfak/kuyruk', { token: garson.token })).status === 200);

    console.log('\n=== Durum gecisleri ===');
    const olaylar = [];
    const abc = new AbortController();
    fetch(TABAN + '/api/realtime/stream?token=' + encodeURIComponent(sahip.token), { signal: abc.signal, headers: { Authorization: 'Bearer ' + sahip.token } })
        .then(async (res) => { const rd = res.body.getReader(); const td = new TextDecoder(); for (;;) { const { value, done } = await rd.read(); if (done) break; olaylar.push(td.decode(value)); } }).catch(() => {});
    await uyu(800);
    ok('garson hazirlaniyor diyemez (403)', (await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: garson.token, body: { durum: 'PREPARING' } })).status === 403);
    ok('garson hazir diyemez (403)', (await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: garson.token, body: { durum: 'READY' } })).status === 403);
    ok('gecersiz durum 400', (await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: mutfak.token, body: { durum: 'UCTU' } })).status === 400);
    ok('bilinmeyen kalem 404', (await js('/api/mutfak/kalem/yok/durum', { token: mutfak.token, body: { durum: 'READY' } })).status === 404);
    ok('NEW -> SERVED olmaz (409)', (await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: mutfak.token, body: { durum: 'SERVED' } })).status === 409);
    const p1 = await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: mutfak.token, body: { durum: 'PREPARING' } });
    const k1a = await kalem(i1.id);
    ok('mutfak basladi: PREPARING + prep_started_at', p1.status === 200 && k1a.status === 'PREPARING' && !!k1a.prep_started_at, [p1, k1a]);
    const geri = await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: mutfak.token, body: { durum: 'NEW' } });
    const k1b = await kalem(i1.id);
    ok('geri al: NEW + prep_started_at bos', geri.status === 200 && k1b.status === 'NEW' && !k1b.prep_started_at, k1b);
    await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: mutfak.token, body: { durum: 'PREPARING' } });
    const h1 = await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: mutfak.token, body: { durum: 'READY' } });
    const k1c = await kalem(i1.id);
    ok('hazir: READY + ready_at', h1.status === 200 && k1c.status === 'READY' && !!k1c.ready_at && !!k1c.prep_started_at, k1c);
    await uyu(500);
    const metin = olaylar.join('');
    ok('SSE item_status READY (Masa 1, Mercimek, 2)', /event: item_status/.test(metin) && /"status":"READY"/.test(metin) && /"tableName":"Masa 1"/.test(metin) && /"name":"Mercimek"/.test(metin), metin.slice(0, 400));
    ok('READY -> NEW gecisi yok... READY -> PREPARING geri al var', (await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: mutfak.token, body: { durum: 'PREPARING' } })).status === 200);
    await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: mutfak.token, body: { durum: 'READY' } });
    const sv = await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: garson.token, body: { durum: 'SERVED' } });
    const k1d = await kalem(i1.id);
    ok('garson servis etti: SERVED + served_at', sv.status === 200 && k1d.status === 'SERVED' && !!k1d.served_at, [sv, k1d]);
    ok('SERVED -> READY olmaz (409)', (await js('/api/mutfak/kalem/' + i1.id + '/durum', { token: mutfak.token, body: { durum: 'READY' } })).status === 409);
    const kq2 = await js('/api/mutfak/kuyruk', { token: mutfak.token });
    ok('servis edilen kuyruktan dustu (M1: 1 kalem)', kq2.d.kartlar.find(k => k.orderId === s1.id).items.length === 1, kq2.d);
    const kh = await js('/api/mutfak/kalem/' + i3 + '/durum', { token: kasiyer.token, body: { durum: 'READY' } });
    ok('kasiyer de hazir diyebilir (200)', kh.status === 200, [kh, i3, !!kasiyer.token]);
    abc.abort();

    console.log('\n=== Toplu islemler + istasyon suzgeci ===');
    const i4 = (await js('/api/orders/' + s1.id + '/items', { token: garson.token, body: { productId: corba.id, qty: 1 } })).d;
    const tb = await js('/api/mutfak/siparis/' + s1.id + '/durum', { token: mutfak.token, body: { durum: 'READY', istasyon: 'BAR' } });
    ok('toplu READY istasyon=BAR: yalniz ayran (adet 1)', tb.status === 200 && tb.d.adet === 1 && (await kalem(i2.id)).status === 'READY' && (await kalem(i4.id)).status === 'NEW', tb);
    const ts = await js('/api/mutfak/siparis/' + s1.id + '/durum', { token: garson.token, body: { durum: 'SERVED' } });
    ok('toplu SERVED (garson): hazir olan ayran (adet 1)', ts.status === 200 && ts.d.adet === 1 && (await kalem(i2.id)).status === 'SERVED', ts);
    const th = await js('/api/mutfak/siparis/' + s1.id + '/durum', { token: mutfak.token, body: { durum: 'READY' } });
    ok('toplu READY HEPSI: kalan corba (adet 1)', th.status === 200 && th.d.adet === 1 && (await kalem(i4.id)).status === 'READY', th);
    ok('garson toplu READY diyemez (403)', (await js('/api/mutfak/siparis/' + s1.id + '/durum', { token: garson.token, body: { durum: 'READY' } })).status === 403);
    ok('bilinmeyen siparis 404', (await js('/api/mutfak/siparis/yok/durum', { token: mutfak.token, body: { durum: 'READY' } })).status === 404);
    const i5 = (await js('/api/orders/' + qr.d.orderId + '/items', { token: kasiyer.token, body: { productId: ayran.id, qty: 1 } })).d;
    const sira = (await js('/api/mutfak/kuyruk', { token: mutfak.token })).d.kartlar;
    ok('siralama: bekleyeni olan M2 once, hepsi hazir M1 sona', sira.length === 2 && sira[0].tableName === 'Masa 2' && sira[1].tableName === 'Masa 1' && sira[1].bekleyen + sira[1].hazirlaniyor === 0 && sira[1].hazir === 1, sira.map(k => [k.tableName, k.bekleyen, k.hazirlaniyor, k.hazir]));
    ok('toplu SERVED: M1 hazir corba (adet 1)', (await js('/api/mutfak/siparis/' + s1.id + '/durum', { token: garson.token, body: { durum: 'SERVED' } })).d.adet === 1);
    ok('toplu: yapacak kalem yoksa adet 0', (await js('/api/mutfak/siparis/' + s1.id + '/durum', { token: garson.token, body: { durum: 'SERVED' } })).d.adet === 0);

    console.log('\n=== Kapali / iptal disarida ===');
    const s3 = (await js('/api/orders', { token: kasiyer.token, body: { tableId: m1.id } })).d; // ayni masa: acik olani dondurur
    ok('ayni masa acik siparisi dondurur', s3.id === s1.id);
    await js('/api/orders/' + s1.id + '/cancel', { token: sahip.token, method: 'POST' });
    const kq3 = await js('/api/mutfak/kuyruk', { token: mutfak.token });
    ok('iptal edilen hesap kuyrukta yok', !kq3.d.kartlar.find(k => k.orderId === s1.id), kq3.d.kartlar.map(k => k.orderId));
    ok('kapali hesapta durum degisimi 409', (await js('/api/mutfak/kalem/' + i4.id + '/durum', { token: mutfak.token, body: { durum: 'SERVED' } })).status === 409);
    await query('UPDATE order_items SET is_cancelled = 1 WHERE id = ?', [i3]);
    const kq4 = await js('/api/mutfak/kuyruk', { token: mutfak.token });
    const m2k = kq4.d.kartlar.find(k => k.orderId === qr.d.orderId);
    ok('iptal kalem kuyrukta yok (M2 kartinda yalniz ayran)', !!m2k && m2k.items.length === 1 && m2k.items[0].id === i5.id && !m2k.items.some(x => x.id === i3), [i3, m2k && m2k.items.map(x => x.id)]);

    console.log('\n=== Personel duzenleme + tenant anahtari ===');
    const mkId = mk.d.id;
    const pasif = await js('/api/auth/staff/' + mkId, { token: sahip.token, method: 'PATCH', body: { isActive: false } });
    ok('mutfak hesabi pasife alindi', pasif.status === 200, pasif);
    ok('pasif hesap kuyrugu okuyamaz (403)', (await js('/api/mutfak/kuyruk', { token: mutfak.token })).status === 403);
    await js('/api/auth/staff/' + mkId, { token: sahip.token, method: 'PATCH', body: { isActive: true } });
    ok('aktif edilince okur (200)', (await js('/api/mutfak/kuyruk', { token: mutfak.token })).status === 200);
    ok('kendini pasife alamaz (400)', (await js('/api/auth/staff/' + me.id, { token: sahip.token, method: 'PATCH', body: { isActive: false } })).status === 400);
    const md2 = await js('/api/auth/staff', { token: sahip.token, body: { email: 'm-mudur2@ornek.test', password: 'mudur123', name: 'Mudur Iki', role: 'MANAGER' } });
    ok('mudur, baska mudur hesabina dokunamaz (403)', (await js('/api/auth/staff/' + md2.d.id, { token: mudur.token, method: 'PATCH', body: { name: 'X' } })).status === 403);
    ok('mudur kendi adini degistirir (200)', (await js('/api/auth/staff/' + md.d.id, { token: mudur.token, method: 'PATCH', body: { name: 'Mudur Can C.' } })).status === 200);
    ok('mudur sahibe dokunamaz (403)', (await js('/api/auth/staff/' + me.id, { token: mudur.token, method: 'PATCH', body: { name: 'X' } })).status === 403);
    ok('mudur mutfak hesabini duzenler (200)', (await js('/api/auth/staff/' + mkId, { token: mudur.token, method: 'PATCH', body: { name: 'Usta Hasan Y.' } })).status === 200);
    ok('gecersiz rol 400', (await js('/api/auth/staff/' + mkId, { token: sahip.token, method: 'PATCH', body: { role: 'OWNER' } })).status === 400);
    ok('kisa sifre 400', (await js('/api/auth/staff/' + mkId, { token: sahip.token, method: 'PATCH', body: { password: '123' } })).status === 400);
    await js('/api/auth/staff/' + mkId, { token: sahip.token, method: 'PATCH', body: { password: 'yeni-sifre-9' } });
    ok('sifre sifirlama: yeni sifreyle giris', !!(await giris('m-mutfak@ornek.test', 'yeni-sifre-9')).token);
    ok('eski sifreyle giris yok', !(await giris('m-mutfak@ornek.test', 'mutfak123')).token);
    const lst = (await js('/api/auth/staff', { token: sahip.token })).d;
    ok('listede ad guncel + rol KITCHEN', lst.find(u => u.id === mkId).name === 'Usta Hasan Y.' && lst.find(u => u.id === mkId).role === 'KITCHEN', lst);
    ok('bilinmeyen personel 404', (await js('/api/auth/staff/yok', { token: sahip.token, method: 'PATCH', body: { name: 'X' } })).status === 404);

    const t0 = (await js('/api/tenant/me', { token: sahip.token })).d;
    ok('mutfak_ekrani varsayilan 0', Number(t0.mutfak_ekrani) === 0, t0.mutfak_ekrani);
    const ta = await js('/api/tenant/me', { token: sahip.token, method: 'PUT', body: { mutfakEkrani: true } });
    const t1 = (await js('/api/tenant/me', { token: sahip.token })).d;
    const me2 = (await js('/api/auth/me', { token: sahip.token })).d;
    ok('mutfak_ekrani acildi + /me mutfakEkrani true', ta.status === 200 && Number(t1.mutfak_ekrani) === 1 && me2.mutfakEkrani === true, [t1.mutfak_ekrani, me2.mutfakEkrani]);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
