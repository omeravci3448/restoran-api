// Root cihaz jetonu (yonetim APK'si, parmak izi): kaydet / jetonla giris / liste / unut / sinirlayici.
// Sunucuyu KENDI baslatir.  Calistir: node test_root_cihaz.js
const { spawn } = require('child_process');
const totp = require('./src/services/totp');

const PORT = 45995, TABAN = `http://127.0.0.1:${PORT}`;
const EPOSTA = 'rootcihaz@mdayazilim.com', PAROLA = 'CokGizliParola123';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
async function iste(yol, govde, jeton, method) {
    const h = { 'Content-Type': 'application/json' };
    if (jeton) h.Authorization = 'Bearer ' + jeton;
    const r = await fetch(TABAN + yol, { method: method || 'POST', headers: h, body: method === 'GET' ? undefined : JSON.stringify(govde || {}) });
    return { kod: r.status, veri: await r.json().catch(() => null) };
}
async function temizle() {
    const { query } = require('./src/config/db');
    const r = await query('SELECT id FROM root_users WHERE email = ?', [EPOSTA]);
    for (const u of r.rows) await query('DELETE FROM root_cihazlar WHERE root_id = ?', [u.id]).catch(() => {});
    await query('DELETE FROM root_users WHERE email = ?', [EPOSTA]);
    await uyu(300);
}

(async () => {
    await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname,
        env: { ...process.env, PORT: String(PORT), ROOT_EMAIL: EPOSTA, ROOT_PASSWORD: PAROLA, JWT_SECRET: 'cihaz-test-jwt' }, stdio: 'ignore' });
    const kapat = () => { try { sunucu.kill(); } catch (_) {} };
    process.on('exit', kapat);
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(6500); // ensureRootUser 5 sn sonra

    console.log('=== Hazirlik: parola + authenticator kurulumu ile normal giris ===');
    let r = await iste('/api/root/login', { email: EPOSTA, password: PAROLA });
    const sir = r.veri && r.veri.sir, kurulumJetonu = r.veri && r.veri.kurulumJetonu;
    r = await iste('/api/root/totp/kurulum', { code: totp.kodUret(sir, totp.suankiAdim()) }, kurulumJetonu);
    const oturum = r.veri && r.veri.token;
    ok('normal root oturumu alindi', !!oturum, r);

    console.log('\n=== 1) Cihaz kaydi ===');
    ok('oturumsuz kayit 401', (await iste('/api/root/cihaz/kaydet', { ad: 'X' })).kod === 401);
    const k = await iste('/api/root/cihaz/kaydet', { ad: 'Samsung Test' }, oturum);
    ok('kayit 201 + uzun rastgele jeton', k.kod === 201 && typeof k.veri.cihazJetonu === 'string' && k.veri.cihazJetonu.length >= 60 && !!k.veri.id, k.veri);
    const jeton = k.veri.cihazJetonu;

    console.log('\n=== 2) Cihaz jetonuyla giris (parola/kod yok) ===');
    const g = await iste('/api/root/cihaz/giris', { cihazJetonu: jeton });
    ok('giris 200 + token + e-posta', g.kod === 200 && !!g.veri.token && g.veri.email === EPOSTA && g.veri.cihazId === k.veri.id, g.veri);
    const r5 = await fetch(TABAN + '/api/root/tenants', { headers: { Authorization: 'Bearer ' + g.veri.token } });
    ok('cihaz oturumu panel uclarini acar', r5.status === 200, r5.status);
    ok('yanlis jeton 401', (await iste('/api/root/cihaz/giris', { cihazJetonu: 'x'.repeat(70) })).kod === 401);
    ok('kisa jeton 401', (await iste('/api/root/cihaz/giris', { cihazJetonu: 'kisa' })).kod === 401);

    console.log('\n=== 3) Liste + bu cihaz isareti ===');
    const l = await iste('/api/root/cihaz', null, g.veri.token, 'GET');
    ok('listede 1 cihaz, buCihaz=true, son kullanim dolu', l.kod === 200 && l.veri.length === 1 && l.veri[0].buCihaz === true && !!l.veri[0].last_used_at && l.veri[0].ad === 'Samsung Test', l.veri);
    const l2 = await iste('/api/root/cihaz', null, oturum, 'GET');
    ok('normal oturumda buCihaz=false', l2.veri[0].buCihaz === false);

    console.log('\n=== 4) Unut (iptal) ===');
    const u = await iste('/api/root/cihaz/unut', {}, g.veri.token);
    ok('bu cihaz iptal 200', u.kod === 200, u);
    ok('iptal edilen jetonla giris 401', (await iste('/api/root/cihaz/giris', { cihazJetonu: jeton })).kod === 401);
    ok('tekrar iptal 404', (await iste('/api/root/cihaz/unut', { id: k.veri.id }, oturum)).kod === 404);
    const l3 = await iste('/api/root/cihaz', null, oturum, 'GET');
    ok('listede revoked_at dolu', !!l3.veri[0].revoked_at);
    ok('mevcut cihaz oturumu (jwt) hala 8 saat gecerli - panel acar', (await fetch(TABAN + '/api/root/tenants', { headers: { Authorization: 'Bearer ' + g.veri.token } })).status === 200);

    console.log('\n=== 5) IP sinirlayici: 10 hatali denemeden sonra 429 ===');
    let son = 0;
    for (let i = 0; i < 11; i++) son = (await iste('/api/root/cihaz/giris', { cihazJetonu: 'y'.repeat(64) })).kod;
    ok('11. deneme 429', son === 429, son);

    console.log('\n=== 6) Ikinci cihaz kaydi ayri jeton ===');
    const k2 = await iste('/api/root/cihaz/kaydet', { ad: 'Tablet' }, oturum);
    ok('ikinci cihaz farkli jeton', k2.kod === 201 && k2.veri.cihazJetonu !== jeton);
    const l4 = await iste('/api/root/cihaz', null, oturum, 'GET');
    ok('listede 2 cihaz', l4.veri.length === 2);

    kapat();
    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
