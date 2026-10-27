// Isletme logosu: yukleme (data URL -> /uploads dosyasi), degistirme (eski dosya silinir), kaldirma,
// gecersiz girdi, diger alanlarin logoya dokunmamasi, QR menu public ucunda logo_url.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');
const { UPLOADS_DIR } = require('./src/services/imageService');

const PORT = 45968, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const GIZLI = 'test-gizli-anahtar-1234567890';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// 1x1 JPEG (en kucuk gecerli)
const JPG1 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function govde(x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: 779102, isletme_slug: 'logo-test', isletme_adi: 'Logo Test Lokanta',
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: '', unvan: '', vergi_dairesi: '', vergi_no: '',
        yetkili_ad: 'Logo Sahibi', yetkili_email: 'logo-sahibi@ornek.test', yetkili_tel: '05321112255',
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
async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
async function temizle() {
    const t = await query("SELECT id FROM tenants WHERE business_name = 'Logo Test Lokanta'");
    for (const r of t.rows) {
        for (const tb of ['users', 'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari', 'islem_gunlugu', 'payments', 'order_items', 'orders', 'tables', 'products', 'categories'])
            await query(`DELETE FROM ${tb} WHERE tenant_id = ?`, [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
        fs.rmSync(path.join(UPLOADS_DIR, r.id), { recursive: true, force: true });
    }
    await query("DELETE FROM deneme_kayitlari WHERE soframix_business_id = '779102'");
    await query("DELETE FROM deneme_devir_nonce WHERE isletme_no = '779102'");
}
const dosyaVar = (tenantId, url) => !!url && fs.existsSync(path.join(UPLOADS_DIR, tenantId, path.basename(url)));

(async () => {
    initDb(); await uyu(900); await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               JWT_SECRET: 'logo-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== Hazirlik: devir ile isletme + sahip ===');
    const r = await fetch(baglanti(govde()), { redirect: 'manual' });
    const jeton = (r.headers.get('location') || '').split('/deneme-giris/')[1];
    const sahip = (await js('/api/public/deneme-giris/' + jeton, { method: 'POST' })).d;
    const me = (await js('/api/auth/me', { token: sahip.token })).d;
    const tid = me.tenantId;
    ok('isletme acildi', !!sahip.token && !!tid, me);
    const p0 = (await js('/api/tenant/me', { token: sahip.token })).d;
    ok('baslangicta logo_url bos', p0 && p0.logo_url == null, p0 && p0.logo_url);

    console.log('\n=== 1) Logo yukle (PNG data URL) ===');
    const y1 = await js('/api/tenant/me', { token: sahip.token, method: 'PUT', body: { logoUrl: PNG1 } });
    ok('PUT 200 + logoUrl donuyor', y1.status === 200 && /^\/uploads\//.test(y1.d && y1.d.logoUrl), y1);
    const p1 = (await js('/api/tenant/me', { token: sahip.token })).d;
    ok('profilde logo_url /uploads/<tenant>/x.png', new RegExp('^/uploads/' + tid + '/[^/]+\\.png$').test(p1.logo_url), p1.logo_url);
    ok('dosya diske yazildi', dosyaVar(tid, p1.logo_url));
    const g1 = await fetch(TABAN + p1.logo_url);
    ok('logo sunuluyor (200, image/png)', g1.status === 200 && /image\/png/.test(g1.headers.get('content-type') || ''), [g1.status, g1.headers.get('content-type')]);

    console.log('\n=== 2) Diger alan guncellemesi logoya dokunmaz ===');
    const y2 = await js('/api/tenant/me', { token: sahip.token, method: 'PUT', body: { phone: '02721234567' } });
    const p2 = (await js('/api/tenant/me', { token: sahip.token })).d;
    ok('telefon degisti, logo ayni', y2.status === 200 && p2.phone === '02721234567' && p2.logo_url === p1.logo_url, [p2.phone, p2.logo_url]);

    console.log('\n=== 3) Logoyu degistir: eski dosya silinir ===');
    const y3 = await js('/api/tenant/me', { token: sahip.token, method: 'PUT', body: { logoUrl: JPG1 } });
    const p3 = (await js('/api/tenant/me', { token: sahip.token })).d;
    ok('yeni logo .jpg', y3.status === 200 && /\.jpg$/.test(p3.logo_url) && p3.logo_url !== p1.logo_url, p3.logo_url);
    await uyu(300);
    ok('eski dosya silindi, yeni dosya var', !dosyaVar(tid, p1.logo_url) && dosyaVar(tid, p3.logo_url));

    console.log('\n=== 4) Gecersiz girdiler ===');
    const h1 = await js('/api/tenant/me', { token: sahip.token, method: 'PUT', body: { logoUrl: 'https://kotu.example/x.png' } });
    ok('http adresi reddedilir (400)', h1.status === 400, h1);
    const h2 = await js('/api/tenant/me', { token: sahip.token, method: 'PUT', body: { logoUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } });
    ok('SVG reddedilir (400)', h2.status === 400, h2);
    const buyuk = 'data:image/png;base64,' + Buffer.alloc(3 * 1024 * 1024 + 10, 1).toString('base64');
    const h3 = await fetch(TABAN + '/api/tenant/me', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sahip.token }, body: JSON.stringify({ logoUrl: buyuk }) });
    ok('3MB ustu reddedilir (413)', h3.status === 413, h3.status);
    const p4 = (await js('/api/tenant/me', { token: sahip.token })).d;
    ok('hatali denemeler logoyu bozmadi', p4.logo_url === p3.logo_url, p4.logo_url);

    console.log('\n=== 5) QR menu public ucunda logo ===');
    const masa = (await js('/api/tables', { token: sahip.token, body: { code: 'L1', name: 'L1', section: 'Salon' } })).d;
    const tq = (await query('SELECT qr_token FROM tables WHERE id = ?', [masa.id])).rows[0];
    let pm = await js(`/api/public/m/${p4.slug}/${tq.qr_token}/menu`);
    if (pm.status === 403) {
        await query(`UPDATE tenants SET license_modules = '["BASE","MENU_DIGITAL","GARSON"]' WHERE id = ?`, [tid]);
        pm = await js(`/api/public/m/${p4.slug}/${tq.qr_token}/menu`);
    }
    ok('public menu 200 + business.logo_url', pm.status === 200 && pm.d && pm.d.business && pm.d.business.logo_url === p4.logo_url, [pm.status, pm.d && pm.d.business]);

    console.log('\n=== 6) Logoyu kaldir ===');
    const y6 = await js('/api/tenant/me', { token: sahip.token, method: 'PUT', body: { logoUrl: '' } });
    const p6 = (await js('/api/tenant/me', { token: sahip.token })).d;
    ok('logo_url null', y6.status === 200 && p6.logo_url == null, p6.logo_url);
    await uyu(300);
    ok('dosya silindi', !dosyaVar(tid, p4.logo_url));
    const pm2 = await js(`/api/public/m/${p4.slug}/${tq.qr_token}/menu`);
    ok('public menude logo_url null', pm2.status === 200 && pm2.d.business.logo_url === null, pm2.d && pm2.d.business);

    console.log('\n=== 7) Kasiyer logo degistiremez (sahip/mudur yetkisi) ===');
    await js('/api/auth/staff', { token: sahip.token, body: { email: 'logo-kasiyer@ornek.test', password: 'kasiyer123', name: 'Kasiyer', role: 'CASHIER' } });
    const kasiyer = (await js('/api/auth/login', { body: { email: 'logo-kasiyer@ornek.test', businessCode: me.businessCode, password: 'kasiyer123' } })).d;
    const k1 = await js('/api/tenant/me', { token: kasiyer.token, method: 'PUT', body: { logoUrl: PNG1 } });
    ok('kasiyer 403', k1.status === 403, k1);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
