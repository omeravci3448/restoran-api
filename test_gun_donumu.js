// Is gunu donumu (K2): isletme Ayarlar'da kapanis saatini secer (0-6); raporlar, panel, islem gunlugu, paket servis
// ve sube grubu ozeti gunu bu saatte dondurur (Istanbul, sabit UTC+3). Senaryo: 20 -> 21 Ekim gecesi 23:30, 00:30,
// 01:30 ve 02:30 satislari; kapanis 00:00 ve 02:00 olan iki isletme; ay siniri (1 Kasim 01:00); gun ortasindaki
// satislarin toplami eski (UTC gunu) hesapla ayni; iki farkli kapanis saatli subeli grup ozeti (tarih + goreli donem).
// Sunucuyu KENDI baslatir (port 47700).  Calistir: node test_gun_donumu.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');
const IG = require('./src/services/isGunu');

const PORT = 47700, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'gun-donumu-test-jwt';
const ON = 'GDT Test';
const EPOSTA_ON = 'gdt-';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 500) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const esit = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;
const sqlZ = (iso) => new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
// Istanbul saati -> SQLite UTC metni
const ist = (gun, saat) => sqlZ(`${gun}T${saat}:00+03:00`);

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

const SIFRE = 'GizliGun!4471';
async function kullaniciEkle(tenantId, slug, rol) {
    const id = uuid();
    const eposta = `${EPOSTA_ON}${rol.toLowerCase()}-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, tenantId, eposta, await bcrypt.hash(SIFRE, 4), rol, rol, new Date().toISOString()]);
    return { id, eposta };
}
async function kiraciKur(ad) {
    const id = uuid();
    const slug = 'gdt-' + crypto.randomBytes(4).toString('hex');
    const kod = String(60000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'TIER_6_10', ?, ?, 1)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, '0533 000 00 00', 'Test Mah.',
            JSON.stringify(['BASE', 'MENU_DIGITAL']), new Date(Date.now() + 200 * 86400000).toISOString()]);
    const sahip = await kullaniciEkle(id, slug, 'OWNER');
    const kasiyer = await kullaniciEkle(id, slug, 'CASHIER');
    return { id, slug, kod, sahip, kasiyer };
}
async function giris(t, k) {
    const r = await js('/api/auth/login', { body: { email: k.eposta, businessCode: t.kod, password: SIFRE } });
    return r.d && r.d.token;
}
async function siparis(tenantId, { kanal = 'DINE_IN', toplam, kapanis, durum = 'CLOSED', odeme = 'NAKIT', urun }) {
    const id = uuid();
    await query(`INSERT INTO orders (id, tenant_id, channel, status, subtotal, total, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, tenantId, kanal, durum, toplam, toplam, kapanis, kapanis]);
    if (durum === 'CLOSED') await query('INSERT INTO payments (id, tenant_id, order_id, method, amount) VALUES (?, ?, ?, ?, ?)', [uuid(), tenantId, id, odeme, toplam]);
    if (urun) await query('INSERT INTO order_items (id, order_id, product_name, qty, unit_price, total) VALUES (?, ?, ?, 1, ?, ?)', [uuid(), id, urun, toplam, toplam]);
    return id;
}

