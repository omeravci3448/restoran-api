// Lisans satisi: para ve onay akisi (A1, 2026-11-18). Kapsam: KDV hesabi (kurus; teklif, kayit, liste, root metni,
// eski kayit "KDV hesaplanmamis"), fatura bilgisi zorunlulugu ve dogrulamasi, bekleyen bildirim 409 (BEKLEYEN_BILDIRIM),
// odeme korumasi (bildir -> lisans biter -> yine yazilir -> pencere biter -> kapanir; red -> kapanir; redden sonraki 30 gun
// icinde yeni bildirime koruma yok; iptal korumayi bitirir; ayar 0 = kapali), red sebebi (en az 5 karakter, musteri
// gorur), yukseltmede bitis asla kisalmaz (erken yenileme sonrasi uzun donem fiyati). Sunucuyu KENDI baslatir.
// Calistir: node test_lisans_kdv_koruma.js   (port 47100)
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 47100, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'lisans-kdv-koruma-test-jwt';
const ON = 'KDVK Test';
const EPOSTA_ON = 'kdvk-';
const GUN = 86400000;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 500) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const KOD_TABAN = Math.floor(Math.random() * 9999);
let kodSayac = 0;
const yakin = (a, b, tol = 5 * 60000) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) < tol;

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
const bitisGun = (gun) => new Date(Date.now() + gun * GUN - 3600000).toISOString();
const FATURA = { billingName: 'Deneme Gıda Ltd. Şti.', billingTaxId: '1234567890', billingTaxOffice: 'Afyon VD', billingAddress: 'Test Mah. 1, Afyonkarahisar' };

