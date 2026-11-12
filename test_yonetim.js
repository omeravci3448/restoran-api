// Root yonetim ekranlari: genel bakis sayilari ve geliri (fark yontemiyle), isletme listesiyle ayni sinif, duyuru
// hedefleme / tarihleri / kimler / dogrulama / tohum taslak, yonetim gunlugune dusen islemler (lisans, modul, hediye,
// ac-kapat, indirim, odeme onay-red, katalog, ayarlar, plaka, duyuru, destek, cihaz yedegi) + filtreler, sifre ve
// jetonun gunluge yazilmamasi, isletme ayrintisi (yetki, alanlar, ic notlar, ciro yok, son giris), ayarlara baglanan
// sabitlerin varsayilan davranisi (deneme 7 gun, salt-okunur 3 gun) ve degistirilince.
// Sunucuyu KENDI baslatir.  Calistir: node test_yonetim.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 46232, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'yonetim-test-jwt';
const ON = 'YNTM Test';
const EPOSTA_ON = 'yntm-';
const TEL_ON = '0533 77';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 400) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const gun = (n) => new Date(Date.now() + n * 86400000).toISOString();
const sqlZaman = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const istanbulGunu = (n = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date(Date.now() + n * 86400000));

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

const SAHIP_SIFRE = 'GizliSahip!8421';
async function kiraciKur(ad, { tier = 'TIER_6_10', moduller = ['BASE', 'MENU_DIGITAL'], bitis = gun(200), aktif = 1, olusturma = null,
    kvkk = false, deneme = false, telefon = null, parentOrg = null, kasiyer = false } = {}) {
    const id = uuid();
    const slug = 'yntm-' + crypto.randomBytes(4).toString('hex');
    const kod = String(80000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, parent_org, license_tier, license_modules,
                              license_end_date, is_active, kvkk_consent_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, telefon || `${TEL_ON} ${String(Math.floor(Math.random() * 90000) + 10000)}`,
            'Test Mah. No: 1', parentOrg, tier, JSON.stringify(moduller), bitis, aktif, kvkk ? new Date().toISOString() : null, olusturma]);
    if (deneme) {
        await query(`INSERT INTO deneme_kayitlari (id, tenant_id, telefon_norm, isletme_adi, kaynak, bitis) VALUES (?, ?, ?, ?, 'test', ?)`,
            [uuid(), id, '533' + String(Math.floor(Math.random() * 9000000) + 1000000), `${ON} ${ad}`, bitis]);
    }
    const uid = uuid();
    const eposta = `${EPOSTA_ON}sahip-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uid, id, eposta, await bcrypt.hash(SAHIP_SIFRE, 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    const sonuc = { id, slug, kod, eposta, uid };
    if (kasiyer) {
        const ke = `${EPOSTA_ON}kasa-${slug}@ornek.test`;
        await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uuid(), id, ke, await bcrypt.hash('kasa1234', 4), 'Kasiyer', 'CASHIER', new Date().toISOString()]);
        sonuc.kasiyerEposta = ke;
    }
    return sonuc;
}
async function giris(t, eposta, sifre) {
    const r = await js('/api/auth/login', { body: { email: eposta || t.eposta, businessCode: t.kod, password: sifre || SAHIP_SIFRE } });
    return r.d && r.d.token;
}
async function odemeEkle(tenantId, { tutar = 1000, durum = 'onaylandi', islenen = "datetime('now')", bildirildi = false } = {}) {
    const id = uuid();
    await query(
        `INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, tur, donem_bitis, islenen_at, onay_gun, odeme_bildirildi_at)
         VALUES (?, ?, 'TIER_6_10', '["BASE"]', ?, ?, 'ilk', ?, ${durum === 'onaylandi' ? islenen : 'NULL'}, 365, ?)`,
        [id, tenantId, tutar, durum, gun(365), bildirildi ? new Date().toISOString() : null]);
    return id;
}
async function plakaEkle(tenantId, { durum = 'ALINDI', tutar = 0, odemeAlindi = false, bildirildi = false } = {}) {
    const id = uuid();
    const no = 900000 + Math.floor(Math.random() * 99999);
    await query(
        `INSERT INTO plaka_talepleri (id, talep_no, tenant_id, durum, hediye_adet, ucretli_adet, tutar, masalar_json, odeme_alindi_at, odeme_bildirildi_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, '[]', ?, ?)`,
        [id, no, tenantId, durum, tutar > 0 ? 2 : 0, tutar, odemeAlindi ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
            bildirildi ? new Date().toISOString() : null]);
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

const duyuruIdleri = [];
const AYAR_ANAHTARLARI = ['bildirim_eposta', 'odeme_aciklama', 'deneme_gun', 'lisans_salt_okunur_gun', 'destek_oturumu_dk'];
let ayarYedek = null;
let katalogYedek = null;
let tohumYedek = null;
let digerAktifDuyurular = [];   // gelistirme veritabaninda yayinda olan baska duyurular: test boyunca pasif, sonra geri
async function temizle() {
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%' OR owner_email LIKE '${EPOSTA_ON}%'`);
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['payments', 'islem_gunlugu', 'orders', 'tables', 'products', 'categories', 'destek_oturumlari', 'yonetim_gunlugu',
            'isletme_notlari', 'lisans_odemeleri', 'plaka_talepleri', 'pos_provizyon', 'deneme_kayitlari', 'root_olaylar',
            'aktivasyon_jetonlari', 'license_cache', 'users']) {
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('temizle', tb, e.message));
        }
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM deneme_kayitlari WHERE isletme_adi LIKE '${ON}%'`).catch(() => {});
    await query(`DELETE FROM demo_talepleri WHERE isletme LIKE '${ON}%'`).catch(() => {});
    await query("DELETE FROM pos_provizyon WHERE odeme_id LIKE 'yntm-%'").catch(() => {});
    for (const id of duyuruIdleri) await query('DELETE FROM duyurular WHERE id = ?', [id]).catch(() => {});
    await query(`DELETE FROM duyurular WHERE baslik LIKE '${ON}%'`).catch(() => {});
    const rr = await query(`SELECT id FROM root_users WHERE email LIKE '${EPOSTA_ON}root-%'`);
    for (const r of rr.rows) {
        await query('DELETE FROM root_cihazlar WHERE root_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM yonetim_gunlugu WHERE root_id = ?', [r.id]).catch(() => {});
    }
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}root-%'`);
}
async function ayarlariYedekle() {
    const r = await query(`SELECT anahtar, deger FROM sistem_ayarlari WHERE anahtar IN (${AYAR_ANAHTARLARI.map(() => '?').join(', ')})`, AYAR_ANAHTARLARI);
    ayarYedek = Object.fromEntries(r.rows.map((x) => [x.anahtar, x.deger]));
    katalogYedek = (await query("SELECT * FROM lisans_katalog WHERE id = 'MODUL-STOK'")).rows[0];
    tohumYedek = (await query("SELECT aktif FROM duyurular WHERE id = 'tohum-plaka-kampanyasi'")).rows[0] || null;
    digerAktifDuyurular = (await query(`SELECT id FROM duyurular WHERE aktif = 1 AND baslik NOT LIKE '${ON}%'`)).rows.map((x) => x.id);
    for (const id of digerAktifDuyurular) await query('UPDATE duyurular SET aktif = 0 WHERE id = ?', [id]);
}
async function ayarlariGeriYukle() {
    if (!ayarYedek) return;
    for (const a of AYAR_ANAHTARLARI) {
        if (Object.prototype.hasOwnProperty.call(ayarYedek, a)) {
            await query('INSERT INTO sistem_ayarlari (anahtar, deger) VALUES (?, ?) ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger', [a, ayarYedek[a]]);
        } else await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [a]);
    }
    if (katalogYedek) await query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [katalogYedek.fiyat, katalogYedek.gorunur, katalogYedek.id]);
    if (tohumYedek) await query("UPDATE duyurular SET aktif = ? WHERE id = 'tohum-plaka-kampanyasi'", [tohumYedek.aktif]);
    for (const id of digerAktifDuyurular) await query('UPDATE duyurular SET aktif = 1 WHERE id = ?', [id]);
    digerAktifDuyurular = [];
}

