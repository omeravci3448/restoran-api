// Tavsiye sistemi ("Tavsiye et, süre kazan", 2026-11-18). Kapsam: kod uretimi ve tekilligi, eksik kodlarin
// doldurulmasi, baglantidan gelen kodun kabulu (tanitim denemesi + /register), bilinmeyen kod 400, kendi kendini
// tavsiye (tarafsiz metin, iptal), ilk odeme onayinda +30 gun (13 ay) ve tavsiye edene +60 gun, tavsiye eden odeme
// yapmamissa odulun beklemesi ve kendi ilk odemesinde uygulanmasi, bir kez (idempotent), SofraMix odeme yolu, root
// listesi ve "Ödülü uygula", bir kerelik panel bildirimi, Tavsiye Et karti.
// Sunucuyu KENDI baslatir. Calistir: node test_tavsiye.js   (port 47650)
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47650, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'tavsiye-test-jwt';
const ON = 'TVS Test';
const EPOSTA_ON = 'tvs-';
const GUN = 86400000;
const PANEL = 'http://localhost:5174';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 600) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const yakin = (a, b, tol = 26 * 3600000) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) < tol;
const fark = (a, b) => new Date(a).getTime() - new Date(b).getTime();
const KOD_TABAN = Math.floor(Math.random() * 9999);
let kodSayac = 0, ipSayac = 0, telSayac = 0;
const trTarih = (d) => new Date(d).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric' });
const KOD_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const telUret = () => '0555' + String(7000000 + (KOD_TABAN * 10 + telSayac++) % 999999).padStart(7, '0');

