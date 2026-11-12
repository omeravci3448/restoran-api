// Magaza incelemesinden ortak dosyalara dusen duzeltmeler (2026-11-12):
//   P1  requireManagerPin ara katmaninda yonetici sifresi deneme siniri (manager-verify ile ayni sayac)
//   P2  GET /api/tenant/me fatura alanlari (TCKN olabilir) yalniz sahip/mudur
//   D1  salt-okunur yazma izni yol segmenti sinirinda ('/api/tenant' kurali '/api/tenants'i acmaz)
// Faz 2 birlesimi: destek oturumu KAPALI'da okuma serbest / yazma yalniz isletmenin acik uclari (karar 3),
// salt-okunurda destek de salt-okunur; deneme gunu herkese acik uc (karar 1); magaza root yazmalarina acik
// yonetim gunlugu satiri.
// Sunucuyu KENDI baslatir.  Calistir: node test_ortak_duzeltmeler.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const L = require('./src/services/lisansDurumu');

const PORT = 46124, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'ortak-duzeltme-test-jwt';
const ON = 'ODZ Test';
const EPOSTA_ON = 'odz-';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

const PIN = '482913';
async function kiraciKur(ad, { pin = PIN, bitis } = {}) {
    const id = uuid();
    const slug = 'odz-' + crypto.randomBytes(4).toString('hex');
    const kod = String(50000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, license_tier, license_modules, license_end_date,
                              billing_name, billing_address, billing_tax_id, billing_tax_office, manager_pin, is_active)
         VALUES (?, ?, ?, ?, ?, 'TIER_6_10', '["BASE","MENU_DIGITAL"]', ?, 'Ayşe Yılmaz', 'Cumhuriyet Mah. No: 5', '12345678901', 'Afyon', ?, 1)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, bitis || new Date(Date.now() + 200 * 86400000).toISOString(),
            pin ? await bcrypt.hash(pin, 4) : null]);
    const jet = {};
    for (const rol of ['OWNER', 'MANAGER', 'CASHIER', 'WAITER']) {
        const eposta = `${EPOSTA_ON}${rol.toLowerCase()}-${slug}@ornek.test`;
        await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uuid(), id, eposta, await bcrypt.hash('sifre1234', 4), rol, rol, new Date().toISOString()]);
        jet[rol] = (await js('/api/auth/login', { body: { email: eposta, businessCode: kod, password: 'sifre1234' } })).d.token;
    }
    return { id, jet };
}

let rootId = null;
async function rootJeton() {
    if (!rootId) {
        rootId = uuid();
        await query('INSERT INTO root_users (id, email, password_hash, name, totp_enabled) VALUES (?, ?, ?, ?, 1)',
            [rootId, `${EPOSTA_ON}root-${rootId.slice(0, 6)}@ornek.test`, 'x', 'Test Root']);
    }
    return jwt.sign({ rootId, scope: 'root' }, JWT_SECRET, { expiresIn: '1h' });
}
// Destek oturumu ac (root) ve isletme paneline girilen destek JWT'sini dondur
async function destekJetonu(rj, tenantId) {
    const ac = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId, sebep: 'Test' } });
    const gr = await js('/api/destek/giris/' + ac.d.jeton, { method: 'POST' });
    return gr.d && gr.d.token;
}