(async () => {
    initDb(); await uyu(900); await temizle(); await ayarlariYedekle();
    // Varsayilan davranis testi icin: sayisal ayarlar bos baslar (yedekten geri yuklenir)
    await query("DELETE FROM sistem_ayarlari WHERE anahtar IN ('deneme_gun', 'lisans_salt_okunur_gun', 'destek_oturumu_dk')");
    const env = { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' };
    delete env.DENEME_GUN; delete env.LISANS_TOLERANS_GUN;
    // TEST_SUNUCU_LOG=<dosya>: sunucu ciktisi dosyaya (teshis icin)
    const logYolu = process.env.TEST_SUNUCU_LOG;
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, env,
        stdio: logYolu ? ['ignore', require('fs').openSync(logYolu, 'a'), require('fs').openSync(logYolu, 'a')] : 'ignore' });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);
    const rj = await rootJeton();

    console.log('=== 1) Genel bakis: yetki ===');
    ok('jetonsuz 401', (await js('/api/root/yonetim/genel-bakis')).status === 401);
    const g0 = await js('/api/root/yonetim/genel-bakis', { token: rj });
    ok('root 200 + bolumler', g0.status === 200 && g0.d.sayilar && g0.d.gelir && Array.isArray(g0.d.yaklasan) && g0.d.bekleyen && Array.isArray(g0.d.sonHareketler), g0.d);
    ok('magaza tablosu yokken magaza geliri gizli (null)', g0.d.gelir.magazaVar === false && g0.d.gelir.buAy.magaza === null);

    console.log('\n=== 2) Genel bakis sayilari (fark yontemi) ===');
    const T = {};
    T.deneme = await kiraciKur('Deneme', { tier: 'TIER_DENEME', bitis: gun(5), deneme: true, telefon: '0533 771 11 11' });
    T.odemeli = await kiraciKur('Odemeli', { tier: 'TIER_6_10', bitis: gun(200) });
    await odemeEkle(T.odemeli.id, { tutar: 1200 });
    T.salt = await kiraciKur('Salt', { tier: 'TIER_1_5', bitis: gun(-1) });
    await odemeEkle(T.salt.id, { tutar: 800, islenen: "datetime('now', '-400 days')" });
    T.kapali = await kiraciKur('Kapali', { aktif: 0 });
    T.kurum = await kiraciKur('Kurum', { tier: 'TIER_KURUM', bitis: '2099-12-31T23:59:59.000Z' });
    T.eski = await kiraciKur('Eski', { tier: 'TIER_DENEME', bitis: gun(-50), olusturma: sqlZaman(-60), deneme: true });
    T.site = await kiraciKur('Site', { tier: 'TIER_1_5', bitis: gun(7), kvkk: true });
    T.siteOdemeli = await kiraciKur('SiteOdemeli', { tier: 'TIER_1_5', bitis: gun(355), olusturma: sqlZaman(-10), kvkk: true });
    await odemeEkle(T.siteOdemeli.id, { tutar: 500, islenen: "datetime('now', '-400 days')" });
    T.elle = await kiraciKur('Elle', { tier: 'TIER_MUSTERI', bitis: gun(100), parentOrg: 'SofraMix' });
    // Gelir ve bekleyen isler
    await plakaEkle(T.odemeli.id, { durum: 'ODEME_ALINDI', tutar: 300, odemeAlindi: true });
    await plakaEkle(T.odemeli.id, { durum: 'REDDEDILDI', tutar: 999, odemeAlindi: true });
    await plakaEkle(T.odemeli.id, { durum: 'ALINDI' });
    await plakaEkle(T.site.id, { durum: 'ODEME_BEKLENIYOR', tutar: 150, bildirildi: true });
    await query(`INSERT INTO pos_provizyon (id, odeme_id, tenant_id, isletme_adi, tutar_kurus, onay_tarihi, durum)
                 VALUES (?, 'yntm-odeme-1', ?, ?, 150000, ?, 'islendi')`, [uuid(), T.elle.id, `${ON} Elle`, new Date().toISOString()]);
    await odemeEkle(T.deneme.id, { durum: 'beklemede', bildirildi: true, tutar: 2400 });

    const g1 = await js('/api/root/yonetim/genel-bakis', { token: rj });
    const f = (k) => g1.d.sayilar[k] - g0.d.sayilar[k];
    ok('toplam +9', f('toplam') === 9, f('toplam'));
    ok('aktif deneme +2 (TIER_DENEME + kayit formu)', f('aktifDeneme') === 2, f('aktifDeneme'));
    ok('odemeli musteri +3 (havale, kayit formu + odeme, elle/SofraMix)', f('odemeliMusteri') === 3, f('odemeliMusteri'));
    ok('salt-okunur +1', f('saltOkunur') === 1, f('saltOkunur'));
    ok('kapali +2 (isletme kapali + suresi cok gecmis)', f('kapali') === 2, f('kapali'));
    ok('kurum/diger +1', f('kurumDiger') === 1, f('kurumDiger'));
    ok('son 7 gun +7, son 30 gun +8', f('yeni7') === 7 && f('yeni30') === 8, [f('yeni7'), f('yeni30')]);
    ok('siniflar toplami toplami tutar', ['aktifDeneme', 'odemeliMusteri', 'saltOkunur', 'kapali', 'kurumDiger'].reduce((a, k) => a + g1.d.sayilar[k], 0) === g1.d.sayilar.toplam);
    const k0 = g0.d.sayilar.donusum90, k1 = g1.d.sayilar.donusum90;
    ok('donusum (90 gun): deneme kohortu +4, musteriye donen +1', k1.deneme - k0.deneme === 4 && k1.musteri - k0.musteri === 1, [k0, k1]);
    ok('donusum orani hesaplanir', typeof k1.oran === 'number' && k1.oran >= 0 && k1.oran <= 100, k1);
    const ga = (a, b) => Math.round((a - b) * 100) / 100;
    ok('bu ay gelir: lisans +1200 (yalniz bu ay onaylanan)', ga(g1.d.gelir.buAy.lisans.tutar, g0.d.gelir.buAy.lisans.tutar) === 1200, [g0.d.gelir.buAy, g1.d.gelir.buAy]);
    ok('bu ay gelir: ucretli plaka +300 (reddedilen sayilmaz)', ga(g1.d.gelir.buAy.plaka.tutar, g0.d.gelir.buAy.plaka.tutar) === 300);
    ok('bu ay gelir: SofraMix +1500', ga(g1.d.gelir.buAy.sofraMix.tutar, g0.d.gelir.buAy.sofraMix.tutar) === 1500);
    ok('toplam = kalemler toplami; yil >= ay', g1.d.gelir.buAy.toplam === Math.round((g1.d.gelir.buAy.lisans.tutar + g1.d.gelir.buAy.plaka.tutar + g1.d.gelir.buAy.sofraMix.tutar) * 100) / 100
        && g1.d.gelir.buYil.toplam >= g1.d.gelir.buAy.toplam, g1.d.gelir);
    const b = (k) => g1.d.bekleyen[k] - g0.d.bekleyen[k];
    ok('bekleyen: odeme bildirimi +1 (odemeyi yaptim +1)', b('odemeBildirimi') === 1 && b('odemeYapildiDenen') === 1);
    ok('bekleyen: plaka yeni +1, odeme bildirildi +1, hazirlanacak +1', b('plakaYeni') === 1 && b('plakaOdemeBildirildi') === 1 && b('plakaHazirlanacak') === 1,
        [b('plakaYeni'), b('plakaOdemeBildirildi'), b('plakaHazirlanacak')]);
    const yk = g1.d.yaklasan;
    const ykD = yk.find((x) => x.id === T.deneme.id);
    ok('yaklasan bitis: deneme (5 gun) telefon + kademe + moduller ile', ykD && ykD.kalanGun <= 5 && ykD.telefon === '0533 771 11 11' && ykD.tierAd === 'Deneme'
        && ykD.moduller.includes('Adisyon ve Kasa') && ykD.sinif === 'deneme', ykD);
    ok('yaklasan: salt-okunur olan da listede (once o)', yk.some((x) => x.id === T.salt.id && x.lisansDurum === 'SALT_OKUNUR')
        && yk.findIndex((x) => x.id === T.salt.id) < yk.findIndex((x) => x.id === T.deneme.id));
    ok('yaklasan: uzak bitis / kurum / kapali yok', !yk.some((x) => [T.odemeli.id, T.kurum.id, T.kapali.id, T.eski.id].includes(x.id)));
    ok('yaklasan: kayit formu denemesi (7 gun) de listede', yk.some((x) => x.id === T.site.id));

    const lt = (await js('/api/root/tenants', { token: rj })).d;
    const L = (t) => lt.find((x) => x.id === t.id);
    ok('isletme listesi ayni sinif: kayit formu denemesi = Deneme', L(T.site).deneme_mi === true && L(T.site).odeme_yapmis === false);
    ok('isletme listesi: havale musterisi = Musteri, 1 odeme', L(T.odemeli).odeme_yapmis === true && L(T.odemeli).odeme_adedi === 1 && L(T.odemeli).son_odeme_kurus === 120000, L(T.odemeli));
    ok('isletme listesi: elle uzatilmis (TIER_MUSTERI) = Musteri', L(T.elle).odeme_yapmis === true && L(T.elle).deneme_mi === false);
    ok('isletme listesi: kurum ne deneme ne musteri', L(T.kurum).deneme_mi === false && L(T.kurum).odeme_yapmis === false && L(T.kurum).sinif === 'kurum');

    console.log('\n=== 3) Isletme ayrintisi ===');
    ok('jetonsuz 401', (await js('/api/root/yonetim/isletme/' + T.odemeli.id)).status === 401);
    const sahipJ = await giris(T.odemeli);
    ok('isletme sahibi jetonuyla 403', (await js('/api/root/yonetim/isletme/' + T.odemeli.id, { token: sahipJ })).status === 403);
    ok('olmayan isletme 404', (await js('/api/root/yonetim/isletme/yok-boyle', { token: rj })).status === 404);
    await query('INSERT INTO tables (id, tenant_id, code, name, qr_token) VALUES (?, ?, ?, ?, ?)', [uuid(), T.odemeli.id, 'M1', 'Masa 1', crypto.randomBytes(12).toString('hex')]);
    await query('INSERT INTO tables (id, tenant_id, code, name, qr_token, is_active) VALUES (?, ?, ?, ?, ?, 0)', [uuid(), T.odemeli.id, 'M2', 'Masa 2', crypto.randomBytes(12).toString('hex')]);
    await query('INSERT INTO products (id, tenant_id, name, price) VALUES (?, ?, ?, ?)', [uuid(), T.odemeli.id, 'Çay', 20]);
    for (const [st, ac] of [['CLOSED', 0], ['CLOSED', -5], ['CANCELLED', 0], ['CLOSED', -40]]) {
        await query('INSERT INTO orders (id, tenant_id, status, total, opened_at) VALUES (?, ?, ?, 750, ?)', [uuid(), T.odemeli.id, st, sqlZaman(ac)]);
    }
    const ay = await js('/api/root/yonetim/isletme/' + T.odemeli.id, { token: rj });
    const d = ay.d;
    ok('ayrinti 200: kimlik (ad, kod, slug, e-posta, telefon, adres, kayit, kanal)', ay.status === 200 && d.kimlik.ad === `${ON} Odemeli` && d.kimlik.kod === T.odemeli.kod
        && d.kimlik.slug === T.odemeli.slug && !!d.kimlik.sahipEposta && !!d.kimlik.telefon && d.kimlik.adres === 'Test Mah. No: 1' && !!d.kimlik.kayit && d.kimlik.kanal === 'Yerel', d.kimlik);
    ok('ayrinti: lisans (kademe adi, modul adlari, bitis, kalan gun, durum, sinif)', d.lisans.tierAd === '6-10 Masa' && d.lisans.modulAdlari.includes('QR Menü')
        && d.lisans.kalanGun > 190 && d.lisans.durum === 'AKTIF' && d.lisans.sinif === 'odemeli' && d.lisans.indirimOrani === 0, d.lisans);
    ok('ayrinti: odeme gecmisi (tur, tutar, durum)', d.odemeler.length === 1 && d.odemeler[0].tutar === 1200 && d.odemeler[0].durum === 'Onaylandı' && d.odemeler[0].tur === 'İlk alım', d.odemeler);
    ok('ayrinti: plaka talepleri (3)', d.plakalar.length === 3 && d.plakalar.some((x) => x.durum_ad));
    ok('ayrinti: magaza uc/tablo yokken gizli (null)', d.magaza === null);
    ok('ayrinti: kullanim (aktif masa 1, kullanici 1, urun 1, son 30 gunde 2 siparis; iptal ve eski sayilmaz)',
        d.kullanim.aktifMasa === 1 && d.kullanim.kullaniciSayisi === 1 && d.kullanim.urunSayisi === 1 && d.kullanim.siparis30 === 2, d.kullanim);
    ok('ayrinti: son giris (girisle yazilir)', !!d.kullanim.sonGiris, d.kullanim.sonGiris);
    ok('ayrinti: CIRO YOK (kullanimda yalniz adet alanlari)', JSON.stringify(Object.keys(d.kullanim).sort()) === JSON.stringify(['aktifMasa', 'kategoriSayisi', 'kullaniciSayisi', 'siparis30', 'sonGiris', 'urunSayisi'])
        && !/"(ciro|total|toplamCiro|subtotal)"/.test(JSON.stringify(d.kullanim)), d.kullanim);
    ok('ayrinti: SofraMix kanali', (await js('/api/root/yonetim/isletme/' + T.elle.id, { token: rj })).d.kimlik.kanal === 'SofraMix');
    ok('bos not 400', (await js(`/api/root/yonetim/isletme/${T.odemeli.id}/notlar`, { token: rj, body: { metin: ' ' } })).status === 400);
    const n1 = await js(`/api/root/yonetim/isletme/${T.odemeli.id}/notlar`, { token: rj, body: { metin: 'Aradım, perşembe dönecek' } });
    ok('ic not eklenir (201)', n1.status === 201 && n1.d.metin === 'Aradım, perşembe dönecek', n1.d);
    const d2 = (await js('/api/root/yonetim/isletme/' + T.odemeli.id, { token: rj })).d;
    ok('ic not ayrintida (tarihli)', d2.notlar.length === 1 && !!d2.notlar[0].created_at && d2.notlar[0].metin === 'Aradım, perşembe dönecek');
    ok('isletme ic notu kendi ucunda goremez (isletme ucunda yok, root ucu 403)', (await js(`/api/root/yonetim/isletme/${T.odemeli.id}`, { token: sahipJ })).status === 403);
    ok('not silinir', (await js(`/api/root/yonetim/isletme/${T.odemeli.id}/notlar/${n1.d.id}`, { token: rj, method: 'DELETE' })).status === 200
        && (await js('/api/root/yonetim/isletme/' + T.odemeli.id, { token: rj })).d.notlar.length === 0);

    console.log('\n=== 4) Yonetim gunlugu: islemler ===');
    const G = async (tenantId, islem) => (await query('SELECT * FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = ? ORDER BY id', [tenantId, islem])).rows;
    ok('ic not ekle/sil gunlukte', (await G(T.odemeli.id, 'isletme_notu')).length === 2);
    await js(`/api/root/tenants/${T.odemeli.id}/lisans-uzat`, { token: rj, body: { gun: 30 } });
    const gl = await G(T.odemeli.id, 'lisans_uzat');
    ok('lisans uzatma: once -> sonra', gl.length === 1 && gl[0].ozet.includes('->') && gl[0].root_id === rootId && gl[0].isletme_adi === `${ON} Odemeli`, gl);
    await js(`/api/root/tenants/${T.odemeli.id}`, { token: rj, method: 'PATCH', body: { modules: ['BASE', 'MENU_DIGITAL', 'STOK'] } });
    const gm = await G(T.odemeli.id, 'modul_degisiklik');
    ok('modul degisikligi: eski ve yeni modul adlari', gm.length === 1 && /Modüller: Adisyon ve Kasa, QR Menü -> Adisyon ve Kasa, QR Menü, Stok/.test(gm[0].ozet), gm);
    await js(`/api/root/tenants/${T.odemeli.id}`, { token: rj, method: 'PATCH', body: { plakaHediyeHakki: 1 } });
    ok('hediye plaka hakki', (await G(T.odemeli.id, 'hediye_hakki')).some((x) => /otomatik -> ver/.test(x.ozet)));
    await js(`/api/root/tenants/${T.odemeli.id}`, { token: rj, method: 'PATCH', body: { isActive: false } });
    await js(`/api/root/tenants/${T.odemeli.id}`, { token: rj, method: 'PATCH', body: { isActive: true } });
    ok('kapat / ac ayri islemler', (await G(T.odemeli.id, 'isletme_kapat')).length === 1 && (await G(T.odemeli.id, 'isletme_ac')).length === 1);
    const ayniKayit = await js(`/api/root/tenants/${T.odemeli.id}`, { token: rj, method: 'PATCH', body: { businessName: `${ON} Odemeli` } });
    await uyu(300);
    ok('degisiklik olmayan kayit gunluge yazilmaz', ayniKayit.status === 200 && (await G(T.odemeli.id, 'isletme_duzenle')).length === 0 && (await G(T.odemeli.id, 'diger')).length === 0);
    ok('gecersiz indirim 400', (await js(`/api/root/yonetim/isletme/${T.odemeli.id}/indirim`, { token: rj, method: 'PUT', body: { oran: 150 } })).status === 400);
    const ind = await js(`/api/root/yonetim/isletme/${T.odemeli.id}/indirim`, { token: rj, method: 'PUT', body: { oran: 15 } });
    ok('indirim orani yazilir ve gunlukte (%0 -> %15)', ind.status === 200 && (await G(T.odemeli.id, 'indirim')).some((x) => /%0 -> %15/.test(x.ozet))
        && (await js('/api/root/yonetim/isletme/' + T.odemeli.id, { token: rj })).d.lisans.indirimOrani === 15);
    const bek = await odemeEkle(T.kurum.id, { durum: 'beklemede', tutar: 4000 });
    const onay = await js(`/api/root/lisans-odemeleri/${bek}/onayla`, { token: rj, body: {} });
    ok('odeme onayi gunlukte (tutar + yeni bitis)', onay.status === 200 && (await G(T.kurum.id, 'odeme_onay')).some((x) => /4\.000 TL/.test(x.ozet) && x.hedef_id === bek), onay.d);
    const bek2 = await odemeEkle(T.kurum.id, { durum: 'beklemede', tutar: 100 });
    await js(`/api/root/lisans-odemeleri/${bek2}/reddet`, { token: rj, body: { not: 'Dekont bulunamadı' } });
    ok('odeme reddi gunlukte (isletme odemeden bulunur)', (await G(T.kurum.id, 'odeme_red')).some((x) => /Dekont bulunamadı/.test(x.ozet)));
    await js('/api/root/katalog/MODUL-STOK', { token: rj, method: 'PATCH', body: { fiyat: Number(katalogYedek.fiyat) + 111 } });
    const gk = (await query("SELECT * FROM yonetim_gunlugu WHERE islem = 'katalog' AND root_id = ? ORDER BY id DESC LIMIT 1", [rootId])).rows[0];
    ok('katalog fiyat degisikligi gunlukte (once -> sonra)', gk && /Stok/.test(gk.ozet) && /fiyat/.test(gk.ozet) && gk.ozet.includes('->'), gk);
    const plk = await plakaEkle(T.kurum.id, { durum: 'ALINDI' });
    await js(`/api/root/plaka/talepler/${plk}/durum`, { token: rj, body: { islem: 'hazirlaniyor' } });
    ok('plaka durum degisikligi gunlukte', (await G(T.kurum.id, 'plaka_durum')).some((x) => /Hazırlanıyor/i.test(x.ozet)));
    const yeniSifre = 'YeniSahipSifresi-77';
    await js(`/api/root/tenants/${T.kurum.id}/owner-password`, { token: rj, body: { password: yeniSifre } });
    const gs = await G(T.kurum.id, 'sifre_ver');
    const tumu = JSON.stringify((await query('SELECT * FROM yonetim_gunlugu WHERE tenant_id = ?', [T.kurum.id])).rows);
    ok('sifre verme gunlukte, SIFRENIN KENDISI yok', gs.length === 1 && !tumu.includes(yeniSifre), gs);
    const ck = await js('/api/root/cihaz/kaydet', { token: rj, body: { ad: 'Test Telefonu' } });
    await uyu(400);
    const gc = (await query("SELECT * FROM yonetim_gunlugu WHERE islem = 'cihaz' AND root_id = ?", [rootId])).rows;
    ok('acik kaydi olmayan uc yedek ara katmanla gunlukte (cihaz), jeton YOK', ck.status === 201 && gc.length === 1 && /\/api\/root\/cihaz\/kaydet/.test(gc[0].ozet)
        && !JSON.stringify(gc).includes(ck.d.cihazJetonu) && !JSON.stringify(gc).includes(ck.d.bildirimJetonu), gc);
    ok('basarisiz istek gunluge yazilmaz', (await js(`/api/root/tenants/${T.kurum.id}/lisans-uzat`, { token: rj, body: { gun: 99999 } })).status === 400
        && (await G(T.kurum.id, 'lisans_uzat')).length === 0);

    console.log('\n=== 5) Sistem ayarlari: varsayilan davranis (ayar yokken birebir eski) ===');
    const a0 = await js('/api/root/yonetim/ayarlar', { token: rj });
    ok('varsayilanlar: deneme 7 gun, salt-okunur 3 gun, destek 120 dk (kayitli yok)', a0.status === 200 && a0.d.sayisal.deneme_gun.etkin === 7 && a0.d.sayisal.deneme_gun.kayitli === null
        && a0.d.sayisal.lisans_salt_okunur_gun.etkin === 3 && a0.d.sayisal.destek_oturumu_dk.etkin === 120, a0.d.sayisal);
    ok('banka bilgileri ve bildirim e-postasi ayni anahtarlar', ['iban', 'iban_sahibi', 'banka_adi', 'odeme_aciklama', 'bildirim_eposta'].every((k) => typeof a0.d[k] === 'string'));
    const dn = await js('/api/public/deneme', { body: { isletme: `${ON} Tanitim Bir`, adSoyad: 'Deneme Kişi', telefon: '0533 778 00 01', eposta: `${EPOSTA_ON}tanitim1@ornek.test` }, headers: { 'x-forwarded-for': '10.9.8.1' } });
    const dnGun = (new Date(dn.d.bitis) - Date.now()) / 86400000;
    ok('ayar yokken deneme 7 gun', dn.status === 201 && dn.d.gun === 7 && dnGun > 6.9 && dnGun <= 7.01, dn.d);
    const salt = await kiraciKur('SaltIki', { bitis: gun(-2) });
    const kapali = await kiraciKur('KapaliIki', { bitis: gun(-5) });
    const saltJ = await giris(salt), kapaliJ = await giris(kapali);
    ok('ayar yokken: 2 gun gecmis = salt-okunur (okuma 200, yazma LICENSE_READONLY)', (await js('/api/tables', { token: saltJ })).status === 200
        && (await js('/api/categories', { token: saltJ, body: { name: 'X' } })).d.code === 'LICENSE_READONLY');
    ok('ayar yokken: 5 gun gecmis = kapali (LICENSE_EXPIRED)', (await js('/api/tables', { token: kapaliJ })).d.code === 'LICENSE_EXPIRED');

    console.log('\n=== 6) Sistem ayarlari: dogrulama + degisiklik + gunluk ===');
    ok('deneme 0 gun 400', (await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { deneme_gun: 0 } })).status === 400);
    ok('deneme 91 gun 400', (await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { deneme_gun: 91 } })).status === 400);
    ok('salt-okunur 31 gun 400', (await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { lisans_salt_okunur_gun: 31 } })).status === 400);
    const hatali = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { deneme_gun: 10, iban: 'XX12' } });
    ok('hatali IBAN 400 ve hicbir ayar yazilmaz', hatali.status === 400 && (await js('/api/root/yonetim/ayarlar', { token: rj })).d.sayisal.deneme_gun.kayitli === null, hatali.d);
    ok('hatali e-posta 400', (await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { bildirim_eposta: 'gecersiz' } })).status === 400);
    const a1 = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { deneme_gun: '10', lisans_salt_okunur_gun: '1', bildirim_eposta: 'patron@ornek.test' } });
    ok('ayarlar yazilir', a1.status === 200 && a1.d.sayisal.deneme_gun.etkin === 10 && a1.d.sayisal.lisans_salt_okunur_gun.etkin === 1 && a1.d.bildirim_eposta === 'patron@ornek.test', a1.d);
    const gy = (await query("SELECT * FROM yonetim_gunlugu WHERE islem = 'sistem_ayari' AND root_id = ? ORDER BY id DESC LIMIT 1", [rootId])).rows[0];
    ok('ayar degisikligi gunlukte (once -> sonra)', gy && /Deneme süresi/.test(gy.ozet) && /-> 10/.test(gy.ozet) && /patron@ornek\.test/.test(gy.ozet), gy);
    const dn2 = await js('/api/public/deneme', { body: { isletme: `${ON} Tanitim Iki`, adSoyad: 'Deneme Kişi', telefon: '0533 778 00 02', eposta: `${EPOSTA_ON}tanitim2@ornek.test` }, headers: { 'x-forwarded-for': '10.9.8.2' } });
    const dn2Gun = (new Date(dn2.d.bitis) - Date.now()) / 86400000;
    ok('deneme ayari 10: yeni deneme 10 gun', dn2.status === 201 && dn2.d.gun === 10 && dn2Gun > 9.9 && dn2Gun <= 10.01, dn2.d);
    const kayit = (await query(`SELECT bitis FROM deneme_kayitlari WHERE isletme_adi = ?`, [`${ON} Tanitim Iki`])).rows[0];
    ok('deneme kaydi da 10 gun', kayit && (new Date(kayit.bitis) - Date.now()) / 86400000 > 9.9);
    ok('salt-okunur ayari 1: 2 gun gecmis artik kapali', (await js('/api/tables', { token: saltJ })).d.code === 'LICENSE_EXPIRED');
    await js('/api/root/ayarlar', { token: rj, method: 'PUT', body: { odeme_aciklama: 'Açıklamaya işyeri kodunu yazın (test)' } });
    const gEski = (await query("SELECT * FROM yonetim_gunlugu WHERE islem = 'sistem_ayari' AND root_id = ? ORDER BY id DESC LIMIT 1", [rootId])).rows[0];
    ok('eski Paketler sekmesindeki ayar kaydi da gunlukte', gEski && /Açıklama notu/.test(gEski.ozet), gEski);
    const a2 = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { deneme_gun: '', lisans_salt_okunur_gun: '' } });
    ok('bos birakilinca varsayilana doner', a2.d.sayisal.deneme_gun.etkin === 7 && a2.d.sayisal.lisans_salt_okunur_gun.etkin === 3);
    ok('varsayilana donunce 2 gun gecmis tekrar salt-okunur', (await js('/api/tables', { token: saltJ })).status === 200);

    console.log('\n=== 7) Duyurular: dogrulama ===');
    const D = (body) => js('/api/root/yonetim/duyurular', { token: rj, body });
    ok('isletme jetonuyla root duyuru ucu 403', (await js('/api/root/yonetim/duyurular', { token: sahipJ })).status === 403);
    ok('kisa baslik 400', (await D({ baslik: 'ab' })).status === 400);
    ok('javascript: baglanti 400', (await D({ baslik: `${ON} X`, baglanti: 'javascript:alert(1)' })).status === 400);
    ok('// ile baslayan baglanti 400', (await D({ baslik: `${ON} X`, baglanti: '//kotu.example.com' })).status === 400);
    ok('gecersiz hedef 400', (await D({ baslik: `${ON} X`, hedef: 'herkes-ve-kedisi' })).status === 400);
    ok('bitis baslangictan once 400', (await D({ baslik: `${ON} X`, baslangic: istanbulGunu(2), bitis: istanbulGunu(1) })).status === 400);
    ok('bozuk tarih 400', (await D({ baslik: `${ON} X`, baslangic: '2026-02-30' })).status === 400);

    console.log('\n=== 8) Duyurular: tohum taslak ===');
    const dl0 = await js('/api/root/yonetim/duyurular', { token: rj });
    const tohum = dl0.d.duyurular.find((x) => x.id === 'tohum-plaka-kampanyasi');
    const tohumSatir = (await query("SELECT aktif FROM sistem_ayarlari s, duyurular d WHERE s.anahtar = 'tohum_duyuru_plaka_v1' AND d.id = 'tohum-plaka-kampanyasi'")).rows;
    ok('tohum isareti yazildi (silinirse geri gelmez)', tohumSatir.length === 1);
    ok('ilk duyuru taslagi tohumlandi (metin + /plakalar; test sirasinda pasif)', tohum && tohum.aktif === false && tohum.hedef === 'tum' && tohum.baglanti === '/plakalar'
        && /Masa plakası kampanyası/.test(tohum.baslik) && /masa sayısı kadar karekodlu metal plaka hediye/.test(tohum.metin) && /Masa Plakaları sayfasına bakın/.test(tohum.metin), tohum);
    ok('hedefler ve kimler secenekleri', !!dl0.d.hedefler.adisyon && !!dl0.d.kimler.herkes);

    console.log('\n=== 9) Duyurular: hedefleme, tarihler, kimler ===');
    const H = {};
    H.denemeA = await kiraciKur('HedefDeneme', { tier: 'TIER_DENEME', bitis: gun(6), moduller: ['BASE', 'MENU_DIGITAL'] });
    H.odemeliA = await kiraciKur('HedefOdemeli', { tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL'], kasiyer: true });
    await odemeEkle(H.odemeliA.id, { tutar: 900 });
    H.menu = await kiraciKur('HedefMenu', { tier: 'TIER_KURUM', moduller: ['MENU_DIGITAL'], bitis: '2099-12-31T23:59:59.000Z' });
    const J = { deneme: await giris(H.denemeA), odemeli: await giris(H.odemeliA), menu: await giris(H.menu), kasa: await giris(H.odemeliA, H.odemeliA.kasiyerEposta, 'kasa1234') };
    const yeni = async (b) => { const r = await D({ aktif: true, ...b, baslik: `${ON} ${b.baslik}` }); if (r.d && r.d.id) duyuruIdleri.push(r.d.id); return r; };
    const dTum = await yeni({ baslik: 'Herkese', hedef: 'tum', baglanti: '/plakalar', baglantiMetni: 'Masa Plakaları' });
    ok('duyuru eklenir (201)', dTum.status === 201 && dTum.d.yayinda === true && dTum.d.durumAd === 'Yayında', dTum.d);
    await yeni({ baslik: 'Adisyonlular', hedef: 'adisyon' });
    await yeni({ baslik: 'Menuciler', hedef: 'menu' });
    await yeni({ baslik: 'Denemedekiler', hedef: 'deneme' });
    await yeni({ baslik: 'Odemeliler', hedef: 'odemeli', baglanti: 'https://www.mdayazilim.com' });
    const dPasif = await yeni({ baslik: 'Pasif', hedef: 'tum', aktif: false });
    const dYarin = await yeni({ baslik: 'Yarin', hedef: 'tum', baslangic: istanbulGunu(1) });
    await yeni({ baslik: 'Dun bitti', hedef: 'tum', bitis: istanbulGunu(-1) });
    await yeni({ baslik: 'Bugun son', hedef: 'tum', baslangic: istanbulGunu(-3), bitis: istanbulGunu(0) });
    await yeni({ baslik: 'Kasiyer de gorsun', hedef: 'tum', kimler: 'herkes' });
    ok('planlanan duyurunun durumu', dYarin.d.yayinda === false && dYarin.d.durumAd === 'Planlandı');
    const gor = async (tok) => ((await js('/api/duyurular', { token: tok })).d || []).filter((x) => x.baslik.startsWith(`${ON} `)).map((x) => x.baslik.replace(`${ON} `, ''));
    ok('isletme ucu oturumsuz 401', (await js('/api/duyurular')).status === 401);
    const gD = await gor(J.deneme), gO = await gor(J.odemeli), gM = await gor(J.menu), gK = await gor(J.kasa);
    const es = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    ok('deneme isletmesi: tum + adisyon + deneme + bugun son', es(gD, ['Herkese', 'Adisyonlular', 'Denemedekiler', 'Bugun son', 'Kasiyer de gorsun']), gD);
    ok('odemeli isletme: tum + adisyon + odemeli', es(gO, ['Herkese', 'Adisyonlular', 'Odemeliler', 'Bugun son', 'Kasiyer de gorsun']), gO);
    ok('yalniz QR menu isletmesi: tum + menu (adisyon yok)', es(gM, ['Herkese', 'Menuciler', 'Bugun son', 'Kasiyer de gorsun']), gM);
    ok('kasiyer yalniz "herkes" duyurusunu gorur', es(gK, ['Kasiyer de gorsun']), gK);
    const birD = (await js('/api/duyurular', { token: J.odemeli })).d.find((x) => x.baslik === `${ON} Odemeliler`);
    ok('isletme ucu yalniz gerekli alanlar (baslik, metin, baglanti, guncelleme)', birD && birD.baglanti === 'https://www.mdayazilim.com' && birD.hedef === undefined && !!birD.guncelleme, birD);
    const ak = await js('/api/root/yonetim/duyurular/' + dPasif.d.id, { token: rj, method: 'PATCH', body: { aktif: true } });
    ok('pasif duyuru yayina alinir', ak.status === 200 && ak.d.yayinda === true && (await gor(J.menu)).includes('Pasif'));
    const gdy = (await query("SELECT * FROM yonetim_gunlugu WHERE islem = 'duyuru' AND hedef_id = ? ORDER BY id", [dPasif.d.id])).rows;
    ok('duyuru ekle ve yayina al gunlukte', gdy.length === 2 && /yayına alındı/.test(gdy[1].ozet), gdy.map((x) => x.ozet));
    const sl = await js('/api/root/yonetim/duyurular/' + dPasif.d.id, { token: rj, method: 'DELETE' });
    ok('duyuru silinir ve gunlukte', sl.status === 200 && !(await gor(J.menu)).includes('Pasif')
        && (await query("SELECT COUNT(*) AS n FROM yonetim_gunlugu WHERE islem = 'duyuru' AND hedef_id = ? AND ozet LIKE 'Duyuru silindi%'", [dPasif.d.id])).rows[0].n === 1);
    ok('olmayan duyuru 404', (await js('/api/root/yonetim/duyurular/yok-boyle', { token: rj, method: 'PATCH', body: { aktif: true } })).status === 404);
    await js('/api/root/yonetim/duyurular/tohum-plaka-kampanyasi', { token: rj, method: 'PATCH', body: { aktif: true } });
    ok('tohum taslak yayina alininca isletmeler gorur', ((await js('/api/duyurular', { token: J.menu })).d || []).some((x) => x.id === 'tohum-plaka-kampanyasi' && x.baglanti === '/plakalar'));
    await js('/api/root/yonetim/duyurular/tohum-plaka-kampanyasi', { token: rj, method: 'PATCH', body: { aktif: !!(tohumYedek && tohumYedek.aktif) } });

    console.log('\n=== 10) Yonetim gunlugu: liste + filtreler ===');
    const ac = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: T.kurum.id, sebep: 'Gunluk testi' } });
    await js('/api/root/yonetim/destek/' + ac.d.id + '/kapat', { token: rj, method: 'POST' });
    ok('destek ac / kapat gunlukte', (await G(T.kurum.id, 'destek_ac')).length === 1 && (await G(T.kurum.id, 'destek_kapat')).length === 1);
    ok('isletme jetonuyla gunluk 403', (await js('/api/root/yonetim/gunluk', { token: sahipJ })).status === 403);
    const l1 = await js('/api/root/yonetim/gunluk?tenantId=' + T.kurum.id, { token: rj });
    ok('isletme filtresi: yalniz o isletme', l1.status === 200 && l1.d.kayitlar.length >= 6 && l1.d.kayitlar.every((x) => x.tenantId === T.kurum.id) && !!l1.d.islemler.lisans_uzat, l1.d.kayitlar.length);
    ok('kayit bicimi: islem adi, isletme adi, root e-postasi, ozet', l1.d.kayitlar.every((x) => x.islemAd && x.isletme === `${ON} Kurum` && /^yntm-root-/.test(x.root || '') && x.ozet), l1.d.kayitlar.slice(0, 2));
    const l2 = await js('/api/root/yonetim/gunluk?islem=lisans_uzat&tenantId=' + T.odemeli.id, { token: rj });
    ok('islem filtresi', l2.d.kayitlar.length === 1 && l2.d.kayitlar[0].islem === 'lisans_uzat');
    const l3 = await js('/api/root/yonetim/gunluk?islem=odeme_onay,odeme_red&tenantId=' + T.kurum.id, { token: rj });
    ok('coklu islem filtresi', l3.d.kayitlar.length === 2, l3.d.kayitlar.map((x) => x.islem));
    const bugun = istanbulGunu(0);
    const l4 = await js(`/api/root/yonetim/gunluk?baslangic=${bugun}&bitis=${bugun}&tenantId=${T.kurum.id}`, { token: rj });
    const l5 = await js(`/api/root/yonetim/gunluk?baslangic=${istanbulGunu(1)}&tenantId=${T.kurum.id}`, { token: rj });
    ok('tarih filtresi: bugun var, yarindan itibaren yok', l4.d.kayitlar.length === l1.d.kayitlar.length && l5.d.kayitlar.length === 0, [l4.d.kayitlar.length, l5.d.kayitlar.length]);
    const s1 = await js('/api/root/yonetim/gunluk?limit=2&tenantId=' + T.kurum.id, { token: rj });
    const s2 = await js(`/api/root/yonetim/gunluk?limit=2&tenantId=${T.kurum.id}&onceId=${s1.d.kayitlar[1].id}`, { token: rj });
    ok('sayfalama: dahaVar + onceId', s1.d.kayitlar.length === 2 && s1.d.dahaVar === true && s2.d.kayitlar.length === 2 && s2.d.kayitlar[0].id < s1.d.kayitlar[1].id);
    const g2 = await js('/api/root/yonetim/genel-bakis', { token: rj });
    ok('genel bakis son hareketler (en yeni 10, yonetim gunlugu dahil)', g2.d.sonHareketler.length === 10 && g2.d.sonHareketler.some((x) => x.kaynak === 'yonetim'), g2.d.sonHareketler.length);

    await ayarlariGeriYukle();
    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU:', e); try { await ayarlariGeriYukle(); } catch (_) {} process.exit(1); });
