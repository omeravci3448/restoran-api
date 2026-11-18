// Moduler lisans + QR menu ozellik anahtarlari + kisa karekod.
// Kapsam: gecis (gecis oncesi bicimdeki kiraci QR'dan siparis verebilir; bir kez calisir), katalog (QR_SIPARIS
// gizli, BASE "Adisyon ve Kasa"), anahtarlar ve public 403'ler (modul VE anahtar), /menu bayraklari, menu kipi
// (BASE yok: POS uclari 403, menu/masa/ayar/plaka acik), garson yalniz cagri kipi (GARSON, BASE yok), giris
// kapilari, bagimliliklar ve fiyat (BASE = kademe fiyati, ucretsiz modul kendiliginden eklenmez), root onayi ve
// duzenleme, deneme her zaman tam (QR_SIPARIS dahil), SofraMix provizyonu, kisa kod cozumu, TAM regresyon.
// Sunucuyu KENDI baslatir.  Calistir: node test_qr_menu_paket.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb, modulGecisi, GECIS_ISARETI, MODUL_GECISI_SQL } = require('./src/config/db');
const QRCode = require('qrcode');

const PORT = 46121, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'qr-menu-modul-test-jwt';
const ON = 'QRPK Test';           // test isletmelerinin ad oneki (temizlik buna gore)
const EPOSTA_ON = 'qrpk-';
const TUM = ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON', 'STOK'];
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

