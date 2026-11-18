// Sube grubu + grup yoneticisi ekrani: root grup kurar (uye, yonetici, gunluk, liste rozeti), yoneticinin /api/grup/ozet
// toplamlari her subenin KENDI rapor rakamlarinin toplamina esit (gun + ay), grup disi isletme hic gorunmez, yonetici
// olmayan / kasiyer 403, yonetici sifresi gerekli, destek oturumu reddedilir, Istanbul gun siniri (23:30 ayni gun,
// 00:30 ertesi gun), donem dogrulamasi, isletme gruptan cikinca yoneticilik de duser.
// Sunucuyu KENDI baslatir (port 47201).  Calistir: node test_grup.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47201, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'grup-test-jwt';
const ON = 'GRPT Test';
const EPOSTA_ON = 'grpt-';
const PIN = '481516';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 500) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const gun = (n) => new Date(Date.now() + n * 86400000).toISOString();
const esit = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

const SIFRE = 'GizliGrup!7710';
async function kullaniciEkle(tenantId, slug, rol) {
    const id = uuid();
    const eposta = `${EPOSTA_ON}${rol.toLowerCase()}-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, tenantId, eposta, await bcrypt.hash(SIFRE, 4), rol, rol, new Date().toISOString()]);
    return { id, eposta };
}
async function kiraciKur(ad, { pin = false } = {}) {
    const id = uuid();
    const slug = 'grpt-' + crypto.randomBytes(4).toString('hex');
    const kod = String(70000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, is_active, manager_pin)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'TIER_6_10', ?, ?, 1, ?)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, '0533 000 00 00', 'Test Mah.',
            JSON.stringify(['BASE', 'MENU_DIGITAL']), gun(200), pin ? await bcrypt.hash(PIN, 4) : null]);
    const sahip = await kullaniciEkle(id, slug, 'OWNER');
    const mudur = await kullaniciEkle(id, slug, 'MANAGER');
    const kasiyer = await kullaniciEkle(id, slug, 'CASHIER');
    return { id, slug, kod, ad: `${ON} ${ad}`, sahip, mudur, kasiyer };
}
async function giris(t, k) {
    const r = await js('/api/auth/login', { body: { email: k.eposta, businessCode: t.kod, password: SIFRE } });
    return r.d && r.d.token;
}
// Kapanmis siparis + odemeleri. kapanis: SQLite UTC metni ('YYYY-MM-DD HH:MM:SS')
async function siparis(tenantId, { kanal = 'DINE_IN', toplam, kapanis, durum = 'CLOSED', odemeler = [] }) {
    const id = uuid();
    await query(`INSERT INTO orders (id, tenant_id, channel, status, subtotal, total, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, tenantId, kanal, durum, toplam, toplam, kapanis || new Date().toISOString().slice(0, 19).replace('T', ' '), durum === 'OPEN' ? null : kapanis]);
    for (const [yontem, tutar] of odemeler) {
        await query('INSERT INTO payments (id, tenant_id, order_id, method, amount) VALUES (?, ?, ?, ?, ?)', [uuid(), tenantId, id, yontem, tutar]);
    }
    return id;
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

async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%' OR owner_email LIKE '${EPOSTA_ON}%'`);
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        await query('DELETE FROM sube_grup_yoneticileri WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)', [r.id]).catch(() => {});
        await query('DELETE FROM sube_grup_uyeleri WHERE tenant_id = ?', [r.id]).catch(() => {});
        for (const tb of ['payments', 'islem_gunlugu', 'orders', 'destek_oturumlari', 'yonetim_gunlugu', 'users']) {
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('temizle', tb, e.message));
        }
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM sube_grup_yoneticileri WHERE grup_id IN (SELECT id FROM sube_gruplari WHERE ad LIKE '${ON}%')`).catch(() => {});
    await query(`DELETE FROM sube_grup_uyeleri WHERE grup_id IN (SELECT id FROM sube_gruplari WHERE ad LIKE '${ON}%')`).catch(() => {});
    await query(`DELETE FROM sube_gruplari WHERE ad LIKE '${ON}%'`).catch(() => {});
    const rr = await query(`SELECT id FROM root_users WHERE email LIKE '${EPOSTA_ON}root-%'`);
    for (const r of rr.rows) await query('DELETE FROM yonetim_gunlugu WHERE root_id = ?', [r.id]).catch(() => {});
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}root-%'`);
}