async function js(yol, { token, body, method, ip } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(ip ? { 'X-Forwarded-For': ip } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

async function girisYap(tenantId) {
    const t = (await query('SELECT business_code FROM tenants WHERE id = ?', [tenantId])).rows[0];
    const eposta = `${EPOSTA_ON}giris-${tenantId.slice(0, 8)}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), tenantId, eposta, await bcrypt.hash('sahip1234', 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    const g = await js('/api/auth/login', { body: { email: eposta, businessCode: t.business_code, password: 'sahip1234' } });
    return g.d && g.d.token;
}

// Dogrudan kurulan isletme (tavsiye eden). odeme: onayli odemesi olsun mu
async function kiraciKur({ ad, tier = 'TIER_1_5', bitis, odeme = false, kod = undefined }) {
    const id = uuid();
    const slug = 'tvs-' + crypto.randomBytes(4).toString('hex');
    const isyeri = String(70000 + (KOD_TABAN + kodSayac++) % 9999);
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, license_tier, license_modules,
                              license_end_date, is_active, referral_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '["BASE","MENU_DIGITAL"]', ?, 1, ?, datetime('now', '-300 days'))`,
        [id, slug, isyeri, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, telUret(), tier, bitis ? bitis.toISOString() : null,
            kod === undefined ? null : kod]);
    if (odeme) await odemeKur(id, 'onaylandi');
    const token = await girisYap(id);
    return { id, slug, token };
}
const odemeKur = async (tenantId, durum = 'onaylandi', tur = 'ilk') => {
    const id = 'tvs-' + crypto.randomBytes(5).toString('hex');
    await query(
        `INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, tur, donem_bitis, islenen_at, onay_gun, created_at)
         VALUES (?, ?, 'TIER_1_5', '["BASE","MENU_DIGITAL"]', 5000, ?, ?, ?, ?, ?, datetime('now', '-1 hours'))`,
        [id, tenantId, durum, tur, durum === 'onaylandi' ? new Date(Date.now() + 100 * GUN).toISOString() : null,
            durum === 'onaylandi' ? new Date(Date.now() - 265 * GUN).toISOString() : null, durum === 'onaylandi' ? 365 : null]);
    return id;
};
const kiraci = async (id) => (await query('SELECT * FROM tenants WHERE id = ?', [id])).rows[0];
const tavsiyeSatiri = async (edilenId) => (await query('SELECT * FROM tavsiyeler WHERE tavsiye_edilen_id = ?', [edilenId])).rows[0];

// Tanitim sayfasindan deneme (her cagri ayri IP: saatlik oran siniri)
async function denemeAc(ad, { tavsiyeKodu, telefon } = {}) {
    const eposta = `${EPOSTA_ON}d-${crypto.randomBytes(4).toString('hex')}@ornek.test`;
    const r = await js('/api/public/deneme', { ip: `10.77.${KOD_TABAN % 250}.${++ipSayac}`,
        body: { isletme: `${ON} ${ad}`, adSoyad: 'Deneme Yetkili', telefon: telefon || telUret(), eposta, tavsiyeKodu } });
    const t = (await query('SELECT id FROM tenants WHERE owner_email = ?', [eposta])).rows[0];
    return { r, id: t ? t.id : null, eposta };
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
        for (const tb of ['lisans_odemeleri', 'pos_provizyon', 'ek_sure_tanimlari', 'root_olaylar', 'license_cache', 'islem_gunlugu',
            'yonetim_gunlugu', 'users', 'aktivasyon_jetonlari', 'deneme_kayitlari', 'sube_grup_uyeleri'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tavsiyeler WHERE tavsiye_eden_id = ? OR tavsiye_edilen_id = ?', [r.id, r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM sube_gruplari WHERE ad LIKE '${ON}%'`).catch(() => {});
    await query(`DELETE FROM demo_talepleri WHERE isletme LIKE '${ON}%'`).catch(() => {});
    await query(`DELETE FROM pending_registrations WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
}

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    // Kodu olmayan eski isletme: sunucu acilisinda (initDb) kod almali
    const kodsuz = uuid();
    await query(`INSERT INTO tenants (id, slug, business_code, business_name, owner_email, license_tier, license_end_date, is_active, referral_code)
                 VALUES (?, ?, ?, ?, ?, 'TIER_1_5', ?, 1, NULL)`,
        [kodsuz, 'tvs-kodsuz-' + crypto.randomBytes(3).toString('hex'), String(69000 + KOD_TABAN % 999), `${ON} Kodsuz`, `${EPOSTA_ON}kodsuz@ornek.test`,
            new Date(Date.now() + 50 * GUN).toISOString()]);

    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '',
            POS_PANEL_URL: PANEL } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();
    const TV = require('./src/services/tavsiye');
    const { tavsiyeKoduUret } = require('./src/config/tavsiyeDb');
    const onayla = (odemeId) => js(`/api/root/lisans-odemeleri/${odemeId}/onayla`, { token: rj, body: { gun: 365 } });

    console.log('=== 0) Sema ve kod uretimi ===');
    const kol = (await query('PRAGMA table_info(tavsiyeler)')).rows.map((x) => x.name);
    ok('tavsiyeler tablosu', ['tavsiye_eden_id', 'tavsiye_edilen_id', 'durum', 'edilen_gun', 'eden_gun', 'edilen_goruldu_at', 'eden_goruldu_at', 'iptal_sebep'].every((k) => kol.includes(k)), kol);
    const kodlar = new Set();
    let hepsiGecerli = true;
    for (let i = 0; i < 3000; i++) { const k = tavsiyeKoduUret(); kodlar.add(k); if (!KOD_RE.test(k)) hepsiGecerli = false; }
    ok('uretilen kod: 6 karakter, buyuk harf, I/O/0/1 yok', hepsiGecerli);
    ok('3000 kodda cakisma yok denecek kadar az', kodlar.size >= 2995, kodlar.size);
    const ks = await kiraci(kodsuz);
    ok('kodu olmayan isletmeye acilista kod verildi', ks && KOD_RE.test(ks.referral_code || ''), ks && ks.referral_code);
    const bos = (await query("SELECT COUNT(*) AS n FROM tenants WHERE referral_code IS NULL OR TRIM(referral_code) = ''")).rows[0].n;
    ok('kodsuz isletme kalmadi', Number(bos) === 0, bos);
    const yk = await TV.yeniKod();
    ok('yeniKod tabloda olmayan bir kod', KOD_RE.test(yk) && !(await query('SELECT 1 FROM tenants WHERE referral_code = ?', [yk])).rows.length);
    await query('UPDATE tenants SET referral_code = NULL WHERE id = ?', [kodsuz]);
    const k1 = await TV.kodVer(kodsuz), k2 = await TV.kodVer(kodsuz);
    ok('kodVer: sonradan acilan isletmeye kod verir ve degistirmez', KOD_RE.test(k1) && k1 === k2, [k1, k2]);
    const tekil = (await query("SELECT referral_code, COUNT(*) AS n FROM tenants WHERE referral_code IS NOT NULL AND referral_code <> '' GROUP BY referral_code HAVING n > 1")).rows;
    ok('kodlar tekil', tekil.length === 0, tekil);
    ok('kod normallestirme (kucuk harf, bosluk, tire)', TV.kodNormalle(' ab-c d2 ') === 'ABCD2' && TV.kodNormalle('') === null);

    console.log('\n=== 1) Tavsiye Et karti + herkese acik kod denetimi ===');
    const A = await kiraciKur({ ad: 'Tavsiye Eden A', bitis: new Date(Date.now() + 100 * GUN), odeme: true });
    const kart = await js('/api/license/tavsiye', { token: A.token });
    const kodA = kart.d && kart.d.kod;
    ok('kart: kod uretildi', kart.status === 200 && KOD_RE.test(kodA || ''), kart);
    ok('kart: baglanti /tanitim?ref=KOD', kart.d.baglanti === `${PANEL}/tanitim?ref=${kodA}` && kart.d.kayitBaglantisi === `${PANEL}/register?ref=${kodA}`, kart.d);
    ok('kart: kural metni', kart.d.kural === 'Tavsiye ettiğiniz işletme ilk paketini aldığında size 2 ay ek süre, ona 13 ay lisans.', kart.d.kural);
    ok('kart: paylasim metninde kod ve baglanti', kart.d.paylasimMetni.includes(kodA) && kart.d.paylasimMetni.includes(kart.d.baglanti));
    ok('kart: bos liste', Array.isArray(kart.d.liste) && kart.d.liste.length === 0);
    ok('kart oturumsuz acilmaz', (await js('/api/license/tavsiye')).status === 401);
    const pk = await js(`/api/public/tavsiye/${kodA}`);
    ok('herkese acik: gecerli kod', pk.status === 200 && pk.d.gecerli === true && !JSON.stringify(pk.d).includes(ON), pk.d);
    ok('herkese acik: kucuk harfle de gecerli', (await js(`/api/public/tavsiye/${kodA.toLowerCase()}`)).d.gecerli === true);
    ok('herkese acik: bilinmeyen kod', (await js('/api/public/tavsiye/ZZZZZZ9')).d.gecerli === false);

    console.log('\n=== 2) Baglantidan gelen kod: tanitim denemesi ===');
    const B = await denemeAc('Tavsiye Edilen B', { tavsiyeKodu: kodA.toLowerCase() });
    ok('deneme 201 + tavsiye baglandi', B.r.status === 201 && B.r.d.tavsiye && B.r.d.tavsiye.durum === 'baglandi', B.r);
    const sB = await tavsiyeSatiri(B.id);
    ok('tavsiyeler satiri: kayit, kaynak tanitim', sB && sB.tavsiye_eden_id === A.id && sB.durum === 'kayit' && sB.kaynak === 'tanitim' && sB.kod === kodA, sB);
    ok('tenants.referred_by = kod', (await kiraci(B.id)).referred_by === kodA);
    const yanlis = await denemeAc('Yanlis Kod', { tavsiyeKodu: 'QQQQQQ' });
    ok('bilinmeyen kod: 400, isletme acilmadi', yanlis.r.status === 400 && yanlis.r.d.code === 'TAVSIYE_KODU_YOK' && !yanlis.id, yanlis.r);
    const kodsuzDeneme = await denemeAc('Kodsuz Deneme');
    ok('kod yoksa normal deneme, tavsiye yok', kodsuzDeneme.r.status === 201 && !kodsuzDeneme.r.d.tavsiye && !(await tavsiyeSatiri(kodsuzDeneme.id)));

    console.log('\n=== 3) /register ile kod ===');
    const regEposta = `${EPOSTA_ON}reg-${crypto.randomBytes(3).toString('hex')}@ornek.test`;
    const regGovde = { businessName: `${ON} Kayit R`, email: regEposta, password: 'sifre1234', phone: telUret(), kvkkConsent: true };
    const rq0 = await js('/api/auth/register/request', { body: { ...regGovde, referredBy: 'YOKBUKOD' } });
    ok('register: bilinmeyen kod 400', rq0.status === 400 && rq0.d.code === 'TAVSIYE_KODU_YOK', rq0);
    const rq = await js('/api/auth/register/request', { body: { ...regGovde, referredBy: ` ${kodA.toLowerCase()} ` } });
    ok('register: istek 201 (dev OTP)', rq.status === 201 && rq.d.devOtp, rq);
    const rv = await js('/api/auth/register/verify', { body: { pendingId: rq.d.pendingId, otp: rq.d.devOtp } });
    ok('register: dogrulama 201 + tavsiye baglandi + yeni bicim kod', rv.status === 201 && rv.d.tavsiye && rv.d.tavsiye.durum === 'baglandi'
        && KOD_RE.test(rv.d.referralCode || ''), rv.d);
    const sR = await tavsiyeSatiri(rv.d.tenantId);
    ok('register: tavsiyeler satiri kaynak kayit', sR && sR.tavsiye_eden_id === A.id && sR.kaynak === 'kayit' && sR.durum === 'kayit', sR);
    const authKaynak = fs.readFileSync(require('path').join(__dirname, 'src/controllers/authController.js'), 'utf8');
    ok('Hub indirim orani artik yazilmiyor', !/hubResp\.discountRate/.test(authKaynak));

    console.log('\n=== 4) Kendi kendini tavsiye ===');
    const tA = await kiraci(A.id);
    const ayniTel = await denemeAc('Ayni Telefon', { tavsiyeKodu: kodA, telefon: tA.phone });
    ok('ayni telefon: deneme acilir, tarafsiz metin', ayniTel.r.status === 201 && ayniTel.r.d.tavsiye && ayniTel.r.d.tavsiye.durum === 'uygulanamadi'
        && ayniTel.r.d.tavsiye.mesaj === 'Tavsiye kodu bu kayıt için kullanılamadı; kaydınız normal şekilde açıldı.', ayniTel.r.d);
    const sT = await tavsiyeSatiri(ayniTel.id);
    ok('ayni telefon: satir iptal (telefon), referred_by bos', sT && sT.durum === 'iptal' && sT.iptal_sebep === 'telefon' && !(await kiraci(ayniTel.id)).referred_by, sT);
    ok('kendi kodu: ayni hesap', (await TV.ayniIsletmeMi(A.id, A.id)) === 'ayni_hesap');
    // Vergi no sonradan ayni yazildi: odul aninda iptal
    const V = await denemeAc('Vergi Ayni', { tavsiyeKodu: kodA });
    await query("UPDATE tenants SET billing_tax_id = '1234567890' WHERE id IN (?, ?)", [A.id, V.id]);
    const oV = await odemeKur(V.id, 'beklemede');
    const vBitisOnce = (await kiraci(A.id)).license_end_date;
    const onV = await onayla(oV);
    const sV = await tavsiyeSatiri(V.id);
    ok('ayni vergi no: onay 200, odul yok, satir iptal', onV.status === 200 && sV.durum === 'iptal' && sV.iptal_sebep === 'vergi_no' && !sV.edilen_odul_at, [onV.status, sV]);
    ok('ayni vergi no: tavsiye edenin bitisi degismedi', (await kiraci(A.id)).license_end_date === vBitisOnce);
    await query('UPDATE tenants SET billing_tax_id = NULL WHERE id = ?', [A.id]);
    // Ayni sube grubu
    const G = await denemeAc('Grup Ayni', { tavsiyeKodu: kodA });
    const grupId = uuid();
    await query('INSERT INTO sube_gruplari (id, ad) VALUES (?, ?)', [grupId, `${ON} Grup`]);
    await query('INSERT INTO sube_grup_uyeleri (grup_id, tenant_id) VALUES (?, ?), (?, ?)', [grupId, A.id, grupId, G.id]);
    const onG = await onayla(await odemeKur(G.id, 'beklemede'));
    const sG = await tavsiyeSatiri(G.id);
    ok('ayni sube grubu: onay 200, satir iptal', onG.status === 200 && sG.durum === 'iptal' && sG.iptal_sebep === 'sube_grubu', [onG.status, sG]);
    await query('DELETE FROM sube_grup_uyeleri WHERE grup_id = ?', [grupId]);
    const kartA2 = (await js('/api/license/tavsiye', { token: A.token })).d;
    ok('isletme listesinde iptaller gorunmez', kartA2.liste.every((x) => x.durum !== 'iptal') && kartA2.liste.length === 2, kartA2.liste);

    console.log('\n=== 5) Ilk odeme onayi: 13 ay + tavsiye edene 60 gun ===');
    const aOnce = (await kiraci(A.id)).license_end_date;
    const oB = await odemeKur(B.id, 'beklemede');
    await query("UPDATE lisans_odemeleri SET odeme_bildirildi_at = CURRENT_TIMESTAMP WHERE id = ?", [oB]);
    const kartA3 = (await js('/api/license/tavsiye', { token: A.token })).d;
    ok('"Odemeyi yaptim" sonrasi: odeme_bekliyor', (kartA3.liste.find((x) => x.id === sB.id) || {}).durum === 'odeme_bekliyor', kartA3.liste);
    const onB = await onayla(oB);
    const tB = await kiraci(B.id);
    const sB2 = await tavsiyeSatiri(B.id);
    ok('onay 200, cevapta tavsiye notu ve son bitis', onB.status === 200 && /Tavsiye koduyla geldiği için 30 gün eklendi/.test(onB.d.message)
        && onB.d.license_end_date === tB.license_end_date, onB.d);
    ok('tavsiye edilen: onay bitisi + 30 gun (365 + 30)', sB2.edilen_gun === 30 && fark(sB2.edilen_yeni_bitis, sB2.edilen_onceki_bitis) === 30 * GUN
        && tB.license_end_date === sB2.edilen_yeni_bitis && yakin(tB.license_end_date, Date.now() + 395 * GUN), [sB2, tB.license_end_date]);
    const tA4 = await kiraci(A.id);
    ok('tavsiye eden: mevcut bitis + 60 gun', fark(tA4.license_end_date, aOnce) === 60 * GUN && sB2.eden_gun === 60 && sB2.eden_yeni_bitis === tA4.license_end_date, [aOnce, tA4.license_end_date]);
    ok('durum odul_verildi, odeme kaynagi havale', sB2.durum === 'odul_verildi' && sB2.odeme_kaynak === 'havale' && sB2.odeme_ref === oB, sB2);
    const ygT = (await query("SELECT * FROM yonetim_gunlugu WHERE islem = 'tavsiye' AND tenant_id IN (?, ?)", [A.id, B.id])).rows;
    ok('yonetim gunlugu: iki tavsiye kaydi', ygT.length === 2, ygT.length);

    console.log('\n=== 6) Panel bildirimi (bir kez) ===');
    const tokB = await girisYap(B.id);
    const bB = (await js('/api/license/tavsiye-bildirimi', { token: tokB })).d;
    ok('tavsiye edilen bildirimi', bB.bildirimler.length === 1 && bB.bildirimler[0].metin === 'Tavsiye koduyla geldiğiniz için ilk paketiniz 13 ay tanımlandı.', bB);
    const bA = (await js('/api/license/tavsiye-bildirimi', { token: A.token })).d;
    const beklenenA = `Tavsiye ettiğiniz ${ON} Tavsiye Edilen B paket aldı; lisansınıza 2 ay eklendi. Yeni bitiş: ${trTarih(tA4.license_end_date)}.`;
    ok('tavsiye eden bildirimi', bA.bildirimler.length === 1 && bA.bildirimler[0].metin === beklenenA, bA);
    ok('baska isletme kapatamaz (404)', (await js(`/api/license/tavsiye-bildirimi/${sB2.id}/goruldu`, { token: kart.d && (await kiraciKur({ ad: 'Yabanci' })).token, body: {} })).status === 404);
    ok('goruldu 200', (await js(`/api/license/tavsiye-bildirimi/${sB2.id}/goruldu`, { token: A.token, body: {} })).status === 200);
    ok('tavsiye edenin bildirimi kapandi', (await js('/api/license/tavsiye-bildirimi', { token: A.token })).d.bildirimler.length === 0);
    ok('tavsiye edilenin bildirimi duruyor', (await js('/api/license/tavsiye-bildirimi', { token: tokB })).d.bildirimler.length === 1);
    const kartA5 = (await js('/api/license/tavsiye', { token: A.token })).d;
    const satirA5 = kartA5.liste.find((x) => x.id === sB2.id) || {};
    ok('kart listesi: odul verildi + metin', satirA5.durum === 'odul_verildi' && satirA5.durumAdi === 'Paket aldı; size 2 ay eklendi' && satirA5.isletme === `${ON} Tavsiye Edilen B`, satirA5);

    console.log('\n=== 7) Bir kez (idempotent) ===');
    const bOnce = (await kiraci(B.id)).license_end_date, aOnce2 = (await kiraci(A.id)).license_end_date;
    const tekrar = await TV.odemeSonrasi(B.id, { kaynak: 'havale' });
    ok('kanca tekrar: degisiklik yok', !tekrar.edilen && tekrar.eden.length === 0 && (await kiraci(B.id)).license_end_date === bOnce, tekrar);
    const u0 = await js(`/api/root/yonetim/tavsiyeler/${sB2.id}/uygula`, { token: rj, body: {} });
    ok('root uygula: iki odul de uygulanmis', u0.status === 200 && u0.d.degisti === false, u0.d);
    const onB2 = await onayla(await odemeKur(B.id, 'beklemede', 'yenileme'));
    const tB3 = await kiraci(B.id);
    ok('ikinci odeme (yenileme): tavsiye edilene ek 30 gun yok', onB2.status === 200 && fark(tB3.license_end_date, bOnce) === 365 * GUN && !/Tavsiye koduyla/.test(onB2.d.message), [onB2.d, bOnce, tB3.license_end_date]);
    ok('ikinci odeme: tavsiye edene ek 60 gun yok', (await kiraci(A.id)).license_end_date === aOnce2);
    ok('tek satir, edilen basina bir kez', (await query('SELECT COUNT(*) AS n FROM tavsiyeler WHERE tavsiye_edilen_id = ?', [B.id])).rows[0].n === 1);

    console.log('\n=== 8) Tavsiye eden odeme yapmamis: odul bekler ===');
    const C = await denemeAc('Tavsiye Eden C (deneme)');
    const kodC = await TV.kodVer(C.id);
    const D = await denemeAc('Tavsiye Edilen D', { tavsiyeKodu: kodC });
    const cOnce = (await kiraci(C.id)).license_end_date;
    const onD = await onayla(await odemeKur(D.id, 'beklemede'));
    const sD = await tavsiyeSatiri(D.id);
    ok('D onayi: D +30 gun, durum odul_bekliyor', onD.status === 200 && sD.edilen_gun === 30 && sD.durum === 'odul_bekliyor' && !sD.eden_odul_at, sD);
    ok('C (odemesiz) bitisi degismedi', (await kiraci(C.id)).license_end_date === cOnce);
    const tokC = await girisYap(C.id);
    const kartC = (await js('/api/license/tavsiye', { token: tokC })).d;
    ok('C kartinda bekleyen odul metni', (kartC.liste[0] || {}).durumAdi === 'Paket aldı; ilk ödemeniz onaylanınca size 2 ay eklenecek' && kartC.ozet.bekleyen === 1, kartC.liste);
    const onC = await onayla(await odemeKur(C.id, 'beklemede'));
    const tC = await kiraci(C.id);
    const sD2 = await tavsiyeSatiri(D.id);
    ok('C kendi ilk odemesi onaylaninca: onay bitisi + 60 gun', onC.status === 200 && sD2.durum === 'odul_verildi'
        && fark(tC.license_end_date, sD2.eden_onceki_bitis) === 60 * GUN && yakin(tC.license_end_date, Date.now() + 425 * GUN), [sD2, tC.license_end_date]);
    ok('C bildirimi', (await js('/api/license/tavsiye-bildirimi', { token: tokC })).d.bildirimler.some((x) => x.tur === 'eden'));

    console.log('\n=== 9) SofraMix odeme yolu ===');
    const E = await kiraciKur({ ad: 'Tavsiye Eden E', bitis: new Date(Date.now() - 5 * GUN), odeme: true });
    const kodE = await TV.kodVer(E.id);
    const F = await denemeAc('Tavsiye Edilen F', { tavsiyeKodu: kodE });
    const P = require('./src/services/posProvizyon');
    const fOnce = (await kiraci(F.id)).license_end_date;
    const odemeId = 'tvs-smx-' + crypto.randomBytes(5).toString('hex');
    const smx = await P.odemeIsle({ odeme_id: odemeId, isletme_adi: `${ON} Tavsiye Edilen F`, yetkili_email: F.eposta, tutar_kurus: 100000,
        kdv_kurus: 20000, yontem: 'kart', onay_tarihi: new Date().toISOString(), kaynak: 'soframix' }, { tenantId: F.id });
    const tF = await kiraci(F.id);
    const sF = await tavsiyeSatiri(F.id);
    ok('SofraMix islendi; F: 365 + 30 gun', smx.durum === 'islendi' && sF.edilen_gun === 30 && sF.odeme_kaynak === 'soframix' && sF.odeme_ref === odemeId
        && fark(tF.license_end_date, sF.edilen_onceki_bitis) === 30 * GUN && smx.lisansBitis === tF.license_end_date
        && yakin(sF.edilen_onceki_bitis, new Date(fOnce).getTime() + 365 * GUN, 5 * 60000), [smx, sF]);
    const tE = await kiraci(E.id);
    ok('E (bitmis lisans): simdi + 60 gun', sF.durum === 'odul_verildi' && yakin(tE.license_end_date, Date.now() + 60 * GUN, 5 * 60000), tE.license_end_date);
    const smx2 = await P.odemeIsle({ odeme_id: odemeId, isletme_adi: 'x', yetkili_email: F.eposta, tutar_kurus: 100000 }, { tenantId: F.id });
    ok('ayni SofraMix odemesi tekrar: degisiklik yok', smx2.durum === 'zaten_islendi' && (await kiraci(F.id)).license_end_date === tF.license_end_date
        && (await kiraci(E.id)).license_end_date === tE.license_end_date, smx2);
    // SofraMix ile odeyen tavsiye eden "odeme yapan" sayilir
    const H = await denemeAc('Tavsiye Eden H (SofraMix)');
    await query("INSERT INTO pos_provizyon (id, odeme_id, tenant_id, durum) VALUES (?, ?, ?, 'islendi')", [uuid(), 'tvs-' + crypto.randomBytes(5).toString('hex'), H.id]);
    const J = await denemeAc('Tavsiye Edilen J', { tavsiyeKodu: await TV.kodVer(H.id) });
    const hOnce = (await kiraci(H.id)).license_end_date;
    await onayla(await odemeKur(J.id, 'beklemede'));
    ok('SofraMix odemeli tavsiye eden: +60 gun', fark((await kiraci(H.id)).license_end_date, hOnce) === 60 * GUN && (await tavsiyeSatiri(J.id)).durum === 'odul_verildi');

    console.log('\n=== 10) Root listesi ve "Ödülü uygula" ===');
    const L = await js('/api/root/yonetim/tavsiyeler', { token: rj });
    const satirB = L.d && L.d.liste.find((x) => x.id === sB2.id);
    ok('root listesi', L.status === 200 && satirB && satirB.durumAdi === 'Ödül verildi' && satirB.eden.ad === `${ON} Tavsiye Eden A`
        && satirB.edilenOdul.gun === 30 && satirB.edenOdul.gun === 60, satirB);
    ok('root listesi: iptal sebebi okunur', (L.d.liste.find((x) => x.id === sT.id) || {}).iptalSebep === 'aynı telefon');
    ok('root listesi: durum suzgeci', (await js('/api/root/yonetim/tavsiyeler?durum=iptal', { token: rj })).d.liste.every((x) => x.durum === 'iptal'));
    ok('isletme jetonuyla root listesi acilmaz', [401, 403].includes((await js('/api/root/yonetim/tavsiyeler', { token: A.token })).status));
    // Kanca calismadan onaylanmis odeme (ornegin hata): root elle uygular
    const M = await denemeAc('Tavsiye Edilen M', { tavsiyeKodu: kodA });
    const sM = await tavsiyeSatiri(M.id);
    const u1 = await js(`/api/root/yonetim/tavsiyeler/${sM.id}/uygula`, { token: rj, body: {} });
    ok('odemesiz: 409', u1.status === 409, u1);
    await odemeKur(M.id, 'onaylandi');
    const mOnce = (await kiraci(M.id)).license_end_date, aOnce3 = (await kiraci(A.id)).license_end_date;
    const u2 = await js(`/api/root/yonetim/tavsiyeler/${sM.id}/uygula`, { token: rj, body: {} });
    ok('root uygula: iki odul', u2.status === 200 && u2.d.degisti && fark((await kiraci(M.id)).license_end_date, mOnce) === 30 * GUN
        && fark((await kiraci(A.id)).license_end_date, aOnce3) === 60 * GUN, u2.d);
    const u3 = await js(`/api/root/yonetim/tavsiyeler/${sM.id}/uygula`, { token: rj, body: {} });
    ok('root uygula tekrar: degisiklik yok', u3.status === 200 && u3.d.degisti === false && fark((await kiraci(A.id)).license_end_date, aOnce3) === 60 * GUN, u3.d);
    ok('root uygula: iptal kayitta 409', (await js(`/api/root/yonetim/tavsiyeler/${sT.id}/uygula`, { token: rj, body: {} })).status === 409);
    ok('root uygula: bilinmeyen 404', (await js(`/api/root/yonetim/tavsiyeler/${uuid()}/uygula`, { token: rj, body: {} })).status === 404);
    const kartA6 = (await js('/api/license/tavsiye', { token: A.token })).d;
    ok('tavan yok: A icin 3 aktif tavsiye listede', kartA6.liste.length === 3 && kartA6.ozet.odulVerilen === 2, kartA6.ozet);

    sunucu.kill();
    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