const GELECEK = new Date(Date.now() + 120 * 86400000).toISOString();
async function kiraciKur({ ad, moduller = TUM, tier = 'TIER_6_10', limit = null, hamModul }) {
    const id = uuid();
    const slug = 'qrpk-' + crypto.randomBytes(4).toString('hex');
    const kod = String(70000 + Math.floor(Math.random() * 29999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, license_table_limit, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, '05320000000', 'Test Mah. 1', tier,
            hamModul !== undefined ? hamModul : JSON.stringify(moduller), GELECEK, limit]);
    // Fatura bilgisi satin almada zorunlu (2026-11-18)
    await query("UPDATE tenants SET billing_name = business_name, billing_tax_id = '1234567890', billing_tax_office = 'Test VD', billing_address = 'Test Mah. 1, Afyon' WHERE id = ?", [id]);
    const kul = {};
    for (const [rol, sifre] of [['OWNER', 'sahip1234'], ['CASHIER', 'kasa1234'], ['WAITER', 'garson1234'], ['KITCHEN', 'mutfak1234']]) {
        const uid = uuid();
        const eposta = `${EPOSTA_ON}${rol.toLowerCase()}-${slug}@ornek.test`;
        await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uid, id, eposta, await bcrypt.hash(sifre, 4), rol, rol, new Date().toISOString()]);
        kul[rol] = { id: uid, eposta, sifre };
    }
    return { id, slug, kod, kul };
}
const giris = (k, rol) => js('/api/auth/login', { body: { email: k.kul[rol].eposta, businessCode: k.kod, password: k.kul[rol].sifre } });
const modulleri = async (id) => JSON.parse((await query('SELECT license_modules m FROM tenants WHERE id = ?', [id])).rows[0].m || '[]');
async function masaVeUrun(token, kod) {
    const m = (await js('/api/tables', { token, body: { code: kod, name: 'Masa ' + kod, section: 'Salon' } })).d;
    const kat = (await js('/api/categories', { token, body: { name: 'Çorbalar ' + kod } })).d;
    const u = (await js('/api/products', { token, body: { name: 'Mercimek ' + kod, price: 90, categoryId: kat.id, isAvailable: true } })).d;
    return { masa: m, urun: u };
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
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['payments', 'orders', 'waiter_calls', 'qr_bekleyen_siparisler', 'plaka_talepleri', 'lisans_odemeleri', 'pos_provizyon',
            'marketplace_credentials', 'marketplace_store_links', 'marketplace_channels',
            'root_olaylar', 'tables', 'products', 'categories', 'license_cache', 'islem_gunlugu', 'aktivasyon_jetonlari',
            'deneme_kayitlari', 'deneme_giris_jetonlari', 'push_abonelikleri', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('  temizlik', tb, e.message));
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM pending_registrations WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    await query(`DELETE FROM demo_talepleri WHERE eposta LIKE '${EPOSTA_ON}%'`).catch(() => {});
    await query(`DELETE FROM deneme_kayitlari WHERE isletme_adi LIKE '${ON}%'`).catch(() => {});
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    if (katalogYedek) for (const x of katalogYedek) await query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [x.fiyat, x.gorunur, x.id]);
}
const fiyatYaz = (id, fiyat, gorunur = 1) => query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [fiyat, gorunur, id]);

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    katalogYedek = (await query('SELECT id, fiyat, gorunur FROM lisans_katalog')).rows;
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development',
               SMTP_HOST: '', QR_PUBLIC_BASE: 'https://restoran.mdayazilim.com' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();

    console.log('=== 0) Sema ve katalog ===');
    const kol = (await query('PRAGMA table_info(tenants)')).rows.map((x) => x.name);
    ok('tenants: 3 QR anahtari + plaka_hediye_hakki, paket_turu YOK', ['qr_siparis_acik', 'qr_garson_acik', 'qr_hesap_acik', 'plaka_hediye_hakki'].every((k) => kol.includes(k)) && !kol.includes('paket_turu'), kol);
    ok('tables.kisa_kod kolonu var', (await query('PRAGMA table_info(tables)')).rows.some((x) => x.name === 'kisa_kod'));
    const kq = (await query("SELECT * FROM lisans_katalog WHERE id = 'MODUL-QR_SIPARIS'")).rows[0];
    ok('katalog: QR_SIPARIS "Masadan Sipariş", fiyat 0, GIZLI', kq && kq.ad === 'Masadan Sipariş' && Number(kq.fiyat) === 0 && kq.gorunur === 0, kq);
    ok('katalog: BASE adi "Adisyon ve Kasa"', (await query("SELECT ad FROM lisans_katalog WHERE id = 'MODUL-BASE'")).rows[0].ad === 'Adisyon ve Kasa');
    ok('katalogda QR_MENU paketi YOK', !(await query("SELECT 1 FROM lisans_katalog WHERE kod = 'QR_MENU'")).rows.length);
    ok('gecis isareti konmus', (await query('SELECT 1 FROM sistem_ayarlari WHERE anahtar = ?', [GECIS_ISARETI])).rows.length === 1);

    console.log('\n=== 1) GECIS: gecis oncesi bicimdeki kiracilar ===');
    const eskiTam = await kiraciKur({ ad: 'Eski Tam', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON'] });
    const eskiMenu = await kiraciKur({ ad: 'Eski Hub', moduller: ['MENU_DIGITAL', 'GARSON'] });
    const eskiBos = await kiraciKur({ ad: 'Eski Boş', hamModul: null });
    const eskiBozuk = await kiraciKur({ ad: 'Eski Bozuk', hamModul: 'bozuk{' });
    const eskiAll = await kiraciKur({ ad: 'Eski ALL', moduller: ['ALL'] });
    const eskiGarsonsuz = await kiraciKur({ ad: 'Eski Garsonsuz', moduller: ['BASE', 'MENU_DIGITAL'] });
    const eskiYalnizMenu = await kiraciKur({ ad: 'Eski Yalnız Menü', moduller: ['MENU_DIGITAL'] });
    await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [GECIS_ISARETI]);
    // D8: bir adim hata verirse hicbir adim yazilmaz, isaret konmaz
    MODUL_GECISI_SQL.splice(MODUL_GECISI_SQL.length - 1, 0, 'UPDATE yok_boyle_tablo SET x = 1');
    let gecisHatasi = null;
    try { await modulGecisi(); } catch (e) { gecisHatasi = e; }
    MODUL_GECISI_SQL.splice(MODUL_GECISI_SQL.length - 2, 1);
    ok('D8: adim hatasinda gecis geri alinir (moduller degismez, isaret yok)', !!gecisHatasi && JSON.stringify(await modulleri(eskiGarsonsuz.id)) === '["BASE","MENU_DIGITAL"]'
        && (await query('SELECT 1 FROM sistem_ayarlari WHERE anahtar = ?', [GECIS_ISARETI])).rows.length === 0, gecisHatasi && gecisHatasi.message);
    ok('gecis calisti (isaret yoktu)', (await modulGecisi()) === true);
    ok('Y1: MENU_DIGITAL olup GARSON olmayana GARSON eklendi (garson cagir kapanmaz)', JSON.stringify(await modulleri(eskiGarsonsuz.id)) === '["BASE","MENU_DIGITAL","QR_SIPARIS","GARSON"]',
        await modulleri(eskiGarsonsuz.id));
    ok('Y1: yalniz QR Menu eski kiraci -> BASE + QR_SIPARIS + GARSON', JSON.stringify(await modulleri(eskiYalnizMenu.id)) === '["MENU_DIGITAL","BASE","QR_SIPARIS","GARSON"]',
        await modulleri(eskiYalnizMenu.id));
    ok('BASE + MENU_DIGITAL -> QR_SIPARIS eklendi', JSON.stringify(await modulleri(eskiTam.id)) === '["BASE","MENU_DIGITAL","GARSON","QR_SIPARIS"]', await modulleri(eskiTam.id));
    ok('BASE olmayan eski kiraci -> BASE + QR_SIPARIS (POS ve QR siparis bugunku gibi acik)', JSON.stringify(await modulleri(eskiMenu.id)) === '["MENU_DIGITAL","GARSON","BASE","QR_SIPARIS"]', await modulleri(eskiMenu.id));
    ok('modul listesi bos -> ["BASE"]', JSON.stringify(await modulleri(eskiBos.id)) === '["BASE"]');
    ok('bozuk liste -> ["BASE"]', JSON.stringify(await modulleri(eskiBozuk.id)) === '["BASE"]');
    ok('ALL dokunulmadi', JSON.stringify(await modulleri(eskiAll.id)) === '["ALL"]');
    const sonra = await kiraciKur({ ad: 'Gecis Sonrasi', moduller: ['MENU_DIGITAL'] });
    ok('ikinci calisma hicbir sey yapmaz (false)', (await modulGecisi()) === false);
    ok('isaretten sonra acilan "yalniz QR menu" kiraciya dokunulmaz', JSON.stringify(await modulleri(sonra.id)) === '["MENU_DIGITAL"]');
    const eS = (await giris(eskiTam, 'OWNER')).d.token;
    const e1 = await masaVeUrun(eS, 'E1');
    const eTok = (await query('SELECT qr_token FROM tables WHERE id = ?', [e1.masa.id])).rows[0].qr_token;
    const eSip = await js(`/api/public/m/${eskiTam.slug}/${eTok}/orders`, { body: { items: [{ productId: e1.urun.id, qty: 1 }] } });
    ok('gecis oncesi bicimdeki kiraci gecisten sonra QR\'dan siparis verir (201)', eSip.status === 201 && eSip.d.addedItems === 1, eSip);
    ok('... POS uclari acik (siparis listesi 200)', (await js('/api/orders', { token: eS })).status === 200);

    console.log('\n=== 2) QR menu anahtarlari (tam isletme) ===');
    const tam = await kiraciKur({ ad: 'Tam Lokanta' });
    const tamS = (await giris(tam, 'OWNER')).d.token, tamK = (await giris(tam, 'CASHIER')).d.token;
    const p0 = (await js('/api/tenant/me', { token: tamS })).d;
    ok('varsayilan: uc anahtar acik, fiili ozellikler acik, modulleri var', p0.qr_siparis_acik === 1 && p0.qr_garson_acik === 1 && p0.qr_hesap_acik === 1
        && p0.qr_ozellikleri.siparis && p0.qr_modulleri.siparis && p0.qr_modulleri.garson && p0.menu_kipi === false, p0);
    const { masa: m1, urun } = await masaVeUrun(tamS, 'T1');
    ok('yeni masaya 8 haneli kisa kod verildi', /^[ACDEFHJKMNPQRTUVWXY34679]{8}$/.test(m1.kisaKod || ''), m1);
    const tok1 = (await query('SELECT qr_token FROM tables WHERE id = ?', [m1.id])).rows[0].qr_token;
    const pub = (k, tok, yol, body) => js(`/api/public/m/${k.slug}/${tok}${yol}`, body ? { body } : {});
    const mn = await pub(tam, tok1, '/menu');
    ok('/menu bayraklari: siparis/garson/hesap acik', mn.status === 200 && mn.d.ozellikler.siparis && mn.d.ozellikler.garson && mn.d.ozellikler.hesap, mn.d && mn.d.ozellikler);
    ok('TAM regresyon: QR siparisi 201', (await pub(tam, tok1, '/orders', { items: [{ productId: urun.id, qty: 1 }] })).status === 201);
    ok('TAM regresyon: hesap 200', (await pub(tam, tok1, '/bill')).status === 200);
    ok('TAM regresyon: garson cagir 201', (await pub(tam, tok1, '/waiter', { reason: 'GENERIC' })).status === 201);
    ok('kasiyer anahtari degistiremez (403)', (await js('/api/tenant/me', { token: tamK, method: 'PUT', body: { qrSiparisAcik: false } })).status === 403);
    await js('/api/tenant/me', { token: tamS, method: 'PUT', body: { qrSiparisAcik: false } });
    const sp2 = await pub(tam, tok1, '/orders', { items: [{ productId: urun.id, qty: 1 }] });
    ok('siparis anahtari kapali: POST orders 403 QR_SIPARIS_KAPALI', sp2.status === 403 && sp2.d.code === 'QR_SIPARIS_KAPALI', sp2);
    ok('/menu: siparis false, garson + hesap true', ((d) => !d.siparis && d.garson && d.hesap)((await pub(tam, tok1, '/menu')).d.ozellikler));
    await query("UPDATE waiter_calls SET status = 'HANDLED' WHERE tenant_id = ?", [tam.id]);
    await js('/api/tenant/me', { token: tamS, method: 'PUT', body: { qrGarsonAcik: false, qrHesapAcik: false } });
    ok('garson anahtari kapali: 403 QR_GARSON_KAPALI', (await pub(tam, tok1, '/waiter', {})).d.code === 'QR_GARSON_KAPALI');
    ok('hesap anahtari kapali: 403 QR_HESAP_KAPALI', (await pub(tam, tok1, '/bill')).d.code === 'QR_HESAP_KAPALI');
    await js('/api/tenant/me', { token: tamS, method: 'PUT', body: { qrSiparisAcik: true, qrGarsonAcik: true, qrHesapAcik: true } });
    ok('hepsi acilinca siparis 201', (await pub(tam, tok1, '/orders', { items: [{ productId: urun.id, qty: 1 }] })).status === 201);
    ok('me.menuKipi false (tam)', (await js('/api/auth/me', { token: tamS })).d.menuKipi === false);

    console.log('\n=== 3) Modul matrisi (QR menu ozellikleri) ===');
    const yalnizMenu = await kiraciKur({ ad: 'Yalnız Menü', moduller: ['MENU_DIGITAL'] });
    const menuGarson = await kiraciKur({ ad: 'Menü Garson', moduller: ['MENU_DIGITAL', 'GARSON'] });
    const siparissiz = await kiraciKur({ ad: 'Siparişsiz', moduller: ['BASE', 'MENU_DIGITAL'] });
    const ymS = (await giris(yalnizMenu, 'OWNER')).d.token, mgS = (await giris(menuGarson, 'OWNER')).d.token, ssS = (await giris(siparissiz, 'OWNER')).d.token;
    const ym = await masaVeUrun(ymS, 'Y1'), mg = await masaVeUrun(mgS, 'G1'), ss = await masaVeUrun(ssS, 'S1');
    const tokOf = async (id) => (await query('SELECT qr_token FROM tables WHERE id = ?', [id])).rows[0].qr_token;
    const ymT = await tokOf(ym.masa.id), mgT = await tokOf(mg.masa.id), ssT = await tokOf(ss.masa.id);
    const oz = async (k, t) => (await pub(k, t, '/menu')).d.ozellikler;
    ok('yalniz QR Menu: menu 200, hicbir ozellik yok', ((d) => d && !d.siparis && !d.garson && !d.hesap)(await oz(yalnizMenu, ymT)));
    ok('... siparis 403 QR_SIPARIS_KAPALI', (await pub(yalnizMenu, ymT, '/orders', { items: [{ productId: ym.urun.id, qty: 1 }] })).d.code === 'QR_SIPARIS_KAPALI');
    ok('... garson 403, hesap 403', (await pub(yalnizMenu, ymT, '/waiter', {})).status === 403 && (await pub(yalnizMenu, ymT, '/bill')).status === 403);
    ok('QR Menu + Garson: yalniz garson cagir acik', ((d) => !d.siparis && d.garson && !d.hesap)(await oz(menuGarson, mgT)));
    ok('... garson cagrisi 201', (await pub(menuGarson, mgT, '/waiter', { reason: 'GENERIC' })).status === 201);
    ok('BASE + MENU (QR_SIPARIS yok): siparis yok, hesap var, garson yok', ((d) => !d.siparis && !d.garson && d.hesap)(await oz(siparissiz, ssT)));
    ok('... siparis 403, hesap 200', (await pub(siparissiz, ssT, '/orders', { items: [{ productId: ss.urun.id, qty: 1 }] })).status === 403 && (await pub(siparissiz, ssT, '/bill')).status === 200);
    const pm = (await js('/api/tenant/me', { token: ymS })).d;
    ok('profil: modulu olmayan anahtar "paketinizde yok" (qr_modulleri false) + menu_kipi', !pm.qr_modulleri.siparis && !pm.qr_modulleri.garson && !pm.qr_modulleri.hesap && pm.menu_kipi === true, pm.qr_modulleri);
    ok('modulu olmasa da anahtar tercihi kaydedilir (200)', (await js('/api/tenant/me', { token: ymS, method: 'PUT', body: { qrGarsonAcik: false } })).status === 200);

    console.log('\n=== 4) Menu kipi (BASE yok): POS uclari 403, menu/masa/ayar acik ===');
    ok('me.menuKipi true', (await js('/api/auth/me', { token: ymS })).d.menuKipi === true);
    const kapali = [['GET', '/api/orders'], ['POST', '/api/orders'], ['GET', '/api/orders/pending-qr'], ['GET', '/api/paket'], ['GET', '/api/reports/day'],
        ['GET', '/api/mutfak/kuyruk'], ['GET', '/api/marketplace/channels'], ['POST', '/api/payments'], ['GET', '/api/stock/current'], ['GET', '/api/suppliers']];
    for (const [m, yol] of kapali) {
        const r = await js(yol, { token: ymS, method: m, body: m === 'POST' ? {} : undefined });
        ok(`menu kipi: ${m} ${yol} -> 403 MODULE_NOT_LICENSED (Adisyon ve Kasa)`, r.status === 403 && r.d.code === 'MODULE_NOT_LICENSED' && /Adisyon ve Kasa/.test(r.d.message), r);
    }
    ok('menu kipi: garson cagrilari 403 (GARSON yok)', (await js('/api/waiter/calls', { token: ymS })).status === 403);
    ok('menu kipi: telefon bildirimi 403 (BASE ya da GARSON yok)', (await js('/api/push/durum', { token: ymS })).status === 403);
    ok('menu kipi: canli olay akisi 403', (await fetch(TABAN + '/api/realtime/stream?token=' + encodeURIComponent(ymS))).status === 403);
    const acik = [['GET', '/api/tables'], ['GET', '/api/tables/limit-info'], ['GET', '/api/categories'], ['GET', '/api/products'], ['GET', '/api/tenant/me'],
        ['GET', '/api/license/purchases'], ['GET', '/api/license/yenileme-kanali'], ['GET', '/api/plaka/durum'], ['GET', '/api/auth/staff'],
        ['GET', '/api/magaza/durum'], ['GET', '/api/magaza/siparisler']];   // magaza her pakette (menu kipi dahil)
    for (const [m, yol] of acik) ok(`menu kipi: ${m} ${yol} acik (200)`, (await js(yol, { token: ymS, method: m })).status === 200);
    ok('menu kipi: toplu masa ekle 201', (await js('/api/tables/bulk', { token: ymS, body: { count: 2, prefix: 'B', section: 'Bahçe' } })).status === 201);
    ok('menu kipi: masa duzenle 200', (await js('/api/tables/' + ym.masa.id, { token: ymS, method: 'PUT', body: { name: 'Pencere Önü' } })).status === 200);
    const pdf = await fetch(TABAN + '/api/tables/karekodlar.pdf', { headers: { Authorization: 'Bearer ' + ymS } });
    ok('menu kipi: tum karekodlar PDF (200, %PDF)', pdf.status === 200 && Buffer.from(await pdf.arrayBuffer()).slice(0, 5).toString() === '%PDF-');
    ok('menu kipi: QR Indir png 200', (await fetch(TABAN + '/api/tables/' + ym.masa.id + '/qr.png', { headers: { Authorization: 'Bearer ' + ymS } })).status === 200);
    ok('menu kipi: menude urun gorunur', ((await pub(yalnizMenu, ymT, '/menu')).d.products || []).some((p) => /Mercimek/.test(p.name)));
    const gYm = await giris(yalnizMenu, 'WAITER');
    ok('menu kipi: garson girisi 403 (anlamli mesaj)', gYm.status === 403 && gYm.d.code === 'MODULE_NOT_LICENSED' && /Garson uygulaması/.test(gYm.d.message), gYm);
    ok('menu kipi: mutfak girisi 403', (await giris(yalnizMenu, 'KITCHEN')).status === 403);
    ok('menu kipi: sahip girisi 200', (await giris(yalnizMenu, 'OWNER')).status === 200);

    console.log('\n=== 5) Garson, BASE yok: yalniz cagri kipi ===');
    const gw = await giris(menuGarson, 'WAITER');
    ok('garson girisi 200 (GARSON var)', gw.status === 200, gw);
    const gT = gw.d.token;
    const cg = await js('/api/waiter/calls', { token: gT });
    ok('garson cagrilari listesi 200 (cagri goruluyor)', cg.status === 200 && cg.d.length >= 1, cg);
    ok('cagriyi isle 200', (await js(`/api/waiter/calls/${cg.d[0].id}/handle`, { token: gT, method: 'POST' })).status === 200);
    ok('siparis ucu 403 (adisyon yok)', (await js('/api/orders', { token: gT })).status === 403);
    ok('telefon bildirimi durumu 200 (GARSON)', (await js('/api/push/durum', { token: gT })).status === 200);
    const ac = new AbortController();
    const rs = await fetch(TABAN + '/api/realtime/stream?token=' + encodeURIComponent(gT), { signal: ac.signal });
    ok('canli olay akisi acik (GARSON)', rs.status === 200, rs.status); ac.abort();
    ok('mutfak girisi 403 (BASE yok)', (await giris(menuGarson, 'KITCHEN')).status === 403);
    ok('TAM: garson ve mutfak girisi 200 (degismedi)', (await giris(tam, 'WAITER')).status === 200 && (await giris(tam, 'KITCHEN')).status === 200);

    console.log('\n=== 6) Bagimliliklar ve fiyat ===');
    await fiyatYaz('TIER-TIER_6_10', 4000); await fiyatYaz('MODUL-BASE', 99999); await fiyatYaz('MODUL-MENU_DIGITAL', 1000);
    await fiyatYaz('MODUL-GARSON', 500); await fiyatYaz('MODUL-QR_SIPARIS', 300, 1); await fiyatYaz('MODUL-STOK', 0);
    const q = (modules) => js('/api/license/quote', { body: { tier: 'TIER_6_10', modules } });
    const q1 = (await q(['QR_SIPARIS'])).d;
    ok('Masadan Siparis secilince QR Menu + Adisyon ve Kasa kendiliginden eklenir', ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS'].every((m) => q1.modules.includes(m))
        && q1.eklenenBagimliliklar.includes('BASE') && q1.eklenenBagimliliklar.includes('MENU_DIGITAL'), q1);
    ok('tutar: BASE = kademe fiyati (4000, katalogdaki BASE fiyati yok sayilir) + 1000 + 300 = 5300', q1.total === 5300 && q1.tableLimit === 10, q1.total);
    const q2 = (await q(['MENU_DIGITAL'])).d;
    ok('yalniz QR Menu: kademe fiyati alinmaz (1000), masa siniri yine kademeden (10)', q2.total === 1000 && q2.tableLimit === 10 && JSON.stringify(q2.modules) === '["MENU_DIGITAL"]', q2);
    const q3 = (await q(['GARSON'])).d;
    ok('Garson tek basina: QR Menu eklenir (1000 + 500)', q3.total === 1500 && q3.modules.includes('MENU_DIGITAL') && !q3.modules.includes('BASE'), q3);
    const q4 = (await q(['BASE', 'GARSON'])).d;
    ok('Garson + Adisyon ve Kasa: QR Menu eklenmez (4000 + 500)', q4.total === 4500 && !q4.modules.includes('MENU_DIGITAL'), q4);
    const q5 = (await q(['BASE'])).d;
    ok('ucretsiz modul (STOK 0 TL) kendiliginden EKLENMEZ', JSON.stringify(q5.modules) === '["BASE"]' && q5.total === 4000, q5.modules);
    const q6 = (await q(['STOK'])).d;
    ok('Stok secilince Adisyon ve Kasa eklenir', q6.modules.includes('BASE'), q6.modules);
    const q7 = await q([]);
    ok('modul secilmeden 400 MODUL_SECILMEDI', q7.status === 400 && q7.d.code === 'MODUL_SECILMEDI', q7);
    await fiyatYaz('MODUL-QR_SIPARIS', 300, 0);
    ok('gizli modul (Masadan Siparis) satin alinamaz 400', (await q(['QR_SIPARIS'])).status === 400);
    await fiyatYaz('MODUL-QR_SIPARIS', 300, 1);

    console.log('\n=== 7) Satin alma + root onayi (yalniz QR menu -> adisyon) ===');
    const al = await js('/api/license/purchase', { token: ymS, body: { tier: 'TIER_6_10', modules: ['QR_SIPARIS', 'GARSON'] } });
    ok('satin alma 201: moduller bagimliliklarla, tutar 5800', al.status === 201 && al.d.total === 5800 && ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON'].every((m) => al.d.modules.includes(m)), al.d);
    ok('onaydan once lisans degismez (menu kipi, POS 403)', JSON.stringify(await modulleri(yalnizMenu.id)) === '["MENU_DIGITAL"]' && (await js('/api/orders', { token: ymS })).status === 403);
    const on1 = await js(`/api/root/lisans-odemeleri/${al.d.id}/onayla`, { token: rj, body: { gun: 365 } });
    const ty = (await query('SELECT * FROM tenants WHERE id = ?', [yalnizMenu.id])).rows[0];
    ok('root onayi: moduller + kademe + masa siniri (10) yazildi', on1.status === 200 && ty.license_tier === 'TIER_6_10' && Number(ty.license_table_limit) === 10
        && ['BASE', 'QR_SIPARIS'].every((m) => JSON.parse(ty.license_modules).includes(m)), ty);
    ok('onay_gun kaydedildi (365)', Number((await query('SELECT onay_gun FROM lisans_odemeleri WHERE id = ?', [al.d.id])).rows[0].onay_gun) === 365);
    await js('/api/tenant/me', { token: ymS, method: 'PUT', body: { qrGarsonAcik: true } });
    ok('onay sonrasi ayni karekod: siparis + garson + hesap acik', ((d) => d.siparis && d.garson && d.hesap)(await oz(yalnizMenu, ymT)));
    ok('onay sonrasi POS uclari acik + siparis 201', (await js('/api/orders', { token: ymS })).status === 200
        && (await pub(yalnizMenu, ymT, '/orders', { items: [{ productId: ym.urun.id, qty: 1 }] })).status === 201);

    console.log('\n=== 8) Root duzenle / yeni isletme ===');
    const ed = await js('/api/root/tenants/' + siparissiz.id, { token: rj, method: 'PATCH', body: { modules: ['QR_SIPARIS'] } });
    ok('root modul duzenle: bagimliliklar eklenir', ed.status === 200 && ['QR_SIPARIS', 'MENU_DIGITAL', 'BASE'].every((m) => ed.d.modules.includes(m)), ed.d);
    ok('olmayan isletme 404', (await js('/api/root/tenants/yok-boyle', { token: rj, method: 'PATCH', body: { businessName: 'x' } })).status === 404);
    const yeniI = await js('/api/root/tenants', { token: rj, body: { businessName: `${ON} Root Açtı`, ownerEmail: `${EPOSTA_ON}rootacti@ornek.test`, ownerPassword: 'sahip1234' } });
    ok('root yeni isletme: varsayilan modullerde QR_SIPARIS var', yeniI.status === 201 && (await modulleri(yeniI.d.id)).includes('QR_SIPARIS'), yeniI);
    const lt = (await js('/api/root/tenants', { token: rj })).d;
    ok('root listesi: menu_kipi turetilir', lt.some((x) => x.id === menuGarson.id && x.menu_kipi === true) && lt.some((x) => x.id === tam.id && x.menu_kipi === false));
    ok('kiraci jetonu root ucuna giremez (403)', (await js('/api/root/tenants/' + tam.id, { token: tamS, method: 'PATCH', body: {} })).status === 403);

    console.log('\n=== 9) Deneme her zaman tam (QR_SIPARIS dahil) ===');
    const d1 = await js('/api/public/deneme', { body: { isletme: `${ON} Deneme`, adSoyad: 'Deneme Kişi', telefon: '0532 400 00 02', eposta: `${EPOSTA_ON}d1@ornek.test`, paketTuru: 'QR_MENU' },
        headers: { 'X-Forwarded-For': '10.9.0.2' } });
    const dt = (await query('SELECT * FROM tenants WHERE owner_email = ?', [`${EPOSTA_ON}d1@ornek.test`])).rows[0];
    ok('tanitim denemesi: butun moduller (QR_SIPARIS dahil), program secimi yok sayilir', d1.status === 201 && dt && ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON'].every((m) => JSON.parse(dt.license_modules).includes(m)), dt && dt.license_modules);
    const kf = await js('/api/auth/register/request', { body: { businessName: `${ON} Kayıt`, email: `${EPOSTA_ON}kayit@ornek.test`, password: 'kayit1234', kvkkConsent: true, tier: 'TIER_6_10', modules: ['BASE'] } });
    const kv = await js('/api/auth/register/verify', { body: { pendingId: kf.d.pendingId, otp: kf.d.devOtp } });
    const kt = (await query('SELECT license_modules FROM tenants WHERE owner_email = ?', [`${EPOSTA_ON}kayit@ornek.test`])).rows[0];
    ok('kayit formu denemesi: QR_SIPARIS dahil butun moduller', kv.status === 201 && ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON', 'STOK'].every((m) => JSON.parse(kt.license_modules).includes(m)), kt);
    const smx = await kiraciKur({ ad: 'SMX', moduller: ['BASE', 'MENU_DIGITAL'] });
    const smxEposta = (await query('SELECT owner_email FROM tenants WHERE id = ?', [smx.id])).rows[0].owner_email;
    const odemeId = 'qrpk-odeme-' + crypto.randomBytes(4).toString('hex');
    const s = await require('./src/services/posProvizyon').odemeIsle({ odeme_id: odemeId, business_id: null, isletme_adi: `${ON} SMX`,
        yetkili_email: smxEposta, yetkili_tel: '05320000999', tutar_kurus: 1200000, kdv_kurus: 200000, yontem: 'kart', onay_tarihi: new Date().toISOString() });
    ok('SofraMix provizyonu var olan kiraciya QR_SIPARIS ekler', s.durum === 'islendi' && (await modulleri(smx.id)).includes('QR_SIPARIS'), s.durum);
    await query('DELETE FROM pos_provizyon WHERE odeme_id = ?', [odemeId]);

    console.log('\n=== 10) Kisa karekod ===');
    const km = (await query('SELECT kisa_kod, qr_token FROM tables WHERE id = ?', [m1.id])).rows[0];
    const c1 = await js('/api/public/q/' + km.kisa_kod);
    ok('kisa kod cozulur: slug + token', c1.status === 200 && c1.d.slug === tam.slug && c1.d.token === km.qr_token, c1);
    ok('kucuk harfle de cozulur', (await js('/api/public/q/' + km.kisa_kod.toLowerCase())).d.token === km.qr_token);
    const yeni = await js('/api/tables/' + m1.id + '/regenerate-qr', { token: tamS, method: 'POST' });
    const c2 = await js('/api/public/q/' + km.kisa_kod);
    ok('qr_token yenilendi: kisa kod ayni, yeni tokena cozulur', yeni.status === 200 && c2.d.token === yeni.d.qrToken
        && (await query('SELECT kisa_kod FROM tables WHERE id = ?', [m1.id])).rows[0].kisa_kod === km.kisa_kod, c2.d);
    ok('eski /m/<slug>/<token> adresi (yeni token) calisir', (await js(`/api/public/m/${tam.slug}/${yeni.d.qrToken}/menu`)).status === 200);
    ok('gecersiz bicim 404', (await js('/api/public/q/ABC')).status === 404 && (await js('/api/public/q/OOOOOO')).status === 404);
    await query("UPDATE orders SET status = 'CLOSED' WHERE table_id = ?", [m1.id]);
    await js('/api/tables/' + m1.id, { token: tamS, method: 'DELETE' });
    const c3 = await js('/api/public/q/' + km.kisa_kod);
    ok('pasif (silinmis) masada 404 KISA_KOD_PASIF (masa kullanilmiyor)', c3.status === 404 && c3.d.code === 'KISA_KOD_PASIF', c3);
    const kodlar = (await query('SELECT kisa_kod FROM tables WHERE tenant_id IN (?, ?, ?)', [tam.id, yalnizMenu.id, menuGarson.id])).rows.map((x) => x.kisa_kod);
    ok('tum masalarin kodu var ve tekil', kodlar.every(Boolean) && new Set(kodlar).size === kodlar.length, kodlar);
    const K = require('./src/services/kisaKod');
    ok('alfabede karisan karakter yok (0 O 1 I L 2 Z 5 S 8 B G)', !/[0O1IL2Z5S8BG]/.test(K.ALFABE) && K.ALFABE.length === 24);
    ok('kisa adres bicimi', K.kisaAdres('ACDEF3') === 'https://restoran.mdayazilim.com/q/ACDEF3');
    ok('O2: kisa kodlar 8 hane', K.UZUNLUK === 8 && kodlar.every((k) => k.length === 8), kodlar);

    console.log('\n=== 11) QR Indir kisa adres, kisa kodu yenile, siparis cekme ===');
    const { masa: m2t } = await masaVeUrun(tamS, 'T2');
    const m2 = (await query('SELECT id, kisa_kod FROM tables WHERE id = ?', [m2t.id])).rows[0];
    const qrp = await fetch(TABAN + '/api/tables/' + m2.id + '/qr.png', { headers: { Authorization: 'Bearer ' + tamS } });
    const beklenen = await QRCode.toBuffer('https://restoran.mdayazilim.com/q/' + m2.kisa_kod, { width: 480, margin: 2, errorCorrectionLevel: 'Q' });
    ok('D10: tek masa QR Indir kisa adresi basar (/q/<KOD>)', qrp.status === 200 && Buffer.from(await qrp.arrayBuffer()).equals(beklenen));
    const PIN = '246813';
    await query('UPDATE tenants SET manager_pin = ? WHERE id = ?', [await bcrypt.hash(PIN, 4), tam.id]);
    const ky0 = await js('/api/tables/' + m2.id + '/kisa-kod-yenile', { token: tamS, method: 'POST' });
    ok('O2: kisa kodu yenile yonetici sifresi ister (403 MANAGER_PIN_REQUIRED)', ky0.status === 403 && ky0.d.code === 'MANAGER_PIN_REQUIRED', ky0);
    ok('O2: kasiyer kisa kodu yenileyemez (403)', (await js('/api/tables/' + m2.id + '/kisa-kod-yenile', { token: tamK, method: 'POST', headers: { 'x-manager-pin': PIN } })).status === 403);
    const ky1 = await js('/api/tables/' + m2.id + '/kisa-kod-yenile', { token: tamS, method: 'POST', headers: { 'x-manager-pin': PIN } });
    ok('O2: sahip + sifre: yeni 8 haneli kod, uyari mesaji', ky1.status === 200 && ky1.d.kisaKod.length === 8 && ky1.d.kisaKod !== m2.kisa_kod
        && /yeniden bastırmanız/.test(ky1.d.message), ky1.d);
    ok('O2: eski kod artik cozulmez (404), yenisi cozulur', (await js('/api/public/q/' + m2.kisa_kod)).status === 404 && (await js('/api/public/q/' + ky1.d.kisaKod)).status === 200);
    await query('UPDATE tenants SET manager_pin = NULL WHERE id = ?', [tam.id]);
    // D4: Adisyon ve Kasa olmayan isletmede siparis cekilmez
    const kanalKur = async (tid) => {
        const kid = 'qrpk-kanal-' + crypto.randomBytes(4).toString('hex');
        await query("INSERT INTO marketplace_channels (id, tenant_id, name, is_active, adapter_code) VALUES (?, ?, 'Sandbox', 1, 'sandbox')", [kid, tid]);
        await query("INSERT INTO marketplace_store_links (id, tenant_id, channel_id, external_store_id, is_active) VALUES (?, ?, ?, ?, 1)", [kid + '-l', tid, kid, 'm-' + kid]);
        await query("INSERT INTO marketplace_credentials (id, tenant_id, channel_id, cipher_blob, iv, auth_tag, status) VALUES (?, ?, ?, 'x', 'x', 'x', 'active')", [kid + '-k', tid, kid]);
        return kid;
    };
    const kTam = await kanalKur(tam.id);
    const kMenu = await kanalKur(menuGarson.id);
    const tara = await require('./src/services/siparisCekici').taranacaklar();
    ok('D4: siparis cekme BASE olan isletmeyi tarar, BASE olmayani atlar', tara.some((k) => k.channel_id === kTam) && !tara.some((k) => k.channel_id === kMenu),
        tara.map((k) => k.channel_id));

    console.log('\n=== 12) Kisa kod oran siniri (en sonda: ayni IP) ===');
    ok('O1: IPv6 /64 anahtari', K.ipAnahtari('2001:db8:abcd:12:1::5') === '2001:db8:abcd:12::/64' && K.ipAnahtari('2001:0db8:abcd:0012:ffff:1:2:3') === '2001:db8:abcd:12::/64'
        && K.ipAnahtari('::ffff:10.1.2.3') === '10.1.2.3' && K.ipAnahtari('fe80::1%eth0') === 'fe80:0:0:0::/64', [K.ipAnahtari('2001:db8:abcd:12:1::5'), K.ipAnahtari('fe80::1%eth0')]);
    // Sunucu tek vekil arkasinda (trust proxy 1): X-Forwarded-For bu bolume kendi IP anahtarini verir
    const ipA = { 'X-Forwarded-For': '10.77.' + crypto.randomInt(1, 250) + '.' + crypto.randomInt(1, 250) };
    const qk = (kod, h) => js('/api/public/q/' + kod, { headers: h });
    const gecerli = await Promise.all(Array.from({ length: 40 }, () => qk(ky1.d.kisaKod, ipA)));
    ok('O1: gecerli kod sinirlanmaz (ayni anda 40 istek, hepsi 200)', gecerli.every((x) => x.status === 200), gecerli.map((x) => x.status).filter((c) => c !== 200));
    const gecerli2 = [];
    for (let i = 0; i < 60; i++) gecerli2.push((await qk(ky1.d.kisaKod, ipA)).status);
    ok('O1: art arda 60 gecerli okutma da sinirlanmaz', gecerli2.every((c) => c === 200), gecerli2.filter((c) => c !== 200));
    const pasifMasa = (await query('SELECT kisa_kod FROM tables WHERE tenant_id = ? AND is_active = 0 AND kisa_kod IS NOT NULL LIMIT 1', [tam.id])).rows[0];
    const pasifler = await Promise.all(Array.from({ length: 5 }, () => qk(pasifMasa.kisa_kod, ipA)));
    ok('O1: silinmis masanin plakasi 404 KISA_KOD_PASIF ve bos deneme sayilmaz', pasifler.every((x) => x.status === 404 && x.d.code === 'KISA_KOD_PASIF'), pasifler[0]);
    // Sirali bos denemeler: tam 30 tanesi 404, 31. istek 429 (gecerli kod dahil: tarama durur)
    const sirali = [];
    for (let i = 0; i < 30; i++) sirali.push((await qk('ACDEFHJ' + K.ALFABE[i % K.ALFABE.length], ipA)).status);
    ok('O1: 30 bos deneme 404', sirali.every((c) => c === 404), sirali.filter((c) => c !== 404));
    ok('O1: sinir asilinca bu IP gecerli kodda da 429 alir (tarama durur)', (await qk(ky1.d.kisaKod, ipA)).status === 429);
    // Ayni anda 120 bos deneme (yeni anahtar): sayac beklemeden ONCE artar, bos deneme tavani 30 + 50 esz.
    const ipB = { 'X-Forwarded-For': '10.78.' + crypto.randomInt(1, 250) + '.' + crypto.randomInt(1, 250) };
    const bos = await Promise.all(Array.from({ length: 120 }, (_, i) => qk('ACDEFHK' + K.ALFABE[i % K.ALFABE.length], ipB)));
    const s404 = bos.filter((x) => x.status === 404).length, s429 = bos.filter((x) => x.status === 429).length;
    ok('O1: ayni anda 120 bos deneme: en cok 80 tanesi islenir (30 + 50 esz.), gerisi 429', s404 <= 80 && s404 + s429 === 120 && s429 >= 40, { s404, s429 });
    ok('O1: ardindan bu anahtar da durur (429)', (await qk(ky1.d.kisaKod, ipB)).status === 429);
    // IPv6: ayni /64 icindeki adresler tek anahtar
    const v6a = { 'X-Forwarded-For': '2001:db8:77:' + crypto.randomInt(1, 9999).toString(16) + '::1' };
    const v6b = { 'X-Forwarded-For': v6a['X-Forwarded-For'].replace('::1', '::abcd') };
    const v6c = { 'X-Forwarded-For': v6a['X-Forwarded-For'].replace('2001:db8:77:', '2001:db8:78:') };
    for (let i = 0; i < 30; i++) await qk('ACDEFHJ3', v6a);
    ok('O1: IPv6 ayni /64 icindeki baska adres de durur (429)', (await qk(ky1.d.kisaKod, v6b)).status === 429);
    ok('O1: baska /64 etkilenmez (200)', (await qk(ky1.d.kisaKod, v6c)).status === 200);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