async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%' OR owner_email LIKE '${EPOSTA_ON}%'`);
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        await query('DELETE FROM sube_grup_yoneticileri WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)', [r.id]).catch(() => {});
        await query('DELETE FROM sube_grup_uyeleri WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM paket_musterileri WHERE tenant_id = ?', [r.id]).catch(() => {});
        for (const tb of ['payments', 'islem_gunlugu', 'orders', 'users']) {
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('temizle', tb, e.message));
        }
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM sube_gruplari WHERE ad LIKE '${ON}%'`).catch(() => {});
}

const rapor = (token, gun) => js('/api/reports/day' + (gun ? '?date=' + gun : ''), { token });
const ayRaporu = (token, ay) => js('/api/reports/month' + (ay ? '?month=' + ay : ''), { token });
const gunluSatir = (ay, gun) => (ay.daily.find((x) => x.day === gun) || { revenue: 0 });

(async () => {
    console.log('=== 1) Yardimci (services/isGunu.js) ===');
    // 20 -> 21 Ekim gecesi (Istanbul)
    const an = { s2330: `2026-10-20T23:30:00+03:00`, s0030: `2026-10-21T00:30:00+03:00`, s0130: `2026-10-21T01:30:00+03:00`, s0230: `2026-10-21T02:30:00+03:00` };
    const g = (k, h) => IG.isGunu(new Date(an[k]), h);
    ok('kapanis 00:00: 23:30 -> 20, 00:30 / 01:30 / 02:30 -> 21',
        g('s2330', 0) === '2026-10-20' && g('s0030', 0) === '2026-10-21' && g('s0130', 0) === '2026-10-21' && g('s0230', 0) === '2026-10-21');
    ok('kapanis 02:00: 23:30 / 00:30 / 01:30 -> 20, 02:30 -> 21',
        g('s2330', 2) === '2026-10-20' && g('s0030', 2) === '2026-10-20' && g('s0130', 2) === '2026-10-20' && g('s0230', 2) === '2026-10-21');
    ok('tam 02:00 yeni gune ait (sinir dahil)', IG.isGunu(new Date('2026-10-21T02:00:00+03:00'), 2) === '2026-10-21'
        && IG.isGunu(new Date('2026-10-21T01:59:59+03:00'), 2) === '2026-10-20');
    ok('gun araligi (UTC): 0 -> 19 21:00 .. 20 21:00; 2 -> 19 23:00 .. 20 23:00',
        JSON.stringify(IG.aralikUtc('2026-10-20', '2026-10-20', 0)) === JSON.stringify({ basUtc: '2026-10-19 21:00:00', bitUtc: '2026-10-20 21:00:00' })
        && JSON.stringify(IG.aralikUtc('2026-10-20', '2026-10-20', 2)) === JSON.stringify({ basUtc: '2026-10-19 23:00:00', bitUtc: '2026-10-20 23:00:00' }));
    ok('ay araligi (Aralik, kapanis 06:00): 1 Ara 03:00 UTC .. 1 Oca 03:00 UTC',
        JSON.stringify(IG.ayAraligiUtc('2026-12', 6)) === JSON.stringify({ basUtc: '2026-12-01 03:00:00', bitUtc: '2027-01-01 03:00:00' }));
    ok('gecersiz saat 0 sayilir', IG.saatNorm(7) === 0 && IG.saatNorm(-1) === 0 && IG.saatNorm('x') === 0 && IG.saatNorm(null) === 0 && IG.saatNorm('3') === 3);
    const P = require('./src/services/paketServis');
    ok('paket gunu yardimcisi kapanis saatini izler', P.istanbulGunu(new Date(an.s0130), 2) === '2026-10-20' && P.istanbulGunu(new Date(an.s0130)) === '2026-10-21'
        && P.istanbulGunBasiUtc(new Date(an.s0130), 2) === '2026-10-19 23:00:00');

    initDb(); await uyu(1200); await temizle();
    const env = { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' };
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: 'ignore' });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    const A = await kiraciKur('Sifir');     // kapanis 00:00 (varsayilan)
    const B = await kiraciKur('Iki');       // kapanis 02:00
    const jA = await giris(A, A.sahip), jB = await giris(B, B.sahip), jK = await giris(B, B.kasiyer);

    console.log('\n=== 2) Ayarlar: kapanis saati ===');
    const p0 = await js('/api/tenant/me', { token: jB });
    ok('varsayilan 0', p0.status === 200 && Number(p0.d.gun_donumu_saat) === 0, p0.d && p0.d.gun_donumu_saat);
    ok('7 reddedilir (400)', (await js('/api/tenant/me', { token: jB, method: 'PUT', body: { gunDonumuSaat: 7 } })).status === 400);
    ok('1.5 reddedilir (400)', (await js('/api/tenant/me', { token: jB, method: 'PUT', body: { gunDonumuSaat: 1.5 } })).status === 400);
    ok('bos reddedilir (400)', (await js('/api/tenant/me', { token: jB, method: 'PUT', body: { gunDonumuSaat: '' } })).status === 400);
    ok('kasiyer degistiremez (403)', (await js('/api/tenant/me', { token: jK, method: 'PUT', body: { gunDonumuSaat: 2 } })).status === 403);
    const kay = await js('/api/tenant/me', { token: jB, method: 'PUT', body: { gunDonumuSaat: 2 } });
    ok('sahip 02:00 secer (200)', kay.status === 200, kay.d);
    ok('okunan deger 2', Number((await js('/api/tenant/me', { token: jB })).d.gun_donumu_saat) === 2);
    await js('/api/tenant/me', { token: jB, method: 'PUT', body: { phone: '0533 111 11 11' } });
    ok('alan gelmezse dokunulmaz', Number((await js('/api/tenant/me', { token: jB })).d.gun_donumu_saat) === 2);

    console.log('\n=== 3) Gun raporu: 20 -> 21 Ekim gecesi ===');
    for (const t of [A, B]) {
        await siparis(t.id, { toplam: 5, kapanis: ist('2026-10-20', '12:00'), urun: 'Corba' });
        await siparis(t.id, { toplam: 10, kapanis: ist('2026-10-20', '23:30'), urun: 'Kebap' });
        await siparis(t.id, { toplam: 20, kapanis: ist('2026-10-21', '00:30'), urun: 'Kebap', odeme: 'KREDI_KARTI' });
        await siparis(t.id, { kanal: 'PAKET_SERVIS', toplam: 40, kapanis: ist('2026-10-21', '01:30'), urun: 'Pide' });
        await siparis(t.id, { toplam: 80, kapanis: ist('2026-10-21', '02:30'), urun: 'Pide' });
        await siparis(t.id, { toplam: 7, kapanis: ist('2026-10-21', '12:00'), urun: 'Corba' });
        await siparis(t.id, { toplam: 3, kapanis: ist('2026-11-01', '01:00'), urun: 'Ayran' });   // ay siniri
        await siparis(t.id, { toplam: 99, kapanis: ist('2026-10-21', '01:00'), durum: 'CANCELLED' });   // iptal: ciroya girmez
    }
    const a20 = (await rapor(jA, '2026-10-20')).d, a21 = (await rapor(jA, '2026-10-21')).d;
    const b20 = (await rapor(jB, '2026-10-20')).d, b21 = (await rapor(jB, '2026-10-21')).d;
    ok('kapanis 00:00: 20 Ekim = 12:00 + 23:30 = 15 (2 adisyon)', esit(a20.totals.revenue, 15) && a20.totals.order_count === 1 + 1, a20.totals);
    ok('kapanis 00:00: 21 Ekim = 00:30 + 01:30 + 02:30 + 12:00 = 147', esit(a21.totals.revenue, 147) && a21.totals.order_count === 4, a21.totals);
    ok('kapanis 02:00: 20 Ekim = 12:00 + 23:30 + 00:30 + 01:30 = 75', esit(b20.totals.revenue, 75) && b20.totals.order_count === 4, b20.totals);
    ok('kapanis 02:00: 21 Ekim = 02:30 + 12:00 = 87', esit(b21.totals.revenue, 87) && b21.totals.order_count === 2, b21.totals);
    ok('kapanis 02:00: paket (01:30) onceki gunde', esit(b20.totals.paket_revenue, 40) && esit(b21.totals.paket_revenue, 0));
    const yontem = (r, m) => Number((r.byPayment.find((x) => x.method === m) || {}).amount || 0);
    ok('odeme yontemi ayni gun sinirini izler', esit(yontem(b20, 'KREDI_KARTI'), 20) && esit(yontem(b20, 'NAKIT'), 55)
        && esit(yontem(a20, 'KREDI_KARTI'), 0) && esit(yontem(a21, 'KREDI_KARTI'), 20));
    const urun = (r, ad) => Number((r.topProducts.find((x) => x.name === ad) || {}).revenue || 0);
    ok('en cok satanlar ayni gun sinirini izler', esit(urun(b20, 'Pide'), 40) && esit(urun(b21, 'Pide'), 80) && esit(urun(a21, 'Pide'), 120));
    ok('cevapta is gunu ve kapanis saati', a20.day === '2026-10-20' && a20.gunDonumuSaat === 0 && b20.gunDonumuSaat === 2);
    ok('gecersiz tarih 400', (await rapor(jB, '2026-02-30')).status === 400 && (await rapor(jB, 'dun')).status === 400);
    const varsA = (await rapor(jA)).d, varsB = (await rapor(jB)).d;
    ok('tarihsiz (Panel "bugun"): isletmenin icinde bulunulan is gunu', varsA.day === IG.isGunu(new Date(), 0) && varsB.day === IG.isGunu(new Date(), 2),
        { a: varsA.day, b: varsB.day });

    console.log('\n=== 4) Gun ortasi toplamlari degismez ===');
    const D = '2026-10-15';
    for (const t of [A, B]) {
        await siparis(t.id, { toplam: 110, kapanis: ist(D, '08:15') });
        await siparis(t.id, { toplam: 220, kapanis: ist(D, '14:40'), odeme: 'KREDI_KARTI' });
        await siparis(t.id, { kanal: 'SOFRAMIX', toplam: 33, kapanis: ist(D, '20:59'), odeme: 'DIGER' });
    }
    const eski = async (tid) => Number((await query(
        "SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE tenant_id = ? AND status = 'CLOSED' AND substr(closed_at, 1, 10) = ?", [tid, D])).rows[0].s);
    const a15 = (await rapor(jA, D)).d, b15 = (await rapor(jB, D)).d;
    ok('gun ortasi: iki kapanis saatinde ayni toplam (363)', esit(a15.totals.revenue, 363) && esit(b15.totals.revenue, 363));
    ok('gun ortasi: eski (UTC gunu) hesapla ayni', esit(a15.totals.revenue, await eski(A.id)) && esit(b15.totals.revenue, await eski(B.id)));
    ok('gun ortasi: kanal ve odeme kirilimi ayni', esit(a15.totals.marketplace_revenue, b15.totals.marketplace_revenue)
        && esit(yontem(a15, 'KREDI_KARTI'), yontem(b15, 'KREDI_KARTI')) && esit(yontem(a15, 'DIGER'), 33));

    console.log('\n=== 5) Aylik rapor ===');
    const aEk = (await ayRaporu(jA, '2026-10')).d, bEk = (await ayRaporu(jB, '2026-10')).d;
    const aKa = (await ayRaporu(jA, '2026-11')).d, bKa = (await ayRaporu(jB, '2026-11')).d;
    ok('Ekim toplami: 00:00 -> 525 (1 Kasim 01:00 Kasim\'da), 02:00 -> 528 (31 Ekim\'e yazilir)',
        esit(aEk.totals.revenue, 525) && esit(bEk.totals.revenue, 528), { a: aEk.totals.revenue, b: bEk.totals.revenue });
    ok('Kasim: 00:00 -> 3, 02:00 -> 0', esit(aKa.totals.revenue, 3) && esit(bKa.totals.revenue, 0));
    ok('gun gun dokum (00:00): 20 -> 15, 21 -> 147', esit(gunluSatir(aEk, '2026-10-20').revenue, 15) && esit(gunluSatir(aEk, '2026-10-21').revenue, 147));
    ok('gun gun dokum (02:00): 20 -> 75, 21 -> 87, 31 -> 3', esit(gunluSatir(bEk, '2026-10-20').revenue, 75)
        && esit(gunluSatir(bEk, '2026-10-21').revenue, 87) && esit(gunluSatir(bEk, '2026-10-31').revenue, 3), bEk.daily);
    ok('gun gun dokum gun raporlariyla ayni (adet)', Number(gunluSatir(bEk, '2026-10-20').cnt) === b20.totals.order_count
        && Number(gunluSatir(aEk, '2026-10-21').cnt) === a21.totals.order_count);
    ok('gun gun dokum toplami = ay toplami', esit(bEk.daily.reduce((s, x) => s + Number(x.revenue), 0), bEk.totals.revenue));
    ok('gecersiz ay 400', (await ayRaporu(jB, '2026-13')).status === 400);
    ok('aysiz: icinde bulunulan is gununun ayi', (await ayRaporu(jB)).d.month === IG.isGunu(new Date(), 2).slice(0, 7));

    console.log('\n=== 6) Islem gunlugu gun filtresi ===');
    for (const t of [A, B]) {
        await query('INSERT INTO islem_gunlugu (id, tenant_id, user_name, islem, detay, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [uuid(), t.id, 'Test', 'siparis_iptal', 'gdt-gece', ist('2026-10-21', '01:30')]);
    }
    const gl = async (tok, gun) => ((await js('/api/reports/islem-gunlugu?gun=' + gun, { token: tok })).d || []).filter((x) => x.detay === 'gdt-gece').length;
    ok('01:30 kaydi: 00:00 isletmede 21 Ekim, 02:00 isletmede 20 Ekim', await gl(jA, '2026-10-21') === 1 && await gl(jA, '2026-10-20') === 0
        && await gl(jB, '2026-10-20') === 1 && await gl(jB, '2026-10-21') === 0);

    console.log('\n=== 7) Paket servis ===');
    const simdi = new Date();
    const bugunB = IG.isGunu(simdi, 2);
    await query(`INSERT INTO orders (id, tenant_id, channel, status, total, opened_at, paket_no, paket_gunu) VALUES (?, ?, 'PAKET_SERVIS', 'CANCELLED', 0, ?, 5, ?)`,
        [uuid(), B.id, sqlZ(simdi.toISOString()), bugunB]);
    const yeni = await js('/api/paket', { token: jB, body: { musteriAd: 'Test Musteri', teslimat: 'GEL_AL', odemeSekli: 'kapida_nakit' } });
    const satir = yeni.d && (await query('SELECT paket_no, paket_gunu FROM orders WHERE id = ?', [yeni.d.id])).rows[0];
    ok('yeni paket: paket gunu = is gunu, numara ayni gun icinde artar', yeni.status === 201 && satir && satir.paket_gunu === bugunB && Number(satir.paket_no) === 6,
        { s: yeni.status, satir, bugunB });
    // "Bugun tamamlanan": is gunu basindan once kapanan dusmez, sonra kapanan gorunur
    const basA = IG.gunBasiUtc(IG.isGunu(simdi, 0), 0), basB = IG.gunBasiUtc(bugunB, 2);
    const once = sqlZ(Date.parse(basB.replace(' ', 'T') + 'Z') - 30 * 60000), sonra = sqlZ(Date.parse(basB.replace(' ', 'T') + 'Z') + 30 * 60000);
    const idOnce = {}, idSonra = {};
    for (const t of [A, B]) {
        idOnce[t.id] = await siparis(t.id, { kanal: 'PAKET_SERVIS', toplam: 12, kapanis: once });
        idSonra[t.id] = await siparis(t.id, { kanal: 'PAKET_SERVIS', toplam: 13, kapanis: sonra });
    }
    const listeB = ((await js('/api/paket', { token: jB })).d || {}).siparisler || [];
    const listeA = ((await js('/api/paket', { token: jA })).d || {}).siparisler || [];
    const var_ = (l, id) => l.some((x) => x.id === id);
    ok('02:00 isletme: gun basindan 30 dk once kapanan listede yok, 30 dk sonra kapanan var',
        !var_(listeB, idOnce[B.id]) && var_(listeB, idSonra[B.id]));
    ok('00:00 isletme: ayni siparisler kendi gun basina gore', var_(listeA, idOnce[A.id]) === (once >= basA) && var_(listeA, idSonra[A.id]) === (sonra >= basA));

    console.log('\n=== 8) Sube grubu: iki farkli kapanis saati ===');
    const GID = uuid();
    await query('INSERT INTO sube_gruplari (id, ad) VALUES (?, ?)', [GID, `${ON} Grubu`]);
    await query('INSERT INTO sube_grup_uyeleri (grup_id, tenant_id) VALUES (?, ?), (?, ?)', [GID, A.id, GID, B.id]);
    await query('INSERT INTO sube_grup_yoneticileri (grup_id, user_id) VALUES (?, ?)', [GID, A.sahip.id]);
    const oz = async (q) => js('/api/grup/ozet' + q, { token: jA });
    const sube = (o, t) => o.d.subeler.find((s) => s.tenantId === t.id);
    const o20 = await oz('?bas=2026-10-20'), o21 = await oz('?bas=2026-10-21&bit=2026-10-21');
    ok('20 Ekim: A 15, B 75, toplam 90', o20.status === 200 && esit(sube(o20, A).ciro, 15) && esit(sube(o20, B).ciro, 75) && esit(o20.d.toplam.ciro, 90),
        o20.d && o20.d.subeler.map((s) => s.ciro));
    ok('21 Ekim: A 147, B 87, toplam 234', esit(sube(o21, A).ciro, 147) && esit(sube(o21, B).ciro, 87) && esit(o21.d.toplam.ciro, 234));
    ok('grup rakamlari subelerin kendi gun raporlariyla ayni (ciro, adisyon, tahsilat)',
        esit(sube(o20, B).ciro, b20.totals.revenue) && sube(o20, B).adisyon === b20.totals.order_count
        && esit(sube(o20, B).tahsilat.kart, yontem(b20, 'KREDI_KARTI')) && esit(sube(o20, A).tahsilat.toplam, 15)
        && esit(sube(o20, B).paket.telefon.tutar, b20.totals.paket_revenue));
    ok('subede kapanis saati ve donem', sube(o20, A).gunDonumuSaat === 0 && sube(o20, B).gunDonumuSaat === 2
        && sube(o20, B).donem.bas === '2026-10-20' && o20.d.donem.kod === 'ozel' && o20.d.donem.gunDonumu === 'sube');
    const oEkim = await oz('?bas=2026-10-01&bit=2026-10-31');
    ok('Ekim (tarih araligi): A 525, B 528 (ay raporlariyla ayni)', esit(sube(oEkim, A).ciro, aEk.totals.revenue) && esit(sube(oEkim, B).ciro, bEk.totals.revenue));
    ok('gecersiz donem kodu 400', (await oz('?donem=yarin')).status === 400);
    ok('donem=bugun 200 ve kod donuyor', (await oz('?donem=bugun')).d.donem.kod === 'bugun');
    // Goreli donem: her sube KENDI bugunune gore. 22 Ekim 01:30 (Istanbul): A icin bugun 22, B icin hala 21.
    const G = require('./src/services/grupOzet');
    const gece = new Date('2026-10-22T01:30:00+03:00');
    const ob = await G.ozet({ id: GID, ad: 'x' }, { donem: 'bugun' }, gece);
    const sb = (o, t) => o.subeler.find((s) => s.tenantId === t.id);
    ok('gece 01:30 "Bugun": A 22 Ekim (0), B 21 Ekim (87)', sb(ob, A).donem.bas === '2026-10-22' && esit(sb(ob, A).ciro, 0)
        && sb(ob, B).donem.bas === '2026-10-21' && esit(sb(ob, B).ciro, 87), ob.subeler.map((s) => [s.donem, s.ciro]));
    ok('grup donemi iki gunu kapsar (21 - 22 Ekim)', ob.donem.bas === '2026-10-21' && ob.donem.bit === '2026-10-22' && ob.donem.kod === 'bugun');
    const od = await G.ozet({ id: GID, ad: 'x' }, { donem: 'dun' }, gece);
    ok('gece 01:30 "Dun": A 21 Ekim (147), B 20 Ekim (75)', esit(sb(od, A).ciro, 147) && esit(sb(od, B).ciro, 75) && esit(od.toplam.ciro, 222));
    const og = await G.ozet({ id: GID, ad: 'x' }, { donem: 'bugun' }, new Date('2026-10-21T15:00:00+03:00'));
    ok('gun ortasi "Bugun": iki sube de 21 Ekim', sb(og, A).donem.bas === '2026-10-21' && sb(og, B).donem.bas === '2026-10-21'
        && og.donem.bas === '2026-10-21' && og.donem.bit === '2026-10-21');
    const oay = await G.ozet({ id: GID, ad: 'x' }, { donem: 'ay' }, new Date('2026-11-01T01:30:00+03:00'));
    ok('1 Kasim 01:30 "Bu ay": A Kasim (3), B hala Ekim (528)', sb(oay, A).donem.bas === '2026-11-01' && esit(sb(oay, A).ciro, 3)
        && sb(oay, B).donem.bas === '2026-10-01' && sb(oay, B).donem.bit === '2026-10-31' && esit(sb(oay, B).ciro, 528));

    await temizle();
    console.log(`\n${pass} gecti, ${fail} kaldi`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await temizle(); } catch (_) {} process.exit(1); });
