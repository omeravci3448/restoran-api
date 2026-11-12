// Destek oturumu: yalniz root acar; giris jetonu tek kullanimlik ve 60 sn; JWT (rol OWNER, ad "MDA Destek",
// destek claim'i, userId YOK); kapatilan / suresi dolan oturum 401; sifre / e-posta / personel / hesap kapatma 403;
// yonetici sifresi atlanir ve kayda gecer; her degisiklik isletmenin Islem Gunlugu'ne "MDA Destek"; isletme verisine
// erisim yalniz o isletme; serit uclari; root listesi; sure ayari; canli akis; IP sutunu yok.
// Sunucuyu KENDI baslatir.  Calistir: node test_destek.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { query, initDb } = require('./src/config/db');

const PORT = 46231, TABAN = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = 'destek-test-jwt';
const ON = 'DSTK Test';
const EPOSTA_ON = 'dstk-';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));
const ozet = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function js(yol, { token, body, method, headers } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}

const GELECEK = new Date(Date.now() + 200 * 86400000).toISOString();
async function kiraciKur(ad) {
    const id = uuid();
    const slug = 'dstk-' + crypto.randomBytes(4).toString('hex');
    const kod = String(70000 + Math.floor(Math.random() * 9999));
    await query(
        `INSERT INTO tenants (id, slug, business_code, business_name, owner_email, phone, license_tier, license_modules,
                              license_end_date, manager_pin, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 'TIER_20_PLUS', ?, ?, ?, 1)`,
        [id, slug, kod, `${ON} ${ad}`, `${EPOSTA_ON}${slug}@ornek.test`, '0532 222 33 44',
            JSON.stringify(['BASE', 'MENU_DIGITAL', 'QR_SIPARIS', 'GARSON']), GELECEK, await bcrypt.hash('yonetici9', 4)]);
    const kul = {};
    for (const [rol, sifre] of [['OWNER', 'sahip1234'], ['CASHIER', 'kasa1234']]) {
        const uid = uuid();
        const eposta = `${EPOSTA_ON}${rol.toLowerCase()}-${slug}@ornek.test`;
        await query('INSERT INTO users (id, tenant_id, email, password_hash, name, role, password_set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uid, id, eposta, await bcrypt.hash(sifre, 4), rol === 'OWNER' ? 'Sahip ' + ad : 'Kasiyer ' + ad, rol, new Date().toISOString()]);
        kul[rol] = { id: uid, eposta, sifre };
    }
    const masa = uuid();
    await query('INSERT INTO tables (id, tenant_id, code, name, section, qr_token) VALUES (?, ?, ?, ?, ?, ?)',
        [masa, id, 'M1', 'Masa 1', 'Salon', crypto.randomBytes(16).toString('hex')]);
    const kat = uuid();
    await query('INSERT INTO categories (id, tenant_id, name) VALUES (?, ?, ?)', [kat, id, 'Çorbalar ' + ad]);
    const urun = uuid();
    await query('INSERT INTO products (id, tenant_id, category_id, name, price, tracks_stock) VALUES (?, ?, ?, ?, ?, 0)',
        [urun, id, kat, 'Mercimek ' + ad, 90]);
    const jet = {};
    for (const rol of Object.keys(kul)) {
        jet[rol] = (await js('/api/auth/login', { body: { email: kul[rol].eposta, businessCode: kod, password: kul[rol].sifre } })).d.token;
    }
    return { id, slug, kod, kul, jet, masa, kat, urun };
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
    const t = await query(`SELECT id FROM tenants WHERE business_name LIKE '${ON}%'`);
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['payments', 'islem_gunlugu', 'orders', 'tables', 'products', 'categories', 'destek_oturumlari',
            'yonetim_gunlugu', 'push_abonelikleri', 'aktivasyon_jetonlari', 'users']) {
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('temizle', tb, e.message));
        }
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query(`DELETE FROM yonetim_gunlugu WHERE root_id IN (SELECT id FROM root_users WHERE email LIKE '${EPOSTA_ON}root-%')`).catch(() => {});
    await query(`DELETE FROM root_users WHERE email LIKE '${EPOSTA_ON}root-%'`);
    await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'destek_oturumu_dk'");
}

