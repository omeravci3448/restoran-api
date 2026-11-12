// Eski musteri hakki (karar 2026-11-12, canli kopya provasindan sonra): moduler lisansa gecis aninda deneme olmayan
// isletmenin gecis sonrasi listesi saklanir; eski haklari onayda odeme gecmisinden bagimsiz ve UCRETSIZ korunur.
// Kapsam: gecisin haklari ayni islemde yazmasi, ikinci calismanin zararsizligi, Teras benzeri (TIER_MUSTERI, aktif
// kanal, odeme gecmisi yok) yenileme, Avci benzeri (eski bekleyen odeme kaydi, FINANSAL_RAPORLAMA) onay, deneme ve
// kayit formu denemesinde koruma yok, gecisin ekledigi Garson'un hakki, bagimlilik kurali, Masadan Siparis satisa
// acilinca hak sahibinde ucretsiz / yeni musteride ucretli, root'un hakki kaldirmasi (yonetim gunlugu), gecisi onceden
// calismis ortamda bir kez doldurma. Sunucuyu KENDI baslatir.  Calistir: node test_eski_hak.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb, modulGecisi, GECIS_ISARETI } = require('./src/config/db');
const GH = require('./src/services/gecisHaklari');

const PORT = 46241, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'eski-hak-test-jwt';
const ON = 'EHK Test';
const EPOSTA_ON = 'ehk-';
const GUN = 86400000;
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 400) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const ayniKume = (a, b) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
const tarihGun = (gun) => new Date(Date.now() + gun * GUN).toISOString();
const sqlTarih = (gun) => new Date(Date.now() + gun * GUN).toISOString().replace('T', ' ').slice(0, 19);

async function kiraciKur({ ad, tier, moduller, bitisGun, kayitGun = -200, kvkk = false }) {
    const id = uuid();
    const slug = 'ehk-' + crypto.randomBytes(4).toString('hex');
    const kod = String(70000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, address, license_tier, license_modules,
                              license_end_date, is_active, created_at, kvkk_consent_at)
         VALUES (?, ?, ?, ?, ?, '05320000000', 'Test Mah. 1', ?, ?, ?, 1, ?, ?)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, tier, JSON.stringify(moduller), tarihGun(bitisGun),
            sqlTarih(kayitGun), kvkk ? new Date().toISOString() : null]);
    const eposta = `${EPOSTA_ON}sahip-${slug}@ornek.test`;
    await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), id, eposta, await bcrypt.hash('sahip1234', 4), 'Sahip', 'OWNER', new Date().toISOString()]);
    const g = await js('/api/auth/login', { body: { email: eposta, businessCode: kod, password: 'sahip1234' } });
    return { id, slug, kod, token: g.d && g.d.token, girisDurumu: g.status };
}
async function kanalKur(tenantId) {
    const k = 'ehk-kanal-' + crypto.randomBytes(4).toString('hex');
    await query("INSERT INTO marketplace_channels (id, tenant_id, name, is_active, adapter_code) VALUES (?, ?, 'SofraMix', 1, 'soframix')", [k, tenantId]);
    await query("INSERT INTO marketplace_store_links (id, tenant_id, channel_id, external_store_id, is_active) VALUES (?, ?, ?, ?, 1)", [k + '-l', tenantId, k, 'm-' + k]);
    await query("INSERT INTO marketplace_credentials (id, tenant_id, channel_id, cipher_blob, iv, auth_tag, status) VALUES (?, ?, ?, 'x', 'x', 'x', 'active')", [k + '-k', tenantId, k]);
}
const kiraci = async (id) => (await query('SELECT * FROM tenants WHERE id = ?', [id])).rows[0];
const modulleri = async (id) => JSON.parse((await kiraci(id)).license_modules || '[]');
const hakSatiri = async (id) => (await query('SELECT * FROM gecis_haklari WHERE tenant_id = ?', [id])).rows[0];
const hakListesi = async (id) => { const s = await hakSatiri(id); return s ? JSON.parse(s.hak) : null; };

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
        for (const tb of ['lisans_odemeleri', 'root_olaylar', 'license_cache', 'islem_gunlugu', 'marketplace_credentials', 'marketplace_store_links',
            'marketplace_channels', 'gecis_haklari', 'yonetim_gunlugu', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch(() => {});
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM yonetim_gunlugu WHERE root_id IN (SELECT id FROM root_users WHERE email LIKE '${EPOSTA_ON}%')`).catch(() => {});
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}%'`).catch(() => {});
    if (katalogYedek) for (const x of katalogYedek) await query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [x.fiyat, x.gorunur, x.id]);
    // Isaretler testten sonra yine yerinde (gecis ve haklar bir kez calismis ortam)
    await query("INSERT OR IGNORE INTO sistem_ayarlari (anahtar, deger) VALUES (?, datetime('now'))", [GECIS_ISARETI]);
    await query("INSERT OR IGNORE INTO sistem_ayarlari (anahtar, deger) VALUES (?, datetime('now'))", [GH.ISARET]);
}
const fiyatYaz = (id, fiyat, gorunur = 1) => query('UPDATE lisans_katalog SET fiyat = ?, gorunur = ? WHERE id = ?', [fiyat, gorunur, id]);

