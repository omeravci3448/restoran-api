// Lansman kampanyasi "%50 lansman indirimi" (2026-11-18). Kapsam: uygunluk (kayit tarihi <= son kayit gunu, Istanbul gun
// sonu; SofraMix kanali haric; yalniz ilk alim; odeme son gunu = deneme bitis gunu + N gun), birlesmeme (en buyuk indirim),
// teklif ve kayit alanlari, "Odemeyi yaptim" son gunden sonra 409 KAMPANYA_SURESI_DOLDU, iptal + yeniden talep indirimsiz,
// ayar dogrulamasi, tanitim ucu, yenileme-kanali bilgisi, root listesi. Sunucuyu KENDI baslatir.
// Calistir: node test_lansman.js   (port 47610)
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47610, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'lansman-test-jwt';
const ON = 'LNS Test';
const EPOSTA_ON = 'lns-';
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
const istGun = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const gunEkle = (g, n) => { const [y, m, d] = g.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const sqlZaman = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

async function kiraciKur({ ad, tier = 'TIER_DENEME', bitis, olusturma = new Date(Date.now() - 2 * GUN), indirim = 0, parentOrg = null }) {
    const id = uuid();
    const slug = 'lns-' + crypto.randomBytes(4).toString('hex');
    const kod = String(70000 + (KOD_TABAN + kodSayac++) % 9999);
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, is_active, created_at, discount_rate, parent_org, billing_name, billing_tax_id, billing_address)
         VALUES (?, ?, ?, ?, ?, '05320000000', 'Test Mah. 1', ?, '["BASE","MENU_DIGITAL"]', ?, 1, ?, ?, ?, 'Test', '12345678901', 'Test Mah. 1, Afyon')`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, tier, bitis.toISOString(), sqlZaman(olusturma), indirim, parentOrg]);
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

const AYARLAR = ['lansman_acik', 'lansman_yuzde', 'lansman_kayit_son', 'lansman_odeme_gun'];
let katalogYedek = null, ayarYedek = null;
async function ayarYaz(anahtar, deger) {
    if (deger == null) return query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [anahtar]);
    return query(`INSERT INTO sistem_ayarlari (anahtar, deger, guncellendi_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger`, [anahtar, String(deger)]);
}
async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%' OR owner_email LIKE '${EPOSTA_ON}%'`);
    for (const r of t.rows) {
        for (const tb of ['lisans_odemeleri', 'deneme_kayitlari', 'root_olaylar', 'license_cache', 'islem_gunlugu', 'yonetim_gunlugu', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    if (katalogYedek) for (const x of katalogYedek) await query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [x.fiyat, x.gorunur, x.id]);
    if (ayarYedek) {
        await query(`DELETE FROM sistem_ayarlari WHERE anahtar IN (${AYARLAR.map(() => '?').join(', ')})`, AYARLAR);
        for (const x of ayarYedek) await query('INSERT INTO sistem_ayarlari (anahtar, deger, guncellendi_at) VALUES (?, ?, ?)', [x.anahtar, x.deger, x.guncellendi_at]);
    }
}

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    katalogYedek = (await query('SELECT id, fiyat, gorunur FROM lisans_katalog')).rows;
    ayarYedek = (await query(`SELECT anahtar, deger, guncellendi_at FROM sistem_ayarlari WHERE anahtar IN (${AYARLAR.map(() => '?').join(', ')})`, AYARLAR)).rows;
    await query(`DELETE FROM sistem_ayarlari WHERE anahtar IN (${AYARLAR.map(() => '?').join(', ')})`, AYARLAR);
    await query("UPDATE lisans_katalog SET fiyat = 4000, gorunur = 1 WHERE id = 'TIER-TIER_1_5'");
    await query("UPDATE lisans_katalog SET fiyat = 1000, gorunur = 1 WHERE id = 'MODUL-MENU_DIGITAL'");
    const SECIM = { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL'] };   // 5000 TL yillik (KDV haric)

    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();
    const LK = require('./src/services/lansmanKampanya');

    console.log('=== 0) Varsayilanlar ve yardimcilar ===');
    const a0 = await LK.ayarlar();
    ok('varsayilan: acik, %50, 2026-11-30, 1 gun', a0.acik === true && a0.yuzde === 50 && a0.kayitSon === '2026-11-30' && a0.odemeGun === 1, a0);
    ok('gunSonu Istanbul: 2026-11-30 23:59:59 +03', LK.gunSonu('2026-11-30').toISOString() === '2026-11-30T20:59:59.999Z');
    ok('gunEkle ay sonu', LK.gunEkle('2026-11-30', 1) === '2026-12-01' && LK.gunTR('2026-12-01') === '01.12.2026');
    ok('gecerliGun', LK.gecerliGun('2026-02-28') && !LK.gecerliGun('2026-02-30') && !LK.gecerliGun('30.11.2026'));
    // Testler bugunun tarihine bagli kalmasin: son kayit gunu ileri bir tarih
    const ILERI = gunEkle(istGun(new Date()), 30);
    await ayarYaz('lansman_kayit_son', ILERI);

    console.log('\n=== 1) Uygun deneme isletmesi: teklif, kayit, liste ===');
    const denemeBitis = new Date(Date.now() + 3 * GUN);
    const a = await kiraciKur({ ad: 'Uygun', bitis: denemeBitis });
    ok('giris', a.girisDurumu === 200 && !!a.token, a);
    const beklenenSon = gunEkle(istGun(denemeBitis), 1);
    const q = (await js('/api/license/quote', { token: a.token, body: SECIM })).d;
    ok('teklif: ilk alim, %50 lansman, son gun = deneme bitisi + 1', q.tur === 'ilk' && q.kampanyaOrani === 50 && q.kampanyaSonGun === beklenenSon
        && q.discountRate === 50 && q.subtotal === 5000 && q.total === 2500 && q.odenecek === 2500, q);
    ok('KDV indirimli tutar uzerinden', q.araToplam === 2500 && q.genelToplam === 3000, q);
    const yk = (await js('/api/license/yenileme-kanali', { token: a.token })).d;
    ok('yenileme-kanali: lansman bilgisi', yk.lansman && yk.lansman.yuzde === 50 && yk.lansman.sonGun === beklenenSon, yk.lansman);
    const s = await js('/api/license/purchase', { token: a.token, body: SECIM });
    ok('talep 201, kampanya alanlari', s.status === 201 && s.d.kampanyaOrani === 50 && s.d.kampanyaSonGun === beklenenSon && s.d.odenecek === 2500, s.d);
    const kay = (await query('SELECT * FROM lisans_odemeleri WHERE id = ?', [s.d.id])).rows[0];
    ok('kayda kampanya orani ve son gun yazildi', Number(kay.kampanya_orani) === 50 && kay.kampanya_son_gun === beklenenSon && Number(kay.tutar) === 2500, kay);
    const liste = (await js('/api/license/purchases', { token: a.token })).d;
    ok('musteri listesi kampanya alanlarini verir', liste[0] && Number(liste[0].kampanya_orani) === 50 && liste[0].kampanya_son_gun === beklenenSon, liste[0]);
    const tekil = (await js(`/api/license/purchases/${s.d.id}`, { token: a.token })).d;
    ok('tekil kayit kampanya alanlarini verir', Number(tekil.kampanya_orani) === 50 && tekil.kampanya_son_gun === beklenenSon, tekil);
    const rk = (await js('/api/root/lisans-odemeleri', { token: rj })).d.find((x) => x.id === s.d.id);
    ok('root listesinde kampanya', rk && Number(rk.kampanya_orani) === 50 && rk.kampanya_son_gun === beklenenSon, rk);

    console.log('\n=== 2) Son gunden sonra "Odemeyi yaptim" 409, iptal + yeniden talep indirimsiz ===');
    await query('UPDATE lisans_odemeleri SET kampanya_son_gun = ? WHERE id = ?', [gunEkle(istGun(new Date()), -1), s.d.id]);
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [new Date(Date.now() - 3 * GUN).toISOString(), a.id]);
    const mp = await js(`/api/license/purchases/${s.d.id}/mark-paid`, { token: a.token, body: {} });
    ok('409 KAMPANYA_SURESI_DOLDU + mesaj', mp.status === 409 && mp.d.code === 'KAMPANYA_SURESI_DOLDU'
        && mp.d.message === 'Lansman indirimi süresi doldu. Lütfen seçiminizi yenileyin; yeni tutar indirimsiz hesaplanır.', mp);
    const kay2 = (await query('SELECT odeme_bildirildi_at, durum FROM lisans_odemeleri WHERE id = ?', [s.d.id])).rows[0];
    ok('kayit bildirilmedi, beklemede', !kay2.odeme_bildirildi_at && kay2.durum === 'beklemede', kay2);
    const ip = await js(`/api/license/purchases/${s.d.id}/cancel`, { token: a.token, body: {} });
    ok('iptal', ip.status === 200, ip);
    const s2 = await js('/api/license/purchase', { token: a.token, body: SECIM });
    ok('yeni talep indirimsiz', s2.status === 201 && !s2.d.kampanyaOrani && s2.d.odenecek === 5000, s2.d);
    const mp2 = await js(`/api/license/purchases/${s2.d.id}/mark-paid`, { token: a.token, body: {} });
    ok('indirimsiz kayitta odemeyi yaptim 200', mp2.status === 200, mp2);

    console.log('\n=== 3) Zamaninda bildirilen kayit sonradan etkilenmez ===');
    const b = await kiraciKur({ ad: 'Zamaninda', bitis: new Date(Date.now() + 2 * GUN) });
    const sb = await js('/api/license/purchase', { token: b.token, body: SECIM });
    const mb = await js(`/api/license/purchases/${sb.d.id}/mark-paid`, { token: b.token, body: { paymentRef: 'ilk' } });
    ok('son gun icinde odemeyi yaptim 200', sb.d.kampanyaOrani === 50 && mb.status === 200, [sb.d, mb]);
    await query('UPDATE lisans_odemeleri SET kampanya_son_gun = ? WHERE id = ?', [gunEkle(istGun(new Date()), -2), sb.d.id]);
    const mb2 = await js(`/api/license/purchases/${sb.d.id}/mark-paid`, { token: b.token, body: { paymentRef: 'not guncel' } });
    ok('zaten bildirilmis kayitta tekrar basmak 200 (engellenmez)', mb2.status === 200, mb2);
    const onay = await js(`/api/root/lisans-odemeleri/${sb.d.id}/onayla`, { token: rj, body: { gun: 365 } });
    ok('root onayi indirimli tutarla', onay.status === 200, onay);
    const sonra = await LK.uygunluk(b.id);
    ok('onayli odemeden sonra kampanya yok (yalniz ilk alim)', sonra.uygun === false, sonra);

    console.log('\n=== 4) Birlesmez: en buyuk indirim ===');
    const c = await kiraciKur({ ad: 'Indirim60', bitis: new Date(Date.now() + 3 * GUN), indirim: 60 });
    const qc = (await js('/api/license/quote', { token: c.token, body: SECIM })).d;
    ok('kiraci %60 > kampanya: kampanya yok, %60', !qc.kampanyaOrani && qc.discountRate === 60 && qc.total === 2000, qc);
    const ykc = (await js('/api/license/yenileme-kanali', { token: c.token })).d;
    ok('kiraci indirimi buyukse seritte kampanya yok', !ykc.lansman, ykc.lansman);
    const d = await kiraciKur({ ad: 'Indirim20', bitis: new Date(Date.now() + 3 * GUN), indirim: 20 });
    const qd = (await js('/api/license/quote', { token: d.token, body: SECIM })).d;
    ok('kiraci %20 < kampanya: yalniz %50 (toplanmaz)', qd.kampanyaOrani === 50 && qd.discountRate === 50 && qd.total === 2500, qd);

    console.log('\n=== 5) Haric tutulanlar ===');
    const e = await kiraciKur({ ad: 'SmxDevir', bitis: new Date(Date.now() + 3 * GUN) });
    await query("INSERT INTO deneme_kayitlari (id, tenant_id, telefon_norm, kaynak) VALUES (?, ?, '5320000000', 'soframix-devir')", [uuid(), e.id]);
    const qe = (await js('/api/license/quote', { token: e.token, body: SECIM })).d;
    ok('SofraMix deneme devri: kampanya yok', !qe.kampanyaOrani && qe.discountRate === 0, qe);
    ok('uygunluk sebebi soframix', (await LK.uygunluk(e.id)).sebep === 'soframix');
    const f = await kiraciKur({ ad: 'SmxUst', bitis: new Date(Date.now() + 3 * GUN), parentOrg: 'SofraMix' });
    ok('parent_org SofraMix: uygun degil', (await LK.uygunluk(f.id)).sebep === 'soframix');
    const g = await kiraciKur({ ad: 'Gec', bitis: new Date(Date.now() + 3 * GUN), olusturma: new Date(Date.now() - 2 * GUN) });
    await ayarYaz('lansman_kayit_son', gunEkle(istGun(new Date()), -3));
    const qg = (await js('/api/license/quote', { token: g.token, body: SECIM })).d;
    ok('son kayit gununden sonra kayit: kampanya yok', !qg.kampanyaOrani, qg);
    ok('uygunluk sebebi kayit_tarihi', (await LK.uygunluk(g.id)).sebep === 'kayit_tarihi');
    const pub0 = (await js('/api/public/lansman')).d;
    ok('tanitim ucu: son kayit gunu gecti -> acik false', pub0 && pub0.acik === false, pub0);
    await ayarYaz('lansman_kayit_son', gunEkle(istGun(new Date()), -1));
    const h = await kiraciKur({ ad: 'SinirIci', bitis: new Date(Date.now() + 3 * GUN), olusturma: new Date(LK.gunSonu(gunEkle(istGun(new Date()), -1)).getTime() - 60000) });
    ok('son kayit gununun son dakikasinda kayit: uygun', (await LK.uygunluk(h.id)).uygun === true, await LK.uygunluk(h.id));
    await ayarYaz('lansman_kayit_son', ILERI);
    const i = await kiraciKur({ ad: 'DenemeBitti', bitis: new Date(Date.now() - 2 * GUN) });
    ok('deneme 2 gun once bitti (+1 gun): suresi doldu', (await LK.uygunluk(i.id)).sebep === 'suresi_doldu');
    const dun = new Date(LK.gunSonu(gunEkle(istGun(new Date()), -1)).getTime() - 3600000);
    const j = await kiraciKur({ ad: 'DunBitti', bitis: dun });
    const uj = await LK.uygunluk(j.id);
    ok('deneme dun bitti: bugun son gun, uygun', uj.uygun === true && uj.sonGun === istGun(new Date()), uj);
    const k = await kiraciKur({ ad: 'Musteri', tier: 'TIER_1_5', bitis: new Date(Date.now() + 200 * GUN), olusturma: new Date(Date.now() - 200 * GUN) });
    const qk = (await js('/api/license/quote', { token: k.token, body: SECIM })).d;
    ok('deneme olmayan isletme (yenileme): kampanya yok', qk.tur !== 'ilk' && !qk.kampanyaOrani, qk);
    await ayarYaz('lansman_acik', 0);
    const qa = (await js('/api/license/quote', { token: d.token, body: SECIM })).d;
    ok('kampanya kapali: indirim yalniz kiraci indirimi', !qa.kampanyaOrani && qa.discountRate === 20, qa);
    const pub1 = (await js('/api/public/lansman')).d;
    ok('tanitim ucu: kapali', pub1 && pub1.acik === false, pub1);
    await ayarYaz('lansman_acik', null);

    console.log('\n=== 6) Ayarlar (root) ve tanitim ucu ===');
    const bozuk = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { lansman_kayit_son: '2026-02-30' } });
    ok('gecersiz tarih 400', bozuk.status === 400 && /tarih/.test(bozuk.d.message || ''), bozuk);
    const yuzdeBozuk = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { lansman_yuzde: '150' } });
    ok('oran 1-100 disi 400', yuzdeBozuk.status === 400, yuzdeBozuk);
    const kaydet = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT',
        body: { lansman_acik: '1', lansman_yuzde: '40', lansman_kayit_son: ILERI, lansman_odeme_gun: '2' } });
    ok('ayarlar kaydedildi', kaydet.status === 200 && kaydet.d.lansman_kayit_son === ILERI && kaydet.d.sayisal.lansman_yuzde.etkin === 40
        && kaydet.d.sayisal.lansman_odeme_gun.etkin === 2, kaydet.d && kaydet.d.sayisal && kaydet.d.sayisal.lansman_yuzde);
    const pub2 = (await js('/api/public/lansman')).d;
    ok('tanitim ucu: acik, %40, son kayit, 2 gun', pub2 && pub2.acik === true && pub2.yuzde === 40 && pub2.kayitSon === ILERI && pub2.odemeGun === 2, pub2);
    const qd2 = (await js('/api/license/quote', { token: d.token, body: SECIM })).d;
    ok('yeni oran teklife yansir (%40 > %20)', qd2.kampanyaOrani === 40 && qd2.total === 3000, qd2);

    sunucu.kill();
    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
