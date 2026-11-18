// "Ek süre tanımla (rakipten geçiş)" (2026-11-18). Kapsam: yalniz onayli lisans odemesi ya da islenmis SofraMix odemesi
// olan isletmeye (yoksa 409 EK_SURE_ODEME_YOK), gun ve not dogrulamasi (1-3650, isletme basina tavan yok), sure mevcut
// bitisin uzerine (bittiyse simdiden), yonetim gunlugu, Lisans sayfasinda bir kerelik bildirim, yetki.
// Sunucuyu KENDI baslatir. Calistir: node test_ek_sure.js   (port 47620)
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47620, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'ek-sure-test-jwt';
const ON = 'EKS Test';
const EPOSTA_ON = 'eks-';
const GUN = 86400000;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 500) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const yakin = (a, b, tol = 5 * 60000) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) < tol;
const KOD_TABAN = Math.floor(Math.random() * 9999);
let kodSayac = 0;
const trTarih = (d) => new Date(d).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric' });

async function js(yol, { token, body, method } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

async function kiraciKur({ ad, tier = 'TIER_1_5', bitis }) {
    const id = uuid();
    const slug = 'eks-' + crypto.randomBytes(4).toString('hex');
    const kod = String(80000 + (KOD_TABAN + kodSayac++) % 9999);
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, license_tier, license_modules,
                              license_end_date, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, '05320000000', ?, '["BASE","MENU_DIGITAL"]', ?, 1, datetime('now', '-300 days'))`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, tier, bitis ? bitis.toISOString() : null]);
    const eposta = `${EPOSTA_ON}sahip-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), id, eposta, await bcrypt.hash('sahip1234', 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    const g = await js('/api/auth/login', { body: { email: eposta, businessCode: kod, password: 'sahip1234' } });
    return { id, slug, kod, eposta, token: g.d && g.d.token, girisDurumu: g.status };
}
const odemeKur = (tenantId, durum = 'onaylandi') => query(
    `INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, donem_bitis, islenen_at, onay_gun)
     VALUES (?, ?, 'TIER_1_5', '[]', 5000, ?, datetime('now', '+100 days'), datetime('now', '-265 days'), 365)`,
    ['eks-' + crypto.randomBytes(4).toString('hex'), tenantId, durum]);
const kiraci = async (id) => (await query('SELECT * FROM tenants WHERE id = ?', [id])).rows[0];

