// Kayit formu denemesi + lisans yenileme hatirlatmasi + isletme menu karekodu + menu kipi kapanmasi.
// Kapsam:
//   1) /register: telefon zorunlu; isletme basina bir deneme (ayni telefon ya da ayni e-posta TARAFSIZ mesajla ret,
//      tanitim denemesiyle ortak kural); deneme TIER_DENEME, masa siniri yok, tanitim denemesiyle ayni moduller
//   2) Hatirlatma: saf islevler (gun farki, saat penceresi, tur) + tara() sahte postaciyla (bir kez, atlama kurallari)
//   3) Menu kipi: isletme duzeyi menu karekodu (panel + kamu uclari, /q cozumu), yalniz goruntuleme
//   4) Menu kipinde lisans N gundur kapaliysa 410 MENU_KAPALI; BASE olan isletme etkilenmez; ayar 0 = hic
// Sunucuyu KENDI baslatir (port 47500).  Calistir: node test_kayit_hatirlatma.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47500, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'kayit-hatirlatma-test-jwt';
const ON = 'KYH Test';
const EPOSTA_ON = 'kyh-';
const TELEFONLAR = ['5324750001', '5324750002', '5324750003', '5324750004', '5324750005'];
const GUN = 86400000;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d, tip: r.headers.get('content-type') || '' };
}

