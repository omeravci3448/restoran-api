// SofraMix -> POS imzali deneme DEVRI sozlesme testi.
// Baglantilar SofraMix'in posDeneme.js'iyle AYNI kanonik bicimle uretilir:
// JSON.stringify(govde, Object.keys(govde).sort()) -> base64url; HMAC-SHA256 hex.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');

const PORT = 45961, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const GIZLI = 'test-gizli-anahtar-1234567890';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

function govde(x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: 777001, isletme_slug: 'devir-test', isletme_adi: 'Devir Test Lokanta',
        il: 'Afyonkarahisar', ilce: 'Merkez', unvan: 'Devir Test Gida Ltd.', vergi_dairesi: 'Kocatepe', vergi_no: '1234567890',
        yetkili_ad: 'Devir Sahibi', yetkili_email: 'devir-sahibi@ornek.test', yetkili_tel: '05321234567',
        deneme_gun: 7, damga_ms: Date.now(), gecerli_sn: 600, nonce: crypto.randomBytes(12).toString('hex'), ...x,
    };
}
const kanonik = (g) => JSON.stringify(g, Object.keys(g).sort());
const imzala = (g, gizli) => crypto.createHmac('sha256', gizli).update(kanonik(g)).digest('hex');
function baglanti(g, gizli = GIZLI, ek = {}) {
    const u = new URL(TABAN + '/api/public/soframix-deneme');
    u.searchParams.set('v', String(ek.v ?? g.surum));
    u.searchParams.set('yuk', ek.yuk ?? Buffer.from(kanonik(g), 'utf8').toString('base64url'));
    u.searchParams.set('imza', ek.imza ?? imzala(g, gizli));
    return u.toString();
}
async function git(url) {
    const r = await fetch(url, { redirect: 'manual' });
    return { status: r.status, yer: r.headers.get('location') || '', govde: await r.text().catch(() => '') };
}
async function temizle() {
    const t = await query("SELECT id FROM tenants WHERE business_name IN ('Devir Test Lokanta', 'Devir Iki Lokanta')");
    for (const r of t.rows) {
        for (const tb of ['users', 'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari']) await query(`DELETE FROM ${tb} WHERE tenant_id = ?`, [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM deneme_kayitlari WHERE soframix_business_id IN ('777001','777002')");
    await query("DELETE FROM deneme_devir_nonce WHERE isletme_no IN ('777001','777002')");
}

(async () => {
    initDb(); await uyu(900); await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               JWT_SECRET: 'devir-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== 1) Gecerli devir: kiraci acilir, panele yonlendirir ===');
    const g1 = govde();
    const r1 = await git(baglanti(g1));
    ok('302 yonlendirme', r1.status === 302, { status: r1.status, govde: r1.govde.slice(0, 120) });
    ok('panel/deneme-giris/<jeton> adresine', r1.yer.startsWith(PANEL + '/deneme-giris/'), r1.yer);
    const k1 = (await query("SELECT * FROM tenants WHERE business_name = 'Devir Test Lokanta'")).rows;
    ok('TEK kiraci acildi', k1.length === 1, k1.length);
    ok('TIER_DENEME + SofraMix kaynakli', k1[0]?.license_tier === 'TIER_DENEME' && k1[0]?.parent_org === 'SofraMix', k1[0]);
    ok('lisans ~7 gun', Math.round((new Date(k1[0]?.license_end_date) - Date.now()) / 86400000) === 7, k1[0]?.license_end_date);
    ok('fatura bilgileri yazildi', k1[0]?.billing_tax_id === '1234567890' && k1[0]?.billing_tax_office === 'Kocatepe', k1[0]);
    ok('deneme kaydi soframix no ile', (await query("SELECT * FROM deneme_kayitlari WHERE soframix_business_id = '777001'")).rows.length === 1);
    ok('nonce kaydedildi', (await query('SELECT * FROM deneme_devir_nonce WHERE nonce = ?', [g1.nonce])).rows.length === 1);

    console.log('\n--- jeton -> JWT degisimi (SPA"nin yaptigi) ---');
    const jeton = r1.yer.split('/deneme-giris/')[1];
    const d1 = await fetch(TABAN + '/api/public/deneme-giris/' + jeton, { method: 'POST' });
    const dj = await d1.json();
    ok('JWT dondu', d1.status === 200 && !!dj.token, dj);
    const me = await fetch(TABAN + '/api/auth/me', { headers: { Authorization: 'Bearer ' + dj.token } });
    ok('JWT ile /me calisiyor (oturum kuruldu)', me.status === 200);
    const d2 = await fetch(TABAN + '/api/public/deneme-giris/' + jeton, { method: 'POST' });
    ok('giris jetonu TEK KULLANIMLIK (410)', d2.status === 410, d2.status);

    console.log('\n=== 2) AYNI baglanti ikinci kez -> nonce reddi, kiraci ACILMAZ ===');
    const r2 = await git(baglanti(g1));
    ok('400', r2.status === 400, r2.status);
    ok('kiraci sayisi degismedi', (await query("SELECT COUNT(*) c FROM tenants WHERE business_name = 'Devir Test Lokanta'")).rows[0].c === 1);

    console.log('\n=== 3) Ayni isletme, YENI nonce -> yeni kiraci ACILMAZ, girise yollanir ===');
    const r3 = await git(baglanti(govde({ nonce: crypto.randomBytes(12).toString('hex') })));
    ok('302 (var olana giris)', r3.status === 302, r3.status);
    ok('hala tek kiraci', (await query("SELECT COUNT(*) c FROM tenants WHERE business_name = 'Devir Test Lokanta'")).rows[0].c === 1);

    console.log('\n=== 4) Imza ve sure kapilari ===');
    const g4 = govde({ isletme_no: 777002, isletme_adi: 'Devir Iki Lokanta', yetkili_email: 'devir2@ornek.test' });
    ok('yanlis anahtar 400', (await git(baglanti(g4, 'baska-anahtar-xxxxxxxxxxxxxx'))).status === 400);
    const kurcalanmis = Buffer.from(kanonik({ ...g4, deneme_gun: 365 }), 'utf8').toString('base64url');
    ok('govde kurcalanmis (imza eski) 400', (await git(baglanti(g4, GIZLI, { yuk: kurcalanmis }))).status === 400);
    ok('surum v=2 400', (await git(baglanti(g4, GIZLI, { v: 2 }))).status === 400);
    ok('suresi gecmis 410', (await git(baglanti(govde({ ...g4, damga_ms: Date.now() - 700000 })))).status === 410);
    ok('ILERI tarihli damga 410', (await git(baglanti(govde({ ...g4, damga_ms: Date.now() + 5 * 60000 })))).status === 410);
    ok('kaynak farkli 400', (await git(baglanti(govde({ ...g4, kaynak: 'baska' })))).status === 400);
    ok('bozuk imza bicimi 400', (await git(baglanti(g4, GIZLI, { imza: 'zzzz' }))).status === 400);
    ok('hicbiri kiraci acmadi', (await query("SELECT COUNT(*) c FROM tenants WHERE business_name = 'Devir Iki Lokanta'")).rows[0].c === 0);

    console.log('\n=== 5) deneme_gun ust siniri ===');
    const r5 = await git(baglanti(govde({ ...g4, deneme_gun: 999, nonce: crypto.randomBytes(12).toString('hex') })));
    ok('302', r5.status === 302, r5.status);
    const k5 = (await query("SELECT license_end_date FROM tenants WHERE business_name = 'Devir Iki Lokanta'")).rows[0];
    ok('999 gun istendi, 30 gune SINIRLANDI', Math.round((new Date(k5?.license_end_date) - Date.now()) / 86400000) === 30, k5);

    console.log('\n=== 6) Gizli anahtar yoksa uc kapali ===');
    // Ayri surec: env'siz baslat, 503 bekle
    const kapali = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: '45962', SOFRAMIX_DENEME_GIZLI: '', POS_PANEL_URL: PANEL, JWT_SECRET: 'x', ROOT_EMAIL: '', ROOT_PASSWORD: '' } });
    for (let i = 0; i < 40; i++) { try { if ((await fetch('http://127.0.0.1:45962/health')).ok) break; } catch (_) {} await uyu(400); }
    const r6 = await fetch(baglanti(g1).replace(String(PORT), '45962'), { redirect: 'manual' });
    ok('503 ve kiraci acilmaz', r6.status === 503, r6.status);
    try { kapali.kill(); } catch (_) {}

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
