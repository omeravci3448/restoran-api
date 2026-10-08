// Giris bilgileri + sifre: SofraMix'ten acilan hesap sifresini mevcut sifre olmadan belirler,
// sonra e-posta + isyeri kodu + sifreyle dogrudan girer; sonraki degisikliklerde mevcut sifre sart.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');

const PORT = 45966, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const GIZLI = 'test-gizli-anahtar-1234567890';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

function govde(x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: 779001, isletme_slug: 'hesap-test', isletme_adi: 'Hesap Test Lokanta',
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: '', unvan: '', vergi_dairesi: '', vergi_no: '',
        yetkili_ad: 'Hesap Sahibi', yetkili_email: 'hesap-sahibi@ornek.test', yetkili_tel: '05321112233',
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
async function git(url) { const r = await fetch(url, { redirect: 'manual' }); return { status: r.status, yer: r.headers.get('location') || '' }; }
async function js(yol, { token, body, method } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
async function temizle() {
    const t = await query("SELECT id FROM tenants WHERE business_name IN ('Hesap Test Lokanta', 'Hesap Eski Lokanta')");
    for (const r of t.rows) {
        for (const tb of ['users', 'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari']) await query(`DELETE FROM ${tb} WHERE tenant_id = ?`, [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM deneme_kayitlari WHERE soframix_business_id = '779001'");
    await query("DELETE FROM deneme_devir_nonce WHERE isletme_no = '779001'");
}

(async () => {
    initDb(); await uyu(900); await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               JWT_SECRET: 'hesap-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== 1) SofraMix devriyle acilan hesap: /me giris bilgilerini verir, sifre BELIRLENMEMIS ===');
    const r1 = await git(baglanti(govde()));
    ok('302', r1.status === 302, r1.status);
    const jeton = r1.yer.split('/deneme-giris/')[1];
    const t1 = (await js('/api/public/deneme-giris/' + jeton, { method: 'POST' })).d;
    const me1 = (await js('/api/auth/me', { token: t1.token })).d;
    ok('e-posta + isyeri kodu + kaynak', me1.email === 'hesap-sahibi@ornek.test' && !!me1.businessCode && me1.parentOrg === 'SofraMix', me1);
    ok('passwordSet false', me1.passwordSet === false, me1.passwordSet);

    console.log('\n=== 2) Mevcut sifre OLMADAN belirleme (ilk kez) ===');
    ok('kisa sifre 400', (await js('/api/auth/sifre-degistir', { token: t1.token, body: { yeni: 'kisa' } })).status === 400);
    const s2 = await js('/api/auth/sifre-degistir', { token: t1.token, body: { yeni: 'yeniSifre123' } });
    ok('mevcut sifresiz belirleme 200', s2.status === 200 && s2.d.passwordSet === true, s2);
    ok('/me passwordSet true', (await js('/api/auth/me', { token: t1.token })).d.passwordSet === true);

    console.log('\n=== 3) Dogrudan giris: e-posta + isyeri kodu + sifre ===');
    const g3 = await js('/api/auth/login', { body: { email: me1.email, businessCode: me1.businessCode, password: 'yeniSifre123' } });
    ok('login 200 + token', g3.status === 200 && !!g3.d.token, g3.status);
    ok('yanlis sifreyle giris 401', (await js('/api/auth/login', { body: { email: me1.email, businessCode: me1.businessCode, password: 'yanlisSifre' } })).status === 401);

    console.log('\n=== 4) Sonraki degisiklikte MEVCUT sifre sart ===');
    ok('mevcut yok 400', (await js('/api/auth/sifre-degistir', { token: g3.d.token, body: { yeni: 'baskaSifre123' } })).status === 400);
    ok('mevcut yanlis 400', (await js('/api/auth/sifre-degistir', { token: g3.d.token, body: { mevcut: 'yanlis', yeni: 'baskaSifre123' } })).status === 400);
    ok('mevcut dogru 200', (await js('/api/auth/sifre-degistir', { token: g3.d.token, body: { mevcut: 'yeniSifre123', yeni: 'baskaSifre123' } })).status === 200);
    ok('yeni sifreyle giris 200', (await js('/api/auth/login', { body: { email: me1.email, businessCode: me1.businessCode, password: 'baskaSifre123' } })).status === 200);
    ok('eski sifre artik 401', (await js('/api/auth/login', { body: { email: me1.email, businessCode: me1.businessCode, password: 'yeniSifre123' } })).status === 401);

    console.log('\n=== 5) Sifre belirleme baglantisi: SMTP yok -> gonderildi=false, ama jeton acildi ===');
    const b5 = await js('/api/auth/sifre-baglantisi', { token: g3.d.token, method: 'POST' });
    ok('200 ve eposta', b5.status === 200 && b5.d.eposta === me1.email && b5.d.gonderildi === false, b5);
    ok('tek acik aktivasyon jetonu', (await query('SELECT COUNT(*) c FROM aktivasyon_jetonlari WHERE user_id = ? AND kullanildi_at IS NULL', [me1.id])).rows[0].c === 1);

    console.log('\n=== 6) Eski (SofraMix disi) hesaplar: geriye donuk password_set_at dolar ===');
    const tid = crypto.randomUUID(), uid = crypto.randomUUID();
    await query("INSERT INTO tenants (id, slug, business_code, business_name, owner_email, is_active) VALUES (?, 'hesap-eski', 'HESAPESK1', 'Hesap Eski Lokanta', 'eski@ornek.test', 1)", [tid]);
    await query("INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, 'eski@ornek.test', 'x', 'Eski', 'OWNER')", [uid, tid]);
    initDb(); await uyu(900);
    ok('eski kullanici password_set_at dolu', !!(await query('SELECT password_set_at p FROM users WHERE id = ?', [uid])).rows[0].p);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