let rootId = null;
async function rootJeton() {
    if (!rootId) {
        rootId = uuid();
        await query('INSERT INTO root_users (id, email, password_hash, name, totp_enabled) VALUES (?, ?, ?, ?, 1)',
            [rootId, `${EPOSTA_ON}root-${rootId.slice(0, 6)}@ornek.test`, 'x', 'Test Root']);
    }
    return jwt.sign({ rootId, scope: 'root' }, JWT_SECRET, { expiresIn: '1h' });
}
async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%' OR owner_email LIKE '${EPOSTA_ON}%'`);
    for (const r of t.rows) {
        for (const tb of ['lisans_odemeleri', 'pos_provizyon', 'ek_sure_tanimlari', 'root_olaylar', 'license_cache', 'islem_gunlugu', 'yonetim_gunlugu', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
}

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();
    const ekSure = (id, body, token = rj) => js(`/api/root/yonetim/isletme/${id}/ek-sure`, { token, body });

    console.log('=== 0) Sema ===');
    const kol = (await query('PRAGMA table_info(ek_sure_tanimlari)')).rows.map((x) => x.name);
    ok('ek_sure_tanimlari tablosu', ['tenant_id', 'gun', 'aciklama', 'onceki_bitis', 'yeni_bitis', 'goruldu_at'].every((k) => kol.includes(k)), kol);
    ok('isletme e-postasi: lisansBildirim.ekSure var', typeof require('./src/services/lisansBildirim').ekSure === 'function');

    console.log('\n=== 1) Odeme yoksa 409 ===');
    const d = await kiraciKur({ ad: 'Deneme', tier: 'TIER_DENEME', bitis: new Date(Date.now() + 5 * GUN) });
    const r0 = await ekSure(d.id, { gun: 143, not: 'X programı lisans ekranı, 143 gün' });
    ok('deneme (odeme yok): 409 + mesaj', r0.status === 409 && r0.d.code === 'EK_SURE_ODEME_YOK'
        && r0.d.message === 'Ek süre ilk ödeme onaylandıktan sonra tanımlanabilir.', r0);
    ok('bitis degismedi', yakin((await kiraci(d.id)).license_end_date, Date.now() + 5 * GUN));
    await odemeKur(d.id, 'beklemede');
    await odemeKur(d.id, 'reddedildi');
    const r1 = await ekSure(d.id, { gun: 10, not: 'deneme notu' });
    ok('bekleyen / reddedilen odeme sayilmaz: 409', r1.status === 409, r1);

    console.log('\n=== 2) Dogrulama ===');
    const a = await kiraciKur({ ad: 'Musteri', bitis: new Date(Date.now() + 100 * GUN) });
    await odemeKur(a.id);
    for (const [ad, govde] of [['gun 0', { gun: 0, not: 'abc not' }], ['gun 1.5', { gun: 1.5, not: 'abc not' }], ['gun 3651', { gun: 3651, not: 'abc not' }],
        ['gun metin', { gun: 'on', not: 'abc not' }], ['not yok', { gun: 10 }], ['not kisa', { gun: 10, not: ' a ' }], ['not uzun', { gun: 10, not: 'x'.repeat(301) }]]) {
        const r = await ekSure(a.id, govde);
        ok('400: ' + ad, r.status === 400, r);
    }
    ok('bilinmeyen isletme 404', (await ekSure(uuid(), { gun: 10, not: 'abc not' })).status === 404);
    ok('isletme jetonuyla root ucu acilmaz', [401, 403].includes((await ekSure(a.id, { gun: 10, not: 'abc not' }, a.token)).status));

    console.log('\n=== 3) Mevcut bitisin uzerine eklenir ===');
    const once = (await kiraci(a.id)).license_end_date;
    const r2 = await ekSure(a.id, { gun: 143, not: 'X programı lisans ekranı, 143 gün' });
    const t2 = await kiraci(a.id);
    ok('200, bitis + 143 gun', r2.status === 200 && t2.license_end_date === r2.d.yeniBitis
        && new Date(t2.license_end_date).getTime() - new Date(once).getTime() === 143 * GUN, [r2.d, once, t2.license_end_date]);
    ok('paket degismedi', t2.license_tier === 'TIER_1_5' && t2.license_modules === '["BASE","MENU_DIGITAL"]');
    ok('cevap metni', r2.d.metin === `Ek lisans süreniz tanımlanmıştır: 143 gün. Yeni bitiş tarihiniz: ${trTarih(t2.license_end_date)}.`, r2.d.metin);
    const kayit = (await query('SELECT * FROM ek_sure_tanimlari WHERE tenant_id = ?', [a.id])).rows;
    ok('ek_sure_tanimlari kaydi', kayit.length === 1 && kayit[0].gun === 143 && kayit[0].aciklama === 'X programı lisans ekranı, 143 gün'
        && kayit[0].onceki_bitis === once && kayit[0].root_id === rootId && !kayit[0].goruldu_at, kayit);
    const yg = (await query("SELECT * FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'ek_sure'", [a.id])).rows;
    ok('yonetim gunlugu: ek_sure, not ve gun ozette', yg.length === 1 && /143 gün/.test(yg[0].ozet) && /X programı/.test(yg[0].ozet), yg);
    const gl = await js(`/api/root/yonetim/gunluk?tenantId=${a.id}`, { token: rj });
    const glSatir = gl.d && (gl.d.kayitlar || gl.d.liste || gl.d.rows || gl.d);
    ok('gunluk listesinde islem adi', gl.status === 200 && JSON.stringify(glSatir).includes('Ek süre (rakipten geçiş)'), gl.status);

    console.log('\n=== 4) Lisans sayfasi bildirimi (bir kez) ===');
    const b1 = (await js('/api/license/ek-sure-bildirimi', { token: a.token })).d;
    ok('bildirim metni', b1 && b1.id === kayit[0].id && b1.metin === r2.d.metin, b1);
    const bg = await js(`/api/license/ek-sure-bildirimi/${b1.id}/goruldu`, { token: a.token, body: {} });
    ok('goruldu 200', bg.status === 200, bg);
    const b2 = (await js('/api/license/ek-sure-bildirimi', { token: a.token })).d;
    ok('ikinci kez gelmez', b2 && !b2.id, b2);
    const yabanci = await kiraciKur({ ad: 'Yabanci', bitis: new Date(Date.now() + 30 * GUN) });
    ok('baska isletmenin bildirimi kapatilamaz (404)', (await js(`/api/license/ek-sure-bildirimi/${b1.id}/goruldu`, { token: yabanci.token, body: {} })).status === 404);

    console.log('\n=== 5) Tavan yok; bitmis lisans simdiden ===');
    const r3 = await ekSure(a.id, { gun: 3650, not: 'ikinci tanim, akil siniri' });
    const r4 = await ekSure(a.id, { gun: 3650, not: 'ucuncu tanim' });
    ok('isletme basina tavan yok (3650 + 3650)', r3.status === 200 && r4.status === 200
        && new Date(r4.d.yeniBitis).getTime() - new Date(r2.d.yeniBitis).getTime() === 7300 * GUN, [r3.status, r4.status]);
    const b3 = (await js('/api/license/ek-sure-bildirimi', { token: a.token })).d;
    ok('yeni bildirim son tanimi gosterir', b3 && b3.gun === 3650 && b3.metin.includes(trTarih(r4.d.yeniBitis)), b3);
    await js(`/api/license/ek-sure-bildirimi/${b3.id}/goruldu`, { token: a.token, body: {} });
    ok('son bildirim kapaninca eskiler de kapanir', !(await js('/api/license/ek-sure-bildirimi', { token: a.token })).d.id);
    const e = await kiraciKur({ ad: 'Bitmis', bitis: new Date(Date.now() - 10 * GUN) });
    await odemeKur(e.id);
    const r5 = await ekSure(e.id, { gun: 30, not: 'Y programı, 30 gün' });
    ok('bitmis lisans: simdi + 30 gun', r5.status === 200 && yakin(r5.d.yeniBitis, Date.now() + 30 * GUN), r5.d);
    const me = (await js('/api/auth/me', { token: e.token })).d;
    ok('isletme yeniden aktif', me && me.lisansDurum === 'AKTIF', me && me.lisansDurum);

    console.log('\n=== 6) Islenmis SofraMix odemesi yeterli ===');
    const s = await kiraciKur({ ad: 'SofraMix', tier: 'TIER_SOFRAMIX', bitis: new Date(Date.now() + 50 * GUN) });
    await query("UPDATE tenants SET parent_org = 'SofraMix' WHERE id = ?", [s.id]);
    const r6 = await ekSure(s.id, { gun: 20, not: 'SofraMix, Z programı 20 gün' });
    ok('islenmemis provizyonla 409', r6.status === 409, r6);
    await query("INSERT INTO pos_provizyon (id, odeme_id, tenant_id, durum) VALUES (?, ?, ?, 'islendi')", [uuid(), 'eks-' + crypto.randomBytes(5).toString('hex'), s.id]);
    const r7 = await ekSure(s.id, { gun: 20, not: 'SofraMix, Z programı 20 gün' });
    ok('islenmis SofraMix odemesiyle 200', r7.status === 200, r7);

    sunucu.kill();
    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
