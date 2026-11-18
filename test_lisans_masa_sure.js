// Lisans: masa siniri, gun sonu, deneme uzatma, yonetici sifresi, QR menu sepeti (A2, 2026-11-18).
// Kapsam: masaSiniri.siniriUygula (acik hesapli masa aktif kalir, kod ve kisa kod degismez, yeniden aktif etme sinirli,
// karekod yeniden calisir), satin almada masa uyarisi + "Okudum, anladim" onayi, root onayinda masalarin pasife
// alinmasi, Istanbul gun sinirlari (23:59), salt-okunurda acik hesabi tahsil edip kapatma (yeni siparis 403),
// deneme uzatma kipleri (deneme / lisans), yonetici sifremi unuttum (yalniz sahip, giris sifresi, 15 dk'da 5 deneme,
// destek oturumunda yasak, KAPALI'da acik), root yonetici sifresi sifirlama, yalniz QR menu teklifi (kademe yok),
// Garson yeni satista Adisyon ve Kasa ister ama eski hakki olan korunur. Sunucuyu KENDI baslatir.
// Calistir: node test_lisans_masa_sure.js   (port 47150)
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47150, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'lisans-masa-sure-test-jwt';
const ON = 'LMS Test';
const EPOSTA_ON = 'lms-';
const GUN = 86400000;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 600) : ''))); };
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
const bitisGun = (gun) => new Date(Date.now() + gun * GUN - 3600000).toISOString();

