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
    await query("DELETE FROM lisans_odemeleri WHERE tenant_id IN (SELECT id FROM tenants WHERE slug = 'rootcihaz-bildirim-test')").catch(() => {});
    await query("DELETE FROM tenants WHERE slug = 'rootcihaz-bildirim-test'").catch(() => {});
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
    ok('kayit ayrica dar yetkili bildirim jetonu verir (cihaz jetonundan farkli)',
        typeof k.veri.bildirimJetonu === 'string' && k.veri.bildirimJetonu.length >= 40 && k.veri.bildirimJetonu !== k.veri.cihazJetonu, k.veri);
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

    console.log('\n=== 4b) Telefon bildirimi: bildirim jetonu + bekleyen odeme durumu ===');
    const k3 = await iste('/api/root/cihaz/kaydet', { ad: 'Bildirim Telefonu' }, oturum);
    const bj = k3.veri.bildirimJetonu;
    ok('bildirim jetonu panel uclarini ACMAZ (cihaz girisi 401)', (await iste('/api/root/cihaz/giris', { cihazJetonu: bj })).kod === 401);
    let d = await iste('/api/root/cihaz/bildirim-durumu', { bildirimJetonu: bj });
    ok('durum 200: bekleyen sayi + son (null ya da nesne)', d.kod === 200 && typeof d.veri.bekleyen === 'number' && (d.veri.son === null || typeof d.veri.son === 'object'), d.veri);
    const oncekiBekleyen = d.veri.bekleyen;
    ok('iptal edilen cihazin bildirim jetonu yok (eski cihaz): yanlis jeton 401', (await iste('/api/root/cihaz/bildirim-durumu', { bildirimJetonu: 'z'.repeat(50) })).kod === 401);
    ok('kisa jeton 401', (await iste('/api/root/cihaz/bildirim-durumu', { bildirimJetonu: 'kisa' })).kod === 401);
    // Bekleyen bir odeme bildirimi olusturulur (dogrudan tabloya: amac bildirim ucunun okudugu ozet)
    {
        const { query } = require('./src/config/db');
        await query("INSERT INTO tenants (id, slug, business_name) VALUES ('rootcihaz-bildirim-tenant', 'rootcihaz-bildirim-test', 'Bildirim Test Lokantasi')");
        await query("INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, created_at) VALUES ('rootcihaz-bildirim-odeme', 'rootcihaz-bildirim-tenant', 'TIER_PRO', '[]', 16000, 'beklemede', datetime('now', '+1 minute'))");
    }
    d = await iste('/api/root/cihaz/bildirim-durumu', { bildirimJetonu: bj });
    ok('yeni bekleyen: sayi +1, son = bizim isletme, 16000, bildirildi=false, zaman dolu',
        d.kod === 200 && d.veri.bekleyen === oncekiBekleyen + 1 && d.veri.son && d.veri.son.isletme === 'Bildirim Test Lokantasi'
        && d.veri.son.tutar === 16000 && d.veri.son.bildirildi === false && typeof d.veri.son.zaman === 'string', d.veri);
    const zaman1 = d.veri.son && d.veri.son.zaman;
    {
        const { query } = require('./src/config/db');
        await query("UPDATE lisans_odemeleri SET odeme_bildirildi_at = datetime('now', '+2 minute') WHERE id = 'rootcihaz-bildirim-odeme'");
    }
    d = await iste('/api/root/cihaz/bildirim-durumu', { bildirimJetonu: bj });
    ok('"odemeyi yaptim" sonrasi: bildirildi=true, zaman ILERLEDI', d.veri.son && d.veri.son.bildirildi === true && d.veri.son.zaman > zaman1, d.veri);
    {
        const { query } = require('./src/config/db');
        await query("UPDATE lisans_odemeleri SET durum = 'onaylandi' WHERE id = 'rootcihaz-bildirim-odeme'");
    }
    d = await iste('/api/root/cihaz/bildirim-durumu', { bildirimJetonu: bj });
    ok('onaylaninca bekleyenden duser', d.veri.bekleyen === oncekiBekleyen, d.veri);
    // Eski kabukla kurulmus cihaza sonradan bildirim jetonu verme (yeniden uretme)
    ok('bildirim-jetonu oturumsuz 401', (await iste('/api/root/cihaz/bildirim-jetonu', { id: k3.veri.id })).kod === 401);
    const y = await iste('/api/root/cihaz/bildirim-jetonu', { id: k3.veri.id }, oturum);
    ok('yeniden uretme 200 + yeni jeton', y.kod === 200 && typeof y.veri.bildirimJetonu === 'string' && y.veri.bildirimJetonu !== bj, y.veri);
    ok('eski bildirim jetonu artik 401', (await iste('/api/root/cihaz/bildirim-durumu', { bildirimJetonu: bj })).kod === 401);
    ok('yeni bildirim jetonu 200', (await iste('/api/root/cihaz/bildirim-durumu', { bildirimJetonu: y.veri.bildirimJetonu })).kod === 200);
    const g3 = await iste('/api/root/cihaz/giris', { cihazJetonu: k3.veri.cihazJetonu });
    const y2 = await iste('/api/root/cihaz/bildirim-jetonu', {}, g3.veri.token);
    ok('cihaz oturumunda id vermeden kendi cihazina uretir', y2.kod === 200 && !!y2.veri.bildirimJetonu, y2.veri);
    ok('cihaz unutulunca bildirim jetonu da duser',
        (await iste('/api/root/cihaz/unut', { id: k3.veri.id }, oturum)).kod === 200
        && (await iste('/api/root/cihaz/bildirim-durumu', { bildirimJetonu: y2.veri.bildirimJetonu })).kod === 401);
    ok('iptal cihaza bildirim jetonu uretilmez 404', (await iste('/api/root/cihaz/bildirim-jetonu', { id: k3.veri.id }, oturum)).kod === 404);

    console.log('\n=== 5) IP sinirlayici: 10 hatali denemeden sonra 429 ===');
    let son = 0;
    for (let i = 0; i < 11; i++) son = (await iste('/api/root/cihaz/giris', { cihazJetonu: 'y'.repeat(64) })).kod;
    ok('11. deneme 429', son === 429, son);

    console.log('\n=== 6) Ikinci cihaz kaydi ayri jeton ===');
    const k2 = await iste('/api/root/cihaz/kaydet', { ad: 'Tablet' }, oturum);
    ok('ikinci cihaz farkli jeton', k2.kod === 201 && k2.veri.cihazJetonu !== jeton);
    const l4 = await iste('/api/root/cihaz', null, oturum, 'GET');
    ok('listede 3 cihaz', l4.veri.length === 3);

    kapat();
    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
