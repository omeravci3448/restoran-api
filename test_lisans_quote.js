// Fiyat hesaplama (quote): oturumsuz 200 (indirimsiz), oturumlu kiraci indirimi, gecersiz paket 400,
// gecersiz jeton anonim; deneme hesabi yenileme kanali 'yerel'+deneme ve satin alma acik.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');

const PORT = 45971, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const GIZLI = 'test-gizli-anahtar-1234567890';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

function govde() {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: 779105, isletme_slug: 'quote-test', isletme_adi: 'Quote Test Lokanta',
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: '', unvan: '', vergi_dairesi: '', vergi_no: '',
        yetkili_ad: 'Quote Sahibi', yetkili_email: 'quote-sahibi@ornek.test', yetkili_tel: '05321112288',
        deneme_gun: 7, damga_ms: Date.now(), gecerli_sn: 600, nonce: crypto.randomBytes(12).toString('hex'),
    };
}
function baglanti(g) {
    const kanonik = JSON.stringify(g, Object.keys(g).sort());
    const u = new URL(TABAN + '/api/public/soframix-deneme');
    u.searchParams.set('v', '1');
    u.searchParams.set('yuk', Buffer.from(kanonik, 'utf8').toString('base64url'));
    u.searchParams.set('imza', crypto.createHmac('sha256', GIZLI).update(kanonik).digest('hex'));
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
    const t = await query("SELECT id FROM tenants WHERE business_name = 'Quote Test Lokanta'");
    for (const r of t.rows) {
        for (const tb of ['lisans_odemeleri', 'license_cache', 'islem_gunlugu', 'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM deneme_kayitlari WHERE soframix_business_id = '779105'");
    await query("DELETE FROM deneme_devir_nonce WHERE isletme_no = '779105'");
}

(async () => {
    initDb(); await uyu(900); await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               JWT_SECRET: 'quote-test-jwt', ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    const kat = (await js('/api/license/catalog')).d;
    const tier = kat.tiers[0] && kat.tiers[0].name;
    ok('katalogda en az bir paket var', !!tier, kat);

    console.log('=== Oturumsuz quote ===');
    const q0 = await js('/api/license/quote', { body: { tier, modules: [] } });
    ok('oturumsuz 200 + indirim 0', q0.status === 200 && q0.d.discountRate === 0 && typeof q0.d.total === 'number', q0);
    const q1 = await js('/api/license/quote', { body: { tier: 'YOK_BOYLE', modules: [] } });
    ok('gecersiz paket 400 (500 degil)', q1.status === 400, q1);
    const q2 = await js('/api/license/quote', { body: { tier, modules: [] }, headers: { Authorization: 'Bearer bozuk.jeton.x' } });
    ok('bozuk jetonla anonim devam (200)', q2.status === 200 && q2.d.discountRate === 0, q2);
    const q3 = await js('/api/license/quote', { body: { tier, modules: ['UYDURMA_MODUL'] } });
    ok('satista olmayan modul 400', q3.status === 400, q3);

    console.log('\n=== Deneme hesabi (dogrudan): kanal yerel + indirimli quote + satin alma acik ===');
    const r = await fetch(baglanti(govde()), { redirect: 'manual' });
    const jeton = (r.headers.get('location') || '').split('/deneme-giris/')[1];
    const sahip = (await js('/api/public/deneme-giris/' + jeton, { method: 'POST' })).d;
    const me = (await js('/api/auth/me', { token: sahip.token })).d;
    await query('UPDATE tenants SET parent_org = NULL, discount_rate = 10 WHERE id = ?', [me.tenantId]);
    const yk = await js('/api/license/yenileme-kanali', { token: sahip.token });
    ok('deneme hesabi: kanal yerel + deneme:true + mesaj', yk.status === 200 && yk.d.kanal === 'yerel' && yk.d.deneme === true && /1 yıl/.test(yk.d.mesaj), yk.d);
    const q4 = await js('/api/license/quote', { token: sahip.token, body: { tier, modules: [] } });
    ok('oturumlu quote: %10 indirim uygulanir', q4.status === 200 && q4.d.discountRate === 10 && q4.d.total === Math.max(0, q4.d.subtotal - q4.d.discountAmount), q4.d);
    const satin = await js('/api/license/purchase', { token: sahip.token, body: { tier, modules: [] } });
    ok('deneme hesabi satin alma baslatabilir (201)', satin.status === 201 && satin.d.status === 'PENDING_PAYMENT', satin);
    const liste = await js('/api/license/purchases', { token: sahip.token });
    ok('bekleyen odeme listede', liste.status === 200 && Array.isArray(liste.d) && liste.d.length === 1 && liste.d[0].durum === 'beklemede', liste.d);
    ok('listede arayuz alanlari (status/amount/modules)', liste.d[0].status === 'PENDING_PAYMENT' && typeof liste.d[0].amount === 'number' && Array.isArray(liste.d[0].modules), liste.d[0]);
    const bild = await js('/api/license/purchases/' + satin.d.id + '/mark-paid', { token: sahip.token, body: { paymentRef: 'dekont 1234' } });
    const tekil = await js('/api/license/purchases/' + satin.d.id, { token: sahip.token });
    ok('odemeyi yaptim: PAID_DECLARED + paid_declared_at + aciklama', bild.status === 200 && tekil.d.status === 'PAID_DECLARED' && !!tekil.d.paid_declared_at && tekil.d.aciklama === 'dekont 1234', tekil.d);
    ok('listede de PAID_DECLARED', (await js('/api/license/purchases', { token: sahip.token })).d[0].status === 'PAID_DECLARED');
    ok('ikinci kez bildirim 200 (hala beklemede)', (await js('/api/license/purchases/' + satin.d.id + '/mark-paid', { token: sahip.token, body: {} })).status === 200);
    const ikinci = await js('/api/license/purchase', { token: sahip.token, body: { tier, modules: [] } });
    ok('ikinci bildirim 409 (bekleyen varken)', ikinci.status === 409, ikinci);

    console.log('\n=== SofraMix kaynakli hesap: kanal soframix, satin alma kapali ===');
    await query("UPDATE tenants SET parent_org = 'SofraMix' WHERE id = ?", [me.tenantId]);
    await query("UPDATE lisans_odemeleri SET durum = 'iptal' WHERE tenant_id = ?", [me.tenantId]);
    const yk2 = await js('/api/license/yenileme-kanali', { token: sahip.token });
    ok('kanal soframix + url', yk2.d.kanal === 'soframix' && /\/isletme\/pos$/.test(yk2.d.url), yk2.d);
    const satin2 = await js('/api/license/purchase', { token: sahip.token, body: { tier, modules: [] } });
    ok('SofraMix hesabinda satin alma 409 WRONG_CHANNEL', satin2.status === 409 && satin2.d.code === 'WRONG_CHANNEL', satin2);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
