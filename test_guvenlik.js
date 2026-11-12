// Guvenlik incelemesi (2026-11-12) duzeltmeleri. Her bulgu kendi bolumunde:
//   Y1  destek yasaklari harf varyanti, mutlak istek satiri ve sondaki / ile atlanamaz (rota duzeyinde yasak +
//       yol normallestirme); dusuk 1: salt-okunurda "GET /API/magaza" kisiti atlanamaz.
//   O3  oturumu acan root pasif ya da silinmisse destek oturumu calismaz ve kapanir.
//   O4  destek oturumunda ticari beyan ve yukumluluk yasak (magaza siparisi / odeme bildirimi, ucretli plaka talebi /
//       plaka odeme bildirimi, lisans "odemeyi yaptim"); teklif, lisans talebi ve hediye plaka serbest.
//   O5  QR acik uclari lisans durumuna bakar: KAPALI'da siparis / garson / hesap kapali, menu acik;
//       SALT_OKUNUR'da yalniz siparis kapali.
//   D2  gecis: license_modules '"ALL"' (JSON metni) ya da duz ALL ise ["ALL"]; BASE'e dusmez.
// Sunucuyu KENDI baslatir.  Calistir: node test_guvenlik.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const net = require('net');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb, modulGecisi, GECIS_ISARETI } = require('./src/config/db');
const zlib = require('zlib');
const fsx = require('fs');
const pathx = require('path');
const { UPLOADS_DIR } = require('./src/services/imageService');
// Plaka talebi logo ister: kucuk gecerli PNG
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const pngParca = (t, v) => { const u = Buffer.alloc(4); u.writeUInt32BE(v.length); const tv = Buffer.concat([Buffer.from(t), v]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(tv)); return Buffer.concat([u, tv, c]); };
function png(gen, yuk) {
    const ham = Buffer.alloc((gen * 4 + 1) * yuk, 200);
    for (let y = 0; y < yuk; y++) ham[y * (gen * 4 + 1)] = 0;
    const ih = Buffer.alloc(13); ih.writeUInt32BE(gen, 0); ih.writeUInt32BE(yuk, 4); ih[8] = 8; ih[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), pngParca('IHDR', ih), pngParca('IDAT', zlib.deflateSync(ham)), pngParca('IEND', Buffer.alloc(0))]);
}

