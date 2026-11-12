// Magaza incelemesinden ortak dosyalara dusen duzeltmeler (2026-11-12):
//   P1  requireManagerPin ara katmaninda yonetici sifresi deneme siniri (manager-verify ile ayni sayac)
//   P2  GET /api/tenant/me fatura alanlari (TCKN olabilir) yalniz sahip/mudur
//   D1  salt-okunur yazma izni yol segmenti sinirinda ('/api/tenant' kurali '/api/tenants'i acmaz)
// Sunucuyu KENDI baslatir.  Calistir: node test_ortak_duzeltmeler.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { spawn } = require('child_process');
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

async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%'`);
    for (const r of t.rows) {
        for (const tb of ['lisans_odemeleri', 'islem_gunlugu', 'license_cache', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
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

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