async function kiraciKur({ ad, moduller, tier = 'TIER_6_10', bitis, parentOrg = null, aktif = 1 }) {
    const id = uuid();
    const slug = 'kyh-' + crypto.randomBytes(4).toString('hex');
    const kod = String(60000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, license_tier, license_modules,
                              license_end_date, parent_org, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, '05320000000', tier, JSON.stringify(moduller),
            bitis, parentOrg, aktif]);
    const eposta = `${EPOSTA_ON}sahip-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), id, eposta, await bcrypt.hash('sahip1234', 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    return { id, slug, kod, eposta };
}
const giris = async (k) => (await js('/api/auth/login', { body: { email: k.eposta, businessCode: k.kod, password: 'sahip1234' } })).d.token;
async function masaEkle(tenantId, kod) {
    const id = uuid(), tok = crypto.randomBytes(12).toString('hex');
    await query('INSERT INTO tables (id, tenant_id, code, name, section, qr_token) VALUES (?, ?, ?, ?, ?, ?)',
        [id, tenantId, kod, 'Masa ' + kod, 'Salon', tok]);
    return { id, tok };
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
        for (const tb of ['lisans_hatirlatmalari', 'lisans_odemeleri', 'tables', 'products', 'categories', 'aktivasyon_jetonlari',
            'deneme_kayitlari', 'license_cache', 'islem_gunlugu', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM pending_registrations WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    await query(`DELETE FROM demo_talepleri WHERE eposta LIKE '${EPOSTA_ON}%'`).catch(() => {});
    await query(`DELETE FROM deneme_kayitlari WHERE isletme_adi LIKE '${ON}%' OR telefon_norm IN (${TELEFONLAR.map(() => '?').join(', ')})`, TELEFONLAR).catch(() => {});
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    await query("DELETE FROM sistem_ayarlari WHERE anahtar IN ('lisans_hatirlatma_acik', 'menu_kipi_kapanma_gun')").catch(() => {});
}

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development',
               SMTP_HOST: '', QR_PUBLIC_BASE: 'https://menu.ornek.test', HUB_URL: 'http://127.0.0.1:9' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();

    console.log('=== 0) Sema ===');
    ok('lisans_hatirlatmalari tablosu var', (await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lisans_hatirlatmalari'")).rows.length === 1);
    ok('tenants.menu_kisa_kod kolonu var', (await query('PRAGMA table_info(tenants)')).rows.some((x) => x.name === 'menu_kisa_kod'));

    console.log('\n=== 1) Kayit formu: bir deneme kurali, TIER_DENEME ===');
    const govde = (x) => ({ businessName: `${ON} Kayıt`, email: `${EPOSTA_ON}k1@ornek.test`, phone: '0532 475 00 01', password: 'kayit1234',
        kvkkConsent: true, tier: 'TIER_1_5', modules: ['BASE'], referredBy: '', ...x });
    const tsiz = await js('/api/auth/register/request', { body: govde({ phone: '' }) });
    ok('telefonsuz kayit 400', tsiz.status === 400, tsiz);
    const kisa = await js('/api/auth/register/request', { body: govde({ phone: '0532' }) });
    ok('eksik telefon 400', kisa.status === 400, kisa);
    const k1 = await js('/api/auth/register/request', { body: govde() });
    ok('kayit istegi 201 + dev kodu', k1.status === 201 && !!k1.d.pendingId && !!k1.d.devOtp, k1);
    const v1 = await js('/api/auth/register/verify', { body: { pendingId: k1.d.pendingId, otp: k1.d.devOtp } });
    ok('dogrulama 201, yanit TIER_DENEME', v1.status === 201 && v1.d.licenseTier === 'TIER_DENEME', v1.d);
    const t1 = (await query('SELECT * FROM tenants WHERE owner_email = ?', [`${EPOSTA_ON}k1@ornek.test`])).rows[0];
    const VARSAYILAN = require('./src/services/posProvizyon').VARSAYILAN_MODULLER;
    ok('kiraci TIER_DENEME, masa siniri NULL (formdaki TIER_1_5 yok sayildi)', t1 && t1.license_tier === 'TIER_DENEME' && t1.license_table_limit == null, t1 && { tier: t1.license_tier, limit: t1.license_table_limit });
    const m1 = JSON.parse(t1.license_modules);
    ok('moduller tanitim denemesiyle ayni (BASE secimi yok sayildi)', m1.length === VARSAYILAN.length && VARSAYILAN.every((m) => m1.includes(m)), m1);
    ok('bitis yaklasik 7 gun sonra', Math.abs(new Date(t1.license_end_date).getTime() - (Date.now() + 7 * GUN)) < 120000, t1.license_end_date);
    const dk = (await query('SELECT * FROM deneme_kayitlari WHERE tenant_id = ?', [t1.id])).rows[0];
    ok('deneme_kayitlari: normalize telefon + kaynak kayit', dk && dk.telefon_norm === '5324750001' && dk.kaynak === 'kayit', dk);
    // Tavsiye sistemi (2026-11-18): kisa tavsiye kodu (6 karakter, I/O/0/1 yok; services/tavsiye.js)
    ok('tavsiye kodu uretildi', /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(v1.d.referralCode || ''), v1.d.referralCode);

    const ayniTel = await js('/api/auth/register/request', { body: govde({ email: `${EPOSTA_ON}k2@ornek.test`, phone: '+90 (532) 475 00 01' }) });
    const ayniEp = await js('/api/auth/register/request', { body: govde({ email: `${EPOSTA_ON.toUpperCase()}K1@ornek.test`, phone: '0532 475 00 02' }) });
    ok('ayni telefon (farkli bicim) 409 DENEME_ALINMIS', ayniTel.status === 409 && ayniTel.d.code === 'DENEME_ALINMIS', ayniTel);
    ok('ayni e-posta (buyuk harf) 409 DENEME_ALINMIS', ayniEp.status === 409 && ayniEp.d.code === 'DENEME_ALINMIS', ayniEp);
    ok('ret mesaji tarafsiz: iki durumda ayni, telefon/e-posta adi gecmez', ayniTel.d.message === ayniEp.d.message
        && !/telefon|e-posta/i.test(ayniTel.d.message), ayniTel.d.message);
    ok('ret durumunda kod gonderilmez (bekleyen kayit yok)', !(await query('SELECT 1 FROM pending_registrations WHERE email = ?', [`${EPOSTA_ON}k2@ornek.test`])).rows.length);

    // Tanitim denemesi alan telefon kayit formundan ikinci deneme alamaz
    const tan = await js('/api/public/deneme', { body: { isletme: `${ON} Tanıtım`, adSoyad: 'Deneme Kişi', telefon: '0532 475 00 03', eposta: `${EPOSTA_ON}t1@ornek.test` },
        headers: { 'X-Forwarded-For': '10.47.5.1' } });
    ok('tanitim denemesi 201', tan.status === 201, tan);
    const tanK = await js('/api/auth/register/request', { body: govde({ email: `${EPOSTA_ON}k3@ornek.test`, phone: '05324750003' }) });
    ok('tanitim denemesinin telefonuyla kayit 409', tanK.status === 409 && tanK.d.code === 'DENEME_ALINMIS', tanK);
    // Kayit formu denemesi alan telefon tanitimdan da alamaz (ortak kural)
    const tan2 = await js('/api/public/deneme', { body: { isletme: `${ON} Tanıtım 2`, adSoyad: 'Deneme Kişi', telefon: '0532 475 00 01', eposta: `${EPOSTA_ON}t2@ornek.test` },
        headers: { 'X-Forwarded-For': '10.47.5.2' } });
    ok('kayit formu denemesinin telefonuyla tanitim denemesi 409', tan2.status === 409, tan2);

    // Kod gonderildikten SONRA ayni telefonla baska yoldan deneme acilirsa dogrulama reddedilir
    const k4 = await js('/api/auth/register/request', { body: govde({ email: `${EPOSTA_ON}k4@ornek.test`, phone: '0532 475 00 04' }) });
    ok('k4 istegi 201', k4.status === 201, k4);
    await js('/api/public/deneme', { body: { isletme: `${ON} Araya Giren`, adSoyad: 'Deneme Kişi', telefon: '0532 475 00 04', eposta: `${EPOSTA_ON}t4@ornek.test` },
        headers: { 'X-Forwarded-For': '10.47.5.4' } });
    const v4 = await js('/api/auth/register/verify', { body: { pendingId: k4.d.pendingId, otp: k4.d.devOtp } });
    ok('dogrulamada tekrar bakilir: 409', v4.status === 409 && v4.d.code === 'DENEME_ALINMIS', v4);
    ok('ikinci kiraci acilmadi', !(await query('SELECT 1 FROM tenants WHERE owner_email = ?', [`${EPOSTA_ON}k4@ornek.test`])).rows.length);

    console.log('\n=== 2) Hatirlatma: saf islevler ===');
    const H = require('./src/services/lisansHatirlatma');
    const ogle = new Date('2026-11-18T09:00:00Z');      // 12:00 Istanbul
    ok('saat penceresi: 12:00 evet, 09:59 hayir, 10:00 evet, 19:59 evet, 20:00 hayir',
        H.gonderimSaatiMi(ogle) && !H.gonderimSaatiMi(new Date('2026-11-18T06:59:00Z')) && H.gonderimSaatiMi(new Date('2026-11-18T07:00:00Z'))
        && H.gonderimSaatiMi(new Date('2026-11-18T16:59:00Z')) && !H.gonderimSaatiMi(new Date('2026-11-18T17:00:00Z')));
    ok('Istanbul gunu: 21:30Z ertesi gun', H.istanbulGun('2026-11-18T21:30:00Z') === '2026-11-19' && H.istanbulGun('2026-11-18T20:59:00Z') === '2026-11-18');
    const tur = (tier, bitis, s = ogle) => H.hatirlatmaTuru({ license_tier: tier, license_end_date: bitis }, s);
    ok('ucretli: 30 gun once', tur('TIER_6_10', '2026-12-18T12:00:00Z') === 'once_30');
    ok('ucretli: 7 gun once', tur('TIER_6_10', '2026-11-25T20:00:00Z') === 'once_7');
    ok('ucretli: 1 gun once', tur('TIER_SOFRAMIX', '2026-11-19T05:00:00Z') === 'once_1');
    ok('ucretli: 1 gun sonra', tur('TIER_6_10', '2026-11-17T10:00:00Z') === 'sonra_1');
    ok('ucretli: bitis gunu, 2, 29, 31 gun ve 2 gun sonra yok', [ '2026-11-18T15:00:00Z', '2026-11-20T10:00:00Z', '2026-12-17T10:00:00Z', '2026-12-19T10:00:00Z', '2026-11-16T10:00:00Z']
        .every((b) => tur('TIER_6_10', b) === null));
    ok('ucretli: Istanbul gun siniri (18 Ara 21:30Z = 19 Ara) 31 gun, yok', tur('TIER_6_10', '2026-12-18T21:30:00Z') === null);
    ok('deneme: 2 gun once ve son gun', tur('TIER_DENEME', '2026-11-20T08:00:00Z') === 'deneme_2' && tur('TIER_DENEME', '2026-11-18T20:00:00Z') === 'deneme_son');
    ok('deneme: 30/7/1 gun once ve 1 gun sonra yok', ['2026-12-18T10:00:00Z', '2026-11-25T10:00:00Z', '2026-11-19T10:00:00Z', '2026-11-17T10:00:00Z']
        .every((b) => tur('TIER_DENEME', b) === null));
    ok('bitis yoksa ya da bozuksa yok', tur('TIER_6_10', null) === null && tur('TIER_6_10', 'bozuk') === null);
    ok('SofraMix kanali: parent_org ya da TIER_SOFRAMIX', H.sofraMixMi({ parent_org: 'SofraMix' }) && H.sofraMixMi({ license_tier: 'TIER_SOFRAMIX' }) && !H.sofraMixMi({ license_tier: 'TIER_6_10' }));
    const ic1 = H.icerik({ tur: 'once_7', isletmeAdi: 'A<b>', bitis: '2026-11-25T20:00:00Z' });
    ok('icerik: Lisans sayfasi baglantisi, ad kacirilmis, tarih', ic1.html.includes('/lisans') && ic1.html.includes('A&lt;b&gt;') && ic1.html.includes('25.11.2026') && ic1.konu.includes('7 gün'), ic1.konu);
    const ic2 = H.icerik({ tur: 'deneme_son', isletmeAdi: 'X', bitis: '2026-11-18T20:00:00Z', sofraMix: true });
    ok('icerik: SofraMix baglantisi /isletme/pos + SofraMix ifadesi', ic2.html.includes('/isletme/pos') && ic2.html.includes('SofraMix işletme paneli'), ic2.baglanti);
    const tum = ['once_30', 'once_7', 'once_1', 'sonra_1', 'deneme_2', 'deneme_son'].map((t) => H.icerik({ tur: t, isletmeAdi: 'X', bitis: ogle, toleransGun: 3 }));
    const TIRELER = [0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((c) => String.fromCharCode(c));
    ok('icerik: uzun tire / eksi isareti yok, "sen" dili yok', tum.every((x) => !TIRELER.some((c) => (x.html + x.konu).includes(c))
        && !/(yapabilirsin|seçebilirsin|edebilirsin)(?![a-zçğıöşü])/.test(x.html)));

    console.log('\n=== 3) Hatirlatma: tara() (sahte postaci) ===');
    // "simdi": bugun 12:00 Istanbul (gercek gun; kiracilar buna gore kurulur)
    const bugun = H.istanbulGun(new Date());
    const simdi = new Date(bugun + 'T09:00:00Z');
    const g = (n) => new Date(simdi.getTime() + n * GUN).toISOString();
    const p30 = await kiraciKur({ ad: 'Hatırlatma 30', moduller: ['BASE'], bitis: g(30) });
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)',
        [uuid(), p30.id, p30.eposta.toUpperCase(), 'x', 'Ikinci Sahip', 'OWNER']);       // ayni e-posta buyuk harfle: tekillesir
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)',
        [uuid(), p30.id, `${EPOSTA_ON}kasa-${p30.slug}@ornek.test`, 'x', 'Kasa', 'CASHIER']);   // sahip degil: gitmez
    const dSon = await kiraciKur({ ad: 'Deneme Son', moduller: ['BASE'], tier: 'TIER_DENEME', bitis: g(0.3) });
    const smx = await kiraciKur({ ad: 'SMX 1', moduller: ['BASE'], tier: 'TIER_SOFRAMIX', parentOrg: 'SofraMix', bitis: g(1) });
    const bek = await kiraciKur({ ad: 'Bekleyen Ödeme', moduller: ['BASE'], bitis: g(7) });
    await query("INSERT INTO lisans_odemeleri (id, tenant_id, tutar, durum, odeme_bildirildi_at) VALUES (?, ?, 100, 'beklemede', CURRENT_TIMESTAMP)", [uuid(), bek.id]);
    const bekBildirmedi = await kiraciKur({ ad: 'Bildirilmemiş Ödeme', moduller: ['BASE'], bitis: g(7) });
    await query("INSERT INTO lisans_odemeleri (id, tenant_id, tutar, durum) VALUES (?, ?, 100, 'beklemede')", [uuid(), bekBildirmedi.id]);
    const pasif = await kiraciKur({ ad: 'Pasif', moduller: ['BASE'], bitis: g(30), aktif: 0 });
    const benim = new Set([p30.id, dSon.id, smx.id, bek.id, bekBildirmedi.id, pasif.id]);
    const giden = [];
    const sahte = async (to, konu, html) => { giden.push({ to, konu, html }); return true; };
    const ayar = require('./src/services/yonetimAyar');
    await ayar.yukle();
    const r1 = await H.tara({ simdi, gonder: sahte });
    const r1b = r1.gonderilen.filter((x) => benim.has(x.tenantId));
    const turu = (id) => (r1b.find((x) => x.tenantId === id) || {}).tur;
    ok('30 gun once gonderildi', turu(p30.id) === 'once_30', r1b);
    ok('deneme son gun gonderildi', turu(dSon.id) === 'deneme_son', r1b);
    ok('SofraMix 1 gun once gonderildi', turu(smx.id) === 'once_1', r1b);
    ok('onay bekleyen odeme bildirimi olan atlandi', !turu(bek.id), r1b);
    ok('bildirilmemis bekleyen odeme engel degil', turu(bekBildirmedi.id) === 'once_7', r1b);
    ok('pasif isletme atlandi', !turu(pasif.id));
    const p30Giden = giden.filter((x) => x.to.includes(p30.slug));
    ok('alicilar: yalniz sahip, e-posta tekillesti (1 posta)', p30Giden.length === 1 && p30Giden[0].to === p30.eposta, p30Giden.map((x) => x.to));
    const smxGiden = giden.find((x) => x.to.includes(smx.slug));
    ok('SofraMix postasi SofraMix baglantisi', smxGiden && smxGiden.html.includes('/isletme/pos') && !smxGiden.html.includes('/lisans"'));
    ok('kayit tablosuna yazildi (alicilarla)', (await query('SELECT alicilar FROM lisans_hatirlatmalari WHERE tenant_id = ? AND tur = ?', [p30.id, 'once_30'])).rows[0]?.alicilar === p30.eposta);
    const r2 = await H.tara({ simdi: new Date(simdi.getTime() + 3600000), gonder: sahte });
    ok('ikinci tur (bir saat sonra): ayni hatirlatma tekrar gitmez', !r2.gonderilen.some((x) => benim.has(x.tenantId)), r2.gonderilen);
    // Lisans uzayinca (yeni bitis) yeni donemin hatirlatmasi yeniden gidebilir
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [g(30) .replace('T09:00', 'T10:00'), p30.id]);
    const r3 = await H.tara({ simdi, gonder: sahte });
    ok('bitis degisince yeni kayit', r3.gonderilen.some((x) => x.tenantId === p30.id && x.tur === 'once_30'), r3.gonderilen);
    // Gonderilemezse kayit geri alinir, sonra yeniden denenir
    const hataDeneme = await kiraciKur({ ad: 'Posta Hatası', moduller: ['BASE'], bitis: g(7) });
    await H.tara({ simdi, gonder: async () => false });
    ok('posta gidemediyse kayit kalmaz', !(await query('SELECT 1 FROM lisans_hatirlatmalari WHERE tenant_id = ?', [hataDeneme.id])).rows.length);
    const r4 = await H.tara({ simdi, gonder: sahte });
    ok('sonraki turda yeniden denenir ve gider', r4.gonderilen.some((x) => x.tenantId === hataDeneme.id));
    ok('saat disinda (21:00) hicbir sey yapmaz', (await H.tara({ simdi: new Date(bugun + 'T18:00:00Z'), gonder: sahte })).atlandi === 'saat_disi');
    await query("INSERT INTO sistem_ayarlari (anahtar, deger) VALUES ('lisans_hatirlatma_acik', '0')");
    await ayar.yukle();
    const yeniKiraci = await kiraciKur({ ad: 'Ayar Kapalı', moduller: ['BASE'], bitis: g(7) });
    const r5 = await H.tara({ simdi, gonder: sahte });
    ok('ayar 0: tarama yapilmaz', r5.atlandi === 'ayar_kapali' && !(await query('SELECT 1 FROM lisans_hatirlatmalari WHERE tenant_id = ?', [yeniKiraci.id])).rows.length);
    await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'lisans_hatirlatma_acik'");
    await ayar.yukle();

    console.log('\n=== 4) Root ayarlari ===');
    const a0 = await js('/api/root/yonetim/ayarlar', { token: rj });
    ok('varsayilanlar: hatirlatma 1, menu kapanma 15 gun', a0.status === 200 && a0.d.sayisal.lisans_hatirlatma_acik.etkin === 1
        && a0.d.sayisal.menu_kipi_kapanma_gun.etkin === 15, a0.d && a0.d.sayisal);
    const aHata = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { lisans_hatirlatma_acik: '2' } });
    ok('hatirlatma anahtari yalniz 0/1 (400)', aHata.status === 400, aHata);

    console.log('\n=== 5) Menu kipi: isletme menu karekodu ===');
    const mk = await kiraciKur({ ad: 'Yalnız Menü', moduller: ['MENU_DIGITAL'], bitis: g(60) });
    const mkS = await giris(mk);
    ok('menu kipi sahibi girer', !!mkS);
    const b1 = await js('/api/tenant/menu-karekod', { token: mkS });
    ok('panel: kod (8 hane) + kisa adres + menuKipi', b1.status === 200 && /^[ACDEFHJKMNPQRTUVWXY34679]{8}$/.test(b1.d.kod)
        && b1.d.adres === 'https://menu.ornek.test/q/' + b1.d.kod && b1.d.menuKipi === true, b1.d);
    const b2 = await js('/api/tenant/menu-karekod', { token: mkS });
    ok('kod sabit kalir (ikinci istekte ayni)', b2.d.kod === b1.d.kod);
    ok('oturumsuz panel ucu 401', (await js('/api/tenant/menu-karekod')).status === 401);
    const png = await fetch(TABAN + '/api/tenant/menu-karekod/karekod.png', { headers: { Authorization: 'Bearer ' + mkS } });
    const pngBuf = Buffer.from(await png.arrayBuffer());
    ok('karekod PNG', png.status === 200 && (png.headers.get('content-type') || '').startsWith('image/png') && pngBuf.slice(1, 4).toString() === 'PNG');
    const kat = await js('/api/categories', { token: mkS, body: { name: 'Tatlılar KYH' } });
    const urun = await js('/api/products', { token: mkS, body: { name: 'Sütlaç KYH', price: 80, categoryId: kat.d && kat.d.id, isAvailable: true } });
    ok('menu kipinde menu duzenlenir (kategori + urun)', kat.status === 201 && urun.status === 201, { kat: kat.status, urun: urun.status });
    const q1 = await js('/api/public/q/' + b1.d.kod);
    ok('/q cozumu: { slug, menu }', q1.status === 200 && q1.d.menu === b1.d.kod && q1.d.slug === mk.slug && !q1.d.token, q1.d);
    ok('/q kucuk harfle de cozulur', (await js('/api/public/q/' + b1.d.kod.toLowerCase())).d.menu === b1.d.kod);
    const mm = await js('/api/public/menu/' + b1.d.kod);
    ok('kamu menu: 200, urun var, yalniz goruntuleme', mm.status === 200 && mm.d.products.some((p) => p.name === 'Sütlaç KYH')
        && mm.d.ozellikler.siparis === false && mm.d.ozellikler.garson === false && mm.d.ozellikler.hesap === false && mm.d.table.name === null, mm.d);
    ok('kamu menu: gecersiz kod 404', (await js('/api/public/menu/AAAAAAAA')).status === 404 && (await js('/api/public/menu/abc')).status === 404);
    // Masa kodu cozumu bozulmadi
    const eskiMasa = await masaEkle(mk.id, 'M1');
    await require('./src/services/kisaKod').masayaAta(eskiMasa.id);
    const mkod = (await query('SELECT kisa_kod FROM tables WHERE id = ?', [eskiMasa.id])).rows[0].kisa_kod;
    const qm = await js('/api/public/q/' + mkod);
    ok('eski masa karekodu calisir (slug + token)', qm.status === 200 && qm.d.token === eskiMasa.tok, qm.d);
    ok('eski masa menusu calisir', (await js(`/api/public/m/${mk.slug}/${eskiMasa.tok}/menu`)).status === 200);
    await query('UPDATE tenants SET is_active = 0 WHERE id = ?', [mk.id]);
    ok('pasif isletmenin menu kodu: /q 404, menu 404', (await js('/api/public/q/' + b1.d.kod)).status === 404 && (await js('/api/public/menu/' + b1.d.kod)).status === 404);
    await query('UPDATE tenants SET is_active = 1 WHERE id = ?', [mk.id]);
    const smxsiz = await kiraciKur({ ad: 'Menüsüz', moduller: ['GARSON'], bitis: g(60) });
    const sz = await giris(smxsiz);
    const szk = (await js('/api/tenant/menu-karekod', { token: sz })).d;
    ok('QR Menu modulu yoksa kamu menu 403', (await js('/api/public/menu/' + szk.kod)).status === 403);

    console.log('\n=== 6) Menu kipi kapanmasi (410) ===');
    const tam = await kiraciKur({ ad: 'Tam Paket', moduller: ['BASE', 'MENU_DIGITAL'], bitis: g(60) });
    const tamMasa = await masaEkle(tam.id, 'T1');
    // 40 gun once bitti: tolerans (3 gun) sonrasi ~37 gundur KAPALI > 15
    await query('UPDATE tenants SET license_end_date = ? WHERE id IN (?, ?)', [new Date(Date.now() - 40 * GUN).toISOString(), mk.id, tam.id]);
    const k410 = await js('/api/public/menu/' + b1.d.kod);
    ok('menu kipi, 15 gunden uzun kapali: isletme menusu 410 MENU_KAPALI', k410.status === 410 && k410.d.code === 'MENU_KAPALI'
        && k410.d.message === 'Bu işletmenin menüsü şu an görüntülenemiyor.', k410);
    const m410 = await js(`/api/public/m/${mk.slug}/${eskiMasa.tok}/menu`);
    ok('menu kipi: masa menusu de 410', m410.status === 410 && m410.d.code === 'MENU_KAPALI', m410);
    ok('/q cozumu yine yonlendirir (sayfa sakin mesaji gosterir)', (await js('/api/public/q/' + b1.d.kod)).status === 200);
    ok('Adisyon ve Kasa olan isletme etkilenmez (200)', (await js(`/api/public/m/${tam.slug}/${tamMasa.tok}/menu`)).status === 200);
    // 10 gun once bitti: ~7 gundur kapali < 15 -> acik
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [new Date(Date.now() - 10 * GUN).toISOString(), mk.id]);
    ok('kapali ama 15 gunu doldurmamis: 200', (await js('/api/public/menu/' + b1.d.kod)).status === 200);
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [new Date(Date.now() - 40 * GUN).toISOString(), mk.id]);
    const a1 = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { menu_kipi_kapanma_gun: '0' } });
    ok('ayar 0 yazilir', a1.status === 200 && a1.d.sayisal.menu_kipi_kapanma_gun.etkin === 0, a1.d && a1.d.sayisal);
    ok('ayar 0: menu hic kapanmaz (200)', (await js('/api/public/menu/' + b1.d.kod)).status === 200);
    const a2 = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { menu_kipi_kapanma_gun: '50' } });
    ok('ayar 50: 37 gun kapali menu acik', a2.status === 200 && (await js('/api/public/menu/' + b1.d.kod)).status === 200);
    await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { menu_kipi_kapanma_gun: '' } });
    ok('bos birakilinca varsayilan (15): yine 410', (await js('/api/public/menu/' + b1.d.kod)).status === 410);

    await temizle();
    console.log(`\n${pass} OK, ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await temizle(); } catch (_) {} process.exit(1); });