async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%'`);
    for (const r of t.rows) {
        for (const tb of ['lisans_odemeleri', 'islem_gunlugu', 'license_cache', 'destek_oturumlari', 'yonetim_gunlugu', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM yonetim_gunlugu WHERE root_id IN (SELECT id FROM root_users WHERE email LIKE '${EPOSTA_ON}root-%')`).catch(() => {});
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}root-%'`).catch(() => {});
}

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);

    console.log('=== P1) Yonetici sifresi deneme siniri ===');
    const a = await kiraciKur('Sinir');
    const korumali = (pin, token = a.jet.OWNER) => js('/api/license/purchases', { token, headers: pin === undefined ? {} : { 'x-manager-pin': pin } });
    ok('dogru sifreyle korumali uc 200', (await korumali(PIN)).status === 200);
    ok('sifresiz istek 403 (deneme sayilmaz)', (await korumali()).status === 403);
    // 3 yanlis + 1 dogru: sayac sifirlanir
    for (let i = 0; i < 3; i++) await korumali('000000');
    ok('3 yanlistan sonra dogru sifre 200 (sayac sifirlanir)', (await korumali(PIN)).status === 200);
    const yanlis = [];
    for (let i = 0; i < 8; i++) yanlis.push((await korumali('11111' + i)).status);
    ok('8 yanlis sifre: 403 MANAGER_PIN_REQUIRED', yanlis.every((c) => c === 403), yanlis);
    const dokuz = await korumali('999999');
    ok('9. deneme 429 MANAGER_PIN_LOCKED', dokuz.status === 429 && dokuz.d.code === 'MANAGER_PIN_LOCKED', dokuz);
    ok('kilitliyken dogru sifre de 429', (await korumali(PIN)).status === 429);
    ok('ayni sayac: manager-verify de 429', (await js('/api/auth/manager-verify', { token: a.jet.OWNER, body: { pin: PIN } })).status === 429);
    ok('kilit isletmeye ozel: baska isletme etkilenmez', (await korumali(PIN, (await kiraciKur('Diger')).jet.OWNER)).status === 200);
    // Eszamanli 20 yanlis deneme: sayac bekleme oncesi artar, en cok 8'i karsilastirilir
    const b = await kiraciKur('Eszamanli');
    const eszamanli = await Promise.all(Array.from({ length: 20 }, (_, i) => korumali('2' + String(i).padStart(5, '0'), b.jet.OWNER)));
    const s403 = eszamanli.filter((x) => x.status === 403).length, s429 = eszamanli.filter((x) => x.status === 429).length;
    ok('eszamanli 20 yanlis: en cok 8 tanesi 403, gerisi 429', s403 <= 8 && s403 + s429 === 20 && s429 >= 12, { s403, s429 });
    ok('manager-verify yanlis sifreleri de sayar (yeni isletme: 8 yanlis -> 429)', await (async () => {
        const c = await kiraciKur('Dogrula');
        for (let i = 0; i < 8; i++) await js('/api/auth/manager-verify', { token: c.jet.OWNER, body: { pin: '00000' + (i % 10) } });
        return (await korumali(PIN, c.jet.OWNER)).status === 429;
    })());

    console.log('\n=== P2) Fatura alanlari yalniz sahip/mudur ===');
    const p = await kiraciKur('Fatura', { pin: null });
    const alanlar = ['billing_name', 'billing_address', 'billing_tax_id', 'billing_tax_office'];
    for (const rol of ['OWNER', 'MANAGER']) {
        const x = (await js('/api/tenant/me', { token: p.jet[rol] })).d;
        ok(`${rol}: fatura alanlari var (TCKN dahil)`, alanlar.every((k) => k in x) && x.billing_tax_id === '12345678901', alanlar.map((k) => x[k]));
    }
    for (const rol of ['CASHIER', 'WAITER']) {
        const x = (await js('/api/tenant/me', { token: p.jet[rol] })).d;
        ok(`${rol}: fatura alanlari YOK (isletme adi var)`, alanlar.every((k) => !(k in x)) && !!x.business_name, Object.keys(x).filter((k) => k.startsWith('billing')));
    }

    console.log('\n=== D1) Salt-okunur yazma izni yol segmenti sinirinda ===');
    const so = (m, u) => L.saltOkunurdaGecerMi({ method: m, originalUrl: u });
    ok('PUT /api/tenant/me acik, PUT /api/tenants/x kapali', so('PUT', '/api/tenant/me') === true && so('PUT', '/api/tenants/x') === false);
    ok('/api/license ve /api/license?x acik, /api/licensex kapali', so('POST', '/api/license/purchase') === true && so('POST', '/api/license?x=1') === true
        && so('POST', '/api/licensex') === false);
    ok('/api/push/iptal acik, /api/push/iptalx kapali', so('POST', '/api/push/iptal') === true && so('POST', '/api/push/iptalx') === false);
    const t = await kiraciKur('Salt', { pin: null, bitis: new Date(Date.now() - 86400000).toISOString() });
    ok('SALT_OKUNUR isletme fatura bilgisini duzeltebilir (PUT /api/tenant/me 200)', (await js('/api/tenant/me', { token: t.jet.OWNER, method: 'PUT', body: { billingName: 'Ayşe Yılmaz' } })).status === 200);
    ok('SALT_OKUNUR: masa ekleme 403 LICENSE_READONLY', ((x) => x.status === 403 && x.d.code === 'LICENSE_READONLY')(await js('/api/tables', { token: t.jet.OWNER, body: { code: 'Z1', name: 'Z1' } })));

    console.log('\n=== Faz 2 birlesimi: destek oturumu ve lisans durumu (karar 3) ===');
    const rj = await rootJeton();
    const kp = await kiraciKur('Destek Kapali', { pin: PIN, bitis: new Date(Date.now() - 10 * 86400000).toISOString() });
    const DK = await destekJetonu(rj, kp.id);
    ok('KAPALI isletmeye destek oturumu acilir', !!DK);
    ok('KAPALI + destek: okuma serbest (GET /api/tables 200, GET /api/tenant/me 200)', (await js('/api/tables', { token: DK })).status === 200
        && (await js('/api/tenant/me', { token: DK })).status === 200);
    const dy = await js('/api/tables', { token: DK, body: { code: 'D1', name: 'D1' } });
    ok('KAPALI + destek: isletmenin acik olmadigi yazma 403 LICENSE_EXPIRED', dy.status === 403 && dy.d.code === 'LICENSE_EXPIRED', dy);
    ok('KAPALI + destek: lisans ucu yazmasi acik (yonetici sifresi sorulmaz, talep 201)',
        (await js('/api/license/purchase', { token: DK, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).status === 201);
    ok('KAPALI isletmenin kendi sahibi: GET /api/tables 403 (yalniz destek okuyabilir)', (await js('/api/tables', { token: kp.jet.OWNER })).status === 403);
    const so2 = await kiraciKur('Destek Salt', { pin: null, bitis: new Date(Date.now() - 86400000).toISOString() });
    const DS = await destekJetonu(rj, so2.id);
    ok('SALT_OKUNUR + destek: okuma 200, masa ekleme 403 LICENSE_READONLY', (await js('/api/tables', { token: DS })).status === 200
        && ((x) => x.status === 403 && x.d.code === 'LICENSE_READONLY')(await js('/api/tables', { token: DS, body: { code: 'D2', name: 'D2' } })));

    console.log('\n=== Faz 2 birlesimi: deneme gunu (karar 1) ve magaza yonetim gunlugu ===');
    const dg0 = await js('/api/public/deneme-gun');
    ok('GET /api/public/deneme-gun herkese acik (varsayilan 7)', dg0.status === 200 && dg0.d.gun === 7, dg0);
    const eskiDg = (await query("SELECT deger FROM sistem_ayarlari WHERE anahtar = 'deneme_gun'")).rows[0];
    const ay = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { deneme_gun: 10 } });
    const dg1 = await js('/api/public/deneme-gun');
    ok('Sistem Ayarlari deneme suresi 10 -> uc 10 doner', ay.status === 200 && dg1.d.gun === 10, [ay.status, ay.d, dg1.d]);
    if (eskiDg) await query("UPDATE sistem_ayarlari SET deger = ? WHERE anahtar = 'deneme_gun'", [eskiDg.deger]);
    else await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'deneme_gun'");
    await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { deneme_gun: eskiDg ? Number(eskiDg.deger) : 7 } });
    const urun = await js('/api/root/magaza/urunler', { token: rj, body: { ad: 'ODZ Test Yazıcı', fiyatKurus: 100000, kdvOrani: 20, durum: 'TASLAK' } });
    await uyu(300);
    const yg = (await query("SELECT islem, ozet, hedef_tur, hedef_id FROM yonetim_gunlugu WHERE root_id = ? AND islem = 'magaza' ORDER BY id DESC LIMIT 5", [rootId])).rows;
    ok('magaza urun ekleme: acik yonetim gunlugu satiri (genel "POST /api/root/magaza..." degil)', urun.status === 201
        && yg.some((x) => /Mağaza ürünü eklendi: ODZ Test Yazıcı/.test(x.ozet) && x.hedef_tur === 'magaza_urun') && !yg.some((x) => /^POST \//.test(x.ozet)), [urun.status, yg]);
    if (urun.d && urun.d.id) await js('/api/root/magaza/urunler/' + urun.d.id, { token: rj, method: 'DELETE' });

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