(async () => {
    initDb(); await uyu(1000);
    await temizle();
    katalogYedek = (await query('SELECT id, fiyat, gorunur FROM lisans_katalog')).rows;
    // Canli katalogun bicimi: Stok ve Pazaryeri gizli, Masadan Siparis gizli ve ucretsiz
    await fiyatYaz('TIER-TIER_1_5', 3000); await fiyatYaz('TIER-TIER_6_10', 4000); await fiyatYaz('MODUL-BASE', 0);
    await fiyatYaz('MODUL-MENU_DIGITAL', 1000); await fiyatYaz('MODUL-GARSON', 500);
    await fiyatYaz('MODUL-STOK', 800, 0); await fiyatYaz('MODUL-MARKETPLACE', 0, 0); await fiyatYaz('MODUL-QR_SIPARIS', 0, 0);

    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development', SMTP_HOST: '' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);
    const rj = await rootJeton();
    const onayla = (id) => js(`/api/root/lisans-odemeleri/${id}/onayla`, { token: rj, body: { gun: 365 } });
    const rootKaydi = async (id) => (await js('/api/root/lisans-odemeleri', { token: rj })).d.find((x) => x.id === id);

    console.log('=== 0) Sema ===');
    const kol = (await query('PRAGMA table_info(gecis_haklari)')).rows.map((x) => x.name);
    ok('gecis_haklari tablosu', ['tenant_id', 'moduller_once', 'moduller_sonra', 'hak', 'sinif', 'kademe', 'kaynak', 'kaldirildi_at', 'kaldiran'].every((k) => kol.includes(k)), kol);
    ok('acilista haklar isareti var (gecis onceden calismis ortamda bir kez dolduruldu)',
        (await query('SELECT 1 FROM sistem_ayarlari WHERE anahtar = ?', [GH.ISARET])).rows.length === 1);

    console.log('\n=== 1) Gecis: haklar ayni islemde yazilir ===');
    const T = await kiraciKur({ ad: 'Teras Benzeri', tier: 'TIER_MUSTERI', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK', 'MARKETPLACE'], bitisGun: 5, kayitGun: -35 });
    await kanalKur(T.id);
    const A = await kiraciKur({ ad: 'Avci Benzeri', tier: 'TIER_1_5', moduller: ['MENU_DIGITAL', 'GARSON', 'STOK', 'FINANSAL_RAPORLAMA'], bitisGun: -2, kayitGun: -155 });
    const aOdeme = 'ehk-eski-' + crypto.randomBytes(4).toString('hex');
    await query(`INSERT INTO lisans_odemeleri (id, tenant_id, tier, moduller, tutar, durum, created_at)
                 VALUES (?, ?, 'TIER_1_5', '["MENU_DIGITAL","GARSON","STOK","BASE"]', 9000, 'beklemede', datetime('now', '-16 days'))`, [aOdeme, A.id]);
    const D = await kiraciKur({ ad: 'Deneme', tier: 'TIER_DENEME', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK', 'MARKETPLACE'], bitisGun: 3, kayitGun: -4 });
    const KF = await kiraciKur({ ad: 'Kayit Formu', tier: 'TIER_1_5', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK'], bitisGun: 5, kayitGun: -2, kvkk: true });
    const Y = await kiraciKur({ ad: 'Garsonsuz', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL'], bitisGun: 10, kayitGun: -300 });
    const E = await kiraciKur({ ad: 'Bagimlilik', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'STOK'], bitisGun: 10, kayitGun: -300 });
    ok('kiracilar acildi (giris 200)', [T, A, D, KF, Y, E].every((x) => x.girisDurumu === 200 && x.token), [T, A, D, KF, Y, E].map((x) => x.girisDurumu));

    await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [GECIS_ISARETI]);
    ok('gecis calisti', (await modulGecisi()) === true);
    const sT = await hakSatiri(T.id);
    ok('Teras benzeri: gecis sonrasi liste saklandi (Masadan Siparis dahil)', sT && ayniKume(JSON.parse(sT.moduller_sonra), ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK', 'MARKETPLACE', 'QR_SIPARIS'])
        && sT.kaynak === 'gecis' && sT.sinif === 'odemeli' && sT.kademe === 'TIER_MUSTERI', sT);
    ok('Teras benzeri: eski hak = Stok, Pazaryeri, Masadan Siparis (Adisyon ve Kasa, QR Menu, Garson eskisi gibi ucretli)',
        ayniKume(JSON.parse(sT.hak), ['STOK', 'MARKETPLACE', 'QR_SIPARIS']), sT.hak);
    ok('gecis oncesi liste de saklandi', sT && ayniKume(JSON.parse(sT.moduller_once), ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK', 'MARKETPLACE']), sT && sT.moduller_once);
    ok('Avci benzeri: gecis BASE + Masadan Siparis ekledi; eski hak = Stok, Maliyet ve Kar Raporu, Masadan Siparis (BASE haric)',
        ayniKume(await modulleri(A.id), ['MENU_DIGITAL', 'GARSON', 'STOK', 'FINANSAL_RAPORLAMA', 'BASE', 'QR_SIPARIS'])
        && ayniKume(await hakListesi(A.id), ['STOK', 'FINANSAL_RAPORLAMA', 'QR_SIPARIS']), await hakListesi(A.id));
    ok('TIER_DENEME: satir var, sinif deneme, hak bos', (await hakSatiri(D.id)).sinif === 'deneme' && (await hakListesi(D.id)).length === 0);
    ok('kayit formu denemesi (kademe paketi, 7 gun): sinif deneme, hak bos', (await hakSatiri(KF.id)).sinif === 'deneme' && (await hakListesi(KF.id)).length === 0);
    ok('gecisin ekledigi Garson ve Masadan Siparis hak (Garson satista olsa da)', ayniKume(await hakListesi(Y.id), ['QR_SIPARIS', 'GARSON']), await hakListesi(Y.id));
    ok('ikinci calisma hicbir sey yapmaz', (await modulGecisi()) === false && ayniKume(JSON.parse((await hakSatiri(T.id)).hak), ['STOK', 'MARKETPLACE', 'QR_SIPARIS']));
    await uyu(1100);   // gecis isaretinden sonraki saniyede acilsin
    const N = await kiraciKur({ ad: 'Yeni Musteri', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL'], bitisGun: 10, kayitGun: 0 });
    ok('gecisten sonra acilan isletmeye hak satiri yok', !(await hakSatiri(N.id)));

    console.log('\n=== 2) Teras benzeri: ayni paketi yeniler (odeme gecmisi yok, aktif kanal) ===');
    const qT = (await js('/api/license/quote', { token: T.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } })).d;
    ok('ucret yalniz secilenler: 3000 + 1000 + 500 = 4500', qT.total === 4500 && qT.odenecek === 4500, qT);
    ok('Stok, Pazaryeri, Masadan Siparis korunur ve eski hak olarak isaretli', ayniKume(qT.korunanModuller, ['MARKETPLACE', 'STOK', 'QR_SIPARIS'])
        && ayniKume(qT.eskiHakModuller, ['MARKETPLACE', 'STOK', 'QR_SIPARIS']), [qT.korunanModuller, qT.eskiHakModuller]);
    ok('dokumde eski haklar 0 TL ve isaretli', ['STOK', 'MARKETPLACE', 'QR_SIPARIS'].every((m) => qT.breakdown.some((b) => b.name === m && b.price === 0 && b.eskiHak === true)), qT.breakdown);
    const qT2 = (await js('/api/license/quote', { token: T.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL', 'GARSON', 'QR_SIPARIS', 'STOK'] } })).d;
    ok('istekte gelen eski hak ucrete girmez (gizli olsa da 400 vermez)', qT2 && qT2.total === 4500 && ayniKume(qT2.eskiHakModuller, ['MARKETPLACE', 'STOK', 'QR_SIPARIS']), qT2);
    const alT = await js('/api/license/purchase', { token: T.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    ok('talep 201', alT.status === 201, alT);
    const rT = await rootKaydi(alT.d.id);
    ok('root onay penceresi: korunacak (eski hak) listesi, kalkacak yok', ayniKume(rT.eski_hak_moduller, ['MARKETPLACE', 'STOK', 'QR_SIPARIS']) && rT.kalkacak_moduller.length === 0, rT);
    ok('onay 200', (await onayla(alT.d.id)).status === 200);
    ok('onaydan sonra Masadan Siparis, Stok, Pazaryeri lisansta', ayniKume(await modulleri(T.id), ['BASE', 'MENU_DIGITAL', 'GARSON', 'MARKETPLACE', 'STOK', 'QR_SIPARIS']), await modulleri(T.id));
    const ygT = (await query("SELECT ozet FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'odeme_onay' ORDER BY id DESC LIMIT 1", [T.id])).rows[0];
    ok('yonetim gunlugu: onayda korunan eski haklar yazili', ygT && /eski hak korundu: .*Masadan Sipariş/.test(ygT.ozet), ygT);

    console.log('\n=== 3) Avci benzeri: eski bekleyen odeme kaydi onaylanir ===');
    const rA = await rootKaydi(aOdeme);
    ok('onay penceresi: Masadan Siparis ve Maliyet ve Kar Raporu eski hak olarak korunacak, kalkacak yok',
        ayniKume(rA.eski_hak_moduller, ['FINANSAL_RAPORLAMA', 'QR_SIPARIS']) && rA.kalkacak_moduller.length === 0 && rA.etkin_tur === 'ilk', rA);
    ok('onay 200', (await onayla(aOdeme)).status === 200);
    ok('onaydan sonra lisans: odenen + Masadan Siparis + Maliyet ve Kar Raporu (modul kaybi yok)',
        ayniKume(await modulleri(A.id), ['MENU_DIGITAL', 'GARSON', 'STOK', 'BASE', 'FINANSAL_RAPORLAMA', 'QR_SIPARIS']), await modulleri(A.id));

    console.log('\n=== 4) Deneme: koruma yok ===');
    const qD = (await js('/api/license/quote', { token: D.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } })).d;
    ok('TIER_DENEME: korunan yok, eski hak yok', qD.korunanModuller.length === 0 && qD.eskiHakModuller.length === 0, qD);
    const alD = await js('/api/license/purchase', { token: D.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } });
    await onayla(alD.d.id);
    ok('deneme onayinda gizli moduller kalkar (bugunku kural)', ayniKume(await modulleri(D.id), ['BASE', 'MENU_DIGITAL', 'GARSON']), await modulleri(D.id));
    const qK = (await js('/api/license/quote', { token: KF.token, body: { tier: 'TIER_1_5', modules: ['BASE', 'MENU_DIGITAL', 'GARSON'] } })).d;
    ok('kayit formu denemesi: korunan yok', qK.korunanModuller.length === 0 && qK.eskiHakModuller.length === 0, qK);

    console.log('\n=== 5) Bagimlilik kurali ===');
    const qE1 = (await js('/api/license/quote', { token: E.token, body: { tier: 'TIER_6_10', modules: ['MENU_DIGITAL'] } })).d;
    ok('Adisyon ve Kasa secilmezse Stok ve Masadan Siparis hakki korunmaz (Garson QR Menu ile korunur)', qE1 && !qE1.korunanModuller.includes('STOK')
        && !qE1.korunanModuller.includes('QR_SIPARIS') && ayniKume(qE1.eskiHakModuller, ['GARSON']), qE1);
    const qE2 = (await js('/api/license/quote', { token: E.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).d;
    ok('Adisyon ve Kasa varken Stok hakki korunur', qE2 && qE2.eskiHakModuller.includes('STOK'), qE2);

    console.log('\n=== 6) Masadan Siparis satisa acilir: hak sahibinde ucretsiz, yeni musteride ucretli ===');
    await fiyatYaz('MODUL-QR_SIPARIS', 600, 1);
    const qY = (await js('/api/license/quote', { token: Y.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).d;
    ok('hak sahibi: 4000 + 1000, Masadan Siparis ve Garson ucretsiz korunur', qY.total === 5000 && ayniKume(qY.eskiHakModuller, ['QR_SIPARIS', 'GARSON']), qY);
    const qY2 = (await js('/api/license/quote', { token: Y.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON'] } })).d;
    ok('hak sahibi Masadan Siparis ve Garson secse de ucret yok (5000)', qY2.total === 5000 && ayniKume(qY2.eskiHakModuller, ['QR_SIPARIS', 'GARSON']), qY2);
    const qN = (await js('/api/license/quote', { token: N.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL', 'QR_SIPARIS'] } })).d;
    ok('yeni musteri: Masadan Siparis ucretli (4000 + 1000 + 600)', qN.total === 5600 && qN.eskiHakModuller.length === 0, qN);
    await fiyatYaz('MODUL-QR_SIPARIS', 0, 0);

    console.log('\n=== 7) Root hakki kaldirir ===');
    const ay0 = (await js('/api/root/yonetim/isletme/' + Y.id, { token: rj })).d;
    ok('isletme ayrintisi: eski haklar gorunur', ay0.lisans.eskiHak && ayniKume(ay0.lisans.eskiHak.hak, ['QR_SIPARIS', 'GARSON'])
        && ay0.lisans.eskiHak.hakAdlari.includes('Masadan Sipariş') && !ay0.lisans.eskiHak.kaldirildi, ay0.lisans.eskiHak);
    const kal = await js(`/api/root/yonetim/isletme/${Y.id}/eski-haklar/kaldir`, { token: rj, body: {} });
    ok('kaldir 200', kal.status === 200, kal);
    ok('ikinci kaldirma 409', (await js(`/api/root/yonetim/isletme/${Y.id}/eski-haklar/kaldir`, { token: rj, body: {} })).status === 409);
    const ygY = (await query("SELECT islem, ozet FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'eski_hak_kaldir'", [Y.id])).rows;
    ok('yonetim gunlugunde tek satir', ygY.length === 1 && /eski müşteri hakları kaldırıldı/.test(ygY[0].ozet), ygY);
    const ay1 = (await js('/api/root/yonetim/isletme/' + Y.id, { token: rj })).d;
    ok('ayrintida kaldirildi tarihi ve kaldiran', !!ay1.lisans.eskiHak.kaldirildi && !!ay1.lisans.eskiHak.kaldiran, ay1.lisans.eskiHak);
    const qY3 = (await js('/api/license/quote', { token: Y.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } })).d;
    ok('kaldirildiktan sonra teklifte korunmaz', qY3.eskiHakModuller.length === 0 && !qY3.korunanModuller.includes('QR_SIPARIS'), qY3);
    const alY = await js('/api/license/purchase', { token: Y.token, body: { tier: 'TIER_6_10', modules: ['BASE', 'MENU_DIGITAL'] } });
    await onayla(alY.d.id);
    ok('sonraki onayda Masadan Siparis ve Garson kalkar', ayniKume(await modulleri(Y.id), ['BASE', 'MENU_DIGITAL']), await modulleri(Y.id));
    ok('olmayan isletme 404', (await js('/api/root/yonetim/isletme/yok-boyle/eski-haklar/kaldir', { token: rj, body: {} })).status === 404);
    ok('hak kaydi olmayan isletme 404', (await js(`/api/root/yonetim/isletme/${N.id}/eski-haklar/kaldir`, { token: rj, body: {} })).status === 404);

    console.log('\n=== 8) Gecis onceden calismis ortam: bir kez doldurma ===');
    const F = await kiraciKur({ ad: 'Eski Ortam', tier: 'TIER_6_10', moduller: ['BASE', 'MENU_DIGITAL', 'GARSON', 'STOK', 'QR_SIPARIS'], bitisGun: 40, kayitGun: -400 });
    await query("UPDATE tenants SET created_at = '2001-01-01 00:00:00' WHERE id = ?", [F.id]);
    await query('DELETE FROM sistem_ayarlari WHERE anahtar = ?', [GH.ISARET]);
    const n1 = await GH.doldur();
    const sF = await hakSatiri(F.id);
    ok('doldurma: gecisten once acilmis isletmeye satir (kaynak sonradan)', n1 >= 1 && sF && sF.kaynak === 'sonradan' && sF.moduller_once === null, [n1, sF]);
    ok('doldurma: satistaki ucretli moduller hak disi, gizliler hak', ayniKume(JSON.parse(sF.hak), ['STOK', 'QR_SIPARIS']), sF && sF.hak);
    ok('doldurma bir kez (isaretli; ikinci cagri 0)', (await GH.doldur()) === 0
        && (await query('SELECT 1 FROM sistem_ayarlari WHERE anahtar = ?', [GH.ISARET])).rows.length === 1);
    ok('gecisten sonra acilan isletme doldurmada da hak almaz', !(await hakSatiri(N.id)));
    ok('kaldirilmis hak doldurmada geri gelmez', !!(await hakSatiri(Y.id)).kaldirildi_at);

    console.log('\n=== 9) Saf hesap ===');
    const U = new Set(['MENU_DIGITAL', 'GARSON']);
    ok('hesapla: deneme -> bos', GH.hesapla({ once: ['STOK'], sonra: ['STOK'], deneme: true, ucretliGorunur: U }).length === 0);
    ok('hesapla: BASE ve ALL hak olmaz', ayniKume(GH.hesapla({ once: [], sonra: ['BASE', 'ALL', 'QR_SIPARIS'], deneme: false, ucretliGorunur: U }), ['QR_SIPARIS']));
    ok('hesapla: gecisin ekledigi ucretli modul hak olur', ayniKume(GH.hesapla({ once: ['MENU_DIGITAL'], sonra: ['MENU_DIGITAL', 'GARSON'], deneme: false, ucretliGorunur: U }), ['GARSON']));

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('COKTU', e); try { await temizle(); } catch (_) {} process.exit(1); });
