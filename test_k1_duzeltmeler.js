// K1 uctan uca test bulgulari (2026-11-18): red sonrasi korumasiz bildirim musteriye ve root'a soylenir
// (koruma_yok_red, yenileme-kanali.bekleyenOdeme, root onceki_red), ozel paket kodlari okunur adla (TIER_DENEME),
// masa uyarisi "acik hesabi olmayan masalar" der, Garson katalog aciklamasi yeni satis kuraliyla celismez.
// Sunucuyu KENDI baslatir. Calistir: node test_k1_duzeltmeler.js   (port 47600)
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47600, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'k1-duzeltme-test-jwt';
const ON = 'K1D Test';
const EPOSTA_ON = 'k1d-';
const GUN = 86400000;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 500) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const KOD_TABAN = Math.floor(Math.random() * 9999);
let kodSayac = 0;

async function js(yol, { token, body, method } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
const bitisGun = (gun) => new Date(Date.now() + gun * GUN - 3600000).toISOString();

async function kiraciKur({ ad, tier = 'TIER_DENEME', moduller = ['BASE', 'MENU_DIGITAL'], bitis }) {
    const id = uuid();
    const slug = 'k1d-' + crypto.randomBytes(4).toString('hex');
    const kod = String(60000 + (KOD_TABAN + kodSayac++) % 9999);
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, is_active, created_at, billing_name, billing_tax_id, billing_address)
         VALUES (?, ?, ?, ?, ?, '05320000000', 'Test Mah. 1', ?, ?, ?, 1, datetime('now', '-5 days'), 'Test', '12345678901', 'Test Mah. 1, Afyon')`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, tier, JSON.stringify(moduller), bitis]);
    const eposta = `${EPOSTA_ON}sahip-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), id, eposta, await bcrypt.hash('sahip1234', 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    const g = await js('/api/auth/login', { body: { email: eposta, businessCode: kod, password: 'sahip1234' } });
    return { id, slug, kod, eposta, token: g.d && g.d.token, girisDurumu: g.status };
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

let katalogYedek = null;
async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%' OR owner_email LIKE '${EPOSTA_ON}%'`);
    for (const r of t.rows) {
        for (const tb of ['lisans_odemeleri', 'tables', 'root_olaylar', 'license_cache', 'islem_gunlugu', 'yonetim_gunlugu', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    if (katalogYedek) for (const x of katalogYedek) await query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [x.fiyat, x.gorunur, x.id]);
}

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    katalogYedek = (await query('SELECT id, fiyat, gorunur FROM lisans_katalog')).rows;
    await query("UPDATE lisans_katalog SET fiyat = 3000, gorunur = 1 WHERE id = 'TIER-TIER_1_5'");
    await query("UPDATE lisans_katalog SET fiyat = 4000, gorunur = 1 WHERE id = 'TIER-TIER_6_10'");
    await query("UPDATE lisans_katalog SET fiyat = 1000, gorunur = 1 WHERE id = 'MODUL-MENU_DIGITAL'");

    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '',
               ODEME_KORUMA_ONBELLEK_MS: '0' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();
    const rootKaydi = async (id) => (await js('/api/root/lisans-odemeleri', { token: rj })).d.find((x) => x.id === id);

    console.log('=== 1) Ozel paket kodlari okunur adla ===');
    const LT = require('./src/services/lisansTalep');
    const tam = await require('./src/services/lisansKatalog').tamKatalog();
    ok('TIER_DENEME -> Deneme sürümü', LT.tierAdi(tam, 'TIER_DENEME') === 'Deneme sürümü', LT.tierAdi(tam, 'TIER_DENEME'));
    ok('TIER_MUSTERI -> Müşteri paketi', LT.tierAdi(tam, 'TIER_MUSTERI') === 'Müşteri paketi');
    ok('katalogdaki kod katalog adiyla', LT.tierAdi(tam, 'TIER_1_5') !== 'TIER_1_5');

    console.log('\n=== 2) Garson aciklamasi celismez ===');
    const g = (await query("SELECT aciklama FROM lisans_katalog WHERE id = 'MODUL-GARSON'")).rows[0];
    ok('Garson aciklamasi "yalnız çağrıları gösterir" demiyor', g && !/yalnız çağrıları/.test(g.aciklama || ''), g);

    console.log('\n=== 3) Red sonrasi ikinci bildirim korumasiz: musteri ve root gorur ===');
    const a = await kiraciKur({ ad: 'Red', bitis: bitisGun(-1) });   // deneme bitti (salt-okunur)
    ok('giris', a.girisDurumu === 200 && !!a.token, a);
    const s1 = await js('/api/license/purchase', { token: a.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('talep 201', s1.status === 201, s1);
    const p1 = await js(`/api/license/purchases/${s1.d.id}/mark-paid`, { token: a.token, body: { paymentRef: 'deneme' } });
    ok('odemeyi yaptim', p1.status === 200, p1);
    const k1 = (await js(`/api/license/purchases/${s1.d.id}`, { token: a.token })).d;
    ok('ilk bildirim korumali, koruma_yok_red false', !!k1.koruma_bitis && k1.koruma_yok_red === false, k1);
    const yk1 = (await js('/api/license/yenileme-kanali', { token: a.token })).d;
    ok('yenileme-kanali bekleyenOdeme: bildirildi, korumali, red yok', yk1.bekleyenOdeme && yk1.bekleyenOdeme.bildirildi === true
        && !!yk1.bekleyenOdeme.korumaBitis && yk1.bekleyenOdeme.redVar === false, yk1.bekleyenOdeme);
    const red = await js(`/api/root/lisans-odemeleri/${s1.d.id}/reddet`, { token: rj, body: { not: 'Hesapta görünmedi' } });
    ok('root reddetti', red.status === 200, red);
    const s2 = await js('/api/license/purchase', { token: a.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('yeniden talep 201', s2.status === 201, s2);
    const k2a = (await js(`/api/license/purchases/${s2.d.id}`, { token: a.token })).d;
    ok('bildirimden once de koruma_yok_red true', k2a.koruma_yok_red === true, k2a);
    await js(`/api/license/purchases/${s2.d.id}/mark-paid`, { token: a.token, body: {} });
    const k2 = (await js(`/api/license/purchases/${s2.d.id}`, { token: a.token })).d;
    ok('ikinci bildirim: koruma yok + koruma_yok_red true', k2.status === 'PAID_DECLARED' && k2.koruma_bitis === null && k2.koruma_yok_red === true, k2);
    const yk2 = (await js('/api/license/yenileme-kanali', { token: a.token })).d;
    ok('yenileme-kanali: bildirildi, korumasiz, red var', yk2.bekleyenOdeme && yk2.bekleyenOdeme.bildirildi === true
        && yk2.bekleyenOdeme.korumaBitis === null && yk2.bekleyenOdeme.redVar === true, yk2.bekleyenOdeme);
    const me = (await js('/api/auth/me', { token: a.token })).d;
    ok('lisans koruma olmadan bitmis gorunur (odemeKorumasi yok)', me && me.lisansDurum !== 'AKTIF' && !me.odemeKorumasi, me && [me.lisansDurum, me.odemeKorumasi]);
    const rk = await rootKaydi(s2.d.id);
    ok('root kaydi: onceki_red notu ve tarihi', rk && rk.onceki_red && rk.onceki_red.not === 'Hesapta görünmedi' && !!rk.onceki_red.tarih, rk && rk.onceki_red);
    ok('root kaydi: onceki/mevcut paket adi ham kod degil', rk && rk.onceki_tier_ad === 'Deneme sürümü' && rk.mevcut_tier_ad === 'Deneme sürümü', rk && [rk.onceki_tier_ad, rk.mevcut_tier_ad]);

    console.log('\n=== 4) Masa uyarisi metni ===');
    const b = await kiraciKur({ ad: 'Masa', bitis: bitisGun(3) });
    for (let i = 0; i < 7; i++) {
        await query("INSERT INTO tables (id, tenant_id, code, name, qr_token, is_active) VALUES (?, ?, ?, ?, ?, 1)", [uuid(), b.id, 'K1D' + i, 'M' + (i + 1), crypto.randomBytes(8).toString('hex')]);
    }
    const mu = await js('/api/license/purchase', { token: b.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('masa uyarisi: acik hesabi olmayan masalar', mu.status === 400 && mu.d.code === 'MASA_UYARISI_ONAY_GEREKLI'
        && /açık hesabı olmayan masalarınız pasife alınır/.test(mu.d.message) && !/tüm masalarınız/.test(mu.d.message), mu.d);

    sunucu.kill();
    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