async function kiraciKur({ ad, tier = 'TIER_6_10', moduller = ['BASE', 'MENU_DIGITAL'], bitis = bitisGun(200), limit = null, kayitGun = -400 }) {
    const id = uuid();
    const slug = 'lms-' + crypto.randomBytes(4).toString('hex');
    const kod = String(60000 + (KOD_TABAN + kodSayac++) % 9999);
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, license_table_limit, is_active, created_at,
                              billing_name, billing_tax_id, billing_address)
         VALUES (?, ?, ?, ?, ?, '05320000000', 'Test Mah. 1', ?, ?, ?, ?, 1, datetime('now', ?), ?, '12345678901', 'Test Mah. 1, Afyon')`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, tier, JSON.stringify(moduller), bitis, limit,
            `${kayitGun} days`, `${ON} ${ad}`]);
    const eposta = `${EPOSTA_ON}sahip-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), id, eposta, await bcrypt.hash('sahip1234', 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    const g = await js('/api/auth/login', { body: { email: eposta, businessCode: kod, password: 'sahip1234' } });
    return { id, slug, kod, eposta, token: g.d && g.d.token };
}
async function personelKur(t, rol) {
    const eposta = `${EPOSTA_ON}${rol.toLowerCase()}-${t.slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), t.id, eposta, await bcrypt.hash('personel123', 4), rol, rol, new Date().toISOString()]);
    const g = await js('/api/auth/login', { body: { email: eposta, businessCode: t.kod, password: 'personel123' } });
    return g.d && g.d.token;
}
async function masaKur(tenantId, n, on = 'M') {
    const out = [];
    for (let i = 1; i <= n; i++) {
        const id = uuid();
        await query('INSERT INTO tables (id, tenant_id, code, name, qr_token) VALUES (?, ?, ?, ?, ?)',
            [id, tenantId, on + i, 'Masa ' + on + i, crypto.randomBytes(16).toString('hex')]);
        await require('./src/services/kisaKod').masayaAta(id);
        out.push(id);
    }
    return out;
}
async function urunKur(tenantId, fiyat = 100) {
    const kat = uuid(), urun = uuid();
    await query('INSERT INTO categories (id, tenant_id, name) VALUES (?, ?, ?)', [kat, tenantId, 'LMS Kategori']);
    await query('INSERT INTO products (id, tenant_id, category_id, name, price, tracks_stock) VALUES (?, ?, ?, ?, ?, 0)', [urun, tenantId, kat, 'LMS Urun', fiyat]);
    return urun;
}
async function gecmisKur(tenantId) {
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, donem_bitis, islenen_at, onay_gun)
                 VALUES (?, ?, 'TIER_6_10', '[]', 1000, 'onaylandi', datetime('now', '-30 days'), datetime('now', '-395 days'), 365)`,
        ['lms-gecmis-' + crypto.randomBytes(4).toString('hex'), tenantId]);
}
const kiraci = async (id) => (await query('SELECT * FROM tenants WHERE id = ?', [id])).rows[0];
const masalar = async (tid) => (await query('SELECT * FROM tables WHERE tenant_id = ? ORDER BY code', [tid])).rows;

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
// Lansman kampanyasi (test_lansman.js) bu testin fiyat beklentilerini degistirmesin: test boyunca kapali, sonunda eski hali
let lansmanYedek;   // undefined: dokunulmadi; null: kayit yoktu; metin: eski deger
async function lansmanKapat() {
    lansmanYedek = ((await query("SELECT deger FROM sistem_ayarlari WHERE anahtar = 'lansman_acik'")).rows[0] || { deger: null }).deger;
    await query("INSERT INTO sistem_ayarlari (anahtar, deger) VALUES ('lansman_acik', '0') ON CONFLICT(anahtar) DO UPDATE SET deger = '0'");
}
async function lansmanGeriAl() {
    if (lansmanYedek === undefined) return;
    if (lansmanYedek === null) await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'lansman_acik'");
    else await query("UPDATE sistem_ayarlari SET deger = ? WHERE anahtar = 'lansman_acik'", [lansmanYedek]);
    lansmanYedek = undefined;
}
async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%' OR owner_email LIKE '${EPOSTA_ON}%'`);
    for (const r of t.rows) {
        await query('DELETE FROM payments WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['orders', 'waiter_calls', 'qr_bekleyen_siparisler', 'tables', 'products', 'categories', 'lisans_odemeleri',
            'root_olaylar', 'license_cache', 'islem_gunlugu', 'yonetim_gunlugu', 'destek_oturumlari', 'gecis_haklari', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    if (katalogYedek) for (const x of katalogYedek) await query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [x.fiyat, x.gorunur, x.id]);
}
const fiyatYaz = (id, fiyat, gorunur = 1) => query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [fiyat, gorunur, id]);

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    await lansmanKapat();
    katalogYedek = (await query('SELECT id, fiyat, gorunur FROM lisans_katalog')).rows;
    await fiyatYaz('TIER-TIER_1_5', 3000); await fiyatYaz('TIER-TIER_6_10', 4000); await fiyatYaz('TIER-TIER_11_20', 6000);
    await fiyatYaz('TIER-TIER_20_PLUS', 9000); await fiyatYaz('MODUL-MENU_DIGITAL', 1000); await fiyatYaz('MODUL-GARSON', 500);
    await fiyatYaz('MODUL-BASE', 0);

    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '',
               ODEME_KORUMA_ONBELLEK_MS: '0' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();

    console.log('=== 1) Istanbul gun sinirlari (lisansDurumu) ===');
    const L = require('./src/services/lisansDurumu');
    const bitis = new Date('2026-03-10T09:00:00+03:00');
    ok('gunSonuIstanbul: ayni gunun 23:59:59.999 Istanbul', L.gunSonuIstanbul(bitis).toISOString() === '2026-03-10T20:59:59.999Z', L.gunSonuIstanbul(bitis));
    ok('bitis gunu 23:59 Istanbul: AKTIF', L.hesapla(bitis, new Date('2026-03-10T23:59:00+03:00')).durum === 'AKTIF');
    ok('bitis gunu, bitis saatinden sonra (18:00): hala AKTIF', L.hesapla(bitis, new Date('2026-03-10T18:00:00+03:00')).durum === 'AKTIF');
    ok('ertesi gun 00:00:01 Istanbul: SALT_OKUNUR', L.hesapla(bitis, new Date('2026-03-11T00:00:01+03:00')).durum === 'SALT_OKUNUR');
    const tol = L.toleransGun ? null : null;   // varsayilan 3 gun
    ok('bitis + 3 gun 23:59 Istanbul: SALT_OKUNUR', L.hesapla(bitis, new Date('2026-03-13T23:59:00+03:00')).durum === 'SALT_OKUNUR');
    ok('bitis + 4 gun 00:00:01 Istanbul: KAPALI', L.hesapla(bitis, new Date('2026-03-14T00:00:01+03:00')).durum === 'KAPALI');
    // UTC'de onceki gun gorunen bitis (22:30Z = Istanbul 01:30 ertesi gun): Istanbul gunu sayilir
    const gece = new Date('2026-03-10T22:30:00Z');
    ok('UTC 22:30 bitis = Istanbul 11 Mart: 11 Mart 23:00 Istanbul AKTIF', L.hesapla(gece, new Date('2026-03-11T23:00:00+03:00')).durum === 'AKTIF');
    ok('kalanGun Istanbul takvim gunu: bitis bugun -> 0', L.hesapla(bitis, new Date('2026-03-10T08:00:00+03:00')).kalanGun === 0);
    ok('kalanGun: 3 gun sonra bitiyor -> 3 (saatten bagimsiz)', L.hesapla(bitis, new Date('2026-03-07T23:30:00+03:00')).kalanGun === 3
        && L.hesapla(bitis, new Date('2026-03-07T00:10:00+03:00')).kalanGun === 3);
    ok('SALT_OKUNUR kalanGun: son gun 0', L.hesapla(bitis, new Date('2026-03-13T12:00:00+03:00')).kalanGun === 0
        && L.hesapla(bitis, new Date('2026-03-11T12:00:00+03:00')).kalanGun === 2);
    ok('aktifBitis donuyor', L.hesapla(bitis, new Date('2026-03-09T12:00:00+03:00')).aktifBitis.toISOString() === '2026-03-10T20:59:59.999Z');
    void tol;

    console.log('\n=== 2) masaSiniri.siniriUygula ===');
    const MS = require('./src/services/masaSiniri');
    const A = await kiraciKur({ ad: 'Masa Siniri', tier: 'TIER_20_PLUS', moduller: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON'], limit: null });
    const aMasa = await masaKur(A.id, 6);
    const aUrun = await urunKur(A.id, 100);
    const acik = await js('/api/orders', { token: A.token, body: { tableId: aMasa[1] } });
    await js(`/api/orders/${acik.d.id}/items`, { token: A.token, body: { productId: aUrun, qty: 1 } });
    ok('hazirlik: M2 masasinda acik hesap', acik.status === 201, acik);
    const onceMasalar = await masalar(A.id);
    ok('sinir null: hicbir sey yapilmaz', (await MS.siniriUygula(A.id, null)).uygulandi === false);
    ok('sinir >= aktif: hicbir sey yapilmaz', (await MS.siniriUygula(A.id, 6)).uygulandi === false);
    const su = await MS.siniriUygula(A.id, 3, { kaynak: 'test' });
    ok('sinir 3 < 6 aktif: acik hesabi olmayan 5 masa pasife alindi, 1 aktif kaldi', su.uygulandi && su.pasifeAlinan === 5 && su.acikKalan === 1 && su.aktifOnce === 6, su);
    const sonraMasalar = await masalar(A.id);
    const m2 = sonraMasalar.find((x) => x.id === aMasa[1]);
    ok('acik hesapli masa aktif, pasif_sebep yok', m2.is_active === 1 && !m2.pasif_sebep, m2);
    ok('pasif masalarda pasif_sebep = lisans', sonraMasalar.filter((x) => x.id !== aMasa[1]).every((x) => x.is_active === 0 && x.pasif_sebep === 'lisans'));
    ok('kodlar, kisa kodlar ve qr_token degismedi', onceMasalar.every((o) => {
        const s = sonraMasalar.find((x) => x.id === o.id);
        return s && s.code === o.code && s.kisa_kod === o.kisa_kod && s.qr_token === o.qr_token;
    }));
    const g1 = (await query("SELECT * FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'masa_lisans_pasif'", [A.id])).rows;
    ok('islem gunlugune yazildi', g1.length === 1 && /5 masa pasife/.test(g1[0].detay), g1);
    const pasifQr = sonraMasalar.find((x) => x.id === aMasa[0]);
    ok('pasif masanin karekodu: menu acilmaz (404), garson cagrisi ve siparis yok', (await js(`/api/public/m/${A.slug}/${pasifQr.qr_token}/menu`)).status === 404
        && (await js(`/api/public/m/${A.slug}/${pasifQr.qr_token}/waiter`, { body: {} })).status === 404
        && (await js(`/api/public/m/${A.slug}/${pasifQr.qr_token}/orders`, { body: { items: [{ productId: aUrun, qty: 1 }] } })).status >= 400);
    ok('kisa kod pasif masada "pasif" doner', (await require('./src/services/kisaKod').coz(pasifQr.kisa_kod)).durum === 'pasif');

    console.log('\n--- yeniden aktif etme (sinir 3) ---');
    await query('UPDATE tenants SET license_table_limit = 3 WHERE id = ?', [A.id]);
    const lp = await js('/api/tables/lisans-pasif', { token: A.token });
    ok('lisans-pasif listesi: 5 masa, sinir 3, kullanilan 1', lp.status === 200 && lp.d.masalar.length === 5 && lp.d.limit === 3 && lp.d.used === 1, lp.d);
    const kasiyer = await personelKur(A, 'CASHIER');
    ok('kasiyer aktif edemez (403)', (await js(`/api/tables/${aMasa[0]}/lisans-aktif`, { token: kasiyer, method: 'POST' })).status === 403);
    const ak1 = await js(`/api/tables/${aMasa[0]}/lisans-aktif`, { token: A.token, method: 'POST' });
    const ak2 = await js(`/api/tables/${aMasa[2]}/lisans-aktif`, { token: A.token, method: 'POST' });
    ok('iki masa aktif edildi (3/3)', ak1.status === 200 && ak2.status === 200, [ak1, ak2]);
    const ak3 = await js(`/api/tables/${aMasa[3]}/lisans-aktif`, { token: A.token, method: 'POST' });
    ok('sinir dolunca 403 ve dogru metin', ak3.status === 403 && ak3.d.message === 'Lisansınız 3 masa ile sınırlı. Başka bir masayı aktif etmek için önce bir masayı pasife alın ya da paketinizi büyütün.', ak3);
    const m1 = (await masalar(A.id)).find((x) => x.id === aMasa[0]);
    ok('aktif edilen masa: pasif_sebep temizlendi, kod ayni', m1.is_active === 1 && !m1.pasif_sebep && m1.code === 'M1', m1);
    ok('aktif edilen masanin karekodu yeniden calisir (menu 200)', (await js(`/api/public/m/${A.slug}/${m1.qr_token}/menu`)).status === 200);
    ok('kisa kod yeniden "aktif"', (await require('./src/services/kisaKod').coz(m1.kisa_kod)).durum === 'aktif');
    ok('silinmis (lisans disi) masa bu uctan aktif edilmez (409)', await (async () => {
        await js(`/api/tables/${aMasa[0]}`, { token: A.token, method: 'DELETE' });
        return (await js(`/api/tables/${aMasa[0]}/lisans-aktif`, { token: A.token, method: 'POST' })).status === 409;
    })());
    const ren = await js(`/api/tables/${aMasa[1]}`, { token: A.token, method: 'PUT', body: { code: 'M4' } });
    ok('baska masa lisans pasifindeki masanin kodunu alamaz (409, kod korunur)', ren.status === 409 && (await masalar(A.id)).find((x) => x.id === aMasa[3]).code === 'M4', ren);

    console.log('\n=== 3) Satin almada masa uyarisi + root onayinda pasife alma ===');
    const B = await kiraciKur({ ad: 'Deneme Fazla Masa', tier: 'TIER_DENEME', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON'], bitis: bitisGun(5), kayitGun: -3 });
    await masaKur(B.id, 8);
    const qb = await js('/api/license/quote', { token: B.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('teklif: aktifMasa 8, masaUyarisi true (sinir 5)', qb.status === 200 && qb.d.aktifMasa === 8 && qb.d.masaUyarisi === true && qb.d.tableLimit === 5, qb.d);
    const qb2 = await js('/api/license/quote', { token: B.token, body: { tier: 'TIER_11_20', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('yeterli paket: masaUyarisi false', qb2.d.masaUyarisi === false, qb2.d);
    const pb0 = await js('/api/license/purchase', { token: B.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('onaysiz satin alma 400 MASA_UYARISI_ONAY_GEREKLI + metin', pb0.status === 400 && pb0.d.code === 'MASA_UYARISI_ONAY_GEREKLI'
        && pb0.d.message.startsWith('Aktif masa sayınız (8) seçtiğiniz paketin sınırının (5) üzerinde. Ödemeniz onaylandığında açık hesabı olmayan masalarınız pasife alınır'), pb0.d);
    const pb = await js('/api/license/purchase', { token: B.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL'], masaUyarisiOnay: true } });
    ok('onayli satin alma 201', pb.status === 201, pb.d);
    const kb = (await query('SELECT * FROM lisans_odemeleri WHERE id = ?', [pb.d.id])).rows[0];
    ok('onay kayda yazildi (zaman + aktif masa 8)', !!kb.masa_uyari_onay_at && Number(kb.masa_uyari_aktif) === 8, kb);
    const rl = (await js('/api/root/lisans-odemeleri', { token: rj })).d.find((x) => x.id === pb.d.id);
    ok('root listesi: aktif_masa 8, yeni sinir 5, pasife alinacak', rl && rl.aktif_masa === 8 && rl.yeni_masa_limiti === 5 && rl.masa_pasife_alinacak === true, rl);
    const onb = await js(`/api/root/lisans-odemeleri/${pb.d.id}/onayla`, { token: rj, body: { gun: 365 } });
    const bm = await masalar(B.id);
    ok('onay: 8 masanin hepsi pasif (lisans), mesajda bilgi', onb.status === 200 && bm.every((x) => x.is_active === 0 && x.pasif_sebep === 'lisans')
        && /8 masa pasife alındı/.test(onb.d.message), [onb.d, bm.map((x) => x.is_active)]);
    ok('onay sonrasi sinir 5', Number((await kiraci(B.id)).license_table_limit) === 5);
    const C = await kiraciKur({ ad: 'Uyarisiz', tier: 'TIER_DENEME', moduller: ['BASE'], bitis: bitisGun(5), kayitGun: -3 });
    await masaKur(C.id, 3);
    const pc = await js('/api/license/purchase', { token: C.token, body: { tier: 'TIER_1_5', modules: ['BASE'] } });
    ok('masa sinirin altinda: onay kutusu istenmez, kayitta uyari yok', pc.status === 201
        && !(await query('SELECT masa_uyari_onay_at FROM lisans_odemeleri WHERE id = ?', [pc.d.id])).rows[0].masa_uyari_onay_at, pc.d);
    await js(`/api/root/lisans-odemeleri/${pc.d.id}/onayla`, { token: rj, body: { gun: 365 } });
    ok('onayda masalara dokunulmadi', (await masalar(C.id)).every((x) => x.is_active === 1));
    const ru = await js(`/api/root/tenants/${C.id}`, { token: rj, method: 'PATCH', body: { tableLimit: 2 } });
    ok('root sinir 2 yazinca (3 aktif) masalar pasife alinir', ru.status === 200 && (await masalar(C.id)).every((x) => x.is_active === 0 && x.pasif_sebep === 'lisans'), ru.d);
    await query("UPDATE tables SET is_active = 1, pasif_sebep = NULL WHERE tenant_id = ?", [C.id]);
    await js(`/api/root/tenants/${C.id}`, { token: rj, method: 'PATCH', body: { tableLimit: 2, phone: '05329999999' } });
    ok('ayni sinir yeniden gonderilince (sinir degismedi) masalara dokunulmaz', (await masalar(C.id)).every((x) => x.is_active === 1));

    console.log('\n=== 4) Salt-okunurda acik hesabi bitirme ===');
    const D = await kiraciKur({ ad: 'Salt Bitir', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL'], bitis: bitisGun(30), limit: 10 });
    const dMasa = await masaKur(D.id, 3);
    const dUrun = await urunKur(D.id, 150);
    const o1 = await js('/api/orders', { token: D.token, body: { tableId: dMasa[0] } });
    await js(`/api/orders/${o1.d.id}/items`, { token: D.token, body: { productId: dUrun, qty: 2 } });
    ok('lisans bitmeden hesap acildi (300 TL)', o1.status === 201 && Number((await query('SELECT total FROM orders WHERE id = ?', [o1.d.id])).rows[0].total) === 300);
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [new Date(Date.now() - GUN).toISOString(), D.id]);
    const me = await js('/api/auth/me', { token: D.token });
    ok('durum SALT_OKUNUR', me.d.lisansDurum === 'SALT_OKUNUR' && !!me.d.lisansAktifBitis, me.d);
    const yeni = await js('/api/orders', { token: D.token, body: { tableId: dMasa[1] } });
    ok('yeni siparis 403 LICENSE_READONLY', yeni.status === 403 && yeni.d.code === 'LICENSE_READONLY', yeni);
    ok('acik hesaba kalem eklenemez (403)', (await js(`/api/orders/${o1.d.id}/items`, { token: D.token, body: { productId: dUrun, qty: 1 } })).status === 403);
    const p1 = await js('/api/payments', { token: D.token, body: { orderId: o1.d.id, method: 'NAKIT', amount: 100 } });
    ok('acik hesaba odeme 201', p1.status === 201, p1);
    const kalemler = (await query('SELECT id FROM order_items WHERE order_id = ?', [o1.d.id])).rows;
    const p2 = await js('/api/payments/by-items', { token: D.token, body: { orderId: o1.d.id, method: 'KREDI_KARTI', items: [{ itemId: kalemler[0].id, qty: 1 }] } });
    ok('kalem secerek odeme gecer (403 degil)', p2.status !== 403, p2);
    const odenen = Number((await query('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE order_id = ?', [o1.d.id])).rows[0].s);
    if (odenen < 300) await js('/api/payments', { token: D.token, body: { orderId: o1.d.id, method: 'NAKIT', amount: 300 - odenen } });
    const kap = await js(`/api/orders/${o1.d.id}/close`, { token: D.token, method: 'POST' });
    ok('hesap kapatildi', kap.status === 200 && (await query('SELECT status FROM orders WHERE id = ?', [o1.d.id])).rows[0].status === 'CLOSED', kap);
    ok('olmayan siparis kapatma 404 (uc yalniz mevcut siparisi kapatir)', (await js('/api/orders/yok-boyle/close', { token: D.token, method: 'POST' })).status === 404);
    ok('paket aksiyonu: "kabul" salt-okunurda kapali', L.saltOkunurdaGecerMi({ method: 'POST', originalUrl: '/api/paket/x/aksiyon', body: { aksiyon: 'kabul' } }) === false
        && L.saltOkunurdaGecerMi({ method: 'POST', originalUrl: '/api/paket/x/aksiyon', body: { aksiyon: 'teslim' } }) === true);
    ok('KAPALI: odeme ve kapatma yine kapali', L.kapalidaGecerMi({ method: 'POST', originalUrl: '/api/payments' }) === false
        && L.kapalidaGecerMi({ method: 'POST', originalUrl: '/api/orders/x/close' }) === false);
    const o2 = await js('/api/orders', { token: D.token, body: { tableId: dMasa[2] } });
    void o2;
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [new Date(Date.now() - 10 * GUN).toISOString(), D.id]);
    ok('KAPALI isletmede odeme 403 LICENSE_EXPIRED', (await js('/api/payments', { token: D.token, body: { orderId: o1.d.id, method: 'NAKIT', amount: 1 } })).d.code === 'LICENSE_EXPIRED');

    console.log('\n=== 5) Deneme uzatma kipleri ===');
    const E = await kiraciKur({ ad: 'Deneme Uzat', tier: 'TIER_DENEME', moduller: ['BASE', 'MENU_DIGITAL'], bitis: bitisGun(2), kayitGun: -5 });
    const eOnce = (await kiraci(E.id)).license_end_date;
    const u1 = await js(`/api/root/tenants/${E.id}/lisans-uzat`, { token: rj, body: { gun: 7, mod: 'deneme' } });
    const e1 = await kiraci(E.id);
    ok('deneme kipi: paket TIER_DENEME kalir, bitis 7 gun uzar', u1.status === 200 && e1.license_tier === 'TIER_DENEME'
        && Math.round((new Date(e1.license_end_date) - new Date(eOnce)) / GUN) === 7 && u1.d.mod === 'deneme' && /deneme süresi/.test(u1.d.message), u1.d);
    ok('deneme kipi: isletme deneme sinifinda kalir', (await require('./src/services/yonetimOzet').isletmeSinifi(E.id)) === 'deneme');
    ok('deneme kipi: kanal hala ilk alim (deneme)', (await js('/api/license/yenileme-kanali', { token: E.token })).d.deneme === true);
    const yg1 = (await query("SELECT islem, ozet FROM yonetim_gunlugu WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [E.id])).rows[0];
    ok('yonetim gunlugu: deneme_uzat', yg1 && yg1.islem === 'deneme_uzat' && /Deneme süresi uzatıldı/.test(yg1.ozet), yg1);
    ok('gecersiz kip 400', (await js(`/api/root/tenants/${E.id}/lisans-uzat`, { token: rj, body: { gun: 7, mod: 'baska' } })).status === 400);
    const u2 = await js(`/api/root/tenants/${E.id}/lisans-uzat`, { token: rj, body: { gun: 365, mod: 'lisans' } });
    const e2 = await kiraci(E.id);
    const yg2 = (await query("SELECT islem, ozet FROM yonetim_gunlugu WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [E.id])).rows[0];
    ok('lisans kipi: TIER_MUSTERI + lisans_uzat kaydi', u2.status === 200 && e2.license_tier === 'TIER_MUSTERI' && yg2.islem === 'lisans_uzat' && /lisans verildi/.test(yg2.ozet), [u2.d, yg2]);
    const E2 = await kiraciKur({ ad: 'Deneme Eski Istemci', tier: 'TIER_DENEME', moduller: ['BASE'], bitis: bitisGun(2), kayitGun: -5 });
    await js(`/api/root/tenants/${E2.id}/lisans-uzat`, { token: rj, body: { gun: 30 } });
    ok('kip gonderilmezse eski davranis (TIER_MUSTERI)', (await kiraci(E2.id)).license_tier === 'TIER_MUSTERI');

    console.log('\n=== 6) Yonetici sifremi unuttum ===');
    const F = await kiraciKur({ ad: 'Pin Unuttum', moduller: ['BASE'] });
    await query('UPDATE tenants SET manager_pin = ? WHERE id = ?', [await bcrypt.hash('111111', 4), F.id]);
    const mudur = await personelKur(F, 'MANAGER');
    ok('mudur sifirlayamaz (403)', (await js('/api/auth/manager-reset', { token: mudur, body: { password: 'personel123', newPin: '222222' } })).status === 403);
    const r1 = await js('/api/auth/manager-reset', { token: F.token, body: { password: 'yanlis-sifre', newPin: '222222' } });
    ok('yanlis giris sifresi 403', r1.status === 403 && r1.d.code === 'GIRIS_SIFRESI_HATALI', r1);
    ok('kisa yeni sifre 400', (await js('/api/auth/manager-reset', { token: F.token, body: { password: 'sahip1234', newPin: '12' } })).status === 400);
    const r2 = await js('/api/auth/manager-reset', { token: F.token, body: { password: 'sahip1234', newPin: '222222' } });
    ok('dogru giris sifresiyle 200', r2.status === 200, r2);
    const hashF = (await kiraci(F.id)).manager_pin;
    ok('yeni yonetici sifresi gecerli, eskisi gecmez', await bcrypt.compare('222222', hashF) && !(await bcrypt.compare('111111', hashF)));
    ok('manager-verify yeni sifreyle 200', (await js('/api/auth/manager-verify', { token: F.token, body: { pin: '222222' } })).status === 200);
    const gF = (await query("SELECT detay FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'yonetici_sifresi_sifirla'", [F.id])).rows;
    ok('islem gunlugune yazildi, sifre yok', gF.length === 1 && !/222222|sahip1234/.test(gF[0].detay), gF);
    const r3 = await js('/api/auth/manager-reset', { token: F.token, body: { password: 'yanlis', newPin: '333333' } });
    const r4 = await js('/api/auth/manager-reset', { token: F.token, body: { password: 'yanlis', newPin: '333333' } });
    const r5 = await js('/api/auth/manager-reset', { token: F.token, body: { password: 'sahip1234', newPin: '333333' } });
    // sayilan istekler: r1, kisa sifre, r2, r3, r4 = 5; altinci (r5, dogru sifreyle) 429
    ok('deneme siniri: 15 dakikada 5 istekten sonra 429 (dogru sifreyle de)', r3.status === 403 && r4.status === 403 && r5.status === 429 && r5.d.code === 'SIFIRLAMA_SINIRI', [r1.status, r2.status, r3.status, r4.status, r5.status]);
    const G = await kiraciKur({ ad: 'Pin Kapali', moduller: ['BASE'], bitis: new Date(Date.now() - 10 * GUN).toISOString() });
    await query('UPDATE tenants SET manager_pin = ? WHERE id = ?', [await bcrypt.hash('111111', 4), G.id]);
    ok('lisans KAPALI isletmede de calisir (200)', (await js('/api/auth/manager-reset', { token: G.token, body: { password: 'sahip1234', newPin: '444444' } })).status === 200);
    const dac = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: F.id, sebep: 'Yönetici şifresi testi' } });
    const dgr = dac.status === 201 ? await js('/api/destek/giris/' + dac.d.jeton, { method: 'POST' }) : null;
    const dr = dgr && dgr.d && dgr.d.token ? await js('/api/auth/manager-reset', { token: dgr.d.token, body: { password: 'sahip1234', newPin: '555555' } }) : null;
    ok('destek oturumunda yasak (403)', dr && dr.status === 403, [dac.status, dgr && dgr.status, dr]);
    if (dac.status === 201) await query("UPDATE destek_oturumlari SET bitis_at = CURRENT_TIMESTAMP WHERE id = ?", [dac.d.id]).catch(() => {});

    console.log('\n--- root: yonetici sifresini sifirla ---');
    const rs = await js(`/api/root/tenants/${F.id}/yonetici-sifresi-sifirla`, { token: rj, method: 'POST' });
    ok('root sifirlama: manager_pin NULL', rs.status === 200 && (await kiraci(F.id)).manager_pin === null, rs);
    ok('manager-status isSet false', (await js('/api/auth/manager-status', { token: F.token })).d.isSet === false);
    const ygF = (await query("SELECT islem FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'yonetici_sifresi_sifirla'", [F.id])).rows;
    ok('yonetim gunlugune yazildi', ygF.length === 1);
    ok('isletme jetonuyla root ucu 401/403', [401, 403].includes((await js(`/api/root/tenants/${F.id}/yonetici-sifresi-sifirla`, { token: F.token, method: 'POST' })).status));

    console.log('\n=== 7) Yalniz QR menu: kademesiz teklif, satin alma, onay ===');
    const anon = await js('/api/license/quote', { body: { modules: ['MENU_DIGITAL'] } });
    ok('oturumsuz teklif kademesiz 200: tier null, sinir null, 1000', anon.status === 200 && anon.d.tier === null && anon.d.tableLimit === null && anon.d.total === 1000, anon.d);
    ok('kademe gelse de yok sayilir', (await js('/api/license/quote', { body: { tier: 'TIER_1_5', modules: ['MENU_DIGITAL'] } })).d.tier === null);
    ok('Adisyon ve Kasa kademesiz 400', (await js('/api/license/quote', { body: { modules: ['BASE'] } })).status === 400);
    const H = await kiraciKur({ ad: 'Yalniz Menu', tier: 'TIER_DENEME', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON'], bitis: bitisGun(4), kayitGun: -3 });
    await masaKur(H.id, 12);
    const qh = await js('/api/license/quote', { token: H.token, body: { modules: ['MENU_DIGITAL'] } });
    ok('oturumlu QR menu teklifi: masa uyarisi yok (sinir yok)', qh.status === 200 && qh.d.tier === null && qh.d.masaUyarisi === false && qh.d.genelToplam === 1200, qh.d);
    const ph = await js('/api/license/purchase', { token: H.token, body: { modules: ['MENU_DIGITAL'] } });
    ok('satin alma 201 (kademe yok)', ph.status === 201 && ph.d.tier === null, ph.d);
    const rh = (await js('/api/root/lisans-odemeleri', { token: rj })).d.find((x) => x.id === ph.d.id);
    ok('root listesi: masa paketi yok, pasife alma yok', rh && /QR Menü/.test(rh.tier_ad) && rh.masa_pasife_alinacak === false && rh.yeni_masa_limiti === null, rh);
    const onh = await js(`/api/root/lisans-odemeleri/${ph.d.id}/onayla`, { token: rj, body: { gun: 365 } });
    const th = await kiraci(H.id);
    ok('onay: TIER_MENU, sinir NULL, yalniz QR Menu, masalara dokunulmadi', onh.status === 200 && th.license_tier === 'TIER_MENU' && th.license_table_limit === null
        && JSON.stringify(JSON.parse(th.license_modules)) === '["MENU_DIGITAL"]' && (await masalar(H.id)).every((x) => x.is_active === 1), [onh.d, th]);
    // Donem icinde QR menuden Adisyon ve Kasa'ya gecis: kucuk pakete gecis sayilmaz (409 olmaz), yukseltme
    const qh2 = await js('/api/license/quote', { token: H.token, body: { tier: 'TIER_1_5', modules: ['MENU_DIGITAL', 'BASE'] } });
    ok('donem icinde QR menu -> Adisyon ve Kasa (5 masa): 200 yukseltme, masa uyarisi (12 > 5)', qh2.status === 200 && qh2.d.tur === 'yukseltme' && qh2.d.masaUyarisi === true, qh2.d);
    const dnh = (await js('/api/license/yenileme-kanali', { token: H.token })).d;
    ok('donem bilgisi: adisyon false', dnh.donem && dnh.donem.mevcut.adisyon === false, dnh);

    console.log('\n=== 8) Garson: yeni satista Adisyon ve Kasa ister, eski hak korunur ===');
    const kat = (await js('/api/license/catalog')).d;
    ok('katalog: Garson satisIcinGerekli BASE', JSON.stringify((kat.modules.find((m) => m.name === 'GARSON') || {}).satisIcinGerekli) === '["BASE"]', kat.modules);
    const J = await kiraciKur({ ad: 'Yeni Garson', tier: 'TIER_DENEME', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON'], bitis: bitisGun(4), kayitGun: -3 });
    const qg = await js('/api/license/quote', { token: J.token, body: { modules: ['MENU_DIGITAL', 'GARSON'] } });
    ok('yeni satin alma: QR Menu + Garson (BASE yok) 400 + metin', qg.status === 400 && qg.d.code === 'GARSON_ADISYON_GEREKLI'
        && qg.d.message === 'Garson çağırma masa karekoduyla çalışır; Adisyon ve Kasa ile birlikte alınır.', qg);
    const qg2 = await js('/api/license/quote', { token: J.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'GARSON'] } });
    ok('Garson + Adisyon ve Kasa 200', qg2.status === 200 && qg2.d.modules.includes('GARSON'), qg2.d);
    const I = await kiraciKur({ ad: 'Eski Garson', tier: 'TIER_MUSTERI', moduller: ['MENU_DIGITAL', 'GARSON'], bitis: bitisGun(10) });
    await gecmisKur(I.id);
    const qi = await js('/api/license/quote', { token: I.token, body: { modules: ['MENU_DIGITAL', 'GARSON'] } });
    ok('Garson sahibi musteri: yenilemede BASE olmadan secebilir', qi.status === 200 && qi.d.modules.includes('GARSON') && !qi.d.modules.includes('BASE') && qi.d.tier === null, qi);
    const dni = (await js('/api/license/yenileme-kanali', { token: I.token })).d;
    ok('donem bilgisi: garsonBasesizIzinli true', dni.donem && dni.donem.mevcut.garsonBasesizIzinli === true, dni);
    const M = require('./src/services/lisansModul');
    const kor = M.korunacakModuller({ mevcut: ['MENU_DIGITAL', 'GARSON'], odenen: ['MENU_DIGITAL'], satinAlinabilir: new Set(['MENU_DIGITAL', 'GARSON', 'BASE']),
        deneme: false, aktifKanal: false, eskiHak: ['GARSON'] });
    ok('eski hak Garson, BASE olmadan da korunur (gecis_haklari)', JSON.stringify(kor) === '["GARSON"]', kor);
    const pi = await js('/api/license/purchase', { token: I.token, body: { modules: ['MENU_DIGITAL', 'GARSON'] } });
    const oni = pi.status === 201 ? await js(`/api/root/lisans-odemeleri/${pi.d.id}/onayla`, { token: rj, body: { gun: 365 } }) : null;
    ok('yenileme onayi: Garson lisansta kalir', oni && oni.status === 200 && JSON.parse((await kiraci(I.id)).license_modules).includes('GARSON'), [pi, oni && oni.d]);

    await temizle();
    await lansmanGeriAl();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    try { sunucu.kill(); } catch (_) {}
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('HATA', e); try { await temizle(); await lansmanGeriAl(); } catch (_) {} process.exit(1); });