const PORT = 46251, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'guvenlik-test-jwt';
const ON = 'GVN Test';
const EPOSTA_ON = 'gvn-';
const GUN = 86400000;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 400) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const KOD_TABAN = Math.floor(Math.random() * 9999);
let kodSayac = 0;

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
    const kod = String(80000 + (KOD_TABAN + kodSayac++) % 9999);   // ayni kosuda tekil (rastgele kod cakisiyordu)
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
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        await query('DELETE FROM payments WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM orders WHERE tenant_id = ?', [r.id]).catch(() => {});
        for (const tb of ['destek_oturumlari', 'islem_gunlugu', 'yonetim_gunlugu', 'lisans_odemeleri', 'license_cache', 'payments', 'waiter_calls',
            'qr_bekleyen_siparisler', 'products', 'categories', 'tables', 'push_subscriptions', 'gecis_haklari', 'plaka_talepleri', 'root_olaylar', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        fsx.rmSync(pathx.join(UPLOADS_DIR, r.id), { recursive: true, force: true });
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
    // Destek gunlugu satiri yanit bittikten sonra yazilir: kisa sure bekle
    let etiket = null;
    for (let i = 0; i < 20 && !etiket; i++) { etiket = (await query("SELECT detay FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'destek_degisiklik' ORDER BY created_at DESC LIMIT 1", [A.id])).rows[0]; if (!etiket) await uyu(100); }
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

    console.log('\n=== O4) Destekte ticari beyan ve yukumluluk yasak ===');
    const C = await kiraciKur({ ad: 'Beyan' });
    const { token: DC } = await destekJetonu(rj, C.id);
    const beyanYasak = (x) => x.status === 403 && x.d && x.d.code === 'DESTEK_YASAK' && x.d.message === 'Bu işlem işletmenin kendi beyanını gerektirir.';
    ok('magaza siparisi olusturma 403 + aciklama', beyanYasak(await js('/api/magaza/siparisler', { token: DC, body: { kalemler: [] } })));
    ok('magaza odeme bildirimi 403', beyanYasak(await js('/api/magaza/siparisler/yok-boyle/odeme-bildir', { token: DC, body: {} })));
    ok('plaka odeme bildirimi 403', beyanYasak(await js('/api/plaka/talepler/yok-boyle/odeme', { token: DC, body: {} })));
    // Lisans: teklif ve talep serbest, "odemeyi yaptim" yasak
    ok('lisans teklifi serbest (200)', (await js('/api/license/quote', { token: DC, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } })).status === 200);
    const talep = await js('/api/license/purchase', { token: DC, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    ok('lisans talebi serbest (201, bekleyen kayit)', talep.status === 201, talep);
    ok('lisans "odemeyi yaptim" 403', beyanYasak(await js(`/api/license/purchases/${talep.d.id}/mark-paid`, { token: DC, body: { paymentRef: 'x' } })));
    ok('... kayit odeme bildirilmemis kaldi', !(await query('SELECT odeme_bildirildi_at FROM lisans_odemeleri WHERE id = ?', [talep.d.id])).rows[0].odeme_bildirildi_at);
    ok('isletme sahibi "odemeyi yaptim" diyebilir (200)', (await js(`/api/license/purchases/${talep.d.id}/mark-paid`, { token: C.token, body: { paymentRef: 'x' } })).status === 200);
    // Plaka: ucretli talep yasak, yalniz hediye serbest
    fsx.mkdirSync(pathx.join(UPLOADS_DIR, C.id), { recursive: true });
    fsx.writeFileSync(pathx.join(UPLOADS_DIR, C.id, 'logo.png'), png(700, 240));
    await query('UPDATE tenants SET logo_url = ? WHERE id = ?', [`/uploads/${C.id}/logo.png`, C.id]);
    const m1 = await js('/api/tables', { token: C.token, body: { code: 'G1', name: 'Masa G1' } });
    const plakaGovde = { tableIds: [m1.d && m1.d.id], aliciAd: 'Test Alici', telefon: '05320000000', adres: 'Test Mahallesi Deneme Sokak No 1' };
    await query('UPDATE tenants SET plaka_hediye_hakki = 0 WHERE id = ?', [C.id]);
    ok('ucretli plaka talebi 403 (hediye hakki yok)', beyanYasak(await js('/api/plaka/talepler', { token: DC, body: plakaGovde })));
    ok('... talep acilmadi', (await query('SELECT COUNT(*) AS n FROM plaka_talepleri WHERE tenant_id = ?', [C.id])).rows[0].n === 0);
    await query('UPDATE tenants SET plaka_hediye_hakki = 1 WHERE id = ?', [C.id]);
    const hediye = await js('/api/plaka/talepler', { token: DC, body: plakaGovde });
    ok('yalniz hediye plakalik talep destekte serbest (201)', hediye.status === 201, hediye);

    console.log('\n=== O5) QR acik uclari lisans durumuna bakar ===');
    async function qrKur(ad, bitis) {
        const k = await kiraciKur({ ad, bitis });
        const masa = uuid(), tok = crypto.randomBytes(16).toString('hex');
        await query('INSERT INTO tables (id, tenant_id, code, name, qr_token) VALUES (?, ?, ?, ?, ?)', [masa, k.id, 'Q1', 'Masa Q1', tok]);
        await query('INSERT INTO categories (id, tenant_id, name, sort_order) VALUES (?, ?, ?, 1)', [masa + '-k', k.id, 'Icecek']);
        await query('INSERT INTO products (id, tenant_id, category_id, name, price, is_available) VALUES (?, ?, ?, ?, 25, 1)', [masa + '-u', k.id, masa + '-k', 'Cay']);
        const taban = `/api/public/m/${k.slug}/${tok}`;
        return { ...k, taban, urun: masa + '-u' };
    }
    const qrIstekleri = async (q) => ({
        menu: await js(q.taban + '/menu'),
        siparis: await js(q.taban + '/orders', { body: { items: [{ productId: q.urun, qty: 1 }] } }),
        garson: await js(q.taban + '/waiter', { body: { reason: 'GENERIC' } }),
        hesap: await js(q.taban + '/bill'),
    });
    const qa = await qrIstekleri(await qrKur('QR Aktif'));
    ok('AKTIF: menu 200, uc ozellik acik', qa.menu.status === 200 && qa.menu.d.ozellikler.siparis && qa.menu.d.ozellikler.garson && qa.menu.d.ozellikler.hesap, qa.menu.d && qa.menu.d.ozellikler);
    ok('AKTIF: siparis 201, garson cagrisi ve hesap acik', qa.siparis.status === 201 && qa.garson.status < 300 && qa.hesap.status === 200, [qa.siparis.status, qa.garson.status, qa.hesap.status]);
    const qk = await qrIstekleri(await qrKur('QR Kapali', new Date(Date.now() - 10 * GUN).toISOString()));
    ok('KAPALI: menu gorunur (200), ozellikler kapali (dugmeler gizlenir)', qk.menu.status === 200 && qk.menu.d.products.length === 1
        && !qk.menu.d.ozellikler.siparis && !qk.menu.d.ozellikler.garson && !qk.menu.d.ozellikler.hesap, qk.menu.d && qk.menu.d.ozellikler);
    ok('KAPALI: siparis 403 QR_SIPARIS_KAPALI + personele basvurun', qk.siparis.status === 403 && qk.siparis.d.code === 'QR_SIPARIS_KAPALI' && /personele başvurun/.test(qk.siparis.d.message), qk.siparis);
    ok('KAPALI: garson cagrisi 403', qk.garson.status === 403 && qk.garson.d.code === 'QR_GARSON_KAPALI', qk.garson);
    ok('KAPALI: hesap 403', qk.hesap.status === 403 && qk.hesap.d.code === 'QR_HESAP_KAPALI', qk.hesap);
    const qs = await qrIstekleri(await qrKur('QR Salt', new Date(Date.now() - GUN).toISOString()));
    ok('SALT_OKUNUR: menu 200, siparis kapali, garson ve hesap acik', qs.menu.status === 200 && !qs.menu.d.ozellikler.siparis
        && qs.menu.d.ozellikler.garson && qs.menu.d.ozellikler.hesap, qs.menu.d && qs.menu.d.ozellikler);
    ok('SALT_OKUNUR: siparis 403 (kasa hesabi kapatamaz)', qs.siparis.status === 403 && qs.siparis.d.code === 'QR_SIPARIS_KAPALI', qs.siparis);
    ok('SALT_OKUNUR: garson cagrisi ve hesap acik', qs.garson.status < 300 && qs.hesap.status === 200, [qs.garson, qs.hesap.status]);

    console.log('\n=== D2) Gecis: tek "ALL" metni dizi olur ===');
    const all1 = await kiraciKur({ ad: 'ALL Metin' }), all2 = await kiraciKur({ ad: 'ALL Duz' }), all3 = await kiraciKur({ ad: 'ALL Dizi' });
    await query('UPDATE tenants SET license_modules = ? WHERE id = ?', ['"ALL"', all1.id]);
    await query('UPDATE tenants SET license_modules = ? WHERE id = ?', ['ALL', all2.id]);
    await query('UPDATE tenants SET license_modules = ? WHERE id = ?', ['["ALL"]', all3.id]);
    await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [GECIS_ISARETI]);
    ok('gecis calisti', (await modulGecisi()) === true);
    const lm = async (id) => (await query('SELECT license_modules FROM tenants WHERE id = ?', [id])).rows[0].license_modules;
    ok('\'"ALL"\' -> ["ALL"] (BASE\'e dusmedi)', (await lm(all1.id)) === '["ALL"]', await lm(all1.id));
    ok('duz ALL -> ["ALL"]', (await lm(all2.id)) === '["ALL"]', await lm(all2.id));
    ok('["ALL"] dokunulmadi', (await lm(all3.id)) === '["ALL"]', await lm(all3.id));

    // --- SONRAKI BOLUMLER ---

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU', e); try { await temizle(); } catch (_) {} process.exit(1); });
