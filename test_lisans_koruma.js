// Lisans KORUMA testi: SofraMix kiracisinin 1 yillik lisansi hub tarafindan
// ezilmemeli, kisaltilmamali; kanal-adaptor baglama beyaz listesi calismali.
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK
    || require('crypto').randomBytes(32).toString('base64');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const hub = require('./src/services/hubService');

const uyu = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : ''))); };
const gun = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function kiraciAc(x = {}) {
    const id = uuid();
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, parent_org, owner_email,
                              license_tier, license_end_date, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [id, 'k-' + uuid().slice(0, 8), '7' + String(Math.floor(Math.random() * 100000)).padStart(5, '0'),
            x.ad || 'Koruma Testi', x.parentOrg || null, x.eposta || `k${uuid().slice(0, 6)}@ornek.test`,
            x.tier || null, x.bitis || gun(365)]);
    return id;
}

(async () => {
    initDb(); await uyu(900);

    console.log('=== 1) SofraMix kiracisina hub DOKUNMAZ ===');
    // Hub'da kayitli olmayan SofraMix kiracisina "abonelik yok" denip is_active=0
    // yazilsaydi authMiddleware her istegi 403 ile keserdi; lisansDurumu'nun
    // 3 gunluk salt-okunur kademesi hic devreye giremez, musteri odedigi halde
    // kasayi hic acamazdi.
    const smx = await kiraciAc({ parentOrg: 'SofraMix', tier: 'TIER_SOFRAMIX', bitis: gun(-10) });
    const r1 = await hub.refreshTenantLicense(smx, 'yok@ornek.test');
    ok('hub disi sayildi', r1.reason === 'HUB_DISI', r1);
    const t1 = (await query('SELECT is_active, license_end_date FROM tenants WHERE id = ?', [smx])).rows[0];
    ok('kiraci PASIFLESTIRILMEDI', t1.is_active === 1, t1);
    ok('lisans tarihine dokunulmadi', t1.license_end_date === (await query(
        'SELECT license_end_date FROM tenants WHERE id = ?', [smx])).rows[0].license_end_date);

    console.log('\n--- tier TIER_SOFRAMIX ise parent_org olmasa da korunur ---');
    const smx2 = await kiraciAc({ tier: 'TIER_SOFRAMIX', bitis: gun(-30) });
    ok('yine hub disi', (await hub.refreshTenantLicense(smx2, 'yok2@ornek.test')).reason === 'HUB_DISI');
    ok('pasiflestirilmedi', (await query('SELECT is_active FROM tenants WHERE id = ?', [smx2])).rows[0].is_active === 1);

    console.log('\n=== 2) Adaptor beyaz listesi ===');
    const { listAvailable } = require('./src/marketplace/registry');
    const kodlar = listAvailable().map(a => a.code);
    ok('soframix baglanabilir listede', kodlar.includes('soframix'), kodlar);
    ok('yemeksepeti listede DEGIL (erisim yok)', !kodlar.includes('yemeksepeti'), kodlar);

    console.log('\n=== 3) SofraMix adaptoru: siparis yonu KAPALI beyan ediyor ===');
    const { getAdapter } = require('./src/marketplace/registry');
    const c = getAdapter('soframix').capabilities;
    ok('menuRead acik', c.menuRead === true);
    ok('acceptReject kapali', c.acceptReject === false);
    ok('markDelivered kapali', c.markDelivered === false);
    ok('storeOpenClose kapali', c.storeOpenClose === false);
    ok('menuWrite kapali (fiyat POStan SofraMixe gitmez)', c.menuWrite === false);

    // Temizlik
    for (const id of [smx, smx2]) await query('DELETE FROM tenants WHERE id = ?', [id]);
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