async function kiraciKur({ ad, tier = 'TIER_6_10', moduller = ['BASE', 'MENU_DIGITAL'], bitis, fatura = true }) {
    const id = uuid();
    const slug = 'kdvk-' + crypto.randomBytes(4).toString('hex');
    const kod = String(50000 + (KOD_TABAN + kodSayac++) % 9999);
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, '05320000000', 'Test Mah. 1', ?, ?, ?, 1, datetime('now', '-400 days'))`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, tier, JSON.stringify(moduller), bitis]);
    if (fatura) {
        await query("UPDATE tenants SET billing_name = business_name, billing_tax_id = '12345678901', billing_address = 'Test Mah. 1, Afyon' WHERE id = ?", [id]);
    }
    const eposta = `${EPOSTA_ON}sahip-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), id, eposta, await bcrypt.hash('sahip1234', 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    const g = await js('/api/auth/login', { body: { email: eposta, businessCode: kod, password: 'sahip1234' } });
    return { id, slug, kod, eposta, token: g.d && g.d.token, girisDurumu: g.status };
}
// Odeme gecmisi: isletmeyi deneme sinifindan cikarir (donemi bitmis eski onayli odeme)
async function gecmisKur(tenantId) {
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, donem_bitis, islenen_at, onay_gun)
                 VALUES (?, ?, 'TIER_6_10', '[]', 1000, 'onaylandi', datetime('now', '-30 days'), datetime('now', '-395 days'), 365)`,
        ['kdvk-gecmis-' + crypto.randomBytes(4).toString('hex'), tenantId]);
}
const kiraci = async (id) => (await query('SELECT * FROM tenants WHERE id = ?', [id])).rows[0];
const kayit = async (id) => (await query('SELECT * FROM lisans_odemeleri WHERE id = ?', [id])).rows[0];

let rootId = null;
async function rootJeton() {
    if (!rootId) {
        rootId = uuid();
        await query('INSERT INTO root_users (id, email, password_hash, name, totp_enabled) VALUES (?, ?, ?, ?, 1)',
            [rootId, `${EPOSTA_ON}root-${rootId.slice(0, 6)}@ornek.test`, 'x', 'Test Root']);
    }
    return jwt.sign({ rootId, scope: 'root' }, JWT_SECRET, { expiresIn: '1h' });
}

let katalogYedek = null, ayarYedek = null;
const AYARLAR = ['kdv_orani', 'odeme_koruma_gun'];
async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%' OR owner_email LIKE '${EPOSTA_ON}%'`);
    for (const r of t.rows) {
        for (const tb of ['lisans_odemeleri', 'categories', 'root_olaylar', 'license_cache', 'islem_gunlugu', 'yonetim_gunlugu', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    if (katalogYedek) for (const x of katalogYedek) await query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [x.fiyat, x.gorunur, x.id]);
    if (ayarYedek) {
        await query(`DELETE FROM sistem_ayarlari WHERE anahtar IN ('kdv_orani', 'odeme_koruma_gun')`);
        for (const x of ayarYedek) await query('INSERT INTO sistem_ayarlari (anahtar, deger, guncellendi_at) VALUES (?, ?, ?)', [x.anahtar, x.deger, x.guncellendi_at]);
    }
}
const fiyatYaz = (id, fiyat, gorunur = 1) => query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [fiyat, gorunur, id]);

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    katalogYedek = (await query('SELECT id, fiyat, gorunur FROM lisans_katalog')).rows;
    ayarYedek = (await query(`SELECT anahtar, deger, guncellendi_at FROM sistem_ayarlari WHERE anahtar IN ('kdv_orani', 'odeme_koruma_gun')`)).rows;
    await query(`DELETE FROM sistem_ayarlari WHERE anahtar IN ('kdv_orani', 'odeme_koruma_gun')`);   // varsayilanlar: %20, 3 gun
    await fiyatYaz('TIER-TIER_1_5', 3000); await fiyatYaz('TIER-TIER_6_10', 4000); await fiyatYaz('TIER-TIER_11_20', 6000);
    await fiyatYaz('TIER-TIER_20_PLUS', 9000); await fiyatYaz('MODUL-MENU_DIGITAL', 1000); await fiyatYaz('MODUL-GARSON', 500);

    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '',
               ODEME_KORUMA_ONBELLEK_MS: '0' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(800);
    const rj = await rootJeton();
    const rootKaydi = async (id) => (await js('/api/root/lisans-odemeleri', { token: rj })).d.find((x) => x.id === id);
    const yaz = (u) => js('/api/categories', { token: u.token, body: { name: 'Koruma deneme ' + crypto.randomBytes(2).toString('hex') } });

    console.log('=== 0) Sema + birim hesap ===');
    const kolonlar = (await query('PRAGMA table_info(lisans_odemeleri)')).rows.map((x) => x.name);
    ok('lisans_odemeleri KDV kolonlari', ['kdv_orani', 'kdv_tutari', 'genel_toplam'].every((k) => kolonlar.includes(k)), kolonlar);
    const KDV = require('./src/services/lisansKdv');
    const k1 = KDV.kdvHesapla(11000, 20);
    ok('11.000 + %20 = 13.200', k1.araToplam === 11000 && k1.kdvTutari === 2200 && k1.genelToplam === 13200, k1);
    const k2 = KDV.kdvHesapla(2760.27, 20);
    ok('kurus yuvarlama: 2760,27 -> KDV 552,05, toplam 3312,32', k2.kdvTutari === 552.05 && k2.genelToplam === 3312.32, k2);
    ok('kdvMetni', /^11\.000 TL \+ %20 KDV = 13\.200 TL$/.test(KDV.kdvMetni({ tutar: 11000, kdv_orani: 20, kdv_tutari: 2200, genel_toplam: 13200 })),
        KDV.kdvMetni({ tutar: 11000, kdv_orani: 20, kdv_tutari: 2200, genel_toplam: 13200 }));
    ok('eski kayit: KDV hesaplanmamis', /KDV hesaplanmamış/.test(KDV.kdvMetni({ tutar: 5000 })) && KDV.kayitKdv({ tutar: 5000 }).genelToplam === 5000);
    const LT = require('./src/services/lisansTalep');
    const uzak = new Date(Date.now() + 500 * GUN).toISOString();
    ok('onayBitisi yukseltme: mevcut bitis daha ilerideyse korunur', LT.onayBitisi({ tur: 'yukseltme', mevcutBitis: uzak, gun: 365 }) === uzak);
    ok('onayBitisi yukseltme: mevcut bitis yakinsa onay + 365', yakin(LT.onayBitisi({ tur: 'yukseltme', mevcutBitis: bitisGun(100), gun: 365 }), Date.now() + 365 * GUN));

    console.log('\n=== 1) Fatura bilgisi zorunlu ===');
    const a = await kiraciKur({ ad: 'Fatura', bitis: bitisGun(10), fatura: false });
    await gecmisKur(a.id);
    ok('giris', a.girisDurumu === 200 && !!a.token, a);
    const f0 = (await js('/api/license/fatura', { token: a.token })).d;
    ok('fatura bilgisi eksik gorunur', f0 && f0.tamam === false && f0.eksik.includes('billing_tax_id'), f0);
    const s0 = await js('/api/license/purchase', { token: a.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('eksikken satin alma 400 FATURA_BILGISI_EKSIK', s0.status === 400 && s0.d.code === 'FATURA_BILGISI_EKSIK', s0);
    ok('kayit acilmadi', (await query('SELECT COUNT(*) AS n FROM lisans_odemeleri WHERE tenant_id = ? AND durum = ?', [a.id, 'beklemede'])).rows[0].n === 0);
    const put = (body) => js('/api/license/fatura', { token: a.token, method: 'PUT', body });
    ok('vergi no 5 hane 400', (await put({ ...FATURA, billingTaxId: '12345' })).status === 400);
    ok('harfli no 400', (await put({ ...FATURA, billingTaxId: '12345abcde' })).status === 400);
    ok('VKN + vergi dairesi yok 400', (await put({ ...FATURA, billingTaxOffice: '' })).status === 400);
    ok('TCKN 0 ile baslarsa 400', (await put({ ...FATURA, billingTaxId: '01234567890', billingTaxOffice: '' })).status === 400);
    ok('adres yok 400', (await put({ ...FATURA, billingAddress: '' })).status === 400);
    const fOk = await put({ ...FATURA, billingTaxId: '123 456 7890' });
    ok('gecerli fatura bilgisi 200 + tamam (bosluklar atilir)', fOk.status === 200 && fOk.d.tamam === true && fOk.d.billingTaxId === '1234567890', fOk);
    ok('TCKN vergi dairesiz gecerli', (await put({ ...FATURA, billingTaxId: '12345678901', billingTaxOffice: '' })).d.tamam === true);
    await put(FATURA);
    ok('yonetim gunlugune vergi no yazilmadi', !(await query("SELECT COUNT(*) AS n FROM yonetim_gunlugu WHERE ozet LIKE '%1234567890%' OR ayrinti LIKE '%1234567890%'")).rows[0].n);

    console.log('\n=== 2) KDV: teklif, kayit, liste, root ===');
    const q = (await js('/api/license/quote', { token: a.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).d;
    ok('teklif: ara 5000, KDV %20 1000, genel 6000', q.tur === 'yenileme' && q.araToplam === 5000 && q.odenecek === 5000 && q.kdvOrani === 20
        && q.kdvTutari === 1000 && q.genelToplam === 6000, q);
    const q0 = (await js('/api/license/quote', { body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).d;
    ok('oturumsuz teklifte de KDV', q0.total === 5000 && q0.kdvTutari === 1000 && q0.genelToplam === 6000, q0);
    const s1 = await js('/api/license/purchase', { token: a.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('satin alma 201 + genel toplam', s1.status === 201 && s1.d.genelToplam === 6000 && s1.d.odenecek === 5000, s1);
    const r1 = await kayit(s1.d.id);
    ok('kayit: tutar KDV haric, kdv kolonlari dolu', r1.tutar === 5000 && r1.kdv_orani === 20 && r1.kdv_tutari === 1000 && r1.genel_toplam === 6000, r1);
    const l1 = (await js('/api/license/purchases', { token: a.token })).d.find((x) => x.id === s1.d.id);
    ok('musteri listesi: havale tutari 6000, KDV var, havale kodu', l1.havale_tutari === 6000 && l1.kdv_var === true && l1.amount === 5000
        && l1.havale_kodu === 'MDA-' + a.kod && l1.koruma_bitis === null, l1);
    const rk = await rootKaydi(s1.d.id);
    ok('root: "5.000 TL + %20 KDV = 6.000 TL", havale tutari, fatura bilgisi', rk && rk.kdv_metni === '5.000 TL + %20 KDV = 6.000 TL' && rk.havale_tutari === 6000
        && rk.havale_kodu === 'MDA-' + a.kod && rk.billing_name === FATURA.billingName && rk.billing_tax_id === FATURA.billingTaxId
        && Array.isArray(rk.fatura_eksik) && rk.fatura_eksik.length === 0, rk);

    console.log('\n=== 3) Bekleyen bildirim varken 409 ===');
    const s2 = await js('/api/license/purchase', { token: a.token, body: { tier: 'TIER_11_20', modules: ['BASE'] } });
    ok('409 BEKLEYEN_BILDIRIM + id + paket + tutar', s2.status === 409 && s2.d.code === 'BEKLEYEN_BILDIRIM' && s2.d.id === s1.d.id
        && s2.d.tier === 'TIER_6_10' && s2.d.genelToplam === 6000 && s2.d.odemeBildirildi === false && !!s2.d.tierAd, s2);
    ok('iptal 200', (await js(`/api/license/purchases/${s1.d.id}/cancel`, { token: a.token, method: 'POST' })).status === 200);
    const s3 = await js('/api/license/purchase', { token: a.token, body: { tier: 'TIER_11_20', modules: ['BASE'] } });
    ok('iptalden sonra yeni secimle 201', s3.status === 201 && s3.d.genelToplam === 7200, s3);
    await js(`/api/license/purchases/${s3.d.id}/cancel`, { token: a.token, method: 'POST' });
    // Eski (KDV oncesi) kayit
    const eskiId = 'kdvk-eski-' + crypto.randomBytes(3).toString('hex');
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, created_at) VALUES (?, ?, 'TIER_6_10', '["BASE"]', 4000, 'beklemede', datetime('now', '-1 days'))`, [eskiId, a.id]);
    const re = await rootKaydi(eskiId);
    ok('eski kayit root: KDV hesaplanmamis, havale tutari = tutar', re && re.kdv_var === false && /KDV hesaplanmamış/.test(re.kdv_metni) && re.havale_tutari === 4000, re);
    const le = (await js('/api/license/purchases', { token: a.token })).d.find((x) => x.id === eskiId);
    ok('eski kayit musteri: kdv_var false, havale tutari 4000', le && le.kdv_var === false && le.havale_tutari === 4000, le);
    await query("UPDATE lisans_odemeleri SET durum = 'iptal' WHERE id = ?", [eskiId]);

    console.log('\n=== 4) Odeme korumasi: bildir -> lisans biter -> acik -> pencere biter -> kapali ===');
    const b = await kiraciKur({ ad: 'Koruma', bitis: bitisGun(5) });
    await gecmisKur(b.id);
    const sb = await js('/api/license/purchase', { token: b.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('talep 201', sb.status === 201, sb);
    ok('bildirmeden once koruma yok (lisans aktif)', !(await js('/api/auth/me', { token: b.token })).d.odemeKorumasi);
    ok('odemeyi yaptim 200', (await js(`/api/license/purchases/${sb.d.id}/mark-paid`, { token: b.token, body: { paymentRef: 'Ali Veli' } })).status === 200);
    await query('UPDATE tenants SET license_end_date = ? WHERE id = ?', [new Date(Date.now() - 10 * GUN).toISOString(), b.id]);
    const me1 = (await js('/api/auth/me', { token: b.token })).d;
    ok('lisans bitti ama korumada: AKTIF + odemeKorumasi.bitis ~ bildirim + 3 gun', me1.lisansDurum === 'AKTIF' && me1.odemeKorumasi
        && yakin(me1.odemeKorumasi.bitis, Date.now() + 3 * GUN), me1);
    ok('korumada yazma serbest (kategori 201)', (await yaz(b)).status === 201);
    const st1 = (await js(`/api/license/purchases/${sb.d.id}`, { token: b.token })).d;
    ok('kayitta koruma_bitis', !!st1.koruma_bitis && yakin(st1.koruma_bitis, me1.odemeKorumasi.bitis), st1);
    const rkb = await rootKaydi(sb.d.id);
    ok('root listesinde koruma_bitis', rkb && !!rkb.koruma_bitis, rkb);
    // Pencere biter
    await query("UPDATE lisans_odemeleri SET odeme_bildirildi_at = datetime('now', '-4 days') WHERE id = ?", [sb.d.id]);
    const yz2 = await yaz(b);
    ok('3 gun dolunca yazma 403 LICENSE_EXPIRED', yz2.status === 403 && yz2.d.code === 'LICENSE_EXPIRED', yz2);
    const me2 = (await js('/api/auth/me', { token: b.token })).d;
    ok('/me KAPALI, koruma yok', me2.lisansDurum === 'KAPALI' && !me2.odemeKorumasi, me2);
    ok('tekrar "odemeyi yaptim" 200', (await js(`/api/license/purchases/${sb.d.id}/mark-paid`, { token: b.token, body: { paymentRef: 'Ali Veli 2' } })).status === 200);
    ok('tekrar bildirmek pencereyi uzatmaz (403)', (await yaz(b)).status === 403);
    ok('ilk bildirim ani korundu, not guncellendi', (await kayit(sb.d.id)).aciklama === 'Ali Veli 2'
        && Date.now() - new Date((await kayit(sb.d.id)).odeme_bildirildi_at.replace(' ', 'T') + 'Z').getTime() > 3.9 * GUN);
    await query("UPDATE lisans_odemeleri SET odeme_bildirildi_at = datetime('now', '-1 hours') WHERE id = ?", [sb.d.id]);
    ok('pencere icine donunce yine acik', (await yaz(b)).status === 201);
    // QR menu (senkron yol) da acik sayar: lisans KAPALI'da siparis kapali olurdu
    const OK = require('./src/services/odemeKorumasi');
    await OK.tazele();   // bu surecin onbellegi (sunucudaki degil) acilista yuklendi; taze oku
    ok('etkinDurum servis duzeyinde AKTIF', (await OK.etkinDurum(b.id, new Date(Date.now() - 10 * GUN).toISOString())).durum === 'AKTIF');

    console.log('\n=== 5) Red: sebep zorunlu, koruma biter, musteri gorur ===');
    ok('kisa red sebebi 400', (await js(`/api/root/lisans-odemeleri/${sb.d.id}/reddet`, { token: rj, body: { not: 'yok' } })).status === 400);
    const SEBEP = 'Havale hesabımızda görünmüyor';
    ok('red 200', (await js(`/api/root/lisans-odemeleri/${sb.d.id}/reddet`, { token: rj, body: { not: SEBEP } })).status === 200);
    const yz3 = await yaz(b);
    ok('redden sonra yazma 403', yz3.status === 403 && yz3.d.code === 'LICENSE_EXPIRED', yz3);
    const lb = (await js('/api/license/purchases', { token: b.token })).d;
    ok('musteri listesinde en ustte REDDEDILDI + sebep', lb[0].id === sb.d.id && lb[0].status === 'REJECTED' && lb[0].admin_note === SEBEP, lb[0]);
    const yg = (await query("SELECT tenant_id FROM yonetim_gunlugu WHERE islem = 'odeme_red' AND hedef_id = ?", [sb.d.id])).rows[0];
    ok('yonetim gunlugu red kaydi isletmeye bagli', yg && yg.tenant_id === b.id, yg);
    // 30 gun icinde ikinci bildirim: koruma YOK
    const sb2 = await js('/api/license/purchase', { token: b.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    ok('KAPALI iken yeni talep acilir (201)', sb2.status === 201, sb2);
    ok('ikinci bildirim 200', (await js(`/api/license/purchases/${sb2.d.id}/mark-paid`, { token: b.token, body: {} })).status === 200);
    const yz4 = await yaz(b);
    ok('redden sonraki 30 gun icinde bildirime koruma yok (403)', yz4.status === 403 && yz4.d.code === 'LICENSE_EXPIRED', yz4);
    ok('/me koruma yok', !(await js('/api/auth/me', { token: b.token })).d.odemeKorumasi);
    ok('kayitta koruma_bitis yok', (await js(`/api/license/purchases/${sb2.d.id}`, { token: b.token })).d.koruma_bitis === null);
    // Red 31 gun once olsaydi koruma olurdu
    await query("UPDATE lisans_odemeleri SET islenen_at = datetime('now', '-31 days') WHERE id = ?", [sb.d.id]);
    ok('red 30 gunden eskiyse koruma yeniden gecerli', (await yaz(b)).status === 201);
    // Onay: lisans uzar, koruma gereksiz
    const on = await js(`/api/root/lisans-odemeleri/${sb2.d.id}/onayla`, { token: rj, body: { gun: 365 } });
    ok('onay 200 + lisans aktif', on.status === 200 && (await js('/api/auth/me', { token: b.token })).d.lisansDurum === 'AKTIF', on);
    ok('onaydan sonra odemeKorumasi yok', !(await js('/api/auth/me', { token: b.token })).d.odemeKorumasi);

    console.log('\n=== 6) Iptal korumayi bitirir; ayar 0 = kapali ===');
    const c = await kiraciKur({ ad: 'Iptal', bitis: new Date(Date.now() - 10 * GUN).toISOString() });
    await gecmisKur(c.id);
    const sc = await js('/api/license/purchase', { token: c.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    await js(`/api/license/purchases/${sc.d.id}/mark-paid`, { token: c.token, body: {} });
    ok('korumada yazma 201', (await yaz(c)).status === 201);
    await js(`/api/license/purchases/${sc.d.id}/cancel`, { token: c.token, method: 'POST' });
    ok('iptal sonrasi yazma 403', (await yaz(c)).status === 403);
    // Iptal edip yeniden bildirmek pencereyi sifirlamaz: baslangic ilk bildirim
    await query("UPDATE lisans_odemeleri SET odeme_bildirildi_at = datetime('now', '-2 days') WHERE id = ?", [sc.d.id]);
    const sc2 = await js('/api/license/purchase', { token: c.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    await js(`/api/license/purchases/${sc2.d.id}/mark-paid`, { token: c.token, body: {} });
    const mec = (await js('/api/auth/me', { token: c.token })).d;
    ok('yeniden bildirimde koruma ilk bildirimden sayilir (~1 gun kaldi)', mec.odemeKorumasi && yakin(mec.odemeKorumasi.bitis, Date.now() + GUN, 10 * 60000), mec);
    await query("UPDATE lisans_odemeleri SET odeme_bildirildi_at = datetime('now', '-4 days') WHERE id = ?", [sc.d.id]);
    ok('ilk bildirimin penceresi bitince yeni bildirim de korumaz (403)', (await yaz(c)).status === 403);
    await query("UPDATE lisans_odemeleri SET odeme_bildirildi_at = datetime('now', '-1 hours') WHERE id = ?", [sc.d.id]);
    ok('pencere icindeyken yazma 201', (await yaz(c)).status === 201);
    const ay = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { odeme_koruma_gun: '0' } });
    ok('ayar odeme_koruma_gun = 0', ay.status === 200 && ay.d.sayisal.odeme_koruma_gun.etkin === 0, ay.d && ay.d.sayisal);
    ok('ayar 0 iken koruma yok (403)', (await yaz(c)).status === 403);
    const ay2 = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { odeme_koruma_gun: '' } });
    ok('bos birakilinca varsayilan 3', ay2.d.sayisal.odeme_koruma_gun.etkin === 3 && ay2.d.sayisal.kdv_orani.etkin === 20, ay2.d.sayisal);
    ok('varsayilana donunce koruma geri gelir', (await yaz(c)).status === 201);
    ok('gecersiz KDV orani 400', (await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { kdv_orani: '75' } })).status === 400);
    await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { kdv_orani: '10' } });
    const q10 = (await js('/api/license/quote', { body: { tier: 'TIER_6_10', modules: ['BASE'] } })).d;
    ok('KDV orani ayardan (%10)', q10.kdvOrani === 10 && q10.kdvTutari === 400 && q10.genelToplam === 4400, q10);
    await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { kdv_orani: '' } });

    console.log('\n=== 7) Yukseltme: bitis asla kisalmaz (erken yenileme sonrasi) ===');
    const uzunBitis = bitisGun(500);
    const d = await kiraciKur({ ad: 'Uzun', bitis: uzunBitis });
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, donem_bitis, islenen_at, onay_gun)
                 VALUES (?, ?, 'TIER_6_10', '[]', 5000, 'onaylandi', ?, datetime('now', '-10 days'), 365)`, ['kdvk-uzun-' + crypto.randomBytes(3).toString('hex'), d.id, uzunBitis]);
    const qd = (await js('/api/license/quote', { token: d.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } })).d;
    // Yillik 5500; 500 gun: 5500 x 500 / 365 = 7534,25; kredi 5000 x 500 / 365 = 6849,32; odenecek 684,93
    ok('uzun donem yukseltme: tutar kalan sureye oranlanir', qd.tur === 'yukseltme' && qd.uzunDonem === true && qd.kalanGun === 500
        && qd.donemTutari === 7534.25 && qd.krediTutari === 6849.32 && qd.odenecek === 684.93, qd);
    ok('aciklama bitisin korundugunu soyler, "1 yillik suresi onay gunu baslar" demez', /korunur/.test(qd.aciklama) && !/Yeni 1 yıllık süreniz/.test(qd.aciklama), qd.aciklama);
    ok('KDV odenecek uzerinden', qd.araToplam === 684.93 && qd.kdvTutari === 136.99 && qd.genelToplam === 821.92, qd);
    const sd = await js('/api/license/purchase', { token: d.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    ok('talep 201', sd.status === 201, sd);
    const rkd = await rootKaydi(sd.d.id);
    ok('root onizlemesi mevcut bitisi korur', rkd && yakin(rkd.yeni_bitis_onizleme, uzunBitis), rkd && rkd.yeni_bitis_onizleme);
    const ond = await js(`/api/root/lisans-odemeleri/${sd.d.id}/onayla`, { token: rj, body: { gun: 365 } });
    const td = await kiraci(d.id);
    ok('onayda bitis geri gitmedi (500 gun korundu)', ond.status === 200 && yakin(td.license_end_date, uzunBitis), [ond.d, td.license_end_date]);
    ok('moduller yazildi', JSON.parse(td.license_modules).includes('GARSON'));
    // Normal yukseltme (kalan <= 365): eskisi gibi onay + 365
    const e = await kiraciKur({ ad: 'Kisa', bitis: bitisGun(200) });
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, donem_bitis, islenen_at, onay_gun)
                 VALUES (?, ?, 'TIER_6_10', '[]', 5000, 'onaylandi', ?, datetime('now', '-165 days'), 365)`, ['kdvk-kisa-' + crypto.randomBytes(3).toString('hex'), e.id, bitisGun(200)]);
    const qe = (await js('/api/license/quote', { token: e.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } })).d;
    ok('kisa donem: uzunDonem yok, odenecek = 5500 - kredi', qe.uzunDonem === false && qe.donemTutari === 5500 && qe.odenecek === Math.round((5500 - qe.krediTutari) * 100) / 100, qe);

    console.log('\n=== 8) Isletme e-posta alicilari ===');
    const al = await require('./src/services/lisansBildirim').alicilar(d.id);
    ok('alicilar: sahip e-postasi + owner_email (tekil)', al.liste.includes(d.eposta.toLowerCase()) && al.liste.length === 2, al);

    sunucu.kill();
    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await temizle(); } catch (_) {} process.exit(1); });