// Bir subenin kendi gun / ay raporu (Raporlar sayfasinin uclari)
async function gunRaporu(token, gunStr, pin) {
    return js('/api/reports/day?date=' + gunStr, { token, headers: pin ? { 'x-manager-pin': pin } : {} });
}
async function ayRaporu(token, ay, pin) {
    return js('/api/reports/month?month=' + ay, { token, headers: pin ? { 'x-manager-pin': pin } : {} });
}
const yontemTutari = (rapor, y) => Number((rapor.byPayment.find((p) => p.method === y) || {}).amount || 0);

(async () => {
    initDb(); await uyu(1200); await temizle();
    const env = { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' };
    const logYolu = process.env.TEST_SUNUCU_LOG;
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, env,
        stdio: logYolu ? ['ignore', require('fs').openSync(logYolu, 'a'), require('fs').openSync(logYolu, 'a')] : 'ignore' });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);
    const rj = await rootJeton();

    const A = await kiraciKur('Merkez', { pin: true });
    const B = await kiraciKur('Kadıköy');
    const C = await kiraciKur('Disarida');

    console.log('=== 1) Root: grup kurulumu ===');
    ok('jetonsuz 401', (await js('/api/root/gruplar')).status === 401);
    const kiraciJeton = await giris(A, A.sahip);
    ok('isletme jetonu root ucuna giremez (403)', (await js('/api/root/gruplar', { token: kiraciJeton })).status === 403);
    ok('bos ad 400', (await js('/api/root/gruplar', { token: rj, body: { ad: '   ' } })).status === 400);
    const g1 = await js('/api/root/gruplar', { token: rj, body: { ad: `${ON} Grubu` } });
    ok('grup olusturuldu 201', g1.status === 201 && g1.d.id, g1.d);
    const GID = g1.d.id;
    const g2 = await js('/api/root/gruplar', { token: rj, body: { ad: `${ON} Ikinci` } });
    ok('uye ekle A', (await js(`/api/root/gruplar/${GID}/uyeler`, { token: rj, body: { tenantId: A.id } })).status === 201);
    ok('uye ekle B', (await js(`/api/root/gruplar/${GID}/uyeler`, { token: rj, body: { tenantId: B.id } })).status === 201);
    ok('ayni uye tekrar: zatenUye', (await js(`/api/root/gruplar/${GID}/uyeler`, { token: rj, body: { tenantId: A.id } })).d.zatenUye === true);
    const ikinci = await js(`/api/root/gruplar/${g2.d.id}/uyeler`, { token: rj, body: { tenantId: A.id } });
    ok('bir isletme iki gruba giremez (409)', ikinci.status === 409 && /yalnızca bir grupta/.test(ikinci.d.message), ikinci.d);
    ok('olmayan isletme 404', (await js(`/api/root/gruplar/${GID}/uyeler`, { token: rj, body: { tenantId: uuid() } })).status === 404);
    const disYon = await js(`/api/root/gruplar/${GID}/yoneticiler`, { token: rj, body: { eposta: C.sahip.eposta } });
    ok('grup disi isletmenin kullanicisi yonetici olamaz (404)', disYon.status === 404, disYon.d);
    const kasYon = await js(`/api/root/gruplar/${GID}/yoneticiler`, { token: rj, body: { eposta: A.kasiyer.eposta } });
    ok('kasiyer yonetici olamaz (400)', kasYon.status === 400, kasYon.d);
    const yon = await js(`/api/root/gruplar/${GID}/yoneticiler`, { token: rj, body: { eposta: A.sahip.eposta.toUpperCase() } });
    ok('A sahibi yonetici (e-posta buyuk harfle de)', yon.status === 201, yon.d);
    const ad = await js(`/api/root/gruplar/${GID}/adaylar`, { token: rj });
    ok('adaylar: yalniz uye isletmelerin sahip / mudurleri', ad.status === 200 && ad.d.length === 4
        && ad.d.every((x) => ['OWNER', 'MANAGER'].includes(x.rol) && [A.id, B.id].includes(x.tenantId))
        && ad.d.find((x) => x.userId === A.sahip.id).yonetici === true, ad.d);
    const ren = await js(`/api/root/gruplar/${GID}`, { token: rj, method: 'PATCH', body: { ad: `${ON} Grubu Yeni` } });
    ok('ad degisti', ren.status === 200 && ren.d.ad === `${ON} Grubu Yeni`);
    const ls = await js('/api/root/gruplar', { token: rj });
    const bu = (ls.d || []).find((x) => x.id === GID);
    ok('liste: uyeler + yoneticiler', bu && bu.uyeler.length === 2 && bu.yoneticiler.length === 1 && bu.yoneticiler[0].gecerli === true
        && bu.uyeler.every((u) => u.lisansDurum === 'AKTIF'), bu);
    const tl = await js('/api/root/tenants', { token: rj });
    const ta = (tl.d || []).find((x) => x.id === A.id), tc = (tl.d || []).find((x) => x.id === C.id);
    ok('isletme listesinde grup adi (rozet)', ta && ta.grup_adi === `${ON} Grubu Yeni` && tc && tc.grup_adi == null, { ta: ta && ta.grup_adi });
    const gl = await query("SELECT islem, tenant_id, ozet FROM yonetim_gunlugu WHERE root_id = ? AND islem = 'sube_grubu'", [rootId]);
    ok('her degisiklik yonetim gunlugunde (olustur x2, uye x2, yonetici, ad)', gl.rows.length === 6, gl.rows.map((x) => x.ozet));
    ok('gunlukte isletme baglantisi (uye ekleme)', gl.rows.some((x) => x.tenant_id === A.id && /eklendi/.test(x.ozet)));

    console.log('\n=== 2) Veri: iki sube + grup disi isletme ===');
    const D = '2026-10-15';
    // A: salon 100 (nakit 60 + kart 40), telefon paketi 50 (nakit), SofraMix 80 (online -> DIGER), acik adisyon 45
    await siparis(A.id, { toplam: 100, kapanis: `${D} 09:00:00`, odemeler: [['NAKIT', 60], ['KREDI_KARTI', 40]] });
    await siparis(A.id, { kanal: 'PAKET_SERVIS', toplam: 50, kapanis: `${D} 12:00:00`, odemeler: [['NAKIT', 50]] });
    await siparis(A.id, { kanal: 'SOFRAMIX', toplam: 80, kapanis: `${D} 15:00:00`, odemeler: [['DIGER', 80]] });
    await siparis(A.id, { toplam: 45, durum: 'OPEN' });
    await siparis(A.id, { toplam: 70, kapanis: `${D} 11:00:00`, durum: 'CANCELLED' });   // iptal: ciroya girmez
    // B: salon 200 (kart) + salon 30 (yemek karti)
    await siparis(B.id, { toplam: 200, kapanis: `${D} 10:00:00`, odemeler: [['KREDI_KARTI', 200]] });
    await siparis(B.id, { toplam: 30, kapanis: `${D} 13:30:00`, odemeler: [['YEMEK_KARTI', 30]] });
    // C (grup disi): ayni gun buyuk satis
    await siparis(C.id, { toplam: 999, kapanis: `${D} 10:00:00`, odemeler: [['NAKIT', 999]] });
    // Gun siniri (ayri gun, 2026-10-20): 23:30 Istanbul = 20:30 UTC (ayni gun); 00:30 Istanbul (21'i) = 21:30 UTC (20'si)
    const S = '2026-10-20';
    await siparis(B.id, { toplam: 11, kapanis: `${S} 20:30:00`, odemeler: [['NAKIT', 11]] });
    await siparis(B.id, { toplam: 22, kapanis: `${S} 21:30:00`, odemeler: [['NAKIT', 22]] });

    const jA = kiraciJeton;
    const jB = await giris(B, B.sahip);
    const PH = { 'x-manager-pin': PIN };

    console.log('\n=== 3) Erisim ===');
    const benA = await js('/api/grup/ben', { token: jA });
    ok('/ben: yonetici grubu ve subeleri gorur (sifresiz)', benA.status === 200 && benA.d.ad === `${ON} Grubu Yeni` && benA.d.subeler.length === 2
        && benA.d.subeler.some((s) => s.tenantId === A.id && s.buSube) && !benA.d.subeler.some((s) => s.tenantId === C.id), benA.d);
    ok('/ben: yonetici olmayan B sahibi 404', (await js('/api/grup/ben', { token: jB })).status === 404);
    ok('/ben: grup disi C sahibi 404', (await js('/api/grup/ben', { token: await giris(C, C.sahip) })).status === 404);
    ok('yonetici sifresi gerekli (basliksiz 403)', (await js('/api/grup/ozet?bas=' + D, { token: jA })).d.code === 'MANAGER_PIN_REQUIRED');
    ok('yanlis yonetici sifresi 403', (await js('/api/grup/ozet?bas=' + D, { token: jA, headers: { 'x-manager-pin': '000000' } })).status === 403);
    const ozB = await js('/api/grup/ozet?bas=' + D, { token: jB });
    ok('yonetici olmayan (B sahibi, gruptaki isletme) 403', ozB.status === 403 && ozB.d.code === 'GRUP_YETKI_YOK', ozB.d);
    const ozM = await js('/api/grup/ozet?bas=' + D, { token: await giris(A, A.mudur), headers: PH });
    ok('ayni isletmenin yonetici olmayan muduru 403', ozM.status === 403, ozM.d);
    ok('kasiyer 403 (rol)', (await js('/api/grup/ozet?bas=' + D, { token: await giris(A, A.kasiyer), headers: PH })).status === 403);
    ok('jetonsuz 401', (await js('/api/grup/ozet')).status === 401);

    console.log('\n=== 4) Gunluk ozet = subelerin kendi gun raporlari ===');
    const oz = await js(`/api/grup/ozet?bas=${D}&bit=${D}`, { token: jA, headers: PH });
    ok('ozet 200', oz.status === 200 && oz.d.toplam && Array.isArray(oz.d.subeler), oz.d);
    const rA = (await gunRaporu(jA, D, PIN)).d, rB = (await gunRaporu(jB, D)).d;
    const T = oz.d.toplam;
    const sA = oz.d.subeler.find((s) => s.tenantId === A.id), sB = oz.d.subeler.find((s) => s.tenantId === B.id);
    ok('grup disi isletme hic yok', oz.d.subeler.length === 2 && !oz.d.subeler.some((s) => s.tenantId === C.id) && !JSON.stringify(oz.d).includes(C.id));
    ok('ciro toplami = rapor A + rapor B', esit(T.ciro, rA.totals.revenue + rB.totals.revenue) && esit(T.ciro, 460), { T: T.ciro, a: rA.totals.revenue, b: rB.totals.revenue });
    ok('sube cirolari = kendi raporlari', esit(sA.ciro, rA.totals.revenue) && esit(sB.ciro, rB.totals.revenue));
    ok('adisyon sayisi = rapor siparis sayisi', T.adisyon === rA.totals.order_count + rB.totals.order_count && T.adisyon === 5 && sA.adisyon === 3);
    ok('masa siparisi = rapor salon', esit(T.masa.tutar, rA.totals.dine_in_revenue + rB.totals.dine_in_revenue) && T.masa.adet === 3 && esit(T.masa.tutar, 330));
    ok('paket = rapor paket + pazaryeri', esit(T.paket.tutar, rA.totals.paket_revenue + rA.totals.marketplace_revenue + rB.totals.paket_revenue + rB.totals.marketplace_revenue)
        && T.paket.adet === 2 && esit(T.paket.telefon.tutar, 50) && esit(T.paket.pazaryeri.tutar, 80) && T.paket.pazaryeri.adet === 1);
    for (const y of ['NAKIT', 'KREDI_KARTI', 'YEMEK_KARTI', 'DIGER']) {
        const oy = Number((T.tahsilat.yontemler.find((x) => x.yontem === y) || {}).tutar || 0);
        ok(`tahsilat ${y} = raporlarin odeme yontemi toplami`, esit(oy, yontemTutari(rA, y) + yontemTutari(rB, y)), { oy, a: yontemTutari(rA, y), b: yontemTutari(rB, y) });
    }
    ok('kasaya giren: nakit 110, kart 240, diger 110 (yemek karti + online), toplam 460', esit(T.tahsilat.nakit, 110) && esit(T.tahsilat.kart, 240)
        && esit(T.tahsilat.diger, 110) && esit(T.tahsilat.toplam, 460), T.tahsilat);
    ok('ortalama adisyon = ciro / adisyon', esit(T.ortalamaAdisyon, 92) && esit(sB.ortalamaAdisyon, 115));
    ok('acik hesaplar (su an)', T.acikHesap.adet === 1 && esit(T.acikHesap.tutar, 45) && sA.acikHesap.adet === 1 && sB.acikHesap.adet === 0);
    ok('lisans durumu + son islem', sA.lisans.durum === 'AKTIF' && sA.lisans.bitis && sA.isyeriKodu === A.kod && typeof sA.sonIslem === 'string');
    ok('donem bilgisi', oz.d.donem.bas === D && oz.d.donem.bit === D && oz.d.donem.gunSayisi === 1 && oz.d.donem.saatDilimi === 'Europe/Istanbul');
    ok('musteri kisisel verisi yok', !/musteri|telefon_no|adres/i.test(JSON.stringify(oz.d)));

    console.log('\n=== 5) Aylik ozet = subelerin kendi ay raporlari ===');
    const ozAy = await js('/api/grup/ozet?bas=2026-10-01&bit=2026-10-31', { token: jA, headers: PH });
    const mA = (await ayRaporu(jA, '2026-10', PIN)).d, mB = (await ayRaporu(jB, '2026-10')).d;
    ok('ay cirosu = ay raporlari toplami', ozAy.status === 200 && esit(ozAy.d.toplam.ciro, mA.totals.revenue + mB.totals.revenue) && esit(ozAy.d.toplam.ciro, 493),
        { oz: ozAy.d && ozAy.d.toplam.ciro, a: mA.totals.revenue, b: mB.totals.revenue });
    ok('ay adisyon = ay raporlari', ozAy.d.toplam.adisyon === mA.totals.cnt + mB.totals.cnt);
    ok('ay salon / paket / pazaryeri = ay raporlari', esit(ozAy.d.toplam.masa.tutar, mA.totals.dine_in + mB.totals.dine_in)
        && esit(ozAy.d.toplam.paket.telefon.tutar, mA.totals.paket + mB.totals.paket)
        && esit(ozAy.d.toplam.paket.pazaryeri.tutar, mA.totals.marketplace + mB.totals.marketplace));

    console.log('\n=== 6) Istanbul gun siniri ===');
    const g20 = await js(`/api/grup/ozet?bas=${S}&bit=${S}`, { token: jA, headers: PH });
    ok('23:30 (Istanbul) siparisi kendi gununde', g20.status === 200 && esit(g20.d.toplam.ciro, 11) && g20.d.toplam.adisyon === 1, g20.d && g20.d.toplam);
    const g21 = await js('/api/grup/ozet?bas=2026-10-21', { token: jA, headers: PH });
    ok('00:30 (Istanbul) siparisi ertesi gunde', esit(g21.d.toplam.ciro, 22) && g21.d.toplam.adisyon === 1, g21.d && g21.d.toplam);
    const r20 = (await gunRaporu(jB, S)).d;
    ok('(bilgi) mevcut gun raporu UTC gunu kullanir: 20 Ekim raporu ikisini de sayar', esit(r20.totals.revenue, 33), r20.totals);

    console.log('\n=== 7) Donem dogrulamasi ===');
    ok('bitis < baslangic 400', (await js('/api/grup/ozet?bas=2026-10-10&bit=2026-10-01', { token: jA, headers: PH })).status === 400);
    ok('94 gun 400', (await js('/api/grup/ozet?bas=2026-07-01&bit=2026-10-02', { token: jA, headers: PH })).status === 400);
    ok('93 gun 200', (await js('/api/grup/ozet?bas=2026-07-01&bit=2026-10-01', { token: jA, headers: PH })).status === 200);
    ok('gecersiz tarih 400', (await js('/api/grup/ozet?bas=2026-02-30', { token: jA, headers: PH })).status === 400);
    const bos = await js('/api/grup/ozet', { token: jA, headers: PH });
    ok('parametresiz: bugun (Istanbul)', bos.status === 200 && bos.d.donem.bas === new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date()));

    console.log('\n=== 8) Destek oturumu ===');
    const ac = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: A.id, sebep: 'Grup testi' } });
    const dg = await js('/api/destek/giris/' + ac.d.jeton, { method: 'POST' });
    ok('destek jetonu alindi', dg.status === 200 && dg.d.token, dg.d);
    const dOz = await js('/api/grup/ozet?bas=' + D, { token: dg.d.token });
    ok('destek oturumunda ozet reddedilir (403 DESTEK_YASAK)', dOz.status === 403 && dOz.d.code === 'DESTEK_YASAK', dOz.d);
    ok('destek oturumunda /ben reddedilir', (await js('/api/grup/ben', { token: dg.d.token })).status === 403);
    await js('/api/root/yonetim/destek/' + ac.d.id + '/kapat', { token: rj, method: 'POST' });

    console.log('\n=== 9) Uyelik degisiklikleri ===');
    const rol = await query("UPDATE users SET role = 'CASHIER' WHERE id = ?", [A.sahip.id]);
    ok('rolu kasiyere dusen yonetici 403', rol && (await js('/api/grup/ozet?bas=' + D, { token: jA, headers: PH })).status === 403);
    ok('liste: yonetici "gecerli degil" isaretli', ((await js('/api/root/gruplar', { token: rj })).d.find((x) => x.id === GID).yoneticiler[0].gecerli) === false);
    await query("UPDATE users SET role = 'OWNER' WHERE id = ?", [A.sahip.id]);
    ok('rol geri: tekrar 200', (await js('/api/grup/ozet?bas=' + D, { token: jA, headers: PH })).status === 200);
    const cik = await js(`/api/root/gruplar/${GID}/uyeler/${A.id}`, { token: rj, method: 'DELETE' });
    ok('A gruptan cikti: yoneticiligi de kaldirildi', cik.status === 200 && cik.d.kaldirilanYonetici === 1, cik.d);
    ok('A sahibi artik grubu goremez (/ben 404)', (await js('/api/grup/ben', { token: jA })).status === 404);
    ok('A sahibi ozet 403', (await js('/api/grup/ozet?bas=' + D, { token: jA, headers: PH })).status === 403);
    ok('A artik baska gruba eklenebilir', (await js(`/api/root/gruplar/${g2.d.id}/uyeler`, { token: rj, body: { tenantId: A.id } })).status === 201);
    const sil = await js(`/api/root/gruplar/${g2.d.id}`, { token: rj, method: 'DELETE' });
    const kalan = await query('SELECT COUNT(*) AS n FROM sube_grup_uyeleri WHERE grup_id = ?', [g2.d.id]);
    ok('grup silinince uyelikleri de silinir', sil.status === 200 && Number(kalan.rows[0].n) === 0);
    ok('silinen grup 404', (await js(`/api/root/gruplar/${g2.d.id}`, { token: rj, method: 'PATCH', body: { ad: 'x' } })).status === 404);
    const yc = await js(`/api/root/gruplar/${GID}/yoneticiler/${A.sahip.id}`, { token: rj, method: 'DELETE' });
    ok('olmayan yoneticiyi kaldirma 404', yc.status === 404);

    await temizle();
    console.log(`\n${pass} gecti, ${fail} kaldi`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await temizle(); } catch (_) {} process.exit(1); });