(async () => {
    initDb(); await uyu(900); await temizle();
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), JWT_SECRET, ROOT_EMAIL: '', ROOT_PASSWORD: '', NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(1200);

    console.log('=== Hazirlik: iki isletme (A, B), root ===');
    const A = await kiraciKur('Alfa');
    const B = await kiraciKur('Beta');
    const rj = await rootJeton();
    ok('isletme ve root jetonlari hazir', !!A.jet.OWNER && !!B.jet.OWNER && !!rj);

    console.log('\n=== 1) Yalniz root acar ===');
    ok('jetonsuz 401', (await js('/api/root/yonetim/destek', { body: { tenantId: A.id } })).status === 401);
    ok('isletme sahibinin jetonuyla 403', (await js('/api/root/yonetim/destek', { token: A.jet.OWNER, body: { tenantId: A.id } })).status === 403);
    ok('olmayan isletme 404', (await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: 'yok-boyle' } })).status === 404);
    ok('uzun sebep 400', (await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: A.id, sebep: 'x'.repeat(201) } })).status === 400);
    const ac1 = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: A.id, sebep: 'Menü fiyatları için arandı' } });
    ok('root acar: 201 + jeton + 60 sn + adres', ac1.status === 201 && typeof ac1.d.jeton === 'string' && ac1.d.jeton.length >= 40
        && ac1.d.gecerlilikSn === 60 && ac1.d.adres === '/destek-giris/' + ac1.d.jeton && ac1.d.sureDk === 120, ac1.d);
    const s1 = (await query('SELECT * FROM destek_oturumlari WHERE id = ?', [ac1.d.id])).rows[0];
    ok('veritabaninda ham jeton YOK, yalniz SHA-256 ozeti', s1 && s1.jeton_ozet === ozet(ac1.d.jeton) && !JSON.stringify(s1).includes(ac1.d.jeton), s1);
    const omur = (new Date(s1.jeton_son_at) - new Date(s1.created_at)) / 1000;
    ok('jeton omru 60 sn', omur >= 59 && omur <= 61, omur);
    ok('oturum henuz baslamadi (giris bekleniyor)', !s1.baslangic_at && !s1.bitis_at && s1.sebep === 'Menü fiyatları için arandı');
    const g1 = (await query("SELECT * FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'destek_ac'", [A.id])).rows;
    ok('yonetim gunlugune destek_ac (sebep ozetle)', g1.length === 1 && g1[0].ozet.includes('Menü fiyatları') && g1[0].root_id === rootId, g1);

    console.log('\n=== 2) Jeton tek kullanimlik ===');
    ok('rastgele jeton 404', (await js('/api/destek/giris/' + crypto.randomBytes(32).toString('base64url'), { method: 'POST' })).status === 404);
    ok('kisa jeton 404', (await js('/api/destek/giris/abc', { method: 'POST' })).status === 404);
    const gr = await js('/api/destek/giris/' + ac1.d.jeton, { method: 'POST' });
    ok('jeton JWT\'ye cevrilir (200)', gr.status === 200 && !!gr.d.token && gr.d.oturum.isletme === `${ON} Alfa`, gr.d);
    const kalanDk = (new Date(gr.d.oturum.bitis) - Date.now()) / 60000;
    ok('oturum suresi varsayilan 120 dk (jeton cevrildigi andan)', kalanDk > 118 && kalanDk <= 120.1, kalanDk);
    const tekrar = await js('/api/destek/giris/' + ac1.d.jeton, { method: 'POST' });
    ok('ayni jeton ikinci kez 410', tekrar.status === 410 && /zaten kullan/i.test(tekrar.d.message), tekrar.d);
    const DT = gr.d.token;
    const p = jwt.decode(DT);
    ok('JWT: destek claim + rol OWNER + ad "MDA Destek" + userId YOK', p.destek && p.destek.oturumId === ac1.d.id && p.role === 'OWNER'
        && p.name === 'MDA Destek' && p.userId === undefined && p.tenantId === A.id, p);
    ok('JWT omru oturumdan biraz uzun (anlamli 401 icin)', p.exp - p.iat >= 120 * 60 && p.exp - p.iat <= 126 * 60, p.exp - p.iat);

    console.log('\n=== 3) Jeton 60 sn: suresi dolan jeton ===');
    const ac2 = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: B.id } });
    await query('UPDATE destek_oturumlari SET jeton_son_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), ac2.d.id]);
    const gec = await js('/api/destek/giris/' + ac2.d.jeton, { method: 'POST' });
    ok('60 sn gecmis jeton 410 (sure mesaji)', gec.status === 410 && /60 saniye/.test(gec.d.message), gec.d);
    const s2 = (await query('SELECT * FROM destek_oturumlari WHERE id = ?', [ac2.d.id])).rows[0];
    ok('kullanilmayan jetonun oturumu kapanir (JETON_KULLANILMADI)', s2.bitis_at && s2.kapanis_nedeni === 'JETON_KULLANILMADI', s2);

    console.log('\n=== 4) Kimlik: /api/auth/me ===');
    const me = await js('/api/auth/me', { token: DT });
    ok('me 200: MDA Destek, OWNER, A isletmesi, destek bilgisi', me.status === 200 && me.d.name === 'MDA Destek' && me.d.role === 'OWNER'
        && me.d.tenantId === A.id && me.d.businessCode === A.kod && me.d.destek && me.d.destek.oturumId === ac1.d.id && me.d.id === null, me.d);
    ok('destekte "sifrenizi belirleyin" notu cikmaz (passwordSet true)', me.d.passwordSet === true);
    const meSahip = await js('/api/auth/me', { token: A.jet.OWNER });
    ok('sahibin oturumunda destek bilgisi YOK (isletme oturumu gormez)', meSahip.status === 200 && meSahip.d.destek === undefined && meSahip.d.name === 'Sahip Alfa', meSahip.d);
    ok('sahip jetonuyla destek serit ucu 403', (await js('/api/destek/oturum', { token: A.jet.OWNER })).status === 403);
    const ot = await js('/api/destek/oturum', { token: DT });
    ok('serit ucu: isletme adi + kalan sure', ot.status === 200 && ot.d.isletme === `${ON} Alfa` && ot.d.kalanSn > 7000 && ot.d.kalanSn <= 7200, ot.d);

    console.log('\n=== 5) Isletme verisine erisim yalniz o isletme ===');
    const masalar = await js('/api/tables', { token: DT });
    ok('masalar yalniz A', masalar.status === 200 && masalar.d.length === 1 && masalar.d[0].id === A.masa, masalar.d && masalar.d.map((x) => x.id));
    const urunler = await js('/api/products', { token: DT });
    ok('urunler yalniz A', urunler.status === 200 && urunler.d.every((x) => x.id !== B.urun) && urunler.d.some((x) => x.id === A.urun));
    ok('B urununu silemez (404)', (await js('/api/products/' + B.urun, { token: DT, method: 'DELETE' })).status === 404);
    ok('B urunu yerinde', (await query('SELECT 1 FROM products WHERE id = ?', [B.urun])).rows.length === 1);
    const sahte = jwt.sign({ destek: { oturumId: ac1.d.id }, tenantId: B.id, role: 'OWNER', name: 'MDA Destek' }, JWT_SECRET, { expiresIn: '1h' });
    const sahteR = await js('/api/tables', { token: sahte });
    ok('oturum A, jetonda B yazan sahte JWT 401', sahteR.status === 401 && sahteR.d.code === 'DESTEK_OTURUMU_BITTI', sahteR);
    ok('destek jetonu root ucuna giremez (403)', (await js('/api/root/tenants', { token: DT })).status === 403);

    console.log('\n=== 6) Yonetici sifresi atlanir (kayda gecer) ===');
    ok('kontrol: sahip sifresiz rapora giremez (403)', (await js('/api/reports/islem-gunlugu', { token: A.jet.OWNER })).status === 403);
    const rap = await js('/api/reports/islem-gunlugu', { token: DT });
    ok('destek: yonetici sifresi sorulmadan rapor (200)', rap.status === 200 && Array.isArray(rap.d), rap.status);
    await uyu(300);
    const s1b = (await query('SELECT pin_atlandi_at FROM destek_oturumlari WHERE id = ?', [ac1.d.id])).rows[0];
    ok('atlama oturuma yazildi', !!s1b.pin_atlandi_at);
    const gp = (await query("SELECT * FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'destek_pin'", [A.id])).rows;
    ok('atlama yonetim gunlugunde (bir kez)', gp.length === 1 && gp[0].hedef_id === ac1.d.id, gp);
    await js('/api/reports/islem-gunlugu', { token: DT });
    await uyu(200);
    ok('ikinci atlama ikinci satir yazmaz', (await query("SELECT COUNT(*) AS n FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'destek_pin'", [A.id])).rows[0].n === 1);
    const ayar = await js('/api/tenant/me', { token: DT, method: 'PUT', body: { phone: '0532 999 00 11' } });
    ok('destek isletme ayarini degistirebilir (yazma izinli, 200)', ayar.status === 200, ayar);

    console.log('\n=== 7) Yasaklar (403 DESTEK_YASAK) ===');
    const y = async (yol, method, body) => js(yol, { token: DT, method, body: body || {} });
    const y1 = await y('/api/auth/sifre-degistir', 'POST', { yeni: 'yenisifre123', mevcut: 'sahip1234' });
    ok('sifre degistirme 403', y1.status === 403 && y1.d.code === 'DESTEK_YASAK' && /işletme sahibi/.test(y1.d.message), y1.d);
    ok('sifre baglantisi 403', (await y('/api/auth/sifre-baglantisi', 'POST')).d.code === 'DESTEK_YASAK');
    const pers = await y('/api/auth/staff', 'POST', { email: 'yeni-personel@ornek.test', password: 'personel123', name: 'Yeni', role: 'CASHIER' });
    ok('personel ekleme 403', pers.status === 403 && pers.d.code === 'DESTEK_YASAK', pers.d);
    ok('personel eklenmedi', (await query("SELECT COUNT(*) AS n FROM users WHERE email = 'yeni-personel@ornek.test'")).rows[0].n === 0);
    ok('personel sifresi degistirme 403', (await y('/api/auth/staff/' + A.kul.CASHIER.id, 'PATCH', { password: 'baskasifre1' })).status === 403);
    ok('personel pasife alma (silme) 403', (await y('/api/auth/staff/' + A.kul.CASHIER.id, 'PATCH', { isActive: false })).status === 403);
    const kas = (await query('SELECT is_active FROM users WHERE id = ?', [A.kul.CASHIER.id])).rows[0];
    ok('kasiyer aktif kaldi', Number(kas.is_active) === 1);
    ok('yonetici sifresi belirleme 403', (await y('/api/auth/manager-set', 'POST', { pin: '111111' })).status === 403);
    ok('hesap kapatma talebi 403', (await y('/api/tenant/close', 'POST', { confirmText: 'KAPAT' })).status === 403);
    ok('isletme acik kaldi', Number((await query('SELECT is_active FROM tenants WHERE id = ?', [A.id])).rows[0].is_active) === 1);
    ok('telefon bildirimi aboneligi 403', (await y('/api/push/abone', 'POST', { endpoint: 'https://x' })).status === 403);
    const kasiyerGiris = await js('/api/auth/login', { body: { email: A.kul.CASHIER.eposta, businessCode: A.kod, password: 'kasa1234' } });
    ok('kasiyer eski sifresiyle girebiliyor (degismedi)', kasiyerGiris.status === 200);
    const sl = await js('/api/auth/staff', { token: DT });
    ok('personel listesi okunur (200)', sl.status === 200 && sl.d.length === 2, sl.status);

    console.log('\n=== 8) Islem Gunlugu: kullanici "MDA Destek" ===');
    const kat = await js('/api/categories', { token: DT, body: { name: 'Destek Kategorisi' } });
    ok('destek kategori ekler', kat.status === 201 || kat.status === 200, kat);
    await uyu(400);
    const ig1 = (await query("SELECT * FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'destek_degisiklik' ORDER BY created_at", [A.id])).rows;
    ok('genel degisiklik kaydi: MDA Destek + konu', ig1.some((x) => x.user_name === 'MDA Destek' && x.user_id === null && /Kategori/.test(x.detay) && /POST \/api\/categories/.test(x.detay)), ig1);
    ok('ayar degisikligi de kayitli', ig1.some((x) => /İşletme ayarları/.test(x.detay)), ig1.map((x) => x.detay));
    const sip = await js('/api/orders', { token: DT, body: { tableId: A.masa } });
    await js('/api/orders/' + sip.d.id + '/items', { token: DT, body: { productId: A.urun, qty: 2 } });
    const ipt = await js('/api/orders/' + sip.d.id + '/cancel', { token: DT, method: 'POST' });
    ok('destek siparis acar ve iptal eder', sip.status === 201 && ipt.status === 200, [sip.status, ipt.status]);
    await uyu(400);
    const ig2 = (await query("SELECT * FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'siparis_iptal'", [A.id])).rows;
    ok('ozel kayit (siparis iptali) kullanici MDA Destek', ig2.length === 1 && ig2[0].user_name === 'MDA Destek' && ig2[0].user_id === null, ig2);
    const cift = (await query("SELECT COUNT(*) AS n FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'destek_degisiklik' AND detay LIKE '%/cancel%'", [A.id])).rows[0].n;
    ok('ozel kayit yazilan istek icin ikinci (genel) satir yok', cift === 0, cift);
    const o1 = (await query('SELECT opened_by, cancelled_by FROM orders WHERE id = ?', [sip.d.id])).rows[0];
    ok('siparis isletme kullanicisina yazilmadi (opened_by bos)', o1.opened_by === null && o1.cancelled_by === null, o1);
    const sayac = (await query('SELECT islem_sayisi FROM destek_oturumlari WHERE id = ?', [ac1.d.id])).rows[0].islem_sayisi;
    ok('oturumun islem sayaci ilerledi', sayac >= 4, sayac);
    const sahipGunluk = await js('/api/reports/islem-gunlugu', { token: A.jet.OWNER, headers: { 'x-manager-pin': 'yonetici9' } });
    ok('isletme sahibi kendi Islem Gunlugu\'nde "MDA Destek" satirlarini gorur', sahipGunluk.status === 200 && sahipGunluk.d.some((x) => x.user_name === 'MDA Destek'), sahipGunluk.status);
    const yasakSonrasi = (await query("SELECT COUNT(*) AS n FROM islem_gunlugu WHERE tenant_id = ? AND detay LIKE '%/api/auth/%'", [A.id])).rows[0].n;
    ok('reddedilen (403) istekler gunluge yazilmaz', yasakSonrasi === 0, yasakSonrasi);

    console.log('\n=== 9) Canli akis (SSE) ===');
    const ac9 = new AbortController();
    const sse = await fetch(TABAN + '/api/realtime/stream?token=' + encodeURIComponent(DT), { signal: ac9.signal }).catch((e) => ({ status: 0, e }));
    ok('destek oturumu canli akisa baglanir (200)', sse.status === 200, sse.status);
    ac9.abort();

    console.log('\n=== 10) Root listesi + root kapatir -> 401 ===');
    const ls = await js('/api/root/yonetim/destek', { token: rj });
    const bizim = ls.d.filter((x) => x.tenantId === A.id || x.tenantId === B.id);
    ok('liste: acik oturum en ustte, kapali olan sonra', ls.status === 200 && bizim[0].id === ac1.d.id && bizim[0].durum === 'ACIK'
        && bizim.some((x) => x.id === ac2.d.id && x.durum === 'KAPALI' && x.kapanisNedeni === 'JETON_KULLANILMADI'), bizim);
    ok('liste: islem sayisi + yonetici sifresi atlama bilgisi', bizim[0].islemSayisi >= 4 && !!bizim[0].pinAtlandi);
    ok('acik filtresi', (await js('/api/root/yonetim/destek?durum=acik', { token: rj })).d.every((x) => x.durum !== 'KAPALI'));
    const kp = await js('/api/root/yonetim/destek/' + ac1.d.id + '/kapat', { token: rj, method: 'POST' });
    ok('root kapatir (200)', kp.status === 200 && kp.d.oturum.kapanisNedeni === 'ROOT_KAPATTI', kp.d);
    const sonra = await js('/api/auth/me', { token: DT });
    ok('kapatilan oturumla istek 401 DESTEK_OTURUMU_BITTI', sonra.status === 401 && sonra.d.code === 'DESTEK_OTURUMU_BITTI', sonra);
    ok('kapatilan oturumla yazma da 401', (await js('/api/categories', { token: DT, body: { name: 'Olmamali' } })).status === 401);
    ok('ikinci kapatma 409', (await js('/api/root/yonetim/destek/' + ac1.d.id + '/kapat', { token: rj, method: 'POST' })).status === 409);
    const gk = (await query("SELECT * FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'destek_kapat'", [A.id])).rows;
    ok('kapatma yonetim gunlugunde', gk.length === 1 && /yönetim panelinden/.test(gk[0].ozet), gk);
    const ac9b = new AbortController();
    const sse2 = await fetch(TABAN + '/api/realtime/stream?token=' + encodeURIComponent(DT), { signal: ac9b.signal }).catch(() => ({ status: 0 }));
    ok('kapali oturum canli akisa baglanamaz (401)', sse2.status === 401, sse2.status);
    ac9b.abort();

    console.log('\n=== 11) Suresi dolan oturum 401 (SURE_DOLDU) ===');
    const ac3 = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: A.id } });
    const DT3 = (await js('/api/destek/giris/' + ac3.d.jeton, { method: 'POST' })).d.token;
    ok('yeni oturum calisiyor', (await js('/api/tables', { token: DT3 })).status === 200);
    await query('UPDATE destek_oturumlari SET planlanan_bitis_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), ac3.d.id]);
    const dol = await js('/api/tables', { token: DT3 });
    ok('suresi dolan oturum 401 DESTEK_OTURUMU_BITTI', dol.status === 401 && dol.d.code === 'DESTEK_OTURUMU_BITTI', dol);
    const s3 = (await query('SELECT bitis_at, kapanis_nedeni FROM destek_oturumlari WHERE id = ?', [ac3.d.id])).rows[0];
    ok('oturum SURE_DOLDU ile kapandi', s3.bitis_at && s3.kapanis_nedeni === 'SURE_DOLDU', s3);

    console.log('\n=== 12) Seritten kapat + ayni isletmede yeni oturum eskisini kapatir ===');
    const ac4 = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: A.id } });
    const DT4 = (await js('/api/destek/giris/' + ac4.d.jeton, { method: 'POST' })).d.token;
    const ac5 = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: A.id } });
    ok('yeni oturum acilinca eski acik oturum kapanir', ac5.d.kapatilanEski === 1
        && (await query('SELECT kapanis_nedeni FROM destek_oturumlari WHERE id = ?', [ac4.d.id])).rows[0].kapanis_nedeni === 'YENI_OTURUM');
    ok('eski oturumun jetonu artik 401', (await js('/api/tables', { token: DT4 })).status === 401);
    const DT5 = (await js('/api/destek/giris/' + ac5.d.jeton, { method: 'POST' })).d.token;
    const sk = await js('/api/destek/kapat', { token: DT5, method: 'POST' });
    ok('seritten kapat (200)', sk.status === 200 && sk.d.ok === true && sk.d.zatenKapali === false, sk.d);
    ok('kapandiktan sonra 401', (await js('/api/tables', { token: DT5 })).status === 401);
    ok('kapanis nedeni DESTEK_KAPATTI', (await query('SELECT kapanis_nedeni FROM destek_oturumlari WHERE id = ?', [ac5.d.id])).rows[0].kapanis_nedeni === 'DESTEK_KAPATTI');
    ok('ikinci kez kapat: zaten kapali', (await js('/api/destek/kapat', { token: DT5, method: 'POST' })).d.zatenKapali === true);
    const gk2 = (await query("SELECT * FROM yonetim_gunlugu WHERE tenant_id = ? AND islem = 'destek_kapat' AND hedef_id = ?", [A.id, ac5.d.id])).rows;
    ok('seritten kapatma yonetim gunlugunde (oturumu acan root ile)', gk2.length === 1 && gk2[0].root_id === rootId && /şeridinden/.test(gk2[0].ozet), gk2);

    console.log('\n=== 13) Sure ayari (destek_oturumu_dk) ===');
    const ay = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { destek_oturumu_dk: '30' } });
    ok('ayar 30 dk', ay.status === 200 && ay.d.sayisal.destek_oturumu_dk.etkin === 30, ay.d && ay.d.sayisal);
    ok('gecersiz sure 400', (await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { destek_oturumu_dk: '2' } })).status === 400);
    const ac6 = await js('/api/root/yonetim/destek', { token: rj, body: { tenantId: B.id } });
    const gr6 = await js('/api/destek/giris/' + ac6.d.jeton, { method: 'POST' });
    const dk6 = (new Date(gr6.d.oturum.bitis) - Date.now()) / 60000;
    ok('yeni oturum 30 dk', ac6.d.sureDk === 30 && dk6 > 29 && dk6 <= 30.1, dk6);
    await js('/api/destek/kapat', { token: gr6.d.token, method: 'POST' });
    const ay2 = await js('/api/root/yonetim/ayarlar', { token: rj, method: 'PUT', body: { destek_oturumu_dk: '' } });
    ok('bos birakilinca varsayilana doner (120)', ay2.d.sayisal.destek_oturumu_dk.etkin === 120 && ay2.d.sayisal.destek_oturumu_dk.kayitli === null, ay2.d.sayisal);

    console.log('\n=== 14) IP kaydedilmez ===');
    const kol = (await query('PRAGMA table_info(destek_oturumlari)')).rows.map((x) => x.name);
    const kol2 = (await query('PRAGMA table_info(yonetim_gunlugu)')).rows.map((x) => x.name);
    ok('destek_oturumlari ve yonetim_gunlugu tablolarinda IP sutunu yok', kol.length > 5 && ![...kol, ...kol2].some((k) => /(^|_)ip(_|$)|ip_?adres/i.test(k)), [kol, kol2]);

    await temizle();
    console.log(`\n=== SONUC: ${pass} gecti, ${fail} kaldi (temizlendi) ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('COKTU:', e); process.exit(1); });
