// Guvenlik incelemesi (2026-11-12) duzeltmeleri. Her bulgu kendi bolumunde:
//   Y1  destek yasaklari harf varyanti, mutlak istek satiri ve sondaki / ile atlanamaz (rota duzeyinde yasak +
//       yol normallestirme); dusuk 1: salt-okunurda "GET /API/magaza" kisiti atlanamaz.
//   O3  oturumu acan root pasif ya da silinmisse destek oturumu calismaz ve kapanir.
// Sunucuyu KENDI baslatir.  Calistir: node test_guvenlik.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const net = require('net');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 46251, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'guvenlik-test-jwt';
const ON = 'GVN Test';
const EPOSTA_ON = 'gvn-';
const GUN = 86400000;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 400) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
// Ham soket: istek satirini oldugu gibi yazar (orn. mutlak bicim "POST http://host/api/... HTTP/1.1")
function hamIstek(satir, { token, govde } = {}) {
    return new Promise((tamam, hata) => {
        const b = govde ? JSON.stringify(govde) : '';
        const s = net.connect(PORT, '127.0.0.1', () => {
            s.write(`${satir} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` + (token ? `Authorization: Bearer ${token}\r\n` : '')
                + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(b)}\r\nConnection: close\r\n\r\n${b}`);
        });
        let veri = '';
        s.on('data', (d) => { veri += d; });
        s.on('end', () => tamam({ status: Number((veri.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0), govde: veri.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
        s.on('error', hata);
    });
}

async function kiraciKur({ ad, tier = 'TIER_6_10', moduller = ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON'], bitis, kayitGun = -200 }) {
    const id = uuid();
    const slug = 'gvn-' + crypto.randomBytes(4).toString('hex');
    const kod = String(80000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, '05320000000', 'Test Mah. 1', ?, ?, ?, 1, ?)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, tier, JSON.stringify(moduller),
            bitis || new Date(Date.now() + 200 * GUN).toISOString(), new Date(Date.now() + kayitGun * GUN).toISOString().replace('T', ' ').slice(0, 19)]);
    const sahipId = uuid();
    const eposta = `${EPOSTA_ON}sahip-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [sahipId, id, eposta, await bcrypt.hash('sahip1234', 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    const g = await js('/api/auth/login', { body: { email: eposta, businessCode: kod, password: 'sahip1234' } });
    return { id, slug, kod, sahipId, token: g.d && g.d.token };
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
async function destekJetonu(rj, tenantId) {
    const ac = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId, sebep: 'Guvenlik testi' } });
    const gr = await js('/api/destek/giris/' + (ac.d && ac.d.jeton), { method: 'POST' });
    return { token: gr.d && gr.d.token, oturumId: ac.d && ac.d.id };
}

async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%' OR owner_email LIKE '${EPOSTA_ON}%'`);
    for (const r of t.rows) {
        for (const tb of ['destek_oturumlari', 'islem_gunlugu', 'yonetim_gunlugu', 'lisans_odemeleri', 'license_cache', 'categories', 'tables',
            'push_subscriptions', 'gecis_haklari', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM yonetim_gunlugu WHERE root_id IN (SELECT id FROM root_users WHERE email LIKE '${EPOSTA_ON}%')`).catch(() => {});
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

    console.log('=== Y1) Destek yasaklari: harf varyanti, mutlak istek satiri, sondaki / ===');
    const A = await kiraciKur({ ad: 'Destek Yasak' });
    const { token: DK } = await destekJetonu(rj, A.id);
    ok('destek oturumu acildi', !!DK);
    const sahipOnce = (await query('SELECT password_hash, email FROM users WHERE id = ?', [A.sahipId])).rows[0];
    const yasak = (x) => x.status === 403 && x.d && x.d.code === 'DESTEK_YASAK';
    ok('POST /API/auth/staff 403', yasak(await js('/API/auth/staff', { token: DK, body: { email: 'gvn-x1@ornek.test', name: 'X', role: 'CASHIER', password: 'gecici1234' } })));
    ok('POST /api/Auth/staff 403', yasak(await js('/api/Auth/staff', { token: DK, body: { email: 'gvn-x2@ornek.test', name: 'X', role: 'CASHIER', password: 'gecici1234' } })));
    ok('POST /api/auth/staff/ (sondaki /) 403', yasak(await js('/api/auth/staff/', { token: DK, body: { email: 'gvn-x3@ornek.test', name: 'X', role: 'CASHIER', password: 'gecici1234' } })));
    ok('PATCH /api/Auth/staff/<sahip> 403', yasak(await js('/api/Auth/staff/' + A.sahipId, { token: DK, method: 'PATCH', body: { password: 'ElGecirdim123' } })));
    ok('POST /API/AUTH/MANAGER-SET 403', yasak(await js('/API/AUTH/MANAGER-SET', { token: DK, body: { pin: '1234' } })));
    ok('POST /api/Auth/sifre-degistir 403', yasak(await js('/api/Auth/sifre-degistir', { token: DK, body: { mevcut: 'x', yeni: 'YeniSifre123' } })));
    ok('POST /api/Tenant/close 403', yasak(await js('/api/Tenant/close', { token: DK, body: {} })));
    ok('POST /api/Push/Abone 403', yasak(await js('/api/Push/Abone', { token: DK, body: {} })));
    const hamStaff = await hamIstek(`POST http://127.0.0.1:${PORT}/api/auth/staff`, { token: DK, govde: { email: 'gvn-x4@ornek.test', name: 'X', role: 'CASHIER', password: 'gecici1234' } });
    ok('mutlak istek satiri POST http://host/api/auth/staff 403', hamStaff.status === 403 && /DESTEK_YASAK/.test(hamStaff.govde), hamStaff);
    const hamKapat = await hamIstek(`POST http://127.0.0.1:${PORT}/api/Tenant/close/`, { token: DK, govde: {} });
    ok('mutlak istek satiri POST http://host/api/Tenant/close/ 403', hamKapat.status === 403, hamKapat);
    const hamPatch = await hamIstek(`PATCH http://127.0.0.1:${PORT}/api/auth/staff/${A.sahipId}`, { token: DK, govde: { password: 'ElGecirdim123' } });
    ok('mutlak istek satiri PATCH sahip 403', hamPatch.status === 403, hamPatch);
    const sahipSonra = (await query('SELECT password_hash, email FROM users WHERE id = ?', [A.sahipId])).rows[0];
    ok('sahibin sifresi ve e-postasi degismedi', sahipOnce.password_hash === sahipSonra.password_hash && sahipOnce.email === sahipSonra.email);
    ok('personel eklenmedi', (await query("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND email LIKE 'gvn-x%'", [A.id])).rows[0].n === 0);
    ok('hesap kapatma talebi yazilmadi', !(await query('SELECT closure_requested_at FROM tenants WHERE id = ?', [A.id])).rows[0].closure_requested_at);
    ok('izinli yazma calisir (POST /API/Categories 201)', (await js('/API/Categories', { token: DK, body: { name: 'GVN Kategori' } })).status === 201);
    const etiket = (await query("SELECT detay FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'destek_degisiklik' ORDER BY created_at DESC LIMIT 1", [A.id])).rows[0];
    ok('gunluk etiketi normallestirilmis yolla', etiket && /\(POST \/api\/categories\)/.test(etiket.detay), etiket);
    ok('isletme sahibi kendi hesabindan personel ekleyebilir (yasak yalniz destekte)', (await js('/api/auth/staff', { token: A.token, body: { email: `gvn-p-${A.slug}@ornek.test`, name: 'Kasa', role: 'CASHIER', password: 'kasa12345' } })).status === 201);

    console.log('\n=== Dusuk 1) Salt-okunur: magaza kisiti yol bicimiyle atlanamaz ===');
    const S = await kiraciKur({ ad: 'Salt Okunur', bitis: new Date(Date.now() - GUN).toISOString() });
    const ro = (x) => x.status === 403 && x.d && x.d.code === 'LICENSE_READONLY';
    ok('GET /api/magaza/urunler 403', ro(await js('/api/magaza/urunler', { token: S.token })));
    ok('GET /API/Magaza/Urunler 403 (harf varyanti)', ro(await js('/API/Magaza/Urunler', { token: S.token })));
    ok('GET /api/magaza/urunler/ 403 (sondaki /)', ro(await js('/api/magaza/urunler/', { token: S.token })));
    const hamMagaza = await hamIstek(`GET http://127.0.0.1:${PORT}/api/magaza/urunler`, { token: S.token });
    ok('mutlak istek satiri GET http://host/api/magaza/urunler 403', hamMagaza.status === 403 && /LICENSE_READONLY/.test(hamMagaza.govde), hamMagaza);
    ok('izinli olanlar acik: GET /API/magaza/siparisler 200', (await js('/API/magaza/siparisler', { token: S.token })).status === 200);
    ok('lisans ucu yazmasi acik: POST /API/License/quote 200', (await js('/API/License/quote', { token: S.token, body: { tier: 'TIER_6_10', modules: ['BASE'] } })).status === 200);

    console.log('\n=== O3) Root pasif ya da silinmis: destek oturumu gecersiz ===');
    const B = await kiraciKur({ ad: 'Root Pasif' });
    async function ekRoot() {
        const id = uuid();
        await query('INSERT INTO root_users (id, email, password_hash, name, totp_enabled) VALUES (?, ?, ?, ?, 1)',
            [id, `${EPOSTA_ON}root-${id.slice(0, 6)}@ornek.test`, 'x', 'Ek Root']);
        return { id, jeton: jwt.sign({ rootId: id, scope: 'root' }, JWT_SECRET, { expiresIn: '1h' }) };
    }
    const oturum = async (oid) => (await query('SELECT bitis_at, kapanis_nedeni FROM destek_oturumlari WHERE id = ?', [oid])).rows[0];
    const r2 = await ekRoot();
    const d2 = await destekJetonu(r2.jeton, B.id);
    ok('ek root destek oturumu calisir', (await js('/api/tables', { token: d2.token })).status === 200);
    await query('UPDATE root_users SET is_active = 0 WHERE id = ?', [r2.id]);
    const p2 = await js('/api/tables', { token: d2.token });
    ok('root pasife alininca destek jetonu 401 DESTEK_OTURUMU_BITTI', p2.status === 401 && p2.d.code === 'DESTEK_OTURUMU_BITTI', p2);
    const o2 = await oturum(d2.oturumId);
    ok('oturum ROOT_GECERSIZ nedeniyle kapandi', !!o2.bitis_at && o2.kapanis_nedeni === 'ROOT_GECERSIZ', o2);
    await query('UPDATE root_users SET is_active = 1 WHERE id = ?', [r2.id]);
    ok('root yeniden aktif olsa da kapanan oturum acilmaz', (await js('/api/tables', { token: d2.token })).status === 401);
    const r3 = await ekRoot();
    const d3 = await destekJetonu(r3.jeton, B.id);
    await query('DELETE FROM root_users WHERE id = ?', [r3.id]);
    ok('root silinince destek jetonu 401', (await js('/api/categories', { token: d3.token, body: { name: 'GVN Silinmis Root' } })).status === 401);
    ok('... oturum kapandi', (await oturum(d3.oturumId)).kapanis_nedeni === 'ROOT_GECERSIZ');
    const r4 = await ekRoot();
    const ac4 = await js('/api/root/yonetim/destek', { token: r4.jeton, body: { tenantId: B.id } });
    await query('UPDATE root_users SET is_active = 0 WHERE id = ?', [r4.id]);
    const g4 = await js('/api/destek/giris/' + ac4.d.jeton, { method: 'POST' });
    ok('pasif root\'un acilmamis jetonu cevrilemez (410)', g4.status === 410 && !(g4.d && g4.d.token), g4);
    const r5 = await ekRoot();
    const d5 = await destekJetonu(r5.jeton, B.id);
    await query('UPDATE root_users SET is_active = 0 WHERE id = ?', [r5.id]);
    const liste = (await js('/api/root/yonetim/destek?tenantId=' + B.id, { token: rj })).d;
    const s5 = (Array.isArray(liste) ? liste : (liste.oturumlar || [])).find((x) => x.id === d5.oturumId);
    ok('root listesi acilirken pasif root\'un acik oturumu kapanir', s5 && s5.durum === 'KAPALI' && s5.kapanisNedeni === 'ROOT_GECERSIZ', s5 || liste);

    // --- SONRAKI BOLUMLER ---

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU', e); try { await temizle(); } catch (_) {} process.exit(1); });
