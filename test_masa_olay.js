// Masa duzenle/sil kurallari (toplu ekleme numarasi, kod cakismasi, acik hesap/onay bekleyen engeli,
// silinmis masanin QR'i, rol) + Patron olaylari (yeni restoran kaydi, SofraMix paket alimi, telefon ozeti).
// Sunucuyu KENDI baslatir.  Calistir: node test_masa_olay.js
process.env.MARKETPLACE_KEK = process.env.MARKETPLACE_KEK || require('crypto').randomBytes(32).toString('base64');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { query, initDb } = require('./src/config/db');
const totp = require('./src/services/totp');
// Izleyici EN BASTA yuklenir: ilk calismada baslangic noktasini modulun yuklendigi an yapar;
// isletme acildiktan sonra yuklenseydi o isletme "eski" sayilirdi (canlida modul sunucu acilirken yuklenir).
const I = require('./src/services/yeniKayitIzleyici');

const PORT = 45973, TABAN = `http://127.0.0.1:${PORT}`, PANEL = 'http://panel.test';
const GIZLI = 'test-gizli-anahtar-masa-olay-1234';
const ISLETME = 'Masa Olay Test Lokanta', SMX_NO = 779173;
const ROOT_EPOSTA = 'masaolay-root@mdayazilim.com', ROOT_PAROLA = 'MasaOlayParola123';
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log('  OK  ' + n))
    : (fail++, console.log('  FAIL ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e).slice(0, 300) : ''))); };
const uyu = (ms) => new Promise(r => setTimeout(r, ms));

function govde(x = {}) {
    return {
        kaynak: 'soframix', surum: 1, isletme_no: SMX_NO, isletme_slug: 'masa-olay-test', isletme_adi: ISLETME,
        il: 'Afyonkarahisar', ilce: 'Merkez', adres: '', unvan: '', vergi_dairesi: '', vergi_no: '',
        yetkili_ad: 'Olay Sahibi', yetkili_email: 'masa-olay-sahibi@ornek.test', yetkili_tel: '05321112273',
        deneme_gun: 7, damga_ms: Date.now(), gecerli_sn: 600, nonce: crypto.randomBytes(12).toString('hex'), ...x,
    };
}
const kanonik = (g) => JSON.stringify(g, Object.keys(g).sort());
function baglanti(g) {
    const u = new URL(TABAN + '/api/public/soframix-deneme');
    u.searchParams.set('v', '1');
    u.searchParams.set('yuk', Buffer.from(kanonik(g), 'utf8').toString('base64url'));
    u.searchParams.set('imza', crypto.createHmac('sha256', GIZLI).update(kanonik(g)).digest('hex'));
    return u.toString();
}
async function js(yol, { token, body, method } = {}) {
    const r = await fetch(TABAN + yol, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    let d = null; try { d = await r.json(); } catch (_) { d = null; }
    return { status: r.status, d };
}
async function temizle() {
    const t = await query('SELECT id FROM tenants WHERE business_name = ?', [ISLETME]);
    for (const r of t.rows) {
        await query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ?)', [r.id]).catch(() => {});
        for (const tb of ['payments', 'stock_movements', 'orders', 'waiter_calls', 'qr_bekleyen_siparisler', 'tables', 'products', 'categories',
                          'marketplace_credentials', 'marketplace_store_links', 'marketplace_channels', 'license_cache', 'islem_gunlugu',
                          'aktivasyon_jetonlari', 'deneme_kayitlari', 'deneme_giris_jetonlari', 'pos_provizyon', 'root_olaylar', 'users'])
            await query('DELETE FROM ' + tb + ' WHERE tenant_id = ?', [r.id]).catch((e) => console.log('  temizlik', tb, e.message));
        await query('DELETE FROM tenants WHERE id = ?', [r.id]);
    }
    await query("DELETE FROM pos_provizyon WHERE odeme_id LIKE 'masa-olay-test-%'").catch(() => {});
    await query("DELETE FROM root_olaylar WHERE ref LIKE 'masa-olay-test-%'").catch(() => {});
    await query('DELETE FROM deneme_kayitlari WHERE soframix_business_id = ?', [String(SMX_NO)]).catch(() => {});
    await query('DELETE FROM deneme_devir_nonce WHERE isletme_no = ?', [String(SMX_NO)]).catch(() => {});
    const ru = await query('SELECT id FROM root_users WHERE email = ?', [ROOT_EPOSTA]);
    for (const u of ru.rows) await query('DELETE FROM root_cihazlar WHERE root_id = ?', [u.id]).catch(() => {});
    await query('DELETE FROM root_users WHERE email = ?', [ROOT_EPOSTA]).catch(() => {});
}

(async () => {
    initDb(); await uyu(900); await temizle();
    // Yayin gununu canlandir: baslangic noktasi YOK -> ilk tarama eski kiracilar icin olay/posta uretmemeli
    await query("DELETE FROM sistem_ayarlari WHERE anahtar = 'olay_izleme_baslangic'");
    const oncekiOlay = Number((await query('SELECT COUNT(*) AS c FROM root_olaylar')).rows[0].c);
    await I.tara();
    const bas = (await query("SELECT deger FROM sistem_ayarlari WHERE anahtar = 'olay_izleme_baslangic'")).rows[0];
    ok('ilk calismada baslangic noktasi yazildi', !!(bas && bas.deger), bas);
    ok('ilk tarama eski kiracilar icin olay uretmedi', Number((await query('SELECT COUNT(*) AS c FROM root_olaylar')).rows[0].c) === oncekiOlay);
    const sunucu = spawn(process.execPath, ['server.js'], { cwd: __dirname, stdio: 'ignore',
        env: { ...process.env, PORT: String(PORT), SOFRAMIX_DENEME_GIZLI: GIZLI, POS_PANEL_URL: PANEL,
               JWT_SECRET: 'masa-olay-test-jwt', ROOT_EMAIL: ROOT_EPOSTA, ROOT_PASSWORD: ROOT_PAROLA, NODE_ENV: 'development' } });
    process.on('exit', () => { try { sunucu.kill(); } catch (_) {} });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(TABAN + '/health')).ok) break; } catch (_) {} await uyu(400); }
    await uyu(6500); // ensureRootUser 5 sn sonra

    console.log('=== Hazirlik: SofraMix denemesiyle isletme + kasiyer ===');
    const r0 = await fetch(baglanti(govde()), { redirect: 'manual' });
    const jeton = (r0.headers.get('location') || '').split('/deneme-giris/')[1];
    const sahip = (await js('/api/public/deneme-giris/' + jeton, { method: 'POST' })).d;
    const me = (await js('/api/auth/me', { token: sahip.token })).d;
    const tid = me.tenantId;
    ok('deneme isletmesi acildi', !!tid, me);
    await js('/api/auth/staff', { token: sahip.token, body: { email: 'masa-olay-kasiyer@ornek.test', password: 'kasiyer123', name: 'Kasiyer', role: 'CASHIER' } });
    const kasiyer = (await js('/api/auth/login', { body: { email: 'masa-olay-kasiyer@ornek.test', businessCode: me.businessCode, password: 'kasiyer123' } })).d;
    const T = sahip.token;
    const liste = async () => (await js('/api/tables', { token: T })).d || [];
    const bul = async (kod) => (await liste()).find(x => x.code === kod);

    console.log('\n=== 1) Toplu ekleme numarayi kaldigi yerden surdurur ===');
    let r = await js('/api/tables/bulk', { token: T, body: { count: 3, prefix: 'M', section: 'Salon' } });
    ok('ilk toplu ekleme M1-M3', r.status === 201 && r.d.eklenen === 3 && r.d.ilk === 'M1' && r.d.son === 'M3', r.d);
    r = await js('/api/tables/bulk', { token: T, body: { count: 2, prefix: 'M', section: 'Salon' } });
    ok('ikinci toplu ekleme M4-M5 (eskiden 0 masa, sessiz)', r.status === 201 && r.d.eklenen === 2 && r.d.ilk === 'M4' && r.d.son === 'M5', r.d);
    ok('listede 5 masa', (await liste()).length === 5);
    ok('bosluklu kod harfi 400', (await js('/api/tables/bulk', { token: T, body: { count: 1, prefix: 'A B' } })).status === 400);
    ok('0 masa 400', (await js('/api/tables/bulk', { token: T, body: { count: 0, prefix: 'M' } })).status === 400);

    console.log('\n=== 2) Duzenleme ===');
    const m2 = await bul('M2'), m3 = await bul('M3'), m4 = await bul('M4'), m5 = await bul('M5');
    r = await js('/api/tables/' + m2.id, { token: T, method: 'PUT', body: { name: 'Pencere önü', section: 'Bahçe', capacity: 6 } });
    ok('ad/bolum/kisi guncellendi 200', r.status === 200, r.d);
    const m2y = await bul('M2');
    ok('degerler listede', m2y.name === 'Pencere önü' && m2y.section === 'Bahçe' && Number(m2y.capacity) === 6, m2y);
    ok('kod degisti M3 -> B1', (await js('/api/tables/' + m3.id, { token: T, method: 'PUT', body: { code: 'B1' } })).status === 200 && !!(await bul('B1')));
    r = await js('/api/tables/' + m4.id, { token: T, method: 'PUT', body: { code: 'M1' } });
    ok('aktif masanin kodu alinamaz 409', r.status === 409, r);
    ok('bos ad 400', (await js('/api/tables/' + m4.id, { token: T, method: 'PUT', body: { name: '  ' } })).status === 400);
    ok('bos kod 400', (await js('/api/tables/' + m4.id, { token: T, method: 'PUT', body: { code: '' } })).status === 400);
    ok('~ iceren kod 400', (await js('/api/tables/' + m4.id, { token: T, method: 'PUT', body: { code: 'X~1' } })).status === 400);
    ok('kisi sayisi 0 -> 400', (await js('/api/tables/' + m4.id, { token: T, method: 'PUT', body: { capacity: 0 } })).status === 400);
    ok('olmayan masa 404', (await js('/api/tables/' + crypto.randomUUID(), { token: T, method: 'PUT', body: { name: 'x' } })).status === 404);
    ok('kasiyer duzenleyemez 403', (await js('/api/tables/' + m4.id, { token: kasiyer.token, method: 'PUT', body: { name: 'x' } })).status === 403);
    ok('kasiyer silemez 403', (await js('/api/tables/' + m4.id, { token: kasiyer.token, method: 'DELETE' })).status === 403);

    console.log('\n=== 3) Silme engelleri ===');
    const ac = await js('/api/orders', { token: T, body: { tableId: m5.id } });
    ok('M5 icin hesap acildi', ac.status === 201 || ac.status === 200, ac);
    r = await js('/api/tables/' + m5.id, { token: T, method: 'DELETE' });
    ok('acik hesapli masa silinmez 409 ACIK_HESAP', r.status === 409 && r.d.code === 'ACIK_HESAP', r);
    ok('M5 listede duruyor', !!(await bul('M5')));
    await query("INSERT INTO qr_bekleyen_siparisler (id, tenant_id, table_id, kalemler_json, toplam, durum) VALUES (?, ?, ?, '[]', 0, 'BEKLIYOR')",
        [crypto.randomUUID(), tid, m4.id]);
    r = await js('/api/tables/' + m4.id, { token: T, method: 'DELETE' });
    ok('onay bekleyen QR siparisli masa silinmez 409 ONAY_BEKLIYOR', r.status === 409 && r.d.code === 'ONAY_BEKLIYOR', r);

    console.log('\n=== 4) Silme + sonrasi ===');
    const m2qr = (await query('SELECT qr_token FROM tables WHERE id = ?', [m2.id])).rows[0].qr_token;
    const slug = (await query('SELECT slug FROM tenants WHERE id = ?', [tid])).rows[0].slug;
    const cagriYolu = '/api/public/m/' + slug + '/' + m2qr + '/waiter';
    ok('silmeden once QR ile garson cagrisi calisir', (await js(cagriYolu, { body: { reason: 'GENERIC' } })).status === 201);
    r = await js('/api/tables/' + m2.id, { token: T, method: 'DELETE' });
    ok('bos masa silindi 200', r.status === 200 && /silindi/i.test(r.d.message), r);
    ok('silinen masa listede yok', !(await bul('M2')));
    const bekleyenCagri = (await query("SELECT COUNT(*) AS c FROM waiter_calls WHERE table_id = ? AND status = 'PENDING'", [m2.id])).rows[0].c;
    ok('silinen masanin bekleyen garson cagrisi kapandi', Number(bekleyenCagri) === 0, bekleyenCagri);
    ok('islem gunlugune masa_sil yazildi', (await query("SELECT 1 FROM islem_gunlugu WHERE tenant_id = ? AND islem = 'masa_sil' AND hedef_id = ?", [tid, m2.id])).rows.length === 1);
    ok('tekrar silme 200 (zaten silinmis)', (await js('/api/tables/' + m2.id, { token: T, method: 'DELETE' })).status === 200);
    ok('silinen masaya hesap acilamaz 404', (await js('/api/orders', { token: T, body: { tableId: m2.id } })).status === 404);
    const cagri = await js(cagriYolu, { body: { reason: 'GENERIC' } });
    ok('silinen masanin QR\'i garson cagiramaz (404)', cagri.status === 404, cagri);
    r = await js('/api/tables/bulk', { token: T, body: { count: 1, prefix: 'M' } });
    ok('silinenler dahil en buyuk numaranin ustu: M6', r.status === 201 && r.d.ilk === 'M6', r.d);
    r = await js('/api/tables/' + m4.id, { token: T, method: 'PUT', body: { code: 'M2' } });
    ok('silinmis masanin kodu yeniden kullanilabilir (M4 -> M2)', r.status === 200 && !!(await bul('M2')), r);
    const eski = (await query('SELECT code, is_active FROM tables WHERE id = ?', [m2.id])).rows[0];
    ok('silinmis kaydin kodu serbest birakildi (M2~...)', eski.is_active === 0 && eski.code.startsWith('M2~'), eski);

    console.log('\n=== 5) Patron olaylari: yeni kayit ===');
    await I.tara();
    let o = (await query("SELECT * FROM root_olaylar WHERE tur = 'yeni_kayit' AND ref = ?", [tid])).rows;
    ok('yeni kayit olayi yazildi', o.length === 1, o);
    ok('aciklama: SofraMix + Deneme', o.length === 1 && /SofraMix/.test(o[0].detay) && /Deneme/.test(o[0].detay), o[0]);
    await I.tara();
    ok('ikinci tarama tekrar yazmaz', (await query("SELECT COUNT(*) AS c FROM root_olaylar WHERE tur = 'yeni_kayit' AND ref = ?", [tid])).rows[0].c === 1);
    const olayId = o[0].id;
    let oz = await I.telefonOzeti(undefined);
    ok('ilk kurulum (id yok): yalniz son id, bildirim yok', oz.sonId >= olayId && oz.yeni === 0 && oz.son === null, oz);
    oz = await I.telefonOzeti(olayId - 1);
    ok('bilinen id eskiyse: yeni >= 1 + ozet', oz.yeni >= 1 && oz.son && typeof oz.son.isletme === 'string' && typeof oz.son.tur === 'string', oz);
    oz = await I.telefonOzeti(oz.sonId);
    ok('guncel id: yeni 0', oz.yeni === 0 && oz.son === null, oz);

    const E = I.etiketle;
    ok('etiket: site denemesi', /Site/.test(E({ license_tier: 'TIER_DENEME' }).kaynak));
    ok('etiket: kayit formu (7 gun demo)', /kayıt formu/.test(E({ license_tier: 'TIER_1_5' }).kaynak) && /7 günlük/.test(E({ license_tier: 'TIER_1_5' }).surum));
    ok('etiket: SofraMix tam surum', E({ license_tier: 'TIER_SOFRAMIX', parent_org: 'SofraMix' }).kaynak === 'SofraMix' && /Tam sürüm/.test(E({ license_tier: 'TIER_SOFRAMIX', parent_org: 'SofraMix' }).surum));
    ok('etiket: root paneli', /Root paneli/.test(E({ license_tier: 'TIER_KURUM' }).kaynak));

    console.log('\n=== 6) SofraMix paket alimi (var olan hesap) ===');
    const odemeId = 'masa-olay-test-' + crypto.randomBytes(4).toString('hex');
    await query("INSERT INTO pos_provizyon (id, odeme_id, kaynak, tenant_id, isletme_adi, tutar_kurus, donem_bitis, kiraci_acildi, durum) VALUES (?, ?, 'soframix', ?, ?, 1200000, ?, 0, 'islendi')",
        [crypto.randomUUID(), odemeId, tid, ISLETME, new Date(Date.now() + 365 * 86400000).toISOString()]);
    await I.tara();
    o = (await query("SELECT * FROM root_olaylar WHERE tur = 'paket_alindi' AND ref = ?", [odemeId])).rows;
    ok('paket alindi olayi yazildi', o.length === 1 && /paket/i.test(o[0].detay), o);

    console.log('\n=== 7) Telefon ucu: olay alani ===');
    let x = await js('/api/root/login', { body: { email: ROOT_EPOSTA, password: ROOT_PAROLA } });
    const sir = x.d && x.d.sir, kurulum = x.d && x.d.kurulumJetonu;
    x = await js('/api/root/totp/kurulum', { token: kurulum, body: { code: totp.kodUret(sir, totp.suankiAdim()) } });
    const oturum = x.d && x.d.token;
    ok('root oturumu', !!oturum, x);
    const cihaz = await js('/api/root/cihaz/kaydet', { token: oturum, body: { ad: 'Masa Olay Telefonu' } });
    const bj = cihaz.d && cihaz.d.bildirimJetonu;
    let d = await js('/api/root/cihaz/bildirim-durumu', { body: { bildirimJetonu: bj } });
    ok('eski alanlar korunur (bekleyen + son)', d.status === 200 && typeof d.d.bekleyen === 'number' && 'son' in d.d, d.d);
    ok('olay alani: sonId sayi, id verilmeyince yeni 0', d.d.olay && typeof d.d.olay.sonId === 'number' && d.d.olay.yeni === 0, d.d.olay);
    d = await js('/api/root/cihaz/bildirim-durumu', { body: { bildirimJetonu: bj, olaySonId: olayId - 1 } });
    ok('olaySonId eskiyse yeni >= 2 (kayit + paket) ve son dolu', d.d.olay.yeni >= 2 && !!d.d.olay.son, d.d.olay);
    ok('jetonsuz istek 401', (await js('/api/root/cihaz/bildirim-durumu', { body: {} })).status === 401);

    console.log('\n=== 8) E-posta kacislama ===');
    const { esc } = require('./src/services/rootBildirim');
    ok('HTML kacislanir', esc('<a href="x">\'y\'</a>&') === '&lt;a href=&quot;x&quot;&gt;&#39;y&#39;&lt;/a&gt;&amp;');

    await temizle();
    console.log(`\n${pass} OK, ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('TEST HATASI', e); try { await temizle(); } catch (_) {} process.exit(1); });
